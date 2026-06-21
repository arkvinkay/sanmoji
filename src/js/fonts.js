/**
 * System font list helpers — family names, paths, and preview selects.
 */
import { state } from './state.js';
import { fetchSystemFonts } from './settings-api.js';
import { toast } from './toast.js';

export function normalizeFontEntry(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') return { family: entry, path: '' };
  return {
    family: entry.family ?? entry.name ?? String(entry),
    path: entry.path ?? '',
  };
}

export function fontEntries() {
  return (state.fonts ?? []).map(normalizeFontEntry).filter(Boolean);
}

export function fontFamilyName(entry) {
  return normalizeFontEntry(entry)?.family ?? 'Arial';
}

export function fontPathForFamily(family) {
  const target = (family ?? '').trim().toLowerCase();
  const hit = fontEntries().find(f => f.family.toLowerCase() === target);
  return hit?.path ?? '';
}

export function populateFontSelect(sel, current) {
  if (!sel) return;
  const cur = current ?? sel.dataset.current ?? 'Arial';
  sel.innerHTML = '';
  const entries = fontEntries();
  entries.forEach(f => {
    const opt = document.createElement('option');
    opt.value = f.family;
    opt.textContent = f.family;
    opt.style.fontFamily = `'${f.family.replace(/'/g, "\\'")}', sans-serif`;
    if (f.family === cur) opt.selected = true;
    sel.appendChild(opt);
  });
  if (!entries.some(f => f.family === cur)) {
    const opt = document.createElement('option');
    opt.value = cur;
    opt.textContent = cur;
    opt.style.fontFamily = `'${cur.replace(/'/g, "\\'")}', sans-serif`;
    opt.selected = true;
    sel.insertBefore(opt, sel.firstChild);
  }
  updateFontPreview(sel);
}

export function updateFontPreview(sel) {
  const previewId = sel.dataset.previewFor;
  if (!previewId) return;
  const preview = document.getElementById(previewId);
  if (!preview) return;
  const family = sel.value || 'Arial';
  preview.textContent = `Aa Bb 123 — ${family}`;
  preview.style.fontFamily = `'${family.replace(/'/g, "\\'")}', sans-serif`;
  preview.style.fontWeight = sel.dataset.boldField
    ? (document.querySelector(`[data-field="${sel.dataset.boldField}"]`)?.checked ? '700' : '400')
    : '400';
}

export async function refreshSystemFonts(showToast = false) {
  const fonts = await fetchSystemFonts();
  state.fonts = fonts;
  document.querySelectorAll('select.font-select').forEach(sel => {
    populateFontSelect(sel, sel.value || sel.dataset.current);
  });
  if (showToast) toast(`Font list refreshed (${fontEntries().length} fonts)`, 'success');
  return fonts;
}