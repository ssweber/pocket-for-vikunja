// When rows marked done or deleted leave the list together (src/js/batch.js). They leave 3 seconds after the last mark,
// counted from when the user stops touching the screen. They never leave while the user is touching the screen or the
// list is scrolling, and they leave at once when the user leaves the screen.
import './browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BATCH_MS, batchTimer } from '../../src/js/batch.js';

const timer = t => { t.mock.timers.enable({ apis: ['setTimeout'] }); const went = []; return { went, b: batchTimer(() => went.push(Date.now())) }; };

test('rows marked go together, 3 seconds after the last mark', t => {
  const { went, b } = timer(t);
  assert.equal(BATCH_MS, 3000);
  b.mark();
  t.mock.timers.tick(2000);
  b.mark();                                                     // marking a second row restarts the wait
  t.mock.timers.tick(2999);
  assert.equal(went.length, 0);
  t.mock.timers.tick(1);
  assert.equal(went.length, 1, 'once, for both');
  assert.equal(b.waiting, false);
  t.mock.timers.tick(10000);
  assert.equal(went.length, 1, 'nothing more to go');
});

test('a finger down holds them, and the wait starts when it lifts', t => {
  const { went, b } = timer(t);
  b.down(1);
  b.mark();                                                     // marked while the touch is still down
  t.mock.timers.tick(10000);
  assert.equal(went.length, 0, 'not while the finger is down');
  b.up(1);
  t.mock.timers.tick(2999);
  assert.equal(went.length, 0, 'counted from the lift');
  t.mock.timers.tick(1);
  assert.equal(went.length, 1);
});

test('a touch after the mark starts the wait again; two fingers, from the last to lift', t => {
  const { went, b } = timer(t);
  b.mark();
  t.mock.timers.tick(2500);
  b.down(1); b.down(2);
  t.mock.timers.tick(5000);
  b.up(1);
  t.mock.timers.tick(5000);
  assert.equal(went.length, 0, 'one finger still down');
  b.up(2);
  b.up(2);                                                      // a second release of the same touch changes nothing
  t.mock.timers.tick(2999);
  assert.equal(went.length, 0);
  t.mock.timers.tick(1);
  assert.equal(went.length, 1);
});

test('scrolling holds them until it stops', t => {
  const { went, b } = timer(t);
  b.mark();
  t.mock.timers.tick(1000);
  b.scroll(true);
  t.mock.timers.tick(8000);
  assert.equal(went.length, 0);
  b.scroll(false);
  t.mock.timers.tick(3000);
  assert.equal(went.length, 1);
});

test('leaving the screen ends the wait (the rows are cleared at once by the caller); every mark undone, nothing goes', t => {
  const { went, b } = timer(t);
  b.mark(); b.down(1);
  b.now();
  assert.equal(b.waiting, false);
  t.mock.timers.tick(10000);
  assert.equal(went.length, 0, 'not again, later');
  b.mark();
  b.stop();
  t.mock.timers.tick(10000);
  assert.equal(went.length, 0);
  b.mark();                                                     // a touch still down when the user left the screen must not hold the next mark
  t.mock.timers.tick(3000);
  assert.equal(went.length, 1);
});

