import { state, scaleAllRows } from '../state.js';
import { renderRows } from '../editor.js';
import { pushHistory } from '../history.js';
import { toast } from '../toast.js';
import { invalidateTimeline } from '../timeline.js';
import { showModal, hideModal } from './_shared.js';

export function openScaleTimingModal() {
  if (!state.project?.rows.length) {
    toast('No rows to scale', 'warning');
    return;
  }
  const input = document.getElementById('scale-factor');
  if (input) input.value = '1.0';
  showModal('modal-scale');
}

document.getElementById('btn-scale-apply')?.addEventListener('click', () => {
  const factor = document.getElementById('scale-factor')?.value ?? '1.0';
  const video = document.getElementById('video-player');
  const anchorMs = Math.round((video?.currentTime ?? 0) * 1000);
  const f = parseFloat(factor);
  if (!f || isNaN(f) || f <= 0) {
    toast('Enter a valid scale factor (e.g. 1.05)', 'warning');
    return;
  }
  pushHistory();
  scaleAllRows(f, anchorMs);
  invalidateTimeline();
  renderRows();
  hideModal('modal-scale');
  toast(`Scaled timings ×${f} around playhead`, 'info');
});

document.getElementById('btn-scale-cancel')?.addEventListener('click', () => {
  hideModal('modal-scale');
});