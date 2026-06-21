use crate::project::LyricRow;
use std::fs;

fn strip_bom(s: &str) -> &str {
    s.trim_start_matches('\u{feff}')
}

fn normalize_subtitle_text(raw: &str) -> String {
    raw.replace("\r\n", "\n").replace('\r', "\n")
}

fn read_subtitle_file(path: &str) -> Result<String, String> {
    let raw = fs::read_to_string(path).map_err(|e| format!("Could not read subtitle file: {e}"))?;
    Ok(normalize_subtitle_text(strip_bom(&raw)).to_string())
}

/// Parse ASS/SRT fractional seconds into milliseconds.
/// ASS uses centiseconds (2 digits), but a single digit is treated as tenths of a second.
fn fraction_to_ms(frac: &str) -> u64 {
    match frac.len() {
        0 => 0,
        1 => frac.parse::<u64>().unwrap_or(0) * 100,
        2 => frac.parse::<u64>().unwrap_or(0) * 10,
        _ => frac[..3.min(frac.len())].parse::<u64>().unwrap_or(0),
    }
}

fn ass_time_to_ms(s: &str) -> u64 {
    let s = s.trim();
    let (hms, frac) = s.split_once('.').unwrap_or((s, "0"));
    let parts: Vec<&str> = hms.split(':').collect();
    if parts.len() != 3 {
        return 0;
    }
    let h: u64 = parts[0].parse().unwrap_or(0);
    let m: u64 = parts[1].parse().unwrap_or(0);
    let sec: u64 = parts[2].parse().unwrap_or(0);
    let ms = fraction_to_ms(frac);
    h * 3_600_000 + m * 60_000 + sec * 1_000 + ms
}

fn srt_time_to_ms(s: &str) -> u64 {
    let s = s.trim().replace(',', ".");
    let (hms, frac) = s.split_once('.').unwrap_or((&s, "0"));
    let parts: Vec<&str> = hms.split(':').collect();
    if parts.len() != 3 {
        return 0;
    }
    let h: u64 = parts[0].parse().unwrap_or(0);
    let m: u64 = parts[1].parse().unwrap_or(0);
    let sec: u64 = parts[2].parse().unwrap_or(0);
    let ms = fraction_to_ms(frac);
    h * 3_600_000 + m * 60_000 + sec * 1_000 + ms
}

fn vtt_time_to_ms(s: &str) -> u64 {
    srt_time_to_ms(s)
}

fn strip_html_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_tag = false;
    for ch in text.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out
}

fn strip_vtt_header(raw: &str) -> &str {
    let trimmed = strip_bom(raw.trim_start());
    if trimmed.len() >= 6 && trimmed[..6].eq_ignore_ascii_case("WEBVTT") {
        let rest = &trimmed[6..];
        rest.trim_start()
    } else {
        trimmed
    }
}

