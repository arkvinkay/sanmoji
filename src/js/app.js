/**
 * app.js — entry point
 */
import {
  state, newProject, addRow, updateRow, setVideoDimensions, setVideoDurationMs,
  resetVideoPreview, syncProjectDimensions, markSaved, markDirty, selectAdjacentRow, subscribe,
  duplicateRow, sortRows,
} from './state.js';

import { invoke, dialog, convertFileSrc, listen, isTauri } from './tauri.js';
import { msToDisplay, secToMs, snapMs, basename, safeDuration, setProgressBar } from './utils.js';
import { DEFAULT_ROW_MS } from './constants.js';
import { renderRows, highlightActiveRow, syncActiveRowHighlight } from './editor.js';
import { initOverlay, renderOverlay } from './overlay.js';
import { initTimeline, renderTimeline, loadWaveform, updateWaveformPlayhead, clearWaveform } from './timeline.js';
import {
  openSettingsModal, openExportModal, openBatchModal,
  openRelinkModal, updateExportProgress, openAboutModal,
  openExportSubsModal, openCutVideoModal, updateCutProgress, openFindReplaceModal,
  openShortcutsModal, promptCloseVideo, promptDuplicateRow,
} from './modals.js';
import { pushHistory, undo, redo, clearHistory, updateHistoryIndicator } from './history.js';
import { toast, setStatus } from './toast.js';
import { startAutosave } from './autosave.js';
import { getShortcuts, shortcutMatches } from './shortcuts.js';
import { fetchSettings, fetchSystemFonts } from './settings-api.js';
import { applyTheme } from './themes.js';

const video = document.getElementById('video-player');
let waveformLoadGen = 0;
let isVideoLoading = false;
let lastVideoDimensions = { w: 0, h: 0 };

export function videoLoadingActive() {
  return isVideoLoading;
}

function showVideoLoading(show, message = '', percent = 0) {
  const wrap = document.getElementById('video-loading');
  const text = document.getElementById('video-loading-text');
  const bar = document.getElementById('video-loading-bar');
  if (!wrap) return;
  isVideoLoading = show;
  document.body.classList.toggle('app-busy', show);
  document.body.setAttribute('aria-busy', show ? 'true' : 'false');
  wrap.setAttribute('aria-busy', show ? 'true' : 'false');
  if (!show) {
    wrap.classList.add('hidden');
    return;
  }
  wrap.classList.remove('hidden');
  if (text) text.textContent = message;
  setProgressBar(bar, percent);
}

async function loadWaveformInBackground(path) {
  const gen = ++waveformLoadGen;
  showVideoLoading(true, 'Building waveform…', 55);
  setStatus('Building waveform…');
  try {
    await loadWaveform(path);
    if (gen === waveformLoadGen) {
      showVideoLoading(false);
      setStatus('Ready');
    }
  } catch (err) {
    console.warn('Waveform load failed:', err);
    if (gen === waveformLoadGen) {
      showVideoLoading(false);
      setStatus('Ready (waveform unavailable)');
      toast('Waveform could not be built — video playback still works', 'warning');
    }
  }
}

function updateResDisplay() {
  const el = document.getElementById('video-res');
  if (!el) return;
  if (state.videoW && state.videoH) {
    el.textContent = `${state.videoW}×${state.videoH}`;
  } else {
    el.textContent = '';
  }
}

function applyVideoDimensions(w, h) {
  if (!(w > 0 && h > 0)) return;
  if (lastVideoDimensions.w === w && lastVideoDimensions.h === h) return;
  lastVideoDimensions = { w, h };
  setVideoDimensions(w, h);
  syncProjectDimensions();
  updateResDisplay();
}

async function probeVideo(path) {
  try {
    const info = await invoke('get_video_info', { videoPath: path });
    if (info?.width > 0 && info?.height > 0) {
      applyVideoDimensions(info.width, info.height);
    }
    if (info?.duration_ms > 0) {
      setVideoDurationMs(info.duration_ms);
    }
    return info;
  } catch (err) {
    console.warn('get_video_info failed:', err);
    return null;
  }
}

