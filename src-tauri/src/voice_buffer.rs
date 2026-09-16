//! MacroVox — Voice memo buffer.
//!
//! Saves dictation recordings as WAV files in a rolling buffer directory,
//! capped at a configurable size (default 100 MB). Each recording is paired
//! with its transcript in a JSON manifest for future playback and model
//! training use.
//!
//! ## Storage layout
//!
//! ```text
//! %LOCALAPPDATA%/com.okstudio.macrovox/voice-buffer/
//! ├── manifest.json          ← index of all recordings
//! ├── 2026-04-14T09-32-17.wav
//! ├── 2026-04-14T10-15-03.wav
//! └── ...
//! ```
//!
//! ## Eviction policy
//!
//! FIFO — oldest recordings are deleted first when the buffer exceeds
//! `max_size_bytes`. Eviction runs before each new save.

use log::{debug, warn};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

// ── Manifest types ───────────────────────────────────────────────────────────

/// A single recording entry in the voice buffer manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceRecording {
    /// Filename (not full path), e.g. "2026-04-14T09-32-17.wav"
    pub file: String,
    /// ISO 8601 timestamp of when the recording was made
    pub timestamp: String,
    /// Duration in seconds
    pub duration_secs: f64,
    /// File size in bytes
    pub size_bytes: u64,
    /// Transcript text (from Deepgram or AI cleanup)
    pub transcript: String,
}

/// The voice buffer manifest — tracks all recordings and buffer limits.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceBufferManifest {
    /// Maximum total size of all recordings in bytes (default 100 MB)
    pub max_size_bytes: u64,
    /// Current total size of all recordings in bytes
    pub current_size_bytes: u64,
    /// List of recordings, oldest first
    pub recordings: Vec<VoiceRecording>,
}

impl Default for VoiceBufferManifest {
    fn default() -> Self {
        Self {
            max_size_bytes: 100 * 1024 * 1024, // 100 MB
            current_size_bytes: 0,
            recordings: Vec::new(),
        }
    }
}

/// Summary info returned to the frontend.
#[derive(Debug, Serialize)]
pub struct VoiceBufferInfo {
    pub enabled: bool,
    pub max_size_bytes: u64,
    pub current_size_bytes: u64,
    pub recording_count: usize,
    pub total_duration_secs: f64,
    pub storage_path: String,
}

// ── Core operations ──────────────────────────────────────────────────────────

/// Loads the manifest from disk, or returns a default if it doesn't exist.
///
/// If the file exists but fails to parse (truncated write, disk corruption),
/// the broken file is renamed to `manifest.json.bad-{timestamp}` so it's
/// recoverable for debugging instead of being silently overwritten.
pub fn load_manifest(buffer_dir: &Path) -> VoiceBufferManifest {
    let path = buffer_dir.join("manifest.json");
    let Ok(data) = fs::read_to_string(&path) else {
        return VoiceBufferManifest::default();
    };
    match serde_json::from_str(&data) {
        Ok(m) => m,
        Err(e) => {
            warn!(
                "[voice_buffer] manifest.json parse failed ({e}) — backing up and starting fresh"
            );
            let ts = chrono::Local::now().format("%Y%m%dT%H%M%S");
            let backup = buffer_dir.join(format!("manifest.json.bad-{ts}"));
            let _ = fs::rename(&path, &backup);
            VoiceBufferManifest::default()
        }
    }
}

/// Writes the manifest to disk atomically (write to .tmp, then rename).
pub fn save_manifest(buffer_dir: &Path, manifest: &VoiceBufferManifest) -> Result<(), String> {
    let path = buffer_dir.join("manifest.json");
    let tmp_path = buffer_dir.join("manifest.json.tmp");
    let json = serde_json::to_string_pretty(manifest)
        .map_err(|e| format!("Failed to serialize manifest: {e}"))?;
    fs::write(&tmp_path, &json).map_err(|e| format!("Failed to write manifest: {e}"))?;
    fs::rename(&tmp_path, &path).map_err(|e| format!("Failed to rename manifest: {e}"))?;
    Ok(())
}

/// Evicts oldest recordings until `current_size_bytes + new_size` fits
/// within `max_size_bytes`. Deletes the WAV files from disk.
pub fn evict_if_needed(buffer_dir: &Path, manifest: &mut VoiceBufferManifest, new_size: u64) {
    while manifest.current_size_bytes + new_size > manifest.max_size_bytes
        && !manifest.recordings.is_empty()
    {
        let oldest = manifest.recordings.remove(0);
        let file_path = buffer_dir.join(&oldest.file);
        if let Err(e) = fs::remove_file(&file_path) {
            warn!("[voice_buffer] Failed to delete {}: {e}", oldest.file);
        } else {
            debug!(
                "[voice_buffer] Evicted {} ({} bytes)",
                oldest.file, oldest.size_bytes
            );
        }
        manifest.current_size_bytes = manifest
            .current_size_bytes
            .saturating_sub(oldest.size_bytes);
    }
}

