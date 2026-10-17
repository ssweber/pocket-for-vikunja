// A task's progress, marking it done, and the gestures on a row (src/js/progress.js).
import './browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  claimsOnSlide,
  DELETE_W,
  EDGE_GUARD,
  figureOf,
  figurePatch,
  inTextField,
  isNudge,
  isSubtask,
  LOCK_PX,
  lockDirection,
  NUDGE_MAX_PX,
  NUDGE_MAX_SPEED,
  NUDGE_MIN_PX,
  NUDGE_SPEED_MS,
  openSubtasks,
  pctOf,
  progressPatch,
  quarterOn,
  QUARTERS,
  releaseSpeed,
  SIDES,
  slideStarts,
  SWIPE_SLOPE,
  swipeAt,
  swipeEnd,
  swipeFeel,
  swipeOffset,
  swipeStarts,
  TEXT_FIELD,
  tickFeel,
  trackMoves,
  typedIn,
  undoing,
  workedOut,
} from '../../src/js/progress.js';

test("progress in percent, from Vikunja's 0 to 1", () => {
  assert.equal(pctOf({ percent_done: 0.3 }), 30);
  assert.equal(pctOf({ percent_done: 0.299999 }), 30);
  assert.equal(pctOf({}), 0);
  assert.equal(pctOf(null), 0);
});

test('100% marks a task done without changing its progress, and a repeating task starts its next time at 0%', () => {
  assert.deepEqual(progressPatch({}, 60), { percent_done: 0.6 });
  assert.deepEqual(progressPatch({}, 100), { done: true });
  assert.deepEqual(progressPatch({}, 120), { done: true });
  assert.deepEqual(progressPatch({ repeat_after: 86400 }, 100), { done: true, percent_done: 0 });
});

test('ticking a task also ticks its open subtasks that do not repeat, and none if the task repeats', () => {
  const t = {
    related_tasks: {
      subtask: [{ id: 1 }, { id: 2, done: true }, { id: 3, repeat_after: 3600 }, { id: 4, repeat_mode: 1 }],
    },
  };
  assert.deepEqual(
    openSubtasks(t).map(s => s.id),
    [1],
  );
  assert.deepEqual(openSubtasks({ ...t, repeat_after: 86400 }), []);
  assert.deepEqual(openSubtasks({}), []);
});

test('an Undo that restores progress shows no message of its own', () => {
  assert.equal(undoing({ percent_done: 0.4 }), true);
  assert.equal(undoing({ percent_done: 0.4, done: true }), false);
  assert.equal(undoing({}), false);
});

test("the sheet's Progress line has the quarters below done, with the task's quarter pressed, or none if done or set elsewhere", () => {
  assert.deepEqual(QUARTERS, [0, 25, 50, 75], 'done is the tick, not a quarter');
  assert.equal(quarterOn({ percent_done: 0 }), 0);
  assert.equal(quarterOn({ percent_done: 0.5 }), 50);
  assert.equal(quarterOn({ percent_done: 0.3 }), null, 'a progress of 30% set on the web has no quarter pressed');
  assert.equal(
    quarterOn({ percent_done: 0.5, done: true }),
    null,
    'a done task has no quarter pressed, and tapping one opens it again at that progress',
  );
});

test('after a hold, the first few pixels decide the direction: vertical moves the row, and sideways releases it', () => {
  assert.equal(lockDirection(4, 5), null);
  assert.equal(lockDirection(LOCK_PX, 0), 'x');
  assert.equal(lockDirection(-8, 7), 'x');
  assert.equal(lockDirection(3, -11), 'y');
  assert.equal(lockDirection(7, 7.5), 'y');
});

