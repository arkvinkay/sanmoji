use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri::Manager;

pub const LEGACY_IDENTIFIER: &str = "id.arkvin.sanmoji.app";

const STATE_FILE: &str = ".legacy-migration.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MigrationOffer {
    pub legacy_identifier: String,
    pub legacy_data_dir: String,
    pub items: Vec<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct MigrationState {
    declined: bool,
    imported: bool,
}

#[cfg(windows)]
fn roaming_data_root(identifier: &str) -> Option<PathBuf> {
    std::env::var_os("APPDATA")
        .map(|root| PathBuf::from(root).join(identifier))
}

#[cfg(windows)]
fn local_data_root(identifier: &str) -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .map(|root| PathBuf::from(root).join(identifier))
}

#[cfg(not(windows))]
fn roaming_data_root(_identifier: &str) -> Option<PathBuf> {
    None
}

#[cfg(not(windows))]
fn local_data_root(_identifier: &str) -> Option<PathBuf> {
    None
}

fn legacy_roaming_dir() -> Option<PathBuf> {
    roaming_data_root(LEGACY_IDENTIFIER)
}

fn legacy_cache_dir() -> Option<PathBuf> {
    local_data_root(LEGACY_IDENTIFIER).map(|p| p.join("cache"))
}

pub fn new_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|_| "Could not locate application data folder".into())
}

pub fn new_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map_err(|_| "Could not locate application cache folder".into())
}

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(new_data_dir(app)?.join(STATE_FILE))
}

fn write_file_atomic(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Could not create folder {}: {e}", parent.display()))?;
        }
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("tmp");
    let tmp = path.with_extension(format!("{ext}.tmp"));
    fs::write(&tmp, content)
        .map_err(|e| format!("Could not write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path)
        .map_err(|e| format!("Could not save {}: {e}", path.display()))
}

fn parse_migration_state(raw: &str) -> Result<MigrationState, serde_json::Error> {
    serde_json::from_str(raw)
}

fn recover_corrupt_state_file(path: &Path, err: &serde_json::Error) {
    eprintln!("migration state corrupt, resetting: {err}");
    let bak = path.with_extension("json.bak");
    let _ = fs::rename(path, &bak);
}

fn read_state(app: &AppHandle) -> Result<MigrationState, String> {
    let path = state_path(app)?;
    if !path.exists() {
        return Ok(MigrationState::default());
    }
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("Could not read migration state: {e}"))?;
    match parse_migration_state(&raw) {
        Ok(state) => Ok(state),
        Err(e) => {
            recover_corrupt_state_file(&path, &e);
            Ok(MigrationState::default())
        }
    }
}

fn write_state(app: &AppHandle, state: &MigrationState) -> Result<(), String> {
    let path = state_path(app)?;
    let json = serde_json::to_string_pretty(state)
        .map_err(|e| format!("Could not serialize migration state: {e}"))?;
    write_file_atomic(&path, &json)
}

fn legacy_items(legacy_dir: &Path) -> Vec<String> {
    let mut items = Vec::new();
    let candidates = ["settings.json", "autosave.smpr"];
    for name in candidates {
        if legacy_dir.join(name).is_file() {
            items.push(name.to_string());
        }
    }
    if legacy_dir.join("ffmpeg/ffmpeg.exe").is_file() {
        items.push("ffmpeg/ffmpeg.exe".to_string());
    }
    items
}

pub fn migration_offer(app: &AppHandle) -> Result<Option<MigrationOffer>, String> {
    let new_dir = new_data_dir(app)?;
    let new_settings = new_dir.join("settings.json");
    if new_settings.is_file() {
        return Ok(None);
    }

    let state = read_state(app)?;
    if state.declined || state.imported {
        return Ok(None);
    }

    let legacy_dir = match legacy_roaming_dir() {
        Some(dir) if dir.join("settings.json").is_file() => dir,
        _ => return Ok(None),
    };

    let items = legacy_items(&legacy_dir);
    if items.is_empty() {
        return Ok(None);
    }

    Ok(Some(MigrationOffer {
        legacy_identifier: LEGACY_IDENTIFIER.into(),
        legacy_data_dir: legacy_dir.to_string_lossy().into_owned(),
        items,
    }))
}

