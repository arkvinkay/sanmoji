# Rencana Implementasi — Modul UI Modals & Tauri Commands Modularization

Rencana ini merinci langkah-langkah memecah dua file monolith terbesar di dalam codebase Sanmoji:
1. `src/js/modals.js` (1.531 baris)
2. `src-tauri/src/commands.rs` (1.409 baris)

Modularisasi ini mengikuti *Single Responsibility Principle* (SRP) untuk memudahkan perawatan jangka panjang dan meningkatkan keterbacaan kode.

---

## User Review Required

> [!NOTE]
> **Penerapan Barrel & Re-export Pattern**: 
> Untuk meminimalkan risiko regresi, kami akan menggunakan pola re-ekspor (barrel pattern). File asli `modals.js` dan `commands.rs` (sebagai `commands/mod.rs` di Rust) akan tetap bertindak sebagai entry point utama yang mengekspor modul di bawahnya. Dengan cara ini, file pemanggil seperti `app.js` dan `lib.rs` tidak perlu mengubah cara mereka mengimpor fungsi.

---

## Proposed Changes

### 🔴 JavaScript Frontend (UI Modals)

Kita akan membuat folder baru `src/js/modals/` dan memindahkan fungsionalitas ke dalam file-file terpisah:

#### [NEW] [export-progress.js](file:///c:/Users/elhan/Desktop/site/sanmoji/v1.1.0/src/js/modals/export-progress.js)
* **Tanggung Jawab**: Manajemen bar kemajuan (progress bar) ekspor video dan pemangkasan video.
* **Fungsi**: `updateExportProgress`, `updateCutProgress`, `resetExportProgress`.

#### [NEW] [about-modal.js](file:///c:/Users/elhan/Desktop/site/sanmoji/v1.1.0/src/js/modals/about-modal.js)
* **Tanggung Jawab**: Menampilkan dialog informasi aplikasi.
* **Fungsi**: `openAboutModal`.

#### [NEW] [export-subs-modal.js](file:///c:/Users/elhan/Desktop/site/sanmoji/v1.1.0/src/js/modals/export-subs-modal.js)
* **Tanggung Jawab**: Menangani formulir ekspor subtitle ke file ASS, SSA, SRT, atau WebVTT.
* **Fungsi**: `openExportSubsModal`.

#### [NEW] [cut-video-modal.js](file:///c:/Users/elhan/Desktop/site/sanmoji/v1.1.0/src/js/modals/cut-video-modal.js)
* **Tanggung Jawab**: Menampilkan dialog pemangkasan video (trim/cut).
* **Fungsi**: `openCutVideoModal`.

#### [NEW] [relink-modal.js](file:///c:/Users/elhan/Desktop/site/sanmoji/v1.1.0/src/js/modals/relink-modal.js)
* **Tanggung Jawab**: Relink path file video yang hilang.
* **Fungsi**: `openRelinkModal`.

#### [NEW] [batch-modal.js](file:///c:/Users/elhan/Desktop/site/sanmoji/v1.1.0/src/js/modals/batch-modal.js)
* **Tanggung Jawab**: Pemrosesan ekspor video massal (batch export).
* **Fungsi**: `openBatchModal`.

#### [NEW] [find-replace-modal.js](file:///c:/Users/elhan/Desktop/site/sanmoji/v1.1.0/src/js/modals/find-replace-modal.js)
* **Tanggung Jawab**: Fitur pencarian dan penggantian teks lirik.
* **Fungsi**: `openFindReplaceModal`.

#### [NEW] [anim-modal.js](file:///c:/Users/elhan/Desktop/site/sanmoji/v1.1.0/src/js/modals/anim-modal.js)
* **Tanggung Jawab**: Animasi transisi per baris subtitle (override).
* **Fungsi**: `openAnimModal`.

#### [NEW] [scale-timing-modal.js](file:///c:/Users/elhan/Desktop/site/sanmoji/v1.1.0/src/js/modals/scale-timing-modal.js)
* **Tanggung Jawab**: Melakukan skala waktu (stretching/shrinking) baris lirik.
* **Fungsi**: `openScaleTimingModal`.

#### [NEW] [shortcuts-modal.js](file:///c:/Users/elhan/Desktop/site/sanmoji/v1.1.0/src/js/modals/shortcuts-modal.js)
* **Tanggung Jawab**: Pengaturan global (Hotkey pintasan, Watermark, Font default, Tema, dll.).
* **Fungsi**: `openShortcutsModal`.

#### [NEW] [choice-prompts.js](file:///c:/Users/elhan/Desktop/site/sanmoji/v1.1.0/src/js/modals/choice-prompts.js)
* **Tanggung Jawab**: Dialog prompt dengan pilihan khusus (pilihan duplikasi baris, konfirmasi migrasi legacy, konfirmasi tutup video).
* **Fungsi**: `promptDuplicateRow`, `promptCloseVideo`, `promptLegacyMigration`.

