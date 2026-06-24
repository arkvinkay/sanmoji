pub mod common;
pub mod export;
pub mod project;
pub mod subtitle;
pub mod system;
pub mod video;

pub use export::*;
pub use project::*;
pub use subtitle::*;
pub use system::*;
pub use video::*;

use crate::settings::AppSettings;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;
use tauri::AppHandle;
use tauri::Manager;
use tauri_plugin_shell::process::CommandChild;

pub struct SettingsCache {
    pub settings: Mutex<AppSettings>,
    pub corrupt: AtomicBool,
}

pub struct FfmpegRuntime {
    pub child: Mutex<Option<CommandChild>>,
}

pub fn init_app_state(app: &AppHandle) -> Result<(), String> {
    let (settings, corrupt) = common::read_settings_from_disk(app)?;
    app.manage(SettingsCache {
        settings: Mutex::new(settings),
        corrupt: AtomicBool::new(corrupt),
    });
    app.manage(FfmpegRuntime {
        child: Mutex::new(None),
    });
    Ok(())
}