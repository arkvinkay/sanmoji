import { invoke, dialog } from '../tauri.js';
import { toast } from '../toast.js';
import { showModal, hideModal } from './_shared.js';

const batchProjects = [];

export function openBatchModal() {
  showModal('modal-batch');
  renderBatchList();
}

function renderBatchList() {
  const list = document.getElementById('batch-list');
  if (!batchProjects.length) {
    list.innerHTML = '<p class="dim-text">No projects added yet.</p>';
    return;
  }
  list.innerHTML = '';
  batchProjects.forEach((p, i) => {
    const item = document.createElement('div');
    item.className = 'batch-item';
    const label = document.createElement('span');
    label.textContent = p.split(/[\\/]/).pop();
    const rm = document.createElement('button');
    rm.className = 'btn-delete-row';
    rm.dataset.batchRm = String(i);
    rm.textContent = '×';
    rm.title = 'Remove from batch';
    item.appendChild(label);
    item.appendChild(rm);
    list.appendChild(item);
  });
  list.querySelectorAll('[data-batch-rm]').forEach(btn => {
    btn.addEventListener('click', () => {
      batchProjects.splice(Number(btn.dataset.batchRm), 1);
      renderBatchList();
    });
  });
}

document.getElementById('btn-batch-add')?.addEventListener('click', async () => {
  const paths = await dialog.open({
    multiple: true,
    filters: [{ name: 'SanMoji Project', extensions: ['smpr'] }]
  });
  if (!paths) return;
  const arr = Array.isArray(paths) ? paths : [paths];
  arr.forEach(p => { if (!batchProjects.includes(p)) batchProjects.push(p); });
  renderBatchList();
});

document.getElementById('btn-batch-clear')?.addEventListener('click', () => {
  batchProjects.length = 0;
  renderBatchList();
});

document.getElementById('btn-batch-dir')?.addEventListener('click', async () => {
  const dir = await dialog.open({ directory: true });
  if (dir) document.getElementById('batch-output-dir').value = dir;
});

document.getElementById('btn-batch-start')?.addEventListener('click', async () => {
  const outDir = document.getElementById('batch-output-dir').value;
  if (!batchProjects.length) { toast('Add at least one project.', 'warning'); return; }
  if (!outDir) { toast('Select output folder.', 'warning'); return; }

  const batchFmt = document.getElementById('batch-format')?.value ?? 'mp4';
  const items = batchProjects.map(p => {
    const base = p.split(/[\\/]/).pop().replace(/\.smpr$/i, '');
    const sep = outDir.includes('\\') ? '\\' : '/';
    return {
      projectPath: p,
      outputPath: `${outDir}${sep}${base}_export.${batchFmt}`,
      videoW: 0,
      videoH: 0,
    };
  });

  document.getElementById('batch-progress').classList.remove('hidden');
  document.getElementById('btn-batch-start').disabled = true;

  try {
    const results = await invoke('batch_export_videos', { items });
    const ok = results.filter(r => r.success).length;
    const fail = results.length - ok;
    if (fail) {
      const detail = results.filter(r => !r.success).map(r => `${r.project_path}: ${r.error}`).join('\n');
      toast(`Batch: ${ok} ok, ${fail} failed`, 'warning');
      console.warn(detail);
    } else {
      toast(`Batch complete: ${ok} succeeded`, 'success');
    }
  } catch (err) {
    toast('Batch export failed: ' + err, 'error');
  } finally {
    document.getElementById('batch-progress').classList.add('hidden');
    document.getElementById('btn-batch-start').disabled = false;
  }
});

document.getElementById('btn-batch-cancel')?.addEventListener('click', () => {
  hideModal('modal-batch');
});