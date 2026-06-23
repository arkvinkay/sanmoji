/**
 * Modal logic: Settings, Export, Batch, Animation Override, Relink
 */
import { state, updateRow, scaleAllRows } from './state.js';
import { animOptions, msToDisplay, escHtml, setProgressBar } from './utils.js';
import { renderRows } from './editor.js';
import { invoke, dialog } from './tauri.js';
import { pushHistory } from './history.js';
import { toast } from './toast.js';
import { refreshWatermark, renderOverlay, invalidateOverlay } from './overlay.js';

import {
  APP_NAME, APP_VERSION, APP_TAGLINE, APP_DESCRIPTION,
  APP_CREATOR, APP_GITHUB, formatById,
} from './app-info.js';
import { openModal, closeModal, initModalBackdropClose, openChoiceModal } from './modal-manager.js';
import { populateFontSelect, refreshSystemFonts, updateFontPreview } from './fonts.js';
import { ensureShortcuts, SHORTCUT_ACTIONS, formatShortcut } from './shortcuts.js';
import { fetchSettings } from './settings-api.js';
import { DEFAULT_SHORTCUTS } from './constants.js';
import { invalidateTimeline } from './timeline.js';
import { applyTheme, themeOptions } from './themes.js';
import { hasBlockingErrors } from './validation.js';

function showModal(id, opts = {}) {
  const el = document.getElementById(id);
  if (!el) return;
  openModal(el, { onEscape: opts.onEscape ?? (() => hideModal(id)) });
}

function hideModal(id) {
  const el = document.getElementById(id);
  if (el) closeModal(el);
}

initModalBackdropClose();

// ═══════════════════════════════════════════════════════
// EXPORT PROGRESS
// ═══════════════════════════════════════════════════════
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

