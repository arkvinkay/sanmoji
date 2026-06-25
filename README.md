# SanMoji

![Version](https://img.shields.io/badge/version-1.1.1-orange)
![License](https://img.shields.io/badge/license-MIT-blue)
![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)
![Tauri](https://img.shields.io/badge/Tauri-v2-24c8db)

**三 + 文字** — Desktop lyric subtitle studio for **Romaji**, **Indonesian**, and **English** tracks.

## Why SanMoji exists

I built SanMoji because I needed a simple desktop tool to burn lyric subtitles onto concert and MV videos — set IN/OUT on a waveform, style three text lines, preview on the video, and export with FFmpeg. No cloud, no subscription, no After Effects timeline for every line.

The three columns are labeled **Romaji**, **Indo**, and **English** because that matches my usual workflow (JP readings + Indonesian + English translations). They are just names: you can type **any language** in any column — Korean, Thai, Spanish, instrumental credits, or leave tracks empty. Export and preview treat them as three independent text lines.

## What's New in v1.1.1

- **Fixed:** `.smpr` file association now registers correctly on install (NSIS `SHELL_CONTEXT` bug) and self-repairs on first launch for existing installs
- **Fixed:** Export modal resets progress state when FFmpeg download or export fails, so retries work without reopening the dialog
- **Fixed:** Settings read from disk are validated and sanitized before caching; corrupt values are flagged instead of silently accepted
- **Fixed:** Settings Cancel no longer overwrites in-memory settings when reload from disk fails
- **Fixed:** Sync Lyric timing uses strict null/undefined checks; backward row backfill anchors to already-timed lines to prevent overlaps
- **Fixed:** Post-release hardening from v1.1.0 — XSS mitigation in animation modal, export preflight locks, autosave path resolution, waveform keyboard navigation, timeline lane gaps, and more (see [CHANGELOG.md](CHANGELOG.md))

## Built with vibes

This app is **fully vibe coded** — designed and implemented iteratively with AI-assisted development, rapid prototyping, and a lot of manual testing on real concert footage. It is a personal tool first; polish and edge cases improve over time. If something feels off, open an issue or patch it.

## Features

### Three-track subtitle editor
- Independent **Romaji**, **Indo**, and **English** columns per timing row
- Virtual-scrolled row list with search, drag-reorder, duplicate, split, merge
- Per-row animation overrides (fade, slide, typewriter, scale, glow, bounce, raw ASS tags)

### Video preview & timing
- Open MP4/MKV/MOV/AVI/WebM and preview with burned-style overlay
- Full-screen loading overlay blocks all interaction while metadata is read and audio is analyzed for the waveform
- **`[ IN` / `OUT ]`** markers with optional 1-second snap
- Zoomable **waveform** (scroll to zoom, drag to pan, click to seek)
- Visual timeline with playhead, lane-packed row blocks, and red overlap warnings
- Bulk shift ±1s and scale-all timings

### Layout & typography
- **Settings → Layout Y** tab: **Position Y** only (vertical placement per track)
- **Romaji / Indo / English** tabs: font, size, color, outline, bold, shadow, and default animation
- Style presets (save/load/delete)
- Watermark image overlay (position, size, margins)

### Project & import/export
- `.smpr` project files with autosave draft
- **Drag & drop** video, `.smpr` project, or subtitle files onto the window
- Import **SRT** / **ASS** / **VTT** subtitles
- Export subtitles (**ASS**, **SSA**, **SRT**, **VTT**) via unified Subs dialog
- **Video export** with burned-in ASS subtitles: MP4, MKV, MOV, M4V, AVI, WebM (VP9)
- Preview 20% export (first fifth of video with burned subs)
- Video cut tool (stream copy trim for long concert footage)
- Batch export multiple projects
- Video relink when source file is missing

### Encoding
- FFmpeg-powered H.264 (CPU / NVENC / QSV) and WebM VP9
- Export progress bar with live percentage
- **Automatic FFmpeg download** on first use if not bundled (Windows)

### UX
- Icon toolbar for New / Open Video / Close Video / Open Project / Save / Import
- Tooltips on major controls
- Undo/redo 
- **Themes:** Dark, Light, Midnight, Warm, Forest (Settings → General)
- Customizable keyboard shortcuts
- Playback speed 0.25×–2×
- About dialog with license and credits

## Drag & drop

Drop files anywhere on the app window:

| File type | Action |
|-----------|--------|
| `.smpr` | Open project |
| Video (MP4, MKV, MOV, AVI, WebM, M4V, FLV, TS) | Open as new project |
| Subtitle (SRT, ASS, SSA, VTT) | Import into current project |

Priority when multiple files are dropped: project → video → subtitle.  
Drops are ignored while a video is still loading (metadata / waveform analysis).

## Requirements

- **Windows 10/11** (primary target)
- **Node.js** 18+ and **Rust** toolchain for development
- FFmpeg is bundled in release builds or downloaded automatically on first export

## Development

```bash
# Clone the repository and run setup from the repository root
npm install
npm run dev      # hot-reload development
npm run build    # release installer (NSIS)
```

### Rust tests

```bash
cd src-tauri
cargo test
```

## Project structure

```
v1.1.0/
├── src/                      # Frontend (vanilla JS)
│   ├── js/
│   │   ├── app.js            # Entry point
│   │   ├── editor.js, overlay.js, timeline.js, …
│   │   ├── modals.js         # Barrel re-export (public API)
│   │   └── modals/           # One file per dialog (settings, export, batch, …)
│   └── css/
├── src-tauri/                # Rust backend (Tauri v2)
│   ├── src/
│   │   ├── commands/         # Tauri IPC handlers (project, export, subtitle, video, system)
│   │   ├── ass.rs, validation.rs, …
│   │   └── lib.rs
│   └── bin/                  # FFmpeg sidecar (dev)
└── README.md
```

## Tauri configuration notes

- **Identifier:** `id.app.arkvin.sanmoji` (reverse-domain bundle ID)
- **Upgrading from v1.0.0:** The NSIS installer hook (`installerHooks`) copies settings, preview cache, and the downloaded FFmpeg binary from `%APPDATA%\id.arkvin.sanmoji.app` (including `ffmpeg/ffmpeg.exe`) when the new folder is still empty. If you run the app without going through the installer (or migration was skipped), SanMoji asks on first launch whether to **Import** settings/autosave/cache/FFmpeg from the old path or **Start Fresh**. Choose Import to copy; nothing is overwritten if the new folder already has data.
- **Asset protocol scope (S4):** Allowed paths include standard user folders (`$DOCUMENT`, `$DOWNLOAD`, `$VIDEO`, `$DESKTOP`, `$HOME`, `$TEMP`, `$APPDATA`) plus `?:/**` for Windows drive letters. The drive wildcard is **required** so users can open videos from any mounted drive (e.g. `D:\Concerts\...`). This is intentional — the webview only reads files the user explicitly opens or that are referenced by a saved project.
- **Shell permissions (S5):** FFmpeg is executed from the Rust backend via Tauri commands, not from frontend JavaScript. `shell:allow-execute` is **not** granted to the webview; only `shell:default` (e.g. opening external URLs) remains.

## License

- **SanMoji** application source: **MIT License**
- **FFmpeg** (video encoding): **GNU GPL** — see [ffmpeg.org](https://ffmpeg.org/legal.html)

## Keyboard shortcuts

Open **⌨ Shortcuts** in the toolbar for the full list.

| Key | Action |
|-----|--------|
| Space | Play / pause video |
| `I` | Set IN at playhead |
| `O` | Set OUT at playhead |
| `[` | Set IN at playhead (toolbar) |
| `]` | Set OUT at playhead (toolbar) |
| ← / → | Seek ±1s (Shift = ±5s) |
| Ctrl+H | Find & Replace |
| Ctrl+Z | Undo |
| Ctrl+Y | Redo |

## Contributing

1. Fork the repository and create a feature branch from `main`.
2. Install dependencies: `npm install` from the repository root.
3. Make changes in `src/js/` (frontend) or `src-tauri/src/` (Rust). New modal logic goes in `src/js/modals/`; new Tauri commands go in `src-tauri/src/commands/`.
4. Run checks before opening a PR:
   ```bash
   npm run lint
   npm run test
   cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
   ```
5. Keep commits focused; update `README.md` if behavior or architecture changes.
6. Open a pull request with a clear description and steps to verify.

Bug reports and feature requests are welcome via GitHub issues.

## Troubleshooting

### Video won't play or preview is black
- Confirm the file path still exists (use **Relink** if the project was moved).
- Check that the video codec is supported by Edge WebView (H.264/VP9/AV1 are typical).
- Try opening the file from a local drive; network paths may be slow or blocked.

### Waveform missing but video plays
- Waveform analysis runs FFmpeg in the background. If it fails, playback still works — check that FFmpeg is available (bundled in release builds or auto-downloaded on first export).

### Export fails or hangs
- Ensure enough disk space for the output file (often larger than source during encode).
- GPU encoders (NVENC, QSV) require compatible drivers; fall back to **libx264** if export errors mention the encoder.
- Cancel a stuck export from the export dialog; only one export runs at a time.

### FFmpeg not found (development)
- Place `ffmpeg.exe` in `src-tauri/bin/`, or run export once to trigger automatic download (Windows).

### Build / CI errors
- **Rust:** `rustup update stable` and `cargo clean --manifest-path src-tauri/Cargo.toml`.
- **Node:** Use Node 18+ (`node -v`). Delete `node_modules` and run `npm install` again.
- **Tauri build:** WebView2 is required on Windows; the installer can bootstrap it silently.

### Settings or project won't save
- Check write permissions to `%APPDATA%/sanmoji/` and your project/output folders.
- Avoid saving projects to read-only or synced folders that conflict during autosave.