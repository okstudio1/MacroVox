//! MacroVox: streaming OGG Opus recorder for unlimited-length captures.
//!
//! Dictation captures (`recording_start` / `recording_stop`) accumulate PCM in
//! memory and are capped at five minutes. "Record only" sessions started from
//! the HUD must not have a length limit, so they take a different path: every
//! frame the cpal callback receives is cloned into a bounded channel (the
//! *capture tap*), and a dedicated writer thread downmixes it to mono,
//! resamples it to 16 kHz, Opus-encodes it in 20 ms frames and appends OGG
//! pages to a `.partial` file as it goes. Memory use is constant no matter how
//! long the session runs, and a crash mid-session leaves a file whose completed
//! pages are still playable (see `voice_buffer::recover_partial_recordings`).
//!
//! The container written here is the same 16 kHz mono OGG Opus layout that
//! `ogg_opus::encode` produces for short dictations, so playback, reprocessing
//! and the startup repair pass treat both kinds of file identically.

use std::fs::File;
use std::io::{self, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, SyncSender};
use std::thread::JoinHandle;

use audiopus::coder::Encoder;
use audiopus::{Application, Bitrate, Channels, SampleRate};
use log::debug;
use ogg::{PacketReader, PacketWriteEndInfo, PacketWriter};

/// Sample rate of every file the recorder writes.
pub const OUTPUT_RATE: u32 = 16_000;
/// Opus frame length: 20 ms at 16 kHz.
const FRAME_SAMPLES: usize = 320;
/// Largest packet Opus recommends for a single frame.
const MAX_PACKET_BYTES: usize = 4000;
/// Opus granule positions are always expressed at 48 kHz regardless of the
/// input rate (RFC 7845 section 4).
const GRANULE_PER_SAMPLE: u64 = 48_000 / OUTPUT_RATE as u64;
/// Packets per OGG page: 50 x 20 ms = 1 s. Each finished page is flushed to
/// disk, so a hard crash loses at most about a second of audio.
const PACKETS_PER_PAGE: u32 = 50;
/// Bounded channel depth between the cpal callback and the writer thread. A
/// frame is typically 10-20 ms of audio, so this is several seconds of slack
/// before the callback has to drop frames.
pub const TAP_CAPACITY: usize = 512;
/// Sessions shorter than this are discarded rather than saved (double-taps).
pub const MIN_RECORDING_SECS: f64 = 0.5;

/// Sender half of the capture tap. Held in `AppState::capture_tap`; dropping it
/// (setting the option back to `None`) closes the channel, which ends the
/// writer thread's receive loop and finalizes the file.
pub type CaptureTap = SyncSender<Vec<f32>>;

/// Result of a finalized streaming write.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FinishedFile {
    pub duration_secs: f64,
    pub size_bytes: u64,
}

/// An in-flight record-only session.
pub struct ActiveRecording {
    /// Final filename (no `.partial` suffix), e.g. `2026-09-15T14-32-07.123.ogg`.
    pub filename: String,
    /// When capture began; becomes the manifest timestamp.
    pub started_at: chrono::DateTime<chrono::Local>,
    /// Voice-history epoch when capture began. A clear during the session bumps
    /// the live epoch, so registering this file afterwards is refused.
    pub history_epoch: u64,
    /// Writer thread. Joins once the tap is dropped and the file is finalized.
    pub worker: JoinHandle<Result<FinishedFile, String>>,
}

impl ActiveRecording {
    /// Path of the file being written while the session is live.
    pub fn partial_path(&self, dir: &Path) -> PathBuf {
        dir.join(partial_name(&self.filename))
    }
}

/// Name of the in-progress file for a given final filename.
pub fn partial_name(filename: &str) -> String {
    format!("{filename}.partial")
}

fn io_err(e: io::Error) -> String {
    format!("Recorder write failed: {e}")
}

// ── Stateful resampler ────────────────────────────────────────────────────────

/// Linear-interpolation resampler that carries state across chunks, so a stream
/// fed in arbitrary-sized pieces yields the same output as resampling the whole
/// signal at once.
pub struct StreamResampler {
    /// Input samples advanced per output sample (`src_rate / dst_rate`).
    step: f64,
    /// Fractional read position within the virtual buffer `[carry, input...]`.
    pos: f64,
    /// Last input sample of the previous chunk (`None` before the first chunk).
    carry: Option<f32>,
}

