// The messages Pocket shows (src/js/messages.js), and where each one appears on a screen or in a sheet (src/js/app/lines.js).
import './browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addedWhere,
  cancelName,
  completeAsk,
  COPIED,
  dayWord,
  doneLine,
  doneText,
  headText,
  moreDone,
  movedText,
  movedTo,
  movedToProject,
  namesText,
  notKnown,
  notReordered,
  notMovedBack,
  notSaved,
  OP_WORDS,
  sentLater,
  startedText,
  toOutbox,
  UNKNOWN,
} from '../../src/js/messages.js';
import { KEPT } from '../../src/js/sync.js';
import { NetError } from '../../src/js/api.js';
import lines from '../../src/js/app/lines.js';
import leaving from '../../src/js/app/leaving.js';
import { blankSheet } from '../../src/js/app/core.js';
import toastPart, { UNDO_MS } from '../../src/js/app/toast.js';

/* The row at the end of a list of done tasks that is shown a part at a time. It offers the next part and says how many
   tasks are left. When fewer than a full part are left, it offers the last of them. When none are left, there is no
   row. */
test('the row for more done tasks names what a tap shows and how many tasks are left', () => {
  assert.deepEqual(moreDone(2900, 100), {
    title: 'Show 100 done earlier',
    note: `${(2900).toLocaleString()} more not shown`,
  });
  assert.deepEqual(moreDone(101, 100), { title: 'Show 100 done earlier', note: '101 more not shown' });
  assert.deepEqual(
    moreDone(100, 100),
    { title: 'Show the last 100', note: '' },
    'when exactly one part is left, the row offers the last of them',
  );
  assert.deepEqual(moreDone(12, 100), { title: 'Show the last 12', note: '' });
  assert.deepEqual(moreDone(1, 50), { title: 'Show the last one', note: '' });
  assert.deepEqual(
    moreDone(60, 50),
    { title: 'Show 50 done earlier', note: '60 more not shown' },
    'search loads 50 at a time',
  );
  assert.equal(moreDone(0, 100), null, 'with no tasks left, there is no row');
  assert.equal(
    moreDone(-3, 100),
    null,
    'with more tasks shown than counted, because tasks were done since, there is no row',
  );
});

test('a message for a change that was not saved gives the reason in a few words', () => {
  assert.equal(notSaved(new NetError('Failed to fetch')), 'Not saved: no connection');
  assert.equal(notSaved(new Error('Forbidden')), 'Not saved: Forbidden');
});

test('a rejected reorder gives the reason', () => {
  assert.equal(notReordered(Object.assign(new Error('Forbidden'), { status: 403 })), 'Not reordered: Forbidden');
});

/* A message about a change kept in the Outbox names the change and has an Outbox button. The button opens the Outbox
   and sends nothing. Only the Outbox's own row tells the user to check, then tap Try again. */
test('a change with an unknown answer, or kept to try again, points to the Outbox', () => {
  assert.equal(
    notKnown(OP_WORDS.done.refused({ op: 'done' }, 'Buy milk')),
    'A tick on “Buy milk” may not have reached Vikunja.',
  );
  assert.equal(
    notKnown(OP_WORDS.add.refused({ op: 'add' }, 'Buy milk')),
    'Adding “Buy milk” may not have reached Vikunja.',
  );
  assert.equal(KEPT, " It's kept to try again.");
  assert.equal(UNKNOWN, "Vikunja may or may not have this change. Check, then tap Try again if it's missing.");
  let opened = 0;
  const b = toOutbox({ openOutbox: () => opened++ });
  b.fn();
  assert.deepEqual([b.label, opened], ['Outbox', 1]);
});