function waitForVideoMetadata(timeoutMs = 8000) {
  return new Promise(resolve => {
    if (!video) { resolve(false); return; }
    if (video.readyState >= 1 && safeDuration(video) > 0) {
      resolve(true);
      return;
    }
    let settled = false;
    const done = ok => {
      if (settled) return;
      settled = true;
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('error', onErr);
      clearTimeout(timer);
      resolve(ok);
    };
    const onMeta = () => done(true);
    const onErr = () => done(false);
    const timer = setTimeout(() => done(false), timeoutMs);
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('error', onErr);
  });
}

async function resolvePreviewPath(path) {
  try {
    return await invoke('prepare_video_preview_path', { path });
  } catch (err) {
    console.warn('prepare_video_preview_path:', err);
    return path;
  }
}

async function loadVideoSource(path) {
  if (!video || !path) return null;
  ++waveformLoadGen;
  showVideoLoading(true, 'Opening video…', 8);
  setStatus('Opening video…');

  setVideoDurationMs(0);
  const previewPath = await resolvePreviewPath(path);
  // stream:// protocol supports HTTP Range requests required for MP4 preview on WebView2
  const src = convertFileSrc('preview', 'stream');
  const assetSrc = convertFileSrc(previewPath);
  video.removeAttribute('crossorigin');
  video.src = src;
  video.load();

  showVideoLoading(true, 'Reading metadata…', 22);
  const [info, metaOkResult] = await Promise.all([probeVideo(path), waitForVideoMetadata()]);
  let metaOk = metaOkResult;
  if (!metaOk && assetSrc !== src) {
    console.warn('Stream preview failed, retrying asset protocol:', video.error);
    video.src = assetSrc;
    video.load();
    metaOk = await waitForVideoMetadata(6000);
  }
  const probeOk = (info?.duration_ms > 0) || (info?.width > 0 && info?.height > 0);
  if (!metaOk && !probeOk && info?.exists !== false) {
    toast('Video preview failed to load — check file format or path', 'warning');
    console.warn('Video metadata load failed:', { path, previewPath, src, assetSrc, error: video.error });
  } else if (!metaOk && probeOk) {
    console.warn('HTML5 preview unavailable; using FFmpeg metadata:', { path, previewPath, error: video.error });
  }

  renderTimeline();
  showVideoLoading(true, 'Video ready — preparing waveform…', 42);
  setStatus(`Video: ${basename(path)}`);

  if (info?.exists !== false) {
    invoke('track_recent_video', { videoPath: path })
      .then(() => fetchSettings())
      .then(s => {
        state.settings = s;
        refreshRecentItems();
      })
      .catch(err => console.warn('track_recent_video failed:', err));
    loadWaveformInBackground(path);
  } else {
    showVideoLoading(false);
  }
  return info;
}

export async function openVideoFromPath(path) {
  if (!path) return;
  try {
    clearHistory();
    newProject(path);
    await loadVideoSource(path);
    pushHistory();
    const titleEl = document.getElementById('project-title');
    if (titleEl) titleEl.textContent = basename(path);
    renderRows();
    setStatus(`Video: ${basename(path)}`);
  } catch (err) {
    console.error('openVideoFromPath failed:', err);
    toast('Failed to open video: ' + err, 'error');
  }
}

function wireVideoMetadata() {
  if (!video) return;
  video.addEventListener('loadedmetadata', () => {
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      applyVideoDimensions(video.videoWidth, video.videoHeight);
    }
    if (safeDuration(video) > 0) {
      setVideoDurationMs(Math.round(safeDuration(video) * 1000));
    }
    renderTimeline();
  });
  video.addEventListener('error', () => {
    const code = video.error?.code;
    const msgs = {
      1: 'Playback aborted',
      2: 'Network error loading video',
      3: 'Video decode error',
      4: 'Could not open video file (path or codec)',
    };
    const msg = msgs[code] ?? 'Unknown video error';
    console.error('Video error:', code, video.error, video.src);
    if (state.videoDurationMs > 0 || state.videoW > 0) {
      console.warn('Preview playback failed but FFmpeg metadata is available');
      return;
    }
    toast(`Video: ${msg}`, 'error');
  });
}
wireVideoMetadata();