impl StreamResampler {
    pub fn new(src_rate: u32, dst_rate: u32) -> Self {
        Self {
            step: src_rate.max(1) as f64 / dst_rate.max(1) as f64,
            pos: 0.0,
            carry: None,
        }
    }

    /// Appends the resampled version of `input` to `out`.
    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if input.is_empty() {
            return;
        }
        if self.step == 1.0 {
            out.extend_from_slice(input);
            return;
        }
        let carry = self.carry;
        let offset = usize::from(carry.is_some());
        let len = input.len() + offset;
        let at = |i: usize| -> f32 {
            if i < offset {
                carry.unwrap_or(0.0)
            } else {
                input[i - offset]
            }
        };
        loop {
            let i0 = self.pos.floor() as usize;
            if i0 + 1 >= len {
                break;
            }
            let frac = (self.pos - i0 as f64) as f32;
            out.push(at(i0) * (1.0 - frac) + at(i0 + 1) * frac);
            self.pos += self.step;
        }
        self.carry = Some(input[input.len() - 1]);
        self.pos -= (len - 1) as f64;
    }
}

/// Averages interleaved channels down to mono, appending to `out`.
fn downmix_into(samples: &[f32], channels: u16, out: &mut Vec<f32>) {
    if channels <= 1 {
        out.extend_from_slice(samples);
        return;
    }
    let ch = channels as usize;
    let inv = 1.0 / ch as f32;
    out.extend(
        samples
            .chunks_exact(ch)
            .map(|frame| frame.iter().sum::<f32>() * inv),
    );
}

// ── Streaming writer ──────────────────────────────────────────────────────────

/// Incremental OGG Opus file writer: 16 kHz mono, 24 kbps, 20 ms frames.
pub struct OpusStreamWriter {
    writer: PacketWriter<BufWriter<File>>,
    encoder: Encoder,
    serial: u32,
    channels_in: u16,
    resampler: StreamResampler,
    mono: Vec<f32>,
    resampled: Vec<f32>,
    /// 16 kHz mono samples waiting to fill a whole frame.
    pending: Vec<i16>,
    packet_buf: Vec<u8>,
    /// Encoder lookahead in samples, prepended as silence and declared as
    /// pre-skip so decoders drop it (RFC 7845 section 4.2).
    pre_skip: u64,
    /// Samples handed to the encoder so far, including pre-skip and padding.
    encoded_samples: u64,
    /// Real audio samples received so far (after resampling).
    real_samples: u64,
    /// Most recent encoded packet, written one step late so the last one can
    /// carry the end-of-stream flag and the trimmed final granule position.
    held: Option<(Box<[u8]>, u64)>,
    packets_in_page: u32,
}

