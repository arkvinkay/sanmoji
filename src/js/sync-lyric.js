/**
 * Sync Lyric Mode — real-time subtitle timing while audio plays.
 */
import { state } from './state.js';
import { invoke, dialog } from './tauri.js';
import { msToDisplay, snapMs, secToMs, basename } from './utils.js';
import { toast } from './toast.js';
import { getWaveformPeaks, durationMs } from './timeline.js';
import { DEFAULT_ROW_MS, WF_ZOOM_MIN, WF_ZOOM_MAX } from './constants.js';

let videoEl = null;
let onLoadRows = null;
let syncActive = false;
let syncRows = [];
let currentIdx = 0;
let syncScreen = 'input';
let syncRafId = null;

let panel;
let inputScreen;
let syncScreenEl;
let romajiTa;
let indoTa;
let englishTa;
let validationEl;
let btnStart;
let syncCanvas;
let syncCtx;
let syncListEl;
let syncTimeEl;
let syncProgressEl;
let btnPlayPause;
let syncWfZoomLabel;

let syncWfZoom = 1;
let syncWfScroll = 0;
let syncWfDragging = false;
let syncWfDragMoved = false;
let syncWfDragStartX = 0;
let syncWfDragStartScroll = 0;

export function isSyncModeActive() {
  return syncActive;
}

function parseLines(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  return lines.length ? lines : [''];
}

function countLines(text) {
  return parseLines(text).length;
}

function updateValidation() {
  if (!validationEl) return;
  const counts = [
    countLines(romajiTa?.value),
    countLines(indoTa?.value),
    countLines(englishTa?.value),
  ];
  const match = counts[0] === counts[1] && counts[1] === counts[2];
  const hasVideo = !!(state.project?.video_path && videoEl?.currentSrc);
  validationEl.textContent = match
    ? `${counts[0]} line(s) in each track — ${hasVideo ? 'ready to sync' : 'open a video first'}`
    : `Line count mismatch: Romaji ${counts[0]}, Indo ${counts[1]}, English ${counts[2]}`;
  validationEl.classList.toggle('sync-validation-ok', match && hasVideo);
  validationEl.classList.toggle('sync-validation-warn', !match || !hasVideo);
  if (btnStart) btnStart.disabled = !match || !hasVideo || counts[0] === 0;
}

function getSnapMs() {
  return snapMs(secToMs(videoEl?.currentTime ?? 0), state.settings?.snap_to_second);
}

function timingUnset(ms) {
  return ms === null || ms === undefined;
}

function rowIsTimed(row) {
  return !timingUnset(row.end_ms) && !timingUnset(row.start_ms) && row.end_ms > row.start_ms;
}

function buildSyncRows() {
  const romaji = parseLines(romajiTa?.value);
  const indo = parseLines(indoTa?.value);
  const english = parseLines(englishTa?.value);
  const lineCount = romaji.length;
  return Array.from({ length: lineCount }, (_, i) => ({
    id: crypto.randomUUID(),
    start_ms: null,
    end_ms: null,
    romaji: romaji[i] ?? '',
    indo: indo[i] ?? '',
    english: english[i] ?? '',
    romaji_anim: null,
    indo_anim: null,
    english_anim: null,
  }));
}

function showScreen(screen) {
  syncScreen = screen;
  inputScreen?.classList.toggle('hidden', screen !== 'input');
  syncScreenEl?.classList.toggle('hidden', screen !== 'sync');
}

function enterSyncMode() {
  syncActive = true;
  document.body.classList.add('sync-mode-active');
  panel?.classList.remove('hidden');
  showScreen('input');
  updateValidation();
}

function stopAndRewind() {
  if (!videoEl) return;
  videoEl.pause();
  videoEl.currentTime = 0;
  updatePlayPauseButton();
  drawSyncWaveform();
}

function updatePlayPauseButton() {
  if (!btnPlayPause || !videoEl) return;
  const playing = !videoEl.paused && !videoEl.ended;
  btnPlayPause.textContent = playing ? '⏸ Pause' : '▶ Play';
  btnPlayPause.setAttribute('aria-label', playing ? 'Pause audio' : 'Play audio');
}

function togglePlayPause() {
  if (!videoEl) return;
  if (videoEl.paused || videoEl.ended) {
    if (videoEl.ended) videoEl.currentTime = 0;
    videoEl.play().catch(() => {});
  } else {
    videoEl.pause();
  }
  updatePlayPauseButton();
}

