/**
 * Visual timeline + zoomable waveform, bulk timing helpers
 */
import { state, shiftAllRows, scaleAllRows, reorderRows, fixOverlaps } from './state.js';
import { msToDisplay, debounce, safeDuration } from './utils.js';
import {
  MIN_TIMELINE_DURATION_MS, WF_ZOOM_MIN, WF_ZOOM_MAX, RESIZE_DEBOUNCE_MS, GAP_WARN_MS,
} from './constants.js';
import { invoke } from './tauri.js';
import { pushHistory } from './history.js';
import { renderRows, syncActiveRowHighlight } from './editor.js';
import { toast } from './toast.js';


const canvas = document.getElementById('timeline-canvas');
const waveformCanvas = document.getElementById('waveform-canvas');
const label = document.getElementById('timeline-label');
const zoomLabel = document.getElementById('wf-zoom-label');
let ctx;
let wfCtx;
let waveformPeaks = null;
let lastWaveformPath = null;

let wfZoom = 1;
let wfScroll = 0;
let wfDragging = false;
let wfDragStartX = 0;
let wfDragStartScroll = 0;

let tlDragId = null;
let tlDragOverIdx = -1;

let wfStaticCanvas = null;
let wfStaticDirty = true;
let tlStaticCanvas = null;
let tlStaticDirty = true;

export function initTimeline() {
  if (!canvas) return;
  ctx = canvas.getContext('2d');
  if (waveformCanvas) wfCtx = waveformCanvas.getContext('2d');

  const onResize = debounce(() => {
    invalidateWaveformCache();
    invalidateTimelineCache();
    renderTimeline();
    drawWaveform();
  }, RESIZE_DEBOUNCE_MS);
  window.addEventListener('resize', onResize);

  canvas.addEventListener('click', e => {
    if (tlDragId) return;
    seekFromCanvas(e, canvas, false);
  });
  canvas.addEventListener('mousedown', onTimelineDragStart);
  canvas.addEventListener('mousemove', onTimelineDragOver);
  canvas.addEventListener('mouseup', onTimelineDragEnd);
  canvas.addEventListener('mouseleave', onTimelineDragEnd);
  canvas.setAttribute('tabindex', '0');
  canvas.setAttribute('role', 'listbox');
  canvas.setAttribute('aria-label', 'Subtitle timeline — use arrow keys to select rows');

  waveformCanvas?.addEventListener('click', e => {
    if (wfDragging) return;
    seekFromCanvas(e, waveformCanvas, true);
  });
  waveformCanvas?.addEventListener('wheel', onWaveformWheel, { passive: false });
  waveformCanvas?.addEventListener('mousedown', onWaveformDragStart);

  document.getElementById('btn-wf-zoom-in')?.addEventListener('click', () => setWaveformZoom(wfZoom * 2));
  document.getElementById('btn-wf-zoom-out')?.addEventListener('click', () => setWaveformZoom(wfZoom / 2));
  document.getElementById('btn-wf-fit')?.addEventListener('click', resetWaveformView);
  document.getElementById('btn-wf-zoom-row')?.addEventListener('click', () => {
    const row = state.project?.rows.find(r => r.id === state.activeRowId);
    if (!row) {
      toast('Select a row first', 'warning');
      return;
    }
    zoomToRow(row.start_ms, row.end_ms);
  });

  document.getElementById('btn-shift-minus')?.addEventListener('click', () => bulkShift(-1000));
  document.getElementById('btn-shift-plus')?.addEventListener('click', () => bulkShift(1000));
  document.getElementById('btn-scale-timing')?.addEventListener('click', async () => {
    const { openScaleTimingModal } = await import('./modals.js');
    openScaleTimingModal();
  });
  document.getElementById('btn-fix-overlaps')?.addEventListener('click', () => {
    if (!state.project?.rows?.length) {
      toast('No rows to fix', 'warning');
      return;
    }
    pushHistory();
    const fixes = fixOverlaps();
    invalidateTimeline();
    renderRows();
    toast(fixes ? `Fixed ${fixes} overlap(s)` : 'No overlaps found', fixes ? 'success' : 'info');
  });
}

export function durationMs() {
  const video = document.getElementById('video-player');
  const fromVideo = safeDuration(video) > 0
    ? Math.round(safeDuration(video) * 1000)
    : 0;
  const fromProbe = state.videoDurationMs > 0 && Number.isFinite(state.videoDurationMs)
    ? state.videoDurationMs
    : 0;
  const fromRows = state.project?.rows.reduce((m, r) => Math.max(m, r.end_ms), 0) ?? 0;
  return Math.max(fromVideo, fromProbe, fromRows, MIN_TIMELINE_DURATION_MS);
}