fn strip_ass_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_tag = false;
    for ch in text.chars() {
        match ch {
            '{' => in_tag = true,
            '}' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out.replace("\\N", "\n")
}

fn new_row(start_ms: u64, end_ms: u64, lines: Vec<String>) -> LyricRow {
    LyricRow {
        id: uuid::Uuid::new_v4().to_string(),
        start_ms,
        end_ms,
        romaji: lines.first().cloned().unwrap_or_default(),
        indo: lines.get(1).cloned().unwrap_or_default(),
        english: lines.get(2).cloned().unwrap_or_default(),
        romaji_anim: None,
        indo_anim: None,
        english_anim: None,
    }
}

pub fn import_srt(path: &str) -> Result<Vec<LyricRow>, String> {
    let raw = read_subtitle_file(path)?;
    let mut rows = Vec::new();
    let blocks: Vec<&str> = raw.split("\n\n").collect();

    for block in blocks {
        let lines: Vec<&str> = block.lines().filter(|l| !l.trim().is_empty()).collect();
        if lines.is_empty() {
            continue;
        }
        let Some(time_line_idx) = lines.iter().position(|l| l.contains("-->")) else {
            continue;
        };
        let time_line = lines[time_line_idx];
        let text_start = time_line_idx + 1;
        if text_start > lines.len() {
            continue;
        }

        let Some((start, end)) = time_line.split_once("-->") else {
            continue;
        };
        let start_ms = srt_time_to_ms(start);
        let end_ms = srt_time_to_ms(end);
        let texts: Vec<String> = lines[text_start..]
            .iter()
            .map(|l| {
                strip_html_tags(
                    &l.trim()
                        .replace("<br>", "\n")
                        .replace("<br/>", "\n")
                        .replace("<br />", "\n")
                        .replace("\\N", "\n"),
                )
            })
            .collect();
        rows.push(new_row(start_ms, end_ms, texts));
    }

    if rows.is_empty() {
        return Err("No subtitle entries found in SRT file".into());
    }
    rows.sort_by_key(|r| r.start_ms);
    Ok(rows)
}

pub fn import_ass(path: &str) -> Result<Vec<LyricRow>, String> {
    let raw = read_subtitle_file(path)?;
    // Dialogue lines sharing the exact same start/end are grouped into one row
    // (romaji / indo / english tracks). Unrelated lines with identical timing merge.
    let mut groups: std::collections::BTreeMap<(u64, u64), Vec<String>> =
        std::collections::BTreeMap::new();

    for line in raw.lines() {
        let line = line.trim();
        if !line.starts_with("Dialogue:") {
            continue;
        }
        let parts: Vec<&str> = line.splitn(10, ',').collect();
        if parts.len() < 10 {
            continue;
        }
        let start_ms = ass_time_to_ms(parts[1]);
        let end_ms = ass_time_to_ms(parts[2]);
        let text = strip_ass_tags(parts[9]);
        groups
            .entry((start_ms, end_ms))
            .or_default()
            .push(text);
    }

    let rows: Vec<LyricRow> = groups
        .into_iter()
        .map(|((start_ms, end_ms), texts)| new_row(start_ms, end_ms, texts))
        .collect();

    if rows.is_empty() {
        return Err("No Dialogue lines found in ASS file".into());
    }
    Ok(rows)
}

pub fn import_vtt(path: &str) -> Result<Vec<LyricRow>, String> {
    let raw = read_subtitle_file(path)?;
    let body = strip_vtt_header(&raw);

    let mut rows = Vec::new();
    for block in body.split("\n\n") {
        let lines: Vec<&str> = block.lines().filter(|l| !l.trim().is_empty()).collect();
        let time_line = lines.iter().find(|l| l.contains("-->"));
        let Some(time_line) = time_line else { continue };
        let Some((start, end)) = time_line.split_once("-->") else {
            continue;
        };
        let start_ms = vtt_time_to_ms(start.trim());
        let end_ms = vtt_time_to_ms(end.split_whitespace().next().unwrap_or("").trim());
        let texts: Vec<String> = lines
            .iter()
            .skip_while(|l| !l.contains("-->"))
            .skip(1)
            .map(|l| l.trim().to_string())
            .collect();
        if texts.is_empty() && start_ms == 0 && end_ms == 0 {
            continue;
        }
        rows.push(new_row(start_ms, end_ms.max(start_ms + 1), texts));
    }

    if rows.is_empty() {
        return Err("No cues found in VTT file".into());
    }
    rows.sort_by_key(|r| r.start_ms);
    Ok(rows)
}

pub fn import_subtitle(path: &str) -> Result<Vec<LyricRow>, String> {
    let lower = path.to_lowercase();
    if lower.ends_with(".srt") {
        import_srt(path)
    } else if lower.ends_with(".ass") || lower.ends_with(".ssa") {
        import_ass(path)
    } else if lower.ends_with(".vtt") {
        import_vtt(path)
    } else {
        Err("Unsupported subtitle format. Use .srt, .ass, or .vtt".into())
    }
}

fn ms_to_srt(ms: u64) -> String {
    let h = ms / 3_600_000;
    let m = (ms % 3_600_000) / 60_000;
    let s = (ms % 60_000) / 1_000;
    let ms3 = ms % 1_000;
    format!("{h:02}:{m:02}:{s:02},{ms3:03}")
}

fn ms_to_vtt(ms: u64) -> String {
    let h = ms / 3_600_000;
    let m = (ms % 3_600_000) / 60_000;
    let s = (ms % 60_000) / 1_000;
    let ms3 = ms % 1_000;
    format!("{h:02}:{m:02}:{s:02}.{ms3:03}")
}

fn row_text(row: &LyricRow) -> Option<String> {
    let text = [row.romaji.as_str(), row.indo.as_str(), row.english.as_str()]
        .iter()
        .filter(|t| !t.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join("\n");
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

pub fn export_vtt(rows: &[LyricRow]) -> String {
    let mut out = String::from("WEBVTT\n\n");
    for row in rows {
        let Some(text) = row_text(row) else { continue };
        out.push_str(&format!(
            "{} --> {}\n{}\n\n",
            ms_to_vtt(row.start_ms),
            ms_to_vtt(row.end_ms),
            text
        ));
    }
    out
}

pub fn export_srt(rows: &[LyricRow]) -> String {
    let mut out = String::new();
    let mut seq = 0u32;
    for row in rows {
        let Some(text) = row_text(row) else { continue };
        seq += 1;
        out.push_str(&format!(
            "{seq}\n{} --> {}\n{}\n\n",
            ms_to_srt(row.start_ms),
            ms_to_srt(row.end_ms),
            text
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn srt_roundtrip_basic() {
        let rows = vec![LyricRow {
            id: uuid::Uuid::new_v4().to_string(),
            start_ms: 1000,
            end_ms: 2000,
            romaji: "hello".into(),
            indo: "halo".into(),
            english: String::new(),
            romaji_anim: None,
            indo_anim: None,
            english_anim: None,
        }];
        let srt = export_srt(&rows);
        assert!(srt.contains("hello"));
        assert!(srt.contains("halo"));
        assert!(srt.starts_with("1\n"));
    }

    #[test]
    fn export_srt_skips_empty_without_gaps() {
        let rows = vec![
            LyricRow {
                id: "1".into(),
                start_ms: 0,
                end_ms: 1000,
                romaji: "a".into(),
                indo: "".into(),
                english: "".into(),
                romaji_anim: None,
                indo_anim: None,
                english_anim: None,
            },
            LyricRow {
                id: "2".into(),
                start_ms: 1000,
                end_ms: 2000,
                romaji: "".into(),
                indo: "".into(),
                english: "".into(),
                romaji_anim: None,
                indo_anim: None,
                english_anim: None,
            },
            LyricRow {
                id: "3".into(),
                start_ms: 2000,
                end_ms: 3000,
                romaji: "b".into(),
                indo: "".into(),
                english: "".into(),
                romaji_anim: None,
                indo_anim: None,
                english_anim: None,
            },
        ];
        let srt = export_srt(&rows);
        assert!(srt.contains("1\n"));
        assert!(srt.contains("2\n"));
        assert!(!srt.contains("3\n\n"));
    }

    #[test]
    fn strip_ass_tags_removes_override_blocks() {
        let raw = r"{\an8\pos(960,540)\fad(0,200)}Hello";
        assert_eq!(strip_ass_tags(raw), "Hello");
    }

    #[test]
    fn srt_ms_two_digit_fraction() {
        assert_eq!(srt_time_to_ms("00:00:01,12"), 1120);
    }

    #[test]
    fn ass_single_digit_fraction_is_tenths_of_second() {
        assert_eq!(ass_time_to_ms("0:00:01.5"), 1500);
    }

    #[test]
    fn ass_two_digit_fraction_is_centiseconds() {
        assert_eq!(ass_time_to_ms("0:00:01.50"), 1500);
    }

    #[test]
    fn row_text_joins_non_empty_tracks() {
        let row = LyricRow {
            id: "1".into(),
            start_ms: 0,
            end_ms: 1000,
            romaji: "a".into(),
            indo: "b".into(),
            english: "".into(),
            romaji_anim: None,
            indo_anim: None,
            english_anim: None,
        };
        assert_eq!(row_text(&row), Some("a\nb".into()));
    }
}