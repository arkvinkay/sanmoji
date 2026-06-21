/**
 * Periodic autosave draft to app data directory.
 */
import { state } from './state.js';
import { invoke } from './tauri.js';

const INTERVAL_MS = 30_000;
let timerId = null;

export function startAutosave() {
  stopAutosave();
  timerId = setInterval(async () => {
    if (!state.settings?.autosave_enabled || !state.project) return;
    try {
      await invoke('autosave_draft', {
        project: state.project,
        projectPath: state.projectPath ?? null,
      });
    } catch {
      /* silent — autosave is best-effort */
    }
  }, INTERVAL_MS);
  return stopAutosave;
}

export function stopAutosave() {
  if (timerId !== null) {
    clearInterval(timerId);
    timerId = null;
  }
}