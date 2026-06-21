mod ass;
mod commands;
mod fonts;
mod ffmpeg_fetch;
mod ffprobe;
mod process_util;
mod project;
mod settings;
mod subtitle;
mod validation;
mod video_stream;

use http::header::CONTENT_TYPE;
use http::status::StatusCode;
use http::Response;
use serde::Serialize;
use tauri::Manager;
use video_stream::VideoPreviewState;

#[derive(Clone, Serialize)]
pub struct ProgressEvent {
    pub percent: f32,
    pub message: String,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .register_asynchronous_uri_scheme_protocol("stream", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            std::thread::spawn(move || {
                let response = match video_stream::handle_stream_request(&app, request) {
                    Ok(resp) => resp,
                    Err(e) => Response::builder()
                        .status(StatusCode::INTERNAL_SERVER_ERROR)
                        .header(CONTENT_TYPE, "text/plain")
                        .body(e.to_string().into_bytes())
                        .unwrap(),
                };
                responder.respond(response);
            });
        })
        .setup(|app| {
            app.manage(VideoPreviewState::new());
            commands::init_app_state(app.handle())
                .map_err(std::io::Error::other)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::load_project,
            commands::save_project,
            commands::relink_video,
            commands::autosave_draft,
            commands::load_autosave_draft,
            commands::get_video_info,
            commands::prepare_video_preview_path,
            commands::get_waveform,
            commands::validate_export,
            commands::export_video,
            commands::batch_export_videos,
            commands::get_system_fonts,
            commands::generate_ass_preview,
            commands::export_ass_file,
            commands::export_srt_file,
            commands::import_subtitle_file,
            commands::ensure_ffmpeg,
            commands::get_ffmpeg_status,
            commands::track_recent_video,
            commands::export_subtitle_file,
            commands::cut_video,
            commands::cancel_export,
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| {
            eprintln!("SanMoji failed to start: {e}");
            eprintln!(
                "If the window does not appear, ensure Microsoft Edge WebView2 Runtime is installed."
            );
            std::process::exit(1);
        });
}