test('a tick message says "Closed" with a count when a parent closed its open subtasks, and "Done:" otherwise', () => {
  assert.equal(doneText(0, 0, 'Call Jo'), 'Done: Call Jo');
  assert.equal(doneText(4, 4, 'Pack the van'), 'Closed Pack the van + 4 subtasks');
  assert.equal(doneText(1, 1, 'Pack the van'), 'Closed Pack the van + 1 subtask');
  assert.equal(doneText(1, 3, 'Pack'), "Closed Pack + 1 of 3 subtasks: the rest couldn't be closed");
  assert.equal(doneText(0, 2, 'Pack'), "Done: Pack — its 2 subtasks couldn't be closed");
  assert.equal(doneText(0, 0, 'x'.repeat(50)), 'Done: ' + 'x'.repeat(38) + '…', 'a long title is cut short');
  // On the row, the title is shown struck through, with the text before it and after it separate.
  assert.deepEqual(doneLine(2, 2, 'Pack the van'), { text: 'Closed', title: 'Pack the van', more: '+ 2 subtasks' });
  assert.deepEqual(doneLine(0, 0, 'Pack the van'), { text: 'Done:', title: 'Pack the van', more: '' });
});

test('a done task with open subtasks shows why it is on the open list', () => {
  assert.equal(headText(1), 'Done, but 1 subtask is still open');
  assert.equal(headText(3), 'Done, but 3 subtasks are still open');
  assert.equal(headText(0), 'Done');
});

test('the add box says where the tasks just added went', () => {
  assert.equal(addedWhere({ n: 1, project: 'Orders' }), 'Added to Orders');
  assert.match(
    addedWhere({ n: 1, project: 'Orders', due: new Date(Date.now() + 30 * 864e5).toISOString() }),
    /^Added to Orders, due (\w+ \d+|\d+ \w+)/,
  );
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  assert.equal(
    addedWhere({ n: 1, project: 'Orders', due: tomorrow.toISOString() }),
    'Added to Orders, due tomorrow',
    'a due day is written as a word in the middle of the sentence',
  );
  assert.equal(addedWhere({ n: 3, project: 'Orders' }), 'Added 3 tasks to Orders');
  assert.equal(addedWhere({ n: 3, subs: 2, project: 'Orders' }), 'Added 1 task with 2 subtasks to Orders');
  assert.equal(
    addedWhere({ n: 9, subs: 7, project: 'Orders' }),
    'Added 2 tasks with 7 subtasks to Orders',
    'a list with several parent tasks',
  );
  assert.equal(
    addedWhere({ n: 1, project: 'Orders', photos: 2, but: ", but @sam can't see Orders" }),
    "Added to Orders, with 2 photos, but @sam can't see Orders",
  );
  assert.equal(addedWhere({ n: 2 }), 'Added 2 tasks to its project');
});

test('Move all to today reports how many tasks moved and which tasks stayed', () => {
  assert.equal(movedText(6, ''), 'Moved 6 to today');
  assert.equal(movedText(2, '1 repeating task stays: tick it.'), 'Moved 2 to today. 1 repeating task stays: tick it.');
  assert.equal(movedText(0, '1 repeating task stays: tick it.'), 'Nothing moved. 1 repeating task stays: tick it.');
  assert.equal(sentLater('Done'), "Done. It's sent once Pocket reaches Vikunja.");
});

// A fake component with the methods from lines.js and leaving.js, a screen (route) and a sheet. Messages appear at a `place` on the screen or in the sheet.
const app = (route = 'today', sheet = blankSheet('')) => {
  const a = {
    route: { name: route },
    sheet,
    places: {},
    lines: {},
    leaving: {},
    said: '',
    toasts: [],
    runView: null,
    notify(msg, action) {
      this.toasts.push({ msg, action });
    },
  };
  for (const part of [lines, leaving]) Object.defineProperties(a, Object.getOwnPropertyDescriptors(part));
  return a;
};

test('a message appears at its place when that place is on screen, and in the toast when it is not', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const today = app('today'),
    undo = { label: 'Undo', fn() {} };
  assert.equal(today.say('Moved 6 to today', { place: 'overdue', action: undo }), 'place');
  assert.deepEqual(
    today.placeLines('overdue').map(l => [l.text, l.action.label]),
    [['Moved 6 to today', 'Undo']],
  );
  assert.equal(
    today.said,
    'Moved 6 to today. Undo is beside it.',
    'a screen reader announces the message and its Undo',
  );
  t.mock.timers.tick(5000);
  assert.deepEqual(today.placeLines('overdue'), [], 'the message disappears when the time for its Undo ends');

  const search = app('search');
  assert.equal(search.say('Moved 6 to today', { place: 'overdue' }), 'toast', 'Overdue is only on Today');
  assert.equal(search.toasts[0].msg, 'Moved 6 to today');
  assert.equal(app('project').say('Added to Orders', { place: 'cap' }), 'place', 'the add box is on a project');
  assert.equal(
    app('run').say('x', { place: ['sheet:files', 'step', 'run'] }),
    'place',
    'the first place in the list that is on screen is used',
  );
});

