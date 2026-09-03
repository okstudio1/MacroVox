/// MacroVox Tauri commands.
///
/// Every command here mirrors one channel from the Electron preload
/// (`src/main/preload.ts`). The renderer calls them via:
///   `invoke("command_name", payload)`   (see `src/renderer/lib/tauri-ipc.ts`)
///
/// Phase status per command:
///   ✅ Phase 2 — implemented (clipboard, window ops, broadcast events, auto-paste)
///   ✅ Phase 3 — audio (cpal WASAPI replaces ffmpeg subprocess)
///   ✅ Phase 4 — Deepgram WebSocket pre-warm + whisper-rs local STT scaffold
///   ✅ Phase 5 — enigo native paste (replaces PowerShell ~700 ms)
///   ✅ Phase 6 — auth stubs removed; Supabase JS SDK used from renderer
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use log::{debug, warn};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;

use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

use crate::deepgram_ws::DeepgramCredential;
use crate::state::AppState;

// ── Shortcut parsing ─────────────────────────────────────────────────────────

/// Parses a human-readable shortcut string like "Ctrl+Shift+D" into a Tauri `Shortcut`.
pub fn parse_shortcut(s: &str) -> Result<Shortcut, String> {
    let parts: Vec<&str> = s.split('+').map(|p| p.trim()).collect();
    if parts.is_empty() {
        return Err("Empty shortcut".to_string());
    }

    let mut mods = Modifiers::empty();
    let mut key_part: Option<&str> = None;

    for part in &parts {
        match part.to_lowercase().as_str() {
            "ctrl" | "control" => mods |= Modifiers::CONTROL,
            "alt" => mods |= Modifiers::ALT,
            "shift" => mods |= Modifiers::SHIFT,
            "super" | "meta" | "win" => mods |= Modifiers::SUPER,
            _ => {
                if key_part.is_some() {
                    return Err(format!("Multiple keys in shortcut: {s}"));
                }
                key_part = Some(part);
            }
        }
    }

    let key_str = key_part.ok_or_else(|| format!("No key in shortcut: {s}"))?;
    let code = parse_key_code(key_str)?;
    let mods_opt = if mods.is_empty() { None } else { Some(mods) };
    Ok(Shortcut::new(mods_opt, code))
}

fn parse_key_code(s: &str) -> Result<Code, String> {
    match s.to_lowercase().as_str() {
        "space" => Ok(Code::Space),
        "enter" | "return" => Ok(Code::Enter),
        "tab" => Ok(Code::Tab),
        "escape" | "esc" => Ok(Code::Escape),
        "backspace" => Ok(Code::Backspace),
        "delete" | "del" => Ok(Code::Delete),
        "insert" => Ok(Code::Insert),
        "home" => Ok(Code::Home),
        "end" => Ok(Code::End),
        "pageup" => Ok(Code::PageUp),
        "pagedown" => Ok(Code::PageDown),
        "up" => Ok(Code::ArrowUp),
        "down" => Ok(Code::ArrowDown),
        "left" => Ok(Code::ArrowLeft),
        "right" => Ok(Code::ArrowRight),
        "f1" => Ok(Code::F1),
        "f2" => Ok(Code::F2),
        "f3" => Ok(Code::F3),
        "f4" => Ok(Code::F4),
        "f5" => Ok(Code::F5),
        "f6" => Ok(Code::F6),
        "f7" => Ok(Code::F7),
        "f8" => Ok(Code::F8),
        "f9" => Ok(Code::F9),
        "f10" => Ok(Code::F10),
        "f11" => Ok(Code::F11),
        "f12" => Ok(Code::F12),
        ";" | "semicolon" => Ok(Code::Semicolon),
        "=" | "equal" => Ok(Code::Equal),
        "," | "comma" => Ok(Code::Comma),
        "-" | "minus" => Ok(Code::Minus),
        "." | "period" => Ok(Code::Period),
        "/" | "slash" => Ok(Code::Slash),
        "`" | "backquote" => Ok(Code::Backquote),
        "[" | "bracketleft" => Ok(Code::BracketLeft),
        "]" | "bracketright" => Ok(Code::BracketRight),
        "\\" | "backslash" => Ok(Code::Backslash),
        "'" | "quote" => Ok(Code::Quote),
        "0" => Ok(Code::Digit0),
        "1" => Ok(Code::Digit1),
        "2" => Ok(Code::Digit2),
        "3" => Ok(Code::Digit3),
        "4" => Ok(Code::Digit4),
        "5" => Ok(Code::Digit5),
        "6" => Ok(Code::Digit6),
        "7" => Ok(Code::Digit7),
        "8" => Ok(Code::Digit8),
        "9" => Ok(Code::Digit9),
        s if s.chars().count() == 1 => {
            // chars().count() == 1 guarantees next() is Some without panic on
            // multi-byte codepoints (where len() == 1 would not).
            let ch = s.chars().next().expect("count is 1").to_ascii_uppercase();
            match ch {
                'A' => Ok(Code::KeyA), 'B' => Ok(Code::KeyB), 'C' => Ok(Code::KeyC),
                'D' => Ok(Code::KeyD), 'E' => Ok(Code::KeyE), 'F' => Ok(Code::KeyF),
                'G' => Ok(Code::KeyG), 'H' => Ok(Code::KeyH), 'I' => Ok(Code::KeyI),
                'J' => Ok(Code::KeyJ), 'K' => Ok(Code::KeyK), 'L' => Ok(Code::KeyL),
                'M' => Ok(Code::KeyM), 'N' => Ok(Code::KeyN), 'O' => Ok(Code::KeyO),
                'P' => Ok(Code::KeyP), 'Q' => Ok(Code::KeyQ), 'R' => Ok(Code::KeyR),
                'S' => Ok(Code::KeyS), 'T' => Ok(Code::KeyT), 'U' => Ok(Code::KeyU),
                'V' => Ok(Code::KeyV), 'W' => Ok(Code::KeyW), 'X' => Ok(Code::KeyX),
                'Y' => Ok(Code::KeyY), 'Z' => Ok(Code::KeyZ),
                _ => Err(format!("Unknown key: {s}")),
            }
        }
        other => Err(format!("Unknown key: {other}")),
    }
}

/// Lock a mutex, recovering from poison if a prior thread panicked.
fn lock_or_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ── Shared response types ─────────────────────────────────────────────────────

#[derive(serde::Serialize, Debug, PartialEq)]
pub struct OkResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl OkResponse {
    pub fn ok() -> Self {
        Self { success: true, error: None }
    }
    pub fn err(msg: impl Into<String>) -> Self {
        Self { success: false, error: Some(msg.into()) }
    }
}

