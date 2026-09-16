//! MacroVox audio utilities — Phase 3/4: cpal WASAPI native capture.
//!
//! This module provides:
//! - `pcm_to_wav`          — encode f32 PCM samples as RIFF/WAV bytes (for Deepgram upload)
//! - `f32_to_i16_bytes`    — convert f32 samples to interleaved i16 LE bytes (for WS streaming)
//! - `process_audio_frame` — cpal callback body; updates level, buffer, and streams PCM
//! - `build_input_stream`  — open a cpal capture stream, dispatching on sample format

use crate::deepgram_ws::{DgMessage, DgSender};
use cpal::traits::DeviceTrait;
use log::warn;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

/// Lock a mutex, recovering from poison if a prior thread panicked.
fn lock_or_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Counter for frames dropped due to channel backpressure. Surfaced via a
/// rate-limited `warn!` so sustained drops are visible in logs without
/// flooding (one line per 100 drops).
static DROPPED_FRAMES: AtomicUsize = AtomicUsize::new(0);

/// Same idea for the record-only capture tap (frames the streaming writer
/// thread could not accept in time).
static TAP_DROPPED_FRAMES: AtomicUsize = AtomicUsize::new(0);

// ── WAV encoding ─────────────────────────────────────────────────────────────

/// Encodes interleaved f32 PCM samples as a RIFF/WAV byte vector.
///
/// Samples are clamped to `[-1.0, 1.0]` and stored as 16-bit signed PCM.
/// `channels` should match the channel count of `samples` (1 = mono, 2 = stereo).
pub fn pcm_to_wav(samples: &[f32], sample_rate: u32, channels: u16) -> Vec<u8> {
    let bits_per_sample: u16 = 16;
    let byte_rate = sample_rate * channels as u32 * bits_per_sample as u32 / 8;
    let block_align = channels * bits_per_sample / 8;
    let data_size = (samples.len() * bits_per_sample as usize / 8) as u32;
    // RIFF file size = 4 ("WAVE") + fmt chunk (24) + data chunk header (8) + data = 36 + data_size
    let riff_size = 36 + data_size;

    let mut buf = Vec::with_capacity(44 + data_size as usize);

    // RIFF header
    buf.extend_from_slice(b"RIFF");
    buf.extend_from_slice(&riff_size.to_le_bytes());
    buf.extend_from_slice(b"WAVE");

    // fmt chunk (16-byte PCM format)
    buf.extend_from_slice(b"fmt ");
    buf.extend_from_slice(&16u32.to_le_bytes()); // chunk size
    buf.extend_from_slice(&1u16.to_le_bytes()); // PCM = 1
    buf.extend_from_slice(&channels.to_le_bytes());
    buf.extend_from_slice(&sample_rate.to_le_bytes());
    buf.extend_from_slice(&byte_rate.to_le_bytes());
    buf.extend_from_slice(&block_align.to_le_bytes());
    buf.extend_from_slice(&bits_per_sample.to_le_bytes());

    // data chunk
    buf.extend_from_slice(b"data");
    buf.extend_from_slice(&data_size.to_le_bytes());
    for &s in samples {
        let val = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        buf.extend_from_slice(&val.to_le_bytes());
    }

    buf
}

// ── PCM conversion ────────────────────────────────────────────────────────────

/// Converts interleaved f32 PCM samples to 16-bit signed little-endian bytes.
///
/// This is the encoding Deepgram's streaming API expects (`encoding=linear16`).
/// Samples outside `[-1.0, 1.0]` are clamped before conversion.
pub fn f32_to_i16_bytes(samples: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for &s in samples {
        let val = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        bytes.extend_from_slice(&val.to_le_bytes());
    }
    bytes
}

// ── Capture callback ──────────────────────────────────────────────────────────

/// Maximum amount of PCM retained for batch transcription and voice history.
pub const MAX_RECORDING_DURATION_SECS: u64 = 5 * 60;
pub const MAX_RECORDING_BUFFER_BYTES: usize = 128 * 1024 * 1024;

/// Calculates the sample cap from the active device format and requested duration.
/// The result is bounded against integer overflow on unusual device profiles.
pub fn recording_sample_limit(sample_rate: u32, channels: u16, duration_secs: u64) -> usize {
    let channel_count = usize::from(channels.max(1));
    let samples = u64::from(sample_rate)
        .saturating_mul(u64::from(channels.max(1)))
        .saturating_mul(duration_secs);
    let duration_limit = usize::try_from(samples).unwrap_or(usize::MAX);
    let byte_limit =
        (MAX_RECORDING_BUFFER_BYTES / std::mem::size_of::<f32>()) / channel_count * channel_count;
    duration_limit.min(byte_limit)
}

