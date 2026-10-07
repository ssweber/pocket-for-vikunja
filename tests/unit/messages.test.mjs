// What Pocket says (src/js/messages.js), and where (src/js/app/lines.js): its places on each screen and in a sheet.
import './browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addedWhere, movedText, notMoved, notSaved, sentLater } from '../../src/js/messages.js';
import { NetError } from '../../src/js/api.js';
import lines from '../../src/js/app/lines.js';
import { blankSheet } from '../../src/js/app/core.js';

test('a change not saved says why in a few words', () => {
  assert.equal(notSaved(new NetError('Failed to fetch')), 'Not saved: no connection');
  assert.equal(notSaved(new Error('Forbidden')), 'Not saved: Forbidden');
});

test('a move turned down says why, and for an API token without it, the permission it needs', () => {
  assert.equal(notMoved(Object.assign(new Error('Your API token doesn\'t allow this.'), { status: 403, code: 'token' })),
    'Not moved: your API token doesn\'t allow reordering. Make one with Position ticked under Tasks.');
  assert.equal(notMoved(Object.assign(new Error('Forbidden'), { status: 403 })), 'Not moved: Forbidden');
  assert.equal(notMoved(new NetError('Failed to fetch')), 'Not moved: no connection');
});

test('where tasks just added went, said by the add box', () => {
  assert.equal(addedWhere({ n: 1, project: 'Orders' }), 'Added to Orders');
  assert.match(addedWhere({ n: 1, project: 'Orders', due: new Date(Date.now() + 30 * 864e5).toISOString() }), /^Added to Orders, due (\w+ \d+|\d+ \w+)/);
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(0, 0, 0, 0);
  assert.equal(addedWhere({ n: 1, project: 'Orders', due: tomorrow.toISOString() }), 'Added to Orders, due tomorrow', 'a day in words, mid-sentence');
  assert.equal(addedWhere({ n: 3, project: 'Orders' }), 'Added 3 tasks to Orders');
  assert.equal(addedWhere({ n: 3, nest: true, project: 'Orders' }), 'Added 1 task with 2 subtasks to Orders');
  assert.equal(addedWhere({ n: 1, project: 'Orders', photos: 2, but: ', but @sam can\'t see Orders' }), 'Added to Orders, with 2 photos, but @sam can\'t see Orders');
  assert.equal(addedWhere({ n: 2 }), 'Added 2 tasks to its project');
});

test('Move all to today says how many moved, and what stayed', () => {
  assert.equal(movedText(6, 0, ''), 'Moved 6 to today');
  assert.equal(movedText(1, 2, ''), 'Moved 1 to today. 2 weren\'t saved and are still overdue.');
  assert.equal(movedText(2, 0, '1 repeating task stays: tick it.'), 'Moved 2 to today. 1 repeating task stays: tick it.');
  assert.equal(movedText(0, 0, '1 repeating task stays: tick it.'), 'Nothing moved. 1 repeating task stays: tick it.');
  assert.equal(sentLater('Done'), 'Done. It\'s sent once Pocket reaches Vikunja.');
});

// The places, on a pretend component with lines.js's methods, a screen (route) and a sheet.
const app = (route = 'today', sheet = blankSheet('')) => {
  const a = { route: { name: route }, sheet, places: {}, lines: {}, said: '', toasts: [], runView: null, notify(msg, action){ this.toasts.push({ msg, action }); } };
  return Object.defineProperties(a, Object.getOwnPropertyDescriptors(lines));
};

test('a message goes to its place when that is on screen, and to the toast when not', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const today = app('today'), undo = { label: 'Undo', fn(){} };
  assert.equal(today.say('Moved 6 to today', { place: 'overdue', action: undo }), 'place');
  assert.deepEqual(today.placeLines('overdue').map(l => [l.text, l.action.label]), [['Moved 6 to today', 'Undo']]);
  assert.equal(today.said, 'Moved 6 to today. Undo is beside it.', 'a screen reader hears it');
  t.mock.timers.tick(5000);
  assert.deepEqual(today.placeLines('overdue'), [], 'gone with its Undo\'s time');

  const search = app('search');
  assert.equal(search.say('Moved 6 to today', { place: 'overdue' }), 'toast', 'Overdue is only on Today');
  assert.equal(search.toasts[0].msg, 'Moved 6 to today');
  assert.equal(app('project').say('Added to Orders', { place: 'cap' }), 'place', 'the add box is on a project');
  assert.equal(app('run').say('x', { place: ['sheet:files', 'step', 'run'] }), 'place', 'the first of a list on screen');
});

test('a sheet\'s messages are in it, under what each is about, and go with it', () => {
  const task = app('today', { ...blankSheet('task'), open: true, task: { id: 1 } });
  task.say('Not saved: no connection', { place: 'sheet:notes', cls: 'failed' });
  assert.equal(task.sheet.lines.notes.text, 'Not saved: no connection');
  assert.equal(task.sheet.lines.notes.cls, 'failed');
  // Another kind of sheet has its message at its top.
  const proj = app('projects', { ...blankSheet('project'), open: true });
  proj.say('Renamed', { place: 'sheet:notes' });
  assert.deepEqual(Object.keys(proj.sheet.lines), ['top']);
  // Closed, there's no sheet to say it in.
  const closed = app('today');
  assert.equal(closed.say('Renamed', { place: 'sheet:top' }), 'toast');
  // A save that failed, done since, takes its message back.
  task.unsay('sheet:notes');
  assert.deepEqual(task.placeLines('sheet:notes'), []);
});

test('an action tapped runs once, and its line goes without calling gone', () => {
  let ran = 0, gone = 0;
  const a = app('today');
  a.sayAt('overdue', { text: 'Moved 2 to today', action: { label: 'Undo', fn: () => ran++ }, gone: () => gone++ });
  const [l] = a.placeLines('overdue');
  a.runPlaceAction(l); a.runPlaceAction(l);
  assert.deepEqual([ran, gone, a.placeLines('overdue').length], [1, 0, 0]);
  // Leaving the screen: what's left folds, as gone.
  a.sayAt('overdue', { text: 'Nothing moved', gone: () => gone++ });
  a.foldLines();
  assert.deepEqual([gone, a.placeLines('overdue').length], [1, 0]);
});
