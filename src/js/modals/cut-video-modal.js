import { state } from '../state.js';
import { msToDisplay } from '../utils.js';
import { invoke, dialog } from '../tauri.js';
import { toast } from '../toast.js';
import { showModal, hideModal } from './_shared.js';
import { resetCutProgress, updateCutProgress } from './export-progress.js';

function updateCutRangeDisplay() {
  const el = document.getElementById('cut-range-display');
  if (!el) return;
  const start = Number(document.getElementById('cut-start-ms')?.value ?? 0);
  const end = Number(document.getElementById('cut-end-ms')?.value ?? 0);
  if (end > start) {
    el.textContent = `Range: ${msToDisplay(start)} → ${msToDisplay(end)} (${((end - start) / 1000).toFixed(1)}s)`;
  } else {
    el.textContent = 'End must be after start.';
  }
}

function defaultCutRange() {
  const video = document.getElementById('video-player');
  const durationMs = state.videoDurationMs
    || Math.round((video?.duration ?? 0) * 1000);
  const playheadMs = Math.round((video?.currentTime ?? 0) * 1000);
  const row = state.project?.rows?.find(r => r.id === state.activeRowId);
  let startMs = row?.start_ms ?? Math.max(0, playheadMs - 30_000);
  let endMs = row?.end_ms ?? Math.min(durationMs || playheadMs + 60_000, playheadMs + 60_000);
  if (durationMs > 0) {
    startMs = Math.min(startMs, durationMs - 1000);
    endMs = Math.min(Math.max(endMs, startMs + 1000), durationMs);
  }
  return { startMs: Math.max(0, startMs), endMs: Math.max(startMs + 1000, endMs) };
}

export function openCutVideoModal() {
  if (!state.project?.video_path) {
    toast('Open a video first.', 'warning');
    return;
  }
  const { startMs, endMs } = defaultCutRange();
  document.getElementById('cut-start-ms').value = startMs;
  document.getElementById('cut-end-ms').value = endMs;
  const pathEl = document.getElementById('cut-output-path');
  if (pathEl && !pathEl.value) {
    const base = state.project.video_path.replace(/\.[^./\\]+$/, '');
    pathEl.value = `${base}_cut.mp4`;
  }
  resetCutProgress();
  updateCutRangeDisplay();
  showModal('modal-cut');
}

document.getElementById('cut-start-ms')?.addEventListener('input', updateCutRangeDisplay);
document.getElementById('cut-end-ms')?.addEventListener('input', updateCutRangeDisplay);

document.getElementById('btn-cut-browse')?.addEventListener('click', async () => {
  const path = await dialog.save({
    filters: [{ name: 'Video', extensions: ['mp4', 'mkv', 'mov', 'm4v', 'webm'] }],
    defaultPath: 'cut.mp4',
  });
  if (path) document.getElementById('cut-output-path').value = path;
});

document.getElementById('btn-cut-start')?.addEventListener('click', async () => {
  const inputPath = state.project?.video_path;
  const outputPath = document.getElementById('cut-output-path')?.value;
  const startMs = Number(document.getElementById('cut-start-ms')?.value ?? 0);
  const endMs = Number(document.getElementById('cut-end-ms')?.value ?? 0);
  if (!outputPath) {
    toast('Select output file first.', 'warning');
    return;
  }
  if (endMs <= startMs) {
    toast('End time must be after start time.', 'warning');
    return;
  }

  document.getElementById('btn-cut-start').disabled = true;
  document.getElementById('btn-cut-cancel').disabled = true;
  updateCutProgress(0, 'Starting cut…');

  try {
    const ff = await invoke('get_ffmpeg_status');
    if (!ff.available) {
      updateCutProgress(0, 'Downloading FFmpeg…');
      await invoke('ensure_ffmpeg');
    }
    await invoke('cut_video', {
      inputPath,
      outputPath,
      startMs,
      endMs,
    });
    toast('Video cut complete!', 'success');
    hideModal('modal-cut');
  } catch (err) {
    toast('Cut failed: ' + err, 'error');
  } finally {
    document.getElementById('btn-cut-start').disabled = false;
    document.getElementById('btn-cut-cancel').disabled = false;
  }
});

document.getElementById('btn-cut-cancel')?.addEventListener('click', () => {
  hideModal('modal-cut');
});