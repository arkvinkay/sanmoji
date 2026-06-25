use crate::ass::build_ass;
use crate::ffprobe::probe_video;
use crate::project::{validate_project_version, Project};
use crate::validation::{validate_project, ValidationIssue};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use tauri::AppHandle;
use tauri::Manager;

use super::common::{
    build_watermark_filter, emit_progress, escape_ffmpeg_path, friendly_io_err, friendly_json_err,
    local_ffmpeg, lock_or_recover, resolve_export_codecs, resolve_video_path, run_ffmpeg_command,
    validate_user_path,
};
use super::get_settings;
use super::FfmpegRuntime;

#[tauri::command]
pub fn validate_export(app: AppHandle, project: Project) -> Vec<ValidationIssue> {
    let settings = get_settings(app).settings;
    validate_project(&project, &settings)
}

#[tauri::command]
pub fn cancel_export(app: AppHandle) -> Result<(), String> {
    let rt = app
        .try_state::<FfmpegRuntime>()
        .ok_or("Export system is not available. Please restart the app.")?;
    let mut slot: std::sync::MutexGuard<'_, Option<tauri_plugin_shell::process::CommandChild>> =
        lock_or_recover(&rt.child, "FFmpeg runtime");
    if let Some(child) = slot.take() {
        child
            .kill()
            .map_err(|e| format!("Could not cancel export: {e}"))?;
    }
    Ok(())
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    pub segment_start_ms: Option<u64>,
    pub segment_end_ms: Option<u64>,
    pub video_duration_ms: Option<u64>,
}

#[tauri::command]
pub async fn cut_video(
    app: AppHandle,
    input_path: String,
    output_path: String,
    start_ms: u64,
    end_ms: u64,
) -> Result<(), String> {
    validate_user_path(&input_path, true, false)?;
    validate_user_path(&output_path, false, true)?;
    if end_ms <= start_ms {
        return Err("Cut end time must be after the start time.".into());
    }
    let duration_ms = end_ms - start_ms;
    let args = vec![
        "-ss".into(),
        format!("{:.3}", start_ms as f64 / 1000.0),
        "-i".into(),
        input_path,
        "-t".into(),
        format!("{:.3}", duration_ms as f64 / 1000.0),
        "-c".into(),
        "copy".into(),
        "-avoid_negative_ts".into(),
        "make_zero".into(),
        output_path,
    ];
    run_ffmpeg_command(&app, args, duration_ms, &[], true).await
}

async fn run_ffmpeg_export(
    app: &AppHandle,
    project: &Project,
    output_path: &str,
    video_w: u32,
    video_h: u32,
    options: ExportOptions,
    track_child: bool,
) -> Result<(), String> {
    validate_user_path(output_path, false, true)?;
    let settings = get_settings(app.clone()).settings;
    let segment_duration_ms = options
        .segment_end_ms
        .zip(options.segment_start_ms)
        .map(|(e, s)| e.saturating_sub(s))
        .filter(|d| *d > 0);

    let full_duration_ms = if segment_duration_ms.is_none() {
        if let Ok(ffmpeg) = local_ffmpeg(app) {
            probe_video(&ffmpeg, &project.video_path)
                .ok()
                .map(|i| i.duration_ms)
                .filter(|d| *d > 0)
        } else {
            None
        }
    } else {
        None
    };

    let duration_ms = segment_duration_ms
        .or(full_duration_ms)
        .or(options.video_duration_ms.filter(|&d| d > 0))
        .or_else(|| {
            project
                .rows
                .iter()
                .map(|r| r.end_ms)
                .max()
                .filter(|&ms| ms > 0)
        });

    let tmp_dir = std::env::temp_dir();
    let ass_path = tmp_dir.join(format!("sanmoji_sub_{}.ass", uuid::Uuid::new_v4()));
    let ass_content = build_ass(&project.rows, &settings, video_w, video_h);
    fs::write(&ass_path, &ass_content)
        .map_err(|e| friendly_io_err("write temporary subtitles", &ass_path, e))?;

    let ass_escaped = escape_ffmpeg_path(&ass_path);
    let wm = &settings.watermark;
    if wm.enabled && !wm.file_path.is_empty() {
        validate_user_path(&wm.file_path, true, false)?;
    }
    let codecs = resolve_export_codecs(output_path, &settings.export);

    let mut args: Vec<String> = Vec::new();
    if let Some(start) = options.segment_start_ms {
        args.push("-ss".into());
        args.push(format!("{:.3}", start as f64 / 1000.0));
    }
    args.push("-i".into());
    args.push(project.video_path.clone());

    let filter = if wm.enabled && !wm.file_path.is_empty() {
        args.push("-i".into());
        args.push(wm.file_path.clone());
        build_watermark_filter(wm, &ass_escaped, duration_ms)
    } else {
        format!("[0:v]ass=filename='{ass}'[out]", ass = ass_escaped)
    };

    if let Some(dur) = segment_duration_ms {
        args.push("-t".into());
        args.push(format!("{:.3}", dur as f64 / 1000.0));
    }

    args.push("-filter_complex".into());
    args.push(filter);
    args.push("-map".into());
    args.push("[out]".into());
    args.push("-map".into());
    args.push("0:a?".into());
    args.push("-c:v".into());
    args.push(codecs.video_encoder);
    args.extend(codecs.extra_args);
    args.push("-c:a".into());
    args.push(codecs.audio_encoder);
    args.push(output_path.to_string());

    let total_ms = duration_ms.unwrap_or(0);
    run_ffmpeg_command(app, args, total_ms, &[ass_path], track_child).await
}