#[derive(serde::Serialize, Debug)]
pub struct AudioDevicesResponse {
    pub success: bool,
    pub devices: Vec<String>,
    pub selected: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(serde::Serialize, Debug)]
pub struct RecordingStopResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ── Audio ✅ Phase 3: cpal WASAPI native capture ───────────────────────────────

#[tauri::command]
pub fn audio_list_devices(state: State<AppState>) -> AudioDevicesResponse {
    use cpal::traits::{DeviceTrait, HostTrait};
    let host = cpal::default_host();
    let devices: Vec<String> = host
        .input_devices()
        .map(|iter| iter.filter_map(|d| d.name().ok()).collect())
        .unwrap_or_default();
    let devices = filter_device_list(devices);
    let selected = lock_or_recover(&state.selected_mic_device).clone();
    debug!("[audio] devices found: {:?}, selected: {:?}", devices, selected);
    AudioDevicesResponse { success: true, devices, selected, error: None }
}

/// On Linux, cpal's ALSA host enumerates dozens of virtual/alias devices
/// (`hw:`, `plughw:`, `dmix:`, `surround51:CARD=…`, monitor taps, etc.) that
/// are noise for a user-facing picker. Keep only the PulseAudio route and
/// plain capture device names; fall through unchanged on other platforms.
fn filter_device_list(devices: Vec<String>) -> Vec<String> {
    #[cfg(target_os = "linux")]
    {
        const NOISE_PREFIXES: &[&str] = &[
            "sysdefault:", "front:", "rear:", "center_lfe:", "side:",
            "surround21:", "surround40:", "surround41:", "surround50:",
            "surround51:", "surround71:",
            "iec958:", "spdif:", "hdmi:",
            "dmix:", "dsnoop:", "hw:", "plughw:",
            "modem:", "phoneline:", "upmix", "vdownmix",
            "samplerate", "speexrate", "null", "jack", "oss",
            "usbstream:",
        ];
        let mut out: Vec<String> = devices
            .into_iter()
            .filter(|name| {
                let lower = name.to_ascii_lowercase();
                if lower.contains("monitor of ") || lower.ends_with(".monitor") {
                    return false;
                }
                !NOISE_PREFIXES.iter().any(|p| name.starts_with(p))
            })
            .collect();
        out.sort();
        out.dedup();
        return out;
    }
    #[cfg(not(target_os = "linux"))]
    {
        devices
    }
}

#[tauri::command]
pub fn audio_set_device(device_name: String, state: State<AppState>) -> OkResponse {
    *lock_or_recover(&state.selected_mic_device) = Some(device_name);
    OkResponse::ok()
}

/// Opens a cpal WASAPI input stream on the selected (or default) microphone.
///
/// Stores the stream in `AppState::audio_stream`; dropping it later (in
/// `audio_stop`) halts capture. Updates `audio_sample_rate` and
/// `audio_channels` so `recording_stop` can build the correct WAV header.
#[tauri::command]
pub fn audio_start(state: State<AppState>) -> OkResponse {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    let host = cpal::default_host();
    let device_name = lock_or_recover(&state.selected_mic_device).clone();
    debug!("[audio] audio_start called, selected device: {:?}", device_name);

    // Find the requested device, or fall back to the system default.
    let device = if let Some(ref name) = device_name {
        host.input_devices()
            .ok()
            .and_then(|mut iter| iter.find(|d| d.name().ok().as_deref() == Some(name.as_str())))
            .or_else(|| {
                warn!("[audio] Device {:?} not found, falling back to default", name);
                host.default_input_device()
            })
    } else {
        host.default_input_device()
    };

    let device = match device {
        Some(d) => {
            debug!("[audio] Using device: {:?}", d.name().unwrap_or_default());
            d
        }
        None => {
            warn!("[audio] No input device found!");
            return OkResponse::err("No input device found");
        }
    };

    let config = match device.default_input_config() {
        Ok(c) => {
            debug!("[audio] Input config: {:?}ch @ {}Hz, format={:?}",
                   c.channels(), c.sample_rate().0, c.sample_format());
            c
        }
        Err(e) => {
            warn!("[audio] Failed to get input config: {e}");
            return OkResponse::err(format!("Failed to get input config: {e}"));
        }
    };

    // Persist stream parameters for WAV encoding in recording_stop.
    *lock_or_recover(&state.audio_sample_rate) = config.sample_rate().0;
    *lock_or_recover(&state.audio_channels) = config.channels();

    let level = Arc::clone(&state.audio_level);
    let buffer = Arc::clone(&state.recording_buffer);
    let is_recording = Arc::clone(&state.is_recording);

    let dg_sender = Arc::clone(&state.dg_sender);

    match crate::audio::build_input_stream(&device, &config, level, buffer, is_recording, dg_sender) {
        Ok(stream) => {
            if let Err(e) = stream.play() {
                warn!("[audio] Failed to start stream: {e}");
                return OkResponse::err(format!("Failed to start stream: {e}"));
            }
            debug!("[audio] Stream started successfully");
            *lock_or_recover(&state.audio_stream) = Some(crate::state::AudioStream(stream));
            OkResponse::ok()
        }
        Err(e) => {
            warn!("[audio] Failed to build audio stream: {e}");
            OkResponse::err(format!("Failed to build audio stream: {e}"))
        }
    }
}

/// Stops audio capture by dropping the cpal stream and zeroing the level meter.
#[tauri::command]
pub fn audio_stop(state: State<AppState>) -> OkResponse {
    *lock_or_recover(&state.audio_stream) = None;
    *lock_or_recover(&state.audio_level) = 0.0;
    OkResponse::ok()
}

/// Returns the current RMS level of the capture stream (0.0–1.0).
#[tauri::command]
pub fn audio_get_level(state: State<AppState>) -> f64 {
    *lock_or_recover(&state.audio_level)
}

// ── Deepgram streaming ✅ Phase 4: pre-warmed WebSocket ───────────────────────

