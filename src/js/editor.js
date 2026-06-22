/**
 * Lyric rows editor — virtual scroll, drag-reorder, context actions
 */
import {
  state, addRow, deleteRow, updateRow, reorderRows,
  duplicateRow, splitRow, mergeRow,
  getFilteredRows, setRowSearchQuery,
} from './state.js';
import { msToDisplay, displayToMs, secToMs, snapMs, animLabel, escHtml, throttle } from './utils.js';
import {
  GAP_WARN_MS,
  ROW_HEIGHT, VISIBLE_BUFFER, MAX_VISIBLE_ROWS,
  SCROLL_RENDER_THROTTLE_MS, DEFAULT_ROW_MS,
} from './constants.js';
import { openAnimModal, promptDuplicateRow } from './modals.js';
import { renderTimeline } from './timeline.js';
import { pushHistory } from './history.js';
import { toast } from './toast.js';

const scrollEl = document.getElementById('rows-scroll');
const container = document.getElementById('rows-container');
const spacerTop = document.getElementById('rows-spacer-top');
const spacerBottom = document.getElementById('rows-spacer-bottom');
const contextMenu = document.getElementById('row-context-menu');
const searchInput = document.getElementById('row-search');

let dragId = null;
let renderedRange = { start: 0, end: 0 };
const rowElCache = new Map();
let editingRowId = null;
let suppressTimeClickUntil = 0;

function hasAnimOverride(anim) {
  if (!anim || typeof anim !== 'object') return false;
  return Object.entries(anim).some(([k, v]) => {
    if (v === null || v === undefined || v === '') return false;
    if ((k === 'raw_ass_in' || k === 'raw_ass_out') && !String(v).trim()) return false;
    return true;
  });
}

export function purgeRowEditorCache(rowId) {
  const el = rowElCache.get(rowId);
  if (el) {
    el.remove();
    rowElCache.delete(rowId);
  }
}

export function renderRows() {
  if (!container) return;
  if (!state.project) {
    container.innerHTML = '';
    if (spacerTop) spacerTop.style.height = '0';
    if (spacerBottom) spacerBottom.style.height = '0';
    rowElCache.clear();
    renderTimeline();
    return;
  }

  const filtered = getFilteredRows();
  const total = filtered.length;
  const scrollTop = scrollEl?.scrollTop ?? 0;
  const viewH = scrollEl?.clientHeight ?? 600;

  let start = Math.floor(scrollTop / ROW_HEIGHT) - VISIBLE_BUFFER;
  let end = start + Math.ceil(viewH / ROW_HEIGHT) + VISIBLE_BUFFER * 2;
  start = Math.max(0, start);
  end = Math.min(total, Math.max(start + 1, end));
  if (end - start > MAX_VISIBLE_ROWS + VISIBLE_BUFFER * 2) {
    end = start + MAX_VISIBLE_ROWS + VISIBLE_BUFFER * 2;
  }

  if (spacerTop) spacerTop.style.height = `${start * ROW_HEIGHT}px`;
  if (spacerBottom) spacerBottom.style.height = `${Math.max(0, total - end) * ROW_HEIGHT}px`;

  const neededIds = new Set(filtered.slice(start, end).map(r => r.id));
  for (const [id, el] of rowElCache) {
    if (!neededIds.has(id)) {
      el.remove();
      rowElCache.delete(id);
    }
  }

  filtered.slice(start, end).forEach((row, i) => {
    let el = rowElCache.get(row.id);
    if (!el) {
      el = buildRowEl(row);
      rowElCache.set(row.id, el);
    } else {
      refreshRowEl(el, row);
    }
    const ref = container.children[i] ?? null;
    if (el.parentNode !== container || ref !== el) {
      container.insertBefore(el, ref);
    }
  });

  renderedRange = { start, end };
  renderTimeline();
}

function scrollActiveRowIntoView() {
  if (!state.activeRowId || !scrollEl) return;
  const el = container?.querySelector(`.lyric-row[data-id="${state.activeRowId}"]`);
  if (el) {
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return;
  }
  const filtered = getFilteredRows();
  const idx = filtered.findIndex(r => r.id === state.activeRowId);
  if (idx < 0) return;
  const rowTop = idx * ROW_HEIGHT;
  const rowBottom = rowTop + ROW_HEIGHT;
  const viewTop = scrollEl.scrollTop;
  const viewBottom = viewTop + scrollEl.clientHeight;
  if (rowTop >= viewTop && rowBottom <= viewBottom) return;
  const target = Math.max(0, rowTop - Math.floor(scrollEl.clientHeight / 3));
  scrollEl.scrollTo({ top: target, behavior: 'smooth' });
}

