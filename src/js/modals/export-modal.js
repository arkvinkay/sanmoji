import { state } from '../state.js';
import { invoke, dialog } from '../tauri.js';
import { toast } from '../toast.js';
import { formatById } from '../app-info.js';
import { showModal, hideModal, swapPathExtension } from './_shared.js';
import { hasBlockingErrors } from '../validation.js';
import {
  resetExportProgress,
  startExportProgress,
  updateExportProgress,
  setExportModalLocked,
  isExportInProgress,
  renderValidationList,
} from './export-progress.js';

function getSelectedExportFormat() {
  return document.getElementById('export-format')?.value ?? 'mp4';
}

function syncExportEncoderVisibility() {
  const fmt = getSelectedExportFormat();
  const encLabel = document.getElementById('export-encoder')?.closest('label');
  const presetLabel = document.getElementById('export-preset')?.closest('label');
  const isWebm = fmt === 'webm';
  if (encLabel) encLabel.style.display = isWebm ? 'none' : '';
  if (presetLabel) presetLabel.style.display = isWebm ? 'none' : '';
}

const EXPORT_QUALITY_PRESETS = {
  custom: null,
  youtube: { crf: 18, preset: 'slow', encoder: 'libx264', label: 'YouTube (high quality)' },
  social: { crf: 23, preset: 'fast', encoder: 'libx264', label: 'Social media (balanced)' },
  draft: { crf: 28, preset: 'ultrafast', encoder: 'libx264', label: 'Draft preview (fast)' },
};

function applyExportQualityPreset(key) {
  const p = EXPORT_QUALITY_PRESETS[key];
  if (!p) return;
  const crfEl = document.getElementById('export-crf');
  const crfVal = document.getElementById('export-crf-val');
  const presetEl = document.getElementById('export-preset');
  const encEl = document.getElementById('export-encoder');
  if (crfEl) crfEl.value = p.crf;
  if (crfVal) crfVal.textContent = String(p.crf);
  if (presetEl) presetEl.value = p.preset;
  if (encEl) encEl.value = p.encoder;
}

export async function openExportModal() {
  if (!state.settings) {
    toast('Settings not loaded yet', 'error');
    return;
  }
  resetExportProgress();
  setExportModalLocked(false);
  showModal('modal-export');
  document.getElementById('export-crf').value = state.settings.export.crf;
  document.getElementById('export-crf-val').textContent = state.settings.export.crf;
  document.getElementById('export-preset').value = state.settings.export.preset;
  document.getElementById('export-encoder').value = state.settings.export.encoder || 'libx264';
  document.getElementById('export-format').value = 'mp4';
  syncExportEncoderVisibility();
  document.getElementById('export-res-info').textContent =
    `Resolution: ${state.videoW}×${state.videoH} (from video)`;

  try {
    const issues = await invoke('validate_export', { project: state.project });
    renderValidationList(issues);
  } catch (err) {
    toast('Validation failed: ' + err, 'error');
  }
}

document.getElementById('export-quality-preset')?.addEventListener('change', e => {
  applyExportQualityPreset(e.target.value);
});

document.getElementById('export-crf')?.addEventListener('input', e => {
  document.getElementById('export-crf-val').textContent = e.target.value;
  const qp = document.getElementById('export-quality-preset');
  if (qp) qp.value = 'custom';
});

document.getElementById('export-format')?.addEventListener('change', () => {
  syncExportEncoderVisibility();
  const pathEl = document.getElementById('export-path');
  if (pathEl?.value) {
    pathEl.value = swapPathExtension(pathEl.value, getSelectedExportFormat());
  }
});

document.getElementById('btn-export-browse')?.addEventListener('click', async () => {
  const fmt = formatById(getSelectedExportFormat());
  const path = await dialog.save({
    filters: [{ name: fmt.label, extensions: fmt.extensions }],
    defaultPath: `export.${fmt.extensions[0]}`,
  });
  if (path) document.getElementById('export-path').value = path;
});

async function runExport(options = null) {
  if (isExportInProgress()) return;
  setExportModalLocked(true);
  try {
    const outPath = document.getElementById('export-path').value;
    if (!outPath) { toast('Select output file first.', 'warning'); return; }

    let issues = [];
    try {
      issues = await invoke('validate_export', { project: state.project });
      renderValidationList(issues);
    } catch (err) {
      toast('Validation failed: ' + err, 'error');
      return;
    }
    if (hasBlockingErrors(issues)) {
      toast('Fix validation errors before exporting', 'error');
      return;
    }

    const crf     = Number(document.getElementById('export-crf').value);
    const preset  = document.getElementById('export-preset').value;
    const encoder = document.getElementById('export-encoder').value;
    state.settings.export.crf     = crf;
    state.settings.export.preset  = preset;
    state.settings.export.encoder = encoder;
    try {
      await invoke('save_settings', { settings: state.settings });
    } catch (err) {
      toast('Failed to save export settings: ' + err, 'error');
      return;
    }

    try {
      const ff = await invoke('get_ffmpeg_status');
      if (!ff.available) {
        startExportProgress();
        updateExportProgress(0, 'Downloading FFmpeg…');
        await invoke('ensure_ffmpeg');
      }
    } catch (err) {
      toast('FFmpeg not available: ' + err, 'error');
      return;
    }

    startExportProgress();

    const exportOptions = {
      ...(options ?? {}),
      videoDurationMs: state.videoDurationMs > 0 ? state.videoDurationMs : undefined,
    };
    await invoke('export_video', {
      project: state.project,
      outputPath: outPath,
      videoW: state.videoW,
      videoH: state.videoH,
      options: exportOptions,
    });
    toast('Export complete!', 'success');
    hideModal('modal-export');
  } catch (err) {
    toast('Export failed: ' + err, 'error');
  } finally {
    setExportModalLocked(false);
  }
}

document.getElementById('btn-export-start')?.addEventListener('click', () => runExport(null));

document.getElementById('btn-export-segment')?.addEventListener('click', async () => {
  const durationMs = state.videoDurationMs
    || Math.round((document.getElementById('video-player')?.duration ?? 0) * 1000);
  if (!durationMs) {
    toast('Video duration unknown — wait for metadata to load.', 'warning');
    return;
  }
  const startMs = 0;
  const endMs = Math.max(1000, Math.round(durationMs * 0.2));

  let outPath = document.getElementById('export-path').value;
  if (!outPath) {
    const fmt = formatById(getSelectedExportFormat());
    outPath = await dialog.save({
      filters: [{ name: fmt.label, extensions: fmt.extensions }],
      defaultPath: `preview_20pct.${fmt.extensions[0]}`,
    });
    if (!outPath) return;
    document.getElementById('export-path').value = outPath;
  }

  await runExport({ segmentStartMs: startMs, segmentEndMs: endMs });
});

document.getElementById('btn-export-cancel')?.addEventListener('click', async () => {
  if (isExportInProgress()) {
    if (!window.confirm('Cancel export in progress? Partial output may remain on disk.')) return;
    try {
      await invoke('cancel_export');
    } catch (err) {
      console.warn('cancel_export:', err);
    }
    setExportModalLocked(false);
    resetExportProgress();
    toast('Export cancelled', 'info');
    return;
  }
  hideModal('modal-export');
});