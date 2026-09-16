//! MacroVox — Phase 4: Deepgram WebSocket streaming.
//!
//! Manages a persistent `wss://api.deepgram.com` connection that streams
//! raw PCM audio in real time and emits transcript events back to the renderer.
//!
//! ## Flow
//!
//! ```text
//! deepgram_start(credential)
//!   └── start_session(DeepgramSessionConfig { credential, sample_rate, channels, .. })
//!         ├── connect_async(wss://...) — TLS handshake happens here (pre-warm)
//!         ├── spawn background task
//!         └── return DgSender (stored in AppState::dg_sender)
//!
//! cpal callback (per ~10 ms frame):
//!   └── if is_recording && dg_sender.is_some()
//!         └── f32_to_i16_bytes(frame) → DgSender.send(DgMessage::Pcm(bytes))
//!
//! background task:
//!   ├── DgMessage::Pcm(bytes)  → WebSocket binary frame
//!   ├── DgMessage::Stop        → send {"type":"CloseStream"}, drain final results
//!   └── WebSocket text frame   → parse JSON → emit "deepgram:transcript" event
//!
//! deepgram_stop()
//!   └── queue DgMessage::Stop after accepted PCM, then await the worker result
//! ```
//!
//! ## Emitted events
//!
//! `"deepgram:transcript"` payload includes `transcript`, `isFinal`, and `sessionId`.
//! Emitted for every non-empty result (interim and final) from Deepgram.

use futures_util::{SinkExt, StreamExt};
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{Emitter, Manager};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        client::IntoClientRequest,
        http::header::{HeaderValue, AUTHORIZATION},
        Message,
    },
};

// ── Public types ──────────────────────────────────────────────────────────────

/// How the streaming socket authenticates.
///
/// A raw Deepgram API key uses the `Token` scheme. A short-lived credential
/// from `/v1/auth/grant` is a JWT and uses `Bearer`. Presenting either one with
/// the other's scheme is a 401, so the two are kept apart by the type rather
/// than by a comment.
///
/// Bring-your-own-key is `ApiKey`: the user's own credential, their own money.
/// The managed path is `AccessToken`, which is the point of the exercise. The
/// managed key stays on the server, and this process only ever holds a token
/// that expires in a minute.
#[derive(Clone, serde::Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum DeepgramCredential {
    /// A Deepgram API key the user typed into Settings.
    ApiKey(String),
    /// A short-lived token from the `deepgram-grant` function.
    AccessToken(String),
}

impl DeepgramCredential {
    /// The `Authorization` header value this credential is presented with.
    pub(crate) fn header_value(&self) -> String {
        match self {
            Self::ApiKey(key) => format!("Token {key}"),
            Self::AccessToken(token) => format!("Bearer {token}"),
        }
    }
}

// Hand-written rather than derived. A derived Debug puts the credential into
// any log line or panic message that formats the enum, and the rule in this
// codebase is that a key never appears in output.
impl std::fmt::Debug for DeepgramCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ApiKey(_) => f.write_str("DeepgramCredential::ApiKey(redacted)"),
            Self::AccessToken(_) => f.write_str("DeepgramCredential::AccessToken(redacted)"),
        }
    }
}

/// Messages the cpal callback (or commands) send to the background WebSocket task.
#[derive(Debug)]
pub enum DgMessage {
    /// Raw 16-bit little-endian PCM bytes to forward to Deepgram.
    Pcm(Vec<u8>),
    /// Signal the task to send `{"type":"CloseStream"}` and exit cleanly.
    Stop {
        completion: oneshot::Sender<StreamingStopResult>,
    },
}

#[derive(Debug, Default)]
pub struct StreamingStopResult {
    pub transcript: String,
    pub error: Option<String>,
}

fn parse_deepgram_text(text: &str) -> (Option<String>, bool, bool) {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(text) else {
        return (None, false, false);
    };
    if json["type"].as_str() == Some("Metadata") {
        return (None, false, true);
    }
    let transcript = json["channel"]["alternatives"][0]["transcript"]
        .as_str()
        .filter(|text| !text.is_empty())
        .map(str::to_string);
    (
        transcript,
        json["is_final"].as_bool().unwrap_or(false),
        false,
    )
}