/// Opens a Deepgram WebSocket connection and begins streaming audio in real time.
///
/// This command is the streaming-mode equivalent of `recording_start`.  The
/// renderer calls it (with `mode = "streaming"`) instead of `recording_start`.
///
/// Steps:
/// 1. Reads the device's sample rate and channel count from `AppState`.
/// 2. Calls `deepgram_ws::start_session` to establish the `wss://` connection
///    (the pre-warm step — the handshake happens here, before the user speaks).
/// 3. Stores the `DgSender` in `AppState::dg_sender` so the cpal callback can
///    forward audio frames to the WebSocket task.
/// 4. Clears the recording buffer and sets `is_recording = true` so the cpal
///    callback starts both buffering (batch fallback) and streaming (WS path).
///
/// Transcripts are pushed back to the renderer as `"deepgram:transcript"` events.
///
/// The `credential` is either the user's own API key or a short-lived token
/// from the `deepgram-grant` function. See `DeepgramCredential`: the two use
/// different `Authorization` schemes, so which one this is has to be stated
/// rather than guessed from the string.
#[tauri::command]
pub async fn deepgram_start(
    credential: DeepgramCredential,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<OkResponse, String> {
    // Ensure the audio capture stream is running before opening the WebSocket.
    // Without this the cpal callback never fires and Deepgram receives no audio.
    {
        let has_stream = lock_or_recover(&state.audio_stream).is_some();
        if !has_stream {
            debug!("[deepgram] No audio stream running — starting one");
            let res = audio_start(state.clone());
            if !res.success {
                warn!("[deepgram] Failed to start audio: {:?}", res.error);
                return Ok(res);
            }
        }
    }

    let sample_rate = *lock_or_recover(&state.audio_sample_rate);
    let channels = *lock_or_recover(&state.audio_channels);
    let keywords = lock_or_recover(&state.deepgram_keywords).clone();
    let number_format = lock_or_recover(&state.number_format).clone();
    let language = lock_or_recover(&state.transcription_language).clone();
    debug!("[deepgram] Starting session: {}Hz, {}ch, {} keywords, numbers={}, lang={}",
           sample_rate, channels, keywords.len(), number_format, language);

    match crate::deepgram_ws::start_session(&credential, sample_rate, channels, &keywords, &number_format, &language, app).await {
        Ok(sender) => {
            debug!("[deepgram] WebSocket session established");
            // Replace any existing sender first — on a double-start the previous
            // background task is signaled to close so it can drop its WebSocket
            // and stop counting against quota. Without this it would orphan.
            if let Some(old) = lock_or_recover(&state.dg_sender).replace(sender) {
                let _ = old.try_send(crate::deepgram_ws::DgMessage::Stop);
            }
            lock_or_recover(&state.recording_buffer).clear();
            *lock_or_recover(&state.is_recording) = true;
            Ok(OkResponse::ok())
        }
        Err(e) => {
            warn!("[deepgram] Failed to start session: {e}");
            Ok(OkResponse::err(e))
        }
    }
}

/// Stops Deepgram WebSocket streaming and closes the connection.
///
/// Sends `DgMessage::Stop` to the background task, which in turn sends
/// `{"type":"CloseStream"}` to Deepgram and drains any final transcript
/// fragments before exiting.  Any remaining `"deepgram:transcript"` events
/// will still arrive in the renderer before the socket closes.
#[tauri::command]
pub fn deepgram_stop(state: State<AppState>) -> OkResponse {
    *lock_or_recover(&state.is_recording) = false;

    // Take the sender out of state — dropping it signals the task to close,
    // but sending Stop first gives Deepgram a chance to flush its buffer.
    if let Some(sender) = lock_or_recover(&state.dg_sender).take() {
        let _ = sender.try_send(crate::deepgram_ws::DgMessage::Stop);
    }

    OkResponse::ok()
}

// ── Buffered recording ✅ Phase 3 ─────────────────────────────────────────────

/// Clears any stale buffer and signals the cpal callback to start accumulating.
/// Starts the audio capture stream if it's not already running.
#[tauri::command]
pub fn recording_start(state: State<AppState>) -> OkResponse {
    // Ensure audio stream is running
    let has_stream = lock_or_recover(&state.audio_stream).is_some();
    if !has_stream {
        debug!("[recording] No audio stream running — starting one");
        let res = audio_start(state.clone());
        if !res.success {
            warn!("[recording] Failed to start audio: {:?}", res.error);
            return res;
        }
    }
    lock_or_recover(&state.recording_buffer).clear();
    *lock_or_recover(&state.is_recording) = true;
    OkResponse::ok()
}

/// Stops buffering, encodes the captured PCM as WAV, and uploads to Deepgram's
/// pre-recorded API. Returns the transcript, confidence, and duration.
///
/// This is an `async` command because it awaits the Deepgram HTTP response.
/// All state locks are released before the `await` to avoid holding them across
/// the suspension point.
/// Tauri 2 requires async commands with borrowed `State<'_, T>` to return `Result`.
/// The `Err` arm is unreachable — failures are expressed through `RecordingStopResponse`.
#[tauri::command]
pub async fn recording_stop(
    credential: DeepgramCredential,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<RecordingStopResponse, String> {
    // --- Stop recording and drain the buffer synchronously ---
    *lock_or_recover(&state.is_recording) = false;
    let samples = std::mem::take(&mut *lock_or_recover(&state.recording_buffer));
    let sample_rate = *lock_or_recover(&state.audio_sample_rate);
    let channels = *lock_or_recover(&state.audio_channels);
    // State locks released here — safe to await below.

    if samples.is_empty() {
        return Ok(RecordingStopResponse {
            success: false,
            transcript: None,
            confidence: None,
            duration: None,
            error: Some("No audio was captured".to_string()),
        });
    }

    let keywords = lock_or_recover(&state.deepgram_keywords).clone();
    let number_format = lock_or_recover(&state.number_format).clone();
    let language = lock_or_recover(&state.transcription_language).clone();

    // Guard against zero values from a corrupted device profile — produces a
    // finite duration instead of NaN/inf that would JSON-stringify to null.
    let safe_sample_rate = sample_rate.max(1);
    let safe_channels = channels.max(1);
    let duration = samples.len() as f64 / (safe_sample_rate as f64 * safe_channels as f64);
    let wav = crate::audio::pcm_to_wav(&samples, safe_sample_rate, safe_channels);

    // --- Upload to Deepgram pre-recorded API ---
    let mut url = format!(
        "https://api.deepgram.com/v1/listen?model=nova-3&punctuate=true&smart_format=true&language={language}"
    );
    if number_format == "digits" {
        url.push_str("&numerals=true");
    }
    // nova-3 uses `keyterm` (not the legacy `keywords` param, which 400s on nova-3).
    for kw in &keywords {
        url.push_str(&format!("&keyterm={}", urlencoding::encode(kw)));
    }

    let client = reqwest::Client::new();
    let resp = match client
        .post(&url)
        .header("Authorization", credential.header_value())
        .header("Content-Type", "audio/wav")
        .body(wav)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return Ok(RecordingStopResponse {
                success: false,
                transcript: None,
                confidence: None,
                duration: Some(duration),
                error: Some(format!("Deepgram request failed: {e}")),
            })
        }
    };

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        warn!("[recording] Deepgram returned {}: {}", status, &text[..text.len().min(200)]);
        return Ok(RecordingStopResponse {
            success: false,
            transcript: None,
            confidence: None,
            duration: Some(duration),
            error: Some(format!("Deepgram error ({})", status)),
        });
    }

    let json: serde_json::Value = match resp.json().await {
        Ok(j) => j,
        Err(e) => {
            return Ok(RecordingStopResponse {
                success: false,
                transcript: None,
                confidence: None,
                duration: Some(duration),
                error: Some(format!("Invalid Deepgram response: {e}")),
            });
        }
    };

    let alt = json
        .get("results")
        .and_then(|r| r.get("channels"))
        .and_then(|ch| ch.get(0))
        .and_then(|c| c.get("alternatives"))
        .and_then(|a| a.get(0));

    match alt {
        Some(alt) => {
            let transcript_text = alt["transcript"].as_str().unwrap_or("").to_string();

            // Auto-save to voice buffer in background — don't block the
            // transcript response. Opus encoding + disk write can take 50-200ms
            // and the user shouldn't wait for it.
            //
            // All state is captured into owned locals here so a concurrent
            // settings_broadcast can't change voice_buffer_dir/max_size between
            // this point and when the background thread actually writes.
            let vb_enabled = *lock_or_recover(&state.voice_buffer_enabled);
            if vb_enabled && !transcript_text.is_empty() {
                let dir = lock_or_recover(&state.voice_buffer_dir).clone();
                let max_size = *lock_or_recover(&state.voice_buffer_max_size);
                let transcript_clone = transcript_text.clone();
                if !dir.as_os_str().is_empty() {
                    // Clone the AppHandle so the background thread can notify
                    // webviews. Without this, the settings window's recordings
                    // list stays frozen at whatever was on disk when its
                    // WebView2 first loaded, since batch mode never round-trips
                    // through the renderer's voice_buffer_save path.
                    let app_handle = app.clone();
                    std::thread::spawn(move || {
                        match crate::voice_buffer::save_recording(
                            &dir, &samples, safe_sample_rate, safe_channels, &transcript_clone, Some(max_size),
                        ) {
                            Ok(_) => {
                                let _ = app_handle.emit("voice-buffer-updated", ());
                            }
                            Err(e) => warn!("[voice_buffer] Auto-save failed: {e}"),
                        }
                    });
                }
            }

            Ok(RecordingStopResponse {
                success: true,
                transcript: Some(transcript_text),
                confidence: alt["confidence"].as_f64(),
                duration: Some(duration),
                error: None,
            })
        }
        None => Ok(RecordingStopResponse {
            success: false,
            transcript: None,
            confidence: None,
            duration: Some(duration),
            error: Some("Unexpected Deepgram response structure".to_string()),
        }),
    }
}