function visibleWindow(dur) {
  const windowMs = dur / wfZoom;
  const maxScrollMs = Math.max(0, dur - windowMs);
  const startMs = wfScroll * maxScrollMs;
  return { startMs, windowMs, endMs: startMs + windowMs, maxScrollMs };
}

function msToCanvasX(ms, w, win) {
  return ((ms - win.startMs) / win.windowMs) * w;
}

function canvasXToMs(x, w, win) {
  return win.startMs + (x / w) * win.windowMs;
}

function clampScroll() {
  wfScroll = Math.max(0, Math.min(1, wfScroll));
}

function updateZoomLabel() {
  if (zoomLabel) zoomLabel.textContent = `${wfZoom}×`;
}

function invalidateWaveformCache() {
  wfStaticDirty = true;
}

function invalidateTimelineCache() {
  tlStaticDirty = true;
}

export function setWaveformZoom(next, anchorMs = null) {
  const dur = durationMs();
  if (dur <= 0) return;
  const prevZoom = wfZoom;
  wfZoom = Math.max(WF_ZOOM_MIN, Math.min(WF_ZOOM_MAX, Math.round(next)));
  if (wfZoom === prevZoom) return;

  const prevWin = visibleWindow(dur);
  const focusMs = anchorMs ?? (prevWin.startMs + prevWin.windowMs / 2);
  const rel = prevWin.windowMs > 0 ? (focusMs - prevWin.startMs) / prevWin.windowMs : 0.5;

  const newWin = dur / wfZoom;
  const maxScrollMs = Math.max(0, dur - newWin);
  const newStart = focusMs - rel * newWin;
  wfScroll = maxScrollMs > 0 ? newStart / maxScrollMs : 0;
  clampScroll();
  updateZoomLabel();
  invalidateWaveformCache();
  drawWaveform();
}

export function resetWaveformView() {
  wfZoom = 1;
  wfScroll = 0;
  updateZoomLabel();
  invalidateWaveformCache();
  drawWaveform();
}

export function zoomToRow(startMs, endMs) {
  const dur = durationMs();
  const rowDur = endMs - startMs;
  if (rowDur <= 0 || dur <= 0) return;
  const padding = rowDur * 0.3;
  const windowMs = rowDur + padding * 2;
  wfZoom = Math.max(WF_ZOOM_MIN, Math.min(WF_ZOOM_MAX, Math.round(dur / windowMs)));
  const actualWindow = dur / wfZoom;
  const maxScrollMs = Math.max(0, dur - actualWindow);
  const startWithPad = Math.max(0, startMs - padding);
  wfScroll = maxScrollMs > 0 ? startWithPad / maxScrollMs : 0;
  clampScroll();
  updateZoomLabel();
  invalidateWaveformCache();
  drawWaveform();
}

export function clearWaveform() {
  waveformPeaks = null;
  lastWaveformPath = null;
  resetWaveformView();
}

function onWaveformWheel(e) {
  e.preventDefault();
  const rect = waveformCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const dur = durationMs();
  const win = visibleWindow(dur);
  const anchorMs = canvasXToMs(x, rect.width, win);
  const factor = e.deltaY < 0 ? 2 : 0.5;
  setWaveformZoom(wfZoom * factor, anchorMs);
}

function onWaveformDragStart(e) {
  if (wfZoom <= 1) return;
  wfDragging = true;
  wfDragStartX = e.clientX;
  wfDragStartScroll = wfScroll;
  waveformCanvas.style.cursor = 'grabbing';
  document.addEventListener('mousemove', onWaveformDragMove);
  document.addEventListener('mouseup', onWaveformDragEnd);
}

function onWaveformDragMove(e) {
  if (!wfDragging) return;
  const dur = durationMs();
  const win = visibleWindow(dur);
  if (win.maxScrollMs <= 0) return;
  const dx = e.clientX - wfDragStartX;
  const msPerPx = win.windowMs / waveformCanvas.clientWidth;
  const deltaScroll = -(dx * msPerPx) / win.maxScrollMs;
  wfScroll = wfDragStartScroll + deltaScroll;
  clampScroll();
  invalidateWaveformCache();
  drawWaveform();
}