function cancelSyncSession() {
  stopAndRewind();
  stopSyncLoop();
  resetSyncWaveformView();
  syncRows = [];
  currentIdx = 0;
  showScreen('input');
  toast('Sync cancelled — audio stopped', 'info');
}

function exitSyncMode() {
  syncActive = false;
  document.body.classList.remove('sync-mode-active');
  panel?.classList.add('hidden');
  stopSyncLoop();
  stopAndRewind();
  resetSyncWaveformView();
  showScreen('input');
  syncRows = [];
  currentIdx = 0;
}

function selectSyncRow(index) {
  if (index < 0 || index >= syncRows.length) return;
  currentIdx = index;
  const row = syncRows[index];
  if (videoEl && !timingUnset(row?.start_ms) && row.start_ms >= 0) {
    videoEl.currentTime = row.start_ms / 1000;
  }
  renderSyncList();
  drawSyncWaveform();
}

function advanceToNextRow() {
  if (currentIdx < syncRows.length - 1) {
    currentIdx += 1;
    return true;
  }
  return false;
}

function renderSyncList() {
  if (!syncListEl) return;
  syncListEl.innerHTML = '';
  syncRows.forEach((row, i) => {
    const el = document.createElement('div');
    el.className = 'sync-row-item';
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', `Line ${i + 1}`);
    if (i === currentIdx) el.classList.add('sync-row-active');
    if (rowIsTimed(row)) {
      el.classList.add('sync-row-done');
    }
    const timing = rowIsTimed(row)
      ? `${msToDisplay(row.start_ms)} → ${msToDisplay(row.end_ms)}`
      : !timingUnset(row.start_ms)
        ? `IN ${msToDisplay(row.start_ms)}`
        : '—';

    const num = document.createElement('span');
    num.className = 'sync-row-num';
    num.textContent = String(i + 1);

    const text = document.createElement('span');
    text.className = 'sync-row-text';
    text.textContent = row.romaji || row.indo || row.english || '(empty)';

    const time = document.createElement('span');
    time.className = 'sync-row-time dim-text';
    time.textContent = timing;

    el.append(num, text, time);
    el.addEventListener('click', () => selectSyncRow(i));
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectSyncRow(i);
      }
    });
    syncListEl.appendChild(el);
    if (i === currentIdx) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  });
  if (syncProgressEl) {
    const done = syncRows.filter(rowIsTimed).length;
    syncProgressEl.textContent = `${done} / ${syncRows.length} timed`;
  }
}

function currentRow() {
  return syncRows[currentIdx] ?? null;
}

function setIn() {
  const row = currentRow();
  if (!row || !videoEl) return;
  const ms = getSnapMs();
  row.start_ms = ms;
  if (timingUnset(row.end_ms) || row.end_ms <= ms) row.end_ms = null;
  renderSyncList();
  toast(`Line ${currentIdx + 1} IN → ${msToDisplay(ms)}`, 'success');
}

function setOut() {
  const row = currentRow();
  if (!row || !videoEl) return;
  const ms = getSnapMs();
  if (timingUnset(row.start_ms)) {
    toast('Set IN first', 'warning');
    return;
  }
  const lineNum = currentIdx + 1;
  row.end_ms = Math.max(ms, row.start_ms + 100);
  const advanced = advanceToNextRow();
  renderSyncList();
  toast(
    advanced
      ? `Line ${lineNum} OUT → ${msToDisplay(row.end_ms)} · now on line ${currentIdx + 1}`
      : `Line ${lineNum} OUT → ${msToDisplay(row.end_ms)}`,
    'success',
  );
}

function chain() {
  const row = currentRow();
  if (!row || !videoEl) return;
  const ms = getSnapMs();
  if (timingUnset(row.start_ms)) {
    row.start_ms = ms;
    toast(`Line ${currentIdx + 1} IN → ${msToDisplay(ms)}`, 'success');
    renderSyncList();
    return;
  }
  row.end_ms = Math.max(ms, row.start_ms + 100);
  if (currentIdx < syncRows.length - 1) {
    currentIdx += 1;
    const next = currentRow();
    if (next) next.start_ms = ms;
    toast(`Chained at ${msToDisplay(ms)}`, 'success');
  } else {
    toast(`Sync complete! Last line timing set to ${msToDisplay(row.end_ms)}`, 'success');
  }
  renderSyncList();
}

