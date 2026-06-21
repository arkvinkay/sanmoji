use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackStyle {
    pub font: String,
    pub size: u32,
    pub color: String,      // hex: "#FFFFFF"
    pub pos_y_percent: f32, // 0.0–1.0, relative to video height
    pub bold: bool,
    pub outline_color: String,
    pub outline_size: f32,
    pub shadow: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnimationDefaults {
    pub anim_in: String,        // "fade" | "typewriter" | "slide_up" | "scale_pop" | "glow" | "bounce" | "none"
    pub anim_out: String,
    pub duration_in_ms: u32,
    pub duration_out_ms: u32,
    pub delay_ms: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatermarkSettings {
    pub enabled: bool,
    pub file_path: String,
    pub width: u32,
    pub height: u32,
    pub margin_x: u32,
    pub margin_y: u32,
    /// "none" | "fade" | "glitch"
    #[serde(default = "default_wm_anim_in")]
    pub anim_in: String,
    #[serde(default = "default_wm_anim_out")]
    pub anim_out: String,
    #[serde(default = "default_wm_dur_in")]
    pub duration_in_ms: u32,
    #[serde(default = "default_wm_dur_out")]
    pub duration_out_ms: u32,
    #[serde(default)]
    pub text: String,
    #[serde(default = "default_wm_text_size")]
    pub text_size: u32,
    #[serde(default = "default_wm_text_color")]
    pub text_color: String,
    #[serde(default = "default_wm_text_gap")]
    pub text_gap: u32,
    /// below | above | beside
    #[serde(default = "default_wm_text_position")]
    pub text_position: String,
    #[serde(default = "default_wm_font")]
    pub text_font: String,
    #[serde(default)]
    pub text_bold: bool,
    #[serde(default = "default_wm_outline_color")]
    pub text_outline_color: String,
    #[serde(default = "default_wm_outline_size")]
    pub text_outline_size: f32,
    #[serde(default = "default_wm_text_shadow")]
    pub text_shadow: bool,
}

fn default_wm_anim_in() -> String {
    "glitch".into()
}

fn default_wm_anim_out() -> String {
    "glitch".into()
}

fn default_wm_dur_in() -> u32 {
    400
}

fn default_wm_dur_out() -> u32 {
    400
}

fn default_wm_text_size() -> u32 {
    14
}

fn default_wm_text_color() -> String {
    "#FFFFFF".into()
}

fn default_wm_text_gap() -> u32 {
    4
}

fn default_wm_text_position() -> String {
    "below".into()
}

fn default_wm_font() -> String {
    "Arial".into()
}

fn default_wm_outline_color() -> String {
    "#000000".into()
}

fn default_wm_outline_size() -> f32 {
    1.0
}

fn default_wm_text_shadow() -> bool {
    true
}

impl WatermarkSettings {
    pub fn validate_and_sanitize(&mut self) {
        let anim_in = self.anim_in.trim().to_lowercase();
        self.anim_in = if ["none", "fade", "glitch"].contains(&anim_in.as_str()) {
            anim_in
        } else {
            default_wm_anim_in()
        };
        let anim_out = self.anim_out.trim().to_lowercase();
        self.anim_out = if ["none", "fade", "glitch"].contains(&anim_out.as_str()) {
            anim_out
        } else {
            default_wm_anim_out()
        };
        self.duration_in_ms = self.duration_in_ms.clamp(0, 5000);
        self.duration_out_ms = self.duration_out_ms.clamp(0, 5000);
        if self.text_size == 0 {
            self.text_size = default_wm_text_size();
        }
        self.text_size = self.text_size.clamp(8, 72);
        self.text_color = normalize_hex_color(&self.text_color, "#FFFFFF");
        self.text_gap = self.text_gap.min(40);
        let pos = self.text_position.trim().to_lowercase();
        self.text_position = if ["below", "above", "beside"].contains(&pos.as_str()) {
            pos
        } else {
            default_wm_text_position()
        };
        if self.text_font.trim().is_empty() {
            self.text_font = default_wm_font();
        }
        self.text_outline_color =
            normalize_hex_color(&self.text_outline_color, "#000000");
        self.text_outline_size = self.text_outline_size.clamp(0.0, 20.0);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportSettings {
    pub crf: u32,
    pub preset: String,
    pub output_dir: String,
    /// libx264 | h264_nvenc | h264_qsv
    #[serde(default = "default_encoder")]
    pub encoder: String,
}

fn default_encoder() -> String {
    "libx264".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StylePreset {
    pub name: String,
    pub romaji: TrackStyle,
    pub indo: TrackStyle,
    pub english: TrackStyle,
    pub romaji_anim: AnimationDefaults,
    pub indo_anim: AnimationDefaults,
    pub english_anim: AnimationDefaults,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub romaji: TrackStyle,
    pub indo: TrackStyle,
    pub english: TrackStyle,
    pub romaji_anim: AnimationDefaults,
    pub indo_anim: AnimationDefaults,
    pub english_anim: AnimationDefaults,
    pub watermark: WatermarkSettings,
    pub export: ExportSettings,
    #[serde(default)]
    pub snap_to_second: bool,
    #[serde(default)]
    pub recent_projects: Vec<String>,
    #[serde(default)]
    pub recent_videos: Vec<String>,
    #[serde(default)]
    pub style_presets: Vec<StylePreset>,
    #[serde(default = "default_true")]
    pub autosave_enabled: bool,
    /// Keyboard shortcut bindings (action id → binding string, e.g. "Ctrl+KeyZ")
    #[serde(default)]
    pub shortcuts: HashMap<String, String>,
    /// UI theme id — see themes.js
    #[serde(default = "default_theme")]
    pub theme: String,
}

fn default_theme() -> String {
    "dark".into()
}

const VALID_THEMES: &[&str] = &[
    "dark", "light", "midnight", "warm", "forest", "ocean", "rose", "sakura", "slate", "neon",
];

fn default_true() -> bool {
    true
}

const FFMPEG_PRESETS: &[&str] = &[
    "ultrafast",
    "superfast",
    "veryfast",
    "faster",
    "fast",
    "medium",
    "slow",
    "slower",
    "veryslow",
];

fn is_valid_hex_color(color: &str) -> bool {
    let hex = color.trim_start_matches('#');
    hex.len() == 6 && hex.chars().all(|c| c.is_ascii_hexdigit())
}

fn normalize_hex_color(color: &str, fallback: &str) -> String {
    let trimmed = color.trim();
    if is_valid_hex_color(trimmed) {
        if trimmed.starts_with('#') {
            trimmed.to_string()
        } else {
            format!("#{trimmed}")
        }
    } else {
        fallback.to_string()
    }
}

impl TrackStyle {
    pub fn validate_and_sanitize(&mut self) {
        if !self.pos_y_percent.is_finite() {
            self.pos_y_percent = 0.5;
        }
        self.pos_y_percent = self.pos_y_percent.clamp(0.0, 1.0);
        if !self.outline_size.is_finite() || self.outline_size < 0.0 {
            self.outline_size = 0.0;
        }
        self.color = normalize_hex_color(&self.color, "#FFFFFF");
        self.outline_color = normalize_hex_color(&self.outline_color, "#000000");
        if self.font.trim().is_empty() {
            self.font = "Arial".into();
        }
        if self.size == 0 {
            self.size = 24;
        }
    }
}

fn crf_max_for_encoder(encoder: &str) -> u32 {
    let enc = encoder.trim().to_lowercase();
    if enc == "libvpx-vp9" || enc == "vp9" {
        63
    } else {
        51
    }
}

impl ExportSettings {
    pub fn validate_and_sanitize(&mut self) -> Result<(), String> {
        let preset = self.preset.trim().to_lowercase();
        if !FFMPEG_PRESETS.contains(&preset.as_str()) {
            return Err(format!(
                "Invalid FFmpeg preset \"{}\". Choose one of: {}",
                self.preset,
                FFMPEG_PRESETS.join(", ")
            ));
        }
        self.preset = preset;
        let crf_max = crf_max_for_encoder(&self.encoder);
        self.crf = self.crf.clamp(0, crf_max);
        Ok(())
    }
}

impl AppSettings {
    pub fn validate_and_sanitize(&mut self) -> Result<(), String> {
        self.romaji.validate_and_sanitize();
        self.indo.validate_and_sanitize();
        self.english.validate_and_sanitize();
        self.watermark.validate_and_sanitize();
        self.export.validate_and_sanitize()?;
        let theme = self.theme.trim().to_lowercase();
        self.theme = if VALID_THEMES.contains(&theme.as_str()) {
            theme
        } else {
            default_theme()
        };
        for preset in &mut self.style_presets {
            preset.romaji.validate_and_sanitize();
            preset.indo.validate_and_sanitize();
            preset.english.validate_and_sanitize();
        }
        Ok(())
    }
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            romaji: TrackStyle {
                font: "Arial".into(),
                size: 52,
                color: "#FFFFFF".into(),
                pos_y_percent: 0.82,
                bold: false,
                outline_color: "#000000".into(),
                outline_size: 2.0,
                shadow: true,
            },
            indo: TrackStyle {
                font: "Arial".into(),
                size: 40,
                color: "#FFD700".into(),
                pos_y_percent: 0.88,
                bold: false,
                outline_color: "#000000".into(),
                outline_size: 2.0,
                shadow: true,
            },
            english: TrackStyle {
                font: "Arial".into(),
                size: 36,
                color: "#AADDFF".into(),
                pos_y_percent: 0.93,
                bold: false,
                outline_color: "#000000".into(),
                outline_size: 1.5,
                shadow: false,
            },
            romaji_anim: AnimationDefaults {
                anim_in: "typewriter".into(),
                anim_out: "fade".into(),
                duration_in_ms: 400,
                duration_out_ms: 200,
                delay_ms: 0,
            },
            indo_anim: AnimationDefaults {
                anim_in: "slide_up".into(),
                anim_out: "fade".into(),
                duration_in_ms: 300,
                duration_out_ms: 200,
                delay_ms: 80,
            },
            english_anim: AnimationDefaults {
                anim_in: "fade".into(),
                anim_out: "fade".into(),
                duration_in_ms: 300,
                duration_out_ms: 200,
                delay_ms: 160,
            },
            watermark: WatermarkSettings {
                enabled: false,
                file_path: String::new(),
                width: 100,
                height: 100,
                margin_x: 20,
                margin_y: 20,
                anim_in: default_wm_anim_in(),
                anim_out: default_wm_anim_out(),
                duration_in_ms: default_wm_dur_in(),
                duration_out_ms: default_wm_dur_out(),
                text: String::new(),
                text_size: default_wm_text_size(),
                text_color: default_wm_text_color(),
                text_gap: default_wm_text_gap(),
                text_position: default_wm_text_position(),
                text_font: default_wm_font(),
                text_bold: false,
                text_outline_color: default_wm_outline_color(),
                text_outline_size: default_wm_outline_size(),
                text_shadow: default_wm_text_shadow(),
            },
            export: ExportSettings {
                crf: 18,
                preset: "slow".into(),
                output_dir: String::new(),
                encoder: default_encoder(),
            },
            snap_to_second: false,
            recent_projects: Vec::new(),
            recent_videos: Vec::new(),
            style_presets: Vec::new(),
            autosave_enabled: true,
            shortcuts: HashMap::new(),
            theme: default_theme(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamps_pos_y_percent() {
        let mut style = TrackStyle {
            font: "Arial".into(),
            size: 40,
            color: "#FFFFFF".into(),
            pos_y_percent: 1.5,
            bold: false,
            outline_color: "#000000".into(),
            outline_size: 2.0,
            shadow: true,
        };
        style.validate_and_sanitize();
        assert_eq!(style.pos_y_percent, 1.0);
    }

    #[test]
    fn rejects_invalid_preset() {
        let mut settings = AppSettings::default();
        settings.export.preset = "turbo".into();
        assert!(settings.validate_and_sanitize().is_err());
    }

    #[test]
    fn normalizes_invalid_hex() {
        let mut style = TrackStyle {
            font: "Arial".into(),
            size: 40,
            color: "not-a-color".into(),
            pos_y_percent: 0.5,
            bold: false,
            outline_color: "#000000".into(),
            outline_size: -1.0,
            shadow: true,
        };
        style.validate_and_sanitize();
        assert_eq!(style.color, "#FFFFFF");
        assert_eq!(style.outline_size, 0.0);
    }
}