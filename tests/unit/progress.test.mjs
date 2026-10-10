// A task's progress, marking it done, and what a finger does on a row (src/js/progress.js).
import './browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimsOnSlide, DELETE_W, EDGE_GUARD, figureOf, figurePatch, inTextField, isNudge, isSubtask, LOCK_PX, lockDirection, NUDGE_MAX_PX, NUDGE_MAX_SPEED, NUDGE_MIN_PX, NUDGE_SPEED_MS, openSubtasks, pctOf, progressPatch, quarterOn, QUARTERS, releaseSpeed, SIDES, slideStarts, SWIPE_SLOPE, swipeAt, swipeEnd, swipeFeel, swipeOffset, swipeStarts, TEXT_FIELD, trackMoves, typedIn, undoing, workedOut } from '../../src/js/progress.js';

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

test('the sheet\'s Progress line: the quarters below done, the one a task is at pressed, none when done or set elsewhere', () => {
  assert.deepEqual(QUARTERS, [0, 25, 50, 75], 'done is the tick');
  assert.equal(quarterOn({ percent_done: 0 }), 0);
  assert.equal(quarterOn({ percent_done: 0.5 }), 50);
  assert.equal(quarterOn({ percent_done: 0.3 }), null, 'set on the web at 30%: none pressed');
  assert.equal(quarterOn({ percent_done: 0.5, done: true }), null, 'a done task: none pressed, a tap opens it again at that');
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

/* What a finger went down on, as far as the guard asks: its tag, whether it's contenteditable (true, false, or not
   said), and what it's in. There's no DOM here, so `closest` reads the guard's own list of selectors. */
const el = (tag, parent = null, editable) => ({ tag, parent, editable, closest(sel){
  const is = e => sel.split(',').map(x => x.trim()).some(x => x.startsWith('[contenteditable]') ? e.editable === true : x === e.tag);
  for (let e = this; e; e = e.parent) if (is(e)) return e;
  return null;
} });
test('a touch that starts in a text field never starts a gesture: an input, a textarea, a select, anything contenteditable', () => {
  for (const tag of ['input', 'textarea', 'select']) assert.equal(inTextField(el(tag)), true, tag);
  assert.equal(inTextField(el('div', null, true)), true, 'contenteditable');
  assert.equal(inTextField(el('b', el('p', el('div', null, true)))), true, 'anything inside it');
  assert.equal(inTextField(el('div', null, false)), false, 'contenteditable="false" is not');
  assert.equal(inTextField(el('span', el('button', el('div')))), false, 'a row\'s title, its tick, the space beside a field');
  assert.equal(inTextField(el('span', el('label'))), false, 'a label over a hidden file input: the label is what\'s touched');
  assert.equal(inTextField({}), false, 'what has no closest (a text node)');
  assert.equal(inTextField(null), false);
  assert.deepEqual(TEXT_FIELD.split(',').map(x => x.trim()), ['input', 'textarea', 'select', '[contenteditable]:not([contenteditable="false"])'], 'one list, in one place');
});

test('a field that\'s typed in keeps the phone\'s keyboard up while it has the focus; a select, a date or a file doesn\'t', () => {
  assert.equal(typedIn({ tagName: 'TEXTAREA' }), true, 'notes, a title, a comment');
  for (const type of ['text', 'search', 'email', 'number', '']) assert.equal(typedIn({ tagName: 'INPUT', type }), true, 'input ' + type);
  for (const type of ['datetime-local', 'date', 'time', 'file', 'checkbox', 'radio', 'range', 'button', 'submit']) assert.equal(typedIn({ tagName: 'INPUT', type }), false, 'input ' + type);
  assert.equal(typedIn({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(typedIn({ tagName: 'SELECT' }), false, 'a select keeps the focus once its list has closed');
  assert.equal(typedIn({ tagName: 'BUTTON' }), false);
  assert.equal(typedIn({ tagName: 'BODY' }), false, 'nothing focused');
  assert.equal(typedIn(null), false);
});

test('the sheet slides down from its bar, or from anywhere at its top with nothing being typed in; never from a text field', () => {
  const at = (field, bar, top, typing) => slideStarts({ field, bar, top, typing });
  assert.equal(at(false, false, true, false), true, 'scrolled to its top, nothing focused: from anywhere');
  assert.equal(at(false, false, false, false), false, 'scrolled down: a pull down scrolls it back up');
  assert.equal(at(false, true, false, false), true, 'from its bar, wherever it\'s scrolled to');
  assert.equal(at(false, false, true, true), false, 'a field being typed in: a pull down beside it only puts the keyboard away');
  assert.equal(at(false, true, true, true), true, 'from its bar, even so');
  assert.equal(at(false, true, false, true), true);
  assert.equal(at(true, false, true, false), false, 'a touch that starts in the notes: never, at the top');
  assert.equal(at(true, false, true, true), false, 'nor while they have the focus');
  assert.equal(at(true, true, true, false), false, 'nor would a field in the bar');
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

test('a swipe stays on the side it started on: dragged back past where it started, it stops there, changing nothing', () => {
  const at = (dx, start, side, del = true) => swipeAt({ start, dx, x: 200, width: W, screen: SCREEN, del, side });
  assert.deepEqual(at(-150, 0, 'right'), { off: 0, pct: 0, to: 'stop' }, 'a row at 0% swiped right, then back left: no Delete, it springs back');
  assert.deepEqual(at(-150, null, 'right'), { off: 0, pct: null, to: 'stop' }, 'nor for a row whose progress isn\'t swiped');
  assert.deepEqual(at(150, 50, 'left'), { off: 0, pct: 50, to: 'stop' }, 'a row at 50% swiped left, then back right: no progress up, it stays at 50%');
  assert.deepEqual(at(150, 0, 'left'), { off: 0, pct: 0, to: 'shut' }, 'started into its Delete: back right, its Delete shut, nothing set');
  assert.deepEqual(at(0, 75, 'left'), { off: 0, pct: 75, to: 'stop' }, 'let go where it started: its progress as it was');
  assert.equal(at(-150, 0, null).to, 'open', 'without a side (as before): its Delete');
  assert.equal(swipeAt({ start: 0, dx: -100, x: 200, width: W, screen: SCREEN, del: true, one: true, side: 'right' }).to, 'stop', 'a parent\'s header the same');
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

test('a swipe moves a row\'s progress only where it can go: not up from done, nor down from 0%', () => {
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
