// A task's progress, marking it done, and what a finger does on a row (src/js/progress.js).
import './browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DELETE_W, doneText, EDGE, EDGE_GUARD, isSubtask, LOCK_PX, lockDirection, nextSnap, openSubtasks, pctOf, progressPatch, slidePct, snapPct, swipeOffset, swipeOpens, swipeStarts, undoing } from '../../src/js/progress.js';

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

test('a slide snaps to the quarters, and progress set elsewhere stays until it\'s slid nearer a snap', () => {
  assert.equal(snapPct(0, 11), 0);
  assert.equal(snapPct(0, 13), 25);
  assert.equal(snapPct(50, 62), 50);
  assert.equal(snapPct(50, 63), 75);
  assert.equal(snapPct(0, 100), 100);
  assert.equal(snapPct(40, 41), 40, 'set elsewhere: still 40% just after the hold');
  assert.equal(snapPct(40, 46), 50, 'slid right, to the nearest snap');
  assert.equal(snapPct(40, 32), 25, 'slid left, to the nearest snap');
  assert.equal(snapPct(40, 45), 40, 'halfway between: where it was');
});

test('the arrow keys go to the next snap', () => {
  assert.equal(nextSnap(0, 1), 25);
  assert.equal(nextSnap(40, 1), 50);
  assert.equal(nextSnap(40, -1), 25);
  assert.equal(nextSnap(75, 1), 100);
  assert.equal(nextSnap(100, 1), 100);
  assert.equal(nextSnap(0, -1), 0);
});

test('the room to slide in is the rest of the way to the screen\'s edge, less EDGE', () => {
  const at = (dx, start = 0, x = 100) => slidePct({ start, dx, x, width: 358, screen: 390 });
  const room = 390 - EDGE - 100;
  assert.equal(at(room), 100);
  assert.equal(at(room * .5), 50);
  assert.equal(at(room * .3), 25);
  assert.equal(at(room + 40), 100, 'past the edge stays at 100%');
  assert.equal(at(-50), 0, 'left of where it was, from 0%: still 0%');
  assert.equal(at(-100, 50), 0, 'from 50%, the room on the left is the rest of the way to 0%');
  // Held close to the edge, there's still a quarter of the row's width, or most of what's left, to slide in.
  assert.equal(slidePct({ start: 0, dx: 30, x: 350, width: 358, screen: 390 }), 100);
});

test('after a hold, the first few pixels decide the way: sideways for progress, up or down for order', () => {
  assert.equal(lockDirection(4, 5), null);
  assert.equal(lockDirection(LOCK_PX, 0), 'x');
  assert.equal(lockDirection(-8, 7), 'x');
  assert.equal(lockDirection(3, -11), 'y');
  assert.equal(lockDirection(7, 7.5), 'y');
});

test('a swipe to Delete: left and mostly sideways, not from the screen\'s edges, and it stays open past a third of the button', () => {
  assert.equal(swipeStarts(-9, 2, 200, 390), true);
  assert.equal(swipeStarts(9, 2, 200, 390), false, 'to the right');
  assert.equal(swipeStarts(-9, 12, 200, 390), false, 'more up or down: a scroll');
  assert.equal(swipeStarts(-9, 2, EDGE_GUARD, 390), false, 'from the left edge: the phone\'s Back');
  assert.equal(swipeStarts(-9, 2, 390 - 10, 390), false, 'from the right edge: the phone\'s too');
  assert.equal(swipeOffset(20), 0);
  assert.equal(swipeOffset(-40), -40);
  assert.equal(swipeOffset(-DELETE_W - 30), -DELETE_W - 10, 'past the button, it follows more slowly');
  assert.equal(swipeOpens(-DELETE_W / 3 - 1), true);
  assert.equal(swipeOpens(-DELETE_W / 3 + 1), false);
});

test('a subtask is a task with a parent', () => {
  assert.equal(isSubtask({ related_tasks: { parenttask: [{ id: 1 }] } }), true);
  assert.equal(isSubtask({ related_tasks: { parenttask: [] } }), false);
  assert.equal(isSubtask({}), false);
});
