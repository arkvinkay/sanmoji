use http::header::*;
use http::status::StatusCode;
use http::{Request, Response};
use http_range::HttpRange;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

pub const STREAM_PATH: &str = "preview";

pub struct VideoPreviewState {
    path: Mutex<Option<PathBuf>>,
}

impl VideoPreviewState {
    pub fn new() -> Self {
        Self {
            path: Mutex::new(None),
        }
    }

    pub fn set(&self, path: PathBuf) {
        *self.path.lock().unwrap() = Some(path);
    }
}

fn guess_mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        "m4v" => "video/x-m4v",
        _ => "video/mp4",
    }
}

fn random_boundary() -> String {
    let mut x = [0_u8; 30];
    getrandom::getrandom(&mut x).expect("failed to get random bytes");
    (x[..])
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub fn handle_stream_request(
    app: &AppHandle,
    request: Request<Vec<u8>>,
) -> Result<Response<Vec<u8>>, Box<dyn std::error::Error + Send + Sync>> {
    let uri_path = request.uri().path().trim_start_matches('/');
    let decoded = percent_encoding::percent_decode(uri_path.as_bytes())
        .decode_utf8_lossy()
        .to_string();
    if decoded != STREAM_PATH {
        return Ok(Response::builder().status(404).body(Vec::new())?);
    }

    let state = app.state::<VideoPreviewState>();
    let file_path = state
        .path
        .lock()
        .unwrap()
        .clone()
        .ok_or("no video preview is loaded")?;

    let mut file = File::open(&file_path)?;
    let len = {
        let old_pos = file.stream_position()?;
        let len = file.seek(SeekFrom::End(0))?;
        file.seek(SeekFrom::Start(old_pos))?;
        len
    };

    let mime_type = guess_mime(&file_path);
    let mut resp = Response::builder().header(CONTENT_TYPE, mime_type);

    if let Some(range_header) = request
        .headers()
        .get("range")
        .and_then(|r| r.to_str().ok())
    {
        resp = resp.header(ACCEPT_RANGES, "bytes");

        let not_satisfiable = || {
            Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(CONTENT_RANGE, format!("bytes */{len}"))
                .body(vec![])
                .map_err(Into::into)
        };

        let ranges = if let Ok(ranges) = HttpRange::parse(range_header, len) {
            ranges
                .iter()
                .map(|r| (r.start, r.start + r.length - 1))
                .collect::<Vec<_>>()
        } else {
            return not_satisfiable();
        };

        const MAX_LEN: u64 = 1000 * 1024;

        if ranges.len() == 1 {
            let &(start, mut end) = ranges.first().unwrap();
            if start >= len || end >= len || end < start {
                return not_satisfiable();
            }
            end = start + (end - start).min(len - start).min(MAX_LEN - 1);
            let nbytes = end + 1 - start;
            let mut buf = Vec::with_capacity(nbytes as usize);
            file.seek(SeekFrom::Start(start))?;
            file.take(nbytes).read_to_end(&mut buf)?;
            resp = resp.header(CONTENT_RANGE, format!("bytes {start}-{end}/{len}"));
            resp = resp.header(CONTENT_LENGTH, nbytes);
            resp = resp.status(StatusCode::PARTIAL_CONTENT);
            resp.body(buf)
        } else {
            let ranges: Vec<(u64, u64)> = ranges
                .iter()
                .filter_map(|&(start, mut end)| {
                    if start >= len || end >= len || end < start {
                        None
                    } else {
                        end = start + (end - start).min(len - start).min(MAX_LEN - 1);
                        Some((start, end))
                    }
                })
                .collect();

            let boundary = random_boundary();
            let boundary_sep = format!("\r\n--{boundary}\r\n");
            let boundary_closer = format!("\r\n--{boundary}--\r\n");
            resp = resp.header(
                CONTENT_TYPE,
                format!("multipart/byteranges; boundary={boundary}"),
            );

            let mut buf = Vec::new();
            for (start, end) in ranges {
                buf.write_all(boundary_sep.as_bytes())?;
                buf.write_all(format!("{CONTENT_TYPE}: {mime_type}\r\n").as_bytes())?;
                buf.write_all(format!("{CONTENT_RANGE}: bytes {start}-{end}/{len}\r\n").as_bytes())?;
                buf.write_all(b"\r\n")?;
                let nbytes = end + 1 - start;
                let mut local_buf = vec![0_u8; nbytes as usize];
                file.seek(SeekFrom::Start(start))?;
                file.read_exact(&mut local_buf)?;
                buf.extend_from_slice(&local_buf);
            }
            buf.write_all(boundary_closer.as_bytes())?;
            resp.body(buf)
        }
    } else if request.method() == http::Method::HEAD {
        resp = resp.header(CONTENT_LENGTH, len);
        resp.body(Vec::new())
    } else {
        resp = resp.header(ACCEPT_RANGES, "bytes");
        resp = resp.header(CONTENT_LENGTH, len);
        let mut buf = Vec::with_capacity(len.min(8 * 1024 * 1024) as usize);
        if len <= 8 * 1024 * 1024 {
            file.read_to_end(&mut buf)?;
        } else {
            file.take(8 * 1024 * 1024).read_to_end(&mut buf)?;
        }
        resp.body(buf)
    }
    .map_err(Into::into)
}