function onWaveformDragEnd() {
  if (!wfDragging) return;
  wfDragging = false;
  document.removeEventListener('mousemove', onWaveformDragMove);
  document.removeEventListener('mouseup', onWaveformDragEnd);
  if (waveformCanvas) waveformCanvas.style.cursor = wfZoom > 1 ? 'grab' : 'pointer';
}

function rowAtTimelineY(y, h, rowCount) {
  if (!rowCount) return -1;
  const rowH = Math.min(14, (h - 16) / rowCount);
  const laneH = rowH + 2;
  const idx = Math.floor((y - 12) / laneH);
  return idx >= 0 && idx < rowCount ? idx : -1;
}

function onTimelineDragStart(e) {
  if (!state.project?.rows.length || !canvas) return;
  const rect = canvas.getBoundingClientRect();
  const y = e.clientY - rect.top;
  const idx = rowAtTimelineY(y, canvas.clientHeight, state.project.rows.length);
  if (idx < 0) return;
  const row = state.project.rows[idx];
  const dur = durationMs();
  const x = e.clientX - rect.left;
  const x1 = (row.start_ms / dur) * canvas.clientWidth;
  const x2 = (row.end_ms / dur) * canvas.clientWidth;
  if (x < x1 - 4 || x > x2 + 4) return;

  tlDragId = row.id;
  state.activeRowId = row.id;
  syncActiveRowHighlight();
  canvas.style.cursor = 'grabbing';
}

function onTimelineDragOver(e) {
  if (!tlDragId || !canvas || !state.project) return;
  const rect = canvas.getBoundingClientRect();
  const y = e.clientY - rect.top;
  tlDragOverIdx = rowAtTimelineY(y, canvas.clientHeight, state.project.rows.length);
  invalidateTimelineCache();
  renderTimeline();
}

function onTimelineDragEnd() {
  if (!tlDragId || !state.project) {
    tlDragId = null;
    tlDragOverIdx = -1;
    if (canvas) canvas.style.cursor = 'pointer';
    return;
  }
  const fromId = tlDragId;
  const targetRow = state.project.rows[tlDragOverIdx];
  if (targetRow && targetRow.id !== fromId) {
    pushHistory();
    reorderRows(fromId, targetRow.id);
    renderRows();
  }
  tlDragId = null;
  tlDragOverIdx = -1;
  if (canvas) canvas.style.cursor = 'pointer';
}

function seekFromCanvas(e, targetCanvas, useWindow) {
  const dur = durationMs();
  if (dur <= 0) return;
  const rect = targetCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  let ms;
  if (useWindow) {
    const win = visibleWindow(dur);
    ms = Math.round(canvasXToMs(x, rect.width, win));
  } else {
    ms = Math.round((x / rect.width) * dur);
  }
  ms = Math.max(0, Math.min(dur, ms));
  const video = document.getElementById('video-player');
  if (video) video.currentTime = ms / 1000;
}

function drawTimeRuler(context, w, h, dur, useWindow) {
  const win = useWindow ? visibleWindow(dur) : { startMs: 0, windowMs: dur, endMs: dur };
  context.fillStyle = '#2a2a2a';
  context.fillRect(0, 0, w, 10);
  const tickCount = Math.min(12, Math.max(4, Math.floor(w / 80)));
  context.fillStyle = '#666';
  context.font = '9px sans-serif';
  for (let i = 0; i <= tickCount; i++) {
    const ms = win.startMs + (win.windowMs * i) / tickCount;
    const x = (i / tickCount) * w;
    context.fillRect(x, 0, 1, 10);
    if (i % Math.max(1, Math.floor(tickCount / 4)) === 0) {
      context.fillText(msToDisplay(ms), x + 2, 9);
    }
  }
}