/// Converts f32 PCM samples to i16 (clamped to [-1.0, 1.0]).
fn f32_to_i16_samples(samples: &[f32]) -> Vec<i16> {
    samples
        .iter()
        .map(|&s| (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
        .collect()
}

/// Downmixes interleaved multi-channel f32 samples to mono by averaging.
fn downmix_to_mono(samples: &[f32], channels: u16) -> Vec<f32> {
    if channels <= 1 {
        return samples.to_vec();
    }
    let ch = channels as usize;
    let inv = 1.0 / ch as f32;
    samples
        .chunks_exact(ch)
        .map(|frame| frame.iter().sum::<f32>() * inv)
        .collect()
}

/// Linear-interpolation resample of mono f32 samples from `src_rate` to `dst_rate`.
fn resample_linear(samples: &[f32], src_rate: u32, dst_rate: u32) -> Vec<f32> {
    if src_rate == dst_rate || samples.is_empty() {
        return samples.to_vec();
    }
    let ratio = dst_rate as f64 / src_rate as f64;
    let out_len = ((samples.len() as f64) * ratio).round() as usize;
    resample_to_length(samples, out_len)
}

/// Resamples mono f32 samples to a specified output length via linear interpolation.
fn resample_to_length(samples: &[f32], out_len: usize) -> Vec<f32> {
    if samples.is_empty() || out_len == 0 {
        return Vec::new();
    }
    if samples.len() == out_len {
        return samples.to_vec();
    }
    let mut out = Vec::with_capacity(out_len);
    let step = samples.len() as f64 / out_len as f64;
    let last = samples.len() - 1;
    for i in 0..out_len {
        let pos = i as f64 * step;
        let i0 = pos.floor() as usize;
        if i0 >= last {
            out.push(samples[last]);
        } else {
            let frac = (pos - i0 as f64) as f32;
            out.push(samples[i0] * (1.0 - frac) + samples[i0 + 1] * frac);
        }
    }
    out
}

/// Encodes f32 PCM samples as OGG Opus at 16 kHz mono.
///
/// Downmixes to mono and resamples to 16 kHz so the Opus container's declared
/// rate matches the actual sample data — without this, recordings captured at
/// the device's native rate (e.g. 48 kHz on Windows) play back at the wrong
/// speed.
fn encode_opus(samples: &[f32], sample_rate: u32, channels: u16) -> Result<Vec<u8>, String> {
    let mono = downmix_to_mono(samples, channels);
    let resampled = resample_linear(&mono, sample_rate, 16_000);
    let i16_samples = f32_to_i16_samples(&resampled);
    ogg_opus::encode::<16000, 1>(&i16_samples).map_err(|e| format!("Opus encoding failed: {e}"))
}

/// Saves a new recording to the voice buffer.
///
/// - Encodes `samples` as OGG Opus (~10x smaller than WAV)
/// - Evicts old recordings if needed to stay within `max_size_bytes`
/// - Writes the file and updates the manifest
///
/// Returns the filename of the saved recording on success.
pub fn save_recording(
    buffer_dir: &Path,
    samples: &[f32],
    sample_rate: u32,
    channels: u16,
    transcript: &str,
    max_size_bytes: Option<u64>,
) -> Result<String, String> {
    if samples.is_empty() {
        return Err("No audio to save".to_string());
    }

    // Ensure the buffer directory exists
    fs::create_dir_all(buffer_dir)
        .map_err(|e| format!("Failed to create voice buffer directory: {e}"))?;

    // Encode as OGG Opus (falls back to WAV if encoding fails)
    let (encoded_bytes, extension) = match encode_opus(samples, sample_rate, channels) {
        Ok(opus_bytes) => {
            debug!(
                "[voice_buffer] Opus encoded: {} samples → {} bytes ({:.0}x compression)",
                samples.len() * 2, // WAV would be 2 bytes per sample + 44 header
                opus_bytes.len(),
                (samples.len() * 2) as f64 / opus_bytes.len().max(1) as f64,
            );
            (opus_bytes, "ogg")
        }
        Err(e) => {
            warn!("[voice_buffer] Opus encoding failed, falling back to WAV: {e}");
            (
                crate::audio::pcm_to_wav(samples, sample_rate, channels),
                "wav",
            )
        }
    };

    // Generate timestamp-based filename with milliseconds for uniqueness
    let now = chrono::Local::now();
    let filename = format!("{}.{}", now.format("%Y-%m-%dT%H-%M-%S%.3f"), extension);
    let file_path = buffer_dir.join(&filename);

    let file_size = encoded_bytes.len() as u64;

    // Load manifest and apply max_size override if provided
    let mut manifest = load_manifest(buffer_dir);
    if let Some(max) = max_size_bytes {
        manifest.max_size_bytes = max;
    }

    // Evict old recordings to make room
    evict_if_needed(buffer_dir, &mut manifest, file_size);

    // Write the encoded file
    fs::write(&file_path, &encoded_bytes)
        .map_err(|e| format!("Failed to write audio file: {e}"))?;

    let duration_secs = samples.len() as f64 / (sample_rate as f64 * channels as f64);

    // Add to manifest
    manifest.recordings.push(VoiceRecording {
        file: filename.clone(),
        timestamp: now.to_rfc3339(),
        duration_secs,
        size_bytes: file_size,
        transcript: transcript.to_string(),
    });
    manifest.current_size_bytes += file_size;

    // Save manifest
    save_manifest(buffer_dir, &manifest)?;

    debug!(
        "[voice_buffer] Saved {} ({:.1}s, {} bytes, {}/{} MB used)",
        filename,
        duration_secs,
        file_size,
        manifest.current_size_bytes / (1024 * 1024),
        manifest.max_size_bytes / (1024 * 1024),
    );

    Ok(filename)
}

/// Registers a file that is already on disk (written by the streaming
/// recorder) in the manifest, evicting older recordings first if needed.
///
/// Returns the new manifest entry. The new file itself is never evicted here
/// even if it alone exceeds the cap; the next save reclaims it.
pub fn register_recording(
    buffer_dir: &Path,
    filename: &str,
    timestamp: String,
    duration_secs: f64,
    size_bytes: u64,
    max_size_bytes: Option<u64>,
) -> Result<VoiceRecording, String> {
    let mut manifest = load_manifest(buffer_dir);
    if let Some(max) = max_size_bytes {
        manifest.max_size_bytes = max;
    }
    evict_if_needed(buffer_dir, &mut manifest, size_bytes);

    let entry = VoiceRecording {
        file: filename.to_string(),
        timestamp,
        duration_secs,
        size_bytes,
        transcript: String::new(),
    };
    manifest.recordings.push(entry.clone());
    manifest.current_size_bytes += size_bytes;
    save_manifest(buffer_dir, &manifest)?;

    debug!(
        "[voice_buffer] Registered {} ({:.1}s, {} bytes, {}/{} MB used)",
        filename,
        duration_secs,
        size_bytes,
        manifest.current_size_bytes / (1024 * 1024),
        manifest.max_size_bytes / (1024 * 1024),
    );
    Ok(entry)
}

/// Startup pass: adopts `.partial` files left behind when the app exited in
/// the middle of a record-only session (crash, force quit). Completed OGG
/// pages are still valid, so the file is renamed to its final name and
/// registered with the duration read from the last page's granule position.
/// Unreadable or sub-threshold leftovers are deleted.
pub fn recover_partial_recordings(buffer_dir: &Path) {
    let Ok(entries) = fs::read_dir(buffer_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some(final_name) = name.strip_suffix(".partial") else {
            continue;
        };
        if !final_name.ends_with(".ogg") {
            continue;
        }
        match crate::recorder::partial_duration_secs(&path) {
            Some(duration) if duration >= crate::recorder::MIN_RECORDING_SECS => {
                let final_path = buffer_dir.join(final_name);
                if let Err(e) = fs::rename(&path, &final_path) {
                    warn!("[voice_buffer] Could not adopt partial recording {name}: {e}");
                    continue;
                }
                let size = fs::metadata(&final_path).map(|m| m.len()).unwrap_or(0);
                let timestamp = timestamp_from_filename(final_name)
                    .unwrap_or_else(|| chrono::Local::now().to_rfc3339());
                match register_recording(buffer_dir, final_name, timestamp, duration, size, None) {
                    Ok(_) => debug!(
                        "[voice_buffer] Recovered partial recording {final_name} ({duration:.1}s)"
                    ),
                    Err(e) => warn!(
                        "[voice_buffer] Recovered {final_name} but manifest update failed: {e}"
                    ),
                }
            }
            _ => {
                debug!("[voice_buffer] Discarding unusable partial recording {name}");
                let _ = fs::remove_file(&path);
            }
        }
    }
}

/// Parses the `%Y-%m-%dT%H-%M-%S%.3f` local timestamp that recording filenames
/// are built from, returning it as RFC 3339.
fn timestamp_from_filename(filename: &str) -> Option<String> {
    use chrono::TimeZone;
    let stem = filename
        .strip_suffix(".ogg")
        .or_else(|| filename.strip_suffix(".wav"))?;
    let naive = chrono::NaiveDateTime::parse_from_str(stem, "%Y-%m-%dT%H-%M-%S%.3f").ok()?;
    chrono::Local
        .from_local_datetime(&naive)
        .single()
        .map(|dt| dt.to_rfc3339())
}

/// One-shot migration: re-encodes any recordings saved before the sample-rate
/// fix so they play at real-time speed.
///
/// Pre-fix `encode_opus` hardcoded a 16 kHz input rate, so 48 kHz captures
/// became 3-second files claiming to be 1 second. The manifest's `duration_secs`
/// was always computed from the true rate, so it's the ground truth: if the
/// decoded length at 16 kHz doesn't match it, the file is stretched and we
/// resample to the correct length and re-encode.
pub fn repair_stretched_recordings(buffer_dir: &Path) {
    if !buffer_dir.exists() {
        return;
    }
    let mut manifest = load_manifest(buffer_dir);
    if manifest.recordings.is_empty() {
        return;
    }

    let mut repaired = 0usize;
    let mut new_total: u64 = 0;

    for entry in manifest.recordings.iter_mut() {
        if !entry.file.ends_with(".ogg") {
            new_total = new_total.saturating_add(entry.size_bytes);
            continue;
        }
        // Anything longer than the old five-minute dictation cap came from the
        // streaming recorder, which never had the stretch bug. Decoding an
        // hour-long file on every launch just to confirm that is not worth it.
        if entry.duration_secs > 300.0 {
            new_total = new_total.saturating_add(entry.size_bytes);
            continue;
        }
        let path = buffer_dir.join(&entry.file);
        let bytes = match fs::read(&path) {
            Ok(b) => b,
            Err(_) => {
                new_total = new_total.saturating_add(entry.size_bytes);
                continue;
            }
        };

        let cursor = std::io::Cursor::new(&bytes);
        let samples_i16 = match ogg_opus::decode::<_, 16_000>(cursor) {
            Ok((s, _)) => s,
            Err(e) => {
                warn!(
                    "[voice_buffer] Skipping repair for {}: decode failed: {e}",
                    entry.file
                );
                new_total = new_total.saturating_add(entry.size_bytes);
                continue;
            }
        };

        let decoded_duration = samples_i16.len() as f64 / 16_000.0;
        // Within 50ms — not stretched, leave it alone.
        if (decoded_duration - entry.duration_secs).abs() < 0.05 {
            new_total = new_total.saturating_add(entry.size_bytes);
            continue;
        }

        let samples_f32: Vec<f32> = samples_i16
            .iter()
            .map(|&s| s as f32 / i16::MAX as f32)
            .collect();
        let target_len = (entry.duration_secs * 16_000.0).round() as usize;
        let resampled = resample_to_length(&samples_f32, target_len);

        let new_bytes = match encode_opus(&resampled, 16_000, 1) {
            Ok(b) => b,
            Err(e) => {
                warn!(
                    "[voice_buffer] Skipping repair for {}: re-encode failed: {e}",
                    entry.file
                );
                new_total = new_total.saturating_add(entry.size_bytes);
                continue;
            }
        };

        if let Err(e) = fs::write(&path, &new_bytes) {
            warn!(
                "[voice_buffer] Skipping repair for {}: write failed: {e}",
                entry.file
            );
            new_total = new_total.saturating_add(entry.size_bytes);
            continue;
        }

        debug!(
            "[voice_buffer] Repaired {}: {:.1}s → {:.1}s ({} → {} bytes)",
            entry.file,
            decoded_duration,
            entry.duration_secs,
            entry.size_bytes,
            new_bytes.len()
        );
        entry.size_bytes = new_bytes.len() as u64;
        new_total = new_total.saturating_add(entry.size_bytes);
        repaired += 1;
    }

    if repaired > 0 {
        manifest.current_size_bytes = new_total;
        if let Err(e) = save_manifest(buffer_dir, &manifest) {
            warn!("[voice_buffer] Repaired {repaired} files but manifest save failed: {e}");
        } else {
            debug!("[voice_buffer] Repaired {repaired} stretched recording(s)");
        }
    }
}

/// Lists all recordings in the buffer, newest first.
pub fn list_recordings(buffer_dir: &Path) -> Vec<VoiceRecording> {
    let mut manifest = load_manifest(buffer_dir);
    // Sort by timestamp descending so newest recordings always appear first,
    // regardless of manifest insertion order.
    manifest
        .recordings
        .sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    manifest.recordings
}

/// Returns buffer info (size, count, etc.).
pub fn get_info(buffer_dir: &Path, enabled: bool) -> VoiceBufferInfo {
    let manifest = load_manifest(buffer_dir);
    VoiceBufferInfo {
        enabled,
        max_size_bytes: manifest.max_size_bytes,
        current_size_bytes: manifest.current_size_bytes,
        recording_count: manifest.recordings.len(),
        total_duration_secs: manifest.recordings.iter().map(|r| r.duration_secs).sum(),
        storage_path: buffer_dir.to_string_lossy().to_string(),
    }
}

/// Validates that `filename` is a plain filename (no separators, no traversal,
/// no absolute path). This is called by every function that takes a user-supplied
/// filename so the substring check + Path::file_name comparison can't be bypassed
/// by URL-encoded / backslash-encoded inputs the user might construct.
fn validate_filename(filename: &str) -> Result<(), String> {
    if filename.is_empty()
        || filename.contains('/')
        || filename.contains('\\')
        || filename.contains("..")
        || filename.contains('\0')
    {
        return Err("Invalid filename".to_string());
    }
    // Belt-and-braces: Path::file_name(filename) must equal filename verbatim.
    // This catches anything that Rust's Path treats as a separator on the
    // current OS but our string check missed.
    if Path::new(filename).file_name().and_then(|n| n.to_str()) != Some(filename) {
        return Err("Invalid filename".to_string());
    }
    Ok(())
}

/// Reads a WAV file from the buffer and returns its bytes.
pub fn get_audio(buffer_dir: &Path, filename: &str) -> Result<Vec<u8>, String> {
    validate_filename(filename)?;
    let path = buffer_dir.join(filename);
    fs::read(&path).map_err(|e| format!("Failed to read audio file: {e}"))
}

/// Deletes a single recording from the buffer.
pub fn delete_recording(buffer_dir: &Path, filename: &str) -> Result<(), String> {
    validate_filename(filename)?;

    let mut manifest = load_manifest(buffer_dir);
    let idx = manifest
        .recordings
        .iter()
        .position(|r| r.file == filename)
        .ok_or_else(|| "Recording not found".to_string())?;

    let recording = manifest.recordings.remove(idx);
    manifest.current_size_bytes = manifest
        .current_size_bytes
        .saturating_sub(recording.size_bytes);

    let file_path = buffer_dir.join(filename);
    if file_path.exists() {
        fs::remove_file(&file_path).map_err(|e| format!("Failed to delete file: {e}"))?;
    }

    save_manifest(buffer_dir, &manifest)?;
    debug!("[voice_buffer] Deleted {}", filename);
    Ok(())
}

/// Deletes all recordings and resets the manifest.
pub fn clear_all(buffer_dir: &Path) -> Result<(), String> {
    let manifest = load_manifest(buffer_dir);
    for recording in &manifest.recordings {
        let file_path = buffer_dir.join(&recording.file);
        if file_path.exists() {
            let _ = fs::remove_file(&file_path);
        }
    }
    save_manifest(buffer_dir, &VoiceBufferManifest::default())?;
    debug!("[voice_buffer] Cleared all recordings");
    Ok(())
}

/// Updates the transcript for a recording in the manifest.
pub fn update_transcript(
    buffer_dir: &Path,
    filename: &str,
    transcript: &str,
) -> Result<(), String> {
    validate_filename(filename)?;
    let mut manifest = load_manifest(buffer_dir);
    let recording = manifest
        .recordings
        .iter_mut()
        .find(|r| r.file == filename)
        .ok_or_else(|| "Recording not found".to_string())?;
    recording.transcript = transcript.to_string();
    save_manifest(buffer_dir, &manifest)?;
    debug!("[voice_buffer] Updated transcript for {}", filename);
    Ok(())
}

/// Updates the max buffer size in the manifest and evicts if needed.
pub fn set_max_size(buffer_dir: &Path, max_size_bytes: u64) -> Result<(), String> {
    let mut manifest = load_manifest(buffer_dir);
    manifest.max_size_bytes = max_size_bytes;
    evict_if_needed(buffer_dir, &mut manifest, 0);
    save_manifest(buffer_dir, &manifest)?;
    debug!(
        "[voice_buffer] Max size set to {} MB",
        max_size_bytes / (1024 * 1024)
    );
    Ok(())
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    use std::sync::atomic::{AtomicU64, Ordering};
    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_dir() -> PathBuf {
        let id = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("macrovox-test-{}-{}", std::process::id(), id));
        let _ = fs::create_dir_all(&dir);
        dir
    }

    fn cleanup(dir: &Path) {
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn manifest_default_is_100mb() {
        let m = VoiceBufferManifest::default();
        assert_eq!(m.max_size_bytes, 100 * 1024 * 1024);
        assert_eq!(m.current_size_bytes, 0);
        assert!(m.recordings.is_empty());
    }

    #[test]
    fn save_and_load_manifest_roundtrip() {
        let dir = temp_dir();
        let mut manifest = VoiceBufferManifest::default();
        manifest.recordings.push(VoiceRecording {
            file: "test.wav".to_string(),
            timestamp: "2026-04-14T09:00:00+00:00".to_string(),
            duration_secs: 5.0,
            size_bytes: 1000,
            transcript: "hello world".to_string(),
        });
        manifest.current_size_bytes = 1000;
        save_manifest(&dir, &manifest).unwrap();

        let loaded = load_manifest(&dir);
        assert_eq!(loaded.recordings.len(), 1);
        assert_eq!(loaded.recordings[0].file, "test.wav");
        assert_eq!(loaded.current_size_bytes, 1000);
        cleanup(&dir);
    }

    #[test]
    fn save_recording_creates_ogg_and_manifest() {
        let dir = temp_dir();
        let samples = vec![0.0f32; 16_000]; // 1 second at 16kHz mono
        let result = save_recording(&dir, &samples, 16_000, 1, "test transcript", None);
        assert!(result.is_ok());

        let filename = result.unwrap();
        assert!(filename.ends_with(".ogg"), "Expected .ogg, got: {filename}");
        assert!(dir.join(&filename).exists());

        let manifest = load_manifest(&dir);
        assert_eq!(manifest.recordings.len(), 1);
        assert_eq!(manifest.recordings[0].transcript, "test transcript");
        assert!((manifest.recordings[0].duration_secs - 1.0).abs() < 0.01);

        // OGG Opus should be much smaller than WAV (WAV = 32044 bytes for 1s @ 16kHz)
        assert!(
            manifest.recordings[0].size_bytes < 10_000,
            "OGG Opus should be much smaller than WAV, got {} bytes",
            manifest.recordings[0].size_bytes
        );
        cleanup(&dir);
    }

    #[test]
    fn eviction_removes_oldest_when_full() {
        let dir = temp_dir();
        // Opus files are small (~1-2KB for short clips), so use a tiny buffer
        let samples = vec![0.1f32; 16_000]; // 1 second of audio

        // Save one to measure the Opus file size
        let f1 =
            save_recording(&dir, &samples, 16_000, 1, "first", Some(100 * 1024 * 1024)).unwrap();
        let manifest = load_manifest(&dir);
        let one_file_size = manifest.recordings[0].size_bytes;

        // Set max to fit only one file — second should evict first
        let small_max = one_file_size + 100; // room for one but not two
        let _f2 = save_recording(&dir, &samples, 16_000, 1, "second", Some(small_max)).unwrap();

        // First file should be evicted
        assert!(!dir.join(&f1).exists());
        let manifest = load_manifest(&dir);
        assert_eq!(manifest.recordings.len(), 1);
        assert_eq!(manifest.recordings[0].transcript, "second");
        cleanup(&dir);
    }

    #[test]
    fn delete_recording_removes_file_and_updates_manifest() {
        let dir = temp_dir();
        let samples = vec![0.0f32; 16_000];
        let filename = save_recording(&dir, &samples, 16_000, 1, "to delete", None).unwrap();

        assert!(dir.join(&filename).exists());
        delete_recording(&dir, &filename).unwrap();
        assert!(!dir.join(&filename).exists());

        let manifest = load_manifest(&dir);
        assert!(manifest.recordings.is_empty());
        assert_eq!(manifest.current_size_bytes, 0);
        cleanup(&dir);
    }

    #[test]
    fn clear_all_removes_everything() {
        let dir = temp_dir();
        let samples = vec![0.0f32; 16_000];
        save_recording(&dir, &samples, 16_000, 1, "one", None).unwrap();
        save_recording(&dir, &samples, 16_000, 1, "two", None).unwrap();

        let manifest = load_manifest(&dir);
        assert_eq!(manifest.recordings.len(), 2);

        clear_all(&dir).unwrap();
        let manifest = load_manifest(&dir);
        assert!(manifest.recordings.is_empty());
        assert_eq!(manifest.current_size_bytes, 0);
        cleanup(&dir);
    }

    #[test]
    fn resample_linear_preserves_duration() {
        // 1 second at 48 kHz → should produce ~16000 samples at 16 kHz
        let input = vec![0.5f32; 48_000];
        let out = resample_linear(&input, 48_000, 16_000);
        assert!((out.len() as i32 - 16_000).abs() <= 1, "got {}", out.len());
    }

    #[test]
    fn downmix_stereo_to_mono_averages_channels() {
        // Stereo: L=1.0, R=0.0 interleaved → mono should be 0.5
        let input = vec![1.0f32, 0.0, 1.0, 0.0];
        let mono = downmix_to_mono(&input, 2);
        assert_eq!(mono, vec![0.5, 0.5]);
    }

    #[test]
    fn save_recording_at_48khz_stores_correct_duration() {
        // Regression: a 1-second 48 kHz capture must be saved so playback
        // is real-time, not 3x slower. Decode the resulting OGG and check
        // it produces ~16000 samples at 16 kHz.
        let dir = temp_dir();
        let samples = vec![0.0f32; 48_000]; // 1 second at 48 kHz mono
        let filename = save_recording(&dir, &samples, 48_000, 1, "48k test", None).unwrap();

        let bytes = std::fs::read(dir.join(&filename)).unwrap();
        let cursor = std::io::Cursor::new(bytes);
        let (decoded, _header) = ogg_opus::decode::<_, 16_000>(cursor).unwrap();

        // Should decode to ~1 second of audio at 16 kHz (16000 samples).
        // Opus has a small encoder delay, so allow some tolerance.
        let len = decoded.len() as i32;
        assert!(
            (len - 16_000).abs() < 1000,
            "expected ~16000 samples after decode, got {len}"
        );
        cleanup(&dir);
    }

    #[test]
    fn repair_fixes_stretched_recording_and_skips_correct_one() {
        let dir = temp_dir();

        // Simulate a pre-fix stretched recording: feed 48000 samples (1s @ 48kHz)
        // straight to the 16 kHz encoder, mimicking the old bug.
        let stretched_samples = vec![0.1f32; 48_000];
        let i16_stretched: Vec<i16> = stretched_samples
            .iter()
            .map(|&s| (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
            .collect();
        let stretched_bytes = ogg_opus::encode::<16_000, 1>(&i16_stretched).unwrap();
        let stretched_name = "stretched.ogg";
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(stretched_name), &stretched_bytes).unwrap();

        // Save a correctly-encoded file alongside it.
        let good_samples = vec![0.1f32; 16_000];
        let good_name = save_recording(&dir, &good_samples, 16_000, 1, "good", None).unwrap();

        // Hand-craft the manifest as it would have looked before the fix:
        // both entries claim 1.0s duration_secs.
        let mut manifest = load_manifest(&dir);
        manifest.recordings.clear();
        manifest.recordings.push(VoiceRecording {
            file: stretched_name.to_string(),
            timestamp: "2026-04-25T12:00:00+00:00".to_string(),
            duration_secs: 1.0,
            size_bytes: stretched_bytes.len() as u64,
            transcript: "stretched".to_string(),
        });
        let good_bytes_len = std::fs::metadata(dir.join(&good_name)).unwrap().len();
        manifest.recordings.push(VoiceRecording {
            file: good_name.clone(),
            timestamp: "2026-04-25T12:00:01+00:00".to_string(),
            duration_secs: 1.0,
            size_bytes: good_bytes_len,
            transcript: "good".to_string(),
        });
        manifest.current_size_bytes = stretched_bytes.len() as u64 + good_bytes_len;
        save_manifest(&dir, &manifest).unwrap();

        // Run the migration.
        repair_stretched_recordings(&dir);

        // Stretched file should now decode to ~16000 samples (1s at 16 kHz).
        let bytes = std::fs::read(dir.join(stretched_name)).unwrap();
        let (decoded, _) = ogg_opus::decode::<_, 16_000>(std::io::Cursor::new(bytes)).unwrap();
        let len = decoded.len() as i32;
        assert!(
            (len - 16_000).abs() < 1000,
            "after repair, expected ~16000 samples, got {len}"
        );

        // Manifest size for the stretched entry should reflect the new file size.
        let after = load_manifest(&dir);
        let stretched_entry = after
            .recordings
            .iter()
            .find(|r| r.file == stretched_name)
            .unwrap();
        let on_disk = std::fs::metadata(dir.join(stretched_name)).unwrap().len();
        assert_eq!(stretched_entry.size_bytes, on_disk);

        // The already-correct file should be unchanged.
        let good_after = std::fs::metadata(dir.join(&good_name)).unwrap().len();
        assert_eq!(
            good_after, good_bytes_len,
            "good file should not have been re-encoded"
        );

        cleanup(&dir);
    }

    #[test]
    fn opus_encoding_compresses_significantly() {
        // 5 seconds of audio at 16kHz mono
        let samples: Vec<f32> = (0..80_000).map(|i| (i as f32 * 0.01).sin() * 0.5).collect();
        let opus_bytes = encode_opus(&samples, 16_000, 1).unwrap();
        let wav_size = samples.len() * 2 + 44; // i16 samples + WAV header
        let ratio = wav_size as f64 / opus_bytes.len() as f64;
        assert!(
            ratio > 5.0,
            "Expected >5x compression, got {ratio:.1}x (WAV={wav_size}, Opus={})",
            opus_bytes.len()
        );
    }

    #[test]
    fn path_traversal_blocked() {
        let dir = temp_dir();
        assert!(get_audio(&dir, "../etc/passwd").is_err());
        assert!(get_audio(&dir, "..\\windows\\system32").is_err());
        assert!(delete_recording(&dir, "../malicious").is_err());
        cleanup(&dir);
    }

    #[test]
    fn empty_samples_rejected() {
        let dir = temp_dir();
        let result = save_recording(&dir, &[], 16_000, 1, "empty", None);
        assert!(result.is_err());
        cleanup(&dir);
    }

    #[test]
    fn get_info_returns_correct_summary() {
        let dir = temp_dir();
        let samples = vec![0.0f32; 16_000]; // 1 second
        save_recording(&dir, &samples, 16_000, 1, "info test", None).unwrap();

        let info = get_info(&dir, true);
        assert!(info.enabled);
        assert_eq!(info.recording_count, 1);
        assert!((info.total_duration_secs - 1.0).abs() < 0.01);
        assert!(info.current_size_bytes > 0);
        cleanup(&dir);
    }

    // ── Corruption / error-path coverage ─────────────────────────────────────

    #[test]
    fn corrupt_manifest_is_backed_up_and_default_returned() {
        let dir = temp_dir();
        fs::write(dir.join("manifest.json"), "{ this is not json").unwrap();

        let manifest = load_manifest(&dir);
        // Default returned (callers can keep working).
        assert!(manifest.recordings.is_empty());
        assert_eq!(manifest.current_size_bytes, 0);

        // Bad file preserved under a backup name so disk forensics is possible.
        let backups: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("manifest.json.bad-")
            })
            .collect();
        assert_eq!(backups.len(), 1, "expected exactly one .bad- backup");
        // Original manifest.json was renamed away.
        assert!(!dir.join("manifest.json").exists());
        cleanup(&dir);
    }

    #[test]
    fn missing_manifest_returns_default_without_creating_files() {
        let dir = temp_dir();
        let manifest = load_manifest(&dir);
        assert!(manifest.recordings.is_empty());
        assert!(
            !dir.join("manifest.json").exists(),
            "load_manifest must not write a fresh manifest as a side effect"
        );
        cleanup(&dir);
    }

    #[test]
    fn update_transcript_on_missing_file_errors() {
        let dir = temp_dir();
        let result = update_transcript(&dir, "does-not-exist.ogg", "new text");
        assert!(result.is_err(), "expected error for unknown filename");
        cleanup(&dir);
    }

    #[test]
    fn update_transcript_persists_change() {
        let dir = temp_dir();
        let samples = vec![0.0f32; 16_000];
        let filename = save_recording(&dir, &samples, 16_000, 1, "original", None).unwrap();

        update_transcript(&dir, &filename, "rewritten").unwrap();

        let manifest = load_manifest(&dir);
        let entry = manifest
            .recordings
            .iter()
            .find(|r| r.file == filename)
            .unwrap();
        assert_eq!(entry.transcript, "rewritten");
        cleanup(&dir);
    }

    #[test]
    fn delete_missing_file_errors() {
        let dir = temp_dir();
        // No save first — the file simply doesn't exist.
        let result = delete_recording(&dir, "ghost.ogg");
        assert!(result.is_err());
        cleanup(&dir);
    }

    #[test]
    fn get_audio_on_missing_file_errors() {
        let dir = temp_dir();
        assert!(get_audio(&dir, "ghost.ogg").is_err());
        cleanup(&dir);
    }

    #[test]
    fn validate_filename_rejects_dangerous_inputs() {
        assert!(validate_filename("").is_err(), "empty filename");
        assert!(validate_filename("..").is_err(), "parent-dir reference");
        assert!(
            validate_filename("../etc/passwd").is_err(),
            "unix traversal"
        );
        assert!(
            validate_filename("..\\windows\\cmd").is_err(),
            "windows traversal"
        );
        assert!(validate_filename("dir/file.ogg").is_err(), "forward slash");
        assert!(validate_filename("dir\\file.ogg").is_err(), "backslash");
        assert!(validate_filename("C:\\file.ogg").is_err(), "drive letter");
        assert!(validate_filename("with\0null.ogg").is_err(), "null byte");
        // The happy path: a normal generated filename.
        assert!(validate_filename("2026-05-06T17-10-13.ogg").is_ok());
    }

    #[test]
    fn save_evicts_multiple_oldest_when_one_save_exceeds_cap_many_fold() {
        let dir = temp_dir();
        let samples = vec![0.1f32; 16_000];

        // Establish file size so we can size the cap correctly.
        let f1 = save_recording(&dir, &samples, 16_000, 1, "a", Some(100 * 1024 * 1024)).unwrap();
        let manifest = load_manifest(&dir);
        let one_size = manifest.recordings[0].size_bytes;

        // Cap fits exactly 3 files (`one_size * 3` exactly, no slack).
        let cap = one_size * 3;
        let f2 = save_recording(&dir, &samples, 16_000, 1, "b", Some(cap)).unwrap();
        let f3 = save_recording(&dir, &samples, 16_000, 1, "c", Some(cap)).unwrap();
        assert_eq!(load_manifest(&dir).recordings.len(), 3);

        // Saving a fourth at this cap requires evicting the oldest (`a`).
        let f4 = save_recording(&dir, &samples, 16_000, 1, "d", Some(cap)).unwrap();
        let after_one = load_manifest(&dir);
        assert_eq!(after_one.recordings.len(), 3);
        assert!(!dir.join(&f1).exists(), "oldest must be evicted");
        assert!(dir.join(&f2).exists() && dir.join(&f3).exists() && dir.join(&f4).exists());

        // Now shrink the cap so the next save must evict two of {b, c, d}.
        let tight_cap = one_size * 2;
        let f5 = save_recording(&dir, &samples, 16_000, 1, "e", Some(tight_cap)).unwrap();
        let after_tight = load_manifest(&dir);
        assert_eq!(after_tight.recordings.len(), 2);
        assert!(dir.join(&f5).exists(), "newest must survive");
        cleanup(&dir);
    }

    #[test]
    fn f32_to_i16_clamps_out_of_range_samples() {
        // Samples outside [-1.0, 1.0] (overamplified mics, gain mistakes) must
        // not wrap around into nonsense values. Implementation uses
        // `i16::MAX as f32` (32767) as the scaling factor for both directions,
        // so the negative limit lands at -32767, not i16::MIN (-32768).
        let samples = vec![2.0f32, -2.0, 0.5, -0.5, 100.0];
        let i16s = f32_to_i16_samples(&samples);
        assert_eq!(i16s[0], i16::MAX);
        assert_eq!(i16s[1], -i16::MAX);
        assert!(i16s[2] > 0 && i16s[2] < i16::MAX);
        assert!(i16s[3] < 0 && i16s[3] > -i16::MAX);
        assert_eq!(i16s[4], i16::MAX, "huge value must clamp, not wrap");
    }

    #[test]
    fn downmix_passthrough_for_mono_input() {
        let mono = vec![0.1f32, 0.2, 0.3];
        assert_eq!(downmix_to_mono(&mono, 1), mono);
    }

    #[test]
    fn resample_linear_handles_same_rate_passthrough() {
        let input = vec![0.5f32; 1000];
        let out = resample_linear(&input, 16_000, 16_000);
        assert_eq!(out.len(), 1000);
    }

    #[test]
    fn resample_linear_handles_empty_input() {
        // Repair path can hit this if a manifest entry exists for an empty
        // file. Must not panic or divide by zero.
        let out = resample_linear(&[], 48_000, 16_000);
        assert!(out.is_empty());
    }

    #[test]
    fn save_then_clear_zeroes_size_counter() {
        let dir = temp_dir();
        let samples = vec![0.0f32; 16_000];
        save_recording(&dir, &samples, 16_000, 1, "x", None).unwrap();
        save_recording(&dir, &samples, 16_000, 1, "y", None).unwrap();

        // Sanity — counter is non-zero before clear.
        assert!(load_manifest(&dir).current_size_bytes > 0);

        clear_all(&dir).unwrap();
        let after = load_manifest(&dir);
        assert_eq!(after.current_size_bytes, 0);
        assert!(after.recordings.is_empty());

        // .ogg files actually deleted (not just removed from manifest).
        let oggs: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".ogg"))
            .collect();
        assert!(
            oggs.is_empty(),
            "clear_all must remove .ogg files from disk"
        );
        cleanup(&dir);
    }

    #[test]
    fn set_max_size_updates_manifest_and_evicts() {
        let dir = temp_dir();
        let samples = vec![0.1f32; 16_000];
        save_recording(&dir, &samples, 16_000, 1, "1", None).unwrap();
        save_recording(&dir, &samples, 16_000, 1, "2", None).unwrap();
        save_recording(&dir, &samples, 16_000, 1, "3", None).unwrap();

        let before = load_manifest(&dir);
        assert_eq!(before.recordings.len(), 3);
        let one_size = before.recordings[0].size_bytes;

        // Shrink cap to a value that holds only one recording.
        let tight = one_size + 100;
        set_max_size(&dir, tight).unwrap();

        let after = load_manifest(&dir);
        assert_eq!(after.max_size_bytes, tight);
        assert_eq!(after.recordings.len(), 1, "shrinking cap must evict to fit");
        cleanup(&dir);
    }
}

