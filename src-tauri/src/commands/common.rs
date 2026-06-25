use crate::fonts;
use crate::settings::{AppSettings, WatermarkSettings};
use crate::ProgressEvent;
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

use super::{FfmpegRuntime, SettingsCache};

pub(crate) fn lock_or_recover<'a, T>(mutex: &'a Mutex<T>, label: &str) -> std::sync::MutexGuard<'a, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            eprintln!("{label} mutex was poisoned; recovering inner state");
            poisoned.into_inner()
        }
    }
}

pub(crate) fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|_| "Could not locate application data folder".into())
}

pub(crate) fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("settings.json"))
}

pub(crate) fn autosave_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("autosave.smpr"))
}

pub(crate) fn read_settings_from_disk(app: &AppHandle) -> Result<(AppSettings, bool), String> {
    let path = settings_path(app)?;
    if path.exists() {
        let raw = fs::read_to_string(&path)
            .map_err(|e| friendly_io_err("read settings", &path, e))?;
        match serde_json::from_str::<AppSettings>(&raw) {
            Ok(mut settings) => {
                let corrupt = settings.validate_and_sanitize().is_err();
                Ok((settings, corrupt))
            }
            Err(e) => {
                eprintln!("settings.json corrupt, using defaults: {e}");
                Ok((AppSettings::default(), true))
            }
        }
    } else {
        Ok((AppSettings::default(), false))
    }
}

pub(crate) fn write_settings_atomic(path: &Path, settings: &AppSettings) -> Result<(), String> {
    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("Could not serialize settings: {e}"))?;
    write_file_atomic(path, &json)
}

pub(crate) fn write_file_atomic(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| friendly_io_err("create folder", parent, e))?;
        }
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("tmp");
    let tmp = path.with_extension(format!("{ext}.tmp"));
    fs::write(&tmp, content).map_err(|e| friendly_io_err("write file", &tmp, e))?;
    fs::rename(&tmp, path).map_err(|e| friendly_io_err("save file", path, e))?;
    Ok(())
}

pub(crate) fn backup_file_if_exists(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    let bak_name = format!("{file_name}.bak");
    let bak = path
        .parent()
        .map(|p| p.join(&bak_name))
        .unwrap_or_else(|| PathBuf::from(&bak_name));
    fs::copy(path, &bak).map_err(|e| friendly_io_err("backup file", &bak, e))?;
    Ok(())
}

pub(crate) fn mutate_settings<F>(app: &AppHandle, mutator: F) -> Result<(), String>
where
    F: FnOnce(&mut AppSettings),
{
    let cache = app
        .try_state::<SettingsCache>()
        .ok_or("Settings are not available yet. Please restart the app.")?;
    let mut guard = lock_or_recover(&cache.settings, "Settings");
    mutator(&mut guard);
    let path = settings_path(app)?;
    write_settings_atomic(&path, &guard)?;
    Ok(())
}

pub(crate) fn store_ffmpeg_child(app: &AppHandle, child: CommandChild) -> Result<(), String> {
    let rt = app
        .try_state::<FfmpegRuntime>()
        .ok_or("Export system is not available. Please restart the app.")?;
    let mut slot = lock_or_recover(&rt.child, "FFmpeg runtime");
    if slot.is_some() {
        let _ = child.kill();
        return Err("An export is already in progress. Wait for it to finish or cancel it.".into());
    }
    *slot = Some(child);
    Ok(())
}

struct UntrackedFfmpegChild(Option<CommandChild>);

impl UntrackedFfmpegChild {
    fn disarm(&mut self) {
        self.0 = None;
    }
}

impl Drop for UntrackedFfmpegChild {
    fn drop(&mut self) {
        if let Some(child) = self.0.take() {
            let _ = child.kill();
        }
    }
}

pub(crate) fn clear_ffmpeg_child(app: &AppHandle) {
    if let Some(rt) = app.try_state::<FfmpegRuntime>() {
        let mut slot = lock_or_recover(&rt.child, "FFmpeg runtime");
        slot.take();
    }
}

