/** App metadata — single source for UI & About dialog */
export const APP_NAME = 'SanMoji';
export const APP_VERSION = '1.0.0';
export const APP_CREATOR = 'Arkvin';
export const APP_GITHUB = 'https://github.com/arkvin/sanmoji';
export const APP_TAGLINE = '三言字幕 — Romaji · Indo · English lyric subtitle studio';
export const APP_DESCRIPTION =
  'SanMoji (三 + 文字) is a desktop app for authoring three-track lyric subtitles — Romaji, Indonesian, and English — ' +
  'with live preview, waveform timing, ASS/SRT export, and FFmpeg-powered video burning with watermark support.';

export const EXPORT_FORMATS = [
  { id: 'mp4', label: 'MP4 (H.264)', extensions: ['mp4'], videoCodec: 'h264', audioCodec: 'copy' },
  { id: 'mkv', label: 'MKV (H.264)', extensions: ['mkv'], videoCodec: 'h264', audioCodec: 'copy' },
  { id: 'mov', label: 'MOV (H.264)', extensions: ['mov'], videoCodec: 'h264', audioCodec: 'copy' },
  { id: 'avi', label: 'AVI (H.264)', extensions: ['avi'], videoCodec: 'h264', audioCodec: 'copy' },
  { id: 'webm', label: 'WebM (VP9)', extensions: ['webm'], videoCodec: 'vp9', audioCodec: 'opus' },
  { id: 'm4v', label: 'M4V (H.264)', extensions: ['m4v'], videoCodec: 'h264', audioCodec: 'copy' },
];

export function formatById(id) {
  return EXPORT_FORMATS.find(f => f.id === id) ?? EXPORT_FORMATS[0];
}