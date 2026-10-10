// What Pocket says (src/js/messages.js), and where (src/js/app/lines.js): its places on each screen and in a sheet.
import './browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addedWhere, cancelName, completeAsk, COPIED, dayWord, doneLine, doneText, headText, moreDone, movedText, movedTo, namesText, notMoved, notMovedBack, notSaved, sentLater, startedText } from '../../src/js/messages.js';
import { NetError } from '../../src/js/api.js';
import lines from '../../src/js/app/lines.js';
import leaving from '../../src/js/app/leaving.js';
import { blankSheet } from '../../src/js/app/core.js';
import outbox from '../../src/js/app/outbox.js';
import runs from '../../src/js/app/runs.js';
import { component } from './fake.mjs';

/* The row at the end of a list of done tasks shown a part at a time (performance-plan, part 9): the next part, and how
   many are left; fewer left than a part, the last of them; none, no row. */
test('the row for more done tasks says what its tap shows, and how many are left', () => {
  assert.deepEqual(moreDone(2900, 100), { title: 'Show 100 more, done before these', note: `${(2900).toLocaleString()} more not shown` });
  assert.deepEqual(moreDone(101, 100), { title: 'Show 100 more, done before these', note: '101 more not shown' });
  assert.deepEqual(moreDone(100, 100), { title: 'Show the last 100, done before these', note: '' }, 'a part left: the last of them');
  assert.deepEqual(moreDone(12, 100), { title: 'Show the last 12, done before these', note: '' });
  assert.deepEqual(moreDone(1, 50), { title: 'Show the last one, done before these', note: '' });
  assert.deepEqual(moreDone(60, 50), { title: 'Show 50 more, done before these', note: '60 more not shown' }, 'search: 50 at a time');
  assert.equal(moreDone(0, 100), null, 'none left: no row');
  assert.equal(moreDone(-3, 100), null, 'more shown than counted (done since): no row');
});

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

test('what a tick says: a parent that closed its open subtasks, "Closed", with how many; none, "Done:"', () => {
  assert.equal(doneText(0, 0, 'Call Jo'), 'Done: Call Jo');
  assert.equal(doneText(4, 4, 'Pack the van'), 'Closed Pack the van + 4 subtasks');
  assert.equal(doneText(1, 1, 'Pack the van'), 'Closed Pack the van + 1 subtask');
  assert.equal(doneText(1, 3, 'Pack'), "Closed Pack + 1 of 3 subtasks: the rest couldn't be closed");
  assert.equal(doneText(0, 2, 'Pack'), "Done: Pack — its 2 subtasks couldn't be closed");
  assert.equal(doneText(0, 0, 'x'.repeat(50)), 'Done: ' + 'x'.repeat(38) + '…', 'a long title is cut short');
  // On its row: the title on its own, struck through, with what's before and after it.
  assert.deepEqual(doneLine(2, 2, 'Pack the van'), { text: 'Closed', title: 'Pack the van', more: '+ 2 subtasks' });
  assert.deepEqual(doneLine(0, 0, 'Pack the van'), { text: 'Done:', title: 'Pack the van', more: '' });
});

test('a done task over its open subtasks says why it\'s on the open list', () => {
  assert.equal(headText(1), 'Done, but 1 subtask is still open');
  assert.equal(headText(3), 'Done, but 3 subtasks are still open');
  assert.equal(headText(0), 'Done');
});