/* In the page, anything put in the component's data comes back as Alpine's copy of it (a Proxy), never as the original
   object. This test uses a store that does the same. The timer that ends a message must remove the copy that the store
   returns. */
test("a message disappears when its time is up, even if the store returns a copy of it, as Alpine's does", t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const copies = new WeakMap(),
    copy = o => copies.get(o) || (copies.set(o, new Proxy(o, {})), copies.get(o));
  const today = app('today');
  let gone = 0;
  today.places = new Proxy(
    {},
    { get: (store, k) => (store[k] && typeof store[k] === 'object' ? copy(store[k]) : store[k]) },
  );
  today.sayAt('cap', { text: 'Moved to tomorrow', action: { label: 'Undo', fn() {} }, gone: () => gone++ });
  assert.equal(today.placeLines('cap').length, 1);
  t.mock.timers.tick(4999);
  assert.equal(today.placeLines('cap').length, 1, 'the message stays for the time of its Undo');
  t.mock.timers.tick(1);
  assert.deepEqual([today.placeLines('cap').length, gone], [0, 1], 'the message is then removed');
  today.sayAt('cap', { text: 'Not added', cls: 'failed' });
  t.mock.timers.tick(4000);
  assert.equal(today.placeLines('cap').length, 0, 'a message with nothing to tap is removed after a shorter time');
  today.sayAt('cap', { text: 'Stays', ms: null });
  t.mock.timers.tick(60000);
  assert.equal(today.placeLines('cap').length, 1, 'a message with no time limit stays until the screen is left');
});

test("a sheet's messages appear in the sheet, under the part each is about, and go away with the sheet", () => {
  const task = app('today', { ...blankSheet('task'), open: true, task: { id: 1 } });
  task.say('Not saved: no connection', { place: 'sheet:notes', cls: 'failed' });
  assert.equal(task.sheet.lines.notes.text, 'Not saved: no connection');
  assert.equal(task.sheet.lines.notes.cls, 'failed');
  // Another kind of sheet shows the message at its top.
  const proj = app('projects', { ...blankSheet('project'), open: true });
  proj.say('Renamed', { place: 'sheet:notes' });
  assert.deepEqual(Object.keys(proj.sheet.lines), ['top']);
  // The New template sheet has its own place for the list of steps. A message for the steps appears there, and the sheet's top message does not appear in it as well.
  const tpl = app('checklists', { ...blankSheet('newtpl'), open: true });
  tpl.say('Not finished', { place: 'sheet:top', cls: 'failed' });
  tpl.say('Not moved', { place: 'sheet:subtasks', cls: 'failed' });
  assert.deepEqual(
    [tpl.placeLines('sheet:top').map(l => l.text), tpl.placeLines('sheet:subtasks').map(l => l.text)],
    [['Not finished'], ['Not moved']],
  );
  // With no sheet open, the message goes to a toast instead.
  const closed = app('today');
  assert.equal(closed.say('Renamed', { place: 'sheet:top' }), 'toast');
  // A save that failed and then succeeded removes its failure message.
  task.unsay('sheet:notes');
  assert.deepEqual(task.placeLines('sheet:notes'), []);
});

test('a tapped action runs once, and its message is removed without calling its gone callback', () => {
  let ran = 0,
    gone = 0;
  const a = app('today');
  a.sayAt('overdue', { text: 'Moved 2 to today', action: { label: 'Undo', fn: () => ran++ }, gone: () => gone++ });
  const [l] = a.placeLines('overdue');
  a.runPlaceAction(l);
  a.runPlaceAction(l);
  assert.deepEqual([ran, gone, a.placeLines('overdue').length], [1, 0, 0]);
  // Leaving the screen folds away the remaining messages and calls `gone` for each.
  a.sayAt('overdue', { text: 'Nothing moved', gone: () => gone++ });
  a.foldLines();
  assert.deepEqual([gone, a.placeLines('overdue').length], [1, 0]);
});

