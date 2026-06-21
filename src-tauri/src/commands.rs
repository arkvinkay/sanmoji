use crate::ass::build_ass;
use crate::video_stream::VideoPreviewState;
use crate::ffprobe::{get_waveform_peaks, probe_video, VideoInfo};
use crate::project::{validate_project_version, Project};
use crate::fonts::{self, FontInfo};
use crate::settings::{AppSettings, WatermarkSettings};
use crate::subtitle::{export_srt, export_vtt, import_subtitle};
use crate::validation::{validate_project, ValidationIssue};
use crate::ProgressEvent;
use serde::{Deserialize, Serialize};
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

pub struct SettingsCache {
    pub settings: Mutex<AppSettings>,
    pub corrupt: AtomicBool,
}

pub struct FfmpegRuntime {
    pub child: Mutex<Option<CommandChild>>,
}

pub fn init_app_state(app: &AppHandle) -> Result<(), String> {
    let (settings, corrupt) = read_settings_from_disk(app)?;
    app.manage(SettingsCache {
        settings: Mutex::new(settings),
        corrupt: AtomicBool::new(corrupt),
    });
    app.manage(FfmpegRuntime {
        child: Mutex::new(None),
    });
    Ok(())
}

fn lock_or_recover<'a, T>(mutex: &'a Mutex<T>, label: &str) -> std::sync::MutexGuard<'a, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            eprintln!("{label} mutex was poisoned; recovering inner state");
            poisoned.into_inner()
        }
    }
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|_| "Could not locate application data folder".into())
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("settings.json"))
}

fn autosave_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("autosave.smpr"))
}

fn read_settings_from_disk(app: &AppHandle) -> Result<(AppSettings, bool), String> {
    let path = settings_path(app)?;
    if path.exists() {
        let raw = fs::read_to_string(&path)
            .map_err(|e| friendly_io_err("read settings", &path, e))?;
        match serde_json::from_str(&raw) {
            Ok(settings) => Ok((settings, false)),
            Err(e) => {
                eprintln!("settings.json corrupt, using defaults: {e}");
                Ok((AppSettings::default(), true))
            }
        }
    } else {
        Ok((AppSettings::default(), false))
    }
}

fn write_settings_atomic(path: &Path, settings: &AppSettings) -> Result<(), String> {
    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("Could not serialize settings: {e}"))?;
    write_file_atomic(path, &json)
}

