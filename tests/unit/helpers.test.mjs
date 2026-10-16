// Small helpers used all over Pocket. They are reading the screen from the URL (routing.js), util.js, and the queue of
// changes waiting to be sent (sync.js).
import './browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeOf } from '../../src/js/routing.js';
import { andList, colorOf, esc, fmtSize, grow, motion, sizeLimit, taskDrafts } from '../../src/js/util.js';
import { heldTasks, itemsOf, packParsed, sendState, slowness, unpackParsed, uuid7, waits, WAIT_MS } from '../../src/js/sync.js';
import { addLines } from '../../src/js/ops/index.js';

test('the address names the screen to show', () => {
  assert.deepEqual(routeOf(''), { name: 'today' });
  assert.deepEqual(routeOf('#/project/12?done=1'), { name: 'project', id: 12, showDone: true });
  assert.deepEqual(routeOf('#/run/7?step=9'), { name: 'run', id: 7, step: 9 });
  assert.deepEqual(routeOf('#/run/7'), { name: 'run', id: 7, step: null });
  assert.deepEqual(routeOf('#/add?title=Milk'), { name: 'add', text: 'Milk' });
  assert.deepEqual(routeOf('#/nowhere'), { name: 'today' });
});

// Only motion() decides whether animations may run, and it checks the phone's setting on every call, because the
// setting can change while Pocket is open. npm run lint stops any other file from checking it.
test('animations run unless the phone asks for less motion, and the setting is checked on every call', () => {
  const was = globalThis.matchMedia, asked = [];
  let less = false;
  globalThis.matchMedia = q => { asked.push(q); return { matches: less }; };
  try {
    assert.equal(motion(), true);
    less = true;
    assert.equal(motion(), false, 'turning the setting on meanwhile changes the result');
    assert.deepEqual(asked, ['(prefers-reduced-motion: reduce)', '(prefers-reduced-motion: reduce)']);
  } finally { globalThis.matchMedia = was; }
});

test('a list of names is joined into a sentence with commas and "and"', () => {
  assert.equal(andList([]), '');
  assert.equal(andList(['you']), 'you');
  assert.equal(andList(['you', 'Jo']), 'you and Jo');
  assert.equal(andList(['you', 'Jo', 'Priya']), 'you, Jo and Priya');
});

test('Vikunja\'s upload limit and a file\'s size are read and written as text', () => {
  assert.equal(sizeLimit('20MB'), 20 * 1048576);
  assert.equal(sizeLimit('512 kb'), 512 * 1024);
  assert.equal(sizeLimit('1.5G'), 1.5 * 1073741824);
  assert.equal(sizeLimit('lots'), null);
  assert.equal(fmtSize(0), '');
  assert.equal(fmtSize(900), '900 B');
  assert.equal(fmtSize(2048), '2 KB');
  assert.equal(fmtSize(3 * 1048576), '3.0 MB');
});

test('a label colour is used only if it is a valid colour, and text is escaped for HTML', () => {
  assert.equal(colorOf('e8445a'), '#e8445a');
  assert.equal(colorOf('#abc'), '#abc');
  assert.equal(colorOf('red;background:url(x)'), 'var(--muted)');
  assert.equal(colorOf(''), 'var(--muted)');
  assert.equal(esc(`<a href="x">Tom's</a>`), '&lt;a href=&quot;x&quot;&gt;Tom&#39;s&lt;/a&gt;');
  assert.equal(esc(null), '');
});

/* A fake text box that reports sizes the way a browser measures them. Its text is `text` px tall, its borders add
   `border` px in total, and its smallest height is `least`. It sits in a sheet scrolled to `top`. A sheet can't stay
   scrolled past its end, so when the box is at its smallest height the sheet's scroll position is capped at `end`. */
