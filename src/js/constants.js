/** Named constants — avoid magic numbers across the app */

export const MIN_ROW_MS = 100;
export const DEFAULT_ROW_MS = 4000;
export const MIN_TIMELINE_DURATION_MS = 60_000;


export const GAP_WARN_MS = 2000;
export const MAX_CHARS_PER_LINE = 42;

export const MAX_TOAST = 5;
export const MAX_HISTORY = 50;

export const SCROLL_RENDER_THROTTLE_MS = 100;
export const RESIZE_DEBOUNCE_MS = 150;

export const ROW_HEIGHT = 56;
export const VISIBLE_BUFFER = 5;
export const MAX_VISIBLE_ROWS = 25;

export const WF_ZOOM_MIN = 1;
export const WF_ZOOM_MAX = 64;

export const DEFAULT_SHORTCUTS = {
  playPause: 'Space',
  save: 'Ctrl+KeyS',
  undo: 'Ctrl+KeyZ',
  redo: 'Ctrl+Shift+KeyZ',
  setIn: 'BracketLeft',
  setOut: 'BracketRight',
  rowIn: 'KeyI',
  rowOut: 'KeyO',
  insertRow: 'KeyN',
  duplicateRow: 'Ctrl+KeyD',
  findReplace: 'Ctrl+KeyH',
  seekBack: 'ArrowLeft',
  seekForward: 'ArrowRight',
  selectPrevRow: 'ArrowUp',
  selectNextRow: 'ArrowDown',
};