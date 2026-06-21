use crate::project::{LyricRow, Project};
use crate::settings::AppSettings;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Debug, Clone, Serialize)]
pub struct ValidationIssue {
    pub severity: Severity,
    pub message: String,
}

pub fn validate_project(project: &Project, settings: &AppSettings) -> Vec<ValidationIssue> {
    let mut issues = Vec::new();

    if project.video_path.is_empty() {
        issues.push(issue(Severity::Error, "No video file linked"));
    } else if !Path::new(&project.video_path).exists() {
        issues.push(issue(
            Severity::Error,
            &format!("Video not found: {}", project.video_path),
        ));
    }

    if project.rows.is_empty() {
        issues.push(issue(Severity::Warning, "No subtitle rows"));
    }

    for (i, row) in project.rows.iter().enumerate() {
        let n = i + 1;
        if row.end_ms < row.start_ms {
            issues.push(issue(
                Severity::Error,
                &format!("Row {n}: end time before start time"),
            ));
        } else if row.end_ms == row.start_ms {
            issues.push(issue(
                Severity::Warning,
                &format!("Row {n}: zero duration (start equals end)"),
            ));
        }
        if row.romaji.is_empty() && row.indo.is_empty() && row.english.is_empty() {
            issues.push(issue(Severity::Warning, &format!("Row {n}: all tracks empty")));
        }
    }

    collect_overlap_issues(&project.rows, &mut issues);

    let fonts = [
        ("Romaji", &settings.romaji.font),
        ("Indo", &settings.indo.font),
        ("English", &settings.english.font),
    ];
    for (label, font) in fonts {
        if font.trim().is_empty() {
            issues.push(issue(Severity::Warning, &format!("{label}: font not set")));
        }
    }

    if settings.watermark.enabled {
        if settings.watermark.file_path.is_empty() {
            issues.push(issue(
                Severity::Error,
                "Watermark enabled but no image selected",
            ));
        } else if !Path::new(&settings.watermark.file_path).exists() {
            issues.push(issue(Severity::Error, "Watermark image file not found"));
        }
    }

    issues
}

const MAX_OVERLAP_WARNINGS: usize = 50;

fn collect_overlap_issues(rows: &[LyricRow], issues: &mut Vec<ValidationIssue>) {
    if rows.len() < 2 {
        return;
    }
    let mut indexed: Vec<(usize, &LyricRow)> = rows.iter().enumerate().collect();
    indexed.sort_by_key(|(_, r)| r.start_ms);

    let mut active: Vec<(usize, u64)> = Vec::new();
    let mut overlap_count = 0usize;
    let mut suppressed = 0usize;
    for (idx, row) in indexed {
        active.retain(|&(_, end)| end > row.start_ms);
        for &(other_idx, _) in &active {
            if overlap_count < MAX_OVERLAP_WARNINGS {
                issues.push(issue(
                    Severity::Warning,
                    &format!("Rows {} and {} overlap in time", other_idx + 1, idx + 1),
                ));
                overlap_count += 1;
            } else {
                suppressed += 1;
            }
        }
        active.push((idx, row.end_ms));
    }
    if suppressed > 0 {
        issues.push(issue(
            Severity::Warning,
            &format!("and {suppressed} more overlaps"),
        ));
    }
}

fn issue(severity: Severity, message: &str) -> ValidationIssue {
    ValidationIssue {
        severity,
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::Project;

    #[test]
    fn detects_invalid_timing() {
        let project = Project {
            version: 1,
            video_path: "x.mp4".into(),
            video_w: 1920,
            video_h: 1080,
            rows: vec![crate::project::LyricRow {
                id: "1".into(),
                start_ms: 5000,
                end_ms: 1000,
                romaji: "a".into(),
                indo: "".into(),
                english: "".into(),
                romaji_anim: None,
                indo_anim: None,
                english_anim: None,
            }],
        };
        let issues = validate_project(&project, &AppSettings::default());
        assert!(issues.iter().any(|i| i.message.contains("end time")));
    }

    #[test]
    fn detects_zero_duration() {
        let project = Project {
            version: 1,
            video_path: "x.mp4".into(),
            video_w: 1920,
            video_h: 1080,
            rows: vec![crate::project::LyricRow {
                id: "1".into(),
                start_ms: 1000,
                end_ms: 1000,
                romaji: "a".into(),
                indo: "".into(),
                english: "".into(),
                romaji_anim: None,
                indo_anim: None,
                english_anim: None,
            }],
        };
        let issues = validate_project(&project, &AppSettings::default());
        assert!(issues.iter().any(|i| i.message.contains("zero duration")));
    }

    #[test]
    fn severity_serializes_lowercase() {
        let issue = issue(Severity::Error, "test");
        let json = serde_json::to_string(&issue).unwrap();
        assert!(json.contains("\"error\""));
    }
}