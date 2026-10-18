// Tests for the edit op (src/js/ops/edit.js), against a fake Vikunja behind the plugin's relay: a title or a priority
// set as it is, notes, reminders and a template's step order made on Vikunja's copy, a later edit that replaces one
// not sent, its Undo, and its words.
import './browser.mjs';
import { sender, reached, noConnection, lastSaid } from './ops-helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPS } from '../../src/js/ops/index.js';
import { started, TASK } from '../../src/js/app/tasks.js';
import { sync, uuid7 } from '../../src/js/sync.js';

// A sender whose tasks have rows and copies.
const listed = (t, list) => {
  const s = sender(t, list);
  s.app.change(w =>
    w.read(
      list.map(x => structuredClone(x)),
      TASK,
      started(),
    ),
  );
  for (const x of list) s.app.row(structuredClone(x));
  t.after(async () => {
    for (const x of sync.all(1)) await sync.remove(x.id);
  });
  return s;
};
const edit = (task, more) => ({ id: uuid7(), op: 'edit', task, run: null, ...more });
const sent = v => reached(v, 'PATCH', /^\/tasks\/\d+$/).map(r => r.body);
const AT = { relative_to: 'due_date', relative_period: 0 },
  HOUR = { relative_to: 'due_date', relative_period: -3600 },
  DAY = { relative_to: 'due_date', relative_period: -86400 };

test('a title shows at once and is sent as it is, and a task deleted in Vikunja since drops the edit', async t => {
  const { v, app } = listed(t, [
    { id: 7, title: 'Wipe the till', description: '' },
    { id: 8, title: 'Count the float', description: '' },
  ]);
  const sending = app.act(
    edit(7, { set: { title: 'Wipe the till and the counter' }, was: { title: 'Wipe the till' } }),
  );
  assert.equal(app.tasks[7].title, 'Wipe the till and the counter', 'the row shows it before Vikunja answers');
  assert.equal((await sending).status, 'sent');
  assert.deepEqual(sent(v), [{ title: 'Wipe the till and the counter' }]);
  v.tasks.delete(8);
  const r = await app.act(edit(8, { set: { priority: 3 }, was: { priority: 0 } }));
  assert.deepEqual([r.status, sync.all(1).length], ['error', 0], 'nothing is kept to try again');
  assert.equal(lastSaid(app).msg, "Priority on “Count the float” couldn't be saved: The task does not exist.");
});

test("notes are written over the notes Vikunja has when they are sent, keeping Pocket's lines", async t => {
  const { v, app } = listed(t, [{ id: 7, title: 'Opening', description: '<p>Use the blue cloth</p>' }]);
  // Vikunja's copy gains an order line after the sheet showed the notes.
  v.task(7).description = '<p>Use the blue cloth</p><p>pocket:order 9 8</p>';
  await app.act(
    edit(7, { rebase: 'notes', text: 'Use the green cloth\n\nRinse it after', base: 'Use the blue cloth' }),
  );
  assert.equal(v.task(7).description, '<p>Use the green cloth</p><p>Rinse it after</p><p>pocket:order 9 8</p>');
  assert.equal(app.tasks[7].description, v.task(7).description, "the row shows Vikunja's answer");
});

test('notes changed in Vikunja while the user wrote go back to the sheet instead of overwriting them', async t => {
  const { v, app } = listed(t, [{ id: 7, title: 'Opening', description: '<p>Use the blue cloth</p>' }]);
  const back = [];
  app.notesRefused = (a, e) => back.push([a.text, a.base, e.notes]);
  v.task(7).description = '<p>Use the red cloth</p>';
  const r = await app.act(edit(7, { rebase: 'notes', text: 'Use the green cloth', base: 'Use the blue cloth' }));
  assert.deepEqual(
    [r.status, sent(v), sync.all(1).length],
    ['error', [], 0],
    'nothing is sent, and the edit leaves the outbox',
  );
  assert.deepEqual(back, [['Use the green cloth', 'Use the blue cloth', 'Use the red cloth']]);
  assert.equal(app.tasks[7].description, '<p>Use the red cloth</p>', "the row shows Vikunja's notes");
  // Saved again from Vikunja's notes, the user's replace them.
  await app.act(edit(7, { rebase: 'notes', text: 'Use the green cloth', base: 'Use the red cloth' }));
  assert.equal(v.task(7).description, '<p>Use the green cloth</p>');
});

test('a reminder is added or removed on the list Vikunja has, so one changed elsewhere stays', async t => {
  const { v, app } = listed(t, [
    { id: 7, title: 'Call the plumber', due_date: '2026-10-20T09:00:00Z', reminders: [AT] },
  ]);
  v.task(7).reminders = [AT, DAY]; // added in the web app after the sheet opened
  await app.act(edit(7, { rebase: 'reminders', add: [HOUR], drop: [AT] }));
  assert.deepEqual(sent(v), [{ reminders: [DAY, HOUR] }]);
});