impl OpusStreamWriter {
    /// Creates `path`, writes the OpusHead/OpusTags header pages and returns a
    /// writer ready for `push`. `sample_rate_in` / `channels_in` describe the
    /// capture stream; conversion to 16 kHz mono happens internally.
    pub fn create(path: &Path, sample_rate_in: u32, channels_in: u16) -> Result<Self, String> {
        let mut encoder = Encoder::new(SampleRate::Hz16000, Channels::Mono, Application::Audio)
            .map_err(|e| format!("Opus encoder init failed: {e}"))?;
        encoder
            .set_bitrate(Bitrate::BitsPerSecond(24_000))
            .map_err(|e| format!("Opus encoder config failed: {e}"))?;
        let pre_skip = u64::from(
            encoder
                .lookahead()
                .map_err(|e| format!("Opus encoder lookahead query failed: {e}"))?,
        );

        let file =
            File::create(path).map_err(|e| format!("Failed to create {}: {e}", path.display()))?;
        let mut writer = PacketWriter::new(BufWriter::with_capacity(64 * 1024, file));
        let serial = std::process::id() ^ chrono::Local::now().timestamp_subsec_nanos();

        // OpusHead (RFC 7845 section 5.1), same layout ogg_opus::encode emits.
        let mut head = Vec::with_capacity(19);
        head.extend_from_slice(b"OpusHead");
        head.push(1); // version
        head.push(1); // channel count
        head.extend_from_slice(&((pre_skip * GRANULE_PER_SAMPLE) as u16).to_le_bytes());
        head.extend_from_slice(&OUTPUT_RATE.to_le_bytes()); // input rate (informational)
        head.extend_from_slice(&0i16.to_le_bytes()); // output gain
        head.push(0); // channel mapping family
        writer
            .write_packet(
                head.into_boxed_slice(),
                serial,
                PacketWriteEndInfo::EndPage,
                0,
            )
            .map_err(io_err)?;

        // OpusTags (section 5.2): vendor string, zero user comments.
        let vendor = b"MacroVox";
        let mut tags = Vec::with_capacity(8 + 4 + vendor.len() + 4);
        tags.extend_from_slice(b"OpusTags");
        tags.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
        tags.extend_from_slice(vendor);
        tags.extend_from_slice(&0u32.to_le_bytes());
        writer
            .write_packet(
                tags.into_boxed_slice(),
                serial,
                PacketWriteEndInfo::EndPage,
                0,
            )
            .map_err(io_err)?;

        let mut pending = Vec::with_capacity(FRAME_SAMPLES * 8);
        pending.resize(pre_skip as usize, 0);

        Ok(Self {
            writer,
            encoder,
            serial,
            channels_in: channels_in.max(1),
            resampler: StreamResampler::new(sample_rate_in, OUTPUT_RATE),
            mono: Vec::new(),
            resampled: Vec::new(),
            pending,
            packet_buf: vec![0u8; MAX_PACKET_BYTES],
            pre_skip,
            encoded_samples: 0,
            real_samples: 0,
            held: None,
            packets_in_page: 0,
        })
    }