function resetCutProgress() {
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

function startExportProgress() {
  const bar = document.getElementById('export-progress-bar');
  const wrap = document.getElementById('export-progress');
  const text = document.getElementById('export-progress-text');
  setProgressBar(bar, 0);
  if (wrap) wrap.classList.remove('hidden');
  if (text) text.textContent = 'Starting export…';
}

function setExportModalLocked(locked) {
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

function isExportInProgress() {
  const wrap = document.getElementById('export-progress');
  return wrap && !wrap.classList.contains('hidden');
}

function renderValidationList(issues) {
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

function refreshPresetListUI() {
  const presets = state.settings?.style_presets ?? [];
  const select = document.getElementById('preset-select');
  if (select) {
    const prev = select.value;
    select.innerHTML = '<option value="">— Select preset —</option>' +
      presets.map((p, i) => `<option value="${i}">${escHtml(p.name)}</option>`).join('');
    if (prev !== '' && Number(prev) < presets.length) select.value = prev;
  }
  const list = document.getElementById('preset-list');
  if (list) {
    list.innerHTML = presets.map(p =>
      `<div class="preset-item"><span>${escHtml(p.name)}</span></div>`
    ).join('') || '<span class="dim-text">No presets saved</span>';
  }
}

// ═══════════════════════════════════════════════════════
// SETTINGS MODAL
// ═══════════════════════════════════════════════════════
export async function openSettingsModal(initialTab = 'layout') {
  await refreshSystemFonts(false);
  if (!state.settings) {
    toast('Settings not loaded yet', 'error');
    return;
  }
  const content = document.getElementById('settings-content');
  const s = state.settings;

  const presets = s.style_presets ?? [];
  const presetOptions = presets.map((p, i) =>
    `<option value="${i}">${escHtml(p.name)}</option>`
  ).join('');

  content.innerHTML = `
    <div class="settings-tabs">
      <button class="tab-btn" data-tab="layout">Layout Y</button>
      <button class="tab-btn" data-tab="romaji">Romaji</button>
      <button class="tab-btn" data-tab="indo">Indo</button>
      <button class="tab-btn" data-tab="english">English</button>
      <button class="tab-btn" data-tab="watermark">Watermark</button>
      <button class="tab-btn" data-tab="general">General</button>
    </div>
    ${layoutPanel(s)}
    ${trackPanel('romaji', 'Romaji (JP)', s.romaji, s.romaji_anim)}
    ${trackPanel('indo', 'Indo', s.indo, s.indo_anim)}
    ${trackPanel('english', 'English', s.english, s.english_anim)}
    <div class="tab-panel" data-panel="watermark">
      <label class="row-inline" style="flex-direction:row;align-items:center;gap:8px">
        <input type="checkbox" id="wm-enabled" ${s.watermark.enabled ? 'checked' : ''} />
        <span>Enable Watermark</span>
      </label>
      <label>Image File (PNG/JPG recommended)
        <div class="row-inline">
          <input type="text" id="wm-path" value="${escHtml(s.watermark.file_path)}" readonly />
          <button type="button" id="btn-wm-browse">Browse</button>
        </div>
      </label>
      <div class="track-settings">
        <label>Width (px)<input type="number" id="wm-w" value="${s.watermark.width}" min="10" max="500" /></label>
        <label>Height (px)<input type="number" id="wm-h" value="${s.watermark.height}" min="10" max="500" /></label>
        <label>Margin Right (px)<input type="number" id="wm-mx" value="${s.watermark.margin_x}" min="0" /></label>
        <label>Margin Bottom (px)<input type="number" id="wm-my" value="${s.watermark.margin_y}" min="0" /></label>
      </div>
      <div class="section-title" style="margin-top:10px">Animation</div>
      <div class="track-settings">
        <label>Anim IN
          <select id="wm-anim-in">
            <option value="glitch"${s.watermark.anim_in === 'glitch' ? ' selected' : ''}>Glitch</option>
            <option value="fade"${s.watermark.anim_in === 'fade' ? ' selected' : ''}>Fade</option>
            <option value="none"${s.watermark.anim_in === 'none' ? ' selected' : ''}>None</option>
          </select>
        </label>
        <label>Anim OUT
          <select id="wm-anim-out">
            <option value="glitch"${s.watermark.anim_out === 'glitch' ? ' selected' : ''}>Glitch</option>
            <option value="fade"${s.watermark.anim_out === 'fade' ? ' selected' : ''}>Fade</option>
            <option value="none"${s.watermark.anim_out === 'none' ? ' selected' : ''}>None</option>
          </select>
        </label>
        <label>IN duration (ms)<input type="number" id="wm-dur-in" value="${s.watermark.duration_in_ms ?? 400}" min="0" max="5000" step="50" /></label>
        <label>OUT duration (ms)<input type="number" id="wm-dur-out" value="${s.watermark.duration_out_ms ?? 400}" min="0" max="5000" step="50" /></label>
      </div>
      <div class="section-title" style="margin-top:10px">Caption</div>
      <label>Text<input type="text" id="wm-text" value="${escHtml(s.watermark.text ?? '')}" placeholder="e.g. @channelname" /></label>
      <div class="track-settings">
        <label>Position
          <select id="wm-text-position">
            <option value="below"${(s.watermark.text_position ?? 'below') === 'below' ? ' selected' : ''}>Below image</option>
            <option value="above"${s.watermark.text_position === 'above' ? ' selected' : ''}>Above image</option>
            <option value="beside"${s.watermark.text_position === 'beside' ? ' selected' : ''}>Beside image (left)</option>
          </select>
        </label>
        <label>Gap (px)<input type="number" id="wm-text-gap" value="${s.watermark.text_gap ?? 4}" min="0" max="40" title="Space between image and caption" /></label>
        <label>Size (px)<input type="number" id="wm-text-size" value="${s.watermark.text_size ?? 14}" min="8" max="72" /></label>
        <label>Font
          <select class="font-select" id="wm-text-font" data-wm-field="text_font" data-current="${escHtml(s.watermark.text_font ?? 'Arial')}" data-preview-for="wm-font-preview" data-bold-field="wm-text-bold">
            <option value="${escHtml(s.watermark.text_font ?? 'Arial')}">${escHtml(s.watermark.text_font ?? 'Arial')}</option>
          </select>
        </label>
        <div id="wm-font-preview" class="font-preview" aria-live="polite">Aa Bb 123</div>
        <button type="button" id="btn-refresh-fonts" class="btn-refresh-fonts" title="Rescan Windows registry (HKLM+HKCU) and font folders">↻ Refresh font list</button>
        <p class="dim-text font-list-hint">Fonts are loaded from Windows registry and font folders. After installing a new font, click Refresh — no restart needed.</p>
        <label>Color
          <div class="color-row">
            <input type="color" id="wm-text-color" data-wm-field="text_color" value="${s.watermark.text_color ?? '#FFFFFF'}" />
            <span>${s.watermark.text_color ?? '#FFFFFF'}</span>
          </div>
        </label>
        <label>Outline Color
          <div class="color-row">
            <input type="color" id="wm-text-outline-color" data-wm-field="text_outline_color" value="${s.watermark.text_outline_color ?? '#000000'}" />
            <span>${s.watermark.text_outline_color ?? '#000000'}</span>
          </div>
        </label>
        <label>Outline Size
          <input type="number" id="wm-text-outline-size" data-wm-field="text_outline_size" value="${s.watermark.text_outline_size ?? 1}" min="0" max="20" step="0.5" />
        </label>
        <label>Bold
          <input type="checkbox" id="wm-text-bold" data-wm-field="text_bold" ${s.watermark.text_bold ? 'checked' : ''} />
        </label>
        <label>Shadow
          <input type="checkbox" id="wm-text-shadow" data-wm-field="text_shadow" ${s.watermark.text_shadow !== false ? 'checked' : ''} />
        </label>
      </div>
    </div>
    <div class="tab-panel" data-panel="general">
      <div class="section-title">Appearance</div>
      <label>Theme
        <select id="ui-theme" title="Application color theme">
          ${themeOptions(s.theme)}
        </select>
      </label>
      <p class="dim-text" style="margin-top:4px">Preview updates when you save settings.</p>
      <div class="section-title" style="margin-top:12px">Style Presets</div>
      <div class="preset-row">
        <select id="preset-select">
          <option value="">— Select preset —</option>
          ${presetOptions}
        </select>
        <button type="button" id="btn-preset-load">Load</button>
        <button type="button" id="btn-preset-delete">Delete</button>
      </div>
      <div class="preset-row">
        <input type="text" id="preset-name" placeholder="Preset name…" />
        <button type="button" id="btn-preset-save">Save Current</button>
      </div>
      <div class="preset-list" id="preset-list">
        ${presets.map(p => `<div class="preset-item"><span>${escHtml(p.name)}</span></div>`).join('') || '<span class="dim-text">No presets saved</span>'}
      </div>
      <div class="section-title" style="margin-top:8px">Autosave</div>
      <label class="row-inline" style="flex-direction:row;align-items:center;gap:8px">
        <input type="checkbox" id="autosave-enabled" ${s.autosave_enabled !== false ? 'checked' : ''} />
        <span>Autosave draft every 30 seconds</span>
      </label>
    </div>
  `;

  content.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => activateSettingsTab(btn.dataset.tab));
  });
  activateSettingsTab(initialTab);

  document.getElementById('btn-wm-browse')?.addEventListener('click', async () => {
    const path = await dialog.open({ filters: [{ name: 'Image', extensions: ['png','jpg','jpeg','webp'] }] });
    if (path) document.getElementById('wm-path').value = path;
  });

  document.getElementById('btn-preset-save')?.addEventListener('click', () => {
    const name = document.getElementById('preset-name')?.value?.trim();
    if (!name) { toast('Enter a preset name', 'warning'); return; }
    const preset = {
      name,
      romaji: { ...state.settings.romaji },
      indo: { ...state.settings.indo },
      english: { ...state.settings.english },
      romaji_anim: { ...state.settings.romaji_anim },
      indo_anim: { ...state.settings.indo_anim },
      english_anim: { ...state.settings.english_anim },
    };
    if (!state.settings.style_presets) state.settings.style_presets = [];
    const existing = state.settings.style_presets.findIndex(p => p.name === name);
    if (existing >= 0) state.settings.style_presets[existing] = preset;
    else state.settings.style_presets.push(preset);
    toast(`Preset "${name}" saved`, 'success');
    refreshPresetListUI();
    const nameInput = document.getElementById('preset-name');
    if (nameInput) nameInput.value = '';
  });

  document.getElementById('btn-preset-load')?.addEventListener('click', () => {
    const idx = document.getElementById('preset-select')?.value;
    if (idx === '' || idx === undefined) { toast('Select a preset', 'warning'); return; }
    const preset = state.settings.style_presets[Number(idx)];
    if (!preset) return;
    applyPreset(preset);
    toast(`Loaded preset "${preset.name}"`, 'success');
    const content = document.getElementById('settings-content');
    content?.querySelectorAll('[data-track][data-field]').forEach(el => {
      const track = el.dataset.track;
      const field = el.dataset.field;
      const val = state.settings[track]?.[field];
      if (val === undefined) return;
      if (el.type === 'checkbox') el.checked = !!val;
      else el.value = val;
      if (field === 'pos_y_percent') {
        const lbl = document.getElementById(`py-val-${track}`);
        if (lbl) lbl.textContent = (val * 100).toFixed(1) + '%';
      }
    });
    content?.querySelectorAll('[data-anim][data-field]').forEach(el => {
      const track = el.dataset.anim + '_anim';
      const field = el.dataset.field;
      const val = state.settings[track]?.[field];
      if (val !== undefined) el.value = val;
    });
    const video = document.getElementById('video-player');
    renderOverlay(Math.round((video?.currentTime ?? 0) * 1000));
  });

  document.getElementById('btn-preset-delete')?.addEventListener('click', () => {
    const idx = document.getElementById('preset-select')?.value;
    if (idx === '' || idx === undefined) { toast('Select a preset', 'warning'); return; }
    const name = state.settings.style_presets[Number(idx)]?.name;
    state.settings.style_presets.splice(Number(idx), 1);
    toast(`Deleted preset "${name}"`, 'info');
    refreshPresetListUI();
  });

  content.querySelectorAll('select.font-select').forEach(sel => {
    populateFontSelect(sel, sel.dataset.current);
    sel.addEventListener('change', () => updateFontPreview(sel));
  });
  document.getElementById('btn-refresh-fonts')?.addEventListener('click', () => {
    refreshSystemFonts(true);
  });
  document.getElementById('wm-text-bold')?.addEventListener('change', () => {
    const sel = document.getElementById('wm-text-font');
    if (sel) updateFontPreview(sel);
  });
  content.querySelectorAll('#wm-text, #wm-text-size, #wm-text-color, #wm-text-gap, #wm-text-position, #wm-text-font, #wm-text-bold, #wm-text-outline-color, #wm-text-outline-size, #wm-text-shadow').forEach(el => {
    const handler = () => applyLiveWatermarkCaption();
    el.addEventListener('input', handler);
    el.addEventListener('change', handler);
  });
  content.querySelectorAll('[data-track][data-field="bold"]').forEach(el => {
    el.addEventListener('change', () => {
      const track = el.dataset.track;
      const sel = content.querySelector(`select.font-select[data-track="${track}"]`);
      if (sel) updateFontPreview(sel);
    });
  });

  showModal('modal-settings');
}