function refreshRecentItems() {
  const sel = document.getElementById('recent-items');
  if (!sel) return;
  const projects = state.settings?.recent_projects ?? [];
  const videos = state.settings?.recent_videos ?? [];
  sel.innerHTML = '<option value="">Recent…</option>';

  if (projects.length) {
    const grp = document.createElement('optgroup');
    grp.label = 'Projects';
    projects.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p;
      opt.dataset.kind = 'project';
      opt.textContent = basename(p);
      grp.appendChild(opt);
    });
    sel.appendChild(grp);
  }

  if (videos.length) {
    const grp = document.createElement('optgroup');
    grp.label = 'Videos';
    videos.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p;
      opt.dataset.kind = 'video';
      opt.textContent = basename(p);
      grp.appendChild(opt);
    });
    sel.appendChild(grp);
  }
}

async function checkVideoAndRelink(project) {
  if (!project?.video_path) return true;
  const info = await probeVideo(project.video_path);
  if (info && !info.exists) {
    setStatus('Video missing — relink required');
    const newPath = await openRelinkModal(project.video_path);
    if (!newPath) {
      toast('Video not linked — preview unavailable', 'warning');
      return false;
    }
    if (state.projectPath) {
      try {
        const updated = await invoke('relink_video', {
          projectPath: state.projectPath,
          project: state.project,
          newVideoPath: newPath,
        });
        state.project = updated;
        toast('Video relinked', 'success');
      } catch (err) {
        if (state.project) state.project.video_path = newPath;
        toast('Relinked locally (save project to persist)', 'warning');
      }
    } else if (state.project) {
      state.project.video_path = newPath;
    }
    await loadVideoSource(newPath);
    setStatus('Ready');
    return true;
  }
  return true;
}

async function loadProjectFromPath(path) {
  if (!path) return;
  try {
    const project = await invoke('load_project', { path });
    state.project = project;
    state.projectPath = path;
    state.settings = await fetchSettings();
    if (project.video_w && project.video_h) {
      applyVideoDimensions(project.video_w, project.video_h);
    }

    const ok = await checkVideoAndRelink(project);
    if (ok && state.project?.video_path) await loadVideoSource(state.project.video_path);

    clearHistory();
    pushHistory();
    markSaved();
    renderRows();
    refreshRecentItems();
    const titleEl = document.getElementById('project-title');
    if (titleEl) titleEl.textContent = basename(path);
    setStatus(`Loaded ${basename(path)}`);
  } catch (err) {
    console.error('loadProjectFromPath failed:', err);
    toast('Failed to load project: ' + err, 'error');
  }
}

async function tryRestoreAutosave() {
  try {
    const draft = await invoke('load_autosave_draft');
    if (!draft?.project) return;

    const ok = await dialog.confirm(
      'An autosaved draft was found. Restore it?',
      { title: 'Restore Autosave', kind: 'info' }
    );
    if (!ok) return;

    state.project = draft.project;
    state.projectPath = draft.project_path ?? null;
    if (draft.project.video_w && draft.project.video_h) {
      applyVideoDimensions(draft.project.video_w, draft.project.video_h);
    }

    if (state.project?.video_path) {
      await checkVideoAndRelink(state.project);
      await loadVideoSource(state.project.video_path);
    }

    clearHistory();
    pushHistory();
    renderRows();
    const titleEl = document.getElementById('project-title');
    if (titleEl) {
      titleEl.textContent = state.projectPath
        ? basename(state.projectPath)
        : 'Autosave Draft';
    }
    toast('Autosave draft restored', 'success');
    setStatus('Restored autosave draft');
  } catch (err) {
    console.warn('Autosave restore failed:', err);
  }
}

