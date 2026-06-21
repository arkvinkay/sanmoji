/**
 * Frontend validation — mirrors backend rules in validation.rs (Q12)
 */
import { state } from './state.js';

function collectOverlapIssues(rows, issues) {
  if (!rows || rows.length < 2) return;
  const indexed = rows.map((row, idx) => ({ idx, row })).sort((a, b) => a.row.start_ms - b.row.start_ms);
  const active = [];
  for (const { idx, row } of indexed) {
    for (let i = active.length - 1; i >= 0; i -= 1) {
      if (active[i].end <= row.start_ms) active.splice(i, 1);
    }
    for (const other of active) {
      issues.push({
        severity: 'warning',
        message: `Rows ${other.idx + 1} and ${idx + 1} overlap in time`,
      });
    }
    active.push({ idx, end: row.end_ms });
  }
}

export function validateProjectFrom(project) {
  const issues = [];
  if (!project) {
    issues.push({ severity: 'error', message: 'No project loaded' });
    return issues;
  }
  if (!project.video_path) {
    issues.push({ severity: 'error', message: 'No video file linked' });
  }
  if (!project.rows?.length) {
    issues.push({ severity: 'warning', message: 'No subtitle rows' });
  }
  project.rows?.forEach((row, i) => {
    const n = i + 1;
    if (row.start_ms < 0) {
      issues.push({ severity: 'error', message: `Row ${n}: negative start time` });
    }
    if (row.end_ms < 0) {
      issues.push({ severity: 'error', message: `Row ${n}: negative end time` });
    }
    if (row.end_ms < row.start_ms) {
      issues.push({ severity: 'error', message: `Row ${n}: end time before start time` });
    }
    if (row.end_ms === row.start_ms) {
      issues.push({ severity: 'warning', message: `Row ${n}: zero duration` });
    }
    if (!row.romaji && !row.indo && !row.english) {
      issues.push({ severity: 'warning', message: `Row ${n}: all tracks empty` });
    }
  });
  collectOverlapIssues(project.rows, issues);
  return issues;
}

export function validateProjectLocal() {
  return validateProjectFrom(state.project);
}

export function hasBlockingErrors(issues) {
  return issues?.some(i => i.severity === 'error');
}