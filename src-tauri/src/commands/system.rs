use crate::migration::{self, MigrationOffer};
use crate::settings::AppSettings;
use crate::StartFileState;
use crate::fonts::{self, FontInfo};
use serde::Serialize;
use std::sync::atomic::Ordering;
use tauri::AppHandle;
use tauri::Manager;

use super::common::{lock_or_recover, mutate_settings, read_settings_from_disk};
use super::SettingsCache;

#[derive(Serialize)]
pub struct SettingsResponse {
    pub settings: AppSettings,
    pub settings_corrupt: bool,
}

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

#[derive(Serialize)]
pub struct FfmpegStatus {
    pub available: bool,
    pub path: Option<String>,
}

#[tauri::command]
pub async fn ensure_ffmpeg(app: AppHandle) -> Result<String, String> {
    crate::ffmpeg_fetch::ensure_ffmpeg(app).await
}

#[tauri::command]
pub fn get_ffmpeg_status(app: AppHandle) -> FfmpegStatus {
    let (available, path) = crate::ffmpeg_fetch::ffmpeg_status(&app);
    FfmpegStatus { available, path }
}

#[tauri::command]
pub async fn get_system_fonts() -> Result<Vec<FontInfo>, String> {
    tauri::async_runtime::spawn_blocking(fonts::collect_system_fonts)
        .await
        .map_err(|e| format!("Could not load system fonts: {e}"))
}

#[tauri::command]
pub fn get_legacy_migration_offer(app: AppHandle) -> Result<Option<MigrationOffer>, String> {
    migration::migration_offer(&app)
}

#[derive(Clone, Serialize)]
pub struct LegacyImportResult {
    pub copied: Vec<String>,
}

#[tauri::command]
pub fn import_legacy_data(app: AppHandle) -> Result<LegacyImportResult, String> {
    let copied = migration::copy_legacy_data(&app)?;
    let (settings, corrupt) = read_settings_from_disk(&app)?;
    if let Some(cache) = app.try_state::<SettingsCache>() {
        *lock_or_recover(&cache.settings, "Settings") = settings;
        cache.corrupt.store(corrupt, Ordering::Relaxed);
    }
    Ok(LegacyImportResult { copied })
}

#[tauri::command]
pub fn decline_legacy_migration(app: AppHandle) -> Result<(), String> {
    migration::decline_migration(&app)
}

#[tauri::command]
pub fn get_start_file(state: tauri::State<'_, StartFileState>) -> Option<String> {
    lock_or_recover(&state.0, "StartFileState").clone()
}