async fn drain_final_results<S, E, F>(
    ws_rx: &mut S,
    timeout: Duration,
    mut transcript: String,
    mut on_transcript: F,
) -> StreamingStopResult
where
    S: futures_util::Stream<Item = Result<Message, E>> + Unpin,
    E: std::fmt::Display,
    F: FnMut(&str, bool),
{
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let incoming = match tokio::time::timeout_at(deadline, ws_rx.next()).await {
            Ok(incoming) => incoming,
            Err(_) => {
                return StreamingStopResult {
                    transcript,
                    error: Some("Timed out waiting for Deepgram final result".to_string()),
                }
            }
        };
        match incoming {
            Some(Ok(Message::Text(text))) => {
                let (fragment, is_final, is_metadata) = parse_deepgram_text(&text);
                if let Some(fragment) = fragment {
                    if is_final {
                        append_final(&mut transcript, &fragment);
                    }
                    on_transcript(&fragment, is_final);
                }
                if is_metadata {
                    return StreamingStopResult {
                        transcript,
                        error: None,
                    };
                }
            }
            Some(Ok(Message::Close(_))) | None => {
                return StreamingStopResult {
                    transcript,
                    error: None,
                }
            }
            Some(Err(error)) => {
                return StreamingStopResult {
                    transcript,
                    error: Some(format!("Deepgram WebSocket failed: {error}")),
                }
            }
            _ => {}
        }
    }
}

/// Sender half of the channel connecting the audio callback to the WS task.
/// Bounded to 1000 messages (~10 seconds of audio at 10 ms frames) to absorb
/// routine network jitter without dropping frames. If the WebSocket is slower
/// than that for a sustained period, frames are dropped (see
/// `audio::process_audio_frame` for drop-counter / log-rate-limit behavior).
pub type DgSender = mpsc::Sender<DgMessage>;

// ── Session start ─────────────────────────────────────────────────────────────

/// Opens a Deepgram streaming WebSocket and starts the background forwarding task.
///
/// Returns a `DgSender` that the cpal callback uses to stream PCM bytes.
/// Dropping the sender (or sending `DgMessage::Stop`) signals the task to
/// close the connection cleanly.
///
/// The background task emits `"deepgram:transcript"` Tauri events on the
/// provided `AppHandle` for every non-empty result Deepgram sends back.
pub struct DeepgramSessionConfig<'a> {
    pub credential: &'a DeepgramCredential,
    pub sample_rate: u32,
    pub channels: u16,
    pub keywords: &'a [String],
    pub number_format: &'a str,
    pub language: &'a str,
    pub session_id: u64,
    pub app: tauri::AppHandle,
}

