# Changelog

All notable changes to SanMoji are documented in this file.

## [1.1.0] - 2026-06-24

### Added
- Sync Lyric Mode for real-time subtitle timing while audio plays.
- File association support: double-clicking `.smpr` files opens SanMoji and loads the project.

### Changed
- Timeline refactored to use a horizontal greedy-packing lane layout.
- Keyboard shortcut adjustments.
- Subtitle overlaps now highlighted with a red warning overlay.
- Upgraded application version metadata to 1.1.0.
- Rust settings: `AnimationType` and `ExportPreset` enums replace stringly-typed animation and FFmpeg preset fields, with safe serde deserialization fallbacks.
- Removed unused exports: `msToSec`, `clearToasts`, `fontFamilyName`, `fontPathForFamily`, `validateProjectLocal`, `isModalOpen`, `videoLoadingActive`.
- Modularized `modals.js` (1,531 lines) into `src/js/modals/` — 14 focused modules with `modals.js` as a barrel re-export; `app.js` imports unchanged.
- Modularized `commands.rs` (1,409 lines) into `src-tauri/src/commands/` — `project`, `export`, `subtitle`, `video`, `system`, and `common` submodules with `mod.rs` as entry point.

### Fixed
- Fixed convertFileSrc protocol parameter mismatch.
- Fixed Content-Length mismatch on GET video requests causing WebView playback hangs.
- Fixed glitch image canvas context null crash.
- Added cache layer for system font scanning to resolve lag during export.
- Fixed Mutex poisoning and preview video cache leaks.
- Removed double serialization inside project history snapshots.
- Undo/redo now fully refreshes row editor and timeline after each step.
- Timeline overlap warning now detects all overlapping ranges, including when a new lane is created (`lane === -1`).

## [1.0.1] - 2026-06-23

### Fixed
- GitHub link in About → arkvinkay/sanmoji
- Space play/pause no longer double-toggles
- Smoother realtime subtitle animation preview
- Waveform time labels readable at high zoom
- Subtitle timing blocks sync with waveform zoom/scroll

### Changed
- Removed CPS and character count column from row editor
- Removed Live Preview panel from Settings → Layout Y
- Bundle identifier: id.arkvin.sanmoji.app → id.app.arkvin.sanmoji
- Data migration from the previous identifier: NSIS installer copies settings when possible; on first launch the app also offers to import settings, autosave, FFmpeg cache, and preview cache (or start fresh)

### Fixed (review follow-up)
- Timeline gap/overlap markers visible when row bars are offscreen in zoomed view
- Legacy migration state file uses atomic write; corrupt state no longer blocks import
- NSIS installer hook registered and copies cache + ffmpeg/ subfolder correctly
- First-launch migration commands allowed in packaged Tauri ACL
- FFmpeg binary migrates from legacy ffmpeg/ subdirectory
- Subtitle overlay updates when seeking while paused
- Timeline stays in sync with waveform during zoomed playback auto-scroll
- Migration modal clears stale file list between prompts