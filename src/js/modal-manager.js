/**
 * Shared modal open/close with focus trap and Escape handling.
 */

const openModals = new Map();
let globalKeyHandler = null;
const MAIN_CONTENT_ID = 'app';

function setMainAriaHidden(hidden) {
  const main = document.getElementById(MAIN_CONTENT_ID);
  if (main) main.setAttribute('aria-hidden', hidden ? 'true' : 'false');
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function getFocusable(modalEl) {
  return [...modalEl.querySelectorAll(FOCUSABLE)]
    .filter(el => !el.disabled && el.offsetParent !== null);
}

function trapFocus(modalEl, e) {
  if (e.key !== 'Tab') return;
  const items = getFocusable(modalEl);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function ensureGlobalHandler() {
  if (globalKeyHandler) return;
  globalKeyHandler = (e) => {
    const top = [...openModals.entries()].pop();
    if (!top) return;
    const [modalEl, meta] = top;
    if (e.key === 'Escape' && meta.onEscape) {
      e.preventDefault();
      meta.onEscape();
      return;
    }
    trapFocus(modalEl, e);
  };
  document.addEventListener('keydown', globalKeyHandler);
}

function removeGlobalHandlerIfIdle() {
  if (openModals.size || !globalKeyHandler) return;
  document.removeEventListener('keydown', globalKeyHandler);
  globalKeyHandler = null;
}

/**
 * @param {HTMLElement} modalEl
 * @param {{ onEscape?: () => void, initialFocus?: HTMLElement }} [opts]
 */
export function openModal(modalEl, opts = {}) {
  if (!modalEl) return;
  const previousFocus = document.activeElement;
  const onEscape = opts.onEscape ?? (() => closeModal(modalEl));

  openModals.set(modalEl, { previousFocus, onEscape });
  modalEl.classList.remove('hidden');
  if (openModals.size === 1) setMainAriaHidden(true);
  ensureGlobalHandler();

  const focusTarget = opts.initialFocus ?? getFocusable(modalEl)[0];
  if (focusTarget) {
    requestAnimationFrame(() => focusTarget.focus());
  }
}

/**
 * @param {HTMLElement} modalEl
 * @param {{ restoreFocus?: boolean }} [opts]
 */
export function closeModal(modalEl, opts = {}) {
  if (!modalEl) return;
  const meta = openModals.get(modalEl);
  modalEl.classList.add('hidden');
  openModals.delete(modalEl);
  if (!openModals.size) setMainAriaHidden(false);
  removeGlobalHandlerIfIdle();

  if (opts.restoreFocus !== false && meta?.previousFocus?.focus) {
    try { meta.previousFocus.focus(); } catch { /* element may be gone */ }
  }
}

export function initModalBackdropClose() {
  document.querySelectorAll('.modal').forEach(modalEl => {
    modalEl.addEventListener('click', (e) => {
      if (e.target === modalEl && openModals.has(modalEl)) {
        const meta = openModals.get(modalEl);
        meta?.onEscape?.();
      }
    });
  });
}

/**
 * Modal with custom action buttons. Resolves to data-choice id or null on cancel.
 * @param {HTMLElement} modalEl
 * @param {{ message?: string, messageEl?: HTMLElement }} [opts]
 */
export function openChoiceModal(modalEl, opts = {}) {
  if (!modalEl) return Promise.resolve(null);
  const messageEl = opts.messageEl ?? modalEl.querySelector('[data-choice-message]');
  if (messageEl && opts.message !== undefined && opts.message !== null) {
    messageEl.textContent = opts.message;
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      modalEl.removeEventListener('click', onClick);
      closeModal(modalEl);
      resolve(value);
    };

    const onClick = (e) => {
      const btn = e.target.closest('[data-choice]');
      if (!btn || !modalEl.contains(btn)) return;
      finish(btn.dataset.choice ?? null);
    };

    modalEl.addEventListener('click', onClick);
    openModal(modalEl, { onEscape: () => finish(null) });
  });
}