function rowGapBadge(row, rows) {
  const idx = rows.findIndex(r => r.id === row.id);
  const next = rows[idx + 1];
  if (!next) return '';
  if (row.end_ms > next.start_ms) {
    return '<span class="row-badge overlap" title="Overlaps next row">⚠</span>';
  }
  if (next.start_ms - row.end_ms > GAP_WARN_MS) {
    return '<span class="row-badge gap" title="Gap &gt; 2s to next row">↕</span>';
  }
  return '';
}

function refreshRowEl(el, row) {
  const rows = state.project?.rows ?? [];
  el.className = 'lyric-row' + (row.id === state.activeRowId ? ' active' : '');
  el.dataset.id = row.id;
  const startBtn = el.querySelector('[data-action="set-start"]');
  const endBtn = el.querySelector('[data-action="set-end"]');
  if (startBtn) startBtn.textContent = msToDisplay(row.start_ms);
  if (endBtn) endBtn.textContent = msToDisplay(row.end_ms);
  const badgeEl = el.querySelector('.row-badges');
  if (badgeEl) badgeEl.innerHTML = rowGapBadge(row, rows);
  ['romaji', 'indo', 'english'].forEach(f => {
    const inp = el.querySelector(`[data-field="${f}"]`);
    if (inp && document.activeElement !== inp) inp.value = row[f] ?? '';
  });
}

function buildRowEl(row) {
  const el = document.createElement('div');
  el.className = 'lyric-row' + (row.id === state.activeRowId ? ' active' : '');
  el.dataset.id = row.id;

  const anims = [row.romaji_anim, row.indo_anim, row.english_anim];
  const hasOverride = anims.some(hasAnimOverride);
  const hasRaw = anims.some(a => a?.raw_ass_in || a?.raw_ass_out);
  const animBadgeClass = (hasOverride || hasRaw) ? 'anim-badge overridden' : 'anim-badge';
  const animSummary = (hasOverride || hasRaw)
    ? (hasRaw ? 'raw ASS' : 'custom')
    : animLabel(state.settings?.romaji_anim?.anim_in ?? 'fade');

  const rows = state.project?.rows ?? [];

  el.innerHTML = `
    <span class="drag-handle" title="Drag to reorder subtitle rows">⠿<span class="row-badges">${rowGapBadge(row, rows)}</span></span>
    <button class="time-btn" data-action="set-start" title="Double-click to edit · click to set IN from playhead">${msToDisplay(row.start_ms)}</button>
    <button class="time-btn" data-action="set-end" title="Double-click to edit · click to set OUT from playhead">${msToDisplay(row.end_ms)}</button>
    <input type="text" data-field="romaji" value="${escHtml(row.romaji)}" placeholder="Romaji…" title="Romaji / Japanese reading" />
    <input type="text" data-field="indo"   value="${escHtml(row.indo)}"   placeholder="Indo…" title="Indonesian translation" />
    <input type="text" data-field="english" value="${escHtml(row.english)}" placeholder="English…" title="English translation" />
    <button class="${animBadgeClass}" data-action="open-anim" title="Per-row animation override">${animSummary}</button>
    <div class="row-actions">
      <button class="btn-row-action" data-action="duplicate" title="Duplicate this row (choose placement)">⧉</button>
      <button class="btn-row-action" data-action="split" title="Split row at playhead into two rows">✂</button>
      <button class="btn-row-action" data-action="merge" title="Merge with the next row">⊕</button>
      <button class="btn-delete-row" data-action="delete" title="Delete this subtitle row">×</button>
    </div>
  `;

  const handle = el.querySelector('.drag-handle');
  if (handle) {
    handle.draggable = true;
    handle.addEventListener('dragstart', e => {
      dragId = row.id;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', row.id);
      if (e.dataTransfer.setDragImage) {
        e.dataTransfer.setDragImage(el, 20, el.clientHeight / 2);
      }
    });
    handle.addEventListener('dragend', () => {
      dragId = null;
      el.classList.remove('dragging');
      container?.querySelectorAll('.lyric-row').forEach(r => r.classList.remove('drag-over'));
    });
  }

  el.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (row.id !== dragId) el.classList.add('drag-over');
  });
  el.addEventListener('dragleave', e => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('drag-over');
  });
  el.addEventListener('drop', e => {
    e.preventDefault();
    el.classList.remove('drag-over');
    if (dragId && dragId !== row.id) {
      pushHistory();
      reorderRows(dragId, row.id);
      renderRows();
    }
    dragId = null;
  });

  el.querySelectorAll('.time-btn').forEach(btn => {
    btn.addEventListener('dblclick', e => {
      e.preventDefault();
      e.stopPropagation();
      suppressTimeClickUntil = Date.now() + 400;
      startTimeEdit(btn, row.id, btn.dataset.action === 'set-end' ? 'end_ms' : 'start_ms');
    });
  });

  el.addEventListener('click', e => {
    if (!e.target.closest('[data-action]') && !e.target.closest('input')) {
      state.activeRowId = row.id;
      seekToRow(row.id);
      container.querySelectorAll('.lyric-row').forEach(r =>
        r.classList.toggle('active', r.dataset.id === row.id)
      );
    }
  });

  el.addEventListener('contextmenu', e => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, row.id);
  });

  return el;
}

