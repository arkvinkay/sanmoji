# Changelog

All notable changes to SanMoji are documented in this file.

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