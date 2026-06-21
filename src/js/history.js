/**
 * Simple undo/redo via project snapshot history.
 */
import { state, markDirty } from './state.js';
import { MAX_HISTORY } from './constants.js';

let undoStack = [];
let redoStack = [];

export function updateHistoryIndicator() {
  const el = document.getElementById('status-history');
  if (!el) return;
  if (!undoStack.length && !redoStack.length) {
    el.textContent = '';
    el.title = '';
    return;
  }
  const parts = [];
  if (undoStack.length) parts.push(`Undo: ${undoStack.length}`);
  else parts.push('Nothing to undo');
  if (redoStack.length) parts.push(`Redo: ${redoStack.length}`);
  el.textContent = parts.join(' · ');
  el.title = undoStack.length
    ? `${undoStack.length} change(s) available to undo`
    : 'Nothing to undo';
}

function snapshot() {
  if (!state.project) return null;
  return JSON.stringify({
    rows: structuredClone(state.project.rows),
    activeRowId: state.activeRowId,
  });
}

function applySnapshot(raw) {
  try {
    const data = JSON.parse(raw);
    if (!state.project) return false;
    state.project.rows = data.rows ?? [];
    state.activeRowId = data.activeRowId ?? null;
    return true;
  } catch (err) {
    console.warn('History snapshot corrupt — skipping restore:', err);
    return false;
  }
}

export function pushHistory() {
  if (!state.project) return;
  const snap = snapshot();
  if (!snap) return;
  if (undoStack.length && undoStack[undoStack.length - 1] === snap) return;
  undoStack.push(snap);
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack = [];
  markDirty();
  updateHistoryIndicator();
}

export function undo() {
  if (!undoStack.length || !state.project) return false;
  redoStack.push(snapshot());
  if (redoStack.length > MAX_HISTORY) redoStack.shift();
  const ok = applySnapshot(undoStack.pop());
  if (!ok) return false;
  markDirty();
  updateHistoryIndicator();
  return true;
}

export function redo() {
  if (!redoStack.length) return false;
  undoStack.push(snapshot());
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  const ok = applySnapshot(redoStack.pop());
  if (!ok) return false;
  markDirty();
  updateHistoryIndicator();
  return true;
}

export function clearHistory() {
  undoStack = [];
  redoStack = [];
  updateHistoryIndicator();
}