function activateSettingsTab(tab) {
  const content = document.getElementById('settings-content');
  if (!content) return;
  const tabId = content.querySelector(`[data-panel="${tab}"]`) ? tab : 'layout';
  content.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tabId);
  });
  content.querySelectorAll('.tab-panel').forEach(p => {
    p.classList.toggle('active', p.dataset.panel === tabId);
  });
}

function layoutTrackRow(key, label, style) {
  return `
    <div class="layout-track">
      <div class="layout-track-head"><strong>${label}</strong></div>
      <div class="layout-fields">
        <label>Position Y <span class="layout-y-val" id="py-val-${key}">${(style.pos_y_percent * 100).toFixed(1)}%</span>
          <input type="range" data-track="${key}" data-field="pos_y_percent"
            value="${style.pos_y_percent}" min="0.55" max="0.98" step="0.005" />
        </label>
      </div>
    </div>`;
}

function layoutPanel(s) {
  return `
  <div class="tab-panel" data-panel="layout">
    <p class="dim-text">Vertical position for each track. Font, size, and color are in the Romaji / Indo / English tabs. Changes update the main video preview — click <strong>Save</strong> to persist.</p>
    <div class="layout-split">
      <div class="layout-controls">
        ${layoutTrackRow('romaji', 'Romaji (三)', s.romaji)}
        ${layoutTrackRow('indo', 'Indonesian', s.indo)}
        ${layoutTrackRow('english', 'English', s.english)}
      </div>
    </div>
  </div>`;
}

