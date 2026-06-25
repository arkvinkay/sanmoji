import { openModal, closeModal, initModalBackdropClose } from '../modal-manager.js';

export function showModal(id, opts = {}) {
  const el = document.getElementById(id);
  if (!el) return;
  const { onEscape, ...rest } = opts;
  openModal(el, {
    onEscape: onEscape ?? (() => hideModal(id)),
    ...rest,
  });
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