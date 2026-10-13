// Small helpers used all over Pocket. They are reading the screen from the URL (routing.js), util.js, and the queue of
// changes waiting to be sent (sync.js).
import './browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeOf } from '../../src/js/routing.js';
import { andList, colorOf, esc, fmtSize, grow, motion, sizeLimit, taskDrafts } from '../../src/js/util.js';
import { entryDone, heldTasks, isChild, itemDone, itemsOf, packParsed, sendState, slowness, underOf, unpackParsed, WAIT_MS } from '../../src/js/sync.js';

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

test('a waiting line is done once its task is created, and a subtask is done once it is also linked to its parent', () => {
  assert.equal(itemDone({ taskId: 4 }, false), true);
  assert.equal(itemDone({ taskId: 4 }, true), false);
  assert.equal(itemDone({ taskId: 4, linked: true }, true), true);
  assert.equal(itemDone({ done: false, taskId: 4 }, false), false, 'the line\'s own done flag takes priority');
  // In a pasted list marked `nest`, every line after the first is a subtask of the first line.
  const entry = { nest: true, items: [{ taskId: 1 }, { taskId: 2, linked: true }], files: [{ sent: true }] };
  assert.deepEqual([isChild(entry, 0), isChild(entry, 1)], [false, true]);
  assert.equal(entryDone(entry), true);
  assert.equal(entryDone({ ...entry, files: [{ sent: false }] }), false, 'an entry with a file still to send is not done');
  assert.equal(isChild({ parent: { id: 3 }, items: [] }, 0), true, 'a line added from a task\'s sheet is a subtask');
});

test('each waiting line records which line it is under, and an older saved entry puts its first line over the rest', () => {
  // The lines are "## A", "a1", "  a2", "## B", "b1". That makes two parents and a subtask of a subtask.
  const list = { nest: false, items: [{ under: null }, { under: 0 }, { under: 1 }, { under: null }, { under: 3 }] };
  assert.deepEqual(list.items.map((x, i) => underOf(list, i)), [null, 0, 1, null, 3]);
  assert.deepEqual(list.items.map((x, i) => isChild(list, i)), [false, true, true, false, true]);
  // An older version of Pocket saved entries with `nest` and no `under`.
  const old = { nest: true, items: [{}, {}, {}] }, flat = { nest: false, items: [{}, {}] };
  assert.deepEqual(old.items.map((x, i) => underOf(old, i)), [null, 0, 0]);
  assert.deepEqual(flat.items.map((x, i) => underOf(flat, i)), [null, null]);
  // In an entry from a subtask box, a line that is not under another line becomes a subtask of the entry's task.
  const sub = { parent: { id: 3 }, items: [{ under: null }, { under: 0 }] };
  assert.deepEqual(sub.items.map((x, i) => [underOf(sub, i), isChild(sub, i)]), [[null, true], [0, true]]);
  assert.equal(entryDone({ ...list, items: list.items.map((x, i) => ({ ...x, taskId: i + 1, linked: x.under !== null })) }), true, 'a line under another line is done once it is linked');
});

test('a box\'s lines become an entry\'s items, a line with no title left is dropped, and lines under it move up a level', () => {
  const p = title => ({ title, due: null, priority: 0, repeat: null, labels: [], assignees: [], project: null });
  const items = itemsOf([{ raw: 'A', p: p('A'), under: null }, { raw: 'tomorrow', p: p(''), under: 0 }, { raw: 'a1', p: p('a1'), under: 1 }, { raw: 'B', p: p('B'), under: null }, { raw: 'b1', p: p('b1'), under: 3 }],
    (k, under) => under !== null && { position: k * 10 });
  assert.deepEqual(items.map(x => [x.raw, x.under, x.p.position]), [['A', null, undefined], ['a1', 0, 10], ['B', null, undefined], ['b1', 2, 30]]);
  assert.deepEqual(items.map(x => [x.taskId, x.done, x.linked]), Array(4).fill([null, false, false]));
  // A parent with no title is dropped, and its lines become separate tasks.
  assert.deepEqual(itemsOf([{ raw: 'tomorrow', p: p(''), under: null }, { raw: 'a', p: p('a'), under: 0 }]).map(x => [x.raw, x.under]), [['a', null]]);
});

test('a step whose change Vikunja rejected holds back the later changes to that step', () => {
  const held = heldTasks([{ kind: 'act', task: 5, failed: true }, { kind: 'act', task: 6 }, { kind: 'capture', task: 7, failed: true }]);
  assert.deepEqual([...held], [5]);
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