/// Escape a filesystem path for use inside an FFmpeg `ass=filename='…'` filter (Windows-safe).
pub(crate) fn escape_ffmpeg_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .replace(':', "\\:")
        .replace('\'', "\\'")
        .replace('[', "\\[")
        .replace(']', "\\]")
        .replace(';', "\\;")
}

fn escape_drawtext(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace(':', "\\:")
        .replace('\'', "\\'")
        .replace('%', "\\%")
}

fn escape_ffmpeg_font_path(path: &str) -> String {
    path.replace('\\', "/").replace(':', "\\:")
}

fn drawtext_font_clause(family: &str, bold: bool) -> String {
    let mut candidates: Vec<String> = Vec::new();
    let base = family.trim();
    if base.is_empty() {
        candidates.push("Arial".into());
    } else {
        candidates.push(base.into());
        if bold {
            candidates.push(format!("{base} Bold"));
            candidates.push(format!("{base}-Bold"));
        }
    }
    for name in candidates {
        if let Some(path) = fonts::resolve_font_path_by_family(&name) {
            if std::path::Path::new(&path).exists() {
                return format!("fontfile='{}'", escape_ffmpeg_font_path(&path));
            }
        }
    }
    String::new()
}

fn caption_reserve_space(wm: &WatermarkSettings) -> u32 {
    if wm.text.trim().is_empty() {
        return 0;
    }
    let pos = wm.text_position.trim().to_lowercase();
    if pos == "below" || pos == "above" {
        wm.text_gap.saturating_add(wm.text_size.saturating_add(4))
    } else {
        0
    }
}

pub(crate) fn build_watermark_filter(wm: &WatermarkSettings, ass_escaped: &str, duration_ms: Option<u64>) -> String {
    let dur_in = wm.duration_in_ms as f64 / 1000.0;
    let dur_out = wm.duration_out_ms as f64 / 1000.0;
    let video_dur = duration_ms.map(|d| d as f64 / 1000.0).unwrap_or(0.0);

    let mut wm_chain = format!("[1:v]scale={}:{}", wm.width, wm.height);
    if wm.anim_in == crate::settings::AnimationType::Fade && dur_in > 0.0 {
        wm_chain.push_str(&format!(",fade=t=in:st=0:d={dur_in}:alpha=1"));
    }
    if wm.anim_out == crate::settings::AnimationType::Fade && dur_out > 0.0 && video_dur > dur_out {
        let st = video_dur - dur_out;
        wm_chain.push_str(&format!(",fade=t=out:st={st}:d={dur_out}:alpha=1"));
    }
    wm_chain.push_str("[wm]");

    let text_block = caption_reserve_space(wm);
    let pos = wm.text_position.trim().to_lowercase();

    let base_x = format!("W-w-{}", wm.margin_x);
    let glitch_jitter = {
        let mut terms: Vec<String> = Vec::new();
        if wm.anim_in == crate::settings::AnimationType::Glitch && dur_in > 0.0 {
            terms.push(format!("if(lt(t\\,{dur_in})\\,5*sin(80*t)\\,0)"));
        }
        if wm.anim_out == crate::settings::AnimationType::Glitch && dur_out > 0.0 && video_dur > dur_out {
            let out_start = video_dur - dur_out;
            terms.push(format!("if(gt(t\\,{out_start})\\,5*sin(80*t)\\,0)"));
        }
        if terms.is_empty() {
            String::new()
        } else {
            format!("+{}", terms.join("+"))
        }
    };
    let overlay_x = format!("{base_x}{glitch_jitter}");

    let overlay_y = format!("H-h-{}-{}", wm.margin_y, text_block);

    let mut chain = format!(
        "[0:v][wm]overlay=x='{overlay_x}':y='{overlay_y}'[ov]"
    );

    if !wm.text.trim().is_empty() {
        let text = escape_drawtext(wm.text.trim());
        let color = wm.text_color.trim_start_matches('#');
        let outline = wm.text_outline_color.trim_start_matches('#');
        let borderw = wm.text_outline_size.max(0.0);
        let gap = wm.text_gap;
        let ts = wm.text_size;

        let (text_x, text_y) = match pos.as_str() {
            "above" => (
                format!("W-tw-{}", wm.margin_x),
                format!("H-h-{}-{}-{}-{}", wm.margin_y, text_block, gap, ts),
            ),
            "beside" => (
                format!("W-w-{}-{}-tw", wm.margin_x, wm.width.saturating_add(gap)),
                format!("H-h-{}+(h-th)/2", wm.margin_y),
            ),
            _ => (
                format!("W-tw-{}", wm.margin_x),
                format!("H-{}-{}", wm.margin_y, ts + 2),
            ),
        };

        let font_clause = drawtext_font_clause(&wm.text_font, wm.text_bold);
        let font_part = if font_clause.is_empty() {
            String::new()
        } else {
            format!(":{font_clause}")
        };

        let mut draw = format!(
            ";[ov]drawtext=text='{text}':x={text_x}:y={text_y}:fontsize={ts}:fontcolor=0x{color}@0.85{font_part}"
        );
        if borderw > 0.0 {
            draw.push_str(&format!(":borderw={borderw}:bordercolor=0x{outline}@0.85"));
        }
        if wm.text_shadow {
            draw.push_str(":shadowx=1:shadowy=1:shadowcolor=0x000000@0.55");
        }
        draw.push_str("[vwm]");
        chain.push_str(&draw);
        chain.push_str(&format!(
            ";[vwm]ass=filename='{ass}'[out]",
            ass = ass_escaped
        ));
    } else {
        chain.push_str(&format!(
            ";[ov]ass=filename='{ass}'[out]",
            ass = ass_escaped
        ));
    }

    format!("{wm_chain};{chain}")
}