/// Called from the cpal input-stream callback with a slice of f32 samples.
///
/// - Updates `level` with the RMS value of the frame (always).
/// - When `is_recording` is true:
///   - Appends samples to `buffer` (for batch/pre-recorded API path),
///     capped at `MAX_BUFFER_SAMPLES` to prevent unbounded memory growth.
///   - If a Deepgram WebSocket session is active (`dg_sender` is `Some`),
///     converts the frame to i16 LE bytes and sends it over the channel for
///     real-time streaming.
/// - Independently of `is_recording`, when a record-only session is active
///   (`capture_tap` is `Some`), clones the frame into the tap channel for the
///   streaming OGG Opus writer thread.
#[allow(clippy::too_many_arguments)]
pub fn process_audio_frame(
    data: &[f32],
    level: &Arc<Mutex<f64>>,
    buffer: &Arc<Mutex<Vec<f32>>>,
    is_recording: &Arc<Mutex<bool>>,
    dg_sender: &Arc<Mutex<Option<DgSender>>>,
    capture_tap: &Arc<Mutex<Option<crate::recorder::CaptureTap>>>,
    max_buffer_samples: usize,
    limit_reached: &Arc<AtomicBool>,
) {
    if data.is_empty() {
        return;
    }
    let rms = {
        let sum_sq: f32 = data.iter().map(|s| s * s).sum();
        (sum_sq / data.len() as f32).sqrt()
    };
    *lock_or_recover(level) = rms as f64;

    // Record-only path: hand a copy of the frame to the streaming writer
    // thread. Never blocks; a full channel drops the frame and a closed one
    // (writer already finished) is ignored.
    if let Some(tap) = lock_or_recover(capture_tap).as_ref() {
        use std::sync::mpsc::TrySendError;
        if let Err(TrySendError::Full(_)) = tap.try_send(data.to_vec()) {
            let n = TAP_DROPPED_FRAMES.fetch_add(1, Ordering::Relaxed) + 1;
            if n % 100 == 1 {
                warn!("[audio] recorder channel full, dropped {n} frames so far");
            }
        }
    }

    if *lock_or_recover(is_recording) {
        // Batch path: buffer raw f32 samples for WAV upload fallback.
        // Cap at MAX_BUFFER_SAMPLES to prevent unbounded memory growth.
        {
            let mut buf = lock_or_recover(buffer);
            let remaining = max_buffer_samples.saturating_sub(buf.len());
            if remaining > 0 {
                let take = data.len().min(remaining);
                buf.extend_from_slice(&data[..take]);
                if take < data.len() {
                    limit_reached.store(true, Ordering::Release);
                }
            } else {
                limit_reached.store(true, Ordering::Release);
            }
        }

        // Streaming path: if a WebSocket session is active, also send i16 bytes.
        if let Some(sender) = lock_or_recover(dg_sender).as_ref() {
            let bytes = f32_to_i16_bytes(data);
            // Non-blocking try_send — drop frames if the channel is full
            // (WebSocket falling behind) or closed (session ending).
            // Surface backpressure via a rate-limited warning log so users
            // notice sustained network slowdowns instead of getting silent
            // gaps in their transcripts.
            if let Err(e) = sender.try_send(DgMessage::Pcm(bytes)) {
                use tokio::sync::mpsc::error::TrySendError;
                if matches!(e, TrySendError::Full(_)) {
                    let n = DROPPED_FRAMES.fetch_add(1, Ordering::Relaxed) + 1;
                    if n % 100 == 1 {
                        warn!("[audio] Deepgram channel full — dropped {n} frames so far");
                    }
                }
            }
        }
    }
}

// ── Stream builder ────────────────────────────────────────────────────────────

