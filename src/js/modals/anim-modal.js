import { state, updateRow } from '../state.js';
import { animOptions, escHtml } from '../utils.js';
import { renderRows } from '../editor.js';
import { pushHistory } from '../history.js';
import { showModal, hideModal } from './_shared.js';

export function openAnimModal(rowId) {
  if (!state.settings || !state.project) return;
  state.pendingAnimRowId = rowId;
  const row = state.project.rows.find(r => r.id === rowId);
  if (!row) return;

  const s = state.settings;
  const content = document.getElementById('anim-content');

  const buildTrackAnim = (trackKey, label, rowField) => {
    const def = s[trackKey + '_anim'];
    const ov  = row[rowField] ?? {};
    return `
    <div class="section-title">${label}</div>
    <div class="anim-grid">
      <label>Anim In
        <select data-row-anim="${rowField}" data-field="anim_in">
          ${animOptions(ov.anim_in ?? def.anim_in)}
        </select>
      </label>
      <label>Duration In (ms)
        <input type="number" data-row-anim="${rowField}" data-field="duration_in_ms"
          value="${ov.duration_in_ms ?? def.duration_in_ms}" min="0" max="5000" />
      </label>
      <label>Delay (ms)
        <input type="number" data-row-anim="${rowField}" data-field="delay_ms"
          value="${ov.delay_ms ?? def.delay_ms}" min="0" max="5000" />
      </label>
      <label>Anim Out
        <select data-row-anim="${rowField}" data-field="anim_out">
          ${animOptions(ov.anim_out ?? def.anim_out)}
        </select>
      </label>
      <label>Duration Out (ms)
        <input type="number" data-row-anim="${rowField}" data-field="duration_out_ms"
          value="${ov.duration_out_ms ?? def.duration_out_ms}" min="0" max="5000" />
      </label>
    </div>
    <label>Raw ASS In <small>e.g. \\fad(500,0)\\blur3</small>
      <input type="text" data-row-anim="${rowField}" data-field="raw_ass_in"
        value="${escHtml(ov.raw_ass_in ?? '')}" placeholder="Optional override tags" />
    </label>
    <label>Raw ASS Out
      <input type="text" data-row-anim="${rowField}" data-field="raw_ass_out"
        value="${escHtml(ov.raw_ass_out ?? '')}" placeholder="Optional override tags" />
    </label>`;
  };

  content.innerHTML =
    buildTrackAnim('romaji',  'Romaji',  'romaji_anim') +
    buildTrackAnim('indo',    'Indo',    'indo_anim') +
    buildTrackAnim('english', 'English', 'english_anim');

  showModal('modal-anim');
}

document.getElementById('btn-anim-save')?.addEventListener('click', () => {
  const id = state.pendingAnimRowId;
  if (!id) return;
  const content = document.getElementById('anim-content');
  const patch = {};

  content.querySelectorAll('[data-row-anim][data-field]').forEach(el => {
    const field = el.dataset.rowAnim;
    const key   = el.dataset.field;
    if (!patch[field]) patch[field] = {};
    let val = el.type === 'number' ? Number(el.value) : el.value;
    if ((key === 'raw_ass_in' || key === 'raw_ass_out') && !val.trim()) val = null;
    patch[field][key] = val;
  });

  pushHistory();
  updateRow(id, patch);
  renderRows();
  hideModal('modal-anim');
});

document.getElementById('btn-anim-reset')?.addEventListener('click', () => {
  const id = state.pendingAnimRowId;
  if (!id) return;
  pushHistory();
  updateRow(id, { romaji_anim: null, indo_anim: null, english_anim: null });
  renderRows();
  hideModal('modal-anim');
});

document.getElementById('btn-anim-cancel')?.addEventListener('click', () => {
  hideModal('modal-anim');
});