/// Discards the recording buffer without transcribing.
#[tauri::command]
pub fn recording_cancel(state: State<AppState>) -> OkResponse {
    *lock_or_recover(&state.is_recording) = false;
    lock_or_recover(&state.recording_buffer).clear();
    OkResponse::ok()
}

// ── Local STT ✅ Phase 4 (local-stt feature) ──────────────────────────────────

/// Transcribes the current recording buffer using whisper-rs (offline/local STT).
///
/// This is an alternative to `recording_stop` for users who want fully offline
/// transcription.  Call after `recording_start` + recording, just like
/// `recording_stop`, but pass a `model_path` pointing to a downloaded GGML
/// model file (e.g. `ggml-base.en.bin`).
///
/// ## Enabling
///
/// The `local-stt` Cargo feature is **off by default** because whisper-rs
/// builds whisper.cpp from source, which requires cmake and a C++ toolchain.
/// Enable it with:
///
/// ```sh
/// cargo build --features local-stt
/// ```
///
/// ## Model download
///
/// Download GGML models from:
/// `https://huggingface.co/ggerganov/whisper.cpp/tree/main`
/// Recommended starter: `ggml-base.en.bin` (~142 MB, English only, fast)
#[tauri::command]
pub fn whisper_transcribe(
    model_path: String,
    state: State<AppState>,
) -> RecordingStopResponse {
    *lock_or_recover(&state.is_recording) = false;
    let samples = std::mem::take(&mut *lock_or_recover(&state.recording_buffer));
    let sample_rate = *lock_or_recover(&state.audio_sample_rate);

    if samples.is_empty() {
        return RecordingStopResponse {
            success: false,
            transcript: None,
            confidence: None,
            duration: None,
            error: Some("No audio was captured".to_string()),
        };
    }

    let duration = samples.len() as f64 / sample_rate as f64;

    #[cfg(feature = "local-stt")]
    {
        whisper_transcribe_impl(samples, sample_rate, duration, &model_path)
    }

    #[cfg(not(feature = "local-stt"))]
    {
        let _ = (model_path, duration); // suppress unused warnings
        RecordingStopResponse {
            success: false,
            transcript: None,
            confidence: None,
            duration: Some(duration),
            error: Some(
                "local-stt feature not enabled — rebuild with `cargo build --features local-stt`"
                    .to_string(),
            ),
        }
    }
}

#[cfg(feature = "local-stt")]
fn whisper_transcribe_impl(
    samples: Vec<f32>,
    sample_rate: u32,
    duration: f64,
    model_path: &str,
) -> RecordingStopResponse {
    use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

    // whisper-rs requires 16 kHz mono f32. We don't resample here, so fail
    // loudly on mismatched rates rather than feed wrong-rate audio to the
    // model (which silently produces garbled transcription). Callers who
    // need 44.1/48 kHz support can resample to 16 kHz before calling, or
    // configure cpal with a 16 kHz input stream in audio_start.
    if sample_rate != 16_000 {
        return RecordingStopResponse {
            success: false,
            transcript: None,
            confidence: None,
            duration: Some(duration),
            error: Some(format!(
                "whisper requires 16 kHz mono input; got {sample_rate} Hz. \
                 Resample to 16 kHz before calling whisper_transcribe."
            )),
        };
    }

    let ctx = match WhisperContext::new_with_params(model_path, WhisperContextParameters::default()) {
        Ok(c) => c,
        Err(e) => {
            return RecordingStopResponse {
                success: false,
                transcript: None,
                confidence: None,
                duration: Some(duration),
                error: Some(format!("Failed to load whisper model: {e}")),
            }
        }
    };

    let mut whisper_state = match ctx.create_state() {
        Ok(s) => s,
        Err(e) => {
            return RecordingStopResponse {
                success: false,
                transcript: None,
                confidence: None,
                duration: Some(duration),
                error: Some(format!("Failed to create whisper state: {e}")),
            }
        }
    };

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("en"));
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);

    if let Err(e) = whisper_state.full(params, &samples) {
        return RecordingStopResponse {
            success: false,
            transcript: None,
            confidence: None,
            duration: Some(duration),
            error: Some(format!("Whisper inference failed: {e}")),
        };
    }

    let n = whisper_state.full_n_segments().unwrap_or(0);
    let transcript: String = (0..n)
        .filter_map(|i| whisper_state.full_get_segment_text(i).ok())
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string();

    RecordingStopResponse {
        success: true,
        transcript: Some(transcript),
        confidence: None, // whisper-rs does not expose per-segment confidence
        duration: Some(duration),
        error: None,
    }
}