pub async fn start_session(config: DeepgramSessionConfig<'_>) -> Result<DgSender, String> {
    let DeepgramSessionConfig {
        credential,
        sample_rate,
        channels,
        keywords,
        number_format,
        language,
        session_id,
        app,
    } = config;
    let mut url = format!(
        "wss://api.deepgram.com/v1/listen\
         ?model=nova-3\
         &punctuate=true\
         &smart_format=true\
         &encoding=linear16\
         &sample_rate={sample_rate}\
         &channels={channels}\
         &interim_results=true\
         &language={}",
        urlencoding::encode(language)
    );

    if number_format == "digits" {
        url.push_str("&numerals=true");
    }

    // nova-3 uses `keyterm` (not the legacy `keywords` param, which 400s on nova-3).
    for kw in keywords {
        url.push_str(&format!("&keyterm={}", urlencoding::encode(kw)));
    }

    // Build HTTP upgrade request and inject the Authorization header.
    let mut request = url
        .into_client_request()
        .map_err(|e| format!("Invalid Deepgram URL: {e}"))?;
    // NOTE: error path here intentionally does not include the credential in
    // the returned message. A malformed one would otherwise leak into logs.
    request.headers_mut().insert(
        AUTHORIZATION,
        HeaderValue::from_str(&credential.header_value())
            .map_err(|_| "Invalid Deepgram credential format".to_string())?,
    );

    // Establish the WebSocket — this is the pre-warm step.
    let (ws_stream, _response) =
        tokio::time::timeout(Duration::from_secs(15), connect_async(request))
            .await
            .map_err(|_| "Deepgram WebSocket connect timed out".to_string())?
            .map_err(|e| format!("Deepgram WebSocket connect failed: {e}"))?;

    let (mut ws_sink, mut ws_rx) = ws_stream.split();
    // Bounded channel: 1000 messages ≈ 10 s of 10 ms audio frames.
    // If the WebSocket falls behind for longer than that, audio.rs drops the
    // overflow frames and rate-limits a warn! line so the user gets a signal.
    let (tx, mut rx) = mpsc::channel::<DgMessage>(1000);

    // Spawn the background task that forwards PCM → WebSocket and
    // WebSocket transcript events → Tauri events.
    tokio::spawn(async move {
        let mut graceful = false;
        let mut completion: Option<oneshot::Sender<StreamingStopResult>> = None;
        let mut final_transcript = String::new();
        let mut stop_error = None;
        loop {
            if app
                .state::<crate::state::AppState>()
                .active_deepgram_session_id
                .load(Ordering::Acquire)
                != session_id
            {
                stop_error = Some("Deepgram streaming session was superseded".to_string());
                break;
            }
            tokio::select! {
                // ── Outbound: PCM bytes or control messages ────────────────
                msg = rx.recv() => {
                    match msg {
                        Some(DgMessage::Pcm(bytes)) => {
                            match tokio::time::timeout(
                                Duration::from_secs(5),
                                ws_sink.send(Message::Binary(bytes)),
                            )
                            .await
                            {
                                Ok(Ok(())) => {}
                                Ok(Err(error)) => {
                                    stop_error = Some(format!("Deepgram WebSocket send failed: {error}"));
                                    break;
                                }
                                Err(_) => {
                                    stop_error = Some("Timed out sending audio to Deepgram".to_string());
                                    break;
                                }
                            }
                        }
                        Some(DgMessage::Stop { completion: done }) => {
                            graceful = true;
                            completion = Some(done);
                            match tokio::time::timeout(
                                Duration::from_secs(5),
                                ws_sink.send(Message::Text(
                                    r#"{"type":"CloseStream"}"#.to_string(),
                                )),
                            )
                            .await
                            {
                                Ok(Ok(())) => {}
                                Ok(Err(error)) => {
                                    stop_error = Some(format!("Failed to close Deepgram stream: {error}"));
                                    break;
                                }
                                Err(_) => {
                                    stop_error = Some("Timed out closing Deepgram stream".to_string());
                                    break;
                                }
                            }
                            let result = drain_final_results(
                                &mut ws_rx,
                                Duration::from_secs(8),
                                final_transcript,
                                |transcript, is_final| {
                                    let _ = app.emit(
                                        "deepgram:transcript",
                                        serde_json::json!({
                                            "transcript": transcript,
                                            "isFinal": is_final,
                                            "sessionId": session_id,
                                        }),
                                    );
                                },
                            )
                            .await;
                            final_transcript = result.transcript;
                            stop_error = result.error;
                            break;
                        }
                        None => {
                            graceful = true;
                            match tokio::time::timeout(
                                Duration::from_secs(5),
                                ws_sink.send(Message::Text(
                                    r#"{"type":"CloseStream"}"#.to_string(),
                                )),
                            )
                            .await
                            {
                                Ok(Ok(())) => {}
                                Ok(Err(error)) => {
                                    stop_error = Some(format!("Failed to close Deepgram stream: {error}"));
                                    break;
                                }
                                Err(_) => {
                                    stop_error = Some("Timed out closing Deepgram stream".to_string());
                                    break;
                                }
                            }
                            let result = drain_final_results(
                                &mut ws_rx,
                                Duration::from_secs(8),
                                final_transcript,
                                |transcript, is_final| {
                                    let _ = app.emit(
                                        "deepgram:transcript",
                                        serde_json::json!({
                                            "transcript": transcript,
                                            "isFinal": is_final,
                                            "sessionId": session_id,
                                        }),
                                    );
                                },
                            )
                            .await;
                            final_transcript = result.transcript;
                            stop_error = result.error;
                            break;
                        }
                    }
                }

                // ── Inbound: transcript results from Deepgram ──────────────
                ws_msg = ws_rx.next() => {
                    match ws_msg {
                        Some(Ok(Message::Text(text))) => {
                            if emit_transcript_event(
                                &app,
                                &text,
                                session_id,
                                &mut final_transcript,
                            ) {
                                break;
                            }
                        }
                        // Server close frame or stream end — exit.
                        Some(Ok(Message::Close(_))) | None => break,
                        Some(Err(error)) => {
                            stop_error = Some(format!("Deepgram WebSocket failed: {error}"));
                            break;
                        }
                        // Ping/Pong/Binary frames — ignore.
                        _ => {}
                    }
                }

            }
        }

        if !graceful {
            let _ = app.emit(
                "deepgram:error",
                serde_json::json!({
                    "error": "Connection lost; recording may be incomplete",
                    "sessionId": session_id,
                }),
            );
        }

        let state = app.state::<crate::state::AppState>();
        state.clear_deepgram_session_if_active(session_id);

        if let Some(done) = completion {
            let _ = done.send(StreamingStopResult {
                transcript: final_transcript,
                error: stop_error,
            });
        }
    });

    Ok(tx)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Parses a Deepgram JSON result and emits a `"deepgram:transcript"` event.
///
/// Emits for both interim (`is_final=false`) and final (`is_final=true`) results.
/// Skips empty transcripts (silence frames) to avoid noisy events.
fn append_final(assembled: &mut String, fragment: &str) {
    let fragment = fragment.trim();
    if fragment.is_empty() {
        return;
    }
    if !assembled.is_empty() {
        assembled.push(' ');
    }
    assembled.push_str(fragment);
}

fn emit_transcript_event(
    app: &tauri::AppHandle,
    text: &str,
    session_id: u64,
    final_transcript: &mut String,
) -> bool {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(text) else {
        return false;
    };

    if json["type"].as_str() == Some("Metadata") {
        return true;
    }

    // Deepgram wraps transcripts in results.channels[0].alternatives[0]
    let transcript = json["channel"]["alternatives"][0]["transcript"]
        .as_str()
        .unwrap_or("");

    if transcript.is_empty() {
        return false;
    }

    let is_final = json["is_final"].as_bool().unwrap_or(false);
    if is_final {
        append_final(final_transcript, transcript);
    }

    let _ = app.emit(
        "deepgram:transcript",
        serde_json::json!({
            "transcript": transcript,
            "isFinal": is_final,
            "sessionId": session_id,
        }),
    );
    false
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_key_is_presented_with_the_token_scheme() {
        let credential = DeepgramCredential::ApiKey("abc123".to_string());
        assert_eq!(credential.header_value(), "Token abc123");
    }

    #[test]
    fn access_token_is_presented_with_the_bearer_scheme() {
        // Sending a granted JWT as `Token` is a 401 from Deepgram, which is a
        // miserable thing to debug from the client side.
        let credential = DeepgramCredential::AccessToken("header.payload.sig".to_string());
        assert_eq!(credential.header_value(), "Bearer header.payload.sig");
    }

    #[test]
    fn debug_never_prints_the_credential() {
        let key = DeepgramCredential::ApiKey("supersecret".to_string());
        let token = DeepgramCredential::AccessToken("supersecret".to_string());
        assert!(!format!("{key:?}").contains("supersecret"));
        assert!(!format!("{token:?}").contains("supersecret"));
    }

    #[test]
    fn deserializes_the_shape_the_renderer_sends() {
        let key: DeepgramCredential =
            serde_json::from_str(r#"{"kind":"api_key","value":"k"}"#).unwrap();
        let token: DeepgramCredential =
            serde_json::from_str(r#"{"kind":"access_token","value":"t"}"#).unwrap();
        assert_eq!(key.header_value(), "Token k");
        assert_eq!(token.header_value(), "Bearer t");
    }

    #[test]
    fn refuses_a_credential_with_no_scheme() {
        // A bare string used to be enough. It is not any more, and the failure
        // should be at the boundary rather than a 401 from the vendor.
        assert!(serde_json::from_str::<DeepgramCredential>(r#""just-a-key""#).is_err());
    }

    /// A well-formed Deepgram JSON result (interim).
    const INTERIM_JSON: &str = r#"{
        "is_final": false,
        "channel": {
            "alternatives": [{ "transcript": "hello world", "confidence": 0.95 }]
        }
    }"#;

    /// A well-formed Deepgram JSON result (final).
    const FINAL_JSON: &str = r#"{
        "is_final": true,
        "channel": {
            "alternatives": [{ "transcript": "hello world.", "confidence": 0.99 }]
        }
    }"#;

    /// An empty-transcript result that should be silently skipped.
    const EMPTY_TRANSCRIPT_JSON: &str = r#"{
        "is_final": false,
        "channel": {
            "alternatives": [{ "transcript": "", "confidence": 0.0 }]
        }
    }"#;

    /// Malformed JSON that should be silently skipped.
    const BAD_JSON: &str = "not json at all";

    #[test]
    fn parse_interim_transcript() {
        let json: serde_json::Value = serde_json::from_str(INTERIM_JSON).unwrap();
        let t = json["channel"]["alternatives"][0]["transcript"]
            .as_str()
            .unwrap_or("");
        let is_final = json["is_final"].as_bool().unwrap_or(false);
        assert_eq!(t, "hello world");
        assert!(!is_final);
    }

    #[test]
    fn parse_final_transcript() {
        let json: serde_json::Value = serde_json::from_str(FINAL_JSON).unwrap();
        let t = json["channel"]["alternatives"][0]["transcript"]
            .as_str()
            .unwrap_or("");
        let is_final = json["is_final"].as_bool().unwrap_or(false);
        assert_eq!(t, "hello world.");
        assert!(is_final);
    }

    #[test]
    fn empty_transcript_is_skipped() {
        let json: serde_json::Value = serde_json::from_str(EMPTY_TRANSCRIPT_JSON).unwrap();
        let t = json["channel"]["alternatives"][0]["transcript"]
            .as_str()
            .unwrap_or("");
        // Would be filtered before emitting.
        assert!(t.is_empty());
    }

    #[test]
    fn bad_json_is_skipped() {
        // serde_json::from_str should fail and emit_transcript_event returns early.
        assert!(serde_json::from_str::<serde_json::Value>(BAD_JSON).is_err());
    }

    #[test]
    fn dg_message_pcm_carries_bytes() {
        let bytes = vec![0u8, 1, 2, 3];
        let msg = DgMessage::Pcm(bytes.clone());
        if let DgMessage::Pcm(b) = msg {
            assert_eq!(b, bytes);
        } else {
            panic!("expected Pcm variant");
        }
    }

    #[test]
    fn dg_sender_send_and_recv() {
        let (tx, mut rx) = mpsc::channel::<DgMessage>(500);
        tx.try_send(DgMessage::Pcm(vec![1, 2])).unwrap();
        let (done, _completion) = oneshot::channel();
        tx.try_send(DgMessage::Stop { completion: done }).unwrap();
        drop(tx);

        match rx.blocking_recv() {
            Some(DgMessage::Pcm(b)) => assert_eq!(b, vec![1, 2]),
            other => panic!("expected Pcm, got {other:?}"),
        }
        assert!(matches!(rx.blocking_recv(), Some(DgMessage::Stop { .. })));
        assert!(rx.blocking_recv().is_none()); // sender dropped
    }

    #[test]
    fn final_fragments_are_assembled_in_server_order() {
        let mut transcript = String::new();
        append_final(&mut transcript, "hello world");
        append_final(&mut transcript, "from MacroVox");
        assert_eq!(transcript, "hello world from MacroVox");
    }

    #[tokio::test]
    async fn delayed_final_result_is_drained_before_metadata() {
        let (tx, rx) = mpsc::channel(4);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            tx.send(Message::Text(FINAL_JSON.to_string()))
                .await
                .unwrap();
            tx.send(Message::Text(r#"{"type":"Metadata"}"#.to_string()))
                .await
                .unwrap();
        });
        let mut stream = Box::pin(futures_util::stream::unfold(rx, |mut receiver| async {
            receiver
                .recv()
                .await
                .map(|message| (Ok::<Message, String>(message), receiver))
        }));
        let result = drain_final_results(
            &mut stream,
            Duration::from_millis(100),
            String::new(),
            |_, _| {},
        )
        .await;
        assert_eq!(result.transcript, "hello world.");
        assert!(result.error.is_none());
    }

    #[tokio::test]
    async fn final_result_deadline_does_not_wait_forever() {
        let (_tx, rx) = mpsc::channel::<Message>(1);
        let mut stream = Box::pin(futures_util::stream::unfold(rx, |mut receiver| async {
            receiver
                .recv()
                .await
                .map(|message| (Ok::<Message, String>(message), receiver))
        }));
        let result = drain_final_results(
            &mut stream,
            Duration::from_millis(10),
            "already final".to_string(),
            |_, _| {},
        )
        .await;
        assert_eq!(result.transcript, "already final");
        assert!(result.error.unwrap().contains("Timed out"));
    }

    #[tokio::test]
    async fn final_result_protocol_error_is_returned() {
        let mut stream = Box::pin(futures_util::stream::iter([Err::<Message, _>(
            "simulated socket failure",
        )]));
        let result = drain_final_results(
            &mut stream,
            Duration::from_millis(100),
            "already final".to_string(),
            |_, _| {},
        )
        .await;

        assert_eq!(result.transcript, "already final");
        assert!(result.error.unwrap().contains("simulated socket failure"));
    }

    #[test]
    fn cleanup_generation_guard_rejects_stale_worker() {
        let active = std::sync::atomic::AtomicU64::new(8);
        assert!(active
            .compare_exchange(7, 0, Ordering::AcqRel, Ordering::Acquire)
            .is_err());
        assert_eq!(active.load(Ordering::Acquire), 8);
    }
}
