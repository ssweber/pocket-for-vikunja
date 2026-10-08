// When rows marked done or deleted leave together (src/js/batch.js): 3 seconds after the last mark, counted from when
// the finger lifts, never while a finger is down or the list scrolls, and at once when the screen is left.
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
  b.mark();                                                     // a second row: the wait starts again
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
  b.mark();                                                     // marked with the finger still down
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
  b.up(2);                                                      // a lift seen twice changes nothing
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
  b.mark();                                                     // a finger left down when the screen was left doesn't hold the next
  t.mock.timers.tick(3000);
  assert.equal(went.length, 1);
});

// The rows marked (src/js/app/leaving.js), on a pretend component: what each tap does, and what's done when it clears.
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
  // Leaving the screen: whatever's marked goes at once.
  app.markRow(1, { kind: 'deleted', gone: () => did.push('sent 1') });
  app.clearNow();
  assert.deepEqual(did.at(-1), 'sent 1');
  assert.deepEqual(app.leaving, {});
});
