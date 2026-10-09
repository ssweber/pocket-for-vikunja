// A task's progress, marking it done, and what a finger does on a row (src/js/progress.js).
import './browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimsOnSlide, DELETE_W, EDGE, EDGE_GUARD, isNudge, isSubtask, MANY_STEPS, LOCK_PX, lockDirection, nextSnap, NUDGE_MAX_PX, NUDGE_MAX_SPEED, NUDGE_MIN_PX, NUDGE_SPEED_MS, openSubtasks, pctOf, progressPatch, QUARTER_PX, releaseSpeed, runLine, slidePct, snapPct, SWIPE_SLOPE, swipeEnd, swipeOffset, swipeStarts, trackAt, trackMoves, undoing } from '../../src/js/progress.js';

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

test('after a hold, the first few pixels decide the way: up or down moves the row, sideways lets it go', () => {
  assert.equal(lockDirection(4, 5), null);
  assert.equal(lockDirection(LOCK_PX, 0), 'x');
  assert.equal(lockDirection(-8, 7), 'x');
  assert.equal(lockDirection(3, -11), 'y');
  assert.equal(lockDirection(7, 7.5), 'y');
});

test('a swipe: either way, clearly sideways, not from the screen\'s edges; on an open row, from anywhere', () => {
  assert.equal(swipeStarts(-9, 2, 200, 390), true);
  assert.equal(swipeStarts(9, 2, 200, 390), true, 'to the right too: its progress, with no hold first');
  assert.equal(swipeStarts(-9, 12, 200, 390), false, 'more up or down: a scroll');
  assert.equal(swipeStarts(10, 9, 200, 390), false, 'about as much up or down: a slow scroll that wanders, or a nudge, stays a scroll');
  assert.equal(swipeStarts(12, 12 / SWIPE_SLOPE - 1, 200, 390), true, 'clearly sideways');
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

/* Progress and Delete are one track (parent-tasks-plan, part 1): swiped right, progress goes up, the room being the
   rest of the way to the screen's edge; left, down a quarter each QUARTER_PX, then on into the row's Delete. */
test('a swipe right sets progress up in snaps, a full swipe is done, and a done row stays done', () => {
  const at = (dx, start = 0, x = 100) => trackAt({ start, dx, x, width: 358, screen: 390, del: true });
  const room = 390 - EDGE - 100;
  assert.deepEqual(at(room * .3), { pct: 25, off: 0 });
  assert.deepEqual(at(room), { pct: 100, off: 0 }, 'a full swipe: done');
  assert.deepEqual(at(room * .3, 50), { pct: 75, off: 0 }, 'from where it was');
  assert.deepEqual(at(80, 100), { pct: 100, off: 0 }, 'done stays done');
  assert.equal(trackMoves(100, 1), false, 'so a swipe right on a done row isn\'t taken');
  assert.equal(trackMoves(0, 1), true);
});

test('a swipe left lowers progress a quarter at a time, then goes on into the row\'s Delete; a done row opens again at 75%', () => {
  const at = (dx, start, x = 300, del = true) => trackAt({ start, dx, x, width: 358, screen: 390, del });
  assert.deepEqual(at(-QUARTER_PX, 50), { pct: 25, off: 0 });
  assert.deepEqual(at(-QUARTER_PX * 1.6, 50), { pct: 0, off: 0 }, 'at 0%, a stop before its Delete');
  assert.deepEqual(at(-QUARTER_PX * 2 - 40, 50), { pct: 0, off: -40 }, 'past 0%, its Delete, measured from there');
  assert.equal(swipeEnd(at(-QUARTER_PX * 2 - 200, 50).off, 358), 'delete', 'a full swipe from 50% deletes it');
  assert.deepEqual(at(-QUARTER_PX, 100), { pct: 75, off: 0 }, 'a done row: open again, at 75%');
  assert.deepEqual(at(-QUARTER_PX * 4 - 10, 100), { pct: 0, off: -10 }, 'and on down, into its Delete');
  assert.deepEqual(at(-30, 0), { pct: 0, off: -30 }, 'at 0%, straight into its Delete, as before');
  assert.deepEqual(at(-200, 50, 300, false), { pct: 0, off: 0 }, 'a row with no Delete (a run\'s template step, a card\'s step) stops at 0%');
  // Put down near the left edge, the quarters come closer together, so 0% is still within reach.
  assert.equal(trackAt({ start: 100, dx: -40, x: 60, width: 358, screen: 390 }).pct, 0);
  assert.equal(trackMoves(0, -1), false, 'nothing to lower at 0%');
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

test('a run\'s line has a segment per step, each filled by whether its own step is done; past MANY_STEPS, one line with ticks, filled the same way', () => {
  const none = n => Array(n).fill(false);
  assert.deepEqual([runLine(none(MANY_STEPS)).segs, runLine(none(MANY_STEPS)).many], [12, false]);
  assert.equal(runLine(none(MANY_STEPS + 1)).many, true);
  assert.deepEqual(runLine([]), { segs: 1, many: false, fill: null }, 'no steps: nothing to fill, and nothing divided by 0');
  assert.equal(runLine([true, false, true, false]).fill, 'linear-gradient(to right,var(--accent) 0% 25%,var(--track) 25% 50%,var(--accent) 50% 75%,var(--track) 75% 100%)', 'the first and third done: those two filled, not the first two');
  assert.equal(runLine([true, true, false]).fill, 'linear-gradient(to right,var(--accent) 0% 66.667%,var(--track) 66.667% 100%)', 'steps alike side by side, one stretch');
  assert.equal(runLine([false, false, false]).fill, 'linear-gradient(to right,var(--track) 0% 100%)');
  const many = Array.from({ length: 14 }, (_, i) => i === 1 || i === 8);   // the 2nd and 9th of 14 done
  assert.deepEqual([runLine(many).many, runLine(many).fill], [true, 'linear-gradient(to right,var(--track) 0% 7.143%,var(--accent) 7.143% 14.286%,var(--track) 14.286% 57.143%,var(--accent) 57.143% 64.286%,var(--track) 64.286% 100%)'], 'past MANY_STEPS too, each step’s stretch by its own step');
  assert.equal(runLine([1, 0.5, 0, true]).fill, 'linear-gradient(to right,var(--accent) 0% 37.5%,var(--track) 37.5% 75%,var(--accent) 75% 100%)', 'a step half done: half its segment, from the left');
  assert.equal(runLine([0, 0.25]).fill, 'linear-gradient(to right,var(--track) 0% 50%,var(--accent) 50% 62.5%,var(--track) 62.5% 100%)');
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
