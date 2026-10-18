// Tests for starting a checklist and adding a step to one, each an op (src/js/ops/runs.js), against a fake Vikunja
// behind the plugin's relay: a lost reply sent again with its key, Cancel, a start's Undo, and the ops on a new step.
import './browser.mjs';
import { sender, lostOnce, noConnection } from './ops-helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ops from '../../src/js/ops/index.js';
import { sync, uuid7 } from '../../src/js/sync.js';
import { SAMPLES } from './samples.mjs';

const D9 = '2026-10-09T09:00:00.000Z';
// A sample's tasks in a fake Vikunja, and its op's fields with an entry id. The outbox starts and ends empty.
const world = (t, name) => {
  t.after(async () => {
    for (const x of sync.all(1)) await sync.remove(x.id);
  });
  const s = SAMPLES[name],
    { v, app } = sender(t, structuredClone(s.tasks));
  v.labels.push(...(s.labels || []));
  return { v, app, f: { id: uuid7(), ...s.fields(ops) } };
};
// How many copies of task `from` Pocket asked for: the keys of its duplicate requests.
const copies = (v, from) => new Set(v.requests.filter(r => r.path === `/tasks/${from}/duplicate`).map(r => r.key)).size;
const rows = app => {
  app.refreshPending();
  return app.outboxRows.map(r => r.text);
};

test('a start whose reply is lost is sent again with its key, and makes the checklist once', async t => {
  const { v, app, f } = world(t, 'startRun');
  lostOnce(v, 'POST', /^\/tasks\/7\/duplicate$/);
  assert.equal((await app.actAll([f], true)).status, 'offline');
  assert.deepEqual(rows(app), ['Starting “Closing”'], 'the start waits in the Outbox');
  app.offline = false;
  const r = await app.sendActs(f.id);
  assert.deepEqual([r.status, r.ids], ['sent', [101]]);
  assert.deepEqual(
    [
      copies(v, 7),
      v.requests.filter(r => r.path === '/tasks/7/duplicate' && r.replayed).length,
      v.task(7).related_tasks.copiedto.length,
    ],
    [1, 1, 1],
    "Vikunja copies the template once, and the relay answers the copy's request sent again",
  );
  assert.deepEqual([v.task(101).related_tasks.subtask.map(s => s.id), sync.all(1).length], [[102, 103], 0]);
});

test('Cancel of a start cut off as it copied the template finds the copy by its key, and deletes it', async t => {
  const { v, app, f } = world(t, 'startRun');
  lostOnce(v, 'POST', /^\/tasks\/7\/duplicate$/);
  await app.actAll([f], true);
  v.trouble = () => 'offline';
  assert.equal(await app.cancelMade(f.id, true), false);
  assert.deepEqual(rows(app), ['Cancelling the start of “Closing”'], 'what it made is deleted once Pocket is back');
  v.trouble = () => null;
  app.offline = false;
  await app.sendActs(f.id);
  assert.deepEqual(
    [copies(v, 7), v.tasks.has(101), [...v.tasks.keys()], sync.all(1).length],
    [1, false, [7, 8, 9], 0],
    'the copy whose reply was lost is deleted, and nothing more is copied',
  );
});

test('Cancel tapped again before the Outbox shows the first leaves the cancelled start as it is', async t => {
  const { v, app, f } = world(t, 'startRun');
  // Vikunja refuses the copy's name, the start's second stage.
  v.trouble = r => (r.method === 'PATCH' && r.path === '/tasks/101' ? 403 : null);
  await app.actAll([f], true);
  // The copy's delete reaches Vikunja, and its reply is lost.
  v.trouble = r => (r.method === 'DELETE' ? 'lost' : null);
  await app.cancelMade(f.id, true);
  v.trouble = () => null;
  app.offline = false;
  await app.cancelMade(f.id, true);
  const asked = new Map();
  for (const r of v.requests.filter(r => r.key))
    asked.set(r.key, new Set([...(asked.get(r.key) || []), r.method + ' ' + r.path]));
  assert.deepEqual(
    [[...asked.values()].filter(s => s.size > 1).map(s => [...s]), [...v.tasks.keys()], sync.all(1).length],
    [[], [7, 8, 9], 0],
    'the second Cancel sends the delete again with its key, and no key goes with another request',
  );
});

