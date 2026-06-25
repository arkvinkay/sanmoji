import { escHtml, setProgressBar } from '../utils.js';

export function updateExportProgress(percent, message) {
  const pct = Math.min(100, Math.max(0, percent));
  const msg = message ?? `Exporting… ${pct.toFixed(1)}%`;
  const bar = document.getElementById('export-progress-bar');
  const text = document.getElementById('export-progress-text');
  const wrap = document.getElementById('export-progress');
  setProgressBar(bar, pct);
  if (text) text.textContent = msg;
  if (wrap) wrap.classList.remove('hidden');
}

export function updateCutProgress(percent, message) {
  const pct = Math.min(100, percent);
  const cutBar = document.getElementById('cut-progress-bar');
  const cutText = document.getElementById('cut-progress-text');
  const cutWrap = document.getElementById('cut-progress');
  setProgressBar(cutBar, pct);
  if (cutText) cutText.textContent = message ?? `Cutting… ${pct.toFixed(0)}%`;
  if (cutWrap) cutWrap.classList.remove('hidden');
}

export function resetCutProgress() {
  const cutBar = document.getElementById('cut-progress-bar');
  const cutWrap = document.getElementById('cut-progress');
  const cutText = document.getElementById('cut-progress-text');
  setProgressBar(cutBar, 0);
  if (cutText) cutText.textContent = '';
  if (cutWrap) cutWrap.classList.add('hidden');
}

export function resetExportProgress() {
  const bar = document.getElementById('export-progress-bar');
  const wrap = document.getElementById('export-progress');
  setProgressBar(bar, 0);
  if (wrap) wrap.classList.add('hidden');
}

export function startExportProgress() {
  const bar = document.getElementById('export-progress-bar');
  const wrap = document.getElementById('export-progress');
  const text = document.getElementById('export-progress-text');
  setProgressBar(bar, 0);
  if (wrap) wrap.classList.remove('hidden');
  if (text) text.textContent = 'Starting export…';
}

export function setExportModalLocked(locked) {
  const modal = document.getElementById('modal-export');
  if (!modal) return;
  modal.querySelectorAll('input, select, button').forEach(el => {
    if (el.id === 'btn-export-cancel') {
      el.disabled = false;
      return;
    }
    el.disabled = locked;
  });
}

export function isExportInProgress() {
  const wrap = document.getElementById('export-progress');
  return wrap && !wrap.classList.contains('hidden');
}

export function renderValidationList(issues) {
  const el = document.getElementById('export-validation');
  if (!el) return;
  if (!issues?.length) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  el.classList.remove('hidden');
  el.innerHTML = issues.map(i =>
    `<div class="validation-item ${escHtml(i.severity)}">${escHtml(i.message)}</div>`
  ).join('');
}