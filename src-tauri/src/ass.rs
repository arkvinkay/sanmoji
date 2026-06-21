use crate::project::{AnimOverride, LyricRow};
use crate::settings::{AnimationDefaults, AppSettings};
use std::borrow::Cow;

/// Convert milliseconds to ASS timestamp: H:MM:SS.cc
fn ms_to_ass(ms: u64) -> String {
    let h = ms / 3_600_000;
    let m = (ms % 3_600_000) / 60_000;
    let s = (ms % 60_000) / 1_000;
    let cs = (ms % 1_000) / 10;
    format!("{h}:{m:02}:{s:02}.{cs:02}")
}

/// Hex color "#RRGGBB" → ASS BGR "&H00BBGGRR"
fn hex_to_ass(hex: &str) -> String {
    let hex = hex.trim_start_matches('#');
    let valid = hex.len() == 6 && hex.chars().all(|c| c.is_ascii_hexdigit());
    if !valid {
        return "&H00FFFFFF".into();
    }
    let chars: Vec<char> = hex.chars().collect();
    let r: String = chars[0..2].iter().collect();
    let g: String = chars[2..4].iter().collect();
    let b: String = chars[4..6].iter().collect();
    format!("&H00{b}{g}{r}")
}

fn clamp_pos_y(p: f32) -> f32 {
    p.clamp(0.0, 1.0)
}

fn fade_out_ms(anim_out: &str, dur_out: u32) -> u32 {
    if anim_out == "fade" {
        dur_out
    } else {
        0
    }
}

struct ResolvedAnim<'a> {
    anim_in: Cow<'a, str>,
    anim_out: Cow<'a, str>,
    dur_in: u32,
    dur_out: u32,
    delay: u32,
    raw_in: Option<Cow<'a, str>>,
    raw_out: Option<Cow<'a, str>>,
}

fn resolve_anim<'a>(
    global: &'a AnimationDefaults,
    ov: &'a Option<AnimOverride>,
) -> ResolvedAnim<'a> {
    let o = ov.as_ref();
    ResolvedAnim {
        anim_in: o
            .and_then(|o| o.anim_in.as_deref())
            .map(Cow::Borrowed)
            .unwrap_or(Cow::Borrowed(global.anim_in.as_str())),
        anim_out: o
            .and_then(|o| o.anim_out.as_deref())
            .map(Cow::Borrowed)
            .unwrap_or(Cow::Borrowed(global.anim_out.as_str())),
        dur_in: o
            .and_then(|o| o.duration_in_ms)
            .unwrap_or(global.duration_in_ms),
        dur_out: o
            .and_then(|o| o.duration_out_ms)
            .unwrap_or(global.duration_out_ms),
        delay: o.and_then(|o| o.delay_ms).unwrap_or(global.delay_ms),
        raw_in: o
            .and_then(|o| o.raw_ass_in.as_deref())
            .map(Cow::Borrowed),
        raw_out: o
            .and_then(|o| o.raw_ass_out.as_deref())
            .map(Cow::Borrowed),
    }
}