function applyLiveSettingChange(el) {
  const track = el.dataset.track;
  const field = el.dataset.field;
  if (!track || !field || !state.settings?.[track]) return;
  let val;
  if (el.type === 'checkbox') val = el.checked;
  else if (el.type === 'number' || el.type === 'range') val = Number(el.value);
  else val = el.value;
  state.settings[track][field] = val;
  if (field === 'pos_y_percent') {
    const lbl = document.getElementById(`py-val-${track}`);
    if (lbl) lbl.textContent = (val * 100).toFixed(1) + '%';
  }
  const video = document.getElementById('video-player');
  renderOverlay(Math.round((video?.currentTime ?? 0) * 1000));
}

function applyPreset(preset) {
  state.settings.romaji = { ...preset.romaji };
  state.settings.indo = { ...preset.indo };
  state.settings.english = { ...preset.english };
  state.settings.romaji_anim = { ...preset.romaji_anim };
  state.settings.indo_anim = { ...preset.indo_anim };
  state.settings.english_anim = { ...preset.english_anim };
}

function trackPanel(key, label, style, anim) {
  return `
  <div class="tab-panel" data-panel="${key}">
    <div class="section-title">${label} — Style</div>
    <div class="track-settings">
      <label class="settings-size-field">Size (px)
        <input type="number" data-track="${key}" data-field="size" value="${style.size}" min="8" max="200" />
      </label>
      <label>Font
        <select class="font-select" data-track="${key}" data-field="font" data-current="${escHtml(style.font)}" data-preview-for="font-preview-${key}" data-bold-field="${key}-bold">
          <option value="${escHtml(style.font)}">${escHtml(style.font)}</option>
        </select>
      </label>
      <div id="font-preview-${key}" class="font-preview" aria-live="polite">Aa Bb 123</div>
      <label>Color
        <div class="color-row">
          <input type="color" data-track="${key}" data-field="color" value="${style.color}" />
          <span>${style.color}</span>
        </div>
      </label>
      <label>Outline Color
        <div class="color-row">
          <input type="color" data-track="${key}" data-field="outline_color" value="${style.outline_color}" />
          <span>${style.outline_color}</span>
        </div>
      </label>
      <label>Outline Size
        <input type="number" data-track="${key}" data-field="outline_size" value="${style.outline_size}" min="0" max="20" step="0.5" />
      </label>
      <label>Bold
        <input type="checkbox" data-track="${key}" data-field="bold" id="${key}-bold" ${style.bold ? 'checked' : ''} />
      </label>
      <label>Shadow
        <input type="checkbox" data-track="${key}" data-field="shadow" ${style.shadow ? 'checked' : ''} />
      </label>
    </div>
    <div class="section-title" style="margin-top:8px">${label} — Default Animation</div>
    <div class="anim-grid">
      <label>Anim In
        <select data-anim="${key}" data-field="anim_in">${animOptions(anim.anim_in)}</select>
      </label>
      <label>Duration In (ms)
        <input type="number" data-anim="${key}" data-field="duration_in_ms" value="${anim.duration_in_ms}" min="0" max="5000" />
      </label>
      <label>Delay (ms)
        <input type="number" data-anim="${key}" data-field="delay_ms" value="${anim.delay_ms}" min="0" max="5000" />
      </label>
      <label>Anim Out
        <select data-anim="${key}" data-field="anim_out">${animOptions(anim.anim_out)}</select>
      </label>
      <label>Duration Out (ms)
        <input type="number" data-anim="${key}" data-field="duration_out_ms" value="${anim.duration_out_ms}" min="0" max="5000" />
      </label>
    </div>
  </div>`;
}

function applyLiveWatermarkCaption() {
  if (!state.settings) return;
  const wm = state.settings.watermark;
  wm.text = document.getElementById('wm-text')?.value ?? '';
  wm.text_size = Number(document.getElementById('wm-text-size')?.value) || 14;
  wm.text_color = document.getElementById('wm-text-color')?.value ?? '#FFFFFF';
  wm.text_gap = Number(document.getElementById('wm-text-gap')?.value) || 0;
  wm.text_position = document.getElementById('wm-text-position')?.value ?? 'below';
  wm.text_font = document.getElementById('wm-text-font')?.value ?? 'Arial';
  wm.text_bold = document.getElementById('wm-text-bold')?.checked ?? false;
  wm.text_outline_color = document.getElementById('wm-text-outline-color')?.value ?? '#000000';
  wm.text_outline_size = Number(document.getElementById('wm-text-outline-size')?.value) || 0;
  wm.text_shadow = document.getElementById('wm-text-shadow')?.checked ?? true;
  invalidateOverlay();
  refreshWatermark();
  const video = document.getElementById('video-player');
  renderOverlay(Math.round((video?.currentTime ?? 0) * 1000));
}

function onSettingsLiveInput(e) {
  const el = e.target;
  if (!el.dataset?.track || !el.dataset?.field) return;
  applyLiveSettingChange(el);
}

document.getElementById('settings-content')?.addEventListener('input', onSettingsLiveInput);
document.getElementById('settings-content')?.addEventListener('change', onSettingsLiveInput);

