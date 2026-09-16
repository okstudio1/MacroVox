use log::{debug, info, warn};
/// MacroVox Tauri commands.
///
/// Every command here mirrors one channel from the Electron preload
/// (`src/main/preload.ts`). The renderer calls them via:
///   `invoke("command_name", payload)`   (see `src/renderer/lib/tauri-ipc.ts`)
///
/// Phase status per command:
///   ✅ Phase 2 — implemented (clipboard, window ops, broadcast events, auto-paste)
///   ✅ Phase 3 — audio (cpal WASAPI replaces ffmpeg subprocess)
///   ✅ Phase 4 — Deepgram WebSocket pre-warm
///   ✅ Phase 5 — enigo native paste (replaces PowerShell ~700 ms)
///   ✅ Phase 6 — auth stubs removed; Supabase JS SDK used from renderer
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;
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
                'A' => Ok(Code::KeyA),
                'B' => Ok(Code::KeyB),
                'C' => Ok(Code::KeyC),
                'D' => Ok(Code::KeyD),
                'E' => Ok(Code::KeyE),
                'F' => Ok(Code::KeyF),
                'G' => Ok(Code::KeyG),
                'H' => Ok(Code::KeyH),
                'I' => Ok(Code::KeyI),
                'J' => Ok(Code::KeyJ),
                'K' => Ok(Code::KeyK),
                'L' => Ok(Code::KeyL),
                'M' => Ok(Code::KeyM),
                'N' => Ok(Code::KeyN),
                'O' => Ok(Code::KeyO),
                'P' => Ok(Code::KeyP),
                'Q' => Ok(Code::KeyQ),
                'R' => Ok(Code::KeyR),
                'S' => Ok(Code::KeyS),
                'T' => Ok(Code::KeyT),
                'U' => Ok(Code::KeyU),
                'V' => Ok(Code::KeyV),
                'W' => Ok(Code::KeyW),
                'X' => Ok(Code::KeyX),
                'Y' => Ok(Code::KeyY),
                'Z' => Ok(Code::KeyZ),
                _ => Err(format!("Unknown key: {s}")),
            }
        }
        other => Err(format!("Unknown key: {other}")),
    }
}

/// Lock a mutex, recovering from poison if a prior thread panicked.
fn lock_or_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
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
        Self {
            success: true,
            error: None,
        }
    }
    pub fn err(msg: impl Into<String>) -> Self {
        Self {
            success: false,
            error: Some(msg.into()),
        }
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

#[derive(serde::Serialize, Debug, Default)]
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
    #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
    pub session_id: Option<u64>,
    #[serde(rename = "limitReached", skip_serializing_if = "Option::is_none")]
    pub limit_reached: Option<bool>,
}

#[derive(serde::Serialize, Debug)]
pub struct DeepgramStartResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
    pub session_id: Option<u64>,
}

// ── Audio ✅ Phase 3: cpal WASAPI native capture ───────────────────────────────

/// The label MacroVox shows for an input device and persists as the chosen
/// microphone.
///
/// cpal 0.17 replaced `Device::name` with a `DeviceDescription`. On WASAPI the
/// endpoint lands in `name` and the adapter in `driver`, so `name` alone is
/// neither stable nor unique: a machine with three microphones reports
/// "Microphone" three times, and every name a user has already saved stops
/// matching, which silently falls back to the default device. Recombining the
/// two fields reproduces the 0.15 string exactly, so saved choices keep
/// working and the picker stays unambiguous. Platforms that leave `driver`
/// empty fall back to the bare name.
fn device_label(device: &cpal::Device) -> Option<String> {
    use cpal::traits::DeviceTrait;
    let description = device.description().ok()?;
    Some(format_device_label(
        description.name(),
        description.driver(),
    ))
}

/// The label format itself, split out so it can be pinned by a test on a
/// machine with no audio hardware.
fn format_device_label(name: &str, driver: Option<&str>) -> String {
    match driver {
        Some(driver) if !driver.is_empty() => format!("{name} ({driver})"),
        _ => name.to_string(),
    }
}

#[tauri::command]
pub fn audio_list_devices(state: State<AppState>) -> AudioDevicesResponse {
    use cpal::traits::HostTrait;
    let host = cpal::default_host();
    let devices: Vec<String> = host
        .input_devices()
        .map(|iter| iter.filter_map(|d| device_label(&d)).collect())
        .unwrap_or_default();
    let devices = filter_device_list(devices);
    let selected = lock_or_recover(&state.selected_mic_device).clone();
    debug!(
        "[audio] devices found: {:?}, selected: {:?}",
        devices, selected
    );
    AudioDevicesResponse {
        success: true,
        devices,
        selected,
        error: None,
    }
}

