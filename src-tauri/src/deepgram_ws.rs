//! MacroVox — Phase 4: Deepgram WebSocket streaming.
//!
//! Manages a persistent `wss://api.deepgram.com` connection that streams
//! raw PCM audio in real time and emits transcript events back to the renderer.
//!
//! ## Flow
//!
//! ```text
//! deepgram_start(credential)
//!   └── start_session(credential, sample_rate, channels, app)
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
//!   ├── DgMessage::Stop        → send {"type":"CloseStream"}, exit loop
//!   └── WebSocket text frame   → parse JSON → emit "deepgram:transcript" event
//!
//! deepgram_stop()
//!   └── drop DgSender  (→ recv() returns None → task sends CloseStream and exits)
//!       OR send DgMessage::Stop explicitly
//! ```
//!
//! ## Emitted events
//!
//! `"deepgram:transcript"` — payload `{ transcript: string, isFinal: boolean }`
//! Emitted for every non-empty result (interim and final) from Deepgram.

use futures_util::{SinkExt, StreamExt};
use tauri::Emitter;
use tokio::sync::mpsc;
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
    Stop,
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
pub async fn start_session(
    credential: &DeepgramCredential,
    sample_rate: u32,
    channels: u16,
    keywords: &[String],
    number_format: &str,
    language: &str,
    app: tauri::AppHandle,
) -> Result<DgSender, String> {
    let mut url = format!(
        "wss://api.deepgram.com/v1/listen\
         ?model=nova-3\
         &punctuate=true\
         &smart_format=true\
         &encoding=linear16\
         &sample_rate={sample_rate}\
         &channels={channels}\
         &interim_results=true\
         &language={language}"
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
    let (ws_stream, _response) = connect_async(request)
        .await
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
        loop {
            tokio::select! {
                // ── Outbound: PCM bytes or control messages ────────────────
                msg = rx.recv() => {
                    match msg {
                        Some(DgMessage::Pcm(bytes)) => {
                            if ws_sink.send(Message::Binary(bytes)).await.is_err() {
                                // WebSocket closed unexpectedly.
                                break;
                            }
                        }
                        Some(DgMessage::Stop) | None => {
                            graceful = true;
                            // Graceful close: tell Deepgram we are done.
                            let _ = ws_sink
                                .send(Message::Text(
                                    r#"{"type":"CloseStream"}"#.to_string(),
                                ))
                                .await;
                            let _ = ws_sink.close().await;
                            break;
                        }
                    }
                }

                // ── Inbound: transcript results from Deepgram ──────────────
                ws_msg = ws_rx.next() => {
                    match ws_msg {
                        Some(Ok(Message::Text(text))) => {
                            emit_transcript_event(&app, &text);
                        }
                        // Server close frame or stream end — exit.
                        Some(Ok(Message::Close(_))) | None => break,
                        // Ping/Pong/Binary frames — ignore.
                        _ => {}
                    }
                }
            }
        }

        if !graceful {
            let _ = app.emit("deepgram:error", serde_json::json!({
                "error": "Connection lost — recording may be incomplete"
            }));
        }

        // Drain any remaining messages after sending CloseStream so Deepgram
        // can flush its buffer and emit the last final result.
        while let Some(Ok(Message::Text(text))) = ws_rx.next().await {
            emit_transcript_event(&app, &text);
        }
    });

    Ok(tx)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Parses a Deepgram JSON result and emits a `"deepgram:transcript"` event.
///
/// Emits for both interim (`is_final=false`) and final (`is_final=true`) results.
/// Skips empty transcripts (silence frames) to avoid noisy events.
fn emit_transcript_event(app: &tauri::AppHandle, text: &str) {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(text) else {
        return;
    };

    // Deepgram wraps transcripts in results.channels[0].alternatives[0]
    let transcript = json["channel"]["alternatives"][0]["transcript"]
        .as_str()
        .unwrap_or("");

    if transcript.is_empty() {
        return;
    }

    let is_final = json["is_final"].as_bool().unwrap_or(false);

    let _ = app.emit(
        "deepgram:transcript",
        serde_json::json!({
            "transcript": transcript,
            "isFinal": is_final,
        }),
    );
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
        tx.try_send(DgMessage::Stop).unwrap();
        drop(tx);

        match rx.blocking_recv() {
            Some(DgMessage::Pcm(b)) => assert_eq!(b, vec![1, 2]),
            other => panic!("expected Pcm, got {other:?}"),
        }
        assert!(matches!(rx.blocking_recv(), Some(DgMessage::Stop)));
        assert!(rx.blocking_recv().is_none()); // sender dropped
    }
}
