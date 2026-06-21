// Central app state — single source of truth
import { MIN_ROW_MS, DEFAULT_ROW_MS } from './constants.js';
import { toast } from './toast.js';

export const state = {
  project: null,
  settings: null,
  fonts: [],
  projectPath: null,
  videoW: 1920,
  videoH: 1080,
  videoDurationMs: 0,
  activeRowId: null,
  pendingAnimRowId: null,
  rowSearchQuery: '',
  contextRowId: null,
  autoAdvance: false,
  dirty: false,
};

const listeners = new Map();

export function subscribe(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event)?.delete(fn);
}

export function notify(event, payload) {
  listeners.get(event)?.forEach(fn => {
    try { fn(payload); } catch (err) { console.warn(`state listener [${event}]:`, err); }
  });
}

export function markDirty() {
  state.dirty = true;
  notify('dirty', true);
}

export function markSaved() {
  state.dirty = false;
  notify('dirty', false);
}

function validateRowTimes(startMs, endMs) {
  const start = Math.max(0, Math.round(Number(startMs) || 0));
  let end = Math.max(0, Math.round(Number(endMs) || 0));
  if (end <= start) end = start + MIN_ROW_MS;
  return { start_ms: start, end_ms: end };
}

export function newProject(videoPath) {
  state.project = {
    version: 1,
    video_path: videoPath,
    video_w: state.videoW,
    video_h: state.videoH,
    rows: [],
  };
  state.projectPath = null;
  notify('project', state.project);
}

export function syncProjectDimensions() {
  if (state.project) {
    state.project.video_w = state.videoW;
    state.project.video_h = state.videoH;
  }
}

function makeRow(startMs, endMs, source = {}) {
  const times = validateRowTimes(startMs, endMs);
  return {
    id: crypto.randomUUID(),
    start_ms: times.start_ms,
    end_ms: times.end_ms,
    romaji: source.romaji ?? '',
    indo: source.indo ?? '',
    english: source.english ?? '',
    romaji_anim: source.romaji_anim ?? null,
    indo_anim: source.indo_anim ?? null,
    english_anim: source.english_anim ?? null,
  };
}

export function addRow(startMs = 0, endMs = DEFAULT_ROW_MS, source = {}) {
  if (!state.project) return null;
  const row = makeRow(startMs, endMs, source);
  state.project.rows.push(row);
  markDirty();
  notify('rows', state.project.rows);
  return row.id;
}

export function deleteRow(id) {
  if (!state.project) return;
  state.project.rows = state.project.rows.filter(r => r.id !== id);
  if (state.activeRowId === id) state.activeRowId = null;
  markDirty();
  notify('rows', state.project.rows);
}

export function updateRow(id, patch) {
  if (!state.project) return;
  const row = state.project.rows.find(r => r.id === id);
  if (!row) return;

  const next = { ...patch };
  if ('start_ms' in next || 'end_ms' in next) {
    const times = validateRowTimes(
      next.start_ms ?? row.start_ms,
      next.end_ms ?? row.end_ms,
    );
    next.start_ms = times.start_ms;
    next.end_ms = times.end_ms;
  }

  Object.assign(row, next);
  markDirty();
  notify('rows', state.project.rows);
}

export function reorderRows(fromId, toId) {
  if (!state.project) return;
  const rows = state.project.rows;
  const fromIdx = rows.findIndex(r => r.id === fromId);
  const toIdx = rows.findIndex(r => r.id === toId);
  if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
  const [item] = rows.splice(fromIdx, 1);
  const insertAt = fromIdx < toIdx ? toIdx - 1 : toIdx;
  rows.splice(insertAt, 0, item);
  markDirty();
  notify('rows', state.project.rows);
}

export function sortRows() {
  if (!state.project) return;
  state.project.rows.sort((a, b) => a.start_ms - b.start_ms);
  markDirty();
  notify('rows', state.project.rows);
}

export function setVideoDimensions(w, h) {
  if (w > 0) state.videoW = w;
  if (h > 0) state.videoH = h;
  notify('videoDimensions', { w: state.videoW, h: state.videoH });
}

export function setVideoDurationMs(ms) {
  state.videoDurationMs = ms > 0 && Number.isFinite(ms) ? Math.round(ms) : 0;
  notify('videoDuration', state.videoDurationMs);
}

export function resetVideoPreview() {
  state.videoW = 1920;
  state.videoH = 1080;
  state.videoDurationMs = 0;
  notify('videoDimensions', { w: state.videoW, h: state.videoH });
  notify('videoDuration', 0);
}

function copyRowAnimFields(source, target) {
  target.romaji_anim = source.romaji_anim ? { ...source.romaji_anim } : null;
  target.indo_anim = source.indo_anim ? { ...source.indo_anim } : null;
  target.english_anim = source.english_anim ? { ...source.english_anim } : null;
}