function seekToRow(rowId) {
  const row = state.project?.rows.find(r => r.id === rowId);
  const video = document.getElementById('video-player');
  if (video && row) video.currentTime = row.start_ms / 1000;
}

function snapTime(ms) {
  return snapMs(ms, state.settings?.snap_to_second);
}

function startTimeEdit(btn, rowId, field) {
  const row = state.project?.rows.find(r => r.id === rowId);
  if (!row) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'time-input';
  input.value = msToDisplay(row[field]);
  input.title = 'HH:MM:SS.mmm — Enter to save, Esc to cancel';
  btn.replaceWith(input);
  input.focus();
  input.select();

  let cancelled = false;
  const restore = (ms) => {
    const button = document.createElement('button');
    button.className = 'time-btn';
    button.dataset.action = field === 'end_ms' ? 'set-end' : 'set-start';
    button.title = field === 'end_ms'
      ? 'Double-click to edit · click to set OUT from playhead'
      : 'Double-click to edit · click to set IN from playhead';
    button.textContent = msToDisplay(ms);
    input.replaceWith(button);
    button.addEventListener('dblclick', e => {
      e.preventDefault();
      e.stopPropagation();
      suppressTimeClickUntil = Date.now() + 400;
      startTimeEdit(button, rowId, field);
    });
  };

  const commit = () => {
    if (cancelled) return;
    const parsed = displayToMs(input.value);
    if (parsed === null) {
      toast('Invalid time — use HH:MM:SS.mmm', 'warning');
      restore(row[field]);
      return;
    }
    pushHistory();
    updateRow(rowId, { [field]: parsed });
    const updated = state.project?.rows.find(r => r.id === rowId);
    restore(updated?.[field] ?? parsed);
    renderTimeline();
  };

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelled = true;
      restore(row[field]);
    }
  });
  input.addEventListener('blur', commit);
}

async function runDuplicateRow(id) {
  const choice = await promptDuplicateRow();
  if (!choice || choice === 'cancel') return;
  pushHistory();
  duplicateRow(id, choice);
  renderRows();
}

function showContextMenu(x, y, rowId) {
  if (!contextMenu) return;
  state.contextRowId = rowId;
  contextMenu.classList.remove('hidden');
  contextMenu.style.left = `${x}px`;
  contextMenu.style.top = `${y}px`;
}

function hideContextMenu() {
  if (!contextMenu) return;
  contextMenu.classList.add('hidden');
  state.contextRowId = null;
}