function cancelCurrent() {
  const row = currentRow();
  if (!row) return;
  row.start_ms = null;
  row.end_ms = null;
  renderSyncList();
  toast('Cleared current line timing', 'info');
}

function closeRemainingRows(endMs) {
  for (let i = syncRows.length - 1; i >= currentIdx; i--) {
    const row = syncRows[i];
    if (rowIsTimed(row)) {
      endMs = Math.min(endMs, row.start_ms);
      continue;
    }
    if (timingUnset(row.start_ms)) row.start_ms = Math.max(0, endMs - DEFAULT_ROW_MS);
    row.end_ms = Math.max(row.start_ms + 100, endMs);
    endMs = row.start_ms;
  }
  renderSyncList();
}

function onAudioEnded() {
  const dur = durationMs();
  closeRemainingRows(dur > 0 ? dur : secToMs(videoEl?.currentTime ?? 0));
  updatePlayPauseButton();
  toast('Playback ended — remaining lines closed', 'info');
}

function onVideoPlayStateChange() {
  updatePlayPauseButton();
}

function syncVisibleWindow(dur) {
  const windowMs = dur / syncWfZoom;
  const maxScrollMs = Math.max(0, dur - windowMs);
  const startMs = syncWfScroll * maxScrollMs;
  return { startMs, windowMs, endMs: startMs + windowMs, maxScrollMs };
}

function syncMsToCanvasX(ms, w, win) {
  return ((ms - win.startMs) / win.windowMs) * w;
}

function syncCanvasXToMs(x, w, win) {
  return win.startMs + (x / w) * win.windowMs;
}

function clampSyncScroll() {
  syncWfScroll = Math.max(0, Math.min(1, syncWfScroll));
}

function updateSyncZoomLabel() {
  if (syncWfZoomLabel) syncWfZoomLabel.textContent = `${syncWfZoom}×`;
  if (syncCanvas) {
    syncCanvas.classList.toggle('sync-wf-pannable', syncWfZoom > 1);
    if (!syncWfDragging) {
      syncCanvas.style.cursor = syncWfZoom > 1 ? 'grab' : 'pointer';
    }
  }
}

function resetSyncWaveformView() {
  syncWfZoom = 1;
  syncWfScroll = 0;
  updateSyncZoomLabel();
}

function setSyncWaveformZoom(next, anchorMs = null) {
  const dur = durationMs();
  if (dur <= 0) return;
  const prevZoom = syncWfZoom;
  syncWfZoom = Math.max(WF_ZOOM_MIN, Math.min(WF_ZOOM_MAX, Math.round(next)));
  if (syncWfZoom === prevZoom) return;

  const prevWin = syncVisibleWindow(dur);
  const focusMs = anchorMs ?? (prevWin.startMs + prevWin.windowMs / 2);
  const rel = prevWin.windowMs > 0 ? (focusMs - prevWin.startMs) / prevWin.windowMs : 0.5;

  const newWin = dur / syncWfZoom;
  const maxScrollMs = Math.max(0, dur - newWin);
  const newStart = focusMs - rel * newWin;
  syncWfScroll = maxScrollMs > 0 ? newStart / maxScrollMs : 0;
  clampSyncScroll();
  updateSyncZoomLabel();
}

function maybeFollowPlayhead(dur) {
  if (!videoEl || videoEl.paused || videoEl.ended || syncWfZoom <= 1) return;
  const playMs = videoEl.currentTime * 1000;
  const win = syncVisibleWindow(dur);
  if (playMs >= win.startMs && playMs <= win.endMs) return;
  const windowMs = dur / syncWfZoom;
  const maxScrollMs = Math.max(0, dur - windowMs);
  const targetStart = Math.max(0, playMs - windowMs * 0.1);
  syncWfScroll = maxScrollMs > 0 ? targetStart / maxScrollMs : 0;
  clampSyncScroll();
}

function seekSyncFromCanvas(clientX) {
  if (!syncCanvas || !videoEl) return;
  const dur = durationMs();
  if (dur <= 0) return;
  const rect = syncCanvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const w = rect.width;
  const win = syncVisibleWindow(dur);
  let ms = Math.round(syncCanvasXToMs(x, w, win));
  ms = Math.max(0, Math.min(dur, ms));
  videoEl.currentTime = ms / 1000;
  if (syncTimeEl) syncTimeEl.textContent = msToDisplay(ms);
}

