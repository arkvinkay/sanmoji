import {
  APP_NAME, APP_VERSION, APP_TAGLINE, APP_DESCRIPTION,
  APP_CREATOR, APP_GITHUB,
} from '../app-info.js';
import { showModal, hideModal } from './_shared.js';

export function openAboutModal() {
  const el = document.getElementById('about-content');
  if (!el) return;
  const aboutTitle = document.getElementById('about-title');
  if (aboutTitle) aboutTitle.textContent = `About ${APP_NAME}`;
  el.innerHTML = `
    <p class="about-tagline"><strong>${APP_NAME}</strong> v${APP_VERSION}</p>
    <p class="about-etymology dim-text">三 (San) = three · 文字 (Moji) = characters</p>
    <p class="dim-text">${APP_TAGLINE}</p>
    <p>${APP_DESCRIPTION}</p>
    <div class="section-title">Source</div>
    <p><a href="${APP_GITHUB}" class="about-link" target="_blank" rel="noopener">${APP_GITHUB}</a></p>
    <div class="section-title">License</div>
    <p class="about-license">
      <strong>${APP_NAME}</strong> source code is licensed under the <strong>MIT License</strong>.
    </p>
    <p class="about-license">
      Video export uses <strong>FFmpeg</strong> (GNU GPL). FFmpeg may be downloaded automatically on first use if not bundled.
    </p>
    <div class="section-title">Third-Party</div>
    <ul class="about-list">
      <li><strong>Tauri</strong> — MIT / Apache-2.0</li>
      <li><strong>FFmpeg</strong> — GPL</li>
    </ul>
    <p class="dim-text">© 2026 ${APP_CREATOR} · ${APP_NAME}</p>
  `;
  showModal('modal-about');
}

document.getElementById('btn-about-close')?.addEventListener('click', () => {
  hideModal('modal-about');
});