/// On Linux, cpal's ALSA host enumerates dozens of virtual/alias devices
/// (`hw:`, `plughw:`, `dmix:`, `surround51:CARD=…`, monitor taps, etc.) that
/// are noise for a user-facing picker. Keep only the PulseAudio route and
/// plain capture device names; fall through unchanged on other platforms.
fn filter_device_list(devices: Vec<String>) -> Vec<String> {
    #[cfg(target_os = "linux")]
    {
        const NOISE_PREFIXES: &[&str] = &[
            "sysdefault:",
            "front:",
            "rear:",
            "center_lfe:",
            "side:",
            "surround21:",
            "surround40:",
            "surround41:",
            "surround50:",
            "surround51:",
            "surround71:",
            "iec958:",
            "spdif:",
            "hdmi:",
            "dmix:",
            "dsnoop:",
            "hw:",
            "plughw:",
            "modem:",
            "phoneline:",
            "upmix",
            "vdownmix",
            "samplerate",
            "speexrate",
            "null",
            "jack",
            "oss",
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

    // Perf: time-to-first-capture is the latency a user feels at the record
    // toggle. We break it down (config / build / play) because the platform
    // deltas live in different stages — see `RUST_LOG=info` output.
    let t0 = std::time::Instant::now();

    let host = cpal::default_host();
    let device_name = lock_or_recover(&state.selected_mic_device).clone();
    debug!(
        "[audio] audio_start called, selected device: {:?}",
        device_name
    );

    // Find the requested device, or fall back to the system default.
    let device = if let Some(ref name) = device_name {
        host.input_devices()
            .ok()
            .and_then(|mut iter| iter.find(|d| device_label(d).as_deref() == Some(name.as_str())))
            .or_else(|| {
                warn!(
                    "[audio] Device {:?} not found, falling back to default",
                    name
                );
                host.default_input_device()
            })
    } else {
        host.default_input_device()
    };

    let device = match device {
        Some(d) => {
            debug!(
                "[audio] Using device: {:?}",
                device_label(&d).unwrap_or_default()
            );
            d
        }
        None => {
            warn!("[audio] No input device found!");
            return OkResponse::err("No input device found");
        }
    };

    let config = match device.default_input_config() {
        Ok(c) => {
            debug!(
                "[audio] Input config: {:?}ch @ {}Hz, format={:?}",
                c.channels(),
                c.sample_rate(),
                c.sample_format()
            );
            c
        }
        Err(e) => {
            warn!("[audio] Failed to get input config: {e}");
            return OkResponse::err(format!("Failed to get input config: {e}"));
        }
    };
    let t_config = t0.elapsed();

    // Persist stream parameters for WAV encoding in recording_stop.
    *lock_or_recover(&state.audio_sample_rate) = config.sample_rate();
    *lock_or_recover(&state.audio_channels) = config.channels();

    let capture = crate::audio::CaptureState {
        level: Arc::clone(&state.audio_level),
        buffer: Arc::clone(&state.recording_buffer),
        is_recording: Arc::clone(&state.is_recording),
        dg_sender: Arc::clone(&state.dg_sender),
        capture_tap: Arc::clone(&state.capture_tap),
        limit_reached: Arc::clone(&state.recording_limit_reached),
    };

    match crate::audio::build_input_stream(&device, &config, capture) {
        Ok(stream) => {
            let t_build = t0.elapsed();
            if let Err(e) = stream.play() {
                warn!("[audio] Failed to start stream: {e}");
                return OkResponse::err(format!("Failed to start stream: {e}"));
            }
            let t_play = t0.elapsed();
            debug!("[audio] Stream started successfully");
            info!(
                "[perf] audio_start total={}ms (config={}ms build={}ms play={}ms) {}ch@{}Hz",
                t_play.as_millis(),
                t_config.as_millis(),
                t_build.saturating_sub(t_config).as_millis(),
                t_play.saturating_sub(t_build).as_millis(),
                config.channels(),
                config.sample_rate(),
            );
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
    let _lifecycle = lock_or_recover(&state.deepgram_lifecycle);
    *lock_or_recover(&state.is_recording) = false;
    lock_or_recover(&state.dg_sender).take();
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
) -> Result<DeepgramStartResponse, String> {
    let _start_guard = state.deepgram_start_lock.lock().await;
    {
        let _lifecycle = lock_or_recover(&state.deepgram_lifecycle);
        if state.active_deepgram_session_id.load(Ordering::Acquire) != 0 {
            return Ok(DeepgramStartResponse {
                success: false,
                error: Some("A Deepgram streaming session is already active".to_string()),
                session_id: None,
            });
        }
    }
    // Ensure the audio capture stream is running before opening the WebSocket.
    // Without this the cpal callback never fires and Deepgram receives no audio.
    {
        let has_stream = lock_or_recover(&state.audio_stream).is_some();
        if !has_stream {
            debug!("[deepgram] No audio stream running — starting one");
            let res = audio_start(state.clone());
            if !res.success {
                warn!("[deepgram] Failed to start audio: {:?}", res.error);
                return Ok(DeepgramStartResponse {
                    success: false,
                    error: res.error,
                    session_id: None,
                });
            }
        }
    }

    let sample_rate = *lock_or_recover(&state.audio_sample_rate);
    let channels = *lock_or_recover(&state.audio_channels);
    let keywords = lock_or_recover(&state.deepgram_keywords).clone();
    let number_format = lock_or_recover(&state.number_format).clone();
    let language = lock_or_recover(&state.transcription_language).clone();
    let session_id = state
        .next_deepgram_session_id
        .fetch_add(1, Ordering::AcqRel);
    debug!(
        "[deepgram] Starting session: {}Hz, {}ch, {} keywords, numbers={}, lang={}",
        sample_rate,
        channels,
        keywords.len(),
        number_format,
        language
    );
    {
        let _lifecycle = lock_or_recover(&state.deepgram_lifecycle);
        if state.active_deepgram_session_id.load(Ordering::Acquire) != 0 {
            return Ok(DeepgramStartResponse {
                success: false,
                error: Some("A Deepgram streaming session is already active".to_string()),
                session_id: None,
            });
        }
        state
            .active_deepgram_session_id
            .store(session_id, Ordering::Release);
    }

    match crate::deepgram_ws::start_session(crate::deepgram_ws::DeepgramSessionConfig {
        credential: &credential,
        sample_rate,
        channels,
        keywords: &keywords,
        number_format: &number_format,
        language: &language,
        session_id,
        app,
    })
    .await
    {
        Ok(sender) => {
            let _lifecycle = lock_or_recover(&state.deepgram_lifecycle);
            if state.active_deepgram_session_id.load(Ordering::Acquire) != session_id {
                *lock_or_recover(&state.is_recording) = false;
                *lock_or_recover(&state.audio_stream) = None;
                *lock_or_recover(&state.audio_level) = 0.0;
                return Ok(DeepgramStartResponse {
                    success: false,
                    error: Some("Deepgram streaming session ended during startup".to_string()),
                    session_id: None,
                });
            }
            debug!("[deepgram] WebSocket session established");
            // Replace any existing sender first — on a double-start the previous
            // background task is signaled to close so it can drop its WebSocket
            // and stop counting against quota. Without this it would orphan.
            if let Some(old) = lock_or_recover(&state.dg_sender).replace(sender) {
                let (completion, _ignored) = tokio::sync::oneshot::channel();
                let _ = old.try_send(crate::deepgram_ws::DgMessage::Stop { completion });
            }
            lock_or_recover(&state.recording_buffer).clear();
            state
                .recording_limit_reached
                .store(false, Ordering::Release);
            *lock_or_recover(&state.is_recording) = true;
            Ok(DeepgramStartResponse {
                success: true,
                error: None,
                session_id: Some(session_id),
            })
        }
        Err(e) => {
            warn!("[deepgram] Failed to start session: {e}");
            let _lifecycle = lock_or_recover(&state.deepgram_lifecycle);
            let owned_session = state
                .active_deepgram_session_id
                .compare_exchange(session_id, 0, Ordering::AcqRel, Ordering::Acquire)
                .is_ok();
            if owned_session {
                lock_or_recover(&state.dg_sender).take();
                *lock_or_recover(&state.is_recording) = false;
                *lock_or_recover(&state.audio_stream) = None;
                *lock_or_recover(&state.audio_level) = 0.0;
            }
            Ok(DeepgramStartResponse {
                success: false,
                error: Some(e),
                session_id: None,
            })
        }
    }
}

/// Stops Deepgram WebSocket streaming and closes the connection.
///
/// Sends `DgMessage::Stop` to the background task, which in turn sends
/// `{"type":"CloseStream"}` to Deepgram and drains any final transcript
/// fragments before exiting.  Any remaining `"deepgram:transcript"` events
/// will still arrive in the renderer before the socket closes.
fn invalidate_streaming_session(state: &AppState, session_id: u64) {
    state.clear_deepgram_session_if_active(session_id);
}

#[tauri::command]
pub async fn deepgram_stop(
    session_id: Option<u64>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RecordingStopResponse, String> {
    let lifecycle = lock_or_recover(&state.deepgram_lifecycle);
    let active_session = state.active_deepgram_session_id.load(Ordering::Acquire);
    if active_session == 0 || session_id.is_some_and(|id| id != active_session) {
        return Ok(RecordingStopResponse {
            success: false,
            transcript: None,
            confidence: None,
            duration: None,
            error: Some("Streaming session is no longer active".to_string()),
            session_id: Some(active_session).filter(|id| *id != 0),
            limit_reached: None,
        });
    }
    *lock_or_recover(&state.is_recording) = false;
    *lock_or_recover(&state.audio_stream) = None;
    *lock_or_recover(&state.audio_level) = 0.0;
    let samples = std::mem::take(&mut *lock_or_recover(&state.recording_buffer));
    let sample_count = samples.len();
    let sample_rate = (*lock_or_recover(&state.audio_sample_rate)).max(1);
    let channels = (*lock_or_recover(&state.audio_channels)).max(1);
    let duration = sample_count as f64 / (sample_rate as f64 * channels as f64);
    let limit_reached = state.recording_limit_reached.load(Ordering::Acquire);
    let voice_history = if *lock_or_recover(&state.voice_buffer_enabled) {
        let dir = lock_or_recover(&state.voice_buffer_dir).clone();
        let max_size = *lock_or_recover(&state.voice_buffer_max_size);
        if dir.as_os_str().is_empty() {
            None
        } else {
            let epoch = crate::voice_buffer::history_epoch(&dir);
            Some((dir, max_size, epoch))
        }
    } else {
        None
    };

    // Take the sender out of state — dropping it signals the task to close,
    // but sending Stop first gives Deepgram a chance to flush its buffer.
    let sender = lock_or_recover(&state.dg_sender).take();
    drop(lifecycle);
    let Some(sender) = sender else {
        invalidate_streaming_session(&state, active_session);
        return Ok(RecordingStopResponse {
            success: false,
            transcript: None,
            confidence: None,
            duration: Some(duration),
            error: Some("Deepgram streaming worker is unavailable".to_string()),
            session_id: Some(active_session),
            limit_reached: Some(limit_reached),
        });
    };
    let (completion, finished) = tokio::sync::oneshot::channel();
    if tokio::time::timeout(
        std::time::Duration::from_secs(12),
        sender.send(crate::deepgram_ws::DgMessage::Stop { completion }),
    )
    .await
    .map_or(true, |result| result.is_err())
    {
        invalidate_streaming_session(&state, active_session);
        return Ok(RecordingStopResponse {
            success: false,
            transcript: None,
            confidence: None,
            duration: Some(duration),
            error: Some("Deepgram streaming worker stopped unexpectedly".to_string()),
            session_id: Some(active_session),
            limit_reached: Some(limit_reached),
        });
    }
    let result = tokio::time::timeout(std::time::Duration::from_secs(10), finished)
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_else(|| crate::deepgram_ws::StreamingStopResult {
            transcript: String::new(),
            error: Some("Timed out stopping Deepgram streaming worker".to_string()),
        });
    if result.error.as_deref() == Some("Timed out stopping Deepgram streaming worker") {
        invalidate_streaming_session(&state, active_session);
    }
    let success = result.error.is_none();
    if let Some(transcript) = Some(result.transcript.clone()).filter(|text| !text.is_empty()) {
        if let Some((dir, max_size, history_epoch)) = voice_history.filter(|_| !samples.is_empty())
        {
            tauri::async_runtime::spawn_blocking(move || {
                match crate::voice_buffer::save_recording_at_epoch(
                    &dir,
                    &samples,
                    sample_rate,
                    channels,
                    &transcript,
                    Some(max_size),
                    history_epoch,
                ) {
                    Ok(_) => {
                        let _ = app.emit("voice-buffer-updated", ());
                    }
                    Err(error) => warn!("[voice_buffer] Streaming auto-save failed: {error}"),
                }
            });
        }
    }
    Ok(RecordingStopResponse {
        success,
        transcript: Some(result.transcript).filter(|text| !text.is_empty()),
        confidence: None,
        duration: Some(duration),
        error: result.error,
        session_id: Some(active_session),
        limit_reached: Some(limit_reached),
    })
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
    state
        .recording_limit_reached
        .store(false, Ordering::Release);
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
    *lock_or_recover(&state.audio_stream) = None;
    *lock_or_recover(&state.audio_level) = 0.0;
    let samples = std::mem::take(&mut *lock_or_recover(&state.recording_buffer));
    let sample_rate = *lock_or_recover(&state.audio_sample_rate);
    let channels = *lock_or_recover(&state.audio_channels);
    let limit_reached = state.recording_limit_reached.load(Ordering::Acquire);
    let voice_history = if *lock_or_recover(&state.voice_buffer_enabled) {
        let dir = lock_or_recover(&state.voice_buffer_dir).clone();
        let max_size = *lock_or_recover(&state.voice_buffer_max_size);
        if dir.as_os_str().is_empty() {
            None
        } else {
            let epoch = crate::voice_buffer::history_epoch(&dir);
            Some((dir, max_size, epoch))
        }
    } else {
        None
    };
    // State locks released here — safe to await below.

    if samples.is_empty() {
        return Ok(RecordingStopResponse {
            success: false,
            transcript: None,
            confidence: None,
            duration: None,
            error: Some("No audio was captured".to_string()),
            session_id: None,
            limit_reached: Some(limit_reached),
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

    let request_started = Instant::now();
    let resp = match state
        .http_client
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
                session_id: None,
                limit_reached: Some(limit_reached),
            })
        }
    };

    let status = resp.status();
    debug!(
        "[recording] Deepgram request completed: status={}, elapsed_ms={}",
        status,
        request_started.elapsed().as_millis(),
    );
    if !status.is_success() {
        warn!("[recording] Deepgram returned status {}", status);
        return Ok(RecordingStopResponse {
            success: false,
            transcript: None,
            confidence: None,
            duration: Some(duration),
            error: Some(format!("Deepgram error ({})", status)),
            session_id: None,
            limit_reached: Some(limit_reached),
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
                session_id: None,
                limit_reached: Some(limit_reached),
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
            if let Some((dir, max_size, history_epoch)) =
                voice_history.filter(|_| !transcript_text.is_empty())
            {
                let transcript_clone = transcript_text.clone();
                // Clone the AppHandle so the background thread can notify
                // webviews. Without this, the settings window's recordings
                // list stays frozen at whatever was on disk when its
                // WebView2 first loaded, since batch mode never round-trips
                // through the renderer's voice_buffer_save path.
                let app_handle = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    match crate::voice_buffer::save_recording_at_epoch(
                        &dir,
                        &samples,
                        safe_sample_rate,
                        safe_channels,
                        &transcript_clone,
                        Some(max_size),
                        history_epoch,
                    ) {
                        Ok(_) => {
                            let _ = app_handle.emit("voice-buffer-updated", ());
                        }
                        Err(e) => warn!("[voice_buffer] Auto-save failed: {e}"),
                    }
                });
            }

            Ok(RecordingStopResponse {
                success: true,
                transcript: Some(transcript_text),
                confidence: alt["confidence"].as_f64(),
                duration: Some(duration),
                error: None,
                session_id: None,
                limit_reached: Some(limit_reached),
            })
        }
        None => Ok(RecordingStopResponse {
            success: false,
            transcript: None,
            confidence: None,
            duration: Some(duration),
            error: Some("Unexpected Deepgram response structure".to_string()),
            session_id: None,
            limit_reached: Some(limit_reached),
        }),
    }
}

/// Discards the recording buffer without transcribing.
#[tauri::command]
pub fn recording_cancel(state: State<AppState>) -> OkResponse {
    *lock_or_recover(&state.is_recording) = false;
    *lock_or_recover(&state.audio_stream) = None;
    *lock_or_recover(&state.audio_level) = 0.0;
    lock_or_recover(&state.recording_buffer).clear();
    OkResponse::ok()
}

// ── Updates ───────────────────────────────────────────────────────────────────

/// Downloads the pending update, checks the installer against our code-signing
/// certificate, and only then hands it to the updater plugin.
///
/// The plugin verifies a minisign signature inside `download` and nothing at
/// all inside `install`, so this command exists to put a second, independent
/// gate in that gap: see `update_guard`.
///
/// On success this process does not return. `install` launches the installer
/// and exits, so any response the renderer actually receives is a failure and
/// the transcript-style fallback applies: the user can download the installer
/// themselves.
#[tauri::command]
pub async fn updater_install(app: AppHandle) -> OkResponse {
    use tauri_plugin_updater::UpdaterExt;

    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(e) => {
            warn!("[updater] unavailable: {e}");
            return OkResponse::err(format!("Updater unavailable: {e}"));
        }
    };

    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => return OkResponse::err("No update is available"),
        Err(e) => {
            warn!("[updater] check failed: {e}");
            return OkResponse::err(format!("Update check failed: {e}"));
        }
    };

    // `download` returns bytes whose minisign signature has already been
    // verified against the key compiled into this binary.
    let bytes = match update.download(|_, _| {}, || {}).await {
        Ok(bytes) => bytes,
        Err(e) => {
            warn!("[updater] download failed: {e}");
            return OkResponse::err(format!("Update download failed: {e}"));
        }
    };

    // Authenticode is checked against a file, so the verified bytes are staged
    // on disk for the query and removed again immediately. The bytes handed to
    // `install` are the same buffer that was verified here.
    let staged = std::env::temp_dir().join(format!(
        "macrovox-{}-update-{}.exe",
        update.version,
        std::process::id()
    ));
    if let Err(e) = std::fs::write(&staged, &bytes) {
        warn!("[updater] could not stage the installer: {e}");
        return OkResponse::err(format!("Could not stage the installer: {e}"));
    }
    let verdict = crate::update_guard::verify_installer(&staged, &update.version);
    let _ = std::fs::remove_file(&staged);

    if let Err(reason) = verdict {
        warn!("[updater] refused {}: {reason}", update.version);
        return OkResponse::err(format!(
            "This update was refused because {reason}. Nothing was installed."
        ));
    }

    info!(
        "[updater] installing {} after signature checks",
        update.version
    );
    match update.install(bytes) {
        Ok(()) => OkResponse::ok(),
        Err(e) => {
            warn!("[updater] install failed: {e}");
            OkResponse::err(format!("Update install failed: {e}"))
        }
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
/// Uses `enigo` for native key injection on Windows, macOS, and Linux/X11 — no
/// subprocess, no JIT assembly load. A 50 ms delay gives the OS time to re-focus
/// the target window after we hide ours; that is all the latency budget this
/// path needs.
///
/// On Wayland, `enigo` cannot synthesise input, so we fall back to a
/// Wayland-native tool (`wtype` or `ydotool`) when one is installed. If neither
/// is present we return an explanatory error; the clipboard copy done upstream
/// still succeeded, so the user can paste manually.
///
/// Logs the end-to-end inject latency at `info` level (`[perf] auto_paste …`).
#[tauri::command]
pub fn dictation_auto_paste(app: AppHandle) -> OkResponse {
    let t0 = std::time::Instant::now();

    // Wayland: enigo's XTEST path is inert — route through wtype/ydotool instead.
    #[cfg(target_os = "linux")]
    if crate::platform::is_wayland() {
        let tool = match crate::platform::wayland_paste_tool() {
            Some(t) => t,
            None => {
                return OkResponse::err(
                    "Auto-paste on Wayland needs `wtype` or `ydotool` installed — \
                     the transcript is on your clipboard; press Ctrl+V to paste, \
                     or install one of those tools to enable auto-paste.",
                );
            }
        };
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.hide();
        }
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(50));
            match crate::platform::wayland_send_paste(tool) {
                Ok(()) => info!(
                    "[perf] auto_paste(wayland:{tool:?}) injected in {}ms",
                    t0.elapsed().as_millis()
                ),
                Err(e) => warn!("[auto-paste] {tool:?} failed: {e}"),
            }
        });
        return OkResponse::ok();
    }

    // Windows, macOS, Linux/X11: native enigo key injection.
    use enigo::{Direction, Enigo, Key, Keyboard, Settings};

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }

    // Background thread: wait for focus to shift, then inject Ctrl+V.
    //
    // Every step is checked. A silent no-op here is indistinguishable from a
    // target application that ignored the paste, and the transcript is already
    // on the clipboard, so a failure is worth one line telling the user that.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(50));
        match Enigo::new(&Settings::default()) {
            Ok(mut enigo) => {
                // `v` is only clicked once the modifier is actually down,
                // otherwise the keystroke types a literal "v" into whatever
                // the user was working in. A modifier that did go down is
                // always released, or it stays stuck for their next keypress.
                let outcome = match enigo.key(Key::Control, Direction::Press) {
                    Err(e) => Err(format!("Ctrl press failed: {e}")),
                    Ok(()) => {
                        let clicked = enigo
                            .key(Key::Unicode('v'), Direction::Click)
                            .map_err(|e| format!("paste keystroke failed: {e}"));
                        let released = enigo
                            .key(Key::Control, Direction::Release)
                            .map_err(|e| format!("Ctrl release failed: {e}"));
                        clicked.and(released)
                    }
                };
                match outcome {
                    Ok(()) => info!(
                        "[perf] auto_paste(enigo) completed in {}ms",
                        t0.elapsed().as_millis()
                    ),
                    Err(reason) => warn!(
                        "[auto-paste] {reason}. Transcript is on the clipboard; press Ctrl+V."
                    ),
                }
            }
            Err(e) => {
                warn!("[auto-paste] injection unavailable: {e}. Transcript is on the clipboard.")
            }
        }
    });

    OkResponse::ok()
}