/** @param {'below' | 'bottom'} position */
export function duplicateRow(id, position = 'below') {
  if (!state.project) return null;
  const rows = state.project.rows;
  const idx = rows.findIndex(r => r.id === id);
  if (idx < 0) return null;
  const row = rows[idx];
  const dur = Math.max(MIN_ROW_MS, row.end_ms - row.start_ms);

  let startMs = 0;
  if (position === 'bottom') {
    const last = rows[rows.length - 1];
    startMs = last ? last.end_ms + 1 : 0;
  } else {
    startMs = row.end_ms + 1;
  }

  const newRow = makeRow(startMs, startMs + dur, row);
  copyRowAnimFields(row, newRow);

  if (position === 'bottom') {
    rows.push(newRow);
  } else {
    rows.splice(idx + 1, 0, newRow);
  }

  markDirty();
  notify('rows', state.project.rows);
  return newRow.id;
}

export function splitRow(id, splitMs) {
  if (!state.project) return null;
  const idx = state.project.rows.findIndex(r => r.id === id);
  if (idx < 0) return null;
  const row = state.project.rows[idx];
  const ms = Math.round(Number(splitMs) || 0);
  if (ms <= row.start_ms || ms >= row.end_ms) return null;

  const right = makeRow(ms, row.end_ms, row);
  row.end_ms = ms;
  state.project.rows.splice(idx + 1, 0, right);
  markDirty();
  notify('rows', state.project.rows);
  return right.id;
}

function mergeTextField(existing, incoming, _fieldName) {
  const a = (existing ?? '').trim();
  const b = (incoming ?? '').trim();
  if (a && b) {
    return { value: `${a} ${b}`, bothFilled: true };
  }
  return { value: a || b, bothFilled: false };
}

export function mergeRow(id) {
  if (!state.project) return false;
  const idx = state.project.rows.findIndex(r => r.id === id);
  if (idx < 0 || idx >= state.project.rows.length - 1) return false;
  const row = state.project.rows[idx];
  const next = state.project.rows[idx + 1];
  let warned = false;

  for (const field of ['romaji', 'indo', 'english']) {
    const merged = mergeTextField(row[field], next[field], field);
    row[field] = merged.value;
    if (merged.bothFilled) warned = true;
  }

  if (warned) {
    toast('Merged rows — text fields combined with a space', 'warning');
  }

  row.end_ms = next.end_ms;
  state.project.rows.splice(idx + 1, 1);
  markDirty();
  notify('rows', state.project.rows);
  return true;
}

export function shiftAllRows(deltaMs) {
  if (!state.project) return;
  const delta = Math.round(Number(deltaMs) || 0);
  state.project.rows.forEach(r => {
    r.start_ms = Math.max(0, r.start_ms + delta);
    r.end_ms = Math.max(r.start_ms + MIN_ROW_MS, r.end_ms + delta);
  });
  markDirty();
  notify('rows', state.project.rows);
}

export function scaleAllRows(factor, anchorMs = 0) {
  if (!state.project) return;
  const f = Number(factor);
  if (!Number.isFinite(f) || f <= 0) return;
  const anchor = Math.round(Number(anchorMs) || 0);
  state.project.rows.forEach(r => {
    r.start_ms = Math.max(0, Math.round(anchor + (r.start_ms - anchor) * f));
    r.end_ms = Math.max(r.start_ms + MIN_ROW_MS, Math.round(anchor + (r.end_ms - anchor) * f));
  });
  markDirty();
  notify('rows', state.project.rows);
}

/** Trim overlapping rows so each ends when the next starts. Returns number of fixes. */
export function fixOverlaps() {
  if (!state.project?.rows?.length) return 0;
  const rows = [...state.project.rows].sort((a, b) => a.start_ms - b.start_ms);
  let fixes = 0;
  for (let i = 0; i < rows.length - 1; i++) {
    const cur = rows[i];
    const next = rows[i + 1];
    if (cur.end_ms > next.start_ms) {
      cur.end_ms = Math.max(cur.start_ms + MIN_ROW_MS, next.start_ms);
      fixes++;
    }
  }
  if (fixes > 0) {
    markDirty();
    notify('rows', state.project.rows);
  }
  return fixes;
}

export function rowMatchesFilter(row, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    (row.romaji ?? '').toLowerCase().includes(q) ||
    (row.indo ?? '').toLowerCase().includes(q) ||
    (row.english ?? '').toLowerCase().includes(q)
  );
}

export function getFilteredRows() {
  if (!state.project) return [];
  const q = state.rowSearchQuery.trim();
  return state.project.rows.filter(r => rowMatchesFilter(r, q));
}

export function setRowSearchQuery(query) {
  state.rowSearchQuery = query ?? '';
  notify('search', state.rowSearchQuery);
}

export function selectAdjacentRow(direction) {
  if (!state.project?.rows.length) return null;
  const rows = state.project.rows;
  const idx = rows.findIndex(r => r.id === state.activeRowId);
  const nextIdx = direction < 0
    ? (idx <= 0 ? 0 : idx - 1)
    : (idx < 0 ? 0 : Math.min(rows.length - 1, idx + 1));
  const row = rows[nextIdx];
  if (row) {
    state.activeRowId = row.id;
    notify('activeRow', row.id);
  }
  return row ?? null;
}