function textBox({ text, border = 0, least = 24, top = 0, end = Infinity }){
  const sheet = { scrollTop: top }, ta = { get scrollHeight(){ return text; }, get clientHeight(){ return this.offsetHeight - border; }, closest: sel => sel === '#sheet .scroll' ? sheet : null };
  let height = 'auto';
  ta.style = { get height(){ return height; }, set height(v){ height = v; if (v === 'auto') sheet.scrollTop = Math.min(sheet.scrollTop, end); } };
  Object.defineProperty(ta, 'offsetHeight', { get: () => height === 'auto' ? least : parseFloat(height) });
  return { ta, sheet };
}
test('a text box is as tall as its text and its borders, and the sheet around it stays scrolled where it was', () => {
  const plain = textBox({ text: 72 });
  grow(plain.ta);
  assert.equal(plain.ta.style.height, '72px', 'a box with no border is as tall as its text');
  const notes = textBox({ text: 2978, border: 3, least: 140, top: 2075, end: 440 });
  grow(notes.ta);
  assert.equal(notes.ta.style.height, '2981px', 'the height includes the borders, so nothing is left to scroll inside the box');
  assert.equal(notes.sheet.scrollTop, 2075, 'measuring at the least height shortened the sheet, so its scroll position is restored');
  const hidden = textBox({ text: 0 });
  grow(hidden.ta);
  assert.equal(hidden.ta.style.height, 'auto', 'a hidden box measures 0, so its height is left alone until it can be measured');
  const alone = { style: {}, scrollHeight: 40, offsetHeight: 24, clientHeight: 24, closest: () => null };
  grow(alone);
  assert.equal(alone.style.height, '40px', 'a box outside a sheet, such as the add box or a checklist\'s comment box, is as tall as its text');
});

test('a draft is kept until it is empty', () => {
  taskDrafts.clear();
  taskDrafts.set('comment:1', 'Half a thought');
  taskDrafts.set('run', { 5: 'a note' });
  assert.equal(taskDrafts.get('comment:1'), 'Half a thought');
  taskDrafts.set('comment:1', '   ');
  taskDrafts.set('run', { 5: '' });
  assert.deepEqual(taskDrafts.all(), {});
});

/* The lines typed together become one add op each. The lines are "## A" (+Garden), "a1", "  a2" (done), "## B" and
   "b1" (50%). That makes two parents and a subtask of a subtask. */
test('each typed line is an add op that names the line it goes under, its project, and the parents whose progress it writes', () => {
  const p = (title, more = {}) => ({ title, project: null, done: false, pct: 0, ...more });
  const items = [{ raw: 'A', p: p('A', { project: { id: 6 } }), under: null }, { raw: 'a1', p: p('a1'), under: 0 }, { raw: 'a2', p: p('a2', { done: true }), under: 1 },
    { raw: 'B', p: p('B'), under: null }, { raw: 'b1', p: p('b1', { pct: 50 }), under: 3 }];
  const ops = addLines(items, { pid: 5 }), id = ops.map(o => 'pending-' + o.id);
  assert.ok(ops.every(o => o.op === 'add' && o.batch === ops[0].id), 'they share a batch');
  assert.deepEqual(ops.map(o => [o.under, o.over, o.pid]), [[null, null, 5], [id[0], 'A', 6], [id[1], 'a1', 6], [null, null, 5], [id[3], 'B', 5]],
    'a line goes to the project of the line it is under');
  assert.deepEqual(ops.map(o => o.ups), [[], [], [id[1], id[0]], [], [id[3]]], 'the last line under a parent writes its progress, deepest first');
  // In a subtask box, every line goes to the parent's project, and the last line writes the parent's progress.
  const parent = { id: 9, project_id: 7, title: 'Pack the van' }, subs = addLines([{ raw: 'x', p: p('x'), under: null }, { raw: 'y', p: p('y'), under: 0 }], { parent });
  assert.deepEqual(subs.map(o => [o.under, o.over, o.pid, o.ups]), [[9, 'Pack the van', 7, []], ['pending-' + subs[0].id, 'x', 7, [9]]]);
});