#[cfg(test)]
mod streaming_tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_dir() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "macrovox-vb-stream-test-{}-{n}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Writes `secs` of a quiet tone through the streaming recorder. With
    /// `finish == false` the writer is dropped mid-session to mimic a crash.
    fn write_session(path: &Path, secs: f64, finish: bool) -> u64 {
        let mut w = crate::recorder::OpusStreamWriter::create(path, 16_000, 1).unwrap();
        let n = (16_000.0 * secs) as usize;
        let samples: Vec<f32> = (0..n).map(|i| (i as f32 * 0.1).sin() * 0.4).collect();
        for chunk in samples.chunks(800) {
            w.push(chunk).unwrap();
        }
        if finish {
            w.finish().unwrap().size_bytes
        } else {
            drop(w);
            fs::metadata(path).map(|m| m.len()).unwrap_or(0)
        }
    }

    #[test]
    fn register_recording_adds_entry_with_empty_transcript_and_evicts() {
        let dir = temp_dir();
        let a = save_recording(&dir, &vec![0.1; 16_000], 16_000, 1, "first", None).unwrap();
        let b = save_recording(&dir, &vec![0.1; 16_000], 16_000, 1, "second", None).unwrap();
        let before = load_manifest(&dir);
        let size_a = before.recordings[0].size_bytes;
        let size_b = before.recordings[1].size_bytes;

        let path = dir.join("long.ogg");
        let size_new = write_session(&path, 3.0, true);
        // Cap fits the new file plus the newer of the two old ones, not both.
        let cap = size_new + size_b + size_a / 2;
        let entry = register_recording(
            &dir,
            "long.ogg",
            "2026-09-15T10:00:00+00:00".into(),
            3.0,
            size_new,
            Some(cap),
        )
        .unwrap();

        assert_eq!(entry.file, "long.ogg");
        assert_eq!(entry.transcript, "");
        assert_eq!(entry.size_bytes, size_new);
        let after = load_manifest(&dir);
        let names: Vec<&str> = after.recordings.iter().map(|r| r.file.as_str()).collect();
        assert_eq!(
            names,
            vec![b.as_str(), "long.ogg"],
            "oldest evicted, new appended last"
        );
        assert!(!dir.join(&a).exists());
        assert_eq!(after.current_size_bytes, size_b + size_new);
        assert_eq!(after.max_size_bytes, cap);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn recover_partial_adopts_playable_file_and_deletes_junk() {
        let dir = temp_dir();
        let good = dir.join("2026-09-15T10-00-00.000.ogg.partial");
        write_session(&good, 2.4, false);
        let junk = dir.join("2026-09-15T11-00-00.000.ogg.partial");
        fs::write(&junk, b"not an ogg file").unwrap();
        let tiny = dir.join("2026-09-15T12-00-00.000.ogg.partial");
        write_session(&tiny, 0.2, false);

        recover_partial_recordings(&dir);

        assert!(
            !good.exists() && !junk.exists() && !tiny.exists(),
            "no partials left"
        );
        assert!(dir.join("2026-09-15T10-00-00.000.ogg").exists());
        let manifest = load_manifest(&dir);
        assert_eq!(manifest.recordings.len(), 1);
        let rec = &manifest.recordings[0];
        assert_eq!(rec.file, "2026-09-15T10-00-00.000.ogg");
        assert_eq!(rec.transcript, "");
        // Only the two completed one-second pages survived the "crash".
        assert!(
            (rec.duration_secs - 2.0).abs() < 0.05,
            "duration {}",
            rec.duration_secs
        );
        assert!(
            rec.timestamp.starts_with("2026-09-15T10:00:00"),
            "timestamp {}",
            rec.timestamp
        );
        assert_eq!(manifest.current_size_bytes, rec.size_bytes);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn recover_partial_ignores_missing_dir() {
        recover_partial_recordings(Path::new("Z:/definitely/not/here"));
    }
}
