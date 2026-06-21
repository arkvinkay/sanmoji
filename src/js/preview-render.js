/**
 * Shared subtitle preview rendering — matches ASS export scale.
 */
import { state } from './state.js';

const SAMPLE_TEXT = {
  romaji: 'さんもじ',
  indo: 'Tiga karakter',
  english: 'Three characters',
};

/** Actual video rect inside a container (object-fit: contain). */
export function videoDisplayRect(containerW, containerH, videoW, videoH) {
  const vw = videoW || state.videoW || 1920;
  const vh = videoH || state.videoH || 1080;
  if (!containerW || !containerH) {
    return { x: 0, y: 0, w: containerW || 0, h: containerH || 0, scale: 1 };
  }
  const videoAspect = vw / vh;
  const containerAspect = containerW / containerH;
  let dw, dh, dx, dy;
  if (containerAspect > videoAspect) {
    dh = containerH;
    dw = containerH * videoAspect;
    dx = (containerW - dw) / 2;
    dy = 0;
  } else {
    dw = containerW;
    dh = containerW / videoAspect;
    dx = 0;
    dy = (containerH - dh) / 2;
  }
  return { x: dx, y: dy, w: dw, h: dh, scale: dh / vh };
}

export function drawSubtitlePreview(ctx, canvas, settings, options = {}) {
  if (!ctx || !canvas || !settings) return;

  const refH = options.videoH ?? state.videoH ?? 1080;
  const refW = options.videoW ?? state.videoW ?? 1920;
  const rect = videoDisplayRect(canvas.width, canvas.height, refW, refH);

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = options.bgColor ?? '#0a0a0a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#181818';
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);

  const tracks = [
    { key: 'romaji', text: SAMPLE_TEXT.romaji },
    { key: 'indo', text: SAMPLE_TEXT.indo },
    { key: 'english', text: SAMPLE_TEXT.english },
  ];

  const cx = rect.x + rect.w / 2;

  tracks.forEach(({ key, text }) => {
    const style = settings[key];
    if (!style) return;
    drawPreviewLine(ctx, text, cx, rect.y + rect.h * style.pos_y_percent,
      style.size * rect.scale, style);
  });
}

function drawPreviewLine(ctx, text, x, y, fontSize, style) {
  if (!text) return;
  const fontName = style.font ?? 'Arial';
  ctx.save();
  ctx.font = `${style.bold ? 'bold ' : ''}${Math.round(fontSize)}px "${fontName}"`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const outlinePx = (style.outline_size ?? 0) * (fontSize / (style.size || 52));

  if (outlinePx > 0) {
    ctx.strokeStyle = style.outline_color ?? '#000';
    ctx.lineWidth = outlinePx * 2;
    ctx.lineJoin = 'round';
    ctx.strokeText(text, x, y);
  }
  ctx.fillStyle = style.color ?? '#fff';
  ctx.fillText(text, x, y);
  ctx.restore();
}