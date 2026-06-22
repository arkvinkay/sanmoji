/**
 * Canvas subtitle preview with animation simulation + watermark.
 */
import { state } from './state.js';
import { resolveAnim } from './utils.js';
import { convertFileSrc } from './tauri.js';
import { videoDisplayRect } from './preview-render.js';

const canvas = document.getElementById('sub-overlay');
const ctx = canvas?.getContext('2d');

let wmImage = null;
let wmImagePath = null;
let lastRenderKey = '';

function resize() {
  if (!canvas || !ctx) return;
  const wrapper = document.getElementById('video-wrapper');
  if (!wrapper) return;
  canvas.width  = wrapper.clientWidth;
  canvas.height = wrapper.clientHeight;
  lastRenderKey = '';
}
window.addEventListener('resize', resize);
resize();

function loadWatermark(path) {
  if (!path) {
    wmImage = null;
    wmImagePath = null;
    return;
  }
  if (path === wmImagePath && wmImage) return;
  wmImagePath = path;
  const img = new Image();
  img.onload = () => { wmImage = img; lastRenderKey = ''; };
  img.onerror = () => { wmImage = null; };
  img.src = convertFileSrc(path);
}

export function refreshWatermark() {
  const wm = state.settings?.watermark;
  if (wm?.enabled && wm.file_path) {
    loadWatermark(wm.file_path);
  } else {
    wmImage = null;
    wmImagePath = null;
    lastRenderKey = '';
  }
}

function getDisplayRect() {
  const wrapper = document.getElementById('video-wrapper');
  const video = document.getElementById('video-player');
  const vw = video?.videoWidth || state.videoW || 1920;
  const vh = video?.videoHeight || state.videoH || 1080;
  return videoDisplayRect(
    wrapper?.clientWidth ?? canvas?.width ?? 0,
    wrapper?.clientHeight ?? canvas?.height ?? 0,
    vw,
    vh,
  );
}

function activeRows(currentMs) {
  if (!state.project) return [];
  return state.project.rows.filter(r => currentMs >= r.start_ms && currentMs <= r.end_ms);
}

function buildRenderKey(currentMs) {
  const rows = activeRows(currentMs);
  const rowKey = rows.map(r =>
    `${r.id}:${r.start_ms}-${r.end_ms}:${r.romaji}|${r.indo}|${r.english}`
  ).join(';');
  const s = state.settings;
  const trackStyleKey = (t) => t
    ? `${t.font}:${t.size}:${t.color}:${t.outline_color}:${t.outline_size}:${t.bold}:${t.pos_y_percent}`
    : '';
  const wm = s?.watermark;
  const wmKey = wm
    ? `${wm.enabled}:${wmImagePath}:${wm.anim_in}:${wm.anim_out}:${wm.duration_in_ms}:${wm.duration_out_ms}:${wm.text}:${wm.text_size}:${wm.text_color}:${wm.text_gap}:${wm.text_position}:${wm.text_font}:${wm.text_bold}:${wm.text_outline_color}:${wm.text_outline_size}:${wm.text_shadow}:${wm.width}:${wm.height}:${wm.margin_x}:${wm.margin_y}`
    : '';
  const settingsKey = s
    ? `${trackStyleKey(s.romaji)}|${trackStyleKey(s.indo)}|${trackStyleKey(s.english)}:${wmKey}`
    : '';
  const rect = getDisplayRect();
  return `${currentMs}|${rowKey}|${settingsKey}|${rect.w}x${rect.h}`;
}

function easeOutCubic(t) {
  return 1 - (1 - t) ** 3;
}

function animProgress(elapsed, delay, durIn) {
  const t = Math.max(0, elapsed - delay);
  if (durIn <= 0) return 1;
  return easeOutCubic(Math.min(1, t / durIn));
}

function fadeOutAlpha(elapsed, rowDur, animOut, durOut) {
  if (animOut !== 'fade' || durOut <= 0) return 1;
  const remaining = rowDur - elapsed;
  if (remaining > durOut) return 1;
  return Math.max(0, remaining / durOut);
}

