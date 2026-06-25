import { dialog } from '../tauri.js';
import { toast } from '../toast.js';
import { showModal, hideModal } from './_shared.js';

let relinkResolve = null;

export function openRelinkModal(oldPath) {
  return new Promise(resolve => {
    relinkResolve = resolve;
    document.getElementById('relink-old-path').textContent = oldPath;
    document.getElementById('relink-path').value = '';
    showModal('modal-relink', {
      onEscape: () => {
        hideModal('modal-relink');
        if (relinkResolve) relinkResolve(null);
        relinkResolve = null;
      },
    });
  });
}

document.getElementById('btn-relink-browse')?.addEventListener('click', async () => {
  const path = await dialog.open({
    filters: [{ name: 'Video', extensions: ['mp4','mkv','mov','avi','webm','flv','ts','m4v'] }]
  });
  if (path) document.getElementById('relink-path').value = path;
});

document.getElementById('btn-relink-confirm')?.addEventListener('click', async () => {
  const newPath = document.getElementById('relink-path').value;
  if (!newPath) { toast('Select a video file', 'warning'); return; }
  hideModal('modal-relink');
  if (relinkResolve) relinkResolve(newPath);
  relinkResolve = null;
});

document.getElementById('btn-relink-cancel')?.addEventListener('click', () => {
  hideModal('modal-relink');
  if (relinkResolve) relinkResolve(null);
  relinkResolve = null;
});