async function boot() {
  try {
    if (!isTauri()) {
      toast('Running outside Tauri — file features disabled', 'warning');
    }
    state.settings = await fetchSettings();
    applyTheme(state.settings?.theme);
    state.fonts = await fetchSystemFonts();
    const snapToggle = document.getElementById('snap-toggle');
    if (snapToggle) snapToggle.checked = state.settings?.snap_to_second ?? false;
    initOverlay();
    initTimeline();
    refreshRecentItems();
    startAutosave();

    await listen('export-progress', (event) => {
      const p = event.payload;
      if (!p) return;
      const cutOpen = !document.getElementById('modal-cut')?.classList.contains('hidden');
      if (cutOpen) updateCutProgress(p.percent, p.message);
      else updateExportProgress(p.percent, p.message);
    });

    await listen('video-load-progress', (event) => {
      const p = event.payload;
      if (!p) return;
      const pct = 42 + (p.percent * 0.58);
      showVideoLoading(true, p.message, pct);
    });

    const ff = await invoke('get_ffmpeg_status');
    if (!ff?.available) {
      setStatus('Setting up FFmpeg…');
      try {
        await invoke('ensure_ffmpeg');
        toast('FFmpeg downloaded and ready', 'success');
      } catch (err) {
        toast('FFmpeg setup failed: ' + err, 'warning');
      }
    }

    await tryRestoreAutosave();
    setupDragDrop();
    updateHistoryIndicator();
    restoreSessionState();
    setStatus('Ready');
  } catch (err) {
    toast('Failed to initialize: ' + err, 'error');
    setStatus('Initialization error');
    console.error(err);
  }
}

const SESSION_KEY = 'sanmoji-session';

function saveSessionState() {
  try {
    const scrollEl = document.getElementById('rows-scroll');
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      scrollTop: scrollEl?.scrollTop ?? 0,
      activeRowId: state.activeRowId ?? null,
    }));
  } catch { /* ignore quota errors */ }
}

function restoreSessionState() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data.activeRowId) state.activeRowId = data.activeRowId;
    const scrollEl = document.getElementById('rows-scroll');
    if (scrollEl && typeof data.scrollTop === 'number') {
      requestAnimationFrame(() => { scrollEl.scrollTop = data.scrollTop; });
    }
  } catch { /* ignore corrupt session */ }
}