// A toast's Undo keeps something until the toast ends: a held delete waits to be sent, and Cancel keeps the entry.
test('a toast with an Undo calls its gone once when it times out, and never after its Undo is tapped', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = Object.defineProperties({ toast: { show: false } }, Object.getOwnPropertyDescriptors(toastPart));
  let ran = 0,
    gone = 0;
  a.notify('Deleted', { label: 'Undo', fn: () => ran++, gone: () => gone++ });
  t.mock.timers.tick(UNDO_MS);
  assert.deepEqual([a.toast.show, ran, gone], [false, 0, 1]);
  a.toastGone(a.toast); // as the watch on toast.show does next
  assert.equal(gone, 1);
  a.notify('Deleted', { label: 'Undo', fn: () => ran++, gone: () => gone++ });
  a.runToastAction();
  t.mock.timers.tick(UNDO_MS);
  assert.deepEqual([ran, gone], [1, 1]);
});

test('on a checklist, a note on a step or the checklist is called a comment, as in Vikunja, in the Outbox and its messages', () => {
  const t = 'Unlock the door';
  assert.equal(OP_WORDS.note.text({ op: 'note' }, t), 'A comment on “Unlock the door”');
  assert.equal(OP_WORDS.doneNote.text({ op: 'doneNote' }, t), 'Done, with a comment: Unlock the door');
  assert.equal(OP_WORDS.note.dropped({ op: 'note' }, t), 'Your comment is back where you typed it.');
  assert.equal(OP_WORDS.note.refused({ op: 'note' }, t), 'A comment on “Unlock the door”');
  assert.equal(OP_WORDS.doneNote.refused({ op: 'doneNote' }, t), 'Marking “Unlock the door” done, with its comment');
});

test('dropping a finish or a reopen says what Vikunja has, also when only its first part was sent', () => {
  assert.deepEqual(
    [0, 1].map(stage => OP_WORDS.finish.dropped({ op: 'finish', stage }, 'Closing up')),
    ['“Closing up” stays open.', '“Closing up” is finished.'],
  );
  assert.deepEqual(
    [0, 1].map(stage => OP_WORDS.reopen.dropped({ op: 'reopen', stage }, 'Closing up')),
    ['“Closing up” stays finished.', '“Closing up” is open.'],
  );
});

test('a cancelled start, Make template or added step names what is being cancelled, in its row and its refusal', () => {
  const start = { op: 'startRun', cancelled: true, template: { title: 'Closing' } },
    make = { op: 'makeTemplate', cancelled: true },
    step = { op: 'templateStep', cancelled: true, p: { title: 'Wipe the till' } },
    insert = { op: 'addStep', cancelled: true, title: 'Sweep up' };
  assert.deepEqual(
    [OP_WORDS.startRun.text(start), OP_WORDS.startRun.refused(start)],
    ['Cancelling the start of “Closing”', 'Cancelling the start of “Closing”'],
  );
  assert.deepEqual(
    [OP_WORDS.makeTemplate.text(make, 'Closing'), OP_WORDS.makeTemplate.refused(make, 'Closing')],
    ['Cancelling Make template on “Closing”', 'Cancelling Make template on “Closing”'],
  );
  assert.deepEqual(
    [OP_WORDS.templateStep.text(step, 'Closing'), OP_WORDS.addStep.text(insert)],
    [
      'Removing “Wipe the till”, because adding it was cancelled',
      'Removing “Sweep up”, because adding it was cancelled',
    ],
  );
});

/* Pocket's copy of each task holds Vikunja's values. Task 7 is a subtask of 1. Without a copy, the words name the
   value before the change. */