function onSyncWaveformClick(e) {
  if (syncWfDragMoved) {
    syncWfDragMoved = false;
    return;
  }
  seekSyncFromCanvas(e.clientX);
}

function onSyncWaveformWheel(e) {
  if (!syncActive || syncScreen !== 'sync') return;
  e.preventDefault();
  const dur = durationMs();
  if (dur <= 0) return;
  const rect = syncCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const win = syncVisibleWindow(dur);
  const anchorMs = syncCanvasXToMs(x, rect.width, win);
  const factor = e.deltaY < 0 ? 2 : 0.5;
  setSyncWaveformZoom(syncWfZoom * factor, anchorMs);
}

function onSyncWaveformDragStart(e) {
  if (syncWfZoom <= 1 || !syncCanvas) return;
  syncWfDragging = true;
  syncWfDragMoved = false;
  syncWfDragStartX = e.clientX;
  syncWfDragStartScroll = syncWfScroll;
  syncCanvas.style.cursor = 'grabbing';
  document.addEventListener('mousemove', onSyncWaveformDragMove);
  document.addEventListener('mouseup', onSyncWaveformDragEnd);
}

function onSyncWaveformDragMove(e) {
  if (!syncWfDragging || !syncCanvas) return;
  const dx = e.clientX - syncWfDragStartX;
  if (Math.abs(dx) > 3) syncWfDragMoved = true;
  const dur = durationMs();
  const win = syncVisibleWindow(dur);
  if (win.maxScrollMs <= 0) return;
  const msPerPx = win.windowMs / syncCanvas.clientWidth;
  const deltaScroll = -(dx * msPerPx) / win.maxScrollMs;
  syncWfScroll = syncWfDragStartScroll + deltaScroll;
  clampSyncScroll();
}

function onSyncWaveformDragEnd() {
  if (!syncWfDragging) return;
  syncWfDragging = false;
  document.removeEventListener('mousemove', onSyncWaveformDragMove);
  document.removeEventListener('mouseup', onSyncWaveformDragEnd);
  if (syncCanvas) syncCanvas.style.cursor = syncWfZoom > 1 ? 'grab' : 'pointer';
}

function drawSyncWaveform() {
  if (!syncCtx || !syncCanvas) return;
  const w = syncCanvas.clientWidth;
  const h = syncCanvas.clientHeight;
  syncCanvas.width = w;
  syncCanvas.height = h;
  syncCtx.clearRect(0, 0, w, h);
  syncCtx.fillStyle = '#0d0d0d';
  syncCtx.fillRect(0, 0, w, h);

  const dur = durationMs();
  if (dur <= 0) return;

  maybeFollowPlayhead(dur);
  const win = syncVisibleWindow(dur);
  const peaks = getWaveformPeaks();

  if (peaks?.length) {
    const startIdx = Math.floor((win.startMs / dur) * peaks.length);
    const endIdx = Math.ceil((win.endMs / dur) * peaks.length);
    const visible = peaks.slice(startIdx, Math.max(startIdx + 1, endIdx));
    const mid = h / 2;
    const step = w / visible.length;
    syncCtx.fillStyle = '#3a5a7a';
    visible.forEach((peak, i) => {
      const barH = peak * (h * 0.85);
      syncCtx.fillRect(i * step, mid - barH / 2, Math.max(step, 1), barH);
    });
  }

  syncRows.forEach((row, i) => {
    if (timingUnset(row.start_ms) || timingUnset(row.end_ms) || row.end_ms <= row.start_ms) return;
    if (row.end_ms < win.startMs || row.start_ms > win.endMs) return;
    const x1 = syncMsToCanvasX(row.start_ms, w, win);
    const x2 = syncMsToCanvasX(row.end_ms, w, win);
    syncCtx.fillStyle = i === currentIdx ? 'rgba(224, 92, 0, 0.35)' : 'rgba(255, 255, 255, 0.12)';
    syncCtx.fillRect(x1, 0, Math.max(x2 - x1, 2), h);
  });

  if (videoEl) {
    const playMs = videoEl.currentTime * 1000;
    if (playMs >= win.startMs && playMs <= win.endMs) {
      const playX = syncMsToCanvasX(playMs, w, win);
      syncCtx.strokeStyle = '#e05c00';
      syncCtx.lineWidth = 2;
      syncCtx.beginPath();
      syncCtx.moveTo(playX, 0);
      syncCtx.lineTo(playX, h);
      syncCtx.stroke();
    }
    if (syncTimeEl) syncTimeEl.textContent = msToDisplay(playMs);
  }
}