fn build_anim_tag(
    anim_in: &str,
    anim_out: &str,
    dur_in: u32,
    dur_out: u32,
    delay: u32,
    text: &str,
    pos: Option<(u32, u32)>,
    video_w: u32,
) -> String {
    let fout = fade_out_ms(anim_out, dur_out);
    match anim_in {
        "typewriter" => {
            let char_count = text.chars().count().max(1);
            let cs = ((dur_in as f64 / char_count as f64) / 10.0)
                .max(1.0)
                .round() as u32;
            let body: String = text
                .chars()
                .map(|c| format!("{{\\kf{cs}}}{c}"))
                .collect();
            if fout > 0 {
                format!("{{\\fad(0,{fout})}}{body}")
            } else {
                body
            }
        }
        "slide_up" => {
            let (cx, y) = pos.unwrap_or((video_w / 2, 30));
            let y_start = y.saturating_add(30);
            let end = delay + dur_in;
            format!(
                "{{\\an8\\move({cx},{y_start},{cx},{y},{delay},{end})\\fad({dur_in},{fout})}}{text}",
                cx = cx,
                y_start = y_start,
                y = y,
                delay = delay,
                end = end,
                dur_in = dur_in,
                fout = fout,
                text = text
            )
        }
        "scale_pop" => {
            format!(
                "{{\\fscx0\\fscy0\\t({delay},{end},\\fscx100\\fscy100)\\fad(0,{fout})}}{text}",
                delay = delay,
                end = delay + dur_in,
                fout = fout,
                text = text
            )
        }
        "glow" => {
            format!(
                "{{\\blur12\\t({delay},{end},\\blur0)\\fad(0,{fout})}}{text}",
                delay = delay,
                end = delay + dur_in,
                fout = fout,
                text = text
            )
        }
        "bounce" => {
            let mid = delay + dur_in / 2;
            let end = delay + dur_in;
            format!(
                "{{\\t({delay},{mid},\\fscx110\\fscy110)\\t({mid},{end},\\fscx100\\fscy100)\\fad(0,{fout})}}{text}",
                delay = delay,
                mid = mid,
                end = end,
                fout = fout,
                text = text
            )
        }
        "fade" => {
            format!(
                "{{\\fad({dur_in},{fout})}}{text}",
                dur_in = dur_in,
                fout = fout,
                text = text
            )
        }
        _ => {
            if fout > 0 {
                format!("{{\\fad(0,{fout})}}{text}", fout = fout, text = text)
            } else {
                text.to_string()
            }
        }
    }
}

fn build_line_text(
    global: &AnimationDefaults,
    ov: &Option<AnimOverride>,
    text: &str,
    pos: Option<(u32, u32)>,
    video_w: u32,
) -> String {
    let anim = resolve_anim(global, ov);

    if let Some(raw) = anim.raw_in.filter(|s| !s.trim().is_empty()) {
        let prefix = if raw.starts_with('{') {
            raw.into_owned()
        } else {
            format!("{{{}}}", raw.trim())
        };
        let suffix = anim
            .raw_out
            .filter(|s| !s.trim().is_empty())
            .map(|s| {
                if s.starts_with('{') {
                    s.into_owned()
                } else {
                    format!("{{{}}}", s.trim())
                }
            })
            .unwrap_or_default();
        return format!("{prefix}{text}{suffix}");
    }

    if anim.anim_in == "slide_up" {
        return build_anim_tag(
            &anim.anim_in,
            &anim.anim_out,
            anim.dur_in,
            anim.dur_out,
            anim.delay,
            text,
            pos,
            video_w,
        );
    }

    let anim_tag = build_anim_tag(
        &anim.anim_in,
        &anim.anim_out,
        anim.dur_in,
        anim.dur_out,
        anim.delay,
        text,
        None,
        video_w,
    );
    if let Some((cx, y)) = pos {
        format!("{{\\an8\\pos({cx},{y})}}{anim_tag}", cx = cx, y = y, anim_tag = anim_tag)
    } else {
        anim_tag
    }
}

