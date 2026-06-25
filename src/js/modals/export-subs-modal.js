import { state } from '../state.js';
import { invoke, dialog } from '../tauri.js';
import { toast } from '../toast.js';
import { showModal, hideModal, swapPathExtension } from './_shared.js';

const SUBS_FORMATS = {
  ass: { label: 'ASS Subtitle', extensions: ['ass'] },
  ssa: { label: 'SSA Subtitle', extensions: ['ssa'] },
  srt: { label: 'SRT Subtitle', extensions: ['srt'] },
  vtt: { label: 'WebVTT Subtitle', extensions: ['vtt'] },
};

function getSelectedSubsFormat() {
  return document.getElementById('subs-format')?.value ?? 'ass';
}

export function openExportSubsModal() {
  if (!state.project?.rows.length) {
    toast('Add subtitle rows first.', 'warning');
    return;
  }
  const fmt = getSelectedSubsFormat();
  const info = SUBS_FORMATS[fmt] ?? SUBS_FORMATS.ass;
  const pathEl = document.getElementById('subs-output-path');
  if (pathEl && !pathEl.value) {
    const base = state.projectPath
      ? state.projectPath.replace(/\.smpr$/i, '')
      : (state.project.video_path?.replace(/\.[^./\\]+$/, '') ?? 'subtitles');
    pathEl.value = `${base}.${info.extensions[0]}`;
  }
  showModal('modal-export-subs');
}

document.getElementById('subs-format')?.addEventListener('change', () => {
  const pathEl = document.getElementById('subs-output-path');
  if (!pathEl?.value) return;
  const fmt = getSelectedSubsFormat();
  const ext = SUBS_FORMATS[fmt]?.extensions[0] ?? 'ass';
  pathEl.value = swapPathExtension(pathEl.value, ext);
});

document.getElementById('btn-subs-browse')?.addEventListener('click', async () => {
  const fmt = getSelectedSubsFormat();
  const info = SUBS_FORMATS[fmt] ?? SUBS_FORMATS.ass;
  const path = await dialog.save({
    filters: [{ name: info.label, extensions: info.extensions }],
    defaultPath: `subtitles.${info.extensions[0]}`,
  });
  if (path) document.getElementById('subs-output-path').value = path;
});

document.getElementById('btn-subs-export')?.addEventListener('click', async () => {
  const outPath = document.getElementById('subs-output-path')?.value;
  if (!outPath) {
    toast('Select output file first.', 'warning');
    return;
  }
  const format = getSelectedSubsFormat();
  const exportBtn = document.getElementById('btn-subs-export');
  const cancelBtn = document.getElementById('btn-subs-cancel');
  if (exportBtn) exportBtn.disabled = true;
  if (cancelBtn) cancelBtn.disabled = true;
  toast(`Exporting ${format.toUpperCase()}…`, 'info', 2000);
  try {
    await invoke('export_subtitle_file', {
      project: state.project,
      outputPath: outPath,
      format,
      videoW: state.videoW,
      videoH: state.videoH,
    });
    toast(`${format.toUpperCase()} subtitles exported`, 'success');
    hideModal('modal-export-subs');
  } catch (err) {
    toast('Subtitle export failed: ' + err, 'error');
  } finally {
    if (exportBtn) exportBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = false;
  }
});

document.getElementById('btn-subs-export-all')?.addEventListener('click', async () => {
  const basePath = document.getElementById('subs-output-path')?.value;
  if (!basePath) {
    toast('Select output file first (used as base name).', 'warning');
    return;
  }
  const base = basePath.replace(/\.[^./\\]+$/, '');
  const formats = ['ass', 'srt', 'vtt'];
  let ok = 0;
  for (const format of formats) {
    const ext = SUBS_FORMATS[format]?.extensions[0] ?? format;
    try {
      await invoke('export_subtitle_file', {
        project: state.project,
        outputPath: `${base}.${ext}`,
        format,
        videoW: state.videoW,
        videoH: state.videoH,
      });
      ok++;
    } catch (err) {
      toast(`${format.toUpperCase()} export failed: ${err}`, 'error');
    }
  }
  if (ok === formats.length) {
    toast('Exported ASS, SRT, and VTT', 'success');
    hideModal('modal-export-subs');
  } else if (ok > 0) {
    toast(`Exported ${ok}/${formats.length} formats`, 'warning');
  }
});

document.getElementById('btn-subs-cancel')?.addEventListener('click', () => {
  hideModal('modal-export-subs');
});