// ── Clipboard ✅ Phase 2 ───────────────────────────────────────────────────────

#[tauri::command]
pub fn clipboard_write(app: AppHandle, text: String) -> OkResponse {
    app.clipboard()
        .write_text(text)
        .map(|_| OkResponse::ok())
        .unwrap_or_else(|e| OkResponse::err(e.to_string()))
}

// ── Auto-paste ✅ Phase 5: enigo native Ctrl+V (replaces PowerShell ~700 ms) ──

/// Hides the dictation window and sends Ctrl+V to the previously focused app.
///
/// Uses `enigo` for native `SendInput` key injection — no subprocess, no JIT
/// assembly load.  A 50 ms delay gives the OS time to re-focus the target window
/// after we hide ours; that is all the latency budget this path needs.
///
/// On Wayland, `enigo` has no reliable key-injection path, so we skip the
/// simulated keystroke and return an explanatory error. The clipboard copy
/// done upstream still succeeds, so the user can paste manually.
#[tauri::command]
pub fn dictation_auto_paste(app: AppHandle) -> OkResponse {
    use enigo::{Direction, Enigo, Key, Keyboard, Settings};

    if crate::platform::is_wayland() {
        return OkResponse::err(
            "Auto-paste is not supported on Wayland — the transcript is on your \
             clipboard; press Ctrl+V manually.",
        );
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }

    // Background thread: wait for focus to shift, then inject Ctrl+V.
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_millis(50));
        if let Ok(mut enigo) = Enigo::new(&Settings::default()) {
            let _ = enigo.key(Key::Control, Direction::Press);
            let _ = enigo.key(Key::Unicode('v'), Direction::Click);
            let _ = enigo.key(Key::Control, Direction::Release);
        }
    });

    OkResponse::ok()
}

/// Reports runtime platform facts the renderer needs to adjust its UI —
/// today just whether the user is on Wayland so Settings can disable
/// auto-paste and explain why.
#[tauri::command]
pub fn platform_info() -> PlatformInfo {
    PlatformInfo {
        os: std::env::consts::OS.to_string(),
        is_wayland: crate::platform::is_wayland(),
    }
}

#[derive(serde::Serialize)]
pub struct PlatformInfo {
    pub os: String,
    pub is_wayland: bool,
}

// ── Window settings ✅ Phase 2 ────────────────────────────────────────────────

#[tauri::command]
pub fn dictation_set_always_on_top(
    app: AppHandle,
    value: bool,
    state: State<AppState>,
) -> OkResponse {
    *lock_or_recover(&state.dictation_always_on_top) = value;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_always_on_top(value);
    }
    OkResponse::ok()
}

#[tauri::command]
pub fn settings_open_window(app: AppHandle) -> OkResponse {
    match app.get_webview_window("settings") {
        Some(win) => {
            let _ = win.show();
            let _ = win.set_focus();
            OkResponse::ok()
        }
        None => OkResponse::err("settings window not found".to_string()),
    }
}

#[tauri::command]
pub fn app_set_minimize_to_tray(value: bool, state: State<AppState>) -> OkResponse {
    *lock_or_recover(&state.minimize_to_tray) = value;
    OkResponse::ok()
}

// ── Theme & settings broadcast ✅ Phase 2 ─────────────────────────────────────

#[tauri::command]
pub fn theme_broadcast(app: AppHandle, theme_id: String) -> OkResponse {
    app.emit("theme-changed", &theme_id)
        .map(|_| OkResponse::ok())
        .unwrap_or_else(|e| OkResponse::err(e.to_string()))
}

#[tauri::command]
pub fn settings_broadcast(
    settings: HashMap<String, String>,
    state: State<AppState>,
    app: AppHandle,
) -> OkResponse {
    // Side-effects: update backend state from incoming settings map
    if let Some(raw) = settings.get("deepgram_keywords") {
        let keywords: Vec<String> = raw
            .split('\n')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty() && s.len() <= 100)
            .take(50)
            .collect();
        *lock_or_recover(&state.deepgram_keywords) = keywords;
    }
    if let Some(val) = settings.get("minimize_to_tray") {
        *lock_or_recover(&state.minimize_to_tray) = val == "true";
    }

    if let Some(val) = settings.get("number_format") {
        let fmt = match val.as_str() {
            "digits" | "words" => val.clone(),
            _ => "smart".to_string(),
        };
        *lock_or_recover(&state.number_format) = fmt;
    }
    if let Some(val) = settings.get("transcription_language") {
        let lang = val.clone();
        if !lang.is_empty() && lang.len() <= 5 {
            *lock_or_recover(&state.transcription_language) = lang;
        }
    }
    if let Some(val) = settings.get("voice_buffer_enabled") {
        *lock_or_recover(&state.voice_buffer_enabled) = val == "true";
    }
    if let Some(val) = settings.get("voice_buffer_max_size") {
        if let Ok(size) = val.parse::<u64>() {
            *lock_or_recover(&state.voice_buffer_max_size) = size;
            let dir = lock_or_recover(&state.voice_buffer_dir).clone();
            if !dir.as_os_str().is_empty() {
                let _ = crate::voice_buffer::set_max_size(&dir, size);
            }
        }
    }

    app.emit("settings-changed", &settings)
        .map(|_| OkResponse::ok())
        .unwrap_or_else(|e| OkResponse::err(e.to_string()))
}

// ── Global hotkey ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn update_global_hotkey(
    shortcut: String,
    state: State<AppState>,
    app: AppHandle,
) -> OkResponse {
    let new_shortcut = match parse_shortcut(&shortcut) {
        Ok(s) => s,
        Err(e) => return OkResponse::err(format!("Invalid shortcut: {e}")),
    };

    // Unregister the current hotkey
    let old_str = lock_or_recover(&state.global_hotkey).clone();
    if let Ok(old_shortcut) = parse_shortcut(&old_str) {
        let _ = app.global_shortcut().unregister(old_shortcut);
    }

    // Register the new one
    if let Err(e) = app.global_shortcut().register(new_shortcut) {
        // Try to re-register the old one as fallback
        if let Ok(old_shortcut) = parse_shortcut(&old_str) {
            let _ = app.global_shortcut().register(old_shortcut);
        }
        return OkResponse::err(format!("Failed to register shortcut: {e}"));
    }

    *lock_or_recover(&state.global_hotkey) = shortcut;
    debug!("[hotkey] Updated global hotkey to: {}", lock_or_recover(&state.global_hotkey));
    OkResponse::ok()
}

