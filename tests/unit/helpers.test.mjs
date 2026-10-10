// The small helpers used all over Pocket: the address (routing.js), util.js, and what's waiting to send (sync.js).
import './browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeOf } from '../../src/js/routing.js';
import { andList, colorOf, esc, fmtSize, grow, motion, sizeLimit, taskDrafts } from '../../src/js/util.js';
import { entryDone, heldTasks, isChild, itemDone, packParsed, sendState, slowness, unpackParsed, WAIT_MS } from '../../src/js/sync.js';

test('the screen in the address', () => {
  assert.deepEqual(routeOf(''), { name: 'today' });
  assert.deepEqual(routeOf('#/project/12?done=1'), { name: 'project', id: 12, showDone: true });
  assert.deepEqual(routeOf('#/run/7?step=9'), { name: 'run', id: 7, step: 9 });
  assert.deepEqual(routeOf('#/run/7'), { name: 'run', id: 7, step: null });
  assert.deepEqual(routeOf('#/add?title=Milk'), { name: 'add', text: 'Milk' });
  assert.deepEqual(routeOf('#/nowhere'), { name: 'today' });
});

// Whether things may move is asked in one place (rows-and-sheet-fixes-plan, part 2), each time, as the phone's setting
// can change while Pocket is open; npm run lint keeps the question out of every other file.
test('things move unless the phone asks for less motion, asked each time', () => {
  const was = globalThis.matchMedia, asked = [];
  let less = false;
  globalThis.matchMedia = q => { asked.push(q); return { matches: less }; };
  try {
    assert.equal(motion(), true);
    less = true;
    assert.equal(motion(), false, 'turned on meanwhile: it only changes');
    assert.deepEqual(asked, ['(prefers-reduced-motion: reduce)', '(prefers-reduced-motion: reduce)']);
  } finally { globalThis.matchMedia = was; }
});

test('words in a list as a sentence has them', () => {
  assert.equal(andList([]), '');
  assert.equal(andList(['you']), 'you');
  assert.equal(andList(['you', 'Jo']), 'you and Jo');
  assert.equal(andList(['you', 'Jo', 'Priya']), 'you, Jo and Priya');
});

test('Vikunja\'s upload limit, and a file\'s size', () => {
  assert.equal(sizeLimit('20MB'), 20 * 1048576);
  assert.equal(sizeLimit('512 kb'), 512 * 1024);
  assert.equal(sizeLimit('1.5G'), 1.5 * 1073741824);
  assert.equal(sizeLimit('lots'), null);
  assert.equal(fmtSize(0), '');
  assert.equal(fmtSize(900), '900 B');
  assert.equal(fmtSize(2048), '2 KB');
  assert.equal(fmtSize(3 * 1048576), '3.0 MB');
});

test('a label\'s colour only if it is one, and text made safe for HTML', () => {
  assert.equal(colorOf('e8445a'), '#e8445a');
  assert.equal(colorOf('#abc'), '#abc');
  assert.equal(colorOf('red;background:url(x)'), 'var(--muted)');
  assert.equal(colorOf(''), 'var(--muted)');
  assert.equal(esc(`<a href="x">Tom's</a>`), '&lt;a href=&quot;x&quot;&gt;Tom&#39;s&lt;/a&gt;');
  assert.equal(esc(null), '');
});

/* A text box as a browser measures it: its text `text` px tall, its borders `border` px in all, its least height `least`.
   In a sheet scrolled to `top`, which can't stay scrolled past its end: with the box at its least height, that's `end`. */
