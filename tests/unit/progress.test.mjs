// A task's progress, marking it done, and what a finger does on a row (src/js/progress.js).
import './browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimsOnSlide, DELETE_W, EDGE, EDGE_GUARD, figureOf, figurePatch, isNudge, isSubtask, LOCK_PX, lockDirection, nextSnap, NUDGE_MAX_PX, NUDGE_MAX_SPEED, NUDGE_MIN_PX, NUDGE_SPEED_MS, openSubtasks, pctOf, progressPatch, QUARTER_PX, releaseSpeed, SIDES, slidePct, snapPct, SWIPE_SLOPE, swipeAt, swipeEnd, swipeFeel, swipeOffset, swipeStarts, trackAt, trackMoves, undoing, workedOut } from '../../src/js/progress.js';

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

/* Swiping a row is one mechanism with mirrored sides (parent-tasks-plan, 1b; SIDES), each with one job, chosen as the
   swipe starts: the content moves with the finger, and what letting go does is shown, not done, until then. Right
   (up): the stops above where it is spread over the first half of the row, then done. Left, a row with progress
   (down): the stops below it the same way, stopping at 0%. Left, a row at 0% (delete): its Delete. */
const W = 358, SCREEN = 390;
test('swiped right, the stops above its progress spread over the first half of the row, and past it, done', () => {
  const at = (dx, start = 0, x = 100) => swipeAt({ start, dx, x, width: W, screen: SCREEN, del: true });
  const half = W * SIDES.up.full;
  assert.deepEqual(at(10), { off: 10, pct: 0, to: 'stop' }, 'a little: the content moves, its progress not yet');
  assert.deepEqual(at(half / 4), { off: half / 4, pct: 25, to: 'stop' });
  assert.deepEqual([at(half / 2).pct, at(half * .75).pct, at(half - 1).pct], [50, 75, 75]);
  assert.deepEqual(at(half), { off: half, pct: 100, to: 'done' }, 'past half: a full swipe, done');
  assert.equal(at(W + 50).off, W, 'never further than the row');
  assert.deepEqual([at(half / 2 - 1, 50).pct, at(half / 2, 50).pct, at(half, 50).to], [50, 75, 'done'], 'from 50%: 75% halfway, done at half');
  assert.deepEqual([at(30, 30).pct, at(half / 3, 30).pct], [30, 50], 'progress set elsewhere: from where it is, to the next stop');
  // Put down near the right edge, the stops come closer, so done is still within reach (slidePct's room).
  const near = swipeAt({ start: 0, dx: 50, x: 330, width: W, screen: SCREEN });
  assert.equal(near.to, 'done');
});

test('swiped left, a row with progress only goes down, spread the same way, and stops at 0% however far it’s pulled', () => {
  const at = (dx, start, x = 300) => swipeAt({ start, dx, x, width: W, screen: SCREEN, del: true });
  const half = W * SIDES.down.full;
  assert.deepEqual(at(-10, 50), { off: -10, pct: 50, to: 'stop' });
  assert.deepEqual(at(-half / 2, 50), { off: -half / 2, pct: 25, to: 'stop' });
  assert.deepEqual(at(-half, 50), { off: -half, pct: 0, to: 'stop' }, 'at half the row: 0%');
  assert.deepEqual(at(-W, 50), { off: -half, pct: 0, to: 'stop' }, 'pulled further: still 0%, no Delete, the row no further');
  assert.deepEqual([at(-half / 4 + 1, 100).pct, at(-half / 4, 100).pct, at(-half * .75, 100).pct, at(-half, 100).pct], [100, 75, 25, 0],
    'a done row: open again at 75%, on down, a quarter of the way each');
  assert.equal(swipeAt({ start: 100, dx: -45, x: 60, width: W, screen: SCREEN }).pct, 0, 'put down near the left edge: the stops closer, so 0% is still within reach');
});

test('swiped left at 0%, a row has its Delete: open on its button, and deleted past half the row', () => {
  const at = (dx, del = true) => swipeAt({ start: 0, dx, x: 300, width: W, screen: SCREEN, del });
  assert.deepEqual(at(-20), { off: -20, pct: 0, to: 'shut' }, 'under a third of its button: it goes back');
  assert.deepEqual(at(-40), { off: -40, pct: 0, to: 'open' });
  assert.equal(at(-W * SIDES.delete.full - 1).to, 'delete');
  assert.deepEqual(at(-100, false), { off: 0, pct: 0, to: 'stop' }, 'no Delete (a template’s step): nothing');
});

test('a row with no progress to swipe, or open on its Delete, has only its Delete', () => {
  const at = (dx, base = 0) => swipeAt({ start: null, dx, x: 200, width: W, screen: SCREEN, del: true, base });
  assert.deepEqual(at(-60), { off: -60, pct: null, to: 'open' });
  assert.deepEqual(at(0, -DELETE_W), { off: -DELETE_W, pct: null, to: 'open' }, 'open, where it rests');
  assert.deepEqual(at(DELETE_W + 40, -DELETE_W), { off: 0, pct: null, to: 'shut' }, 'swiped back: shut, never on to the right');
  assert.equal(at(-W / 2, -DELETE_W).to, 'delete', 'swiped on: deleted');
});

