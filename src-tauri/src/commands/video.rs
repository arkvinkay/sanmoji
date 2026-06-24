use crate::ffprobe::{get_waveform_peaks, probe_video, VideoInfo};
use crate::project::Project;
use crate::video_stream::VideoPreviewState;
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::Manager;

use super::common::{
    backup_file_if_exists, emit_video_load_progress, friendly_io_err, local_ffmpeg,
    mutate_settings, push_recent_video, validate_user_path, write_file_atomic,
};

#[tauri::command]
pub fn track_recent_video(app: AppHandle, video_path: String) -> Result<(), String> {
    validate_user_path(&video_path, true, false)?;
    mutate_settings(&app, |settings| push_recent_video(settings, &video_path))
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
    let path = std::path::Path::new(&project_path);
    let json = serde_json::to_string_pretty(&project)
        .map_err(|e| format!("Could not prepare project data: {e}"))?;
    backup_file_if_exists(path)?;
    write_file_atomic(path, &json)?;
    Ok(project)
}

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