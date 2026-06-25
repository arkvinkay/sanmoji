import { applySettingsResponse } from './shortcuts.js';
import { invoke } from './tauri.js';
import { toast } from './toast.js';

/** Fetch settings from Rust and surface corrupt-file warnings */
export async function fetchSettings() {
  const resp = await invoke('get_settings');
  const parsed = applySettingsResponse(resp);
  if (!parsed) {
    toast('Settings could not be loaded', 'error');
    return null;
  }
  const { settings, corrupt } = parsed;
  if (corrupt) {
    toast('Settings file was corrupt — defaults were restored', 'warning');
  }
  return settings;
}

export async function fetchSystemFonts(refresh = false) {
  try {
    return await invoke('get_system_fonts', { refresh });
  } catch (err) {
    console.warn('get_system_fonts failed:', err);
    return [
      { family: 'Arial', path: '' },
      { family: 'Segoe UI', path: '' },
      { family: 'Times New Roman', path: '' },
    ];
  }
}