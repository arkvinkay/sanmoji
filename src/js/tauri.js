/**
 * Tauri v2 API wrapper (vanilla JS, withGlobalTauri).
 */

let devWarned = false;

function warnDevOnce(msg) {
  if (devWarned) return;
  devWarned = true;
  console.warn(msg);
}

function core() {
  if (!window.__TAURI__?.core) {
    warnDevOnce('Tauri API unavailable — running in browser/dev mode. File and export features are disabled.');
    return null;
  }
  return window.__TAURI__.core;
}

export function isTauri() {
  return Boolean(window.__TAURI__?.core);
}

export async function invoke(cmd, args = {}) {
  const api = core();
  if (!api) throw new Error(`Tauri invoke unavailable: ${cmd}`);
  return api.invoke(cmd, args);
}

export function convertFileSrc(path, protocol = 'asset') {
  if (!path) return '';
  const api = core();
  if (!api) return path;
  const normalized = String(path).replace(/\\/g, '/');
  return api.convertFileSrc(normalized, protocol);
}

function eventApi() {
  if (!window.__TAURI__?.event) {
    warnDevOnce('Tauri event API unavailable.');
    return null;
  }
  return window.__TAURI__.event;
}

export async function listen(event, handler) {
  const api = eventApi();
  if (!api) return () => {};
  return api.listen(event, handler);
}

function isConfirmOk(result) {
  if (result === true) return true;
  if (typeof result === 'string') {
    const s = result.trim().toLowerCase();
    return s === 'ok' || s === 'yes' || s === 'confirm';
  }
  return false;
}

export const dialog = {
  async open(opts = {}) {
    return invoke('plugin:dialog|open', { options: opts });
  },
  async save(opts = {}) {
    return invoke('plugin:dialog|save', { options: opts });
  },
  async message(msg, opts = {}) {
    const title = typeof opts === 'string' ? opts : opts.title;
    return invoke('plugin:dialog|message', {
      message: msg,
      title,
      kind: opts.kind,
      buttons: opts.buttons ?? 'Ok',
    });
  },
  async confirm(msg, opts = {}) {
    const title = typeof opts === 'string' ? opts : opts.title;
    const result = await invoke('plugin:dialog|message', {
      message: msg,
      title,
      kind: opts.kind ?? 'warning',
      buttons: 'OkCancel',
    });
    return isConfirmOk(result);
  },
};