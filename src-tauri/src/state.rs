use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use crate::deepgram_ws::DgSender;

// ── cpal::Stream Send/Sync wrapper ────────────────────────────────────────────

/// Wraps `cpal::Stream` to implement `Send + Sync`.
///
/// `cpal::Stream` is `!Send` on WASAPI due to a `PhantomData<*mut ()>` marker
/// added as a portability guard for macOS (CoreAudio requires thread affinity).
/// On Windows/WASAPI the stream is reference-counted and safe to move between
/// threads; the `Mutex<Option<AudioStream>>` further ensures no simultaneous
/// access from multiple threads.
///
/// This wrapper is **only** used to satisfy `Tauri::State<AppState>` which
/// requires `AppState: Send + Sync`.  The stream is never accessed from more
/// than one thread at a time.
#[allow(dead_code)] // field held only for its Drop; never read back out
pub(crate) struct AudioStream(pub cpal::Stream);

// SAFETY: See doc comment above.
unsafe impl Send for AudioStream {}
unsafe impl Sync for AudioStream {}

/// Shared mutable state for the MacroVox Tauri backend.
///
/// Wrapped in `Mutex` so Tauri command handlers (which run on the async executor)
/// can safely access it. Each field maps to a concept from the old Electron
/// main process globals in `src/main/main.ts`.
///
/// Audio fields (`audio_level`, `recording_buffer`, `is_recording`) are
/// `Arc<Mutex<T>>` rather than plain `Mutex<T>` so the cpal capture callback
/// closure can share them without borrowing `AppState`.
pub struct AppState {
    /// Name of the selected microphone device (`None` = system default).
    pub selected_mic_device: Mutex<Option<String>>,

    /// Whether the dictation window stays on top of other windows.
    pub dictation_always_on_top: Mutex<bool>,

    /// Whether closing the window hides it to tray instead of quitting.
    pub minimize_to_tray: Mutex<bool>,

    /// Set to `true` during app shutdown so that windows with `prevent_close`
    /// handlers (like settings) allow themselves to be destroyed.
    pub is_quitting: AtomicBool,

    // ── Phase 3: cpal WASAPI audio ────────────────────────────────────────────
    /// Live cpal capture stream. Dropping it stops audio capture.
    /// `None` when the stream is stopped.
    /// Wrapped in `AudioStream` to satisfy `Send + Sync` bounds (see above).
    pub audio_stream: Mutex<Option<AudioStream>>,

    /// Current RMS level of the capture stream (range 0.0–1.0).
    /// Updated by the cpal callback on every audio frame.
    pub audio_level: Arc<Mutex<f64>>,

    /// PCM f32 samples accumulated while `is_recording` is true.
    /// Consumed (and cleared) by `recording_stop`.
    pub recording_buffer: Arc<Mutex<Vec<f32>>>,

    /// True between `recording_start` and `recording_stop`/`recording_cancel`.
    pub is_recording: Arc<Mutex<bool>>,

    /// Sample rate of the active capture stream (default 16 000 Hz).
    /// Updated in `audio_start` after opening the device.
    pub audio_sample_rate: Mutex<u32>,

    /// Channel count of the active capture stream (1 = mono, 2 = stereo).
    /// Updated in `audio_start` after opening the device.
    pub audio_channels: Mutex<u16>,

    // ── Deepgram ──────────────────────────────────────────────────────────────
    /// Keywords forwarded to Deepgram for boosted recognition.
    /// Parsed from the `deepgram_keywords` settings key (newline-separated).
    pub deepgram_keywords: Mutex<Vec<String>>,

    /// Number formatting preference for transcripts.
    /// "digits" = always use numerals, "words" = always spell out, "smart" = Deepgram default.
    pub number_format: Mutex<String>,

    /// Global hotkey string, e.g. "Ctrl+Space". Stored so settings_broadcast can
    /// read/display it and update_global_hotkey can unregister the old one.
    pub global_hotkey: Mutex<String>,

    /// Transcription language code for Deepgram (e.g. "en", "es", "fr").
    pub transcription_language: Mutex<String>,

    // ── Phase 4: Deepgram WebSocket streaming ─────────────────────────────────
    /// Sender half of the channel used to push PCM bytes (and control messages)
    /// to the background Deepgram WebSocket task. `None` when no session is
    /// active. Set by `deepgram_start`, cleared by `deepgram_stop`.
    ///
    /// `Arc` so the cpal capture callback can hold a clone without borrowing
    /// `AppState` (which is not available in the callback closure).
    pub dg_sender: Arc<Mutex<Option<DgSender>>>,

    // ── Voice buffer ─────────────────────────────────────────────────────────
    /// Directory where voice memo WAV files and manifest are stored.
    /// Set during app setup to `%LOCALAPPDATA%/com.okstudio.macrovox/voice-buffer/`.
    pub voice_buffer_dir: Mutex<PathBuf>,

    /// Whether the voice buffer feature is enabled (opt-in).
    pub voice_buffer_enabled: Mutex<bool>,

