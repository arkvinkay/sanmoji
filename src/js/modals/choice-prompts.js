import { escHtml } from '../utils.js';
import { openChoiceModal } from '../modal-manager.js';

export function promptDuplicateRow() {
  return openChoiceModal(document.getElementById('modal-duplicate-row'), {
    message: 'Where should the duplicate be placed? IN time will be set 1 ms after the row above.',
  });
}

export function promptCloseVideo() {
  return openChoiceModal(document.getElementById('modal-close-video'), {
    message: 'What should happen to subtitle rows?',
  });
}

/**
 * @param {{ legacy_identifier: string, legacy_data_dir: string, items: string[] }} offer
 */
export function promptLegacyMigration(offer) {
  const modal = document.getElementById('modal-legacy-migration');
  const list = document.getElementById('legacy-migration-items');
  if (list) {
    list.innerHTML = offer?.items?.length
      ? offer.items.map(item => `<li>${escHtml(item)}</li>`).join('')
      : '';
  }
  const itemSummary = offer?.items?.length
    ? offer.items.join(', ')
    : 'settings';
  return openChoiceModal(modal, {
    message: `SanMoji found data from the previous installation (${offer.legacy_identifier}). Copy ${itemSummary} into this version?`,
  });
}