window.addEventListener('beforeunload', (e) => {
  saveSessionState();
  if (state.dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

boot();

document.getElementById('btn-open-video')?.addEventListener('click', async () => {
  try {
    const path = await dialog.open({
      filters: [{ name: 'Video', extensions: ['mp4','mkv','mov','avi','webm','flv','ts','m4v'] }]
    });
    if (!path) return;
    await openVideoFromPath(path);
  } catch (err) {
    toast('Open video failed: ' + err, 'error');
  }
});

video?.addEventListener('timeupdate', () => {
  if (!video) return;
  const ms = secToMs(video.currentTime);
  const timeEl = document.getElementById('time-display');
  if (timeEl) timeEl.textContent = msToDisplay(ms);
  highlightActiveRow(ms);
  renderOverlay(ms);
  updateWaveformPlayhead();
});

function getSnapMs() {
  return snapMs(secToMs(video?.currentTime ?? 0), state.settings?.snap_to_second);
}

function ensureTargetRow(createIfEmpty = true) {
  if (!state.project) {
    toast('Open a video or project first', 'warning');
    return null;
  }
  const rows = state.project.rows;
  if (!rows.length && createIfEmpty) {
    const ms = getSnapMs();
    const id = addRow(ms, ms + DEFAULT_ROW_MS);
    if (id) state.activeRowId = id;
    renderRows();
    toast('Created new row at playhead', 'info');
    return state.project.rows.find(r => r.id === id);
  }
  if (!rows.length) return null;
  const target = rows.find(r => r.id === state.activeRowId) ?? rows[rows.length - 1];
  state.activeRowId = target.id;
  return target;
}

function advanceAfterOut(outMs) {
  if (!state.autoAdvance || !state.project || !video) return;
  const idx = state.project.rows.findIndex(r => r.id === state.activeRowId);
  const next = state.project.rows[idx + 1];
  if (next) {
    state.activeRowId = next.id;
    return;
  }
  const startMs = outMs;
  const id = addRow(startMs, startMs + DEFAULT_ROW_MS);
  if (id) {
    state.activeRowId = id;
    sortRows();
  }
}

function setMarker(which) {
  const target = ensureTargetRow(true);
  if (!target) return;
  const ms = getSnapMs();
  pushHistory();
  if (which === 'in') {
    const patch = { start_ms: ms };
    if (target.end_ms <= ms) patch.end_ms = ms + 1000;
    updateRow(target.id, patch);
    toast(`IN → ${msToDisplay(ms)}`, 'success');
  } else {
    const endMs = Math.max(ms, target.start_ms + 100);
    updateRow(target.id, { end_ms: endMs });
    toast(`OUT → ${msToDisplay(endMs)}`, 'success');
    advanceAfterOut(endMs);
  }
  renderRows();
}

function setRowTime(which) {
  const target = ensureTargetRow(false);
  if (!target) {
    toast('Select or create a row first', 'warning');
    return;
  }
  const ms = getSnapMs();
  pushHistory();
  if (which === 'in') {
    const patch = { start_ms: ms };
    if (target.end_ms <= ms) patch.end_ms = ms + 1000;
    updateRow(target.id, patch);
    toast(`IN → ${msToDisplay(ms)}`, 'success');
  } else {
    const endMs = Math.max(ms, target.start_ms + 100);
    updateRow(target.id, { end_ms: endMs });
    toast(`OUT → ${msToDisplay(endMs)}`, 'success');
    advanceAfterOut(endMs);
  }
  renderRows();
}

function selectRowByDirection(dir) {
  const row = selectAdjacentRow(dir);
  if (!row || !video) return;
  syncActiveRowHighlight();
  video.currentTime = row.start_ms / 1000;
  renderRows();
}

const VIDEO_EXT = /\.(mp4|mkv|mov|avi|webm|m4v|flv|ts)$/i;
const SUB_EXT = /\.(srt|ass|ssa|vtt)$/i;

function showFileDropOverlay(show) {
  const el = document.getElementById('file-drop-overlay');
  if (!el) return;
  el.classList.toggle('hidden', !show);
}

async function importSubtitleFromPath(path) {
  if (!state.project) {
    toast('Open a video or project first, then drop a subtitle file.', 'warning');
    return;
  }
  try {
    const rows = await invoke('import_subtitle_file', { path });
    pushHistory();
    state.project.rows.push(...rows);
    state.project.rows.sort((a, b) => a.start_ms - b.start_ms);
    renderRows();
    toast(`Imported ${rows.length} subtitle entries from ${basename(path)}`, 'success');
  } catch (err) {
    toast('Subtitle import failed: ' + err, 'error');
  }
}

async function handleDroppedFiles(paths) {
  if (!paths?.length) return;
  const smpr = paths.find(p => /\.smpr$/i.test(p));
  const vid = paths.find(p => VIDEO_EXT.test(p));
  const sub = paths.find(p => SUB_EXT.test(p));

  if (smpr) {
    await loadProjectFromPath(smpr);
    return;
  }
  if (vid) {
    await openVideoFromPath(vid);
    return;
  }
  if (sub) {
    await importSubtitleFromPath(sub);
    return;
  }
  toast('Unsupported file — drop a video, .smpr project, or subtitle (.srt/.ass/.vtt)', 'warning');
}

async function setupDragDrop() {
  try {
    await listen('tauri://drag-enter', (event) => {
      if (isVideoLoading) return;
      const paths = event.payload?.paths ?? [];
      if (paths.length) showFileDropOverlay(true);
    });
    await listen('tauri://drag-leave', () => showFileDropOverlay(false));
    await listen('tauri://drag-drop', async (event) => {
      showFileDropOverlay(false);
      if (isVideoLoading) {
        toast('Please wait — video is still loading', 'warning');
        return;
      }
      try {
        await handleDroppedFiles(event.payload?.paths ?? []);
      } catch (err) {
        toast('Drop handler failed: ' + err, 'error');
      }
    });
  } catch (err) {
    console.warn('Drag-drop unavailable:', err);
  }
}

document.getElementById('btn-set-in')?.addEventListener('click', () => setMarker('in'));
document.getElementById('btn-set-out')?.addEventListener('click', () => setMarker('out'));

async function closeVideo() {
  const hasVideo = !!(video?.currentSrc || state.project?.video_path);
  if (!hasVideo) {
    toast('No video loaded', 'info');
    return;
  }
  const hasRows = state.project?.rows?.length > 0;
  let clearRows = false;
  if (hasRows) {
    const choice = await promptCloseVideo();
    if (!choice || choice === 'cancel') return;
    clearRows = choice === 'clear';
  }
  video?.pause();
  video?.removeAttribute('src');
  video?.load();
  resetVideoPreview();
  lastVideoDimensions = { w: 0, h: 0 };
  updateResDisplay();
  clearWaveform();
  if (state.project) {
    state.project.video_path = '';
    if (clearRows) {
      state.project.rows = [];
      state.activeRowId = null;
      markDirty();
    }
  }
  syncProjectDimensions();
  renderRows();
  renderTimeline();
  setStatus('Video closed');
  toast(clearRows ? 'Video closed — rows cleared' : 'Video closed', 'info');
}

document.getElementById('btn-close-video')?.addEventListener('click', () => closeVideo().catch(err => toast(String(err), 'error')));
document.getElementById('btn-about')?.addEventListener('click', openAboutModal);
document.getElementById('btn-layout-quick')?.addEventListener('click', () => openSettingsModal('layout'));
document.getElementById('btn-shortcuts')?.addEventListener('click', openShortcutsModal);

document.getElementById('playback-speed')?.addEventListener('change', e => {
  if (!video) return;
  const rate = parseFloat(e.target.value);
  if (Number.isFinite(rate) && rate > 0) {
    video.playbackRate = rate;
  }
});

document.getElementById('snap-toggle')?.addEventListener('change', async e => {
  if (!state.settings) return;
  state.settings.snap_to_second = e.target.checked;
  try {
    await invoke('save_settings', { settings: state.settings });
  } catch (err) {
    toast('Failed to save snap setting: ' + err, 'error');
  }
});

document.getElementById('auto-advance-toggle')?.addEventListener('change', e => {
  state.autoAdvance = e.target.checked;
});

function isTypingTarget(el) {
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
}

const MODAL_ALLOWED_SHORTCUTS = new Set(['save', 'undo', 'redo']);
const TYPING_ALLOWED_SHORTCUTS = new Set(['undo', 'redo', 'save']);

async function saveProject() {
  if (!state.project) return;
  let path = state.projectPath;
  if (!path) {
    path = await dialog.save({ filters: [{ name: 'SanMoji Project', extensions: ['smpr'] }] });
    if (!path) return;
    state.projectPath = path;
  }
  syncProjectDimensions();
  try {
    await invoke('save_project', { project: state.project, path });
    state.settings = await fetchSettings();
    markSaved();
    clearHistory();
    refreshRecentItems();
    toast('Project saved', 'success');
    setStatus(`Saved ${basename(path)}`);
  } catch (err) {
    toast('Save failed: ' + err, 'error');
  }
}

function handleShortcutAction(actionId, e) {
  switch (actionId) {
    case 'playPause':
      if (!video) return;
      video.paused ? video.play() : video.pause();
      break;
    case 'save':
      saveProject();
      break;
    case 'undo':
      if (undo()) renderRows();
      break;
    case 'redo':
      if (redo()) renderRows();
      break;
    case 'setIn':
      document.getElementById('btn-set-in')?.click();
      break;
    case 'setOut':
      document.getElementById('btn-set-out')?.click();
      break;
    case 'rowIn':
      setRowTime('in');
      break;
    case 'rowOut':
      setRowTime('out');
      break;
    case 'insertRow':
      document.getElementById('btn-add-row')?.click();
      break;
    case 'duplicateRow':
      if (!state.activeRowId) {
        toast('Select a row first', 'warning');
        break;
      }
      (async () => {
        const choice = await promptDuplicateRow();
        if (!choice || choice === 'cancel') return;
        pushHistory();
        duplicateRow(state.activeRowId, choice);
        renderRows();
      })();
      break;
    case 'findReplace':
      openFindReplaceModal();
      break;
    case 'seekBack':
      if (video) video.currentTime = Math.max(0, video.currentTime - (e?.shiftKey ? 5 : 1));
      break;
    case 'seekForward':
      if (video) {
        const dur = safeDuration(video) || 0;
        video.currentTime = Math.min(dur, video.currentTime + (e?.shiftKey ? 5 : 1));
      }
      break;
    case 'selectPrevRow':
      selectRowByDirection(-1);
      break;
    case 'selectNextRow':
      selectRowByDirection(1);
      break;
    default:
      break;
  }
}

document.addEventListener('keydown', e => {
  if (isVideoLoading) return;

  const modalOpen = document.querySelector('.modal:not(.hidden)');
  const shortcuts = getShortcuts();
  for (const [actionId, binding] of Object.entries(shortcuts)) {
    if (!shortcutMatches(e, binding)) continue;
    if (modalOpen && !MODAL_ALLOWED_SHORTCUTS.has(actionId)) return;

    if (isTypingTarget(e.target)) {
      if (TYPING_ALLOWED_SHORTCUTS.has(actionId)) {
        e.preventDefault();
        handleShortcutAction(actionId, e);
      }
      return;
    }

    e.preventDefault();
    handleShortcutAction(actionId, e);
    return;
  }
});

document.getElementById('btn-save-project')?.addEventListener('click', () => saveProject());

document.getElementById('btn-open-project')?.addEventListener('click', async () => {
  try {
    const path = await dialog.open({ filters: [{ name: 'SanMoji Project', extensions: ['smpr'] }] });
    if (!path) return;
    await loadProjectFromPath(path);
  } catch (err) {
    toast('Open project failed: ' + err, 'error');
  }
});

document.getElementById('recent-items')?.addEventListener('change', async e => {
  const path = e.target.value;
  if (!path) return;
  const kind = e.target.selectedOptions[0]?.dataset.kind ?? 'project';
  e.target.value = '';
  try {
    if (kind === 'video') {
      await openVideoFromPath(path);
      return;
    }
    await loadProjectFromPath(path);
  } catch (err) {
    toast('Recent item failed: ' + err, 'error');
  }
});

document.getElementById('btn-new')?.addEventListener('click', async () => {
  try {
    if (state.project?.rows.length) {
      const ok = await dialog.confirm('Discard current project?', { title: 'New Project', kind: 'warning' });
      if (!ok) return;
    }
    state.project = null;
    state.projectPath = null;
    resetVideoPreview();
    lastVideoDimensions = { w: 0, h: 0 };
    video?.removeAttribute('src');
    video?.load();
    clearWaveform();
    clearHistory();
    renderRows();
    const titleEl = document.getElementById('project-title');
    if (titleEl) titleEl.textContent = 'Untitled';
    updateResDisplay();
    setStatus('Ready');
  } catch (err) {
    toast('New project failed: ' + err, 'error');
  }
});

document.getElementById('btn-import-subtitle')?.addEventListener('click', async () => {
  if (!state.project) { toast('Open a video or project first.', 'warning'); return; }
  try {
    const paths = await dialog.open({
      multiple: true,
      filters: [{ name: 'Subtitles', extensions: ['srt','ass','ssa','vtt'] }]
    });
    if (!paths) return;
    const list = Array.isArray(paths) ? paths : [paths];
    let total = 0;
    pushHistory();
    for (const path of list) {
      try {
        const rows = await invoke('import_subtitle_file', { path });
        state.project.rows.push(...rows);
        total += rows.length;
      } catch (err) {
        toast(`Import failed for ${basename(path)}: ${err}`, 'error');
      }
    }
    if (total > 0) {
      state.project.rows.sort((a, b) => a.start_ms - b.start_ms);
      renderRows();
      toast(`Imported ${total} entries from ${list.length} file(s)`, 'success');
    }
  } catch (err) {
    toast('Import failed: ' + err, 'error');
  }
});

document.getElementById('btn-export-subs')?.addEventListener('click', openExportSubsModal);
document.getElementById('btn-cut-video')?.addEventListener('click', openCutVideoModal);
document.getElementById('btn-settings')?.addEventListener('click', openSettingsModal);
document.getElementById('btn-export')?.addEventListener('click', () => {
  if (!state.project?.video_path) { toast('Open a video first.', 'warning'); return; }
  openExportModal();
});
document.getElementById('btn-batch-export')?.addEventListener('click', openBatchModal);

subscribe('activeRow', () => syncActiveRowHighlight());