pub(crate) fn friendly_io_err(action: &str, path: &Path, err: std::io::Error) -> String {
    match err.kind() {
        std::io::ErrorKind::NotFound => format!("File not found: {}", path.display()),
        std::io::ErrorKind::PermissionDenied => {
            format!("Permission denied while trying to {action}: {}", path.display())
        }
        _ => format!("Could not {action} ({}): {err}", path.display()),
    }
}

pub(crate) fn friendly_json_err(context: &str, err: serde_json::Error) -> String {
    format!("Could not read {context}: the file may be damaged ({err})")
}

/// Validate a user-supplied filesystem path.
pub(crate) fn validate_user_path(path: &str, must_exist: bool, for_write: bool) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err("No file path was provided.".into());
    }
    if path.contains('\0') {
        return Err("The file path contains invalid characters.".into());
    }
    let pb = PathBuf::from(path);
    if pb.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("Paths containing '..' are not allowed.".into());
    }
    if must_exist && !pb.exists() {
        return Err(format!("File not found: {path}"));
    }
    if for_write {
        if let Some(parent) = pb.parent() {
            if !parent.as_os_str().is_empty() && !parent.exists() {
                return Err(format!(
                    "The folder does not exist: {}",
                    parent.display()
                ));
            }
        }
    }
    Ok(pb)
}

pub(crate) fn resolve_video_path(project_path: Option<&str>, video_path: &str) -> PathBuf {
    if let Some(proj) = project_path {
        if let Some(base) = Path::new(proj).parent() {
            let relative = base.join(video_path);
            if relative.exists() {
                return relative;
            }
        }
    }
    let p = PathBuf::from(video_path);
    if p.is_absolute() {
        return p;
    }
    if p.exists() {
        return p;
    }
    p
}

pub(crate) fn push_recent(settings: &mut AppSettings, path: &str) {
    settings.recent_projects.retain(|p| p != path);
    settings.recent_projects.insert(0, path.to_string());
    settings.recent_projects.truncate(10);
}

pub(crate) fn push_recent_video(settings: &mut AppSettings, path: &str) {
    settings.recent_videos.retain(|p| p != path);
    settings.recent_videos.insert(0, path.to_string());
    settings.recent_videos.truncate(10);
}

pub(crate) fn local_ffmpeg(app: &AppHandle) -> Result<PathBuf, String> {
    crate::ffmpeg_fetch::resolve_ffmpeg_path(app)
        .ok_or_else(|| "FFmpeg was not found. Use Settings to download or install it.".into())
}