#### [MODIFY] [modals.js](file:///c:/Users/elhan/Desktop/site/sanmoji/v1.1.0/src/js/modals.js)
* **Perubahan**: Bersihkan seluruh baris kode dan ubah menjadi barrel file yang mengekspor ulang seluruh modul baru:
  ```javascript
  export * from './modals/export-progress.js';
  export * from './modals/about-modal.js';
  export * from './modals/export-subs-modal.js';
  export * from './modals/cut-video-modal.js';
  export * from './modals/relink-modal.js';
  export * from './modals/batch-modal.js';
  export * from './modals/find-replace-modal.js';
  export * from './modals/anim-modal.js';
  export * from './modals/scale-timing-modal.js';
  export * from './modals/shortcuts-modal.js';
  export * from './modals/choice-prompts.js';
  ```

---

### 🟡 Rust Backend (Tauri Commands)

Kita akan membuat folder baru `src-tauri/src/commands/` dan membagi perintah Rust:

#### [NEW] [mod.rs](file:///c:/Users/elhan/Desktop/site/sanmoji/v1.1.0/src-tauri/src/commands/mod.rs)
* **Perubahan**: Berfungsi sebagai entry point yang mendeklarasikan modul-modul anak dan mengekspor fungsinya:
  ```rust
  pub mod project;
  pub mod export;
  pub mod subtitle;
  pub mod video;
  pub mod system;

  pub use project::*;
  pub use export::*;
  pub use subtitle::*;
  pub use video::*;
  pub use system::*;
  ```

#### [NEW] [project.rs](file:///c:/Users/elhan/Desktop/site/sanmoji/v1.1.0/src-tauri/src/commands/project.rs)
* **Tanggung Jawab**: Operasi berkas proyek.
* **Commands**: `load_project`, `save_project`, `autosave_draft`, `load_autosave_draft`.

#### [NEW] [export.rs](file:///c:/Users/elhan/Desktop/site/sanmoji/v1.1.0/src-tauri/src/commands/export.rs)
* **Tanggung Jawab**: Rendering ekspor video dengan watermark.
* **Commands**: `export_video`, `batch_export_videos`, `cancel_export`, `cut_video`, `validate_export`.

#### [NEW] [subtitle.rs](file:///c:/Users/elhan/Desktop/site/sanmoji/v1.1.0/src-tauri/src/commands/subtitle.rs)
* **Tanggung Jawab**: Konversi format berkas subtitle.
* **Commands**: `export_ass_file`, `export_srt_file`, `export_subtitle_file`, `import_subtitle_file`, `generate_ass_preview`.

#### [NEW] [video.rs](file:///c:/Users/elhan/Desktop/site/sanmoji/v1.1.0/src-tauri/src/commands/video.rs)
* **Tanggung Jawab**: Pemrosesan video preview.
* **Commands**: `relink_video`, `get_video_info`, `prepare_video_preview_path`, `get_waveform`, `track_recent_video`.

#### [NEW] [system.rs](file:///c:/Users/elhan/Desktop/site/sanmoji/v1.1.0/src-tauri/src/commands/system.rs)
* **Tanggung Jawab**: Penyetelan aplikasi, font list, migrasi, dan inisialisasi awal.
* **Commands**: `get_settings`, `save_settings`, `get_system_fonts`, `ensure_ffmpeg`, `get_ffmpeg_status`, `get_legacy_migration_offer`, `import_legacy_data`, `decline_legacy_migration`, `get_start_file`.

#### [DELETE] [commands.rs](file:///c:/Users/elhan/Desktop/site/sanmoji/v1.1.0/src-tauri/src/commands.rs)
* **Perubahan**: Hapus file monolith lama ini setelah kodenya sukses dipindahkan ke dalam direktori `src-tauri/src/commands/`.

#### [MODIFY] [lib.rs](file:///c:/Users/elhan/Desktop/site/sanmoji/v1.1.0/src-tauri/src/lib.rs)
* **Perubahan**: Ubah baris import `mod commands;` agar mengarah ke modul direktori baru yang tetap mengekspor handler tauri perintah secara transparan.

---

## Verification Plan

### Automated Tests
* Jalankan `npm run lint` untuk memastikan semua modul Javascript baru bebas dari kesalahan impor atau linting.
* Jalankan `cargo check --manifest-path src-tauri/Cargo.toml` untuk memverifikasi struktur modul Rust dapat dikompilasi dengan benar.
* Jalankan `npm run test` untuk memastikan fungsionalitas test suite tetap hijau.

### Manual Verification
1. **Settings & Hotkeys**: Buka dialog Settings, ubah salah satu hotkey shortcut, simpan, dan verifikasi shortcut baru tersebut merespons dengan benar.
2. **Export Video**: Lakukan ekspor rendering preview/render penuh untuk memastikan perintah backend FFmpeg berjalan lancar di bawah modul modular baru.
3. **About Modal**: Tekan tombol info di toolbar dan verifikasi dialog About terbuka menampilkan detail versi `1.1.0`.