test('a swipe starts when the drag is clearly sideways in either direction and not near a screen edge, or anywhere on an open row', () => {
  assert.equal(swipeStarts(-9, 2, 200, 390), true);
  assert.equal(swipeStarts(9, 2, 200, 390), true, 'swiping right starts too, to set progress with no hold first');
  assert.equal(swipeStarts(-9, 12, 200, 390), false, 'a drag that is more vertical is a scroll');
  assert.equal(
    swipeStarts(10, 9, 200, 390),
    false,
    'a drag that is about as vertical as sideways stays a scroll, whether a slow scroll that wanders or a nudge',
  );
  assert.equal(swipeStarts(12, 12 / SWIPE_SLOPE - 1, 200, 390), true, 'a clearly sideways drag starts a swipe');
  assert.equal(swipeStarts(-9, 2, EDGE_GUARD, 390), false, "a drag from the left edge is the phone's Back gesture");
  assert.equal(swipeStarts(-9, 2, 390 - 10, 390), false, 'a drag from the right edge is also left to the phone');
  assert.equal(swipeStarts(9, 2, 200, 390, true), true, 'an open row can be swiped back');
  assert.equal(swipeStarts(-9, 2, 380, 390, true), true, 'an open row can be swiped further, even near the edge');
});

/* A fake element for the text-field guard. It has a tag, a contenteditable value (true, false, or not set) and a
   parent. There is no DOM here, so `closest` matches the selectors that inTextField passes it. */
const el = (tag, parent = null, editable) => ({
  tag,
  parent,
  editable,
  closest(sel) {
    const is = e =>
      sel
        .split(',')
        .map(x => x.trim())
        .some(x => (x.startsWith('[contenteditable]') ? e.editable === true : x === e.tag));
    for (let e = this; e; e = e.parent) if (is(e)) return e;
    return null;
  },
});
test('a touch that starts in a text field never starts a gesture, including an input, a textarea, a select or contenteditable text', () => {
  for (const tag of ['input', 'textarea', 'select']) assert.equal(inTextField(el(tag)), true, tag);
  assert.equal(inTextField(el('div', null, true)), true, 'contenteditable');
  assert.equal(
    inTextField(el('b', el('p', el('div', null, true)))),
    true,
    'anything inside contenteditable text counts',
  );
  assert.equal(inTextField(el('div', null, false)), false, 'contenteditable="false" does not count');
  assert.equal(
    inTextField(el('span', el('button', el('div')))),
    false,
    "a row's title, its tick and the space beside a field do not count",
  );
  assert.equal(
    inTextField(el('span', el('label'))),
    false,
    'a label over a hidden file input does not count, because the label is what the user touches',
  );
  assert.equal(inTextField({}), false, 'a node with no closest method, such as a text node, does not count');
  assert.equal(inTextField(null), false);
  assert.deepEqual(
    TEXT_FIELD.split(',').map(x => x.trim()),
    ['input', 'textarea', 'select', '[contenteditable]:not([contenteditable="false"])'],
    'the selectors are defined in one place',
  );
});

