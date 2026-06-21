use crate::process_util::hidden_command;
use crate::ProgressEvent;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{copy, Read};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};
use zip::ZipArchive;

#[cfg(windows)]
const FFMPEG_URL: &str =
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip";

/// Minimum expected size for the FFmpeg zip (rolling "latest" builds vary; size check is fallback).
#[cfg(windows)]
const FFMPEG_ZIP_MIN_BYTES: u64 = 50 * 1024 * 1024;

/// Pin a specific release hash here to reject tampered downloads; `None` for rolling "latest".
#[cfg(windows)]
const FFMPEG_ZIP_EXPECTED_SHA256: Option<&str> = None;

pub fn ffmpeg_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("ffmpeg");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub fn downloaded_ffmpeg_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(ffmpeg_data_dir(app)?.join("ffmpeg.exe"))
}

#[cfg(not(windows))]
fn system_ffmpeg_from_path() -> Option<PathBuf> {
    let which_cmd = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };
    hidden_command(which_cmd)
        .arg("ffmpeg")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|stdout| {
            stdout
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .map(|line| PathBuf::from(line))
        })
        .filter(|p| p.exists())
}

pub fn resolve_ffmpeg_path(app: &AppHandle) -> Option<PathBuf> {
    // Release NSIS install: sidecar sits next to sanmoji.exe (not under bin/).
    if let Ok(exe_dir) = app.path().executable_dir() {
        #[cfg(windows)]
        let sidecars = [
            exe_dir.join("ffmpeg.exe"),
            exe_dir.join("ffmpeg-x86_64-pc-windows-msvc.exe"),
        ];
        #[cfg(not(windows))]
        let sidecars = [exe_dir.join("ffmpeg")];
        for candidate in sidecars {
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    if let Ok(res) = app.path().resource_dir() {
        #[cfg(windows)]
        let bundled = res.join("bin/ffmpeg.exe");
        #[cfg(not(windows))]
        let bundled = res.join("bin/ffmpeg");
        if bundled.exists() {
            return Some(bundled);
        }
    }
    #[cfg(debug_assertions)]
    {
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("bin/ffmpeg-x86_64-pc-windows-msvc.exe");
        if dev.exists() {
            return Some(dev);
        }
    }
    if let Ok(p) = downloaded_ffmpeg_path(app) {
        if p.exists() {
            return Some(p);
        }
    }
    #[cfg(not(windows))]
    {
        if let Some(p) = system_ffmpeg_from_path() {
            return Some(p);
        }
    }
    None
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

#[cfg(windows)]
fn download_file_powershell(url: &str, dest: &Path) -> Result<(), String> {
    let dest_str = dest.to_string_lossy().replace('\'', "''");
    let url_esc = url.replace('\'', "''");
    let script = format!(
        "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '{url_esc}' -OutFile '{dest_str}' -UseBasicParsing"
    );
    let status = hidden_command("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .status()
        .map_err(|e| format!("PowerShell download failed: {e}"))?;
    if !status.success() {
        return Err(format!("FFmpeg download failed (exit {status})"));
    }
    Ok(())
}

#[cfg(windows)]
fn verify_zip_download(zip_path: &Path) -> Result<(), String> {
    let meta = fs::metadata(zip_path).map_err(|e| format!("Could not read downloaded zip: {e}"))?;
    if meta.len() < FFMPEG_ZIP_MIN_BYTES {
        let _ = fs::remove_file(zip_path);
        return Err(format!(
            "Downloaded FFmpeg archive is too small ({} bytes). \
             The download may be incomplete — please try again.",
            meta.len()
        ));
    }

    let mut file = File::open(zip_path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let digest = hasher.finalize();
    let hash_hex = hex::encode(digest);
    eprintln!("FFmpeg download SHA256: {hash_hex}");
    if let Some(expected) = FFMPEG_ZIP_EXPECTED_SHA256 {
        if hash_hex != expected {
            let _ = fs::remove_file(zip_path);
            return Err(format!(
                "Downloaded FFmpeg archive failed integrity check \
                 (expected {expected}, got {hash_hex})"
            ));
        }
    }
    Ok(())
}

#[cfg(windows)]
pub async fn download_ffmpeg_if_missing(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(p) = resolve_ffmpeg_path(app) {
        return Ok(p);
    }

    let dest = downloaded_ffmpeg_path(app)?;
    let zip_path = ffmpeg_data_dir(app)?.join("ffmpeg-download.zip");
    let app_dl = app.clone();
    let zip_dl = zip_path.clone();
    emit_progress(app, 0.0, "Downloading FFmpeg… (this may take a few minutes)");

    let url = FFMPEG_URL.to_string();
    tauri::async_runtime::spawn_blocking(move || download_file_powershell(&url, &zip_dl))
        .await
        .map_err(|e| format!("Download task failed: {e}"))??;

    verify_zip_download(&zip_path)?;

    emit_progress(&app_dl, 85.0, "Extracting FFmpeg…");
    extract_ffmpeg_exe_from_file(&zip_path, &dest)?;
    let _ = fs::remove_file(&zip_path);

    verify_ffmpeg_binary(&dest)?;
    emit_progress(&app_dl, 100.0, "FFmpeg ready");
    Ok(dest)
}

#[cfg(not(windows))]
pub async fn download_ffmpeg_if_missing(_app: &AppHandle) -> Result<PathBuf, String> {
    Err("Automatic FFmpeg download is only supported on Windows".into())
}

fn extract_ffmpeg_exe_from_file(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let file = File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Invalid FFmpeg zip: {e}"))?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().replace('\\', "/");
        if name.ends_with("/bin/ffmpeg.exe") || name.ends_with("bin/ffmpeg.exe") {
            let tmp = dest.with_extension("tmp.exe");
            let mut out = File::create(&tmp).map_err(|e| e.to_string())?;
            copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
            drop(out);
            if dest.exists() {
                let _ = fs::remove_file(dest);
            }
            fs::rename(&tmp, dest).map_err(|e| e.to_string())?;
            return Ok(());
        }
    }
    Err("ffmpeg.exe not found inside downloaded archive".into())
}

fn verify_ffmpeg_binary(path: &Path) -> Result<(), String> {
    let output = hidden_command(path)
        .args(["-version"])
        .output()
        .map_err(|e| format!("Downloaded FFmpeg failed verification: {e}"))?;
    if !output.status.success() {
        let _ = fs::remove_file(path);
        return Err("Downloaded FFmpeg binary failed -version check".into());
    }
    Ok(())
}

pub async fn ensure_ffmpeg(app: AppHandle) -> Result<String, String> {
    let path = download_ffmpeg_if_missing(&app).await?;
    Ok(path.to_string_lossy().to_string())
}

pub fn ffmpeg_status(app: &AppHandle) -> (bool, Option<String>) {
    match resolve_ffmpeg_path(app) {
        Some(p) => (true, Some(p.to_string_lossy().to_string())),
        None => (false, None),
    }
}