function startSyncLoop() {
  stopSyncLoop();
  const tick = () => {
    drawSyncWaveform();
    syncRafId = requestAnimationFrame(tick);
  };
  syncRafId = requestAnimationFrame(tick);
}

function stopSyncLoop() {
  if (syncRafId) {
    cancelAnimationFrame(syncRafId);
    syncRafId = null;
  }
}

function startSyncSession() {
  if (!state.project?.video_path) {
    toast('Open a video before syncing', 'warning');
    return;
  }
  syncRows = buildSyncRows();
  currentIdx = 0;
  resetSyncWaveformView();
  showScreen('sync');
  renderSyncList();
  drawSyncWaveform();
  startSyncLoop();
  if (videoEl) {
    videoEl.currentTime = 0;
    videoEl.play().catch(() => {});
  }
  updatePlayPauseButton();
  toast('Sync started — Play/Pause controls, I=IN, O=OUT, Space/Enter=Chain, Esc=Clear line', 'info');
}

function buildProjectFromSync() {
  return {
    version: 1,
    video_path: state.project?.video_path ?? '',
    video_w: state.videoW,
    video_h: state.videoH,
    rows: syncRows.map(r => ({ ...r })),
  };
}

async function exportSmpr() {
  const project = buildProjectFromSync();
  const path = await dialog.save({
    filters: [{ name: 'SanMoji Project', extensions: ['smpr'] }],
    defaultPath: 'synced-project.smpr',
  });
  if (!path) return;
  try {
    await invoke('save_project', { project, path });
    toast(`Saved ${basename(path)}`, 'success');
  } catch (err) {
    toast('Save failed: ' + err, 'error');
  }
}

async function exportSubtitle(format) {
  const project = buildProjectFromSync();
  const ext = format === 'ass' ? 'ass' : 'srt';
  const path = await dialog.save({
    filters: [{ name: format.toUpperCase(), extensions: [ext] }],
    defaultPath: `synced.${ext}`,
  });
  if (!path) return;
  try {
    await invoke('export_subtitle_file', {
      project,
      outputPath: path,
      format,
      videoW: state.videoW,
      videoH: state.videoH,
    });
    toast(`${format.toUpperCase()} exported`, 'success');
  } catch (err) {
    toast('Export failed: ' + err, 'error');
  }
}

function loadToEditor() {
  const timed = syncRows.filter(rowIsTimed);
  if (!timed.length) {
    toast('No timed rows to load', 'warning');
    return;
  }
  onLoadRows?.(timed);
  exitSyncMode();
}

function onSyncWaveformKeydown(e) {
  if (!syncActive || syncScreen !== 'sync') return;
  const dur = durationMs();
  if (dur <= 0) return;
  let handled = false;

  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    const step = e.shiftKey ? 5000 : 1000;
    const dir = e.key === 'ArrowLeft' ? -1 : 1;
    if (videoEl) {
      const target = Math.max(0, Math.min(dur, (videoEl.currentTime * 1000) + dir * step));
      videoEl.currentTime = target / 1000;
    }
    handled = true;
  } else if (e.key === 'ArrowUp' || e.key === '+' || e.key === '=') {
    e.preventDefault();
    setSyncWaveformZoom(syncWfZoom * 2);
    handled = true;
  } else if (e.key === 'ArrowDown' || e.key === '-') {
    e.preventDefault();
    setSyncWaveformZoom(syncWfZoom / 2);
    handled = true;
  } else if (e.key === 'Home' || e.key === 'End') {
    e.preventDefault();
    syncWfScroll = e.key === 'Home' ? 0 : 1;
    clampSyncScroll();
    handled = true;
  } else if (e.key === 'PageUp' || e.key === 'PageDown') {
    e.preventDefault();
    const dir = e.key === 'PageUp' ? -1 : 1;
    syncWfScroll = Math.max(0, Math.min(1, syncWfScroll + dir * 0.1));
    clampSyncScroll();
    handled = true;
  }

  if (handled) {
    drawSyncWaveform();
  }
}

