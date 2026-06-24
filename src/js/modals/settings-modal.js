import { state } from '../state.js';
import { animOptions, escHtml } from '../utils.js';
import { renderRows } from '../editor.js';
import { invoke, dialog } from '../tauri.js';
import { toast } from '../toast.js';
import { refreshWatermark, renderOverlay, invalidateOverlay } from '../overlay.js';
import { showModal, hideModal } from './_shared.js';
import { populateFontSelect, refreshSystemFonts, updateFontPreview } from '../fonts.js';
import { applyTheme, themeOptions } from '../themes.js';

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