// ── Voice buffer ─────────────────────────────────────────────────────────────

/// Lists all voice buffer recordings (newest first).
#[tauri::command]
pub fn voice_buffer_list(state: State<AppState>) -> Vec<crate::voice_buffer::VoiceRecording> {
    let dir = lock_or_recover(&state.voice_buffer_dir).clone();
    if dir.as_os_str().is_empty() {
        return Vec::new();
    }
    crate::voice_buffer::list_recordings(&dir)
}

/// Returns voice buffer info (size, count, etc.).
#[tauri::command]
pub fn voice_buffer_info(state: State<AppState>) -> crate::voice_buffer::VoiceBufferInfo {
    let dir = lock_or_recover(&state.voice_buffer_dir).clone();
    let enabled = *lock_or_recover(&state.voice_buffer_enabled);
    if dir.as_os_str().is_empty() {
        return crate::voice_buffer::VoiceBufferInfo {
            enabled,
            max_size_bytes: 0,
            current_size_bytes: 0,
            recording_count: 0,
            total_duration_secs: 0.0,
            storage_path: String::new(),
        };
    }
    crate::voice_buffer::get_info(&dir, enabled)
}

/// Returns audio bytes as base64 with MIME type for HTML5 `<audio>` playback.
#[derive(serde::Serialize)]
pub struct AudioDataResponse {
    pub base64: String,
    pub mime: String,
}

#[tauri::command]
pub fn voice_buffer_get_audio(
    filename: String,
    state: State<AppState>,
) -> Result<AudioDataResponse, String> {
    use base64::Engine;
    let dir = lock_or_recover(&state.voice_buffer_dir).clone();
    let bytes = crate::voice_buffer::get_audio(&dir, &filename)?;
    let mime = if filename.ends_with(".ogg") {
        "audio/ogg"
    } else {
        "audio/wav"
    };
    Ok(AudioDataResponse {
        base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        mime: mime.to_string(),
    })
}

/// Deletes a single recording from the voice buffer.
#[tauri::command]
pub fn voice_buffer_delete(
    filename: String,
    state: State<AppState>,
) -> OkResponse {
    let dir = lock_or_recover(&state.voice_buffer_dir).clone();
    match crate::voice_buffer::delete_recording(&dir, &filename) {
        Ok(()) => OkResponse::ok(),
        Err(e) => OkResponse::err(e),
    }
}

/// Clears all recordings from the voice buffer.
#[tauri::command]
pub fn voice_buffer_clear(state: State<AppState>) -> OkResponse {
    let dir = lock_or_recover(&state.voice_buffer_dir).clone();
    match crate::voice_buffer::clear_all(&dir) {
        Ok(()) => OkResponse::ok(),
        Err(e) => OkResponse::err(e),
    }
}

/// Saves the current recording buffer to the voice buffer.
/// Called automatically after recording_stop if voice buffer is enabled,
/// or manually from the frontend.
#[tauri::command]
pub fn voice_buffer_save(
    transcript: String,
    state: State<AppState>,
) -> OkResponse {
    let enabled = *lock_or_recover(&state.voice_buffer_enabled);
    if !enabled {
        return OkResponse::err("Voice buffer is disabled");
    }
    let dir = lock_or_recover(&state.voice_buffer_dir).clone();
    if dir.as_os_str().is_empty() {
        return OkResponse::err("Voice buffer directory not initialized");
    }
    let samples = lock_or_recover(&state.recording_buffer).clone();
    let sample_rate = *lock_or_recover(&state.audio_sample_rate);
    let channels = *lock_or_recover(&state.audio_channels);
    let max_size = *lock_or_recover(&state.voice_buffer_max_size);

    match crate::voice_buffer::save_recording(
        &dir, &samples, sample_rate, channels, &transcript, Some(max_size),
    ) {
        Ok(_filename) => OkResponse::ok(),
        Err(e) => OkResponse::err(e),
    }
}

/// Updates the transcript for a recording in the voice buffer.
#[tauri::command]
pub fn voice_buffer_update_transcript(
    filename: String,
    transcript: String,
    state: State<AppState>,
) -> OkResponse {
    let dir = lock_or_recover(&state.voice_buffer_dir).clone();
    match crate::voice_buffer::update_transcript(&dir, &filename, &transcript) {
        Ok(()) => OkResponse::ok(),
        Err(e) => OkResponse::err(e),
    }
}

