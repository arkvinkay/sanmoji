use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnimOverride {
    pub anim_in: Option<String>,
    pub anim_out: Option<String>,
    pub duration_in_ms: Option<u32>,
    pub duration_out_ms: Option<u32>,
    pub delay_ms: Option<u32>,
    /// Raw ASS override tags for power users, e.g. `{\fad(500,200)\blur3}`
    pub raw_ass_in: Option<String>,
    pub raw_ass_out: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LyricRow {
    pub id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub romaji: String,
    pub indo: String,
    pub english: String,
    /// If None, use global settings defaults
    pub romaji_anim: Option<AnimOverride>,
    pub indo_anim: Option<AnimOverride>,
    pub english_anim: Option<AnimOverride>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub version: u32,
    pub video_path: String,
    #[serde(default)]
    pub video_w: u32,
    #[serde(default)]
    pub video_h: u32,
    pub rows: Vec<LyricRow>,
}

/// Reject project files with unsupported version numbers.
pub fn validate_project_version(version: u32) -> Result<(), String> {
    if version == 0 {
        return Err(
            "This project file has no version number and cannot be opened.".into(),
        );
    }
    if version > 1 {
        return Err(format!(
            "This project was saved with a newer version (v{version}). \
             Please update Sanmoji to open it."
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_version_one() {
        assert!(validate_project_version(1).is_ok());
    }

    #[test]
    fn rejects_version_zero() {
        assert!(validate_project_version(0).is_err());
    }

    #[test]
    fn rejects_future_version() {
        assert!(validate_project_version(2).is_err());
    }
}