function handleRowAction(id, action) {
  const row = state.project?.rows.find(r => r.id === id);
  if (!row) return;
  const video = document.getElementById('video-player');
  const currentMs = snapTime(secToMs(video?.currentTime ?? 0));

  switch (action) {
    case 'duplicate':
      runDuplicateRow(id);
      break;
    case 'split':
      if (currentMs <= row.start_ms || currentMs >= row.end_ms) {
        toast('Move playhead inside the row to split', 'warning');
        return;
      }
      pushHistory();
      splitRow(id, currentMs);
      renderRows();
      break;
    case 'merge': {
      const idx = state.project.rows.findIndex(r => r.id === id);
      if (idx < 0 || idx >= state.project.rows.length - 1) {
        toast('No next row to merge', 'warning');
        break;
      }
      pushHistory();
      mergeRow(id);
      renderRows();
      break;
    }
    case 'delete':
      pushHistory();
      deleteRow(id);
      purgeRowEditorCache(id);
      renderRows();
      break;
  }
}

document.addEventListener('click', e => {
  if (contextMenu && !contextMenu.contains(e.target)) hideContextMenu();
});

contextMenu?.addEventListener('click', e => {
  const btn = e.target.closest('[data-ctx]');
  if (!btn || !state.contextRowId) return;
  handleRowAction(state.contextRowId, btn.dataset.ctx);
  hideContextMenu();
});

const throttledScrollRender = throttle(() => {
  const filtered = getFilteredRows();
  const total = filtered.length;
  const scrollTop = scrollEl?.scrollTop ?? 0;
  const viewH = scrollEl?.clientHeight ?? 600;
  let start = Math.floor(scrollTop / ROW_HEIGHT) - VISIBLE_BUFFER;
  let end = start + Math.ceil(viewH / ROW_HEIGHT) + VISIBLE_BUFFER * 2;
  start = Math.max(0, start);
  end = Math.min(total, end);
  if (start !== renderedRange.start || end !== renderedRange.end) {
    renderRows();
  }
}, SCROLL_RENDER_THROTTLE_MS);

scrollEl?.addEventListener('scroll', throttledScrollRender);

searchInput?.addEventListener('input', e => {
  setRowSearchQuery(e.target.value);
  if (scrollEl) scrollEl.scrollTop = 0;
  renderRows();
});

container?.addEventListener('input', e => {
  const input = e.target;
  const field = input.dataset.field;
  if (!field) return;
  const id = input.closest('.lyric-row')?.dataset.id;
  if (!id) return;
  if (editingRowId !== id) {
    pushHistory();
    editingRowId = id;
  }
  updateRow(id, { [field]: input.value });
});

container?.addEventListener('focusout', e => {
  if (e.target.dataset?.field) editingRowId = null;
});

container?.addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const id  = btn.closest('.lyric-row')?.dataset.id;
  const row = state.project?.rows.find(r => r.id === id);
  if (!row) return;

  const video = document.getElementById('video-player');
  const currentMs = snapTime(secToMs(video?.currentTime ?? 0));

  switch (btn.dataset.action) {
    case 'set-start':
      if (Date.now() < suppressTimeClickUntil) return;
      pushHistory();
      updateRow(id, { start_ms: currentMs });
      btn.textContent = msToDisplay(currentMs);
      renderTimeline();
      break;
    case 'set-end':
      if (Date.now() < suppressTimeClickUntil) return;
      pushHistory();
      updateRow(id, { end_ms: currentMs });
      btn.textContent = msToDisplay(currentMs);
      renderTimeline();
      break;
    case 'open-anim':
      openAnimModal(id);
      break;
    case 'duplicate':
    case 'split':
    case 'merge':
    case 'delete':
      handleRowAction(id, btn.dataset.action);
      break;
  }
});

document.getElementById('btn-add-row')?.addEventListener('click', () => {
  if (!state.project) return;
  const video = document.getElementById('video-player');
  const curMs = snapTime(secToMs(video?.currentTime ?? 0));
  pushHistory();
  addRow(curMs, curMs + DEFAULT_ROW_MS);
  renderRows();
  if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
});

export function highlightActiveRow(currentMs) {
  const rows = state.project?.rows ?? [];
  const active = rows.find(r => currentMs >= r.start_ms && currentMs <= r.end_ms);
  if (active && active.id !== state.activeRowId) {
    state.activeRowId = active.id;
    container?.querySelectorAll('.lyric-row').forEach(el => {
      el.classList.toggle('active', el.dataset.id === state.activeRowId);
    });
    scrollActiveRowIntoView();
  }
}

export function syncActiveRowHighlight() {
  if (!state.activeRowId || !container) return;
  container.querySelectorAll('.lyric-row').forEach(el => {
    el.classList.toggle('active', el.dataset.id === state.activeRowId);
  });
}