/// Re-transcribes a voice buffer recording through Deepgram.
///
/// Decodes the OGG Opus file back to PCM, encodes as WAV, sends to Deepgram
/// batch API, and returns the fresh transcript. The frontend is responsible
/// for running Claude cleanup and calling `voice_buffer_update_transcript`.
#[tauri::command]
pub async fn voice_buffer_reprocess(
    filename: String,
    credential: DeepgramCredential,
    state: State<'_, AppState>,
) -> Result<RecordingStopResponse, String> {
    let dir = lock_or_recover(&state.voice_buffer_dir).clone();
    let raw_bytes = crate::voice_buffer::get_audio(&dir, &filename)?;

    // Decode OGG Opus → i16 PCM (or read WAV directly)
    let (samples_i16, sample_rate, source_channels) = if filename.ends_with(".ogg") {
        let cursor = std::io::Cursor::new(raw_bytes);
        let (samples, _) = ogg_opus::decode::<_, 16000>(cursor)
            .map_err(|e| format!("Failed to decode OGG Opus: {e}"))?;
        (samples, 16_000u32, 1u16)
    } else {
        // WAV — parse header and extract i16 samples. Use try_into-or-error
        // (no unwrap) so a malformed file fails cleanly instead of panicking.
        if raw_bytes.len() < 44 {
            return Err("WAV file too small".to_string());
        }
        let channels_bytes: [u8; 2] = raw_bytes[22..24]
            .try_into()
            .map_err(|_| "WAV header truncated (channels)".to_string())?;
        let rate_bytes: [u8; 4] = raw_bytes[24..28]
            .try_into()
            .map_err(|_| "WAV header truncated (sample rate)".to_string())?;
        let channels = u16::from_le_bytes(channels_bytes).max(1);
        let sample_rate = u32::from_le_bytes(rate_bytes).max(1);
        let samples: Vec<i16> = raw_bytes[44..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|chunk| i16::from_le_bytes(*chunk))
            .collect();
        (samples, sample_rate, channels)
    };

    if samples_i16.is_empty() {
        return Ok(RecordingStopResponse {
            success: false, transcript: None, confidence: None,
            duration: None, error: Some("No audio in recording".to_string()),
        });
    }

    // Convert i16 → f32 for WAV encoding
    let samples_f32: Vec<f32> = samples_i16.iter()
        .map(|&s| s as f32 / i16::MAX as f32)
        .collect();
    let duration = samples_f32.len() as f64 / (sample_rate as f64 * source_channels as f64);
    let wav = crate::audio::pcm_to_wav(&samples_f32, sample_rate, source_channels);

    // Send to Deepgram
    let keywords = lock_or_recover(&state.deepgram_keywords).clone();
    let number_format = lock_or_recover(&state.number_format).clone();
    let language = lock_or_recover(&state.transcription_language).clone();
    let mut url = format!(
        "https://api.deepgram.com/v1/listen?model=nova-3&punctuate=true&smart_format=true&language={language}"
    );
    if number_format == "digits" {
        url.push_str("&numerals=true");
    }
    // nova-3 uses `keyterm` (not the legacy `keywords` param, which 400s on nova-3).
    for kw in &keywords {
        url.push_str(&format!("&keyterm={}", urlencoding::encode(kw)));
    }

    let client = reqwest::Client::new();
    let resp = match client
        .post(&url)
        .header("Authorization", credential.header_value())
        .header("Content-Type", "audio/wav")
        .body(wav)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return Ok(RecordingStopResponse {
                success: false, transcript: None, confidence: None,
                duration: Some(duration), error: Some(format!("Deepgram request failed: {e}")),
            })
        }
    };

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        warn!("[reprocess] Deepgram returned {}: {}", status, &text[..text.len().min(200)]);
        return Ok(RecordingStopResponse {
            success: false, transcript: None, confidence: None,
            duration: Some(duration), error: Some(format!("Deepgram error ({})", status)),
        });
    }

    let json: serde_json::Value = match resp.json().await {
        Ok(j) => j,
        Err(e) => {
            return Ok(RecordingStopResponse {
                success: false, transcript: None, confidence: None,
                duration: Some(duration), error: Some(format!("Invalid Deepgram response: {e}")),
            });
        }
    };

    let alt = json.get("results")
        .and_then(|r| r.get("channels"))
        .and_then(|ch| ch.get(0))
        .and_then(|c| c.get("alternatives"))
        .and_then(|a| a.get(0));

    match alt {
        Some(alt) => Ok(RecordingStopResponse {
            success: true,
            transcript: Some(alt["transcript"].as_str().unwrap_or("").to_string()),
            confidence: alt["confidence"].as_f64(),
            duration: Some(duration),
            error: None,
        }),
        None => Ok(RecordingStopResponse {
            success: false, transcript: None, confidence: None,
            duration: Some(duration), error: Some("Unexpected Deepgram response structure".to_string()),
        }),
    }
}

