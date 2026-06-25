use crate::ass::build_ass;
use crate::project::Project;
use crate::subtitle::{export_srt, export_vtt, import_subtitle};
use std::fs;
use std::path::Path;
use tauri::AppHandle;

use super::common::{friendly_io_err, validate_user_path};
use super::get_settings;

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