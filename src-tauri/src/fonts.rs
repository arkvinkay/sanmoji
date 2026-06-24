use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static SYSTEM_FONTS: OnceLock<Vec<FontInfo>> = OnceLock::new();

#[derive(Debug, Clone, Serialize)]
pub struct FontInfo {
    pub family: String,
    pub path: String,
}

fn parse_registry_line(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    if !trimmed.contains("REG_SZ") || trimmed.starts_with("HKEY_") {
        return None;
    }
    let (left, right) = trimmed.split_once("REG_SZ")?;
    let family = left
        .trim()
        .trim_end_matches(" (TrueType)")
        .trim_end_matches(" (OpenType)")
        .trim_end_matches(" (All res)")
        .trim()
        .to_string();
    let file = right.trim().to_string();
    if family.is_empty() || file.is_empty() {
        return None;
    }
    Some((family, file))
}

fn windows_fonts_dir() -> PathBuf {
    std::env::var("WINDIR")
        .map(|w| PathBuf::from(w).join("Fonts"))
        .unwrap_or_else(|_| PathBuf::from(r"C:\Windows\Fonts"))
}

fn user_fonts_dir() -> Option<PathBuf> {
    std::env::var("LOCALAPPDATA")
        .ok()
        .map(|p| PathBuf::from(p).join(r"Microsoft\Windows\Fonts"))
}

fn resolve_font_path(filename: &str) -> PathBuf {
    if let Some(user) = user_fonts_dir() {
        let p = user.join(filename);
        if p.exists() {
            return p;
        }
    }
    let sys = windows_fonts_dir().join(filename);
    if sys.exists() {
        return sys;
    }
    PathBuf::from(filename)
}

fn read_registry_fonts(key: &str, out: &mut HashMap<String, FontInfo>) {
    let Ok(output) = crate::process_util::hidden_command("reg")
        .args(["query", key])
        .output()
    else {
        return;
    };
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        let Some((family, file)) = parse_registry_line(line) else {
            continue;
        };
        let path = resolve_font_path(&file);
        if !path.exists() {
            continue;
        }
        let key_lower = family.to_lowercase();
        out.entry(key_lower).or_insert(FontInfo {
            family,
            path: path.to_string_lossy().to_string(),
        });
    }
}

fn family_from_font_file(path: &Path) -> Option<String> {
    let data = std::fs::read(path).ok()?;
    let face = ttf_parser::Face::parse(&data, 0).ok()?;
    face.names()
        .into_iter()
        .find(|n| n.name_id == ttf_parser::name_id::FAMILY && n.is_unicode())
        .and_then(|n| n.to_string())
        .or_else(|| {
            path.file_stem()
                .and_then(|s| s.to_str())
                .map(|s| s.to_string())
        })
}

fn scan_font_dir(dir: &Path, out: &mut HashMap<String, FontInfo>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        if !matches!(ext.as_str(), "ttf" | "otf" | "ttc" | "woff" | "woff2") {
            continue;
        }
        let family = family_from_font_file(&path).unwrap_or_else(|| {
            path.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("Unknown")
                .to_string()
        });
        let key_lower = family.to_lowercase();
        out.entry(key_lower).or_insert(FontInfo {
            family,
            path: path.to_string_lossy().to_string(),
        });
    }
}

fn scan_system_fonts() -> Vec<FontInfo> {
    let mut map: HashMap<String, FontInfo> = HashMap::new();

    #[cfg(windows)]
    {
        read_registry_fonts(
            r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts",
            &mut map,
        );
        read_registry_fonts(
            r"HKCU\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts",
            &mut map,
        );
        scan_font_dir(&windows_fonts_dir(), &mut map);
        if let Some(user) = user_fonts_dir() {
            scan_font_dir(&user, &mut map);
        }
    }

    #[cfg(not(windows))]
    {
        if let Ok(output) = crate::process_util::hidden_command("fc-list")
            .args(["--format=%{family}\n"])
            .output()
        {
            let text = String::from_utf8_lossy(&output.stdout);
            for line in text.lines() {
                let family = line.split(',').next().unwrap_or(line).trim().to_string();
                if family.is_empty() {
                    continue;
                }
                map.entry(family.to_lowercase()).or_insert(FontInfo {
                    family,
                    path: String::new(),
                });
            }
        }
    }

    let mut fonts: Vec<FontInfo> = map.into_values().collect();
    fonts.sort_by_key(|a| a.family.to_lowercase());
    fonts
}

pub fn collect_system_fonts() -> Vec<FontInfo> {
    SYSTEM_FONTS.get_or_init(scan_system_fonts).clone()
}

pub fn resolve_font_path_by_family(family: &str) -> Option<String> {
    let target = family.trim().to_lowercase();
    if target.is_empty() {
        return None;
    }
    collect_system_fonts()
        .into_iter()
        .find(|f| f.family.eq_ignore_ascii_case(family) || f.family.to_lowercase() == target)
        .map(|f| f.path)
}