    /// Feeds interleaved f32 samples at the capture rate. Whole 20 ms frames are
    /// encoded and queued immediately; the remainder waits for the next call.
    pub fn push(&mut self, samples: &[f32]) -> Result<(), String> {
        if samples.is_empty() {
            return Ok(());
        }
        self.mono.clear();
        downmix_into(samples, self.channels_in, &mut self.mono);
        self.resampled.clear();
        self.resampler.process(&self.mono, &mut self.resampled);
        self.real_samples += self.resampled.len() as u64;
        self.pending.extend(
            self.resampled
                .iter()
                .map(|&s| (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16),
        );
        self.drain_frames()
    }

    /// Encodes every whole frame currently in `pending`.
    fn drain_frames(&mut self) -> Result<(), String> {
        let mut offset = 0;
        while self.pending.len() - offset >= FRAME_SAMPLES {
            let frame = &self.pending[offset..offset + FRAME_SAMPLES];
            let packet = encode_frame(&self.encoder, &mut self.packet_buf, frame)?;
            offset += FRAME_SAMPLES;
            self.encoded_samples += FRAME_SAMPLES as u64;
            let granule = self.encoded_samples * GRANULE_PER_SAMPLE;
            self.queue_packet(packet, granule)?;
        }
        self.pending.drain(..offset);
        Ok(())
    }

    /// Writes the previously held packet (if any) and holds `packet`. Ends and
    /// flushes a page every `PACKETS_PER_PAGE` packets.
    fn queue_packet(&mut self, packet: Box<[u8]>, granule: u64) -> Result<(), String> {
        if let Some((prev, prev_granule)) = self.held.take() {
            self.packets_in_page += 1;
            let ends_page = self.packets_in_page >= PACKETS_PER_PAGE;
            let info = if ends_page {
                self.packets_in_page = 0;
                PacketWriteEndInfo::EndPage
            } else {
                PacketWriteEndInfo::NormalPacket
            };
            self.writer
                .write_packet(prev, self.serial, info, prev_granule)
                .map_err(io_err)?;
            if ends_page {
                self.writer.inner_mut().flush().map_err(io_err)?;
            }
        }
        self.held = Some((packet, granule));
        Ok(())
    }

    /// Encodes the zero-padded tail, closes the stream and syncs the file.
    /// Returns the real duration and the file size.
    pub fn finish(mut self) -> Result<FinishedFile, String> {
        if !self.pending.is_empty() {
            let padded = self.pending.len().div_ceil(FRAME_SAMPLES) * FRAME_SAMPLES;
            self.pending.resize(padded, 0);
            self.drain_frames()?;
        }
        // The last packet carries the trimmed position: decoders discard any
        // padding beyond pre-skip + real samples.
        let end_granule = (self.pre_skip + self.real_samples) * GRANULE_PER_SAMPLE;
        if let Some((last, _)) = self.held.take() {
            self.writer
                .write_packet(
                    last,
                    self.serial,
                    PacketWriteEndInfo::EndStream,
                    end_granule,
                )
                .map_err(io_err)?;
        }
        let mut buffered = self.writer.into_inner();
        buffered.flush().map_err(io_err)?;
        let file = buffered
            .into_inner()
            .map_err(|e| format!("Recorder flush failed: {e}"))?;
        file.sync_all().map_err(io_err)?;
        let size_bytes = file.metadata().map_err(io_err)?.len();
        Ok(FinishedFile {
            duration_secs: self.real_samples as f64 / f64::from(OUTPUT_RATE),
            size_bytes,
        })
    }
}

fn encode_frame(encoder: &Encoder, buf: &mut [u8], frame: &[i16]) -> Result<Box<[u8]>, String> {
    let n = encoder
        .encode(frame, buf)
        .map_err(|e| format!("Opus encode failed: {e}"))?;
    Ok(buf[..n].to_vec().into_boxed_slice())
}

// ── Writer thread ─────────────────────────────────────────────────────────────

/// Spawns the writer thread. It drains `rx` until every sender is dropped,
/// then finalizes the file.
pub fn spawn_writer(
    mut writer: OpusStreamWriter,
    rx: Receiver<Vec<f32>>,
) -> Result<JoinHandle<Result<FinishedFile, String>>, String> {
    std::thread::Builder::new()
        .name("macrovox-recorder".into())
        .spawn(move || {
            for chunk in rx {
                writer.push(&chunk)?;
            }
            let finished = writer.finish()?;
            debug!(
                "[recorder] Finalized {:.1}s, {} bytes",
                finished.duration_secs, finished.size_bytes
            );
            Ok(finished)
        })
        .map_err(|e| format!("Failed to spawn recorder thread: {e}"))
}

// ── Crash recovery ────────────────────────────────────────────────────────────

/// Reads the duration of a (possibly truncated) recorder file from the last
/// complete page's granule position. `None` if the file has no OpusHead or no
/// audio pages at all.
pub fn partial_duration_secs(path: &Path) -> Option<f64> {
    let file = File::open(path).ok()?;
    let mut reader = PacketReader::new(BufReader::new(file));
    let head = reader.read_packet().ok().flatten()?;
    if head.data.len() < 19 || &head.data[..8] != b"OpusHead" {
        return None;
    }
    let pre_skip_48k = u64::from(u16::from_le_bytes([head.data[10], head.data[11]]));
    let mut last_granule = 0u64;
    let mut packets = 0u64;
    while let Ok(Some(packet)) = reader.read_packet() {
        last_granule = last_granule.max(packet.absgp_page());
        packets += 1;
    }
    // The first packet after OpusHead is OpusTags; anything beyond it is audio.
    if packets < 2 {
        return None;
    }
    Some(last_granule.saturating_sub(pre_skip_48k) as f64 / 48_000.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_dir() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir =
            std::env::temp_dir().join(format!("macrovox-recorder-test-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sine(rate: u32, channels: usize, secs: f64, hz: f64, amp: f32) -> Vec<f32> {
        let frames = (f64::from(rate) * secs) as usize;
        (0..frames)
            .flat_map(|i| {
                let v =
                    (i as f64 * hz * std::f64::consts::TAU / f64::from(rate)).sin() as f32 * amp;
                std::iter::repeat_n(v, channels)
            })
            .collect()
    }

    fn rms(samples: &[i16]) -> f64 {
        let sum: f64 = samples
            .iter()
            .map(|&s| {
                let v = f64::from(s) / f64::from(i16::MAX);
                v * v
            })
            .sum();
        (sum / samples.len().max(1) as f64).sqrt()
    }

    #[test]
    fn resampler_chunked_matches_single_pass() {
        let input = sine(48_000, 1, 0.5, 440.0, 0.8);
        let mut whole = Vec::new();
        StreamResampler::new(48_000, 16_000).process(&input, &mut whole);

        let mut chunked = Vec::new();
        let mut rs = StreamResampler::new(48_000, 16_000);
        let sizes = [480usize, 333, 1, 1000, 7, 2];
        let (mut i, mut k) = (0, 0);
        while i < input.len() {
            let n = sizes[k % sizes.len()].min(input.len() - i);
            rs.process(&input[i..i + n], &mut chunked);
            i += n;
            k += 1;
        }

        assert_eq!(whole.len(), chunked.len());
        for (a, b) in whole.iter().zip(&chunked) {
            assert!((a - b).abs() < 1e-6, "{a} vs {b}");
        }
        let expected = input.len() / 3;
        assert!(
            (whole.len() as i64 - expected as i64).abs() <= 1,
            "{} vs {expected}",
            whole.len()
        );
    }

    #[test]
    fn resampler_same_rate_is_passthrough() {
        let input = sine(16_000, 1, 0.1, 300.0, 0.5);
        let mut out = Vec::new();
        StreamResampler::new(16_000, 16_000).process(&input, &mut out);
        assert_eq!(out, input);
    }

    #[test]
    fn downmix_averages_interleaved_channels() {
        let mut out = Vec::new();
        downmix_into(&[1.0, -1.0, 0.5, 0.5, 0.2, 0.4], 2, &mut out);
        assert_eq!(out.len(), 3);
        assert!((out[0]).abs() < 1e-6);
        assert!((out[1] - 0.5).abs() < 1e-6);
        assert!((out[2] - 0.3).abs() < 1e-6);
    }

    #[test]
    fn writer_produces_decodable_opus_with_correct_duration() {
        let dir = temp_dir();
        let path = dir.join("session.ogg.partial");
        let mut w = OpusStreamWriter::create(&path, 48_000, 2).unwrap();
        let input = sine(48_000, 2, 2.5, 440.0, 0.5);
        for chunk in input.chunks(960) {
            w.push(chunk).unwrap();
        }
        let finished = w.finish().unwrap();

        assert!(
            (finished.duration_secs - 2.5).abs() < 0.01,
            "duration {}",
            finished.duration_secs
        );
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(bytes.len() as u64, finished.size_bytes);
        assert!(
            bytes.len() < 20_000,
            "24 kbps x 2.5 s should be under 20 kB, got {}",
            bytes.len()
        );

        // The independent decoder that reprocess/repair use must accept it and
        // return the trimmed sample count.
        let (decoded, _) = ogg_opus::decode::<_, 16_000>(std::io::Cursor::new(bytes)).unwrap();
        let expected = 2.5 * 16_000.0;
        assert!(
            (decoded.len() as f64 - expected).abs() <= FRAME_SAMPLES as f64,
            "decoded {} samples, expected about {expected}",
            decoded.len()
        );
        // Skip the first 100 ms of encoder warm-up, then the tone must survive.
        let level = rms(&decoded[1_600..]);
        assert!(level > 0.2 && level < 0.5, "rms {level}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn writer_empty_session_has_zero_duration_but_valid_headers() {
        let dir = temp_dir();
        let path = dir.join("empty.ogg.partial");
        let w = OpusStreamWriter::create(&path, 16_000, 1).unwrap();
        let finished = w.finish().unwrap();
        assert_eq!(finished.duration_secs, 0.0);
        assert!(finished.size_bytes > 0);
        assert!(path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn partial_duration_reads_last_complete_page() {
        let dir = temp_dir();
        let path = dir.join("crash.ogg.partial");
        {
            let mut w = OpusStreamWriter::create(&path, 16_000, 1).unwrap();
            let input = sine(16_000, 1, 2.3, 300.0, 0.5);
            for chunk in input.chunks(320) {
                w.push(chunk).unwrap();
            }
            // Dropped without finish(): simulates a crash. Only the two
            // completed one-second pages reached the file.
        }
        let d = partial_duration_secs(&path).expect("readable partial");
        assert!((d - 2.0).abs() < 0.05, "duration {d}");

        // Header-only file (no audio page yet) and garbage are both unusable.
        let header_only = dir.join("header.ogg.partial");
        drop(OpusStreamWriter::create(&header_only, 16_000, 1).unwrap());
        assert!(partial_duration_secs(&header_only).is_none());
        let junk = dir.join("junk.ogg.partial");
        std::fs::write(&junk, b"definitely not ogg").unwrap();
        assert!(partial_duration_secs(&junk).is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
