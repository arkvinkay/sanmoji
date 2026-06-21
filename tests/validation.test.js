import { validateProjectFrom, hasBlockingErrors } from '../src/js/validation.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function hasMessage(issues, fragment) {
  return issues.some(i => i.message.includes(fragment));
}

// null project
{
  const issues = validateProjectFrom(null);
  assert(hasMessage(issues, 'No project loaded'), 'expected null project error');
  assert(hasBlockingErrors(issues), 'expected blocking errors for null project');
}

// missing video
{
  const issues = validateProjectFrom({
    video_path: '',
    rows: [{ id: '1', start_ms: 0, end_ms: 1000, romaji: 'hi', indo: '', english: '' }],
  });
  assert(hasMessage(issues, 'No video file linked'), 'expected missing video error');
  assert(hasBlockingErrors(issues), 'expected blocking errors for missing video');
}

// zero-duration row
{
  const issues = validateProjectFrom({
    video_path: 'test.mp4',
    rows: [{ id: '1', start_ms: 500, end_ms: 500, romaji: 'x', indo: '', english: '' }],
  });
  assert(hasMessage(issues, 'zero duration'), 'expected zero-duration warning');
  assert(!hasBlockingErrors(issues), 'zero duration should not block export');
}

// negative timing
{
  const issues = validateProjectFrom({
    video_path: 'test.mp4',
    rows: [
      { id: '1', start_ms: -100, end_ms: 500, romaji: 'a', indo: '', english: '' },
      { id: '2', start_ms: 2000, end_ms: 1500, romaji: 'b', indo: '', english: '' },
    ],
  });
  assert(hasMessage(issues, 'negative start time'), 'expected negative start error');
  assert(hasMessage(issues, 'end time before start'), 'expected invalid timing detection');
  assert(hasBlockingErrors(issues), 'expected blocking errors for negative/invalid timing');
}

// overlaps
{
  const issues = validateProjectFrom({
    video_path: 'test.mp4',
    rows: [
      { id: '1', start_ms: 0, end_ms: 2000, romaji: 'a', indo: '', english: '' },
      { id: '2', start_ms: 1500, end_ms: 3000, romaji: 'b', indo: '', english: '' },
    ],
  });
  assert(hasMessage(issues, 'overlap in time'), 'expected overlap warning');
  assert(!hasBlockingErrors(issues), 'overlap should be a warning only');
}

console.log('validation.test.js: ok');