function onSyncKeydown(e) {
  if (!syncActive || syncScreen !== 'sync') return;
  if (e.target?.closest?.('button,input,textarea,select,a,[contenteditable="true"],.sync-row-item')) return;

  const key = e.key.toLowerCase();
  if (key === 'i') {
    e.preventDefault();
    setIn();
  } else if (key === 'o') {
    e.preventDefault();
    setOut();
  } else if (key === 'enter' || key === ' ' || e.code === 'Space') {
    e.preventDefault();
    chain();
  } else if (key === 'escape') {
    e.preventDefault();
    cancelCurrent();
  }
}

export function initSyncLyric({ videoEl: video, onLoadRows: loadCb }) {
  videoEl = video;
  onLoadRows = loadCb;

  panel = document.getElementById('sync-lyric-panel');
  inputScreen = document.getElementById('sync-input-screen');
  syncScreenEl = document.getElementById('sync-timing-screen');
  romajiTa = document.getElementById('sync-romaji');
  indoTa = document.getElementById('sync-indo');
  englishTa = document.getElementById('sync-english');
  validationEl = document.getElementById('sync-validation');
  btnStart = document.getElementById('btn-sync-start');
  syncCanvas = document.getElementById('sync-waveform-canvas');
  syncListEl = document.getElementById('sync-row-list');
  syncTimeEl = document.getElementById('sync-time-display');
  syncProgressEl = document.getElementById('sync-progress-label');
  btnPlayPause = document.getElementById('btn-sync-play-pause');
  syncWfZoomLabel = document.getElementById('sync-wf-zoom-label');

  if (syncCanvas) syncCtx = syncCanvas.getContext('2d');

  if (syncCanvas) {
    syncCanvas.setAttribute('tabindex', '0');
    syncCanvas.addEventListener('click', onSyncWaveformClick);
    syncCanvas.addEventListener('wheel', onSyncWaveformWheel, { passive: false });
    syncCanvas.addEventListener('mousedown', onSyncWaveformDragStart);
    syncCanvas.addEventListener('keydown', onSyncWaveformKeydown);
  }

  document.getElementById('btn-sync-wf-zoom-in')?.addEventListener('click', () => {
    setSyncWaveformZoom(syncWfZoom * 2);
  });
  document.getElementById('btn-sync-wf-zoom-out')?.addEventListener('click', () => {
    setSyncWaveformZoom(syncWfZoom / 2);
  });
  document.getElementById('btn-sync-wf-fit')?.addEventListener('click', () => {
    resetSyncWaveformView();
    drawSyncWaveform();
  });

  document.getElementById('btn-sync-mode')?.addEventListener('click', () => {
    if (syncActive) {
      exitSyncMode();
      return;
    }
    if (!state.project?.video_path) {
      toast('Open a video first to use Sync Lyric Mode', 'warning');
      return;
    }
    enterSyncMode();
  });

  document.getElementById('btn-sync-close')?.addEventListener('click', exitSyncMode);
  document.getElementById('btn-sync-start')?.addEventListener('click', startSyncSession);
  document.getElementById('btn-sync-play-pause')?.addEventListener('click', togglePlayPause);
  document.getElementById('btn-sync-restart')?.addEventListener('click', stopAndRewind);
  document.getElementById('btn-sync-set-in')?.addEventListener('click', setIn);
  document.getElementById('btn-sync-set-out')?.addEventListener('click', setOut);
  document.getElementById('btn-sync-chain')?.addEventListener('click', chain);
  document.getElementById('btn-sync-clear-line')?.addEventListener('click', cancelCurrent);
  document.getElementById('btn-sync-cancel')?.addEventListener('click', cancelSyncSession);
  document.getElementById('btn-sync-export-smpr')?.addEventListener('click', () => exportSmpr());
  document.getElementById('btn-sync-export-srt')?.addEventListener('click', () => exportSubtitle('srt'));
  document.getElementById('btn-sync-export-ass')?.addEventListener('click', () => exportSubtitle('ass'));
  document.getElementById('btn-sync-load-editor')?.addEventListener('click', loadToEditor);

  [romajiTa, indoTa, englishTa].forEach(el => {
    el?.addEventListener('input', updateValidation);
  });

  videoEl?.addEventListener('ended', onAudioEnded);
  videoEl?.addEventListener('play', onVideoPlayStateChange);
  videoEl?.addEventListener('pause', onVideoPlayStateChange);
  document.addEventListener('keydown', onSyncKeydown, true);

  window.addEventListener('resize', () => {
    if (syncActive && syncScreen === 'sync') drawSyncWaveform();
  });
}