/// Reports runtime platform facts the renderer needs to adjust its UI: whether
/// the user is on Wayland, and whether auto-paste can actually inject a
/// keystroke (false on Wayland with no `wtype`/`ydotool`). Settings uses
/// `auto_paste_available` to enable or disable the "Auto-paste on stop" toggle.
#[tauri::command]
pub fn platform_info() -> PlatformInfo {
    PlatformInfo {
        os: std::env::consts::OS.to_string(),
        is_wayland: crate::platform::is_wayland(),
        auto_paste_available: crate::platform::auto_paste_available(),
    }
}

#[derive(serde::Serialize)]
pub struct PlatformInfo {
    pub os: String,
    pub is_wayland: bool,
    pub auto_paste_available: bool,
}

/// Perf marker: logs `label` with the elapsed time since process start.
///
/// The renderer calls this once it has painted its first frame so we can measure
/// real time-to-first-paint (`[perf] dictation_first_paint …`) instead of
/// relying on folklore about WebView engine cold-start. Surfaced at `info` level
/// — run with `RUST_LOG=info` (or `debug`) to see it.
#[tauri::command]
pub fn perf_mark(state: State<AppState>, label: String) -> OkResponse {
    let ms = state.started_at.elapsed().as_millis();
    info!("[perf] {label}: {ms}ms since process start");
    OkResponse::ok()
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
    debug!(
        "[hotkey] Updated global hotkey to: {}",
        lock_or_recover(&state.global_hotkey)
    );
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
pub fn voice_buffer_delete(filename: String, state: State<AppState>) -> OkResponse {
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
pub async fn voice_buffer_save(
    transcript: String,
    state: State<'_, AppState>,
) -> Result<OkResponse, String> {
    let enabled = *lock_or_recover(&state.voice_buffer_enabled);
    if !enabled {
        return Ok(OkResponse::err("Voice buffer is disabled"));
    }
    let dir = lock_or_recover(&state.voice_buffer_dir).clone();
    if dir.as_os_str().is_empty() {
        return Ok(OkResponse::err("Voice buffer directory not initialized"));
    }
    let samples = lock_or_recover(&state.recording_buffer).clone();
    let sample_rate = *lock_or_recover(&state.audio_sample_rate);
    let channels = *lock_or_recover(&state.audio_channels);
    let max_size = *lock_or_recover(&state.voice_buffer_max_size);
    let history_epoch = crate::voice_buffer::history_epoch(&dir);

    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::voice_buffer::save_recording_at_epoch(
            &dir,
            &samples,
            sample_rate,
            channels,
            &transcript,
            Some(max_size),
            history_epoch,
        )
    })
    .await
    .map_err(|e| format!("Voice buffer worker failed: {e}"))?;
    Ok(match result {
        Ok(_filename) => OkResponse::ok(),
        Err(e) => OkResponse::err(e),
    })
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
/// Uploads the stored OGG Opus (or WAV) file as-is to Deepgram's pre-recorded
/// API and returns the fresh transcript. The frontend is responsible for
/// running Claude cleanup and calling `voice_buffer_update_transcript`.
#[tauri::command]
pub async fn voice_buffer_reprocess(
    filename: String,
    credential: DeepgramCredential,
    state: State<'_, AppState>,
) -> Result<RecordingStopResponse, String> {
    let dir = lock_or_recover(&state.voice_buffer_dir).clone();
    let raw_bytes = crate::voice_buffer::get_audio(&dir, &filename)?;

    if raw_bytes.is_empty() {
        return Ok(RecordingStopResponse {
            success: false,
            transcript: None,
            confidence: None,
            duration: None,
            error: Some("No audio in recording".to_string()),
            ..Default::default()
        });
    }

    // Upload the stored file as-is. Deepgram demuxes OGG Opus (and WAV)
    // natively, so there is no need to decode to PCM first. That mattered
    // little for five-minute dictations, but an hour-long record-only session
    // would balloon to hundreds of MB of WAV in memory and on the wire.
    let content_type = if filename.ends_with(".ogg") {
        "audio/ogg"
    } else {
        "audio/wav"
    };
    let duration = crate::voice_buffer::list_recordings(&dir)
        .into_iter()
        .find(|r| r.file == filename)
        .map(|r| r.duration_secs)
        .unwrap_or(0.0);

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

    let request_started = Instant::now();
    let resp = match state
        .http_client
        .post(&url)
        .header("Authorization", credential.header_value())
        .header("Content-Type", content_type)
        .body(raw_bytes)
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
                ..Default::default()
            })
        }
    };

    let status = resp.status();
    debug!(
        "[reprocess] Deepgram request completed: status={}, elapsed_ms={}",
        status,
        request_started.elapsed().as_millis(),
    );
    if !status.is_success() {
        warn!("[reprocess] Deepgram returned status {}", status);
        return Ok(RecordingStopResponse {
            success: false,
            transcript: None,
            confidence: None,
            duration: Some(duration),
            error: Some(format!("Deepgram error ({})", status)),
            ..Default::default()
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
                ..Default::default()
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
        Some(alt) => Ok(RecordingStopResponse {
            success: true,
            transcript: Some(alt["transcript"].as_str().unwrap_or("").to_string()),
            confidence: alt["confidence"].as_f64(),
            duration: Some(duration),
            error: None,
            ..Default::default()
        }),
        None => Ok(RecordingStopResponse {
            success: false,
            transcript: None,
            confidence: None,
            duration: Some(duration),
            error: Some("Unexpected Deepgram response structure".to_string()),
            ..Default::default()
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

// ── Record-only sessions (unlimited length) ──────────────────────────────────

/// Response for `voice_buffer_record_stop`.
#[derive(serde::Serialize, Debug)]
pub struct RecordStopResponse {
    pub success: bool,
    pub recording: Option<crate::voice_buffer::VoiceRecording>,
    pub error: Option<String>,
}

/// Starts a "record only" session: audio is streamed straight to an OGG Opus
/// file in the voice buffer directory with no length limit and no transcription.
///
/// Unlike `recording_start`, this does not touch `is_recording` or the
/// in-memory `recording_buffer` (which is capped at five minutes). It installs
/// a capture tap that the cpal callback feeds; a writer thread encodes and
/// appends pages as audio arrives. Not gated on `voice_buffer_enabled`: that
/// flag controls auto-saving dictations, whereas saving is the whole point of
/// this mode. Needs no API key.
#[tauri::command]
pub fn voice_buffer_record_start(state: State<AppState>) -> OkResponse {
    if lock_or_recover(&state.active_recording).is_some() {
        return OkResponse::err("A recording is already in progress");
    }
    let dir = lock_or_recover(&state.voice_buffer_dir).clone();
    if dir.as_os_str().is_empty() {
        return OkResponse::err("Voice buffer directory not initialized");
    }
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return OkResponse::err(format!("Failed to create voice buffer directory: {e}"));
    }

    let has_stream = lock_or_recover(&state.audio_stream).is_some();
    if !has_stream {
        debug!("[record] No audio stream running, starting one");
        let res = audio_start(state.clone());
        if !res.success {
            return res;
        }
    }
    let sample_rate = (*lock_or_recover(&state.audio_sample_rate)).max(1);
    let channels = (*lock_or_recover(&state.audio_channels)).max(1);

    let started_at = chrono::Local::now();
    let filename = format!("{}.ogg", started_at.format("%Y-%m-%dT%H-%M-%S%.3f"));
    let partial_path = dir.join(crate::recorder::partial_name(&filename));

    // Create the file and encoder up front so a failure surfaces now, not at stop.
    let writer =
        match crate::recorder::OpusStreamWriter::create(&partial_path, sample_rate, channels) {
            Ok(w) => w,
            Err(e) => return OkResponse::err(e),
        };
    let (tx, rx) = std::sync::mpsc::sync_channel(crate::recorder::TAP_CAPACITY);
    let worker = match crate::recorder::spawn_writer(writer, rx) {
        Ok(handle) => handle,
        Err(e) => {
            let _ = std::fs::remove_file(&partial_path);
            return OkResponse::err(e);
        }
    };

    *lock_or_recover(&state.capture_tap) = Some(tx);
    *lock_or_recover(&state.active_recording) = Some(crate::recorder::ActiveRecording {
        filename: filename.clone(),
        started_at,
        history_epoch: crate::voice_buffer::history_epoch(&dir),
        worker,
    });
    debug!("[record] Started record-only session: {filename}");
    OkResponse::ok()
}

/// Stops the record-only session, finalizes the OGG file, and registers it in
/// the voice buffer manifest with an empty transcript.
///
/// Async so the (short) join on the writer thread runs on the blocking pool
/// rather than the main thread. Sessions shorter than
/// `recorder::MIN_RECORDING_SECS` are discarded as accidental double-taps.
#[tauri::command]
pub async fn voice_buffer_record_stop(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<RecordStopResponse, String> {
    // Drop the tap first: the callback stops feeding the channel, the writer's
    // receive loop ends, and it finalizes the file.
    *lock_or_recover(&state.capture_tap) = None;
    let Some(active) = lock_or_recover(&state.active_recording).take() else {
        return Ok(RecordStopResponse {
            success: false,
            recording: None,
            error: Some("No recording in progress".to_string()),
        });
    };
    let dir = lock_or_recover(&state.voice_buffer_dir).clone();
    let max_size = *lock_or_recover(&state.voice_buffer_max_size);

    let result = tauri::async_runtime::spawn_blocking(move || {
        let partial_path = active.partial_path(&dir);
        let finished = match active.worker.join() {
            Ok(Ok(finished)) => finished,
            Ok(Err(e)) => {
                let _ = std::fs::remove_file(&partial_path);
                return Err(e);
            }
            Err(_) => {
                let _ = std::fs::remove_file(&partial_path);
                return Err("Recording writer thread panicked".to_string());
            }
        };
        if finished.duration_secs < crate::recorder::MIN_RECORDING_SECS {
            let _ = std::fs::remove_file(&partial_path);
            return Err("Recording was too short to save".to_string());
        }
        let final_path = dir.join(&active.filename);
        std::fs::rename(&partial_path, &final_path)
            .map_err(|e| format!("Failed to finalize recording: {e}"))?;
        crate::voice_buffer::register_recording_at_epoch(
            &dir,
            &active.filename,
            active.started_at.to_rfc3339(),
            finished.duration_secs,
            finished.size_bytes,
            Some(max_size),
            active.history_epoch,
        )
    })
    .await
    .map_err(|e| format!("Recording finalize task failed: {e}"))?;

    match result {
        Ok(recording) => {
            let _ = app.emit("voice-buffer-updated", ());
            Ok(RecordStopResponse {
                success: true,
                recording: Some(recording),
                error: None,
            })
        }
        Err(e) => {
            warn!("[record] Stop failed: {e}");
            Ok(RecordStopResponse {
                success: false,
                recording: None,
                error: Some(e),
            })
        }
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_label_recombines_endpoint_and_adapter() {
        // These are the exact strings cpal 0.15 returned from `Device::name`
        // on WASAPI, which is what users already have saved as their
        // microphone choice. cpal 0.17 splits them across two fields.
        assert_eq!(
            format_device_label("Microphone", Some("Shure MV7+")),
            "Microphone (Shure MV7+)"
        );
        assert_eq!(
            format_device_label("IN 1", Some("BEHRINGER UMC 404HD 192k")),
            "IN 1 (BEHRINGER UMC 404HD 192k)"
        );
    }

    #[test]
    fn device_label_falls_back_to_the_bare_name() {
        // Hosts that do not report an adapter, and the ALSA-style names the
        // Linux picker filters on, must survive unchanged.
        assert_eq!(format_device_label("default", None), "default");
        assert_eq!(
            format_device_label("hw:CARD=PCH,DEV=0", Some("")),
            "hw:CARD=PCH,DEV=0"
        );
    }

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
        assert!(
            !json.contains("error"),
            "error field should be omitted: {json}"
        );
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
            ..Default::default()
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
            ..Default::default()
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
        map.insert(
            "deepgram_keywords".to_string(),
            "MacroVox\nDeepgram\n".to_string(),
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
        assert_eq!(
            lock_or_recover(&state.selected_mic_device).as_deref(),
            Some("Headset")
        );
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
            assert!(
                !*lock_or_recover(&state.voice_buffer_enabled),
                "expected disabled for value {raw:?}"
            );
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
            assert_eq!(
                *lock_or_recover(&state.voice_buffer_max_size),
                initial,
                "unparseable {bad:?} must leave max_size unchanged"
            );
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