function drawTimelineBlocks(context, w, h, dur) {
  context.fillStyle = '#1a1a1a';
  context.fillRect(0, 0, w, h);
  drawTimeRuler(context, w, h, dur, false);

  if (!state.project?.rows.length) return;

  const rowH = Math.min(14, (h - 16) / state.project.rows.length);
  const colors = { romaji: '#ffffff', indo: '#ffd700', english: '#aaddff' };

  state.project.rows.forEach((row, i) => {
    const y = 12 + i * (rowH + 2);
    const x1 = (row.start_ms / dur) * w;
    const x2 = (row.end_ms / dur) * w;
    const barW = Math.max(x2 - x1, 2);
    const isActive = row.id === state.activeRowId;
    const isDragOver = tlDragOverIdx === i && tlDragId && tlDragId !== row.id;

    if (isDragOver) {
      context.fillStyle = 'rgba(224, 92, 0, 0.25)';
      context.fillRect(0, y - 1, w, rowH + 6);
    }

    const next = state.project.rows[i + 1];
    if (next) {
      if (row.end_ms > next.start_ms) {
        const ox1 = (next.start_ms / dur) * w;
        const ox2 = (row.end_ms / dur) * w;
        context.fillStyle = 'rgba(255, 107, 107, 0.35)';
        context.fillRect(ox1, y - 1, Math.max(ox2 - ox1, 2), rowH + 4);
      } else if (next.start_ms - row.end_ms > GAP_WARN_MS) {
        const gx1 = (row.end_ms / dur) * w;
        const gx2 = (next.start_ms / dur) * w;
        context.fillStyle = 'rgba(68, 170, 255, 0.35)';
        context.fillRect(gx1, y + rowH / 2 - 1, Math.max(gx2 - gx1, 2), 3);
      }
    }

    [['romaji', 0], ['indo', 1], ['english', 2]].forEach(([track, offset]) => {
      if (!row[track]) return;
      context.fillStyle = colors[track];
      context.globalAlpha = isActive ? 1 : 0.65;
      context.fillRect(x1, y + offset * 3, barW, 3);
    });
    context.globalAlpha = 1;
  });
}

function drawPlayhead(context, w, h, dur, useWindow) {
  const video = document.getElementById('video-player');
  if (!video) return;
  const playMs = video.currentTime * 1000;
  if (!Number.isFinite(playMs)) return;
  let playX;
  if (useWindow) {
    const win = visibleWindow(dur);
    if (playMs < win.startMs || playMs > win.endMs) return;
    playX = msToCanvasX(playMs, w, win);
  } else {
    playX = (playMs / dur) * w;
  }
  context.strokeStyle = '#e05c00';
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(playX, 0);
  context.lineTo(playX, h);
  context.stroke();
}

function ensureTimelineStatic(w, h, dur) {
  if (!tlStaticCanvas) tlStaticCanvas = document.createElement('canvas');
  if (tlStaticCanvas.width !== w || tlStaticCanvas.height !== h) {
    tlStaticCanvas.width = w;
    tlStaticCanvas.height = h;
    tlStaticDirty = true;
  }
  if (tlStaticDirty) {
    const sctx = tlStaticCanvas.getContext('2d');
    drawTimelineBlocks(sctx, w, h, dur);
    tlStaticDirty = false;
  }
}

export function renderTimeline() {
  if (!ctx || !canvas) return;
  const dur = durationMs();
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w;
  canvas.height = h;

  ensureTimelineStatic(w, h, dur);
  ctx.drawImage(tlStaticCanvas, 0, 0);
  drawPlayhead(ctx, w, h, dur, false);

  if (label) {
    const win = visibleWindow(dur);
    const zoomPart = wfZoom > 1 ? ` · Wave ${wfZoom}×` : '';
    label.textContent = `Timeline · ${msToDisplay(dur)}${zoomPart} · ${msToDisplay(win.startMs)}–${msToDisplay(win.endMs)}`;
  }
}

function drawTimelinePlayheadOnly() {
  if (!ctx || !canvas || !tlStaticCanvas) return;
  const dur = durationMs();
  const w = canvas.width;
  const h = canvas.height;
  ctx.drawImage(tlStaticCanvas, 0, 0);
  drawPlayhead(ctx, w, h, dur, false);
}

export async function loadWaveform(videoPath) {
  if (!videoPath || !waveformCanvas) return;
  if (videoPath === lastWaveformPath && waveformPeaks) {
    drawWaveform();
    return;
  }
  try {
    const dur = state.videoDurationMs || 0;
    let buckets = Math.max(600, (waveformCanvas.clientWidth || 400) * 3);
    if (dur > 90 * 60 * 1000) buckets = Math.min(buckets, 500);
    else if (dur > 45 * 60 * 1000) buckets = Math.min(buckets, 800);
    else if (dur > 20 * 60 * 1000) buckets = Math.min(buckets, 1200);
    waveformPeaks = await invoke('get_waveform', { videoPath, buckets });
    lastWaveformPath = videoPath;
    resetWaveformView();
  } catch {
    waveformPeaks = null;
    invalidateWaveformCache();
    drawWaveform();
  }
}