test("a field the user types in keeps the phone's keyboard up while focused, and a select, date or file field does not", () => {
  assert.equal(typedIn({ tagName: 'TEXTAREA' }), true, 'notes, a title and a comment are typed in');
  for (const type of ['text', 'search', 'email', 'number', ''])
    assert.equal(typedIn({ tagName: 'INPUT', type }), true, 'input ' + type);
  for (const type of ['datetime-local', 'date', 'time', 'file', 'checkbox', 'radio', 'range', 'button', 'submit'])
    assert.equal(typedIn({ tagName: 'INPUT', type }), false, 'input ' + type);
  assert.equal(typedIn({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(
    typedIn({ tagName: 'SELECT' }),
    false,
    'a select keeps the focus after its list has closed, but is not typed in',
  );
  assert.equal(typedIn({ tagName: 'BUTTON' }), false);
  assert.equal(typedIn({ tagName: 'BODY' }), false, 'nothing is focused');
  assert.equal(typedIn(null), false);
});

test('the sheet slides down from its bar, or from anywhere when scrolled to the top and nothing is being typed, never from a text field', () => {
  const at = (field, bar, top, typing) => slideStarts({ field, bar, top, typing });
  assert.equal(
    at(false, false, true, false),
    true,
    'a sheet scrolled to the top with nothing focused slides down from anywhere',
  );
  assert.equal(at(false, false, false, false), false, 'a sheet scrolled down scrolls back up instead');
  assert.equal(at(false, true, false, false), true, 'the sheet slides down from its bar wherever it is scrolled to');
  assert.equal(
    at(false, false, true, true),
    false,
    'with a field being typed in, a pull down beside it only closes the keyboard',
  );
  assert.equal(at(false, true, true, true), true, 'the sheet still slides down from its bar while typing');
  assert.equal(at(false, true, false, true), true);
  assert.equal(
    at(true, false, true, false),
    false,
    'a touch that starts in the notes never slides the sheet, even at the top',
  );
  assert.equal(
    at(true, false, true, true),
    false,
    'a touch in the notes does not slide the sheet while they are focused',
  );
  assert.equal(at(true, true, true, false), false, 'a touch in a field in the bar does not slide the sheet');
});

test('releasing a swiped row closes it, leaves it open on its Delete, or deletes it past half its width', () => {
  const w = 358;
  assert.equal(swipeOffset(20, w), 0, 'the offset is never to the right');
  assert.equal(swipeOffset(-40, w), -40, 'the offset follows the drag');
  assert.equal(swipeOffset(-500, w), -w, 'the offset is never further than the row');
  assert.equal(swipeEnd(-DELETE_W / 3 + 1, w), 'shut');
  assert.equal(swipeEnd(-DELETE_W / 3 - 1, w), 'open');
  assert.equal(swipeEnd(-w / 2 + 1, w), 'open', 'just under half the width only opens the row');
  assert.equal(swipeEnd(-w / 2 - 1, w), 'delete', 'past half the width is a full swipe');
  assert.equal(swipeEnd(swipeOffset(-DELETE_W - 100, w), w), 'delete', 'swiping on from an open row deletes it');
});

/* Swiping a row uses one mechanism for both directions (SIDES). Each side has one job, chosen when the swipe starts.
   The row's content follows the finger, and releasing only shows what will happen. It happens when the user lets go.
   Swiping right (`up`) spreads the progress stops above the current value over the first half of the row, then marks
   the task done. Swiping left on a row with progress (`down`) spreads the stops below the current value the same way,
   down to 0%. Swiping left on a row at 0% (`delete`) reveals its Delete button. */
const W = 358,
  SCREEN = 390;
test('swiping right spreads the stops above the current progress over the first half of the row, and past half marks it done', () => {
  const at = (dx, start = 0, x = 100) => swipeAt({ start, dx, x, width: W, screen: SCREEN, del: true });
  const half = W * SIDES.up.full;
  assert.deepEqual(
    at(10),
    { off: 10, pct: 0, to: 'stop' },
    'a short swipe moves the content but does not change the progress yet',
  );
  assert.deepEqual(at(half / 4), { off: half / 4, pct: 25, to: 'stop' });
  assert.deepEqual([at(half / 2).pct, at(half * 0.75).pct, at(half - 1).pct], [50, 75, 75]);
  assert.deepEqual(
    at(half),
    { off: half, pct: 100, to: 'done' },
    'past half the row is a full swipe and marks the task done',
  );
  assert.equal(at(W + 50).off, W, 'the content never moves further than the row');
  assert.deepEqual(
    [at(half / 2 - 1, 50).pct, at(half / 2, 50).pct, at(half, 50).to],
    [50, 75, 'done'],
    'from 50%, halfway reaches 75% and half the row marks it done',
  );
  assert.deepEqual(
    [at(30, 30).pct, at(half / 3, 30).pct],
    [30, 50],
    'progress set elsewhere starts from its current value and goes to the next stop',
  );
  // A swipe that starts near the right edge has less space, so the stops are closer together and done is still reachable.
  const near = swipeAt({ start: 0, dx: 50, x: 330, width: W, screen: SCREEN });
  assert.equal(near.to, 'done');
});

test('swiping left on a row with progress only lowers it, spread the same way, and stops at 0% however far it is pulled', () => {
  const at = (dx, start, x = 300) => swipeAt({ start, dx, x, width: W, screen: SCREEN, del: true });
  const half = W * SIDES.down.full;
  assert.deepEqual(at(-10, 50), { off: -10, pct: 50, to: 'stop' });
  assert.deepEqual(at(-half / 2, 50), { off: -half / 2, pct: 25, to: 'stop' });
  assert.deepEqual(at(-half, 50), { off: -half, pct: 0, to: 'stop' }, 'half the row is 0%');
  assert.deepEqual(
    at(-W, 50),
    { off: -half, pct: 0, to: 'stop' },
    'pulling further stays at 0%, shows no Delete and moves the row no further',
  );
  assert.deepEqual(
    [at(-half / 4 + 1, 100).pct, at(-half / 4, 100).pct, at(-half * 0.75, 100).pct, at(-half, 100).pct],
    [100, 75, 25, 0],
    'a done row opens again at 75% and goes down a quarter every quarter of the way',
  );
  assert.equal(
    swipeAt({ start: 100, dx: -45, x: 60, width: W, screen: SCREEN }).pct,
    0,
    'a swipe that starts near the left edge has closer stops, so 0% is still within reach',
  );
});

test('swiping left on a row at 0% shows its Delete, opens on its button, and deletes past half the row', () => {
  const at = (dx, del = true) => swipeAt({ start: 0, dx, x: 300, width: W, screen: SCREEN, del });
  assert.deepEqual(
    at(-20),
    { off: -20, pct: 0, to: 'shut' },
    'under a third of the button width, the row closes again',
  );
  assert.deepEqual(at(-40), { off: -40, pct: 0, to: 'open' });
  assert.equal(at(-W * SIDES.delete.full - 1).to, 'delete');
  assert.deepEqual(
    at(-100, false),
    { off: 0, pct: 0, to: 'stop' },
    "a row with no Delete, such as a template's step, does nothing",
  );
});

test('a row with no progress to swipe, or already open on its Delete, offers only its Delete', () => {
  const at = (dx, base = 0) => swipeAt({ start: null, dx, x: 200, width: W, screen: SCREEN, del: true, base });
  assert.deepEqual(at(-60), { off: -60, pct: null, to: 'open' });
  assert.deepEqual(
    at(0, -DELETE_W),
    { off: -DELETE_W, pct: null, to: 'open' },
    'an open row stays open where it rests',
  );
  assert.deepEqual(
    at(DELETE_W + 40, -DELETE_W),
    { off: 0, pct: null, to: 'shut' },
    'swiping back closes the row and never goes to the right',
  );
  assert.equal(at(-W / 2, -DELETE_W).to, 'delete', 'swiping on from an open row deletes it');
});

test('a swipe stays on the side it started on, and dragging back past the start changes nothing', () => {
  const at = (dx, start, side, del = true) => swipeAt({ start, dx, x: 200, width: W, screen: SCREEN, del, side });
  assert.deepEqual(
    at(-150, 0, 'right'),
    { off: 0, pct: 0, to: 'stop' },
    'a row at 0% swiped right and then back left shows no Delete and springs back',
  );
  assert.deepEqual(
    at(-150, null, 'right'),
    { off: 0, pct: null, to: 'stop' },
    'a row whose progress is not swiped shows no Delete either',
  );
  assert.deepEqual(
    at(150, 50, 'left'),
    { off: 0, pct: 50, to: 'stop' },
    'a row at 50% swiped left and then back right does not raise progress and stays at 50%',
  );
  assert.deepEqual(
    at(150, 0, 'left'),
    { off: 0, pct: 0, to: 'shut' },
    'a swipe into the Delete and back right shuts the Delete and sets nothing',
  );
  assert.deepEqual(
    at(0, 75, 'left'),
    { off: 0, pct: 75, to: 'stop' },
    'releasing where the swipe started keeps the progress as it was',
  );
  assert.equal(at(-150, 0, null).to, 'open', 'with no side given, a left swipe shows the Delete');
  assert.equal(
    swipeAt({ start: 0, dx: -100, x: 200, width: W, screen: SCREEN, del: true, one: true, side: 'right' }).to,
    'stop',
    "a parent's header behaves the same",
  );
});

test('the phone vibrates at each stop and at the Delete button, and vibrates more firmly at a full swipe and at 0%', () => {
  const stop = pct => ({ to: 'stop', pct });
  assert.equal(swipeFeel(stop(0), stop(0)), null);
  assert.equal(swipeFeel(stop(0), stop(25)), 'tick');
  assert.equal(swipeFeel(stop(75), { to: 'done', pct: 100 }), 'done');
  assert.equal(swipeFeel({ to: 'done', pct: 100 }, { to: 'done', pct: 100 }), null, 'the phone vibrates once');
  assert.equal(swipeFeel(stop(25), stop(0)), 'done', 'lowering progress to 0% vibrates more firmly');
  assert.equal(
    swipeFeel({ to: 'shut', pct: 0 }, { to: 'open', pct: 0 }),
    'tick',
    'reaching the Delete button vibrates',
  );
  assert.equal(swipeFeel({ to: 'open', pct: 0 }, { to: 'delete', pct: 0 }), 'done');
  assert.equal(swipeFeel({ to: 'open', pct: 0 }, { to: 'shut', pct: 0 }), null);
});

// Tapping a task's or a step's tick makes the phone vibrate, and marking it done vibrates the same as a full swipe.
test('tapping a tick makes the phone vibrate firmly to mark done, as a full swipe does, and lightly to open again', () => {
  assert.equal(tickFeel(false), 'done');
  assert.equal(tickFeel(true), 'tick');
  assert.equal(
    tickFeel(false),
    swipeFeel({ to: 'stop', pct: 75 }, { to: 'done', pct: 100 }),
    'marking done vibrates the same whether tapped or swiped',
  );
});

test("a swipe moves a row's progress only in a direction it can go, not up from done and not down from 0%", () => {
  assert.equal(trackMoves(100, 1), false, 'a done row cannot be swiped up');
  assert.equal(trackMoves(0, -1), false, 'progress at 0% cannot be lowered');
});

test('a subtask is a task with a parent', () => {
  assert.equal(isSubtask({ related_tasks: { parenttask: [{ id: 1 }] } }), true);
  assert.equal(isSubtask({ related_tasks: { parenttask: [] } }), false);
  assert.equal(isSubtask({}), false);
});

test('sliding progress claims a task only if nobody is assigned to it and its slot can be tapped', () => {
  assert.equal(claimsOnSlide({ can: true, users: [] }), true, 'an unassigned task is claimed for you, like "+ me"');
  assert.equal(
    claimsOnSlide({ can: false, users: [{ id: 2 }] }),
    false,
    'a task assigned to someone else stays with them',
  );
  assert.equal(
    claimsOnSlide({ can: true, mine: true, users: [{ id: 1 }] }),
    false,
    'a task already assigned to you is not claimed again',
  );
  assert.equal(
    claimsOnSlide({ can: false, users: [] }),
    false,
    'a done task, or a task shared with you as read-only, is not claimed',
  );
  assert.equal(
    claimsOnSlide(null),
    false,
    'a checklist, a template or a task waiting to be sent has no slot and is not claimed',
  );
});

/* A parent's progress is calculated from its subtasks, so the user can't set it directly. */
test("a parent's percentage is the rounded average of its subtasks' progress, counting a done subtask as 100%", () => {
  assert.deepEqual(
    workedOut([{ pct: 50 }, { pct: 0 }, { pct: 0 }, { pct: 0 }]),
    { pct: 13, done: 0, total: 4 },
    'one subtask at 50% out of four is 13%',
  );
  assert.deepEqual(
    workedOut([{ done: true }, { pct: 50 }, { done: true, pct: 20 }, { pct: 0 }]),
    { pct: 63, done: 2, total: 4 },
    'a done subtask counts as 100%, whatever its progress was',
  );
  assert.deepEqual(workedOut([{ done: true }, { done: true }]), { pct: 100, done: 2, total: 2 });
  assert.equal(workedOut([]), null, 'with no subtasks there is no percentage, so the parent keeps its last one');
  assert.equal(workedOut([{ pct: 150 }]).pct, 100, 'the percentage never goes past 100%');
});

test("a parent's percentage is written from Vikunja's copy of its subtasks, and only when it changes", () => {
  const parent = (pct, ...subs) => ({ id: 1, percent_done: pct, related_tasks: { subtask: subs } });
  const four = [{ id: 2, percent_done: 0.5 }, { id: 3 }, { id: 4 }, { id: 5 }];
  assert.deepEqual(figureOf(parent(0, ...four)), { pct: 13, done: 0, total: 4 });
  assert.deepEqual(
    figurePatch(parent(0, ...four)),
    { percent_done: 0.13 },
    'the written percentage is rounded, as the ring shows it',
  );
  assert.equal(figurePatch(parent(0.13, ...four)), null, 'a percentage that is already correct is not saved again');
  assert.equal(figurePatch(parent(0.4)), null, 'a parent whose subtasks were all removed keeps its last percentage');
  assert.deepEqual(
    figurePatch(parent(0.5, { id: 2, done: true }, { id: 3, done: true })),
    { percent_done: 1 },
    'with every subtask done the percentage is 100%, though the parent stays open until Close',
  );
});

test("swiping a parent's header right has one stop at the full point, springs back before it, and sets no progress", () => {
  const at = dx => swipeAt({ start: 0, dx, x: 100, width: W, screen: SCREEN, del: true, one: true });
  const half = W * SIDES.up.full;
  assert.deepEqual(at(half / 4), { off: half / 4, pct: 0, to: 'stop' }, 'a quarter of the way sets no 25%');
  assert.deepEqual(
    at(half - 1),
    { off: half - 1, pct: 0, to: 'stop' },
    'just short of the full point still sets nothing, and releasing springs back',
  );
  assert.deepEqual(at(half), { off: half, pct: 100, to: 'done' }, 'the full point asks the question, or shows Close');
  assert.equal(at(-200).to, 'delete', 'swiping left shows the Delete, as on a row at 0%');
  assert.deepEqual(
    [swipeFeel(at(10), at(half / 2)), swipeFeel(at(half - 1), at(half))],
    [null, 'done'],
    'the phone does not vibrate on the way and vibrates firmly at the full point',
  );
});

test('a nudge is a touch that moves up or down past a tap, within about a row, and is slow as it lifts', () => {
  assert.equal(isNudge({ dy: 30, ms: 300, speed: 0.1 }), true, 'a short, slow scroll is a nudge');
  assert.equal(isNudge({ dy: -30, ms: 300, speed: 0.1 }), true, 'a nudge works upwards as well as downwards');
  assert.equal(
    isNudge({ dy: NUDGE_MIN_PX - 1, ms: 300, speed: 0 }),
    false,
    'a touch that hardly moved is a tap or a hold',
  );
  assert.equal(isNudge({ dy: NUDGE_MAX_PX, ms: 400, speed: 0.1 }), true, "a nudge can be as long as a row's height");
  assert.equal(
    isNudge({ dy: NUDGE_MAX_PX + 1, ms: 2000, speed: 0.1 }),
    false,
    'a longer touch is a scroll, however slow',
  );
  assert.equal(
    isNudge({ dy: 40, ms: 400, speed: NUDGE_MAX_SPEED + 0.1 }),
    false,
    'a touch that is fast as it lifts is a fling',
  );
  assert.equal(isNudge({ dx: 30, dy: 20, ms: 300, speed: 0.1 }), false, 'a touch that is more sideways is a swipe');
  assert.equal(
    isNudge({ dy: 40, ms: 50 }),
    false,
    'with no speed given, the average speed is used, and here it is fast',
  );
  assert.equal(
    isNudge({ dy: 40, ms: 400 }),
    true,
    'with no speed given, the average speed is used, and here it is slow',
  );
});

test('the release speed is measured over the last moves of the touch, not the whole touch', () => {
  const slow = [0, 40, 80, 120, 160, 200].map((t, i) => ({ t, y: 400 - i * 5 }));
  assert.equal(
    releaseSpeed(slow, 240, 370),
    10 / 80,
    `the speed starts from the first move in the last ${NUDGE_SPEED_MS}ms`,
  );
  // The drag is slow and ends with a flick. Only the end of the drag counts.
  const flick = [
    { t: 0, y: 400 },
    { t: 500, y: 390 },
    { t: 600, y: 388 },
    { t: 620, y: 370 },
  ];
  assert.ok(releaseSpeed(flick, 640, 340) > NUDGE_MAX_SPEED);
  assert.equal(
    releaseSpeed([{ t: 0, y: 400 }], 50, 380),
    20 / 50,
    'a touch shorter than that measures from where it went down',
  );
  assert.equal(
    releaseSpeed(
      [
        { t: 0, y: 400 },
        { t: 300, y: 380 },
      ],
      900,
      380,
    ),
    0,
    'holding still before lifting gives no speed',
  );
  assert.equal(
    releaseSpeed(
      [
        { t: 0, y: 400 },
        { t: 70, y: 425 },
        { t: 190, y: 450 },
      ],
      200,
      450,
    ),
    25 / 130,
    'when only the last move is recent, the speed is measured from the move before it',
  );
  assert.equal(releaseSpeed([], 10, 10), 0);
});