pub fn build_ass(
    rows: &[LyricRow],
    settings: &AppSettings,
    video_w: u32,
    video_h: u32,
) -> String {
    let romaji_y =
        (video_h as f32 * clamp_pos_y(settings.romaji.pos_y_percent)).round() as u32;
    let indo_y = (video_h as f32 * clamp_pos_y(settings.indo.pos_y_percent)).round() as u32;
    let english_y =
        (video_h as f32 * clamp_pos_y(settings.english.pos_y_percent)).round() as u32;

    let mut out = format!(
        r#"[Script Info]
ScriptType: v4.00+
PlayResX: {video_w}
PlayResY: {video_h}
WrapStyle: 0

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Romaji,{rf},{rs},{rc},{ro},&H80000000,{rb},0,0,0,100,100,0,0,1,{rop:.1},{rshadow},8,10,10,10,1
Style: Indo,{indof},{is},{ic},{io},&H80000000,{ib},0,0,0,100,100,0,0,1,{iop:.1},{ishadow},8,10,10,10,1
Style: English,{ef},{es},{ec},{eo},&H80000000,{eb},0,0,0,100,100,0,0,1,{eop:.1},{eshadow},8,10,10,10,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
"#,
        video_w = video_w,
        video_h = video_h,
        rf = settings.romaji.font,
        rs = settings.romaji.size,
        rc = hex_to_ass(&settings.romaji.color),
        ro = hex_to_ass(&settings.romaji.outline_color),
        rb = if settings.romaji.bold { "-1" } else { "0" },
        rop = settings.romaji.outline_size,
        rshadow = if settings.romaji.shadow { "1" } else { "0" },
        indof = settings.indo.font,
        is = settings.indo.size,
        ic = hex_to_ass(&settings.indo.color),
        io = hex_to_ass(&settings.indo.outline_color),
        ib = if settings.indo.bold { "-1" } else { "0" },
        iop = settings.indo.outline_size,
        ishadow = if settings.indo.shadow { "1" } else { "0" },
        ef = settings.english.font,
        es = settings.english.size,
        ec = hex_to_ass(&settings.english.color),
        eo = hex_to_ass(&settings.english.outline_color),
        eb = if settings.english.bold { "-1" } else { "0" },
        eop = settings.english.outline_size,
        eshadow = if settings.english.shadow { "1" } else { "0" },
    );

    for row in rows {
        let start = ms_to_ass(row.start_ms);
        let end = ms_to_ass(row.end_ms);

        let cx = video_w / 2;

        if !row.romaji.is_empty() {
            let text = build_line_text(
                &settings.romaji_anim,
                &row.romaji_anim,
                &row.romaji,
                Some((cx, romaji_y)),
                video_w,
            );
            out.push_str(&format!(
                "Dialogue: 0,{start},{end},Romaji,,0,0,0,,{text}\n",
                text = text
            ));
        }

        if !row.indo.is_empty() {
            let text = build_line_text(
                &settings.indo_anim,
                &row.indo_anim,
                &row.indo,
                Some((cx, indo_y)),
                video_w,
            );
            out.push_str(&format!(
                "Dialogue: 0,{start},{end},Indo,,0,0,0,,{text}\n",
                text = text
            ));
        }

        if !row.english.is_empty() {
            let text = build_line_text(
                &settings.english_anim,
                &row.english_anim,
                &row.english,
                Some((cx, english_y)),
                video_w,
            );
            out.push_str(&format!(
                "Dialogue: 0,{start},{end},English,,0,0,0,,{text}\n",
                text = text
            ));
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::LyricRow;
    use crate::settings::AppSettings;

    fn sample_row() -> LyricRow {
        LyricRow {
            id: "1".into(),
            start_ms: 0,
            end_ms: 2000,
            romaji: "test".into(),
            indo: String::new(),
            english: String::new(),
            romaji_anim: None,
            indo_anim: None,
            english_anim: None,
        }
    }

    #[test]
    fn builds_ass_with_fade_preset() {
        let settings = AppSettings::default();
        let out = build_ass(&[sample_row()], &settings, 1920, 1080);
        assert!(out.contains("Dialogue:"));
        assert!(out.contains("\\fad("));
    }

    #[test]
    fn builds_ass_play_res() {
        let settings = AppSettings::default();
        let out = build_ass(&[], &settings, 1280, 720);
        assert!(out.contains("PlayResX: 1280"));
        assert!(out.contains("PlayResY: 720"));
    }

    #[test]
    fn normalizes_line_endings() {
        let settings = AppSettings::default();
        let out = build_ass(&[sample_row()], &settings, 1920, 1080);
        assert!(!out.contains('\r'));
    }
}