test("Cancel's words name each value as Pocket's copy of the task has it, and a partly sent op first says what Vikunja has", () => {
  const COPIES = {
      1: { id: 1, title: 'Groceries', percent_done: 0.6 },
      7: {
        id: 7,
        title: 'Buy mlk',
        priority: 1,
        percent_done: 0.4,
        due_date: new Date(2031, 9, 20, 9).toISOString(),
        assignees: [{ id: 1 }, { id: 2, username: 'sam' }],
        related_tasks: { parenttask: [{ id: 1 }] },
        project_id: 5,
      },
    },
    copy = id => COPIES[id],
    words = (op, a, c = copy) => OP_WORDS[op].dropped({ op, task: 7, user: 1, stage: 0, ...a }, 'Buy milk', c);
  assert.deepEqual(
    [
      words('edit', { set: { title: 'Buy milk' }, was: { title: 'Buy mk' } }),
      words('edit', { set: { priority: 3 }, was: { priority: 0 } }),
      words('edit', { set: { priority: 3 }, was: { priority: 0 } }, () => undefined),
      words('progress', { pct: 80, up: 1 }),
      words('progress', { pct: 40, up: 1, stage: 1 }),
      words('due', { due: '0001-01-01T00:00:00Z' }),
      words('delete', { ids: [7], up: 1 }),
      words('delete', { ids: [7], up: 1, stage: 1 }),
      words('done', { up: 1 }),
      words('claim', {}),
      words('unlink', { up: 1, over: 'Groceries' }),
      words('link', { up: 1, over: 'Groceries', stage: 1 }),
      words('project', { pid: 6, was: { 7: 5 }, into: 'Errands', from: 'Home' }),
      words('repeat', { set: { repeat_after: 86400 }, was: { repeat_after: 604800 } }, () => undefined),
    ],
    [
      '“Buy milk” title stays “Buy mlk”.',
      '“Buy milk” priority stays Low.',
      '“Buy milk” stays without a priority.',
      '“Buy milk” progress stays 40%.',
      '“Buy milk” progress is 40%. “Groceries” progress stays 60%.',
      '“Buy milk” due date stays Mon, Oct 20, 2031.',
      '“Buy milk” stays in Vikunja.',
      '“Buy milk” is deleted. “Groceries” progress stays 60%.',
      '“Buy milk” stays not done.',
      '“Buy milk” stays assigned to you and sam.',
      '“Buy milk” stays a subtask of “Groceries”.',
      '“Buy milk” is a subtask of “Groceries”. “Groceries” progress stays 60%.',
      '“Buy milk” stays in Home.',
      '“Buy milk” repeat stays every week.',
    ],
  );
});

test("the question a parent's ring asks lists the tasks that close with it, naming the first three and counting the rest", () => {
  assert.equal(namesText(['Load chairs']), 'Load chairs');
  assert.equal(namesText(['Load chairs', 'Book the hall']), 'Load chairs and Book the hall');
  assert.equal(
    namesText(['Load chairs', 'Book the hall', 'Wipe the tables']),
    'Load chairs, Book the hall and Wipe the tables',
  );
  assert.equal(
    namesText(['Load chairs', 'Book the hall', 'Wipe the tables', 'Stack cups', 'Sweep']),
    'Load chairs, Book the hall, Wipe the tables and 2 more',
  );
  assert.deepEqual(completeAsk({ title: 'Pack the van', names: ['Load chairs'] }), {
    head: 'Complete “Pack the van”?',
    body: 'Its open subtask will be marked done too: Load chairs.',
    yes: 'Complete all 2',
  });
  assert.deepEqual(completeAsk({ title: 'Pack the van', names: ['Load chairs', 'Book the hall', 'Wipe the tables'] }), {
    head: 'Complete “Pack the van”?',
    body: 'Its 3 open subtasks will be marked done too: Load chairs, Book the hall and Wipe the tables.',
    yes: 'Complete all 4',
  });
  assert.equal(
    completeAsk({ title: 'Pack the van', names: ['A', 'B', 'C', 'D', 'E'], stay: 1 }).body,
    'Its 5 open subtasks will be marked done too: A, B, C and 2 more. The one that repeats stays as it is.',
  );
  assert.deepEqual(completeAsk({ title: 'Closing up', run: true, names: ['Mop', 'Lock up'] }), {
    head: 'Finish this checklist with 2 steps not done?',
    body: 'These 2 steps stay not done: Mop and Lock up.',
    yes: 'Finish checklist',
  });
  assert.equal(completeAsk({ title: 'Closing up', run: true, names: ['Mop'] }).body, 'This step stays not done: Mop.');
});