/// Opens a cpal input stream on `device` with the given `config`.
///
/// Handles `F32`, `I16`, `I32`, and `U16` sample formats by converting to f32
/// before passing to `process_audio_frame`. Returns `StreamTypeNotSupported`
/// for other formats.
///
/// `dg_sender` is an `Arc`-wrapped optional channel used to stream PCM bytes
/// to the Deepgram WebSocket task (Phase 4). Pass the same `Arc` that is stored
/// in `AppState::dg_sender` so the callback reflects live session changes.
///
/// The returned `cpal::Stream` is paused; call `.play()` to start capture.
#[allow(clippy::too_many_arguments)]
pub fn build_input_stream(
    device: &cpal::Device,
    config: &cpal::SupportedStreamConfig,
    level: Arc<Mutex<f64>>,
    buffer: Arc<Mutex<Vec<f32>>>,
    is_recording: Arc<Mutex<bool>>,
    dg_sender: Arc<Mutex<Option<DgSender>>>,
    capture_tap: Arc<Mutex<Option<crate::recorder::CaptureTap>>>,
    limit_reached: Arc<AtomicBool>,
) -> Result<cpal::Stream, cpal::BuildStreamError> {
    let err_fn = |e| eprintln!("[MacroVox audio] stream error: {e}");
    let max_buffer_samples = recording_sample_limit(
        config.sample_rate().0,
        config.channels(),
        MAX_RECORDING_DURATION_SECS,
    );

    match config.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config.config(),
            move |data: &[f32], _| {
                process_audio_frame(
                    data,
                    &level,
                    &buffer,
                    &is_recording,
                    &dg_sender,
                    &capture_tap,
                    max_buffer_samples,
                    &limit_reached,
                )
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config.config(),
            move |data: &[i16], _| {
                let floats: Vec<f32> = data.iter().map(|&s| s as f32 / i16::MAX as f32).collect();
                process_audio_frame(
                    &floats,
                    &level,
                    &buffer,
                    &is_recording,
                    &dg_sender,
                    &capture_tap,
                    max_buffer_samples,
                    &limit_reached,
                );
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::I32 => device.build_input_stream(
            &config.config(),
            move |data: &[i32], _| {
                let floats: Vec<f32> = data.iter().map(|&s| s as f32 / i32::MAX as f32).collect();
                process_audio_frame(
                    &floats,
                    &level,
                    &buffer,
                    &is_recording,
                    &dg_sender,
                    &capture_tap,
                    max_buffer_samples,
                    &limit_reached,
                );
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            &config.config(),
            move |data: &[u16], _| {
                let floats: Vec<f32> = data
                    .iter()
                    .map(|&s| (s as f32 / u16::MAX as f32) * 2.0 - 1.0)
                    .collect();
                process_audio_frame(
                    &floats,
                    &level,
                    &buffer,
                    &is_recording,
                    &dg_sender,
                    &capture_tap,
                    max_buffer_samples,
                    &limit_reached,
                );
            },
            err_fn,
            None,
        ),
        _ => Err(cpal::BuildStreamError::StreamConfigNotSupported),
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_header_is_44_bytes_for_empty_samples() {
        let wav = pcm_to_wav(&[], 16000, 1);
        assert_eq!(wav.len(), 44);
    }

    #[test]
    fn wav_riff_and_wave_magic() {
        let wav = pcm_to_wav(&[0.0], 16000, 1);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(&wav[36..40], b"data");
    }

    #[test]
    fn wav_data_size_field_matches_sample_count() {
        let samples = vec![0.0f32; 100];
        let wav = pcm_to_wav(&samples, 16000, 1);
        let data_size = u32::from_le_bytes(wav[40..44].try_into().unwrap());
        // 100 samples * 2 bytes each = 200
        assert_eq!(data_size, 200);
        assert_eq!(wav.len(), 44 + 200);
    }

    #[test]
    fn wav_sample_rate_written_correctly() {
        let wav = pcm_to_wav(&[], 48000, 1);
        let sr = u32::from_le_bytes(wav[24..28].try_into().unwrap());
        assert_eq!(sr, 48000);
    }

    #[test]
    fn wav_clamps_out_of_range_samples() {
        let wav = pcm_to_wav(&[2.0, -2.0], 16000, 1);
        let s0 = i16::from_le_bytes(wav[44..46].try_into().unwrap());
        let s1 = i16::from_le_bytes(wav[46..48].try_into().unwrap());
        assert_eq!(s0, i16::MAX);
        assert_eq!(s1, -i16::MAX);
    }

    #[test]
    fn wav_stereo_block_align_is_4() {
        let wav = pcm_to_wav(&[], 48000, 2);
        let block_align = u16::from_le_bytes(wav[32..34].try_into().unwrap());
        assert_eq!(block_align, 4); // 2 channels * 2 bytes
    }

    fn no_sender() -> Arc<Mutex<Option<crate::deepgram_ws::DgSender>>> {
        Arc::new(Mutex::new(None))
    }

    fn no_tap() -> Arc<Mutex<Option<crate::recorder::CaptureTap>>> {
        Arc::new(Mutex::new(None))
    }

    #[test]
    fn process_audio_frame_feeds_tap_even_when_not_recording() {
        let level = Arc::new(Mutex::new(0.0f64));
        let buffer = Arc::new(Mutex::new(Vec::new()));
        let is_recording = Arc::new(Mutex::new(false));
        let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<f32>>(4);
        let tap = Arc::new(Mutex::new(Some(tx)));

        process_audio_frame(
            &[0.25, -0.25],
            &level,
            &buffer,
            &is_recording,
            &no_sender(),
            &tap,
            usize::MAX,
            &no_limit(),
        );

        assert_eq!(rx.try_recv().unwrap(), vec![0.25, -0.25]);
        assert!(
            buffer.lock().unwrap().is_empty(),
            "tap must not touch the dictation buffer"
        );
    }

    #[test]
    fn process_audio_frame_survives_full_or_closed_tap() {
        let level = Arc::new(Mutex::new(0.0f64));
        let buffer = Arc::new(Mutex::new(Vec::new()));
        let is_recording = Arc::new(Mutex::new(false));
        let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<f32>>(1);
        let tap = Arc::new(Mutex::new(Some(tx)));

        // Fill the channel, then push again: must neither block nor panic.
        let send = |data: &[f32]| {
            process_audio_frame(
                data,
                &level,
                &buffer,
                &is_recording,
                &no_sender(),
                &tap,
                usize::MAX,
                &no_limit(),
            )
        };
        send(&[0.1]);
        send(&[0.2]);
        assert_eq!(rx.try_recv().unwrap(), vec![0.1]);
        assert!(
            rx.try_recv().is_err(),
            "second frame was dropped, not queued"
        );

        // Receiver gone: sends fail silently.
        drop(rx);
        send(&[0.3]);
    }

    fn no_limit() -> Arc<AtomicBool> {
        Arc::new(AtomicBool::new(false))
    }

    #[test]
    fn process_audio_frame_updates_level() {
        let level = Arc::new(Mutex::new(0.0f64));
        let buffer = Arc::new(Mutex::new(Vec::new()));
        let is_recording = Arc::new(Mutex::new(false));

        // RMS of [1.0, -1.0] = sqrt((1+1)/2) = 1.0
        process_audio_frame(
            &[1.0, -1.0],
            &level,
            &buffer,
            &is_recording,
            &no_sender(),
            &no_tap(),
            usize::MAX,
            &no_limit(),
        );
        let lvl = *level.lock().unwrap();
        assert!((lvl - 1.0).abs() < 1e-6, "level = {lvl}");
        assert!(
            buffer.lock().unwrap().is_empty(),
            "no buffering when not recording"
        );
    }

    #[test]
    fn process_audio_frame_buffers_when_recording() {
        let level = Arc::new(Mutex::new(0.0f64));
        let buffer = Arc::new(Mutex::new(Vec::new()));
        let is_recording = Arc::new(Mutex::new(true));

        process_audio_frame(
            &[0.1, 0.2, 0.3],
            &level,
            &buffer,
            &is_recording,
            &no_sender(),
            &no_tap(),
            usize::MAX,
            &no_limit(),
        );
        let buf = buffer.lock().unwrap().clone();
        assert_eq!(buf, vec![0.1, 0.2, 0.3]);
    }

    #[test]
    fn process_audio_frame_ignores_empty_slice() {
        let level = Arc::new(Mutex::new(0.5f64));
        let buffer = Arc::new(Mutex::new(Vec::new()));
        let is_recording = Arc::new(Mutex::new(false));
        process_audio_frame(
            &[],
            &level,
            &buffer,
            &is_recording,
            &no_sender(),
            &no_tap(),
            usize::MAX,
            &no_limit(),
        );
        // level unchanged
        assert!((0.5 - *level.lock().unwrap()).abs() < 1e-9);
    }

    #[test]
    fn process_audio_frame_sends_pcm_when_streaming() {
        use crate::deepgram_ws::DgMessage;
        use tokio::sync::mpsc;

        let level = Arc::new(Mutex::new(0.0f64));
        let buffer = Arc::new(Mutex::new(Vec::new()));
        let is_recording = Arc::new(Mutex::new(true));

        let (tx, mut rx) = mpsc::channel::<DgMessage>(500);
        let dg_sender = Arc::new(Mutex::new(Some(tx)));

        process_audio_frame(
            &[0.5, -0.5],
            &level,
            &buffer,
            &is_recording,
            &dg_sender,
            &no_tap(),
            usize::MAX,
            &no_limit(),
        );

        // Should have received one Pcm message.
        let msg = rx.blocking_recv().expect("expected Pcm message");
        if let DgMessage::Pcm(bytes) = msg {
            // 2 f32 samples → 4 bytes (2 × i16)
            assert_eq!(bytes.len(), 4);
            // 0.5 → i16::MAX/2 ≈ 16383; verify it's non-zero
            let val = i16::from_le_bytes([bytes[0], bytes[1]]);
            assert!(val > 0, "0.5 should map to positive i16");
        } else {
            panic!("expected DgMessage::Pcm");
        }
    }

    #[test]
    fn process_audio_frame_no_send_when_not_recording() {
        use crate::deepgram_ws::DgMessage;
        use tokio::sync::mpsc;

        let level = Arc::new(Mutex::new(0.0f64));
        let buffer = Arc::new(Mutex::new(Vec::new()));
        let is_recording = Arc::new(Mutex::new(false)); // not recording

        let (tx, mut rx) = mpsc::channel::<DgMessage>(500);
        let dg_sender = Arc::new(Mutex::new(Some(tx)));

        process_audio_frame(
            &[0.5],
            &level,
            &buffer,
            &is_recording,
            &dg_sender,
            &no_tap(),
            usize::MAX,
            &no_limit(),
        );

        // Nothing should have been sent.
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn duration_limit_accounts_for_sample_rate_and_channels() {
        assert_eq!(recording_sample_limit(48_000, 2, 60), 5_760_000);
    }

    #[test]
    fn duration_limit_has_a_hard_memory_ceiling_and_whole_frames() {
        let limit = recording_sample_limit(u32::MAX, 7, u64::MAX);
        assert!(limit * std::mem::size_of::<f32>() <= MAX_RECORDING_BUFFER_BYTES);
        assert_eq!(limit % 7, 0);
    }

    #[test]
    fn process_audio_frame_surfaces_buffer_limit() {
        let level = Arc::new(Mutex::new(0.0f64));
        let buffer = Arc::new(Mutex::new(Vec::new()));
        let is_recording = Arc::new(Mutex::new(true));
        let limit_reached = no_limit();

        process_audio_frame(
            &[0.1, 0.2, 0.3],
            &level,
            &buffer,
            &is_recording,
            &no_sender(),
            &no_tap(),
            2,
            &limit_reached,
        );

        assert_eq!(*buffer.lock().unwrap(), vec![0.1, 0.2]);
        assert!(limit_reached.load(Ordering::Acquire));
    }

    // ── f32_to_i16_bytes ──────────────────────────────────────────────────────

    #[test]
    fn f32_to_i16_bytes_length() {
        let bytes = f32_to_i16_bytes(&[0.0, 0.5, -0.5, 1.0]);
        assert_eq!(bytes.len(), 8); // 4 samples × 2 bytes
    }

    #[test]
    fn f32_to_i16_bytes_zero_maps_to_zero() {
        let bytes = f32_to_i16_bytes(&[0.0]);
        let val = i16::from_le_bytes([bytes[0], bytes[1]]);
        assert_eq!(val, 0);
    }

    #[test]
    fn f32_to_i16_bytes_clamps_overflow() {
        let bytes = f32_to_i16_bytes(&[2.0, -2.0]);
        let hi = i16::from_le_bytes([bytes[0], bytes[1]]);
        let lo = i16::from_le_bytes([bytes[2], bytes[3]]);
        assert_eq!(hi, i16::MAX);
        assert_eq!(lo, -i16::MAX);
    }

    #[test]
    fn f32_to_i16_bytes_positive_half() {
        let bytes = f32_to_i16_bytes(&[0.5]);
        let val = i16::from_le_bytes([bytes[0], bytes[1]]);
        // 0.5 × 32767 = 16383 (truncated)
        assert_eq!(val, 16383);
    }
}