fn copy_file_if_missing(src: &Path, dest: &Path) -> Result<bool, String> {
    if !src.is_file() {
        return Ok(false);
    }
    if dest.exists() {
        return Ok(false);
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Could not create folder {}: {e}", parent.display()))?;
    }
    fs::copy(src, dest).map_err(|e| {
        format!(
            "Could not copy {} to {}: {e}",
            src.display(),
            dest.display()
        )
    })?;
    Ok(true)
}

fn copy_dir_files_if_missing(src_dir: &Path, dest_dir: &Path) -> Result<u32, String> {
    if !src_dir.is_dir() {
        return Ok(0);
    }
    fs::create_dir_all(dest_dir)
        .map_err(|e| format!("Could not create folder {}: {e}", dest_dir.display()))?;
    let mut copied = 0u32;
    let entries = fs::read_dir(src_dir)
        .map_err(|e| format!("Could not read folder {}: {e}", src_dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Could not read directory entry: {e}"))?;
        let path = entry.path();
        if path.is_dir() {
            let n = copy_dir_files_if_missing(&path, &dest_dir.join(entry.file_name()))?;
            copied += n;
            continue;
        }
        if !path.is_file() {
            continue;
        }
        let dest = dest_dir.join(entry.file_name());
        if copy_file_if_missing(&path, &dest)? {
            copied += 1;
        }
    }
    Ok(copied)
}

pub fn copy_legacy_data(app: &AppHandle) -> Result<Vec<String>, String> {
    let legacy_dir = legacy_roaming_dir()
        .filter(|d| d.join("settings.json").is_file())
        .ok_or_else(|| "No legacy settings folder found".to_string())?;

    let new_dir = new_data_dir(app)?;
    let new_cache = new_cache_dir(app)?;
    let mut copied = Vec::new();

    for name in ["settings.json", "autosave.smpr"] {
        let src = legacy_dir.join(name);
        let dest = new_dir.join(name);
        if copy_file_if_missing(&src, &dest)? {
            copied.push(name.to_string());
        }
    }

    let legacy_ffmpeg = legacy_dir.join("ffmpeg");
    let new_ffmpeg = new_dir.join("ffmpeg");
    let n = copy_dir_files_if_missing(&legacy_ffmpeg, &new_ffmpeg)?;
    if n > 0 {
        copied.push(format!("ffmpeg/ ({n} files)"));
    }

    if let Some(legacy_cache) = legacy_cache_dir() {
        let n = copy_dir_files_if_missing(&legacy_cache, &new_cache)?;
        if n > 0 {
            copied.push(format!("cache ({n} files)"));
        }
    }

    if copied.is_empty() {
        return Err("Legacy data was already present or could not be copied".into());
    }

    let mut state = read_state(app)?;
    state.imported = true;
    write_state(app, &state)?;
    Ok(copied)
}

pub fn decline_migration(app: &AppHandle) -> Result<(), String> {
    let mut state = read_state(app)?;
    state.declined = true;
    write_state(app, &state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_items_lists_existing_files() {
        let dir = std::env::temp_dir().join(format!("sanmoji-mig-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("settings.json"), "{}").unwrap();
        let items = legacy_items(&dir);
        assert!(items.contains(&"settings.json".to_string()));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_items_includes_ffmpeg_subdir() {
        let dir = std::env::temp_dir().join(format!("sanmoji-mig-test-{}", uuid::Uuid::new_v4()));
        let ffmpeg_dir = dir.join("ffmpeg");
        fs::create_dir_all(&ffmpeg_dir).unwrap();
        fs::write(ffmpeg_dir.join("ffmpeg.exe"), b"fake").unwrap();
        let items = legacy_items(&dir);
        assert!(items.contains(&"ffmpeg/ffmpeg.exe".to_string()));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn parse_migration_state_rejects_corrupt_json() {
        assert!(parse_migration_state("{not json").is_err());
        let state = parse_migration_state(r#"{"declined":false,"imported":false}"#).unwrap();
        assert!(!state.imported);
        assert!(!state.declined);
    }

    #[test]
    fn recover_corrupt_state_file_renames_to_bak() {
        let dir = std::env::temp_dir().join(format!("sanmoji-mig-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(STATE_FILE);
        fs::write(&path, "{not json").unwrap();
        let err = parse_migration_state("{not json").unwrap_err();
        recover_corrupt_state_file(&path, &err);
        assert!(!path.exists());
        assert!(dir.join(".legacy-migration.json.bak").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}