pub(crate) fn emit_video_load_progress(app: &AppHandle, percent: f32, message: &str) {
    let _ = app.emit(
        "video-load-progress",
        ProgressEvent {
            percent,
            message: message.into(),
        },
    );
}

pub(crate) fn emit_progress(app: &AppHandle, percent: f32, message: &str) {
    let _ = app.emit(
        "export-progress",
        ProgressEvent {
            percent,
            message: message.into(),
        },
    );
}

fn format_ms_time(ms: u64) -> String {
    let h = ms / 3_600_000;
    let m = (ms % 3_600_000) / 60_000;
    let s = (ms % 60_000) / 1_000;
    let rem = ms % 1_000;
    format!("{h:02}:{m:02}:{s:02}.{rem:03}")
}

fn format_duration_secs(secs: u64) -> String {
    if secs >= 3_600 {
        format!("{}:{:02}:{:02}", secs / 3_600, (secs % 3_600) / 60, secs % 60)
    } else {
        format!("{}:{:02}", secs / 60, secs % 60)
    }
}

fn parse_current_ms(line: &str) -> Option<u64> {
    let trimmed = line.trim();
    if let Some(v) = trimmed.strip_prefix("out_time_us=") {
        return v.trim().parse::<u64>().ok().map(|us| us / 1000);
    }
    if let Some(v) = trimmed.strip_prefix("out_time_ms=") {
        return v.trim().parse::<u64>().ok();
    }
    if trimmed.starts_with("out_time=") {
        return parse_out_time_ms(trimmed);
    }
    parse_ffmpeg_time(trimmed)
}

struct ExportProgressTracker {
    total_ms: u64,
    last_pct: f32,
    last_emit: Instant,
    encode_started: Option<Instant>,
    pending: String,
}

impl ExportProgressTracker {
    fn new(total_ms: u64) -> Self {
        Self {
            total_ms,
            last_pct: -1.0,
            last_emit: Instant::now(),
            encode_started: None,
            pending: String::new(),
        }
    }

    fn ingest(&mut self, app: &AppHandle, chunk: &str) {
        self.pending.push_str(chunk);
        while let Some(idx) = self.pending.find(|c| ['\n', '\r'].contains(&c)) {
            let line = self.pending[..idx].trim().to_string();
            self.pending = self.pending[idx + 1..].to_string();
            if !line.is_empty() {
                self.on_line(app, &line);
            }
        }
    }

    fn on_line(&mut self, app: &AppHandle, line: &str) {
        if let Some(cur_ms) = parse_current_ms(line) {
            self.update(app, cur_ms);
        }
    }

    fn update(&mut self, app: &AppHandle, cur_ms: u64) {
        let now = Instant::now();
        if self.encode_started.is_none() && cur_ms > 0 {
            self.encode_started = Some(now);
        }

        let pct = if self.total_ms > 0 {
            (cur_ms as f32 / self.total_ms as f32 * 100.0).clamp(0.0, 99.5)
        } else {
            0.0
        };

        let pct_step = (pct - self.last_pct).abs();
        let time_elapsed = now.duration_since(self.last_emit).as_millis() >= 400;
        let should_emit = self.last_pct < 0.0
            || pct_step >= 0.15
            || (time_elapsed && pct > self.last_pct);

        if !should_emit {
            return;
        }

        self.last_pct = pct;
        self.last_emit = now;
        emit_progress(app, pct, &self.format_message(cur_ms, pct));
    }

    fn format_message(&self, cur_ms: u64, pct: f32) -> String {
        if self.total_ms > 0 {
            let elapsed = self
                .encode_started
                .map(|s| Instant::now().duration_since(s).as_secs())
                .unwrap_or(0);
            let eta = if cur_ms > 500 && pct >= 0.5 {
                ((elapsed as f64) * (100.0 - pct as f64) / pct as f64).round() as u64
            } else {
                0
            };
            format!(
                "Encoding… {pct:.1}% · {} / {} · elapsed {} · ETA {}",
                format_ms_time(cur_ms),
                format_ms_time(self.total_ms),
                format_duration_secs(elapsed),
                if eta > 0 {
                    format_duration_secs(eta)
                } else {
                    "--:--".into()
                }
            )
        } else {
            format!("Encoding… {}", format_ms_time(cur_ms))
        }
    }
}

