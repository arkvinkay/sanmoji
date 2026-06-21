/** UI color themes — applied via data-theme on <html> */

export const THEMES = [
  { id: 'dark', label: 'Dark (default)' },
  { id: 'light', label: 'Light' },
  { id: 'midnight', label: 'Midnight blue' },
  { id: 'warm', label: 'Warm amber' },
  { id: 'forest', label: 'Forest green' },
  { id: 'ocean', label: 'Ocean teal' },
  { id: 'rose', label: 'Rose blush' },
  { id: 'sakura', label: 'Sakura pink' },
  { id: 'slate', label: 'Slate gray' },
  { id: 'neon', label: 'Neon cyber' },
];

const VALID = new Set(THEMES.map(t => t.id));

export function normalizeTheme(id) {
  return VALID.has(id) ? id : 'dark';
}

export function applyTheme(themeId) {
  const theme = normalizeTheme(themeId);
  document.documentElement.dataset.theme = theme;
  return theme;
}

export function themeOptions(selected) {
  const cur = normalizeTheme(selected);
  return THEMES.map(t =>
    `<option value="${t.id}"${t.id === cur ? ' selected' : ''}>${t.label}</option>`
  ).join('');
}