// A task's progress, marking it done, and what a finger does on a row (src/js/progress.js).
import './browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimsOnSlide, DELETE_W, EDGE, EDGE_GUARD, isNudge, isSubtask, MANY_STEPS, LOCK_PX, lockDirection, nextSnap, NUDGE_MAX_PX, NUDGE_MAX_SPEED, NUDGE_MIN_PX, NUDGE_SPEED_MS, openSubtasks, pctOf, progressPatch, releaseSpeed, runLine, slidePct, snapPct, swipeEnd, swipeOffset, swipeStarts, undoing } from '../../src/js/progress.js';

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

test('a swipe to Delete: left and mostly sideways, not from the screen\'s edges; on an open row, either way', () => {
  assert.equal(swipeStarts(-9, 2, 200, 390), true);
  assert.equal(swipeStarts(9, 2, 200, 390), false, 'to the right');
  assert.equal(swipeStarts(-9, 12, 200, 390), false, 'more up or down: a scroll');
  assert.equal(swipeStarts(-9, 2, EDGE_GUARD, 390), false, 'from the left edge: the phone\'s Back');
  assert.equal(swipeStarts(-9, 2, 390 - 10, 390), false, 'from the right edge: the phone\'s too');
  assert.equal(swipeStarts(9, 2, 200, 390, true), true, 'an open row, swiped back');
  assert.equal(swipeStarts(-9, 2, 380, 390, true), true, 'an open row, swiped on');
});

test('let go, a swiped row goes back, stays open on its Delete, or past half its width is deleted', () => {
  const w = 358;
  assert.equal(swipeOffset(20, w), 0, 'not to the right');
  assert.equal(swipeOffset(-40, w), -40, 'with the finger');
  assert.equal(swipeOffset(-500, w), -w, 'no further than the row');
  assert.equal(swipeEnd(-DELETE_W / 3 + 1, w), 'shut');
  assert.equal(swipeEnd(-DELETE_W / 3 - 1, w), 'open');
  assert.equal(swipeEnd(-w / 2 + 1, w), 'open', 'just under half: still only open');
  assert.equal(swipeEnd(-w / 2 - 1, w), 'delete', 'past half: a full swipe');
  assert.equal(swipeEnd(swipeOffset(-DELETE_W - 100, w), w), 'delete', 'carried on from the open row');
});

test('a subtask is a task with a parent', () => {
  assert.equal(isSubtask({ related_tasks: { parenttask: [{ id: 1 }] } }), true);
  assert.equal(isSubtask({ related_tasks: { parenttask: [] } }), false);
  assert.equal(isSubtask({}), false);
});

test('sliding progress claims a task only where no one is on it and its slot can be tapped', () => {
  assert.equal(claimsOnSlide({ can: true, users: [] }), true, '"+ me": it\'s yours');
  assert.equal(claimsOnSlide({ can: false, users: [{ id: 2 }] }), false, 'someone else\'s stays theirs');
  assert.equal(claimsOnSlide({ can: true, mine: true, users: [{ id: 1 }] }), false, 'yours already');
  assert.equal(claimsOnSlide({ can: false, users: [] }), false, 'done, or shared with you to read');
  assert.equal(claimsOnSlide(null), false, 'no slot: a run, a template, a task waiting to be sent');
});

test('a run\'s line has a segment per step, the done ones filled; past MANY_STEPS, one line with ticks', () => {
  assert.deepEqual(runLine(4, 1), { segs: 4, done: 1, many: false });
  assert.deepEqual(runLine(MANY_STEPS, MANY_STEPS), { segs: 12, done: 12, many: false });
  assert.equal(runLine(MANY_STEPS + 1, 0).many, true);
  assert.deepEqual(runLine(0, 0), { segs: 1, done: 0, many: false }, 'no steps: nothing to fill, and nothing divided by 0');
  assert.equal(runLine(3, 5).done, 3, 'never more done than there are steps');
});

test('a nudge: a touch moved up or down past a tap, within about a row, and slow as it lifts; else a tap or a fling', () => {
  assert.equal(isNudge({ dy: 30, ms: 300, speed: 0.1 }), true, 'a short, slow scroll');
  assert.equal(isNudge({ dy: -30, ms: 300, speed: 0.1 }), true, 'up as well as down');
  assert.equal(isNudge({ dy: NUDGE_MIN_PX - 1, ms: 300, speed: 0 }), false, 'hardly moved: a tap, or a hold');
  assert.equal(isNudge({ dy: NUDGE_MAX_PX, ms: 400, speed: 0.1 }), true, 'a row\'s height');
  assert.equal(isNudge({ dy: NUDGE_MAX_PX + 1, ms: 2000, speed: 0.1 }), false, 'further: a scroll, however slow');
  assert.equal(isNudge({ dy: 40, ms: 400, speed: NUDGE_MAX_SPEED + 0.1 }), false, 'fast as it lifts: a fling');
  assert.equal(isNudge({ dx: 30, dy: 20, ms: 300, speed: 0.1 }), false, 'more sideways: a swipe');
  assert.equal(isNudge({ dy: 40, ms: 50 }), false, 'no speed given: its average, here fast');
  assert.equal(isNudge({ dy: 40, ms: 400 }), true, 'its average, here slow');
});

test('the speed as the finger lifts is over its last moves, not the whole touch', () => {
  const slow = [0, 40, 80, 120, 160, 200].map((t, i) => ({ t, y: 400 - i * 5 }));
  assert.equal(releaseSpeed(slow, 240, 370), 10 / 80, `from its first move in the last ${NUDGE_SPEED_MS}ms`);
  // Slow, then flicked at the end: the end is what counts.
  const flick = [{ t: 0, y: 400 }, { t: 500, y: 390 }, { t: 600, y: 388 }, { t: 620, y: 370 }];
  assert.ok(releaseSpeed(flick, 640, 340) > NUDGE_MAX_SPEED);
  assert.equal(releaseSpeed([{ t: 0, y: 400 }], 50, 380), 20 / 50, 'a touch shorter than that: from where it went down');
  assert.equal(releaseSpeed([{ t: 0, y: 400 }, { t: 300, y: 380 }], 900, 380), 0, 'held still before lifting: no speed');
  assert.equal(releaseSpeed([{ t: 0, y: 400 }, { t: 70, y: 425 }, { t: 190, y: 450 }], 200, 450), 25 / 130, 'only its last move that recent: from the one before');
  assert.equal(releaseSpeed([], 10, 10), 0);
});
