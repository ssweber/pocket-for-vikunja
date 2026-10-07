// A task's progress, and marking it done (src/js/progress.js).
import './browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doneText, openSubtasks, pctOf, progressPatch, undoing } from '../../src/js/progress.js';

test('progress in percent, from Vikunja\'s 0 to 1', () => {
  assert.equal(pctOf({ percent_done: 0.3 }), 30);
  assert.equal(pctOf({ percent_done: 0.299999 }), 30);
  assert.equal(pctOf({}), 0);
  assert.equal(pctOf(null), 0);
});

test('100% marks it done and leaves its progress; a repeating task starts its next time at 0%', () => {
  assert.deepEqual(progressPatch({}, 60), { percent_done: 0.6 });
  assert.deepEqual(progressPatch({}, 100), { done: true });
  assert.deepEqual(progressPatch({}, 120), { done: true });
  assert.deepEqual(progressPatch({ repeat_after: 86400 }, 100), { done: true, percent_done: 0 });
});

test('the subtasks ticked with a task: only open ones that don\'t repeat, and none for a repeating task', () => {
  const t = { related_tasks: { subtask: [{ id: 1 }, { id: 2, done: true }, { id: 3, repeat_after: 3600 }, { id: 4, repeat_mode: 1 }] } };
  assert.deepEqual(openSubtasks(t).map(s => s.id), [1]);
  assert.deepEqual(openSubtasks({ ...t, repeat_after: 86400 }), []);
  assert.deepEqual(openSubtasks({}), []);
});

test('an Undo putting progress back says nothing of its own', () => {
  assert.equal(undoing({ percent_done: 0.4 }), true);
  assert.equal(undoing({ percent_done: 0.4, done: true }), false);
  assert.equal(undoing({}), false);
});

test('what a tick says', () => {
  assert.equal(doneText(0, 0, 'Call Jo'), 'Done: Call Jo');
  assert.equal(doneText(0, 0), 'Done');
  assert.equal(doneText(2, 2, 'Pack'), 'Done: Pack, with 2 subtasks');
  assert.equal(doneText(1, 1, 'Pack'), 'Done: Pack, with 1 subtask');
  assert.equal(doneText(1, 3, 'Pack'), 'Done: Pack, with 1 of its 3 open subtasks. The rest couldn\'t be saved.');
  assert.equal(doneText(0, 0, 'x'.repeat(50)), 'Done: ' + 'x'.repeat(38) + '…', 'a long title is cut short');
});