test('a box\'s lines become an entry\'s items, a line with no title left is dropped, and lines under it move up a level', () => {
  const p = title => ({ title, due: null, priority: 0, repeat: null, labels: [], assignees: [], project: null });
  const items = itemsOf([{ raw: 'A', p: p('A'), under: null }, { raw: 'tomorrow', p: p(''), under: 0 }, { raw: 'a1', p: p('a1'), under: 1 }, { raw: 'B', p: p('B'), under: null }, { raw: 'b1', p: p('b1'), under: 3 }],
    (k, under) => under !== null && { position: k * 10 });
  assert.deepEqual(items.map(x => [x.raw, x.under, x.p.position]), [['A', null, undefined], ['a1', 0, 10], ['B', null, undefined], ['b1', 2, 30]]);
  // A parent with no title is dropped, and its lines become separate tasks.
  assert.deepEqual(itemsOf([{ raw: 'tomorrow', p: p(''), under: null }, { raw: 'a', p: p('a'), under: 0 }]).map(x => [x.raw, x.under]), [['a', null]]);
});

test('a step whose change Vikunja rejected holds back the later changes to that step', () => {
  const held = heldTasks([{ kind: 'act', task: 5, failed: true }, { kind: 'act', task: 6 }, { kind: 'capture', task: 7, failed: true }]);
  assert.deepEqual([...held], [5]);
});

test('a line that failed holds back the lines under it, and their lines in turn, and the changes to its task', () => {
  const stopped = heldTasks([{ kind: 'act', op: 'add', id: 'a', taskId: 4, failed: true }]);
  assert.deepEqual([...stopped], ['pending-a', 4]);
  const line = (id, under) => ({ kind: 'act', op: 'add', id, under });
  assert.deepEqual([waits(line('b', 'pending-a'), stopped), waits(line('c', 'pending-b'), stopped), waits(line('d', 9), stopped)], [true, true, false]);
  assert.deepEqual([waits({ kind: 'act', op: 'done', task: 4 }, stopped), waits({ kind: 'act', op: 'done', task: 5 }, stopped)], [true, false]);
});

test('the send state is "sending" while sending, even with changes waiting, and an outbox not read yet is not idle', () => {
  assert.equal(sendState({ busy: false, unsent: 0 }), 'idle');
  assert.equal(sendState({ busy: true, unsent: 0 }), 'sending');
  assert.equal(sendState({ busy: true, unsent: 2 }), 'sending');
  assert.equal(sendState({ busy: false, unsent: 1 }), 'waiting');
  assert.equal(sendState({ busy: false, unsent: null }), 'waiting');
});

test('a parsed line saved on the phone keeps its date', () => {
  const p = { title: 'Call Jo', due: new Date('2026-10-08T09:00:00Z'), priority: 2, repeat: null, labels: ['work'], assignees: [], project: null };
  const back = unpackParsed(JSON.parse(JSON.stringify(packParsed(p))));
  assert.equal(+back.due, +p.due);
  assert.equal(back.title, 'Call Jo');
  assert.equal(back.priority, 2);
});

test('a change is shown as waiting only after it has waited a while, or at once when there is no connection', () => {
  const now = Date.parse('2026-10-07T10:00:00Z'), at = ms => new Date(now - ms).toISOString();
  const entries = [{ id: 'old', at: at(WAIT_MS) }, { id: 'new', at: at(500) }, { id: 'newer', at: at(100) }];
  assert.deepEqual(slowness(entries, now, false), { slow: ['old'], next: now - 500 + WAIT_MS }, 'the next change to be shown as waiting is the oldest of the rest');
  assert.deepEqual(slowness(entries, now, true), { slow: ['old', 'new', 'newer'], next: null }, 'offline, every change is shown as waiting at once');
  assert.deepEqual(slowness([], now, false), { slow: [], next: null });
  assert.ok(WAIT_MS >= 2000 && WAIT_MS <= 3000, 'a few seconds');
});

// The relay reads a key's age from the UUIDv7 it starts with, so the time must be right and the version and variant set.
test('a UUIDv7 holds the time it was made, version 7 and variant 10, and two made together differ', () => {
  const id = uuid7(), hex = id.replaceAll('-', '');
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(Math.abs(parseInt(hex.slice(0, 12), 16) - Date.now()) < 1000, 'its first 48 bits are now, in milliseconds');
  assert.notEqual(uuid7(), uuid7());
});
