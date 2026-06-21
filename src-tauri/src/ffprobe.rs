use crate::process_util::hidden_command;
use serde::Deserialize;
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;

#[derive(Debug, Clone, Serialize)]
pub struct VideoInfo {
    pub width: u32,
    pub height: u32,
    pub duration_ms: u64,
    pub exists: bool,
}

#[derive(Debug, Deserialize)]
struct FfprobeOutput {
    streams: Option<Vec<FfprobeStream>>,
    format: Option<FfprobeFormat>,
}

#[derive(Debug, Deserialize)]
struct FfprobeStream {
    codec_type: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct FfprobeFormat {
    duration: Option<String>,
}

fn resolve_ffprobe_path(ffmpeg_path: &Path) -> PathBuf {
    if let Some(parent) = ffmpeg_path.parent() {
        #[cfg(windows)]
        let sibling = parent.join("ffprobe.exe");
        #[cfg(not(windows))]
        let sibling = parent.join("ffprobe");
        if sibling.exists() {
            return sibling;
        }
    }
    if let Some(name) = ffmpeg_path.file_name().and_then(|n| n.to_str()) {
        let probe_name = name.replace("ffmpeg", "ffprobe");
        let probe = ffmpeg_path.with_file_name(&probe_name);
        if probe.exists() {
            return probe;
        }
    }
    #[cfg(windows)]
    {
        ffmpeg_path.with_file_name("ffprobe.exe")
    }
    #[cfg(not(windows))]
    {
        ffmpeg_path.with_file_name("ffprobe")
    }
}

fn probe_video_ffprobe_json(ffprobe: &Path, video_path: &str) -> Result<VideoInfo, String> {
    let output = hidden_command(ffprobe)
        .args([
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_streams",
            "-show_format",
            video_path,
        ])
        .output()
        .map_err(|e| format!("Could not run ffprobe ({}): {e}", ffprobe.display()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "ffprobe failed for {}: {}",
            video_path,
            stderr.trim()
        ));
    }

    let parsed: FfprobeOutput = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Could not parse ffprobe output for {video_path}: {e}"))?;

    let mut width = 0u32;
    let mut height = 0u32;
    if let Some(streams) = parsed.streams {
        for stream in streams {
            if stream.codec_type.as_deref() == Some("video") {
                if let (Some(w), Some(h)) = (stream.width, stream.height) {
                    width = w;
                    height = h;
                    break;
                }
            }
        }
    }

    let duration_ms = parsed
        .format
        .and_then(|f| f.duration)
        .and_then(|d| d.parse::<f64>().ok())
        .map(|secs| (secs * 1000.0).round() as u64)
        .unwrap_or(0);

    Ok(VideoInfo {
        width,
        height,
        duration_ms,
        exists: true,
    })
}

/// Fallback when ffprobe is not bundled (SanMoji ships ffmpeg.exe only).
fn probe_video_ffmpeg_stderr(ffmpeg_path: &Path, video_path: &str) -> Result<VideoInfo, String> {
    let output = hidden_command(ffmpeg_path)
        .args(["-hide_banner", "-i", video_path])
        .output()
        .map_err(|e| format!("Could not probe video with FFmpeg: {e}"))?;

    let stderr = String::from_utf8_lossy(&output.stderr);
    let mut width = 0u32;
    let mut height = 0u32;
    let mut duration_ms = 0u64;

    for line in stderr.lines() {
        if let Some((w, h)) = parse_resolution(line) {
            width = w;
            height = h;
        }
        if let Some(dur) = parse_duration_line(line) {
            duration_ms = dur;
        }
    }

    Ok(VideoInfo {
        width,
        height,
        duration_ms,
        exists: true,
    })
}

pub fn probe_video(ffmpeg_path: &Path, video_path: &str) -> Result<VideoInfo, String> {
    if !Path::new(video_path).exists() {
        return Ok(VideoInfo {
            width: 0,
            height: 0,
            duration_ms: 0,
            exists: false,
        });
    }

    let ffprobe = resolve_ffprobe_path(ffmpeg_path);
    if ffprobe.exists() {
        if let Ok(info) = probe_video_ffprobe_json(&ffprobe, video_path) {
            return Ok(info);
        }
    }

    probe_video_ffmpeg_stderr(ffmpeg_path, video_path)
}

fn parse_resolution(line: &str) -> Option<(u32, u32)> {
    if !line.contains("Video:") {
        return None;
    }
    for token in line.split_whitespace() {
        if let Some((w, h)) = parse_dim_token(token) {
            return Some((w, h));
        }
        if let Some(rest) = token.strip_prefix('[') {
            if let Some(inner) = rest.strip_suffix(']') {
                if let Some((w, h)) = parse_dim_token(inner) {
                    return Some((w, h));
                }
            }
        }
    }
    None
}

fn parse_dim_token(token: &str) -> Option<(u32, u32)> {
    let token = token.trim_matches(|c: char| c == ',' || c == '[' || c == ']');
    let (w_str, h_str) = token.split_once('x')?;
    let h_clean: String = h_str.chars().take_while(|c| c.is_ascii_digit()).collect();
    let w: u32 = w_str.parse().ok()?;
    let h: u32 = h_clean.parse().ok()?;
    if w > 0 && h > 0 {
        Some((w, h))
    } else {
        None
    }
}