function computeAnim(globalAnim, override, elapsed, rowDur) {
  const animIn = resolveAnim(globalAnim, override, 'anim_in') ?? 'fade';
  const animOut = resolveAnim(globalAnim, override, 'anim_out') ?? 'fade';
  const durIn = resolveAnim(globalAnim, override, 'duration_in_ms') ?? 300;
  const durOut = resolveAnim(globalAnim, override, 'duration_out_ms') ?? 200;
  const delay = resolveAnim(globalAnim, override, 'delay_ms') ?? 0;
  const p = animProgress(elapsed, delay, durIn);
  const alpha = fadeOutAlpha(elapsed, rowDur, animOut, durOut);

  let yOff = 0, scale = 1, blur = 0;

  switch (animIn) {
    case 'fade':
      return { alpha: p * alpha, yOff, scale, blur, charRatio: 1 };
    case 'slide_up':
      yOff = (1 - p) * 24 * (getDisplayRect().scale);
      return { alpha: p * alpha, yOff, scale, blur, charRatio: 1 };
    case 'scale_pop':
      scale = 0.2 + p * 0.8;
      return { alpha: p * alpha, yOff, scale, blur, charRatio: 1 };
    case 'typewriter':
      return { alpha, yOff, scale, blur, charRatio: p };
    case 'glow':
      blur = (1 - p) * 8;
      return { alpha: p * alpha, yOff, scale, blur, charRatio: 1 };
    case 'bounce': {
      const bounce = p < 0.6 ? p / 0.6 * 1.1 : 1.1 - (p - 0.6) / 0.4 * 0.1;
      scale = Math.min(bounce, 1.1);
      return { alpha, yOff, scale, blur, charRatio: 1 };
    }
    default:
      return { alpha, yOff, scale, blur, charRatio: 1 };
  }
}

function drawLine(text, x, y, fontSize, style, anim, scale) {
  if (!ctx || !text) return;
  let display = text;
  let partialAlpha = 1;
  if (anim.charRatio < 1) {
    const visible = text.length * anim.charRatio;
    const fullCount = Math.floor(visible);
    partialAlpha = visible - fullCount;
    display = text.slice(0, fullCount);
    if (partialAlpha > 0.02 && fullCount < text.length) {
      display += text[fullCount];
    } else {
      partialAlpha = 1;
    }
  }
  if (!display) return;

  const fontName = style.font ?? 'Arial';
  ctx.save();
  ctx.globalAlpha = anim.alpha * (partialAlpha < 1 ? partialAlpha : 1);
  ctx.font = `${style.bold ? 'bold ' : ''}${Math.round(fontSize)}px "${fontName}"`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const drawY = y + anim.yOff;
  ctx.translate(x, drawY);
  ctx.scale(anim.scale, anim.scale);

  if (anim.blur > 0) {
    ctx.shadowColor = style.color;
    ctx.shadowBlur = anim.blur * 2;
  }

  const outlinePx = (style.outline_size ?? 0) * scale;
  if (outlinePx > 0) {
    ctx.strokeStyle = style.outline_color;
    ctx.lineWidth = outlinePx * 2;
    ctx.lineJoin = 'round';
    ctx.strokeText(display, 0, 0);
  }
  ctx.fillStyle = style.color;
  ctx.fillText(display, 0, 0);
  ctx.restore();
}

function computeWatermarkAnim(currentMs) {
  const wm = state.settings?.watermark;
  if (!wm) return { alpha: 1, glitch: 0 };
  const durIn = wm.duration_in_ms ?? 400;
  const durOut = wm.duration_out_ms ?? 400;
  const animIn = wm.anim_in ?? 'glitch';
  const animOut = wm.anim_out ?? 'glitch';
  const video = document.getElementById('video-player');
  const videoDurMs = state.videoDurationMs
    || Math.round((video?.duration ?? 0) * 1000);

  let alpha = 1;
  let glitch = 0;

  if (durIn > 0 && currentMs < durIn) {
    const p = currentMs / durIn;
    if (animIn === 'fade' || animIn === 'none') alpha = animIn === 'fade' ? p : 1;
    else if (animIn === 'glitch') {
      alpha = Math.min(1, p * 1.5);
      glitch = Math.max(glitch, 1 - p);
    }
  }

  if (durOut > 0 && videoDurMs > durOut && currentMs > videoDurMs - durOut) {
    const p = (videoDurMs - currentMs) / durOut;
    if (animOut === 'fade') alpha = Math.min(alpha, p);
    else if (animOut === 'glitch') {
      alpha = Math.min(alpha, Math.min(1, p * 1.5));
      glitch = Math.max(glitch, 1 - p);
    }
  }

  return { alpha, glitch };
}

function drawGlitchImage(img, x, y, w, h, intensity) {
  if (!ctx || intensity <= 0.02) {
    ctx.drawImage(img, x, y, w, h);
    return;
  }
  const slices = 6;
  const sliceH = h / slices;
  for (let i = 0; i < slices; i++) {
    const sy = (img.height / slices) * i;
    const sh = img.height / slices;
    const jitter = (Math.random() - 0.5) * 12 * intensity * rectScale();
    const dy = y + sliceH * i;
    ctx.drawImage(img, 0, sy, img.width, sh, x + jitter, dy, w, sliceH);
  }
  const offset = 3 * intensity * rectScale();
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha *= 0.35;
  ctx.drawImage(img, x - offset, y, w, h);
  ctx.drawImage(img, x + offset, y, w, h);
  ctx.globalCompositeOperation = 'source-over';
}

