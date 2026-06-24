import { state } from '../state.js';
import { escHtml } from '../utils.js';
import { invoke } from '../tauri.js';
import { toast } from '../toast.js';
import { showModal, hideModal } from './_shared.js';
import { ensureShortcuts, SHORTCUT_ACTIONS, formatShortcut } from '../shortcuts.js';
import { fetchSettings } from '../settings-api.js';
import { DEFAULT_SHORTCUTS } from '../constants.js';

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