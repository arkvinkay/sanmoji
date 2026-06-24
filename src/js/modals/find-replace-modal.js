import { state } from '../state.js';
import { renderRows } from '../editor.js';
import { pushHistory } from '../history.js';
import { toast } from '../toast.js';
import { showModal, hideModal } from './_shared.js';

function escapeRegexLiteral(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildFindReplacer(find, repl, caseInsensitive, useRegex) {
  if (useRegex) {
    const flags = caseInsensitive ? 'gi' : 'g';
    const re = new RegExp(find, flags);
    return {
      replace(text) {
        if (!text) return { text, count: 0 };
        const matches = text.match(re);
        if (!matches?.length) return { text, count: 0 };
        return { text: text.replace(re, repl), count: matches.length };
      },
    };
  }
  if (caseInsensitive) {
    const re = new RegExp(escapeRegexLiteral(find), 'gi');
    return {
      replace(text) {
        if (!text) return { text, count: 0 };
        const matches = text.match(re);
        if (!matches?.length) return { text, count: 0 };
        return { text: text.replace(re, repl), count: matches.length };
      },
    };
  }
  return {
    replace(text) {
      if (!text?.includes(find)) return { text, count: 0 };
      const parts = text.split(find);
      return { text: parts.join(repl), count: parts.length - 1 };
    },
  };
}

export function openFindReplaceModal() {
  if (!state.project?.rows.length) {
    toast('No subtitle rows to search', 'warning');
    return;
  }
  document.getElementById('fr-find').value = '';
  document.getElementById('fr-replace').value = '';
  showModal('modal-find-replace');
}

document.getElementById('btn-fr-apply')?.addEventListener('click', () => {
  const find = document.getElementById('fr-find')?.value ?? '';
  if (!find) {
    toast('Enter text to find', 'warning');
    return;
  }
  const repl = document.getElementById('fr-replace')?.value ?? '';
  const caseInsensitive = document.getElementById('fr-case-insensitive')?.checked ?? false;
  const useRegex = document.getElementById('fr-regex')?.checked ?? false;
  const tracks = [];
  if (document.getElementById('fr-romaji')?.checked) tracks.push('romaji');
  if (document.getElementById('fr-indo')?.checked) tracks.push('indo');
  if (document.getElementById('fr-english')?.checked) tracks.push('english');
  if (!tracks.length) {
    toast('Select at least one track', 'warning');
    return;
  }

  let replacer;
  try {
    replacer = buildFindReplacer(find, repl, caseInsensitive, useRegex);
  } catch (err) {
    toast('Invalid regex: ' + err.message, 'error');
    return;
  }

  let count = 0;
  pushHistory();
  for (const row of state.project.rows) {
    for (const t of tracks) {
      const result = replacer.replace(row[t] ?? '');
      if (result.count > 0) {
        row[t] = result.text;
        count += result.count;
      }
    }
  }
  renderRows();
  hideModal('modal-find-replace');
  toast(count ? `Replaced ${count} occurrence(s)` : 'No matches found', count ? 'success' : 'info');
});

document.getElementById('btn-fr-cancel')?.addEventListener('click', () => {
  hideModal('modal-find-replace');
});