test('moving a task to another project names the project and counts the subtasks that went with it', () => {
  assert.equal(movedToProject('Errands'), 'Moved to Errands');
  assert.equal(movedToProject('Errands', 1), 'Moved to Errands, with its subtask');
  assert.equal(movedToProject('Errands', 3), 'Moved to Errands, with its 3 subtasks');
  assert.equal(
    movedToProject(undefined, 2),
    'Moved to the other project, with its 2 subtasks',
    'a project Pocket has not loaded yet',
  );
});

test('moving a task held on Today names where it went, explains a card kept by its subtask, and reports what an Undo could not move back', () => {
  assert.equal(movedTo('Friday'), 'Moved to Friday');
  assert.equal(movedTo('Today'), 'Moved to today');
  assert.equal(movedTo('Mon 12'), 'Moved to Mon 12');
  assert.equal(movedTo(null), 'Removed its due date');
  assert.equal(
    notMovedBack(1, null),
    "1 task couldn't be moved back (changed since, or not saved) and is still without a date.",
  );
  assert.equal(
    movedTo('Tomorrow', 'Buy paint'),
    'Moved to tomorrow. Its subtask “Buy paint” is due sooner, so it stays here.',
  );
  assert.equal(
    movedTo(null, 'Buy paint'),
    'Removed its due date. Its subtask “Buy paint” has a date, so it stays here.',
  );
  assert.equal(dayWord('Friday'), 'Friday');
  assert.equal(
    notMovedBack(1, 'today'),
    "1 task couldn't be moved back (changed since, or not saved) and is still due today.",
  );
  assert.equal(
    notMovedBack(2, 'Friday'),
    "2 tasks couldn't be moved back (changed since, or not saved) and are still due Friday.",
  );
});

// Who started a checklist, shown in its history. The summary shows only the time when the checklist started today. The
// ⋯ menu always shows the day. When the time is unknown, only the name is shown. When the name is unknown, nothing is shown.
test('a checklist shows who started it and when, with the day if it started on another day or in the ⋯ menu', () => {
  const now = new Date(2026, 9, 9, 14, 0),
    at = new Date(2026, 9, 9, 6, 2),
    before = new Date(2026, 9, 8, 6, 2);
  const time = d => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    full = d => d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  assert.equal(startedText('Priya', at.toISOString(), { now }), 'Started by Priya at ' + time(at));
  assert.equal(startedText('you', before.toISOString(), { now }), 'Started by you, ' + full(before));
  assert.equal(startedText('Priya', at.toISOString(), { now, day: true }), 'Started by Priya, ' + full(at));
  assert.equal(startedText('Priya', null, { now }), 'Started by Priya');
  assert.equal(startedText(null, at.toISOString(), { now }), '');
});

test('Cancel on a waiting row names what happens to the lines waiting under it', () => {
  assert.equal(cancelName('Pack the van'), 'Cancel Pack the van');
  assert.equal(cancelName('Pack the van', 2), 'Cancel Pack the van. The lines under it become their own tasks.');
  assert.equal(cancelName('Pack the van', 1), 'Cancel Pack the van. The line under it becomes its own task.');
  assert.equal(
    cancelName('Load chairs', 1, 'Pack the van'),
    'Cancel Load chairs. The line under it moves under “Pack the van”.',
  );
  assert.equal(
    cancelName('Load chairs', 3, 'Pack the van'),
    'Cancel Load chairs. The lines under it move under “Pack the van”.',
  );
});

test("the Markdown copy message names both uses: pasting into notes, and pasting into Pocket's add box to make the same tasks", () => {
  assert.equal(
    COPIED.markdown,
    "Copied as a Markdown list. Paste it into your notes, or into Pocket's add box to make the same tasks",
  );
});