test("a step moves within the order Vikunja has, and a move that would give the template a problem isn't sent", async t => {
  const steps = [
    { id: 2, title: 'Check the guards {#check-the-guards}' },
    { id: 3, title: 'Warm up the press T#30m' },
    { id: 4, title: 'First article check T#2h:check-the-guards' },
  ];
  const tpl = { id: 1, title: 'TEMPLATE: Press', description: '', related_tasks: { subtask: steps } };
  const { v, app } = listed(t, [tpl, ...steps.map(s => ({ ...s, description: '' }))]);
  // Vikunja's order has step 3 last, as a move in the web app since the sheet opened left it.
  v.task(1).description = '<p>pocket:order 2 4 3</p>';
  await app.act(
    edit(1, { rebase: 'order', moves: [{ step: 3, dir: -1, after: null, to: 0, dragged: false, from: 2, at: 1 }] }),
  );
  assert.deepEqual(sent(v), [{ description: '<p>pocket:order 2 3 4</p>' }], 'step 3 moves up one, past step 4');
  // Step 4's time counts from step 2, so step 4 can't be dragged to the top.
  const r = await app.act(
    edit(1, { rebase: 'order', moves: [{ step: 4, dir: -2, after: null, to: 0, dragged: true, from: 3, at: 2 }] }),
  );
  assert.deepEqual([r.status, sent(v).length, sync.all(1).length], ['error', 1, 0]);
  assert.match(lastSaid(app).msg, /^Not moved: step 3, “First article check”: its time counts from “check-the-guards”/);
});

test('a later edit of the same field replaces one not sent, keeping where the first began', async t => {
  const { v, app } = listed(t, [
    { id: 7, title: 'Wipe the till', priority: 0, due_date: '2026-10-20T09:00:00Z', reminders: [AT] },
  ]);
  noConnection(app, v);
  await app.act(edit(7, { set: { title: 'Wipe the till twice' }, was: { title: 'Wipe the till' } }));
  const second = edit(7, { set: { title: 'Wipe the counter' }, was: { title: 'Wipe the till twice' } });
  await app.act(second);
  await app.act(edit(7, { set: { priority: 2 }, was: { priority: 0 } }));
  await app.act(edit(7, { rebase: 'reminders', add: [HOUR], drop: [AT] }));
  await app.act(edit(7, { rebase: 'reminders', add: [DAY], drop: [HOUR] }));
  assert.deepEqual(
    sync.all(1).map(e => [e.set, e.was, e.add, e.drop]),
    [
      [{ title: 'Wipe the counter' }, { title: 'Wipe the till' }, undefined, undefined],
      [{ priority: 2 }, { priority: 0 }, undefined, undefined],
      [undefined, undefined, [DAY], [AT, HOUR]],
    ],
    'a title and a priority stay apart, and two changes to the reminders add up',
  );
  assert.equal(app.tasks[7].title, 'Wipe the counter');
  v.trouble = () => null;
  await app.flush();
  assert.deepEqual(sent(v), [{ title: 'Wipe the counter' }, { priority: 2 }, { reminders: [DAY] }]);
  await app.undoOps([second]).left;
  assert.equal(v.task(7).title, 'Wipe the till', "the second's Undo goes back to the title before the first");
  assert.deepEqual(
    OPS.edit.merge(
      edit(1, { rebase: 'order', moves: [{ step: 3 }] }),
      edit(1, { rebase: 'order', moves: [{ step: 2 }] }),
    ).moves,
    [{ step: 3 }, { step: 2 }],
    'two moves of steps are both made, in order',
  );
});

test('an Undo leaves a field a teammate changed since, and says so on the row', async t => {
  const { v, app } = listed(t, [{ id: 7, title: 'Wipe the till', priority: 0, description: '<p>Blue cloth</p>' }]);
  const title = edit(7, { set: { title: 'Wipe the counter' }, was: { title: 'Wipe the till' } }),
    notes = edit(7, { rebase: 'notes', text: 'Green cloth', base: 'Blue cloth' });
  await app.act(title);
  await app.act(notes);
  v.task(7).title = 'Wipe the counter and the till';
  assert.equal(await app.undoOps([title], false).left, 1);
  assert.deepEqual(
    [v.task(7).title, app.tasks[7].title, lastSaid(app).msg, lastSaid(app).row.id],
    [
      'Wipe the counter and the till',
      'Wipe the counter and the till',
      'Not undone: “Wipe the counter” has changed since then',
      7,
    ],
  );
  v.task(7).description = '<p>Red cloth</p>';
  assert.equal(await app.undoOps([notes], false).left, 1, 'notes changed since stay too');
  assert.equal(v.task(7).description, '<p>Red cloth</p>');
  v.task(7).description = '<p>Green cloth</p>';
  assert.equal(await app.undoOps([notes]).left, 0);
  assert.equal(v.task(7).description, '<p>Blue cloth</p>', 'and notes that are still the edit’s go back');
});

test('an edit names the field it changes in the Outbox, when Vikunja refuses it, and when it is cancelled', () => {
  const words = a => [OPS.edit.text(a, 'Wipe the till'), OPS.edit.refused(a, 'Wipe the till'), OPS.edit.dropped(a, '')];
  assert.deepEqual(
    [
      words({ set: { title: 'Wipe the counter' } }),
      words({ set: { priority: 3 } }),
      words({ set: { priority: 0 } })[0],
      words({ rebase: 'notes' }),
      words({ rebase: 'reminders' }),
      words({ rebase: 'order' }),
    ],
    [
      [
        'Renaming “Wipe the till” to “Wipe the counter”',
        'Renaming “Wipe the till”',
        '“it” keeps its title in Vikunja.',
      ],
      [
        'Priority: High on “Wipe the till”',
        'Priority on “Wipe the till”',
        '“it” keeps the priority it has in Vikunja.',
      ],
      'No priority on “Wipe the till”',
      ['Notes on “Wipe the till”', 'Notes on “Wipe the till”', '“it” keeps the notes it has in Vikunja.'],
      ['Reminders on “Wipe the till”', 'Reminders on “Wipe the till”', '“it” keeps the reminders it has in Vikunja.'],
      [
        'Moving a step in “Wipe the till”',
        'Moving a step in “Wipe the till”',
        '“it” keeps its order of steps in Vikunja.',
      ],
    ],
  );
});