// Marked rows (src/js/app/leaving.js) on a fake component. The test checks what tapping a row does and what runs when
// the batch clears.
test('a row marked: its tap takes the mark back; a subtask closed with its parent only leaves its parent\'s mark', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { component } = await import('./fake.mjs'), leaving = (await import('../../src/js/app/leaving.js')).default;
  const app = component(leaving), did = [];
  app.tasks = { 1: { id: 1, title: 'Load chairs' }, 2: { id: 2, title: 'Pack the van' } };
  app.markRow(1, { kind: 'deleted', undo: () => did.push('restored 1'), gone: () => did.push('sent 1'), said: 'Deleted: Load chairs. Restore is in its place' });
  app.markRow(2, { kind: 'done', ids: [2, 3, 4], undo: () => did.push('opened 2'), gone: () => did.push('gone 2') });
  assert.deepEqual(app.leaving, { 1: 'deleted', 2: 'done', 3: 'done', 4: 'done' });
  assert.ok(app.unmark(1));
  assert.equal(app.said, 'Restored: Load chairs');
  assert.equal(app.unmark(3), false, 'a subtask closed with it: its own tick then opens it');
  assert.deepEqual(app.leaving, { 2: 'done', 4: 'done' });
  assert.equal(app.unmark(9), false, 'not marked');
  assert.deepEqual(did, ['restored 1']);
  await app.clearBatch(true);
  assert.deepEqual(did, ['restored 1', 'gone 2'], 'what each was for, once');
  assert.deepEqual(app.leaving, {});
  // Leaving the screen clears every marked row at once.
  app.markRow(1, { kind: 'deleted', gone: () => did.push('sent 1') });
  app.clearNow();
  assert.deepEqual(did.at(-1), 'sent 1');
  assert.deepEqual(app.leaving, {});
});

/* When the top row of a collapsed card is marked done, it leaves after half the usual wait (clearTops), so the next
   subtask comes up sooner. The same touch and scroll rules apply. Only that row's own mark leaves early. Any other
   row, a parent closed together with its subtasks, and a deleted row wait for the batch. */
test('a collapsed card\'s top row done goes after 1.5 seconds, for the next to come up; every other row waits for the batch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { component } = await import('./fake.mjs'), leaving = (await import('../../src/js/app/leaving.js')).default;
  const { TOP_MS } = await import('../../src/js/batch.js');
  const app = component(leaving), did = [], was = { one: document.querySelector, all: document.querySelectorAll };
  // On the page, task 1 is the top row of a collapsed card and task 2 is a plain row. Task 4 is both a top row and a plain row elsewhere.
  const tops = [1, 4, 5, 6], plain = [2, 4];
  document.querySelector = sel => tops.some(id => sel.includes(`.step-line[data-id="${id}"]`)) ? {} : null;
  document.querySelectorAll = sel => plain.some(id => sel.includes(`[data-id="${id}"]`)) ? [{ offsetHeight: 50, style: {}, animate: () => ({ finished: Promise.resolve(), cancel(){}, effect: { target: { style: {} } } }) }] : [];
  try {
    assert.equal(TOP_MS, 1500);
    for (const id of [1, 2, 4]) app.markRow(id, { kind: 'done', gone: () => did.push('gone ' + id) });
    app.markRow(5, { kind: 'done', ids: [5, 7], gone: () => did.push('gone 5') });      // a parent closed together with its subtask
    app.markRow(6, { kind: 'deleted', gone: () => did.push('sent 6') });
    t.mock.timers.tick(TOP_MS - 1);
    assert.deepEqual(did, [], 'not before');
    t.mock.timers.tick(1);
    assert.deepEqual([did, app.leaving], [['gone 1'], { 2: 'done', 4: 'done', 5: 'done', 7: 'done', 6: 'deleted' }], 'the top row alone');
    // Ticking the row again before the wait ends undoes the mark, and the row does not leave.
    app.markRow(1, { kind: 'done', undo: () => did.push('opened 1'), gone: () => did.push('gone 1 again') });
    t.mock.timers.tick(1000);
    app.unmark(1);
    t.mock.timers.tick(1000);
    assert.deepEqual(did, ['gone 1', 'opened 1']);
    // Leaving the screen clears this row with the rest, at once.
    app.markRow(1, { kind: 'done', gone: () => did.push('gone 1 again') });
    app.clearNow();
    assert.deepEqual(did.slice(2).sort(), ['gone 1 again', 'gone 2', 'gone 4', 'gone 5', 'sent 6'], 'the screen left: all at once');
  } finally { document.querySelector = was.one; if (was.all) document.querySelectorAll = was.all; else delete document.querySelectorAll; }
});

