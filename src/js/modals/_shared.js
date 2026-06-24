import { openModal, closeModal, initModalBackdropClose } from '../modal-manager.js';

export function showModal(id, opts = {}) {
  const el = document.getElementById(id);
  if (!el) return;
  openModal(el, { onEscape: opts.onEscape ?? (() => hideModal(id)) });
}

export function hideModal(id) {
  const el = document.getElementById(id);
  if (el) closeModal(el);
}

export function swapPathExtension(path, ext) {
  if (!path) return path;
  const base = path.replace(/\.[^./\\]+$/, '');
  return `${base}.${ext}`;
}

initModalBackdropClose();