fn write_file_atomic(path: &Path, content: &str) -> Result<(), String> {
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

fn backup_file_if_exists(path: &Path) -> Result<(), String> {
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

fn mutate_settings<F>(app: &AppHandle, mutator: F) -> Result<(), String>
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

fn store_ffmpeg_child(app: &AppHandle, child: CommandChild) -> Result<(), String> {
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

fn clear_ffmpeg_child(app: &AppHandle) {
    if let Some(rt) = app.try_state::<FfmpegRuntime>() {
        let mut slot = lock_or_recover(&rt.child, "FFmpeg runtime");
        slot.take();
    }
}

/// Escape a filesystem path for use inside an FFmpeg `ass=filename='…'` filter (Windows-safe).
fn escape_ffmpeg_path(path: &Path) -> String {
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

fn build_watermark_filter(wm: &WatermarkSettings, ass_escaped: &str, duration_ms: Option<u64>) -> String {
    let dur_in = wm.duration_in_ms as f64 / 1000.0;
    let dur_out = wm.duration_out_ms as f64 / 1000.0;
    let video_dur = duration_ms.map(|d| d as f64 / 1000.0).unwrap_or(0.0);

    let mut wm_chain = format!("[1:v]scale={}:{}", wm.width, wm.height);
    if wm.anim_in == "fade" && dur_in > 0.0 {
        wm_chain.push_str(&format!(",fade=t=in:st=0:d={dur_in}:alpha=1"));
    }
    if wm.anim_out == "fade" && dur_out > 0.0 && video_dur > dur_out {
        let st = video_dur - dur_out;
        wm_chain.push_str(&format!(",fade=t=out:st={st}:d={dur_out}:alpha=1"));
    }
    wm_chain.push_str("[wm]");

    let text_block = caption_reserve_space(wm);
    let pos = wm.text_position.trim().to_lowercase();

    let base_x = format!("W-w-{}", wm.margin_x);
    let glitch_jitter = {
        let mut terms: Vec<String> = Vec::new();
        if wm.anim_in == "glitch" && dur_in > 0.0 {
            terms.push(format!("if(lt(t\\,{dur_in})\\,5*sin(80*t)\\,0)"));
        }
        if wm.anim_out == "glitch" && dur_out > 0.0 && video_dur > dur_out {
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

fn friendly_io_err(action: &str, path: &Path, err: std::io::Error) -> String {
    match err.kind() {
        std::io::ErrorKind::NotFound => format!("File not found: {}", path.display()),
        std::io::ErrorKind::PermissionDenied => {
            format!("Permission denied while trying to {action}: {}", path.display())
        }
        _ => format!("Could not {action} ({}): {err}", path.display()),
    }
}

fn friendly_json_err(context: &str, err: serde_json::Error) -> String {
    format!("Could not read {context}: the file may be damaged ({err})")
}

/// Validate a user-supplied filesystem path.
fn validate_user_path(path: &str, must_exist: bool, for_write: bool) -> Result<PathBuf, String> {
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

fn resolve_video_path(project_path: Option<&str>, video_path: &str) -> PathBuf {
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

fn push_recent(settings: &mut AppSettings, path: &str) {
    settings.recent_projects.retain(|p| p != path);
    settings.recent_projects.insert(0, path.to_string());
    settings.recent_projects.truncate(10);
}

fn push_recent_video(settings: &mut AppSettings, path: &str) {
    settings.recent_videos.retain(|p| p != path);
    settings.recent_videos.insert(0, path.to_string());
    settings.recent_videos.truncate(10);
}

#[tauri::command]
pub fn track_recent_video(app: AppHandle, video_path: String) -> Result<(), String> {
    validate_user_path(&video_path, true, false)?;
    mutate_settings(&app, |settings| push_recent_video(settings, &video_path))
}

fn local_ffmpeg(app: &AppHandle) -> Result<PathBuf, String> {
    crate::ffmpeg_fetch::resolve_ffmpeg_path(app)
        .ok_or_else(|| "FFmpeg was not found. Use Settings to download or install it.".into())
}

#[tauri::command]
pub async fn ensure_ffmpeg(app: AppHandle) -> Result<String, String> {
    crate::ffmpeg_fetch::ensure_ffmpeg(app).await
}

#[derive(Serialize)]
pub struct FfmpegStatus {
    pub available: bool,
    pub path: Option<String>,
}

#[tauri::command]
pub fn get_ffmpeg_status(app: AppHandle) -> FfmpegStatus {
    let (available, path) = crate::ffmpeg_fetch::ffmpeg_status(&app);
    FfmpegStatus { available, path }
}

#[derive(Clone, Serialize)]
pub struct SettingsResponse {
    pub settings: AppSettings,
    pub settings_corrupt: bool,
}

// ─── Settings ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_settings(app: AppHandle) -> SettingsResponse {
    if let Some(cache) = app.try_state::<SettingsCache>() {
        let guard = lock_or_recover(&cache.settings, "Settings");
        return SettingsResponse {
            settings: guard.clone(),
            settings_corrupt: cache.corrupt.load(Ordering::Relaxed),
        };
    }
    let (settings, corrupt) =
        read_settings_from_disk(&app).unwrap_or((AppSettings::default(), false));
    SettingsResponse {
        settings,
        settings_corrupt: corrupt,
    }
}

#[tauri::command]
pub fn save_settings(app: AppHandle, mut settings: AppSettings) -> Result<(), String> {
    settings
        .validate_and_sanitize()
        .map_err(|e| format!("Invalid settings: {e}"))?;
    mutate_settings(&app, |cached| *cached = settings)?;
    if let Some(cache) = app.try_state::<SettingsCache>() {
        cache.corrupt.store(false, Ordering::Relaxed);
    }
    Ok(())
}

// ─── Project ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn save_project(app: AppHandle, project: Project, path: String) -> Result<(), String> {
    validate_user_path(&path, false, true)?;
    validate_project_version(project.version)?;
    let path = Path::new(&path);
    let json = serde_json::to_string_pretty(&project)
        .map_err(|e| format!("Could not prepare project data: {e}"))?;
    backup_file_if_exists(path)?;
    write_file_atomic(path, &json)?;
    mutate_settings(&app, |settings| push_recent(settings, path.to_string_lossy().as_ref()))
}

#[tauri::command]
pub fn load_project(app: AppHandle, path: String) -> Result<Project, String> {
    validate_user_path(&path, true, false)?;
    let raw = fs::read_to_string(&path)
        .map_err(|e| friendly_io_err("open project", Path::new(&path), e))?;
    let mut project: Project =
        serde_json::from_str(&raw).map_err(|e| friendly_json_err("project file", e))?;
    validate_project_version(project.version)?;
    let resolved = resolve_video_path(Some(&path), &project.video_path);
    if resolved.exists() {
        project.video_path = resolved.to_string_lossy().to_string();
    }
    mutate_settings(&app, |settings| push_recent(settings, &path))?;
    Ok(project)
}

#[tauri::command]
pub fn relink_video(
    project_path: String,
    mut project: Project,
    new_video_path: String,
) -> Result<Project, String> {
    validate_user_path(&project_path, false, true)?;
    validate_user_path(&new_video_path, true, false)?;
    project.video_path = new_video_path;
    let path = Path::new(&project_path);
    let json = serde_json::to_string_pretty(&project)
        .map_err(|e| format!("Could not prepare project data: {e}"))?;
    backup_file_if_exists(path)?;
    write_file_atomic(path, &json)?;
    Ok(project)
}

#[tauri::command]
pub fn autosave_draft(
    app: AppHandle,
    project: Project,
    project_path: Option<String>,
) -> Result<(), String> {
    let path = autosave_path(&app)?;
    let payload = serde_json::json!({ "project": project, "project_path": project_path });
    let json = serde_json::to_string(&payload)
        .map_err(|e| format!("Could not prepare autosave data: {e}"))?;
    write_file_atomic(&path, &json)
}

#[derive(Serialize)]
pub struct AutosavePayload {
    pub project: Project,
    pub project_path: Option<String>,
}

#[tauri::command]
pub fn load_autosave_draft(app: AppHandle) -> Result<Option<AutosavePayload>, String> {
    let path = autosave_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path)
        .map_err(|e| friendly_io_err("read autosave", &path, e))?;
    let v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| friendly_json_err("autosave file", e))?;
    if v.get("project").is_none() {
        return Err("Autosave data is damaged: missing project data".into());
    }
    let project: Project = serde_json::from_value(v["project"].clone())
        .map_err(|e| friendly_json_err("autosave project data", e))?;
    let project_path = v["project_path"].as_str().map(|s| s.to_string());
    Ok(Some(AutosavePayload {
        project,
        project_path,
    }))
}

// ─── Video probe / waveform ───────────────────────────────────────────────────

#[tauri::command]
pub fn get_video_info(app: AppHandle, video_path: String) -> Result<VideoInfo, String> {
    validate_user_path(&video_path, true, false)?;
    let ffmpeg = local_ffmpeg(&app)?;
    probe_video(&ffmpeg, &video_path)
}

/// Copy or hard-link the video into app cache so WebView2 asset scope always allows it.
#[tauri::command]
pub fn prepare_video_preview_path(app: AppHandle, path: String) -> Result<String, String> {
    validate_user_path(&path, true, false)?;
    let src = PathBuf::from(&path);
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp4");
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Could not resolve app cache directory: {e}"))?;
    fs::create_dir_all(&cache_dir)
        .map_err(|e| friendly_io_err("create preview cache", &cache_dir, e))?;
    let dest = cache_dir.join(format!("preview_{}.{}", uuid::Uuid::new_v4().as_simple(), ext));
    if std::fs::hard_link(&src, &dest).is_err() {
        fs::copy(&src, &dest).map_err(|e| friendly_io_err("prepare video preview", &dest, e))?;
    }
    if let Some(state) = app.try_state::<VideoPreviewState>() {
        state.set(dest.clone());
    }
    Ok(dest.to_string_lossy().to_string())
}

fn emit_video_load_progress(app: &AppHandle, percent: f32, message: &str) {
    let _ = app.emit(
        "video-load-progress",
        ProgressEvent {
            percent,
            message: message.into(),
        },
    );
}

#[tauri::command]
pub async fn get_waveform(app: AppHandle, video_path: String, buckets: u32) -> Result<Vec<f32>, String> {
    validate_user_path(&video_path, true, false)?;
    let ffmpeg = local_ffmpeg(&app)?;
    let path = video_path;
    let app_emit = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        get_waveform_peaks(&ffmpeg, &path, buckets, |pct, msg| {
            emit_video_load_progress(&app_emit, pct, msg);
        })
    })
    .await
    .map_err(|e| format!("Waveform analysis failed unexpectedly: {e}"))?
}

// ─── Validation ───────────────────────────────────────────────────────────────

#[tauri::command]
pub fn validate_export(app: AppHandle, project: Project) -> Vec<ValidationIssue> {
    let settings = get_settings(app).settings;
    validate_project(&project, &settings)
}

// ─── System Fonts ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_system_fonts() -> Result<Vec<FontInfo>, String> {
    tauri::async_runtime::spawn_blocking(fonts::collect_system_fonts)
        .await
        .map_err(|e| format!("Could not load system fonts: {e}"))
}

#[tauri::command]
pub fn cancel_export(app: AppHandle) -> Result<(), String> {
    let rt = app
        .try_state::<FfmpegRuntime>()
        .ok_or("Export system is not available. Please restart the app.")?;
    let mut slot: std::sync::MutexGuard<'_, Option<CommandChild>> =
        lock_or_recover(&rt.child, "FFmpeg runtime");
    if let Some(child) = slot.take() {
        child
            .kill()
            .map_err(|e| format!("Could not cancel export: {e}"))?;
    }
    Ok(())
}

// ─── Subtitle Import / Export ─────────────────────────────────────────────────

#[tauri::command]
pub fn import_subtitle_file(path: String) -> Result<Vec<crate::project::LyricRow>, String> {
    validate_user_path(&path, true, false)?;
    import_subtitle(&path)
}

#[tauri::command]
pub fn generate_ass_preview(
    app: AppHandle,
    project: Project,
    video_w: u32,
    video_h: u32,
) -> Result<String, String> {
    let settings = get_settings(app).settings;
    Ok(build_ass(&project.rows, &settings, video_w, video_h))
}

#[tauri::command]
pub fn export_ass_file(
    app: AppHandle,
    project: Project,
    output_path: String,
    video_w: u32,
    video_h: u32,
) -> Result<(), String> {
    validate_user_path(&output_path, false, true)?;
    let settings = get_settings(app).settings;
    let ass_content = build_ass(&project.rows, &settings, video_w, video_h);
    fs::write(&output_path, ass_content)
        .map_err(|e| friendly_io_err("export ASS file", Path::new(&output_path), e))
}

#[tauri::command]
pub fn export_srt_file(project: Project, output_path: String) -> Result<(), String> {
    validate_user_path(&output_path, false, true)?;
    let content = export_srt(&project.rows);
    fs::write(&output_path, content)
        .map_err(|e| friendly_io_err("export SRT file", Path::new(&output_path), e))
}

#[tauri::command]
pub fn export_subtitle_file(
    app: AppHandle,
    project: Project,
    output_path: String,
    format: String,
    video_w: u32,
    video_h: u32,
) -> Result<(), String> {
    validate_user_path(&output_path, false, true)?;
    let settings = get_settings(app).settings;
    let ext = Path::new(&output_path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    let fmt = if format.is_empty() {
        ext
    } else {
        format.to_lowercase()
    };
    let content = match fmt.as_str() {
        "ass" | "ssa" => build_ass(&project.rows, &settings, video_w, video_h),
        "srt" => export_srt(&project.rows),
        "vtt" => export_vtt(&project.rows),
        _ => return Err(format!("Unsupported subtitle format: {fmt}")),
    };
    fs::write(&output_path, content)
        .map_err(|e| friendly_io_err("export subtitle file", Path::new(&output_path), e))
}

// ─── Video Export ─────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    pub segment_start_ms: Option<u64>,
    pub segment_end_ms: Option<u64>,
    pub video_duration_ms: Option<u64>,
}

struct ExportCodecs {
    video_encoder: String,
    audio_encoder: String,
    extra_args: Vec<String>,
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
            map_nvenc_preset(&settings.preset).into(),
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
            map_qsv_preset(&settings.preset).into(),
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
            settings.preset.clone(),
        ]
    }
}