fn parse_duration_line(line: &str) -> Option<u64> {
    let idx = line.find("Duration:")?;
    let dur = line[idx + "Duration:".len()..].trim();
    let dur = dur.split(',').next()?.trim();
    let ms = parse_duration(dur);
    if ms > 0 { Some(ms) } else { None }
}

fn parse_duration(s: &str) -> u64 {
    let s = s.trim();
    if let Some((hms, frac)) = s.split_once('.') {
        let parts: Vec<&str> = hms.split(':').collect();
        if parts.len() == 3 {
            let h: f64 = parts[0].parse().unwrap_or(0.0);
            let m: f64 = parts[1].parse().unwrap_or(0.0);
            let sec: f64 = parts[2].parse().unwrap_or(0.0);
            let frac_ms: f64 = format!("0.{frac}")
                .parse()
                .map(|f: f64| f * 1000.0)
                .unwrap_or(0.0);
            return ((h * 3600.0 + m * 60.0 + sec) * 1000.0 + frac_ms) as u64;
        }
    }
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() != 3 {
        return 0;
    }
    let h: f64 = parts[0].parse().unwrap_or(0.0);
    let m: f64 = parts[1].parse().unwrap_or(0.0);
    let sec: f64 = parts[2].parse().unwrap_or(0.0);
    ((h * 3600.0 + m * 60.0 + sec) * 1000.0) as u64
}

fn waveform_sample_rate(duration_ms: u64) -> u32 {
    if duration_ms > 3_600_000 {
        2000
    } else if duration_ms > 1_800_000 {
        4000
    } else {
        8000
    }
}

const WAVEFORM_READ_CHUNK: usize = 64 * 1024;

pub fn get_waveform_peaks(
    ffmpeg_path: &Path,
    video_path: &str,
    buckets: u32,
    mut on_progress: impl FnMut(f32, &str),
) -> Result<Vec<f32>, String> {
    if !Path::new(video_path).exists() {
        return Err("Video file not found".into());
    }

    let info = probe_video(ffmpeg_path, video_path)?;
    let duration_ms = info.duration_ms.max(1);
    let buckets = buckets.clamp(64, 2048) as usize;
    let sample_rate = waveform_sample_rate(duration_ms);
    let expected_samples = ((duration_ms as f64 / 1000.0) * sample_rate as f64).max(1.0) as usize;
    let samples_per_bucket = (expected_samples / buckets).max(1);

    on_progress(5.0, "Starting waveform analysis…");

    let mut child = hidden_command(ffmpeg_path)
        .args([
            "-hide_banner",
            "-threads",
            "2",
            "-i",
            video_path,
            "-vn",
            "-ac",
            "1",
            "-ar",
            &sample_rate.to_string(),
            "-f",
            "f32le",
            "-",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Could not start waveform extraction: {e}"))?;

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Waveform output stream unavailable".to_string())?;

    let mut peaks = vec![0.0f32; buckets];
    let mut chunk_buf = vec![0u8; WAVEFORM_READ_CHUNK];
    let mut carry = Vec::new();
    let mut read_idx = 0usize;
    let mut sample_index = 0usize;
    let mut last_emit = 0.0f32;

    let read_result = (|| -> Result<(), String> {
        loop {
            let n = stdout
                .read(&mut chunk_buf)
                .map_err(|e| format!("Could not read waveform data: {e}"))?;
            if n == 0 {
                break;
            }
            carry.extend_from_slice(&chunk_buf[..n]);
            while read_idx + 4 <= carry.len() {
                let sample = f32::from_le_bytes([
                    carry[read_idx],
                    carry[read_idx + 1],
                    carry[read_idx + 2],
                    carry[read_idx + 3],
                ]);
                read_idx += 4;
                let sample = sample.abs();
                let bucket = (sample_index / samples_per_bucket).min(buckets - 1);
                if sample > peaks[bucket] {
                    peaks[bucket] = sample;
                }
                sample_index += 1;

                if expected_samples > 0 {
                    let pct =
                        (sample_index as f32 / expected_samples as f32 * 90.0).clamp(5.0, 95.0);
                    if pct - last_emit >= 2.0 {
                        last_emit = pct;
                        on_progress(pct, &format!("Analyzing audio… {pct:.0}%"));
                    }
                }
            }
            if read_idx > 0 {
                carry.drain(..read_idx);
                read_idx = 0;
            }
        }
        Ok(())
    })();

    let status = child
        .wait()
        .map_err(|e| format!("Could not wait for waveform extraction: {e}"))?;

    if let Err(e) = read_result {
        return Err(e);
    }

    if !status.success() {
        return Err(format!(
            "Waveform extraction failed (FFmpeg exit code {:?})",
            status.code()
        ));
    }

    if sample_index == 0 {
        on_progress(100.0, "Waveform ready");
        return Ok(vec![0.0; buckets]);
    }

    let max = peaks.iter().cloned().fold(0.0f32, f32::max).max(0.001);
    for p in &mut peaks {
        *p /= max;
    }

    on_progress(100.0, "Waveform ready");
    Ok(peaks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_resolution_token() {
        assert_eq!(parse_dim_token("1920x1080"), Some((1920, 1080)));
        assert_eq!(parse_dim_token("1920x1080,"), Some((1920, 1080)));
    }

    #[test]
    fn parses_duration_with_fraction() {
        assert_eq!(parse_duration("00:01:30.500"), 90500);
    }
}