fn poll_progress_file(tracker: &Arc<Mutex<ExportProgressTracker>>, app: &AppHandle, path: &Path, last_pos: &mut u64) {
    let Ok(mut file) = OpenOptions::new().read(true).open(path) else {
        return;
    };
    if file.seek(SeekFrom::Start(*last_pos)).is_err() {
        return;
    }
    let mut buf = [0u8; 8192];
    let Ok(n) = file.read(&mut buf) else {
        return;
    };
    if n == 0 {
        return;
    }
    *last_pos += n as u64;
    let chunk = String::from_utf8_lossy(&buf[..n]);
    if let Ok(mut t) = tracker.lock() {
        t.ingest(app, &chunk);
    }
}

pub(crate) async fn run_ffmpeg_command(
    app: &AppHandle,
    args: Vec<String>,
    total_ms: u64,
    cleanup: &[PathBuf],
    track_child: bool,
) -> Result<(), String> {
    let ffmpeg = local_ffmpeg(app)?;
    let progress_file =
        std::env::temp_dir().join(format!("sanmoji_prog_{}.txt", uuid::Uuid::new_v4()));
    let _ = fs::remove_file(&progress_file);

    let mut full_args = vec![
        "-hide_banner".into(),
        "-y".into(),
        "-progress".into(),
        progress_file.to_string_lossy().to_string(),
        "-stats_period".into(),
        "0.25".into(),
    ];
    full_args.extend(args);

    emit_progress(app, 0.0, "Starting encoder…");

    let (mut rx, child) = app
        .shell()
        .command(ffmpeg.to_string_lossy().to_string())
        .args(full_args)
        .spawn()
        .map_err(|e| format!("Could not start FFmpeg: {e}"))?;

    let mut child_guard = if track_child {
        store_ffmpeg_child(app, child)?;
        None
    } else {
        Some(UntrackedFfmpegChild(Some(child)))
    };

    let tracker = Arc::new(Mutex::new(ExportProgressTracker::new(total_ms)));
    let done = Arc::new(AtomicBool::new(false));
    let app_poll = app.clone();
    let pf = progress_file.clone();
    let done_poll = done.clone();
    let tracker_poll = tracker.clone();
    let poll = thread::spawn(move || {
        let mut last_pos = 0u64;
        while !done_poll.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(100));
            poll_progress_file(&tracker_poll, &app_poll, &pf, &mut last_pos);
        }
    });

    let mut result = Err("FFmpeg stopped unexpectedly.".into());
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stderr(bytes) => {
                if let Ok(mut t) = tracker.lock() {
                    t.ingest(app, &String::from_utf8_lossy(&bytes));
                }
            }
            CommandEvent::Stdout(bytes) => {
                if let Ok(mut t) = tracker.lock() {
                    t.ingest(app, &String::from_utf8_lossy(&bytes));
                }
            }
            CommandEvent::Terminated(payload) => {
                if track_child {
                    clear_ffmpeg_child(app);
                } else if let Some(guard) = child_guard.as_mut() {
                    guard.disarm();
                }
                done.store(true, Ordering::Relaxed);
                let mut fin_pos = 0u64;
                poll_progress_file(&tracker, app, &progress_file, &mut fin_pos);
                let _ = fs::remove_file(&progress_file);
                for c in cleanup {
                    let _ = fs::remove_file(c);
                }
                result = if payload.code == Some(0) {
                    emit_progress(app, 100.0, "Export complete");
                    Ok(())
                } else {
                    Err(format!(
                        "Video encoding failed (FFmpeg exit code {:?}). \
                         Check that the video file is valid and try again.",
                        payload.code
                    ))
                };
                break;
            }
            _ => {}
        }
    }
    if track_child {
        clear_ffmpeg_child(app);
    }
    done.store(true, Ordering::Relaxed);
    let _ = poll.join();
    let _ = fs::remove_file(&progress_file);
    result
}