function rectScale() {
  return getDisplayRect().scale || 1;
}

function captionReservePx(wm) {
  if (!wm.text?.trim()) return 0;
  const pos = wm.text_position ?? 'below';
  if (pos === 'beside') return 0;
  const textSize = (wm.text_size ?? 14);
  const textGap = wm.text_gap ?? 4;
  return (textSize + textGap) * rectScale();
}

function drawCaptionText(text, wm, rect, imgX, imgY, imgW, imgH, alpha) {
  if (!ctx || !text) return;
  const scale = rect.scale;
  const textSize = (wm.text_size ?? 14) * scale;
  const textGap = (wm.text_gap ?? 4) * scale;
  const mx = (wm.margin_x ?? 0) * scale;
  const my = (wm.margin_y ?? 0) * scale;
  const pos = wm.text_position ?? 'below';
  const fontName = wm.text_font ?? 'Arial';
  const outlinePx = (wm.text_outline_size ?? 0) * scale;
  const color = wm.text_color ?? '#FFFFFF';
  const outlineColor = wm.text_outline_color ?? '#000000';

  ctx.save();
  ctx.globalAlpha = 0.85 * alpha;
  ctx.font = `${wm.text_bold ? 'bold ' : ''}${Math.round(textSize)}px "${fontName}", sans-serif`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;

  let tx;
  let ty;
  if (pos === 'above') {
    tx = rect.x + rect.w - mx;
    ty = imgY - textGap - textSize * 0.5;
  } else if (pos === 'beside') {
    tx = imgX - textGap;
    ty = imgY + imgH / 2;
    ctx.textAlign = 'right';
  } else {
    tx = rect.x + rect.w - mx;
    ty = rect.y + rect.h - my - textSize * 0.35;
  }

  if (wm.text_shadow) {
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = Math.max(1, textSize * 0.08);
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;
  }

  if (outlinePx > 0) {
    ctx.lineWidth = outlinePx * 2;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = outlineColor;
    ctx.strokeText(text, tx, ty);
  }
  ctx.fillText(text, tx, ty);
  ctx.restore();
}

function drawWatermark(rect, currentMs) {
  if (!ctx) return;
  const wm = state.settings?.watermark;
  if (!wm?.enabled || !wmImage) return;

  const w = wm.width * rect.scale;
  const h = wm.height * rect.scale;
  const mx = wm.margin_x * rect.scale;
  const my = wm.margin_y * rect.scale;
  const hasText = !!(wm.text?.trim());
  const textBlock = captionReservePx(wm);

  const x = rect.x + rect.w - w - mx;
  const y = rect.y + rect.h - h - my - textBlock;
  const { alpha, glitch } = computeWatermarkAnim(currentMs);

  ctx.save();
  ctx.globalAlpha = 0.85 * alpha;
  if (glitch > 0.02) drawGlitchImage(wmImage, x, y, w, h, glitch);
  else ctx.drawImage(wmImage, x, y, w, h);
  ctx.restore();

  if (hasText) {
    drawCaptionText(wm.text.trim(), wm, rect, x, y, w, h, alpha);
  }
}

export function renderOverlay(currentMs) {
  if (!ctx || !canvas) return;
  const video = document.getElementById('video-player');
  const isPlaying = video && !video.paused && !video.ended;
  if (!isPlaying) {
    const key = buildRenderKey(currentMs);
    if (key === lastRenderKey) return;
    lastRenderKey = key;
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!state.settings || !state.project) return;

  const rect = getDisplayRect();
  drawWatermark(rect, currentMs);

  const rows = activeRows(currentMs);
  if (!rows.length) return;

  const s = state.settings;
  const cx = rect.x + rect.w / 2;

  rows.forEach(row => {
    const elapsed = currentMs - row.start_ms;
    const rowDur = row.end_ms - row.start_ms;

    const tracks = [
      { text: row.romaji, style: s.romaji, global: s.romaji_anim, ov: row.romaji_anim },
      { text: row.indo, style: s.indo, global: s.indo_anim, ov: row.indo_anim },
      { text: row.english, style: s.english, global: s.english_anim, ov: row.english_anim },
    ];

    tracks.forEach(({ text, style, global, ov }) => {
      const anim = computeAnim(global, ov, elapsed, rowDur);
      const y = rect.y + rect.h * style.pos_y_percent;
      drawLine(text, cx, y, style.size * rect.scale, style, anim, rect.scale);
    });
  });
}

export function invalidateOverlay() {
  lastRenderKey = '';
}

export function initOverlay() {
  refreshWatermark();
  const video = document.getElementById('video-player');
  video?.addEventListener('loadedmetadata', () => {
    lastRenderKey = '';
    resize();
  });
}