fn resolve_export_codecs(output_path: &str, settings: &crate::settings::ExportSettings) -> ExportCodecs {
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

fn emit_progress(app: &AppHandle, percent: f32, message: &str) {
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
        while let Some(idx) = self.pending.find(|c| c == '\n' || c == '\r') {
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

async fn run_ffmpeg_command(
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

async fn run_ffmpeg_export(
    app: &AppHandle,
    project: &Project,
    output_path: &str,
    video_w: u32,
    video_h: u32,
    options: ExportOptions,
    track_child: bool,
) -> Result<(), String> {
    validate_user_path(output_path, false, true)?;
    let settings = get_settings(app.clone()).settings;
    let segment_duration_ms = options
        .segment_end_ms
        .zip(options.segment_start_ms)
        .map(|(e, s)| e.saturating_sub(s))
        .filter(|d| *d > 0);

    let full_duration_ms = if segment_duration_ms.is_none() {
        if let Ok(ffmpeg) = local_ffmpeg(app) {
            probe_video(&ffmpeg, &project.video_path)
                .ok()
                .map(|i| i.duration_ms)
                .filter(|d| *d > 0)
        } else {
            None
        }
    } else {
        None
    };

    let duration_ms = segment_duration_ms
        .or(full_duration_ms)
        .or(options.video_duration_ms.filter(|&d| d > 0))
        .or_else(|| {
            project
                .rows
                .iter()
                .map(|r| r.end_ms)
                .max()
                .filter(|&ms| ms > 0)
        });

    let tmp_dir = std::env::temp_dir();
    let ass_path = tmp_dir.join(format!("sanmoji_sub_{}.ass", uuid::Uuid::new_v4()));
    let ass_content = build_ass(&project.rows, &settings, video_w, video_h);
    fs::write(&ass_path, &ass_content)
        .map_err(|e| friendly_io_err("write temporary subtitles", &ass_path, e))?;

    let ass_escaped = escape_ffmpeg_path(&ass_path);
    let wm = &settings.watermark;
    if wm.enabled && !wm.file_path.is_empty() {
        validate_user_path(&wm.file_path, true, false)?;
    }
    let codecs = resolve_export_codecs(output_path, &settings.export);

    let mut args: Vec<String> = Vec::new();
    if let Some(start) = options.segment_start_ms {
        args.push("-ss".into());
        args.push(format!("{:.3}", start as f64 / 1000.0));
    }
    args.push("-i".into());
    args.push(project.video_path.clone());

    let filter = if wm.enabled && !wm.file_path.is_empty() {
        args.push("-i".into());
        args.push(wm.file_path.clone());
        build_watermark_filter(wm, &ass_escaped, duration_ms)
    } else {
        format!("[0:v]ass=filename='{ass}'[out]", ass = ass_escaped)
    };

    if let Some(dur) = segment_duration_ms {
        args.push("-t".into());
        args.push(format!("{:.3}", dur as f64 / 1000.0));
    }

    args.push("-filter_complex".into());
    args.push(filter);
    args.push("-map".into());
    args.push("[out]".into());
    args.push("-map".into());
    args.push("0:a?".into());
    args.push("-c:v".into());
    args.push(codecs.video_encoder);
    args.extend(codecs.extra_args);
    args.push("-c:a".into());
    args.push(codecs.audio_encoder);
    args.push(output_path.to_string());

    let total_ms = duration_ms.unwrap_or(0);
    run_ffmpeg_command(app, args, total_ms, &[ass_path], track_child).await
}

#[tauri::command]
pub async fn cut_video(
    app: AppHandle,
    input_path: String,
    output_path: String,
    start_ms: u64,
    end_ms: u64,
) -> Result<(), String> {
    validate_user_path(&input_path, true, false)?;
    validate_user_path(&output_path, false, true)?;
    if end_ms <= start_ms {
        return Err("Cut end time must be after the start time.".into());
    }
    let duration_ms = end_ms - start_ms;
    let args = vec![
        "-ss".into(),
        format!("{:.3}", start_ms as f64 / 1000.0),
        "-i".into(),
        input_path,
        "-t".into(),
        format!("{:.3}", duration_ms as f64 / 1000.0),
        "-c".into(),
        "copy".into(),
        "-avoid_negative_ts".into(),
        "make_zero".into(),
        output_path,
    ];
    run_ffmpeg_command(&app, args, duration_ms, &[], true).await
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



#[tauri::command]
pub async fn export_video(
    app: AppHandle,
    project: Project,
    output_path: String,
    video_w: u32,
    video_h: u32,
    options: Option<ExportOptions>,
) -> Result<(), String> {
    run_ffmpeg_export(
        &app,
        &project,
        &output_path,
        video_w,
        video_h,
        options.unwrap_or_default(),
        true,
    )
    .await
}

// ─── Batch Export ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchExportItem {
    pub project_path: String,
    pub output_path: String,
    pub video_w: u32,
    pub video_h: u32,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct BatchExportResult {
    pub project_path: String,
    pub output_path: String,
    pub success: bool,
    pub error: Option<String>,
}

async fn process_batch_item(app: AppHandle, item: BatchExportItem) -> BatchExportResult {
    if let Err(e) = validate_user_path(&item.project_path, true, false) {
        return BatchExportResult {
            project_path: item.project_path.clone(),
            output_path: item.output_path.clone(),
            success: false,
            error: Some(e),
        };
    }
    if let Err(e) = validate_user_path(&item.output_path, false, true) {
        return BatchExportResult {
            project_path: item.project_path.clone(),
            output_path: item.output_path.clone(),
            success: false,
            error: Some(e),
        };
    }

    let load_result = fs::read_to_string(&item.project_path)
        .map_err(|e| friendly_io_err("open project", Path::new(&item.project_path), e))
        .and_then(|raw| {
            serde_json::from_str::<Project>(&raw).map_err(|e| friendly_json_err("project file", e))
        });

    match load_result {
        Ok(mut project) => {
            if let Err(e) = validate_project_version(project.version) {
                return BatchExportResult {
                    project_path: item.project_path.clone(),
                    output_path: item.output_path.clone(),
                    success: false,
                    error: Some(e),
                };
            }
            let resolved = resolve_video_path(Some(&item.project_path), &project.video_path);
            if resolved.exists() {
                project.video_path = resolved.to_string_lossy().to_string();
            }
            if project.video_w == 0 || project.video_h == 0 {
                if let Ok(ffmpeg) = local_ffmpeg(&app) {
                    if let Ok(info) = probe_video(&ffmpeg, &project.video_path) {
                        project.video_w = info.width.max(1);
                        project.video_h = info.height.max(1);
                    }
                }
            }
            let w = if item.video_w > 0 {
                item.video_w
            } else {
                project.video_w.max(1)
            };
            let h = if item.video_h > 0 {
                item.video_h
            } else {
                project.video_h.max(1)
            };
            let export_result = run_ffmpeg_export(
                &app,
                &project,
                &item.output_path,
                w,
                h,
                ExportOptions::default(),
                false,
            )
            .await;
            BatchExportResult {
                project_path: item.project_path.clone(),
                output_path: item.output_path.clone(),
                success: export_result.is_ok(),
                error: export_result.err(),
            }
        }
        Err(e) => BatchExportResult {
            project_path: item.project_path.clone(),
            output_path: item.output_path.clone(),
            success: false,
            error: Some(e),
        },
    }
}

#[tauri::command]
pub async fn batch_export_videos(
    app: AppHandle,
    items: Vec<BatchExportItem>,
) -> Result<Vec<BatchExportResult>, String> {
    let total = items.len().max(1);
    let mut results = Vec::with_capacity(items.len());

    for (i, item) in items.into_iter().enumerate() {
        emit_progress(
            &app,
            (i as f32 / total as f32) * 100.0,
            &format!("Batch {}/{total}", i + 1),
        );
        results.push(process_batch_item(app.clone(), item).await);
    }

    emit_progress(&app, 100.0, "Batch export complete");
    Ok(results)
}