    /// Maximum voice buffer size in bytes (default 100 MB).
    pub voice_buffer_max_size: Mutex<u64>,

    // ── Record-only capture (streaming OGG Opus writer) ──────────────────────
    /// Sender half of the capture tap feeding the record-only writer thread.
    /// `None` when no record-only session is active. `Arc` so the cpal callback
    /// can hold a clone. Dropping the sender ends the writer thread's loop.
    pub capture_tap: Arc<Mutex<Option<crate::recorder::CaptureTap>>>,

    /// The in-flight record-only session, joined by `voice_buffer_record_stop`.
    pub active_recording: Mutex<Option<crate::recorder::ActiveRecording>>,

    // ── Perf instrumentation ──────────────────────────────────────────────────
    /// Wall-clock instant captured when `AppState` is constructed, very early in
    /// `run()`. Used as the zero point for the `perf_mark` command so the
    /// renderer can report time-to-first-paint relative to process start.
    pub started_at: Instant,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            selected_mic_device: Mutex::new(None),
            dictation_always_on_top: Mutex::new(true),
            minimize_to_tray: Mutex::new(false),
            is_quitting: AtomicBool::new(false),
            audio_stream: Mutex::new(None),
            audio_level: Arc::new(Mutex::new(0.0)),
            recording_buffer: Arc::new(Mutex::new(Vec::new())),
            is_recording: Arc::new(Mutex::new(false)),
            audio_sample_rate: Mutex::new(16_000),
            audio_channels: Mutex::new(1),
            deepgram_keywords: Mutex::new(Vec::new()),
            number_format: Mutex::new("smart".to_string()),
            global_hotkey: Mutex::new("Ctrl+Space".to_string()),
            transcription_language: Mutex::new("en".to_string()),
            dg_sender: Arc::new(Mutex::new(None)),
            voice_buffer_dir: Mutex::new(PathBuf::new()),
            voice_buffer_enabled: Mutex::new(false),
            voice_buffer_max_size: Mutex::new(100 * 1024 * 1024), // 100 MB
            capture_tap: Arc::new(Mutex::new(None)),
            active_recording: Mutex::new(None),

            started_at: Instant::now(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_default_values() {
        let state = AppState::default();
        assert!(state.selected_mic_device.lock().unwrap().is_none());
        assert!(*state.dictation_always_on_top.lock().unwrap());
        assert!(!*state.minimize_to_tray.lock().unwrap());
        assert!(state.audio_stream.lock().unwrap().is_none());
        assert_eq!(*state.audio_level.lock().unwrap(), 0.0);
        assert!(state.recording_buffer.lock().unwrap().is_empty());
        assert!(!*state.is_recording.lock().unwrap());
        assert_eq!(*state.audio_sample_rate.lock().unwrap(), 16_000);
        assert_eq!(*state.audio_channels.lock().unwrap(), 1);
        assert!(state.deepgram_keywords.lock().unwrap().is_empty());
        assert!(state.dg_sender.lock().unwrap().is_none());
        assert!(state.capture_tap.lock().unwrap().is_none());
        assert!(state.active_recording.lock().unwrap().is_none());
    }

    #[test]
    fn state_mic_device_mutation() {
        let state = AppState::default();
        *state.selected_mic_device.lock().unwrap() = Some("Headset Mic".to_string());
        assert_eq!(
            state.selected_mic_device.lock().unwrap().as_deref(),
            Some("Headset Mic")
        );
    }

    #[test]
    fn state_audio_level_shared_arc() {
        let state = AppState::default();
        let level_clone = Arc::clone(&state.audio_level);
        *level_clone.lock().unwrap() = 0.75;
        assert_eq!(*state.audio_level.lock().unwrap(), 0.75);
    }

    #[test]
    fn state_recording_buffer_accumulates() {
        let state = AppState::default();
        state
            .recording_buffer
            .lock()
            .unwrap()
            .extend([0.1f32, 0.2, 0.3]);
        assert_eq!(state.recording_buffer.lock().unwrap().len(), 3);
    }

    #[test]
    fn state_dg_sender_is_none_by_default() {
        let state = AppState::default();
        assert!(state.dg_sender.lock().unwrap().is_none());
    }

    #[test]
    fn state_voice_buffer_defaults() {
        let state = AppState::default();
        assert!(!*state.voice_buffer_enabled.lock().unwrap());
        assert_eq!(
            *state.voice_buffer_max_size.lock().unwrap(),
            100 * 1024 * 1024
        );
        assert!(state
            .voice_buffer_dir
            .lock()
            .unwrap()
            .as_os_str()
            .is_empty());
    }

    #[test]
    fn state_keywords_mutation() {
        let state = AppState::default();
        state
            .deepgram_keywords
            .lock()
            .unwrap()
            .extend(["foo".to_string(), "bar".to_string()]);
        assert_eq!(state.deepgram_keywords.lock().unwrap().len(), 2);
    }
}