function collectSettings() {
  const s = JSON.parse(JSON.stringify(state.settings));
  const content = document.getElementById('settings-content');

  content.querySelectorAll('[data-track][data-field]').forEach(el => {
    const track = el.dataset.track;
    const field = el.dataset.field;
    let val;
    if (el.type === 'checkbox') val = el.checked;
    else if (el.type === 'number' || el.type === 'range') val = Number(el.value);
    else val = el.value;
    s[track][field] = val;
  });

  content.querySelectorAll('[data-anim][data-field]').forEach(el => {
    const track = el.dataset.anim + '_anim';
    const field = el.dataset.field;
    const val = el.type === 'number' ? Number(el.value) : el.value;
    s[track][field] = val;
  });

  s.watermark.enabled   = document.getElementById('wm-enabled')?.checked ?? false;
  s.watermark.file_path = document.getElementById('wm-path')?.value ?? '';
  s.watermark.width     = Number(document.getElementById('wm-w')?.value) || 0;
  s.watermark.height    = Number(document.getElementById('wm-h')?.value) || 0;
  s.watermark.margin_x  = Number(document.getElementById('wm-mx')?.value) || 0;
  s.watermark.margin_y  = Number(document.getElementById('wm-my')?.value) || 0;
  s.watermark.anim_in         = document.getElementById('wm-anim-in')?.value ?? 'glitch';
  s.watermark.anim_out        = document.getElementById('wm-anim-out')?.value ?? 'glitch';
  s.watermark.duration_in_ms  = Number(document.getElementById('wm-dur-in')?.value) || 0;
  s.watermark.duration_out_ms = Number(document.getElementById('wm-dur-out')?.value) || 0;
  s.watermark.text            = document.getElementById('wm-text')?.value ?? '';
  s.watermark.text_size       = Number(document.getElementById('wm-text-size')?.value) || 14;
  s.watermark.text_color      = document.getElementById('wm-text-color')?.value ?? '#FFFFFF';
  s.watermark.text_gap        = Number(document.getElementById('wm-text-gap')?.value) || 0;
  s.watermark.text_position   = document.getElementById('wm-text-position')?.value ?? 'below';
  s.watermark.text_font       = document.getElementById('wm-text-font')?.value ?? 'Arial';
  s.watermark.text_bold       = document.getElementById('wm-text-bold')?.checked ?? false;
  s.watermark.text_outline_color = document.getElementById('wm-text-outline-color')?.value ?? '#000000';
  s.watermark.text_outline_size  = Number(document.getElementById('wm-text-outline-size')?.value) || 0;
  s.watermark.text_shadow     = document.getElementById('wm-text-shadow')?.checked ?? true;
  s.autosave_enabled    = document.getElementById('autosave-enabled')?.checked ?? true;
  s.theme               = document.getElementById('ui-theme')?.value ?? 'dark';

  return s;
}

document.getElementById('btn-settings-save')?.addEventListener('click', async () => {
  const s = collectSettings();
  try {
    await invoke('save_settings', { settings: s });
  } catch (err) {
    toast('Failed to save settings: ' + err, 'error');
    return;
  }
  state.settings = s;
  applyTheme(s.theme);
  hideModal('modal-settings');
  refreshWatermark();
  renderRows();
  toast('Settings saved', 'success');
});

document.getElementById('btn-settings-cancel')?.addEventListener('click', () => {
  hideModal('modal-settings');
});

// ═══════════════════════════════════════════════════════
// ABOUT MODAL
// ═══════════════════════════════════════════════════════
export function openAboutModal() {
  const el = document.getElementById('about-content');
  if (!el) return;
  const aboutTitle = document.getElementById('about-title');
  if (aboutTitle) aboutTitle.textContent = `About ${APP_NAME}`;
  el.innerHTML = `
    <p class="about-tagline"><strong>${APP_NAME}</strong> v${APP_VERSION}</p>
    <p class="about-etymology dim-text">三 (San) = three · 文字 (Moji) = characters</p>
    <p class="dim-text">${APP_TAGLINE}</p>
    <p>${APP_DESCRIPTION}</p>
    <div class="section-title">Source</div>
    <p><a href="${APP_GITHUB}" class="about-link" target="_blank" rel="noopener">${APP_GITHUB}</a></p>
    <div class="section-title">License</div>
    <p class="about-license">
      <strong>${APP_NAME}</strong> source code is licensed under the <strong>MIT License</strong>.
    </p>
    <p class="about-license">
      Video export uses <strong>FFmpeg</strong> (GNU GPL). FFmpeg may be downloaded automatically on first use if not bundled.
    </p>
    <div class="section-title">Third-Party</div>
    <ul class="about-list">
      <li><strong>Tauri</strong> — MIT / Apache-2.0</li>
      <li><strong>FFmpeg</strong> — GPL</li>
    </ul>
    <p class="dim-text">© 2026 ${APP_CREATOR} · ${APP_NAME}</p>
  `;
  showModal('modal-about');
}

document.getElementById('btn-about-close')?.addEventListener('click', () => {
  hideModal('modal-about');
});

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