// Rows missing from a freshly loaded list (settle and collapseRows in util.js). A few rows on the screen fold away, and
// all of them are measured before any is changed. More than a few at once, or any row off the screen, just disappear.
const fakeRow = (id, top, log) => ({ isConnected: true, style: {}, dataset: { id: String(id) },
  get offsetHeight(){ log.push('read'); return 50; },
  getBoundingClientRect(){ log.push('read'); return { top, bottom: top + 50, height: 50 }; },
  animate(){ log.push('fold ' + id); return { finished: Promise.resolve() }; } });

test('rows gone after a load: a few on the screen fold, all measured first; many at once, or off the screen, simply go', async () => {
  const { collapseRows, FOLD_FEW } = await import('../../src/js/util.js'), log = [];
  globalThis.innerHeight = 800;
  await collapseRows([fakeRow(1, 100, log), fakeRow(2, 150, log), fakeRow(3, 2000, log), fakeRow(4, -300, log)]);
  assert.deepEqual(log.filter(x => x !== 'read'), ['fold 1', 'fold 2'], 'only those on the screen');
  assert.equal(log.indexOf('fold 1'), 8, 'every row measured before the first folds');
  log.length = 0;
  await collapseRows(Array.from({ length: FOLD_FEW + 1 }, (_, i) => fakeRow(i, i * 50, log)));
  assert.deepEqual(log.filter(x => x !== 'read'), [], 'too many on the screen at once: they simply go');
});

test('rows marked stay where they were through a load: one Vikunja no longer lists, and on Today one it now has under another day', async () => {
  const { component } = await import('./fake.mjs'), views = (await import('../../src/js/app/views.js')).default;
  const app = component(views), task = id => ({ id }), [a, b, c, d] = [1, 2, 3, 4].map(task);
  const ids = groups => groups.map(g => g.tasks.map(t => t.id));
  app.view = { groups: [{ key: 'today', tasks: [a, b, c] }, { key: 'week', tasks: [d] }] };
  app.leaving = { 2: 'done', 3: 'done' };
  // Task b is done, so Vikunja's Today no longer lists it. Task c repeats and is now due next week.
  assert.deepEqual(ids(app.keepMarked([{ key: 'today', tasks: [a] }, { key: 'week', tasks: [d, c] }])), [[1, 2, 3], [4]], 'both where they were');
  // A task that is not marked appears where Vikunja lists it.
  app.leaving = {};
  assert.deepEqual(ids(app.keepMarked([{ key: 'today', tasks: [a] }, { key: 'week', tasks: [d, c] }])), [[1], [4, 3]]);
  // In search and in a project, a ticked task that Vikunja now lists under Done stays where it is. Its mark moves nothing further.
  app.route = { name: 'search' };
  app.view = { groups: [{ key: 'open', tasks: [a, b] }, { key: 'done', tasks: [] }] };
  app.leaving = { 2: 'done' };
  assert.deepEqual(ids(app.keepMarked([{ key: 'open', tasks: [a] }, { key: 'done', tasks: [b] }])), [[1], [2]]);
  assert.deepEqual(ids(app.keepMarked([{ key: 'open', tasks: [a] }, { key: 'done', tasks: [] }])), [[1, 2], []], 'one it doesn\'t list stays, as before');
});

test('a load finds the rows gone from the page in one pass, not one for each', async () => {
  const { component } = await import('./fake.mjs'), views = (await import('../../src/js/app/views.js')).default;
  const app = component(views), log = [], asked = [];
  Object.assign(app, { lines: {}, flash(){} });
  app.view = { loading: false, checklists: [], groups: [{ key: 'open', tasks: [1, 2, 3, 4].map(id => ({ id })) }] };
  const rows = [1, 2, 3, 4].map(id => fakeRow(id, id * 50, log));
  globalThis.document.querySelectorAll = sel => { asked.push(sel); return rows; };
  try { assert.equal(await app.settle([1, 3], 0), true); }
  finally { delete globalThis.document.querySelectorAll; }
  assert.equal(asked.length, 1, 'one query');
  assert.deepEqual(log.filter(x => x !== 'read'), ['fold 2', 'fold 4'], 'the rows gone fold');
});