function textBox({ text, border = 0, least = 24, top = 0, end = Infinity }){
  const sheet = { scrollTop: top }, ta = { get scrollHeight(){ return text; }, get clientHeight(){ return this.offsetHeight - border; }, closest: sel => sel === '#sheet .scroll' ? sheet : null };
  let height = 'auto';
  ta.style = { get height(){ return height; }, set height(v){ height = v; if (v === 'auto') sheet.scrollTop = Math.min(sheet.scrollTop, end); } };
  Object.defineProperty(ta, 'offsetHeight', { get: () => height === 'auto' ? least : parseFloat(height) });
  return { ta, sheet };
}
test('a text box is as tall as its text and its borders, and the sheet it\'s in stays where it was scrolled to', () => {
  const plain = textBox({ text: 72 });
  grow(plain.ta);
  assert.equal(plain.ta.style.height, '72px', 'a box with no border: its text\'s height');
  const notes = textBox({ text: 2978, border: 3, least: 140, top: 2075, end: 440 });
  grow(notes.ta);
  assert.equal(notes.ta.style.height, '2981px', 'its borders too, so nothing is left to scroll inside it');
  assert.equal(notes.sheet.scrollTop, 2075, 'measured at its least height, the sheet\'s end came up: it\'s put back');
  const hidden = textBox({ text: 0 });
  grow(hidden.ta);
  assert.equal(hidden.ta.style.height, 'auto', 'a hidden box measures 0: left until it can be measured');
  const alone = { style: {}, scrollHeight: 40, offsetHeight: 24, clientHeight: 24, closest: () => null };
  grow(alone);
  assert.equal(alone.style.height, '40px', 'a box outside a sheet (the add box, a run\'s comment)');
});

test('drafts are kept until they\'re empty', () => {
  taskDrafts.clear();
  taskDrafts.set('comment:1', 'Half a thought');
  taskDrafts.set('run', { 5: 'a note' });
  assert.equal(taskDrafts.get('comment:1'), 'Half a thought');
  taskDrafts.set('comment:1', '   ');
  taskDrafts.set('run', { 5: '' });
  assert.deepEqual(taskDrafts.all(), {});
});

test('what\'s waiting: a line is done once its task is made, and a subtask once it\'s linked too', () => {
  assert.equal(itemDone({ taskId: 4 }, false), true);
  assert.equal(itemDone({ taskId: 4 }, true), false);
  assert.equal(itemDone({ taskId: 4, linked: true }, true), true);
  assert.equal(itemDone({ done: false, taskId: 4 }, false), false, 'what it says of itself wins');
  // A pasted list "nested" under its first line: the lines after it are subtasks.
  const entry = { nest: true, items: [{ taskId: 1 }, { taskId: 2, linked: true }], files: [{ sent: true }] };
  assert.deepEqual([isChild(entry, 0), isChild(entry, 1)], [false, true]);
  assert.equal(entryDone(entry), true);
  assert.equal(entryDone({ ...entry, files: [{ sent: false }] }), false, 'a file still to go');
  assert.equal(isChild({ parent: { id: 3 }, items: [] }, 0), true, 'added from a task\'s sheet');
});

test('a step whose act Vikunja turned down holds the acts behind it', () => {
  const held = heldTasks([{ kind: 'act', task: 5, failed: true }, { kind: 'act', task: 6 }, { kind: 'capture', task: 7, failed: true }]);
  assert.deepEqual([...held], [5]);
});

test('where sending stands: sending beats waiting, and an outbox not read yet isn\'t idle', () => {
  assert.equal(sendState({ busy: false, unsent: 0 }), 'idle');
  assert.equal(sendState({ busy: true, unsent: 0 }), 'sending');
  assert.equal(sendState({ busy: true, unsent: 2 }), 'sending');
  assert.equal(sendState({ busy: false, unsent: 1 }), 'waiting');
  assert.equal(sendState({ busy: false, unsent: null }), 'waiting');
});

test('a parsed line kept on the phone keeps its date', () => {
  const p = { title: 'Call Jo', due: new Date('2026-10-08T09:00:00Z'), priority: 2, repeat: null, labels: ['work'], assignees: [], project: null };
  const back = unpackParsed(JSON.parse(JSON.stringify(packParsed(p))));
  assert.equal(+back.due, +p.due);
  assert.equal(back.title, 'Call Jo');
  assert.equal(back.priority, 2);
});

test('a change looks waiting only once it has waited a while, or at once without a connection', () => {
  const now = Date.parse('2026-10-07T10:00:00Z'), at = ms => new Date(now - ms).toISOString();
  const entries = [{ id: 'old', at: at(WAIT_MS) }, { id: 'new', at: at(500) }, { id: 'newer', at: at(100) }];
  assert.deepEqual(slowness(entries, now, false), { slow: ['old'], next: now - 500 + WAIT_MS }, 'the next to look waiting: the oldest of the rest');
  assert.deepEqual(slowness(entries, now, true), { slow: ['old', 'new', 'newer'], next: null }, 'offline: all at once');
  assert.deepEqual(slowness([], now, false), { slow: [], next: null });
  assert.ok(WAIT_MS >= 2000 && WAIT_MS <= 3000, 'a few seconds');
});