fn parse_ffmpeg_time(line: &str) -> Option<u64> {
    let idx = line.find("time=")?;
    let rest = &line[idx + 5..];
    let time_str = rest.split_whitespace().next()?;
    let parts: Vec<&str> = time_str.split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let h: f64 = parts[0].parse().ok()?;
    let m: f64 = parts[1].parse().ok()?;
    let s: f64 = parts[2].parse().ok()?;
    Some((h * 3_600_000.0 + m * 60_000.0 + s * 1000.0) as u64)
}

fn parse_out_time_ms(line: &str) -> Option<u64> {
    let v = line.strip_prefix("out_time=")?.trim();
    let (hms, frac) = v.split_once('.').unwrap_or((v, "0"));
    let parts: Vec<&str> = hms.split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let h: f64 = parts[0].parse().ok()?;
    let m: f64 = parts[1].parse().ok()?;
    let s: f64 = parts[2].parse().ok()?;
    let frac_ms: f64 = format!("0.{frac}")
        .parse()
        .map(|f: f64| f * 1000.0)
        .unwrap_or(0.0);
    Some((h * 3_600_000.0 + m * 60_000.0 + s * 1000.0 + frac_ms) as u64)
}

pub(crate) struct ExportCodecs {
    pub(crate) video_encoder: String,
    pub(crate) audio_encoder: String,
    pub(crate) extra_args: Vec<String>,
}

fn map_nvenc_preset(x264_preset: &str) -> &'static str {
    match x264_preset.trim().to_lowercase().as_str() {
        "ultrafast" | "superfast" => "p7",
        "veryfast" | "faster" => "p5",
        "fast" => "p4",
        "medium" => "p4",
        "slow" => "p3",
        "slower" | "veryslow" => "p2",
        _ => "p4",
    }
}

fn map_qsv_preset(x264_preset: &str) -> &'static str {
    match x264_preset.trim().to_lowercase().as_str() {
        "ultrafast" | "superfast" | "veryfast" | "faster" | "fast" => "veryfast",
        "slow" | "slower" | "veryslow" => "slow",
        _ => "medium",
    }
}

fn h264_encoder_args(encoder: &str, settings: &crate::settings::ExportSettings) -> Vec<String> {
    let enc = encoder.trim().to_lowercase();
    if enc == "h264_nvenc" {
        vec![
            "-preset".into(),
            map_nvenc_preset(settings.preset.as_str()).into(),
            "-rc:v".into(),
            "vbr".into(),
            "-cq".into(),
            settings.crf.to_string(),
            "-b:v".into(),
            "0".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
        ]
    } else if enc == "h264_qsv" {
        vec![
            "-preset".into(),
            map_qsv_preset(settings.preset.as_str()).into(),
            "-global_quality".into(),
            settings.crf.to_string(),
            "-pix_fmt".into(),
            "yuv420p".into(),
        ]
    } else {
        vec![
            "-crf".into(),
            settings.crf.to_string(),
            "-preset".into(),
            settings.preset.as_str().into(),
        ]
    }
}

pub(crate) fn resolve_export_codecs(output_path: &str, settings: &crate::settings::ExportSettings) -> ExportCodecs {
    let ext = Path::new(output_path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("mp4")
        .to_lowercase();
    match ext.as_str() {
        "webm" => ExportCodecs {
            video_encoder: "libvpx-vp9".into(),
            audio_encoder: "libopus".into(),
            extra_args: vec![
                "-b:v".into(),
                "0".into(),
                "-crf".into(),
                settings.crf.to_string(),
            ],
        },
        _ => {
            let encoder = if settings.encoder.is_empty() {
                "libx264".to_string()
            } else {
                settings.encoder.clone()
            };
            ExportCodecs {
                video_encoder: encoder.clone(),
                audio_encoder: "copy".into(),
                extra_args: h264_encoder_args(&encoder, settings),
            }
        }
    }
}

