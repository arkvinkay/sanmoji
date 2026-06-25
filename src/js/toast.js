import { MAX_TOAST } from './constants.js';

const container = () => document.getElementById('toast-container');
const activeToasts = [];

function trimToasts() {
  const c = container();
  if (!c) return;
  while (activeToasts.length > MAX_TOAST) {
    const oldest = activeToasts.shift();
    if (oldest?.el?.isConnected) oldest.el.remove();
    if (oldest?.hideTimer) clearTimeout(oldest.hideTimer);
    if (oldest?.removeTimer) clearTimeout(oldest.removeTimer);
    if (oldest?.showRaf) cancelAnimationFrame(oldest.showRaf);
  }
}

export function toast(message, type = 'info', ms = 3500) {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  container()?.appendChild(el);

  const entry = { el, hideTimer: null, removeTimer: null, showRaf: null };
  activeToasts.push(entry);
  trimToasts();

  entry.showRaf = requestAnimationFrame(() => {
    entry.showRaf = null;
    el.classList.add('show');
  });

  entry.hideTimer = setTimeout(() => {
    el.classList.remove('show');
    entry.removeTimer = setTimeout(() => {
      el.remove();
      const idx = activeToasts.indexOf(entry);
      if (idx >= 0) activeToasts.splice(idx, 1);
    }, 300);
  }, ms);
}

export function setStatus(text) {
  const el = document.getElementById('status-text');
  if (el) el.textContent = text;
}