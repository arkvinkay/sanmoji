import { DEFAULT_SHORTCUTS } from './constants.js';
import { state } from './state.js';

export function getShortcuts() {
  return { ...DEFAULT_SHORTCUTS, ...(state.settings?.shortcuts ?? {}) };
}

export function ensureShortcuts(settings) {
  if (!settings) return settings;
  settings.shortcuts = { ...DEFAULT_SHORTCUTS, ...(settings.shortcuts ?? {}) };
  return settings;
}

/** Unwrap SettingsResponse from Rust get_settings command */
export function applySettingsResponse(resp) {
  if (!resp) return null;
  if (resp.settings) {
    return {
      settings: ensureShortcuts(resp.settings),
      corrupt: !!resp.settings_corrupt,
    };
  }
  return { settings: ensureShortcuts(resp), corrupt: false };
}

/** Parse "Ctrl+Shift+KeyZ" into modifier flags + code */
function parseShortcut(str) {
  if (!str) return null;
  const parts = str.split('+').map(s => s.trim());
  const code = parts[parts.length - 1];
  const mods = parts.slice(0, -1).map(m => m.toLowerCase());
  return {
    code,
    ctrl: mods.includes('ctrl') || mods.includes('control'),
    meta: mods.includes('meta') || mods.includes('cmd') || mods.includes('command'),
    shift: mods.includes('shift'),
    alt: mods.includes('alt'),
  };
}

export function shortcutMatches(e, binding) {
  const spec = parseShortcut(binding);
  if (!spec) return false;
  if (e.code !== spec.code) return false;
  const wantsMod = spec.ctrl || spec.meta;
  const hasMod = e.ctrlKey || e.metaKey;
  if (!!hasMod !== !!wantsMod) return false;
  if (!!e.shiftKey !== spec.shift) return false;
  if (!!e.altKey !== spec.alt) return false;
  return true;
}

export function formatShortcut(binding) {
  if (!binding) return '—';
  return binding
    .replace(/Key/g, '')
    .replace(/Digit(\d)/g, '$1')
    .replace(/BracketLeft/g, '[')
    .replace(/BracketRight/g, ']')
    .replace(/Ctrl\+/g, 'Ctrl+')
    .replace(/Shift\+/g, 'Shift+')
    .replace(/Space/g, 'Space');
}

export const SHORTCUT_ACTIONS = [
  { id: 'playPause', label: 'Play / Pause' },
  { id: 'save', label: 'Save project' },
  { id: 'undo', label: 'Undo' },
  { id: 'redo', label: 'Redo' },
  { id: 'setIn', label: 'Set IN marker' },
  { id: 'setOut', label: 'Set OUT marker' },
  { id: 'rowIn', label: 'Row start at playhead' },
  { id: 'rowOut', label: 'Row end at playhead' },
  { id: 'insertRow', label: 'Insert row at playhead' },
  { id: 'duplicateRow', label: 'Duplicate row' },
  { id: 'findReplace', label: 'Find & Replace' },
  { id: 'seekBack', label: 'Seek backward' },
  { id: 'seekForward', label: 'Seek forward' },
  { id: 'selectPrevRow', label: 'Select previous row' },
  { id: 'selectNextRow', label: 'Select next row' },
];