test("a start's Undo deletes the checklist and its steps, and puts back the template's date unless it moved since", async t => {
  const { v, app, f } = world(t, 'startRun');
  await app.actAll([f], true);
  assert.deepEqual([v.tasks.size, v.task(7).due_date !== D9], [6, true], 'the start ticks the template');
  assert.equal(await app.undoOps([f]).left, 0);
  assert.deepEqual([[...v.tasks.keys()], v.task(7).due_date, v.task(7).done], [[7, 8, 9], D9, false]);

  const g = { id: uuid7(), ...SAMPLES.startRun.fields(ops) };
  await app.actAll([g], true);
  v.task(7).due_date = '2026-11-01T09:00:00.000Z'; // a teammate moves the template in the web app
  await app.undoOps([g]).left;
  assert.deepEqual(
    [[...v.tasks.keys()], v.task(7).due_date],
    [[7, 8, 9], '2026-11-01T09:00:00.000Z'],
    "the checklist goes, and the template keeps the teammate's date",
  );
});

test('a step inserted in a checklist, cancelled after its reply was lost, is found by its key and deleted', async t => {
  const { v, app, f } = world(t, 'addStep');
  const made = r => r.method === 'POST' && r.path === '/projects/5/tasks';
  lostOnce(v, 'POST', /^\/projects\/5\/tasks$/);
  assert.equal((await app.act(f)).status, 'offline');
  app.offline = false;
  await app.cancelMade(f.id, true);
  assert.deepEqual(
    v.requests.filter(made).map(r => [r.key, !!r.replayed]),
    [
      [`${f.id}:1:0`, false],
      [`${f.id}:1:0`, true],
    ],
    "the step's request is sent again with its key",
  );
  assert.deepEqual(
    [v.tasks.has(101), v.task(1).description, sync.all(1).length],
    [false, '<p>pocket:order 2 3</p>', 0],
    'the step is deleted, and nothing is left waiting',
  );
});

test('a step inserted in a checklist while Pocket knows it is offline, then cancelled, sends nothing', async t => {
  const { v, app, f } = world(t, 'addStep');
  noConnection(app, v);
  assert.equal((await app.act(f)).status, 'offline');
  await app.cancelMade(f.id);
  assert.equal(app.toasts.at(-1).msg, 'Cancelled.');
  v.trouble = () => null;
  app.offline = false;
  await app.flush();
  assert.deepEqual(
    [v.requests.filter(r => r.method !== 'GET'), sync.all(1).length],
    [[], 0],
    'no request for the step was made, and nothing is left waiting',
  );
});

test('an op on a step whose add is cancelled leaves with it, also when another tab cancelled the add', async t => {
  const { v, app, f } = world(t, 'addStep');
  noConnection(app, v);
  await app.act(f);
  await app.act({ op: 'done', task: 'pending-' + f.id, run: 1 });
  await app.cancelMade(f.id, true);
  assert.equal(sync.all(1).length, 0, 'the tick leaves with the step');

  const g = { id: uuid7(), ...SAMPLES.addStep.fields(ops) };
  await app.act(g);
  const tick = (await app.act({ op: 'done', task: 'pending-' + g.id, run: 1 })).entry;
  await sync.remove(g.id); // as another tab's Cancel removes it
  v.trouble = () => null;
  app.offline = false;
  assert.equal((await app.sendActs(tick)).status, 'gone');
  assert.deepEqual(
    [v.requests.filter(r => r.method !== 'GET'), sync.all(1).length],
    [[], 0],
    'the tick on a step never made leaves the outbox, and sends nothing',
  );
});

test('a step whose add is cancelled after it was made is hidden until Vikunja deletes it', async t => {
  const { v, app, f } = world(t, 'addStep');
  // Vikunja refuses the step's place in the checklist's order, after it made the step.
  v.trouble = r => (r.method === 'PATCH' && r.path === '/tasks/1' ? 403 : null);
  assert.equal((await app.act(f)).status, 'error');
  v.trouble = () => 'offline';
  await app.cancelMade(f.id, true);
  assert.deepEqual([v.tasks.has(101), app.hiddenRows.has(101)], [true, true], 'the step is hidden while Cancel waits');
  v.trouble = () => null;
  app.offline = false;
  await app.sendActs(f.id);
  assert.deepEqual([v.tasks.has(101), app.hiddenRows.has(101), sync.all(1).length], [false, false, 0]);
});