test('a tick is felt at each stop and at a Delete’s button, a firmer one at a full swipe and at 0%', () => {
  const stop = pct => ({ to: 'stop', pct });
  assert.equal(swipeFeel(stop(0), stop(0)), null);
  assert.equal(swipeFeel(stop(0), stop(25)), 'tick');
  assert.equal(swipeFeel(stop(75), { to: 'done', pct: 100 }), 'done');
  assert.equal(swipeFeel({ to: 'done', pct: 100 }, { to: 'done', pct: 100 }), null, 'once');
  assert.equal(swipeFeel(stop(25), stop(0)), 'done', 'lowered to 0%, where it stops: firmer');
  assert.equal(swipeFeel({ to: 'shut', pct: 0 }, { to: 'open', pct: 0 }), 'tick', 'at its Delete’s button');
  assert.equal(swipeFeel({ to: 'open', pct: 0 }, { to: 'delete', pct: 0 }), 'done');
  assert.equal(swipeFeel({ to: 'open', pct: 0 }, { to: 'shut', pct: 0 }), null);
});

test('the sheet\'s bar: right up to the screen\'s edge, left a quarter each QUARTER_PX, done staying done', () => {
  const at = (dx, start, x = 300) => trackAt({ start, dx, x, width: W, screen: SCREEN });
  assert.equal(trackAt({ start: 0, dx: SCREEN - EDGE - 100, x: 100, width: W, screen: SCREEN }), 100);
  assert.equal(at(80, 100), 100);
  assert.equal(at(-QUARTER_PX, 50), 25);
  assert.equal(at(-QUARTER_PX * 4, 50), 0);
  assert.equal(trackMoves(100, 1), false, 'a done row isn\'t swiped up');
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

/* A parent's progress is worked out from its subtasks (parent-tasks-plan, part 3; design rule 5): it has none of its own
   to set. */
test('a parent\'s figure is the average of its subtasks\', a done one 100%, rounded; with none, it has none', () => {
  assert.deepEqual(workedOut([{ pct: 50 }, { pct: 0 }, { pct: 0 }, { pct: 0 }]), { pct: 13, done: 0, total: 4 }, 'one at 50% of four: 13%');
  assert.deepEqual(workedOut([{ done: true }, { pct: 50 }, { done: true, pct: 20 }, { pct: 0 }]), { pct: 63, done: 2, total: 4 }, 'done counts 100%, whatever its progress was');
  assert.deepEqual(workedOut([{ done: true }, { done: true }]), { pct: 100, done: 2, total: 2 });
  assert.equal(workedOut([]), null, 'no subtasks: no figure, so it keeps its last');
  assert.equal(workedOut([{ pct: 150 }]).pct, 100, 'never past 100%');
});

test('the figure written to a parent: from Vikunja\'s copy of its subtasks, only when it changes', () => {
  const parent = (pct, ...subs) => ({ id: 1, percent_done: pct, related_tasks: { subtask: subs } });
  const four = [{ id: 2, percent_done: 0.5 }, { id: 3 }, { id: 4 }, { id: 5 }];
  assert.deepEqual(figureOf(parent(0, ...four)), { pct: 13, done: 0, total: 4 });
  assert.deepEqual(figurePatch(parent(0, ...four)), { percent_done: 0.13 }, 'as the ring shows it, rounded');
  assert.equal(figurePatch(parent(0.13, ...four)), null, 'already that: nothing to save');
  assert.equal(figurePatch(parent(0.4)), null, 'its subtasks all removed: it keeps its last figure');
  assert.deepEqual(figurePatch(parent(0.5, { id: 2, done: true }, { id: 3, done: true })), { percent_done: 1 }, 'every one done: 100%, though it stays open until Close');
});

test('a parent\'s header swiped right has one stop, its full point: it springs back before it, and has no progress to set', () => {
  const at = dx => swipeAt({ start: 0, dx, x: 100, width: W, screen: SCREEN, del: true, one: true });
  const half = W * SIDES.up.full;
  assert.deepEqual(at(half / 4), { off: half / 4, pct: 0, to: 'stop' }, 'a quarter of the way: no 25%');
  assert.deepEqual(at(half - 1), { off: half - 1, pct: 0, to: 'stop' }, 'just short: still nothing, let go it springs back');
  assert.deepEqual(at(half), { off: half, pct: 100, to: 'done' }, 'all the way: its question (or Close)');
  assert.equal(at(-200).to, 'delete', 'left: its Delete, as a row at 0%');
  assert.deepEqual([swipeFeel(at(10), at(half / 2)), swipeFeel(at(half - 1), at(half))], [null, 'done'], 'nothing felt on the way, a firm tick at the full point');
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