#[tauri::command]
pub async fn export_video(
    app: AppHandle,
    project: Project,
    output_path: String,
    video_w: u32,
    video_h: u32,
    options: Option<ExportOptions>,
) -> Result<(), String> {
    run_ffmpeg_export(
        &app,
        &project,
        &output_path,
        video_w,
        video_h,
        options.unwrap_or_default(),
        true,
    )
    .await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchExportItem {
    pub project_path: String,
    pub output_path: String,
    pub video_w: u32,
    pub video_h: u32,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct BatchExportResult {
    pub project_path: String,
    pub output_path: String,
    pub success: bool,
    pub error: Option<String>,
}

async fn process_batch_item(app: AppHandle, item: BatchExportItem) -> BatchExportResult {
    if let Err(e) = validate_user_path(&item.project_path, true, false) {
        return BatchExportResult {
            project_path: item.project_path.clone(),
            output_path: item.output_path.clone(),
            success: false,
            error: Some(e),
        };
    }
    if let Err(e) = validate_user_path(&item.output_path, false, true) {
        return BatchExportResult {
            project_path: item.project_path.clone(),
            output_path: item.output_path.clone(),
            success: false,
            error: Some(e),
        };
    }

    let load_result = fs::read_to_string(&item.project_path)
        .map_err(|e| friendly_io_err("open project", Path::new(&item.project_path), e))
        .and_then(|raw| {
            serde_json::from_str::<Project>(&raw).map_err(|e| friendly_json_err("project file", e))
        });

    match load_result {
        Ok(mut project) => {
            if let Err(e) = validate_project_version(project.version) {
                return BatchExportResult {
                    project_path: item.project_path.clone(),
                    output_path: item.output_path.clone(),
                    success: false,
                    error: Some(e),
                };
            }
            let resolved = resolve_video_path(Some(&item.project_path), &project.video_path);
            if resolved.exists() {
                project.video_path = resolved.to_string_lossy().to_string();
            }
            if project.video_w == 0 || project.video_h == 0 {
                if let Ok(ffmpeg) = local_ffmpeg(&app) {
                    if let Ok(info) = probe_video(&ffmpeg, &project.video_path) {
                        project.video_w = info.width.max(1);
                        project.video_h = info.height.max(1);
                    }
                }
            }
            let w = if item.video_w > 0 {
                item.video_w
            } else {
                project.video_w.max(1)
            };
            let h = if item.video_h > 0 {
                item.video_h
            } else {
                project.video_h.max(1)
            };
            let export_result = run_ffmpeg_export(
                &app,
                &project,
                &item.output_path,
                w,
                h,
                ExportOptions::default(),
                false,
            )
            .await;
            BatchExportResult {
                project_path: item.project_path.clone(),
                output_path: item.output_path.clone(),
                success: export_result.is_ok(),
                error: export_result.err(),
            }
        }
        Err(e) => BatchExportResult {
            project_path: item.project_path.clone(),
            output_path: item.output_path.clone(),
            success: false,
            error: Some(e),
        },
    }
}

#[tauri::command]
pub async fn batch_export_videos(
    app: AppHandle,
    items: Vec<BatchExportItem>,
) -> Result<Vec<BatchExportResult>, String> {
    let total = items.len().max(1);
    let mut results = Vec::with_capacity(items.len());

    for (i, item) in items.into_iter().enumerate() {
        emit_progress(
            &app,
            (i as f32 / total as f32) * 100.0,
            &format!("Batch {}/{total}", i + 1),
        );
        results.push(process_batch_item(app.clone(), item).await);
    }

    emit_progress(&app, 100.0, "Batch export complete");
    Ok(results)
}