function drawWaveformStatic(w, h, dur) {
  if (!wfStaticCanvas) wfStaticCanvas = document.createElement('canvas');
  if (wfStaticCanvas.width !== w || wfStaticCanvas.height !== h) {
    wfStaticCanvas.width = w;
    wfStaticCanvas.height = h;
    wfStaticDirty = true;
  }
  if (!wfStaticDirty) return;

  const sctx = wfStaticCanvas.getContext('2d');
  sctx.clearRect(0, 0, w, h);
  sctx.fillStyle = '#0d0d0d';
  sctx.fillRect(0, 0, w, h);

  const video = document.getElementById('video-player');
  const playMs = video ? video.currentTime * 1000 : 0;
  if (!video?.paused && wfZoom > 1) {
    const winCheck = visibleWindow(dur);
    if (playMs < winCheck.startMs || playMs > winCheck.endMs) {
      const windowMs = dur / wfZoom;
      const maxScrollMs = Math.max(0, dur - windowMs);
      const targetStart = Math.max(0, playMs - windowMs * 0.1);
      wfScroll = maxScrollMs > 0 ? targetStart / maxScrollMs : 0;
      clampScroll();
      wfStaticDirty = true;
    }
  }

  const win = visibleWindow(dur);
  drawTimeRuler(sctx, w, h, dur, true);

  if (waveformPeaks?.length) {
    const startIdx = Math.floor((win.startMs / dur) * waveformPeaks.length);
    const endIdx = Math.ceil((win.endMs / dur) * waveformPeaks.length);
    const visible = waveformPeaks.slice(startIdx, Math.max(startIdx + 1, endIdx));
    const mid = h / 2 + 5;
    const step = w / visible.length;

    sctx.fillStyle = '#3a5a7a';
    visible.forEach((peak, i) => {
      const barH = peak * ((h - 14) * 0.9);
      const x = i * step;
      sctx.fillRect(x, mid - barH / 2, Math.max(step, 1), barH);
    });
  }

  wfStaticDirty = false;
}

function drawWaveform() {
  if (!wfCtx || !waveformCanvas) return;
  const w = waveformCanvas.clientWidth;
  const h = waveformCanvas.clientHeight;
  waveformCanvas.width = w;
  waveformCanvas.height = h;

  const dur = durationMs();
  if (dur <= 0) {
    wfCtx.clearRect(0, 0, w, h);
    return;
  }

  drawWaveformStatic(w, h, dur);
  wfCtx.drawImage(wfStaticCanvas, 0, 0);
  drawPlayhead(wfCtx, w, h, dur, true);
  waveformCanvas.style.cursor = wfZoom > 1 ? 'grab' : 'pointer';
  updateZoomLabel();
}

function drawWaveformPlayheadOnly() {
  if (!wfCtx || !waveformCanvas || !wfStaticCanvas) return;
  const dur = durationMs();
  if (dur <= 0) return;
  const w = waveformCanvas.width;
  const h = waveformCanvas.height;

  const video = document.getElementById('video-player');
  const playMs = video ? video.currentTime * 1000 : 0;
  if (!video?.paused && wfZoom > 1 && Number.isFinite(playMs)) {
    const winCheck = visibleWindow(dur);
    if (playMs < winCheck.startMs || playMs > winCheck.endMs) {
      invalidateWaveformCache();
      drawWaveformStatic(w, h, dur);
    }
  }

  wfCtx.drawImage(wfStaticCanvas, 0, 0);
  drawPlayhead(wfCtx, w, h, dur, true);
}

export function updateWaveformPlayhead() {
  drawWaveformPlayheadOnly();
  drawTimelinePlayheadOnly();
}

export function bulkShift(deltaMs) {
  if (!state.project?.rows.length) {
    toast('No rows to shift', 'warning');
    return;
  }
  pushHistory();
  shiftAllRows(deltaMs);
  invalidateTimelineCache();
  renderRows();
  toast(`Shifted all rows ${deltaMs > 0 ? '+' : ''}${deltaMs / 1000}s`, 'info');
}

export function bulkScale(factor) {
  if (!state.project?.rows.length) {
    toast('No rows to scale', 'warning');
    return;
  }
  const f = parseFloat(factor);
  if (!f || isNaN(f) || f <= 0) {
    toast('Enter a valid scale factor', 'warning');
    return;
  }
  const video = document.getElementById('video-player');
  const anchorMs = Math.round((video?.currentTime ?? 0) * 1000);
  pushHistory();
  scaleAllRows(f, anchorMs);
  invalidateTimelineCache();
  renderRows();
  toast(`Scaled timings ×${f} around playhead`, 'info');
}

export function invalidateTimeline() {
  invalidateTimelineCache();
  invalidateWaveformCache();
}