function swapPathExtension(path, ext) {
  if (!path) return path;
  const base = path.replace(/\.[^./\\]+$/, '');
  return `${base}.${ext}`;
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

// ═══════════════════════════════════════════════════════
// EXPORT MODAL
// ═══════════════════════════════════════════════════════
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
  await invoke('save_settings', { settings: state.settings });

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

  setExportModalLocked(true);
  startExportProgress();

  try {
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

// ═══════════════════════════════════════════════════════
// EXPORT SUBTITLES MODAL
// ═══════════════════════════════════════════════════════
const SUBS_FORMATS = {
  ass: { label: 'ASS Subtitle', extensions: ['ass'] },
  ssa: { label: 'SSA Subtitle', extensions: ['ssa'] },
  srt: { label: 'SRT Subtitle', extensions: ['srt'] },
  vtt: { label: 'WebVTT Subtitle', extensions: ['vtt'] },
};

function getSelectedSubsFormat() {
  return document.getElementById('subs-format')?.value ?? 'ass';
}

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

export function openExportSubsModal() {
  if (!state.project?.rows.length) {
    toast('Add subtitle rows first.', 'warning');
    return;
  }
  const fmt = getSelectedSubsFormat();
  const info = SUBS_FORMATS[fmt] ?? SUBS_FORMATS.ass;
  const pathEl = document.getElementById('subs-output-path');
  if (pathEl && !pathEl.value) {
    const base = state.projectPath
      ? state.projectPath.replace(/\.smpr$/i, '')
      : (state.project.video_path?.replace(/\.[^./\\]+$/, '') ?? 'subtitles');
    pathEl.value = `${base}.${info.extensions[0]}`;
  }
  showModal('modal-export-subs');
}

document.getElementById('subs-format')?.addEventListener('change', () => {
  const pathEl = document.getElementById('subs-output-path');
  if (!pathEl?.value) return;
  const fmt = getSelectedSubsFormat();
  const ext = SUBS_FORMATS[fmt]?.extensions[0] ?? 'ass';
  pathEl.value = swapPathExtension(pathEl.value, ext);
});

document.getElementById('btn-subs-browse')?.addEventListener('click', async () => {
  const fmt = getSelectedSubsFormat();
  const info = SUBS_FORMATS[fmt] ?? SUBS_FORMATS.ass;
  const path = await dialog.save({
    filters: [{ name: info.label, extensions: info.extensions }],
    defaultPath: `subtitles.${info.extensions[0]}`,
  });
  if (path) document.getElementById('subs-output-path').value = path;
});

document.getElementById('btn-subs-export')?.addEventListener('click', async () => {
  const outPath = document.getElementById('subs-output-path')?.value;
  if (!outPath) {
    toast('Select output file first.', 'warning');
    return;
  }
  const format = getSelectedSubsFormat();
  const exportBtn = document.getElementById('btn-subs-export');
  const cancelBtn = document.getElementById('btn-subs-cancel');
  if (exportBtn) exportBtn.disabled = true;
  if (cancelBtn) cancelBtn.disabled = true;
  toast(`Exporting ${format.toUpperCase()}…`, 'info', 2000);
  try {
    await invoke('export_subtitle_file', {
      project: state.project,
      outputPath: outPath,
      format,
      videoW: state.videoW,
      videoH: state.videoH,
    });
    toast(`${format.toUpperCase()} subtitles exported`, 'success');
    hideModal('modal-export-subs');
  } catch (err) {
    toast('Subtitle export failed: ' + err, 'error');
  } finally {
    if (exportBtn) exportBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = false;
  }
});

document.getElementById('btn-subs-export-all')?.addEventListener('click', async () => {
  const basePath = document.getElementById('subs-output-path')?.value;
  if (!basePath) {
    toast('Select output file first (used as base name).', 'warning');
    return;
  }
  const base = basePath.replace(/\.[^./\\]+$/, '');
  const formats = ['ass', 'srt', 'vtt'];
  let ok = 0;
  for (const format of formats) {
    const ext = SUBS_FORMATS[format]?.extensions[0] ?? format;
    try {
      await invoke('export_subtitle_file', {
        project: state.project,
        outputPath: `${base}.${ext}`,
        format,
        videoW: state.videoW,
        videoH: state.videoH,
      });
      ok++;
    } catch (err) {
      toast(`${format.toUpperCase()} export failed: ${err}`, 'error');
    }
  }
  if (ok === formats.length) {
    toast('Exported ASS, SRT, and VTT', 'success');
    hideModal('modal-export-subs');
  } else if (ok > 0) {
    toast(`Exported ${ok}/${formats.length} formats`, 'warning');
  }
});

document.getElementById('btn-subs-cancel')?.addEventListener('click', () => {
  hideModal('modal-export-subs');
});

// ═══════════════════════════════════════════════════════
// CUT VIDEO MODAL
// ═══════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════
// RELINK MODAL
// ═══════════════════════════════════════════════════════
let relinkResolve = null;

export function openRelinkModal(oldPath) {
  return new Promise(resolve => {
    relinkResolve = resolve;
    document.getElementById('relink-old-path').textContent = oldPath;
    document.getElementById('relink-path').value = '';
    showModal('modal-relink', {
      onEscape: () => {
        hideModal('modal-relink');
        if (relinkResolve) relinkResolve(null);
        relinkResolve = null;
      },
    });
  });
}

document.getElementById('btn-relink-browse')?.addEventListener('click', async () => {
  const path = await dialog.open({
    filters: [{ name: 'Video', extensions: ['mp4','mkv','mov','avi','webm','flv','ts','m4v'] }]
  });
  if (path) document.getElementById('relink-path').value = path;
});

document.getElementById('btn-relink-confirm')?.addEventListener('click', async () => {
  const newPath = document.getElementById('relink-path').value;
  if (!newPath) { toast('Select a video file', 'warning'); return; }
  hideModal('modal-relink');
  if (relinkResolve) relinkResolve(newPath);
  relinkResolve = null;
});

document.getElementById('btn-relink-cancel')?.addEventListener('click', () => {
  hideModal('modal-relink');
  if (relinkResolve) relinkResolve(null);
  relinkResolve = null;
});

// ═══════════════════════════════════════════════════════
// BATCH EXPORT MODAL
// ═══════════════════════════════════════════════════════
const batchProjects = [];

export function openBatchModal() {
  showModal('modal-batch');
  renderBatchList();
}

function renderBatchList() {
  const list = document.getElementById('batch-list');
  if (!batchProjects.length) {
    list.innerHTML = '<p class="dim-text">No projects added yet.</p>';
    return;
  }
  list.innerHTML = '';
  batchProjects.forEach((p, i) => {
    const item = document.createElement('div');
    item.className = 'batch-item';
    const label = document.createElement('span');
    label.textContent = p.split(/[\\/]/).pop();
    const rm = document.createElement('button');
    rm.className = 'btn-delete-row';
    rm.dataset.batchRm = String(i);
    rm.textContent = '×';
    rm.title = 'Remove from batch';
    item.appendChild(label);
    item.appendChild(rm);
    list.appendChild(item);
  });
  list.querySelectorAll('[data-batch-rm]').forEach(btn => {
    btn.addEventListener('click', () => {
      batchProjects.splice(Number(btn.dataset.batchRm), 1);
      renderBatchList();
    });
  });
}

document.getElementById('btn-batch-add')?.addEventListener('click', async () => {
  const paths = await dialog.open({
    multiple: true,
    filters: [{ name: 'SanMoji Project', extensions: ['smpr'] }]
  });
  if (!paths) return;
  const arr = Array.isArray(paths) ? paths : [paths];
  arr.forEach(p => { if (!batchProjects.includes(p)) batchProjects.push(p); });
  renderBatchList();
});

document.getElementById('btn-batch-clear')?.addEventListener('click', () => {
  batchProjects.length = 0;
  renderBatchList();
});

document.getElementById('btn-batch-dir')?.addEventListener('click', async () => {
  const dir = await dialog.open({ directory: true });
  if (dir) document.getElementById('batch-output-dir').value = dir;
});

document.getElementById('btn-batch-start')?.addEventListener('click', async () => {
  const outDir = document.getElementById('batch-output-dir').value;
  if (!batchProjects.length) { toast('Add at least one project.', 'warning'); return; }
  if (!outDir) { toast('Select output folder.', 'warning'); return; }

  const batchFmt = document.getElementById('batch-format')?.value ?? 'mp4';
  const items = batchProjects.map(p => {
    const base = p.split(/[\\/]/).pop().replace(/\.smpr$/i, '');
    const sep = outDir.includes('\\') ? '\\' : '/';
    return {
      projectPath: p,
      outputPath: `${outDir}${sep}${base}_export.${batchFmt}`,
      videoW: 0,
      videoH: 0,
    };
  });

  document.getElementById('batch-progress').classList.remove('hidden');
  document.getElementById('btn-batch-start').disabled = true;

  try {
    const results = await invoke('batch_export_videos', { items });
    const ok = results.filter(r => r.success).length;
    const fail = results.length - ok;
    if (fail) {
      const detail = results.filter(r => !r.success).map(r => `${r.project_path}: ${r.error}`).join('\n');
      toast(`Batch: ${ok} ok, ${fail} failed`, 'warning');
      console.warn(detail);
    } else {
      toast(`Batch complete: ${ok} succeeded`, 'success');
    }
  } catch (err) {
    toast('Batch export failed: ' + err, 'error');
  } finally {
    document.getElementById('batch-progress').classList.add('hidden');
    document.getElementById('btn-batch-start').disabled = false;
  }
});

document.getElementById('btn-batch-cancel')?.addEventListener('click', () => {
  hideModal('modal-batch');
});

// ═══════════════════════════════════════════════════════
// FIND & REPLACE
// ═══════════════════════════════════════════════════════
function escapeRegexLiteral(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildFindReplacer(find, repl, caseInsensitive, useRegex) {
  if (useRegex) {
    const flags = caseInsensitive ? 'gi' : 'g';
    const re = new RegExp(find, flags);
    return {
      replace(text) {
        if (!text) return { text, count: 0 };
        const matches = text.match(re);
        if (!matches?.length) return { text, count: 0 };
        return { text: text.replace(re, repl), count: matches.length };
      },
    };
  }
  if (caseInsensitive) {
    const re = new RegExp(escapeRegexLiteral(find), 'gi');
    return {
      replace(text) {
        if (!text) return { text, count: 0 };
        const matches = text.match(re);
        if (!matches?.length) return { text, count: 0 };
        return { text: text.replace(re, repl), count: matches.length };
      },
    };
  }
  return {
    replace(text) {
      if (!text?.includes(find)) return { text, count: 0 };
      const parts = text.split(find);
      return { text: parts.join(repl), count: parts.length - 1 };
    },
  };
}

export function openFindReplaceModal() {
  if (!state.project?.rows.length) {
    toast('No subtitle rows to search', 'warning');
    return;
  }
  document.getElementById('fr-find').value = '';
  document.getElementById('fr-replace').value = '';
  showModal('modal-find-replace');
}

document.getElementById('btn-fr-apply')?.addEventListener('click', () => {
  const find = document.getElementById('fr-find')?.value ?? '';
  if (!find) {
    toast('Enter text to find', 'warning');
    return;
  }
  const repl = document.getElementById('fr-replace')?.value ?? '';
  const caseInsensitive = document.getElementById('fr-case-insensitive')?.checked ?? false;
  const useRegex = document.getElementById('fr-regex')?.checked ?? false;
  const tracks = [];
  if (document.getElementById('fr-romaji')?.checked) tracks.push('romaji');
  if (document.getElementById('fr-indo')?.checked) tracks.push('indo');
  if (document.getElementById('fr-english')?.checked) tracks.push('english');
  if (!tracks.length) {
    toast('Select at least one track', 'warning');
    return;
  }

  let replacer;
  try {
    replacer = buildFindReplacer(find, repl, caseInsensitive, useRegex);
  } catch (err) {
    toast('Invalid regex: ' + err.message, 'error');
    return;
  }

  let count = 0;
  pushHistory();
  for (const row of state.project.rows) {
    for (const t of tracks) {
      const result = replacer.replace(row[t] ?? '');
      if (result.count > 0) {
        row[t] = result.text;
        count += result.count;
      }
    }
  }
  renderRows();
  hideModal('modal-find-replace');
  toast(count ? `Replaced ${count} occurrence(s)` : 'No matches found', count ? 'success' : 'info');
});

document.getElementById('btn-fr-cancel')?.addEventListener('click', () => {
  hideModal('modal-find-replace');
});

// ═══════════════════════════════════════════════════════
// ANIMATION OVERRIDE MODAL
// ═══════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════
// SCALE TIMING MODAL
// ═══════════════════════════════════════════════════════
export function openScaleTimingModal() {
  if (!state.project?.rows.length) {
    toast('No rows to scale', 'warning');
    return;
  }
  const input = document.getElementById('scale-factor');
  if (input) input.value = '1.0';
  showModal('modal-scale');
}

document.getElementById('btn-scale-apply')?.addEventListener('click', () => {
  const factor = document.getElementById('scale-factor')?.value ?? '1.0';
  const video = document.getElementById('video-player');
  const anchorMs = Math.round((video?.currentTime ?? 0) * 1000);
  const f = parseFloat(factor);
  if (!f || isNaN(f) || f <= 0) {
    toast('Enter a valid scale factor (e.g. 1.05)', 'warning');
    return;
  }
  pushHistory();
  scaleAllRows(f, anchorMs);
  invalidateTimeline();
  renderRows();
  hideModal('modal-scale');
  toast(`Scaled timings ×${f} around playhead`, 'info');
});

document.getElementById('btn-scale-cancel')?.addEventListener('click', () => {
  hideModal('modal-scale');
});

// ═══════════════════════════════════════════════════════
// KEYBOARD SHORTCUTS MODAL
// ═══════════════════════════════════════════════════════
let capturingAction = null;

function renderShortcutsList() {
  const list = document.getElementById('shortcuts-list');
  if (!list) return;
  ensureShortcuts(state.settings);
  const shortcuts = state.settings?.shortcuts ?? {};
  list.innerHTML = SHORTCUT_ACTIONS.map(({ id, label }) => `
    <div class="shortcut-row">
      <span class="shortcut-label">${escHtml(label)}</span>
      <button type="button" class="shortcut-bind" data-action="${id}" title="Click then press a key combination">
        ${escHtml(formatShortcut(shortcuts[id]))}
      </button>
    </div>
  `).join('');

  list.querySelectorAll('.shortcut-bind').forEach(btn => {
    btn.addEventListener('click', () => {
      capturingAction = btn.dataset.action;
      btn.textContent = 'Press keys…';
      btn.classList.add('capturing');
    });
  });
}

export function openShortcutsModal() {
  if (!state.settings) {
    toast('Settings not loaded yet', 'error');
    return;
  }
  capturingAction = null;
  renderShortcutsList();
  showModal('modal-shortcuts');
}

document.getElementById('btn-shortcuts-reset')?.addEventListener('click', () => {
  if (!state.settings) return;
  state.settings.shortcuts = { ...DEFAULT_SHORTCUTS };
  renderShortcutsList();
  toast('Shortcuts reset to defaults', 'info');
});

document.getElementById('btn-shortcuts-save')?.addEventListener('click', async () => {
  if (!state.settings) return;
  try {
    await invoke('save_settings', { settings: state.settings });
    toast('Shortcuts saved', 'success');
    hideModal('modal-shortcuts');
  } catch (err) {
    toast('Failed to save shortcuts: ' + err, 'error');
  }
});

document.getElementById('btn-shortcuts-cancel')?.addEventListener('click', async () => {
  try {
    state.settings = await fetchSettings();
  } catch (err) {
    console.warn('Reload settings on shortcuts cancel:', err);
  }
  hideModal('modal-shortcuts');
});

document.addEventListener('keydown', (e) => {
  if (!capturingAction) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') {
    capturingAction = null;
    renderShortcutsList();
    return;
  }
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  if (e.code && !['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight'].includes(e.code)) {
    parts.push(e.code);
  }
  if (parts.length < 1 || (parts.length === 1 && parts[0].startsWith('Control'))) return;

  ensureShortcuts(state.settings);
  state.settings.shortcuts[capturingAction] = parts.join('+');
  capturingAction = null;
  renderShortcutsList();
}, true);

// ═══════════════════════════════════════════════════════
// CHOICE MODALS
// ═══════════════════════════════════════════════════════

export function promptDuplicateRow() {
  return openChoiceModal(document.getElementById('modal-duplicate-row'), {
    message: 'Where should the duplicate be placed? IN time will be set 1 ms after the row above.',
  });
}

export function promptCloseVideo() {
  return openChoiceModal(document.getElementById('modal-close-video'), {
    message: 'What should happen to subtitle rows?',
  });
}

/**
 * @param {{ legacy_identifier: string, legacy_data_dir: string, items: string[] }} offer
 */
export function promptLegacyMigration(offer) {
  const modal = document.getElementById('modal-legacy-migration');
  const list = document.getElementById('legacy-migration-items');
  if (list) {
    list.innerHTML = offer?.items?.length
      ? offer.items.map(item => `<li>${escHtml(item)}</li>`).join('')
      : '';
  }
  const itemSummary = offer?.items?.length
    ? offer.items.join(', ')
    : 'settings';
  return openChoiceModal(modal, {
    message: `SanMoji found data from the previous installation (${offer.legacy_identifier}). Copy ${itemSummary} into this version?`,
  });
}