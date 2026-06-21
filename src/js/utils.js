/** Escape string for safe use inside HTML text or attribute values */
export function escHtml(str) {
  return (str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** ms → "HH:MM:SS.mmm" display */
export function msToDisplay(ms) {
  const safe = Math.max(0, ms);
  const h  = Math.floor(safe / 3_600_000);
  const m  = Math.floor((safe % 3_600_000) / 60_000);
  const s  = Math.floor((safe % 60_000) / 1_000);
  const ms3 = safe % 1_000;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(ms3).padStart(3,'0')}`;
}

/** "HH:MM:SS.mmm" (or H:MM:SS / MM:SS.mmm) → ms; null when invalid */
export function displayToMs(str) {
  const raw = String(str ?? '').trim();
  if (!raw) return null;

  const parts = raw.split(':');
  let h = 0;
  let m = 0;
  let sPart = '';

  if (parts.length === 3) {
    h = Number(parts[0]);
    m = Number(parts[1]);
    sPart = parts[2];
  } else if (parts.length === 2) {
    m = Number(parts[0]);
    sPart = parts[1];
  } else if (parts.length === 1) {
    sPart = parts[0];
  } else {
    return null;
  }

  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;

  const [sStr, msStr = ''] = sPart.split('.');
  const s = Number(sStr);
  if (!Number.isFinite(s)) return null;

  let ms3 = 0;
  if (msStr) {
    if (!/^\d{1,3}$/.test(msStr)) return null;
    ms3 = Number(msStr.padEnd(3, '0').slice(0, 3));
    if (!Number.isFinite(ms3)) return null;
  }

  if (m < 0 || m >= 60 || s < 0 || s >= 60 || h < 0) return null;
  return Math.round(h * 3_600_000 + m * 60_000 + s * 1_000 + ms3);
}

/** Set progress bar fill via transform scaleX (0–100 percent). */
export function setProgressBar(el, percent) {
  if (!el) return;
  const scale = Math.min(100, Math.max(0, percent)) / 100;
  el.style.setProperty('--progress', String(scale));
}

export function secToMs(sec) { return Math.round(sec * 1000); }
export function msToSec(ms) { return ms / 1000; }

/** Snap ms to nearest whole second when enabled */
export function snapMs(ms, enabled) {
  if (!enabled) return ms;
  return Math.round(ms / 1000) * 1000;
}

/** Extract filename from a filesystem path */
export function basename(path) {
  if (!path) return '';
  const normalized = String(path).replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

/** Safe video duration in seconds (0 when unknown/invalid) */
export function safeDuration(video) {
  const d = video?.duration;
  return Number.isFinite(d) && d > 0 ? d : 0;
}

export function debounce(fn, ms) {
  let timer = null;
  return function debounced(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

export function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  return function throttled(...args) {
    const now = Date.now();
    const remaining = ms - (now - last);
    if (remaining <= 0) {
      if (timer) { clearTimeout(timer); timer = null; }
      last = now;
      fn.apply(this, args);
    } else if (!timer) {
      timer = setTimeout(() => {
        last = Date.now();
        timer = null;
        fn.apply(this, args);
      }, remaining);
    }
  };
}

export const ANIM_OPTIONS = [
  { value: 'none',       label: 'None' },
  { value: 'fade',       label: 'Fade' },
  { value: 'typewriter', label: 'Typewriter' },
  { value: 'slide_up',   label: 'Slide Up' },
  { value: 'scale_pop',  label: 'Scale Pop' },
  { value: 'glow',       label: 'Glow' },
  { value: 'bounce',     label: 'Bounce' },
];

export function animLabel(value) {
  return ANIM_OPTIONS.find(o => o.value === value)?.label ?? value;
}

export function animOptions(selected) {
  return ANIM_OPTIONS.map(o =>
    `<option value="${o.value}"${o.value === selected ? ' selected' : ''}>${o.label}</option>`
  ).join('');
}

export function resolveAnim(globalAnim, override, field) {
  return override?.[field] ?? globalAnim?.[field];
}