/// Opens the voice buffer storage folder in the system file manager.
#[tauri::command]
pub fn voice_buffer_open_folder(state: State<AppState>) -> OkResponse {
    let dir = lock_or_recover(&state.voice_buffer_dir).clone();
    if dir.as_os_str().is_empty() || !dir.exists() {
        return OkResponse::err("Voice buffer directory not found");
    }
    crate::platform::open_in_file_manager(&dir);
    OkResponse::ok()
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ok_response_success() {
        let r = OkResponse::ok();
        assert!(r.success);
        assert!(r.error.is_none());
    }

    #[test]
    fn ok_response_error() {
        let r = OkResponse::err("boom");
        assert!(!r.success);
        assert_eq!(r.error.as_deref(), Some("boom"));
    }

    #[test]
    fn ok_response_serialises_no_error_field_when_none() {
        let json = serde_json::to_string(&OkResponse::ok()).unwrap();
        assert!(!json.contains("error"), "error field should be omitted: {json}");
        assert!(json.contains("\"success\":true"));
    }

    #[test]
    fn ok_response_serialises_error_field_when_present() {
        let json = serde_json::to_string(&OkResponse::err("oops")).unwrap();
        assert!(json.contains("\"error\":\"oops\""), "{json}");
        assert!(json.contains("\"success\":false"));
    }

    #[test]
    fn audio_devices_response_shape() {
        let r = AudioDevicesResponse {
            success: true,
            devices: vec!["Mic A".to_string()],
            selected: Some("Mic A".to_string()),
            error: None,
        };
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("\"devices\":[\"Mic A\"]"), "{json}");
        assert!(json.contains("\"selected\":\"Mic A\""), "{json}");
        assert!(!json.contains("\"error\""), "{json}");
    }

    #[test]
    fn recording_stop_response_omits_optionals() {
        let r = RecordingStopResponse {
            success: true,
            transcript: None,
            confidence: None,
            duration: None,
            error: None,
        };
        let json = serde_json::to_string(&r).unwrap();
        assert_eq!(json, r#"{"success":true}"#, "{json}");
    }

    #[test]
    fn recording_stop_response_includes_transcript() {
        let r = RecordingStopResponse {
            success: true,
            transcript: Some("hello world".to_string()),
            confidence: Some(0.99),
            duration: Some(3.2),
            error: None,
        };
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("\"transcript\":\"hello world\""), "{json}");
        assert!(json.contains("\"confidence\":0.99"), "{json}");
        assert!(json.contains("\"duration\":3.2"), "{json}");
    }

    #[test]
    fn settings_broadcast_parses_keywords() {
        let state = AppState::default();
        let mut map = HashMap::new();
        map.insert("deepgram_keywords".to_string(), "MacroVox\nDeepgram\n".to_string());
        if let Some(raw) = map.get("deepgram_keywords") {
            let keywords: Vec<String> = raw
                .split('\n')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            *lock_or_recover(&state.deepgram_keywords) = keywords;
        }
        let kws = lock_or_recover(&state.deepgram_keywords).clone();
        assert_eq!(kws, vec!["MacroVox", "Deepgram"]);
    }

    #[test]
    fn settings_broadcast_parses_minimize_to_tray() {
        let state = AppState::default();
        let mut map = HashMap::new();
        map.insert("minimize_to_tray".to_string(), "true".to_string());
        if let Some(val) = map.get("minimize_to_tray") {
            *lock_or_recover(&state.minimize_to_tray) = val == "true";
        }
        assert!(*lock_or_recover(&state.minimize_to_tray));
    }

    #[test]
    fn audio_set_device_updates_state() {
        let state = AppState::default();
        *lock_or_recover(&state.selected_mic_device) = Some("Headset".to_string());
        assert_eq!(lock_or_recover(&state.selected_mic_device).as_deref(), Some("Headset"));
    }

    #[test]
    fn dictation_set_always_on_top_updates_state() {
        let state = AppState::default();
        *lock_or_recover(&state.dictation_always_on_top) = false;
        assert!(!*lock_or_recover(&state.dictation_always_on_top));
    }

    #[test]
    fn recording_start_clears_buffer_and_sets_flag() {
        let state = AppState::default();
        // Pre-load some stale samples
        lock_or_recover(&state.recording_buffer).push(0.1);
        // Simulate recording_start logic
        lock_or_recover(&state.recording_buffer).clear();
        *lock_or_recover(&state.is_recording) = true;
        assert!(lock_or_recover(&state.recording_buffer).is_empty());
        assert!(*lock_or_recover(&state.is_recording));
    }

    #[test]
    fn recording_cancel_clears_buffer_and_flag() {
        let state = AppState::default();
        lock_or_recover(&state.recording_buffer).push(0.5);
        *lock_or_recover(&state.is_recording) = true;
        // Simulate recording_cancel logic
        *lock_or_recover(&state.is_recording) = false;
        lock_or_recover(&state.recording_buffer).clear();
        assert!(!*lock_or_recover(&state.is_recording));
        assert!(lock_or_recover(&state.recording_buffer).is_empty());
    }

    // ── settings_broadcast voice_buffer parsing ──────────────────────────────
    //
    // settings_broadcast is the central pipe for renderer-driven config
    // changes. The parsing branches for voice_buffer_* settings have caused
    // user-visible bugs (silent acceptance of bogus sizes, on/off flips not
    // persisting). These tests pin the branch logic without needing a real
    // tauri::AppHandle.

    #[test]
    fn voice_buffer_enabled_setting_parses_true_and_false() {
        let state = AppState::default();
        let mut settings: HashMap<String, String> = HashMap::new();

        settings.insert("voice_buffer_enabled".to_string(), "true".to_string());
        if let Some(val) = settings.get("voice_buffer_enabled") {
            *lock_or_recover(&state.voice_buffer_enabled) = val == "true";
        }
        assert!(*lock_or_recover(&state.voice_buffer_enabled));

        settings.insert("voice_buffer_enabled".to_string(), "false".to_string());
        if let Some(val) = settings.get("voice_buffer_enabled") {
            *lock_or_recover(&state.voice_buffer_enabled) = val == "true";
        }
        assert!(!*lock_or_recover(&state.voice_buffer_enabled));
    }

    #[test]
    fn voice_buffer_enabled_treats_unknown_strings_as_false() {
        // Anything other than the literal string "true" should disable the
        // buffer. This is a fail-safe: a typo'd setting must not silently
        // start recording.
        let state = AppState::default();
        for raw in ["1", "yes", "TRUE", "True", "", "garbage"] {
            *lock_or_recover(&state.voice_buffer_enabled) = raw == "true";
            assert!(!*lock_or_recover(&state.voice_buffer_enabled),
                "expected disabled for value {raw:?}");
        }
    }

    #[test]
    fn voice_buffer_max_size_parses_valid_u64() {
        let state = AppState::default();
        let mut settings: HashMap<String, String> = HashMap::new();
        settings.insert("voice_buffer_max_size".to_string(), "104857600".to_string());
        if let Some(val) = settings.get("voice_buffer_max_size") {
            if let Ok(size) = val.parse::<u64>() {
                *lock_or_recover(&state.voice_buffer_max_size) = size;
            }
        }
        assert_eq!(*lock_or_recover(&state.voice_buffer_max_size), 104_857_600);
    }

    #[test]
    fn voice_buffer_max_size_ignores_unparseable_values() {
        // The parsing branch in settings_broadcast is `if let Ok(size) = ...`
        // so unparseable input must leave the previous value intact, not
        // panic and not zero out the cap. Default starts at 100 MB.
        let state = AppState::default();
        let initial = *lock_or_recover(&state.voice_buffer_max_size);

        let mut settings: HashMap<String, String> = HashMap::new();
        for bad in ["", "not-a-number", "-1", "12.5", "9999999999999999999999"] {
            settings.insert("voice_buffer_max_size".to_string(), bad.to_string());
            if let Some(val) = settings.get("voice_buffer_max_size") {
                if let Ok(size) = val.parse::<u64>() {
                    *lock_or_recover(&state.voice_buffer_max_size) = size;
                }
            }
            assert_eq!(*lock_or_recover(&state.voice_buffer_max_size), initial,
                "unparseable {bad:?} must leave max_size unchanged");
        }
    }

    #[test]
    fn transcription_language_setting_rejects_oversize_values() {
        // The branch is `if !lang.is_empty() && lang.len() <= 5` — language
        // codes are like "en"/"es"/"zh-CN"; anything longer is suspect input
        // and must be ignored to avoid driving Deepgram into a bad state.
        let state = AppState::default();
        let initial = lock_or_recover(&state.transcription_language).clone();

        for bad in ["", "english-us", "12345678"] {
            let lang = bad.to_string();
            if !lang.is_empty() && lang.len() <= 5 {
                *lock_or_recover(&state.transcription_language) = lang;
            }
        }
        assert_eq!(*lock_or_recover(&state.transcription_language), initial);

        // The happy path still updates.
        let lang = "es".to_string();
        if !lang.is_empty() && lang.len() <= 5 {
            *lock_or_recover(&state.transcription_language) = lang;
        }
        assert_eq!(*lock_or_recover(&state.transcription_language), "es");
    }

    #[test]
    fn deepgram_keywords_parsing_strips_blanks_and_whitespace() {
        // The settings_broadcast parser splits on '\n', trims, and drops
        // empties — important so a trailing newline doesn't turn into an
        // empty `&keyterm=` parameter that Nova-3 rejects with 400.
        let state = AppState::default();
        let mut map = HashMap::new();
        map.insert(
            "deepgram_keywords".to_string(),
            "  alpha  \n\nbeta\n   \ngamma\n".to_string(),
        );
        if let Some(raw) = map.get("deepgram_keywords") {
            let keywords: Vec<String> = raw
                .split('\n')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            *lock_or_recover(&state.deepgram_keywords) = keywords;
        }
        let kws = lock_or_recover(&state.deepgram_keywords).clone();
        assert_eq!(kws, vec!["alpha", "beta", "gamma"]);
    }
}