test('where tasks just added went, said by the add box', () => {
  assert.equal(addedWhere({ n: 1, project: 'Orders' }), 'Added to Orders');
  assert.match(addedWhere({ n: 1, project: 'Orders', due: new Date(Date.now() + 30 * 864e5).toISOString() }), /^Added to Orders, due (\w+ \d+|\d+ \w+)/);
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(0, 0, 0, 0);
  assert.equal(addedWhere({ n: 1, project: 'Orders', due: tomorrow.toISOString() }), 'Added to Orders, due tomorrow', 'a day in words, mid-sentence');
  assert.equal(addedWhere({ n: 3, project: 'Orders' }), 'Added 3 tasks to Orders');
  assert.equal(addedWhere({ n: 3, subs: 2, project: 'Orders' }), 'Added 1 task with 2 subtasks to Orders');
  assert.equal(addedWhere({ n: 9, subs: 7, project: 'Orders' }), 'Added 2 tasks with 7 subtasks to Orders', 'a list with several parents');
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
  const a = { route: { name: route }, sheet, places: {}, lines: {}, leaving: {}, said: '', toasts: [], runView: null, notify(msg, action){ this.toasts.push({ msg, action }); } };
  for (const part of [lines, leaving]) Object.defineProperties(a, Object.getOwnPropertyDescriptors(part));
  return a;
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

test('on a run, what\'s written on a step or the run is a comment, as Vikunja calls it, in Waiting to send and its messages', () => {
  const a = component(outbox, runs);
  Object.assign(a, { pending: [], failed: [], view: { groups: [], run: null }, actTitle: () => 'Unlock the door' });
  assert.equal(a.actText({ op: 'note', task: 1 }), 'A comment on “Unlock the door”');
  assert.equal(a.actText({ op: 'doneNote', task: 1 }), 'Done, with a comment: Unlock the door');
  assert.equal(a.dropText({ op: 'note', task: 1 }), 'The comment isn\'t posted: its words go back where you wrote them.');
  assert.equal(a.actWhat({ op: 'note', task: 1, run: 5 }), 'A comment on “Unlock the door”');
  assert.equal(a.actWhat({ op: 'doneNote', task: 1, run: 5 }), 'A tick and its comment on “Unlock the door”');
});

test('the question a parent’s ring asks names what goes with it in a sentence: the first three, then how many more', () => {
  assert.equal(namesText(['Load chairs']), 'Load chairs');
  assert.equal(namesText(['Load chairs', 'Book the hall']), 'Load chairs and Book the hall');
  assert.equal(namesText(['Load chairs', 'Book the hall', 'Wipe the tables']), 'Load chairs, Book the hall and Wipe the tables');
  assert.equal(namesText(['Load chairs', 'Book the hall', 'Wipe the tables', 'Stack cups', 'Sweep']), 'Load chairs, Book the hall, Wipe the tables and 2 more');
  assert.deepEqual(completeAsk({title: 'Pack the van', names: ['Load chairs']}),
    {head: 'Complete “Pack the van”?', body: 'Its open subtask will be marked done too: Load chairs.', yes: 'Complete all 2'});
  assert.deepEqual(completeAsk({title: 'Pack the van', names: ['Load chairs', 'Book the hall', 'Wipe the tables']}),
    {head: 'Complete “Pack the van”?', body: 'Its 3 open subtasks will be marked done too: Load chairs, Book the hall and Wipe the tables.', yes: 'Complete all 4'});
  assert.equal(completeAsk({title: 'Pack the van', names: ['A', 'B', 'C', 'D', 'E'], stay: 1}).body,
    'Its 5 open subtasks will be marked done too: A, B, C and 2 more. The one that repeats stays as it is.');
  assert.deepEqual(completeAsk({title: 'Closing up', run: true, names: ['Mop', 'Lock up']}),
    {head: 'Finish this run with 2 steps not done?', body: '“Closing up” is finished, and its 2 steps not done stay that way: Mop and Lock up.', yes: 'Finish run'});
  assert.equal(completeAsk({title: 'Closing up', run: true, names: ['Mop']}).body, '“Closing up” is finished, and its step not done stays that way: Mop.');
});

test('a card thrown to a new date but kept by its subtask says why; Move all to today\'s Undo, what couldn\'t go back', () => {
  assert.equal(movedTo('Friday'), 'Moved to Friday');
  assert.equal(movedTo('Today'), 'Moved to today');
  assert.equal(movedTo('Tomorrow', 'Buy paint'), 'Moved to tomorrow. Its subtask “Buy paint” is due sooner, so it stays here.');
  assert.equal(movedTo(null, 'Buy paint'), 'Took its date off. Its subtask “Buy paint” has a date, so it stays here.');
  assert.equal(dayWord('Friday'), 'Friday');
  assert.equal(notMovedBack(1, 'today'), '1 task couldn\'t be moved back (changed since, or not saved) and is still due today.');
  assert.equal(notMovedBack(2, 'Friday'), '2 tasks couldn\'t be moved back (changed since, or not saved) and are still due Friday.');
});

// Who started a run, in its history (parent-tasks-plan, the run's row): its summary, today with the time only, and its ⋯,
// always with the day; who alone when its time isn't known, nothing when who isn't.
test('a run says who started it and when, with the day when it was another day or at the top of its ⋯', () => {
  const now = new Date(2026, 9, 9, 14, 0), at = new Date(2026, 9, 9, 6, 2), before = new Date(2026, 9, 8, 6, 2);
  const time = d => d.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'}), full = d => d.toLocaleString([], {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});
  assert.equal(startedText('Priya', at.toISOString(), {now}), 'Started by Priya at ' + time(at));
  assert.equal(startedText('you', before.toISOString(), {now}), 'Started by you, ' + full(before));
  assert.equal(startedText('Priya', at.toISOString(), {now, day: true}), 'Started by Priya, ' + full(at));
  assert.equal(startedText('Priya', null, {now}), 'Started by Priya');
  assert.equal(startedText(null, at.toISOString(), {now}), '');
});

test('a waiting row\'s Cancel says what becomes of the lines waiting under it', () => {
  assert.equal(cancelName('Pack the van'), 'Cancel Pack the van');
  assert.equal(cancelName('Pack the van', 2), 'Cancel Pack the van: the lines under it become tasks of their own');
  assert.equal(cancelName('Pack the van', 1), 'Cancel Pack the van: the line under it becomes a task of its own');
  assert.equal(cancelName('Load chairs', 1, 'Pack the van'), 'Cancel Load chairs: the line under it goes under “Pack the van”');
  assert.equal(cancelName('Load chairs', 3, 'Pack the van'), 'Cancel Load chairs: the lines under it go under “Pack the van”');
});

test('a Markdown copy says both things it\'s for: notes, and Pocket\'s add box, where it makes the same tasks', () => {
  assert.equal(COPIED.markdown, 'Copied as a Markdown list: paste it into your notes, or into Pocket\'s add box to make the same tasks');
});
