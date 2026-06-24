use crate::project::{validate_project_version, Project};
use std::fs;
use std::path::Path;
use tauri::AppHandle;

use super::common::{
    autosave_path, backup_file_if_exists, friendly_io_err, friendly_json_err, mutate_settings,
    push_recent, resolve_video_path, validate_user_path, write_file_atomic,
};

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

#[derive(serde::Serialize)]
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