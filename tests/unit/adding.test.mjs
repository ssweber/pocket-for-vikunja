// What an add box's lines become, through the outbox (src/js/app/sending.js, LINE_STEPS in src/js/sync.js), against a
// pretend Vikunja: what's sent for each line, in which order, and what its row shows once it's there. And what a box
// says it read before that: its chips and the words marked in it (src/js/app/quickadd.js).
import { fakeVikunja, component } from './fake.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import actions from '../../src/js/app/actions.js';
import tasks from '../../src/js/app/tasks.js';
import sending from '../../src/js/app/sending.js';
import leaving from '../../src/js/app/leaving.js';
import quickadd from '../../src/js/app/quickadd.js';
import views from '../../src/js/app/views.js';
import sheetPart from '../../src/js/app/sheet.js';
import { newBox } from '../../src/js/app/core.js';
import { todayGroups } from '../../src/js/lists.js';
import { sync } from '../../src/js/sync.js';

const DAY = 86400;
const pick = (part, ...names) => Object.fromEntries(names.map(n => [n, part[n]]));
// The component on Today, with the parts that send an entry and put what it made on the screen. The batch's timer is
// the test's, so it doesn't clear by itself.
const adding = t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const app = component(tasks, actions, leaving, quickadd, pick(sending, 'createTask', 'linkSubtask', 'sendEntry', 'placeSent', 'pendingPlace', 'arrivedDone', 'findSent', 'refreshPending', 'keyWaiting', 'markSlow', 'cancelPending', 'cancelLabel'));
  Object.assign(app, { user: { id: 1 }, pending: [], failed: [], deleting: [], slow: [], positions: {}, projects: [], canWrite: () => true });
  Object.defineProperty(app, 'pendingTasks', Object.getOwnPropertyDescriptor(sending, 'pendingTasks'));
  app.view = { groups: todayGroups(), route: '' };
  return app;
};
// A line as an add box keeps it in the outbox (packParsed): `p`, what was read in it; `under`: the line it's under.
const line = (title, p = {}, under = null) => ({ raw: title, p: { title, due: null, priority: 0, repeat: null, labels: [], assignees: [], project: null, remind: false, done: false, pct: 0, ...p }, under, taskId: null, done: false, linked: false });
// The same as a Pocket from before lines said which line they're under kept it: its entry's `nest` said it for them all.
const oldLine = (title, p = {}) => { const { under, ...x } = line(title, p); return x; };
let n = 0;
const entry = (items, more = {}) => ({ id: 'e' + ++n, user: 1, at: new Date().toISOString(), nest: false, pid: 5, items, files: [], ...more });
const send = async (app, e) => { await sync.add(e, []); app.refreshPending(); return app.sendEntry(e.id); };
const sent = v => v.requests.filter(r => r.method !== 'GET').map(r => [r.method, r.path, r.body]);
const group = (app, key) => app.view.groups.find(g => g.key === key).tasks;

test('a line that says it\'s done is made as any task, then marked done as a tick marks it', async t => {
  const v = fakeVikunja(), app = adding(t);
  const r = await send(app, entry([line('Call Sam', { done: true }), line('Call Jo')]));
  assert.deepEqual(sent(v), [['POST', '/projects/5/tasks', { title: 'Call Sam' }], ['PATCH', '/tasks/101', { done: true }], ['POST', '/projects/5/tasks', { title: 'Call Jo' }]]);
  assert.deepEqual([r.status, v.task(101).done, v.task(102).done], ['sent', true, false]);
  assert.equal(sync.all(1).length, 0, 'nothing left waiting');
});

test('while it waits, a line that says it\'s done is on its list ticked', async t => {
  const v = fakeVikunja(), app = adding(t);
  v.trouble = () => 'offline';
  const r = await send(app, entry([line('Call Sam', { done: true }), line('Call Jo')]));
  app.refreshPending();
  assert.equal(r.status, 'offline');
  assert.deepEqual(app.pendingTasks.map(x => [x.title, x.done]), [['Call Sam', true], ['Call Jo', false]]);
  await sync.remove(sync.all(1)[0].id);
});

test('a task that arrived done shows ticked on its row and leaves with the batch; its tick meanwhile opens it again', async t => {
  const v = fakeVikunja(), app = adding(t);
  const r = await send(app, entry([line('Call Sam', { done: true })]));
  app.placeSent(r.tasks);
  assert.deepEqual(group(app, 'nodate').map(x => [x.title, x.done]), [['Call Sam', true]], 'ticked, where a task added goes');
  assert.deepEqual([app.leaving, app.said], [{ 101: 'done' }, 'Done: Call Sam'], 'marked, as a tick marks it');
  t.mock.timers.tick(2999);
  assert.equal(group(app, 'nodate').length, 1, 'not before 3 seconds');
  await app.clearBatch(true);
  assert.deepEqual(group(app, 'nodate'), [], 'gone with the batch');
  // Another, opened again by its tick before the batch clears.
  const again = await send(app, entry([line('Call Jo', { done: true })]));
  app.placeSent(again.tasks);
  await app.unmark(102);
  assert.deepEqual([v.task(102).done, app.tasks[102].done, app.leaving], [false, false, {}]);
  await app.clearBatch(true);
  assert.deepEqual(group(app, 'nodate').map(x => x.title), ['Call Jo'], 'it stays');
});

test('one that repeats moves on to its next date, as a tick moves it, and a lost reply doesn\'t tick it twice', async t => {
  const v = fakeVikunja(), app = adding(t), due = new Date(Date.now() + 36e5).toISOString();
  const e = entry([line('Water the plants', { done: true, due, repeat: { after: DAY, mode: 0 } })]);
  v.trouble = r => r.method === 'PATCH' ? 'lost' : null;
  assert.equal((await send(app, e)).status, 'offline', 'kept, to try again');
  v.trouble = () => null;
  const r = await app.sendEntry(e.id);
  assert.equal(sent(v).filter(([m]) => m === 'PATCH').length, 1, 'ticked once: Vikunja\'s copy said it got there');
  assert.equal(Date.parse(v.task(101).due_date) - Date.parse(due), DAY * 1000);
  assert.equal(v.task(101).done, false);
  assert.equal(r.status, 'sent');
});

test('a repeating task that arrived done shows ticked with the date it was given, then open at its next', async t => {
  const v = fakeVikunja(), app = adding(t), due = new Date(Date.now() + 36e5).toISOString();
  const r = await send(app, entry([line('Water the plants', { done: true, due, repeat: { after: DAY, mode: 0 } })]));
  app.placeSent(r.tasks);
  const row = app.tasks[101];
  assert.deepEqual([row.done, row.due_date, app.leaving[101]], [true, due, 'done']);
  await app.clearBatch(true);
  assert.deepEqual([row.done, row.due_date], [false, v.task(101).due_date], 'open again, at its next date');
  assert.ok(app.view.groups.some(g => g.tasks.includes(row)), 'still on Today: its next date is within the week');
});

test('a line\'s progress is written once it\'s made, as a swipe would set it, and shows in its row\'s tick; 100% is done', async t => {
  const v = fakeVikunja(), app = adding(t);
  const e = entry([line('Tables', { pct: 50 }), line('Chairs', { pct: 100 })]);
  v.trouble = () => 'offline';
  await send(app, e);
  app.refreshPending();
  assert.deepEqual(app.pendingTasks.map(x => [x.title, x.percent_done, x.done]), [['Tables', 0.5, false], ['Chairs', 1, true]], 'while they wait, too');
  v.trouble = () => null;
  v.requests.length = 0;
  const r = await app.sendEntry(e.id);
  assert.deepEqual(sent(v), [['POST', '/projects/5/tasks', { title: 'Tables' }], ['PATCH', '/tasks/101', { percent_done: 0.5 }],
    ['POST', '/projects/5/tasks', { title: 'Chairs' }], ['PATCH', '/tasks/102', { done: true }]]);
  app.placeSent(r.tasks);
  assert.deepEqual(group(app, 'nodate').map(x => [x.title, x.percent_done, x.done]).sort(), [['Chairs', 0, true], ['Tables', 0.5, false]]);
  assert.deepEqual(app.leaving, { 102: 'done' }, 'only the one that\'s done leaves with the batch');
});

test('a line over lines that arrived done or with progress has the figure they give it, written once they\'re in', async t => {
  const v = fakeVikunja(), app = adding(t);
  await send(app, entry([line('Pack the van'), line('Load chairs', { done: true }, 0), line('Tables', {}, 0)]));
  await app.saveTask(101, null, () => null);
  assert.deepEqual([v.task(101).percent_done, v.task(102).done, v.task(103).done], [0.5, true, false], 'one of two done');
  assert.deepEqual(v.task(101).related_tasks.subtask.map(s => s.id), [102, 103]);
  await send(app, entry([line('Set the hall'), line('Tables', { pct: 50 }, 0), line('Lights', {}, 0)]));
  await app.saveTask(104, null, () => null);
  assert.equal(v.task(104).percent_done, 0.25, 'one at 50% of two');
  // With none done, its figure is 0, as Vikunja made it: nothing is written.
  v.requests.length = 0;
  await send(app, entry([line('Order cups'), line('Small', {}, 0), line('Large', {}, 0)]));
  assert.deepEqual(sent(v).filter(([m]) => m === 'PATCH'), []);
});

const links = v => v.requests.filter(r => r.path.endsWith('/relations')).map(r => [+r.path.split('/')[2], r.body.other_task_id]);
test('a list with several parents, and subtasks of subtasks: each line is made under the line it says, in order', async t => {
  const v = fakeVikunja(), app = adding(t);
  // "## Pack the van", "Load chairs", "  Stack them" (done), "## Set the hall", "Tables (50%)"
  const e = entry([line('Pack the van'), line('Load chairs', {}, 0), line('Stack them', { done: true }, 1), line('Set the hall'), line('Tables', { pct: 50 }, 3)]);
  v.trouble = () => 'offline';
  await send(app, e);
  app.refreshPending();
  assert.deepEqual(app.pendingTasks.map(x => [x.id, x.parent, x.child]), [[`pending-${e.id}-0`, null, false], [`pending-${e.id}-1`, `pending-${e.id}-0`, true],
    [`pending-${e.id}-2`, `pending-${e.id}-1`, true], [`pending-${e.id}-3`, null, false], [`pending-${e.id}-4`, `pending-${e.id}-3`, true]], 'while they wait: each row under its line\'s row, their ids in item order');
  v.trouble = () => null;
  v.requests.length = 0;
  const r = await app.sendEntry(e.id);
  assert.equal(r.status, 'sent');
  assert.deepEqual(links(v), [[101, 102], [102, 103], [104, 105]]);
  assert.deepEqual(r.tasks.map(x => [x.title, x.parent, x.child]), [['Pack the van', null, false], ['Load chairs', 101, true], ['Stack them', 102, true], ['Set the hall', null, false], ['Tables', 104, true]]);
  await app.saveTask(101, null, () => null);
  // The deepest first, as each counts in the one over it: Load chairs 100% (its one subtask done), so Pack the van 100%.
  assert.deepEqual(sent(v).filter(([m, , b]) => m === 'PATCH' && 'percent_done' in b && !b.done).map(([, path, b]) => [path, b.percent_done]),
    [['/tasks/105', 0.5], ['/tasks/104', 0.5], ['/tasks/102', 1], ['/tasks/101', 1]]);
});

test('an entry kept from before lines said which line they\'re under still sends: its first line over the rest, or all tasks of their own', async t => {
  const v = fakeVikunja(), app = adding(t);
  const r = await send(app, entry([oldLine('Pack the van'), oldLine('Load chairs'), oldLine('Tables')], { nest: true }));
  assert.deepEqual(links(v), [[101, 102], [101, 103]]);
  assert.deepEqual(r.tasks.map(x => x.parent), [null, 101, 101]);
  await send(app, entry([oldLine('Order cups'), oldLine('Order lids')]));
  assert.equal(links(v).length, 2, 'no more links: tasks of their own');
  // Half sent by the older Pocket: its first line made, and the project it went to kept on the entry.
  const half = entry([{ ...oldLine('Set the hall'), taskId: 101, projectId: 5, done: true }, oldLine('Lights')], { nest: true, parentProject: 5 });
  await send(app, half);
  assert.deepEqual(links(v).at(-1), [101, v.tasks.size + 100], 'the rest carries on under it');
  // Subtasks added from a task's sheet (parent), kept without `under`: under that task.
  await send(app, entry([oldLine('Sound check')], { parent: { id: 101, project_id: 5, title: 'Pack the van' } }));
  assert.deepEqual(links(v).at(-1), [101, v.tasks.size + 100]);
});

test('a waiting line cancelled: the lines under it go under what it was under, and it says so', async t => {
  const v = fakeVikunja(), app = adding(t);
  Object.assign(app, { cap: { text: '' } });
  v.trouble = () => 'offline';
  const e = entry([line('Pack the van'), line('Load chairs', {}, 0), line('Stack them', {}, 1), line('Tables', {}, 0)]);
  await send(app, e);
  // Each waiting row's Cancel says what becomes of the lines under it, a later parent's too.
  assert.deepEqual(app.pendingTasks.map(x => app.cancelLabel(x)), ['Cancel Pack the van. The lines under it become their own tasks.',
    'Cancel Load chairs. The line under it moves under “Pack the van”.', 'Cancel Stack them', 'Cancel Tables']);
  await app.cancelPending(e.id, 1);
  assert.deepEqual(sync.all(1)[0].items.map(x => [x.raw, x.under]), [['Pack the van', null], ['Stack them', 0], ['Tables', 0]]);
  assert.equal(app.toast.msg, 'Cancelled. It\'s back in the box. The 1 line under it is now under “Pack the van”.');
  assert.equal(app.cap.text, 'Load chairs');
  assert.equal(app.cancelLabel(app.pendingTasks[0]), 'Cancel Pack the van. The lines under it become their own tasks.', 'two still wait under the first');
  await app.cancelPending(e.id, 0);
  assert.deepEqual(sync.all(1)[0].items.map(x => [x.raw, x.under]), [['Stack them', null], ['Tables', null]]);
  assert.equal(app.toast.msg, 'Cancelled. It\'s back in the box. The 2 lines under it are now their own tasks.');
  assert.deepEqual(app.pendingTasks.map(x => app.cancelLabel(x)), ['Cancel Stack them', 'Cancel Tables']);
  // One kept from before, its first line cancelled: the rest are tasks of their own, as they were then.
  const old = entry([oldLine('Order cups'), oldLine('Small'), oldLine('Large')], { nest: true });
  await send(app, old);
  await app.cancelPending(old.id, 0);
  const left = sync.all(1).find(x => x.id === old.id);
  assert.deepEqual([left.nest, left.items.map(x => x.under)], [false, [null, null]]);
  for (const x of sync.all(1)) await sync.remove(x.id);
});

/* What a box reads, before it's sent (src/js/app/quickadd.js): the chips under it, as their words (a chip tapped off
   with a ~ before them), and the words marked in it, each as kind:words. */
const boxes = () => {
  const app = component(quickadd), cafe = { id: 5, title: 'Café' };
  Object.assign(app, { user: { id: 1, settings: { frontend_settings: {} } }, cap: newBox(), runInsert: newBox(), capPhotos: [], projects: [cafe], projById: new Map([[5, cafe]]),
    labels: [], people: [], access: {}, userKnown: {}, accessBlocked: false, checklistIds: new Set(), remindersReach: false, defaultProjectId: () => 5, canWrite: () => true });
  app.sheet = { task: { id: 9, project_id: 5, title: 'Pack the van' }, sub: newBox() };
  return app;
};
const chipsOf = (app, w) => app.chips(w).map(c => (c.off ? '~' : '') + c.text);
const marksOf = (app, w) => app.marks(w).map(m => m.kind + ':' + app.box(w).text.slice(m.start, m.end));
const linesOf = (app, w) => app.boxParsedLines(w).map(p => [p.title, p.done]);
const tap = (app, w, text) => app.tapChip(w, app.chips(w).find(c => c.text.includes(text)));

test('one line that says it\'s done: a Done chip, its marker marked; tapped off, the marker\'s words stay in the title', () => {
  const app = boxes();
  app.cap.text = 'x Call Sam !2';
  assert.deepEqual(chipsOf(app, 'cap'), ['Done', 'Café', 'Priority 2']);
  assert.deepEqual(marksOf(app, 'cap'), ['done:x', 'priority:!2']);
  assert.deepEqual(linesOf(app, 'cap'), [['Call Sam', true]]);
  tap(app, 'cap', 'Done');
  assert.deepEqual(chipsOf(app, 'cap'), ['~Done', 'Café', 'Priority 2']);
  assert.deepEqual(marksOf(app, 'cap'), ['priority:!2']);
  assert.deepEqual(linesOf(app, 'cap'), [['x Call Sam', false]]);
  tap(app, 'cap', 'Done');
  assert.deepEqual(linesOf(app, 'cap'), [['Call Sam', true]], 'tapped again: read again');
  // A capital X, as a phone's keyboard starts a line: the same chip, and tapped off, the title as typed.
  app.cap.text = 'X Call Sam';
  assert.deepEqual([chipsOf(app, 'cap')[0], marksOf(app, 'cap'), linesOf(app, 'cap')], ['Done', ['done:X'], [['Call Sam', true]]]);
  tap(app, 'cap', 'Done');
  assert.deepEqual(linesOf(app, 'cap'), [['X Call Sam', false]]);
  tap(app, 'cap', 'Done');
  // With quick add turned off in Vikunja, it's read all the same: it's about the list, not Vikunja's shortcuts.
  app.user.settings.frontend_settings.quick_add_magic_mode = 'disabled';
  app.cap.text = '- [x] Call Sam tomorrow (50%)';
  assert.deepEqual(marksOf(app, 'cap'), ['done:[x]', 'progress:(50%)']);
  assert.deepEqual(app.boxParsedLines('cap').map(p => [p.title, p.done, p.pct]), [['Call Sam tomorrow', true, 50]]);
});

test('a list with lines that say they\'re done: one chip counts them; tapped, they\'re left out, and tapped again they\'re back', () => {
  const app = boxes();
  app.cap.text = 'Groceries\n- [x] Eggs\n- [ ] Milk tomorrow\nx Bread';
  assert.deepEqual(chipsOf(app, 'cap'), ['2 will be added as done', '4 tasks', 'Café']);
  assert.deepEqual(marksOf(app, 'cap'), ['done:[x]', 'due:tomorrow', 'done:x']);
  assert.deepEqual(linesOf(app, 'cap'), [['Groceries', false], ['Eggs', true], ['Milk', false], ['Bread', true]]);
  tap(app, 'cap', 'will be added as done');
  assert.deepEqual(chipsOf(app, 'cap'), ['2 already ticked, left out', '2 tasks', 'Café']);
  assert.deepEqual(marksOf(app, 'cap'), ['due:tomorrow']);
  assert.deepEqual(linesOf(app, 'cap'), [['Groceries', false], ['Milk', false]]);
  tap(app, 'cap', 'left out');
  assert.deepEqual(chipsOf(app, 'cap'), ['2 will be added as done', '4 tasks', 'Café']);
  // A subtask box reads them the same way.
  app.sheet.sub.text = '[x] Load chairs\nTables';
  assert.deepEqual(chipsOf(app, 'sub'), ['1 will be added as done', '2 subtasks']);
  assert.deepEqual(linesOf(app, 'sub'), [['Load chairs', true], ['Tables', false]]);
});

const under = (app, w) => app.boxParsedLines(w).map(p => p.under);
test('a pasted list with headings: each a task over its lines, the chip counting them; ↳ Under first line shows on, and tapped off makes them all tasks', () => {
  const app = boxes();
  app.cap.text = '## Pack the van (38%)\n- Load chairs\n- [x] Tables\n## Set the hall\n- Lights (50%)';
  assert.deepEqual(chipsOf(app, 'cap'), ['1 will be added as done', '2 tasks + 3 subtasks', 'Café']);
  assert.deepEqual(under(app, 'cap'), [null, 0, 0, null, 3]);
  assert.deepEqual(app.boxParsedLines('cap').map(p => [p.title, p.pct]), [['Pack the van', 0], ['Load chairs', 0], ['Tables', 0], ['Set the hall', 0], ['Lights', 50]], 'a parent\'s figure is dropped');
  assert.equal(app.nestOn, true, 'the first line is a parent as the list is written');
  app.tapNest();
  assert.deepEqual([app.nestOn, under(app, 'cap')], [false, [null, null, null, null, null]]);
  assert.deepEqual(chipsOf(app, 'cap'), ['1 will be added as done', '5 tasks', 'Café']);
  app.tapNest();
  assert.deepEqual([app.nestOn, under(app, 'cap')], [true, [null, 0, 0, null, 3]], 'tapped again: as written');
  // A list with no markers: off until it's tapped, as before.
  app.cap = newBox();
  app.cap.text = 'Pack the van\nLoad chairs\nTables';
  assert.deepEqual([app.nestOn, chipsOf(app, 'cap')], [false, ['3 tasks', 'Café']]);
  app.tapNest();
  assert.deepEqual([app.nestOn, chipsOf(app, 'cap'), under(app, 'cap')], [true, ['1 task + 2 subtasks', 'Café'], [null, 0, 0]]);
  app.tapNest();
  assert.deepEqual([app.nestOn, under(app, 'cap')], [false, [null, null, null]]);
});

test('in a subtask box, a heading\'s lines go under it, and it goes under the open task', () => {
  const app = boxes();
  app.sheet.sub.text = '## Chairs\n- Stack them\n- [x] Count them\nTables';
  assert.deepEqual(chipsOf(app, 'sub'), ['1 will be added as done', '4 subtasks']);
  assert.deepEqual(app.boxItems('sub').map(x => [x.raw, x.under]), [['Chairs', null], ['Stack them', 0], ['x Count them', 0], ['Tables', 0]]);
});

test('a pasted list with indented lines: each under the line above it that\'s indented less, the chip counting them', () => {
  const app = boxes();
  app.cap.text = 'Pack the van (38%)\n  Load chairs (50%)\n    Stack them\n  Tables\nSet the hall';
  assert.deepEqual(chipsOf(app, 'cap'), ['2 tasks + 3 subtasks', 'Café']);
  assert.deepEqual(under(app, 'cap'), [null, 0, 1, 0, null]);
  assert.deepEqual(app.boxParsedLines('cap').map(p => p.pct), [0, 0, 0, 0, 0], 'a figure on a line with lines under it is dropped');
  assert.equal(app.nestOn, true);
  // In a subtask box: under the line above it, which is under the open task.
  app.sheet.sub.text = 'Chairs\n  Stack them\nTables';
  assert.deepEqual(app.boxItems('sub').map(x => [x.raw, x.under]), [['Chairs', null], ['Stack them', 0], ['Tables', null]]);
});

test('a project\'s copy pasted: its heading, one #, is the list\'s name, left out, and a chip says so', () => {
  const app = boxes();
  app.cap.text = '# Café · 3 open · 5 done\n- [ ] Order milk\n- [ ] Pack the van\n  - [ ] Tables (50%)';
  assert.deepEqual(chipsOf(app, 'cap'), ['The # line is the list’s name, so it is left out', '2 tasks + 1 subtask', 'Café']);
  assert.deepEqual(app.boxItems('cap').map(x => [x.p.title, x.under, x.p.pct]), [['Order milk', null, 0], ['Pack the van', null, 0], ['Tables', 1, 50]]);
  assert.equal(app.nestOn, false, 'the first line that\'s a task isn\'t a parent');
  // Alone in the box, a # line names no list: it's a task, as typed.
  app.cap.text = '# of chairs we need';
  assert.deepEqual([chipsOf(app, 'cap'), linesOf(app, 'cap')], [['Café'], [['# of chairs we need', false]]]);
});

test('a first line ending with a colon is the parent of the rest in quick add, its colon taken off; ↳ Under first line tapped off keeps it', () => {
  const app = boxes();
  app.cap.text = 'Groceries:\nmilk\n- [x] eggs';
  assert.deepEqual([chipsOf(app, 'cap'), app.nestOn], [['1 will be added as done', '1 task + 2 subtasks', 'Café'], true]);
  assert.deepEqual(app.boxItems('cap').map(x => [x.p.title, x.under]), [['Groceries', null], ['milk', 0], ['eggs', 0]]);
  app.tapNest();
  assert.deepEqual([chipsOf(app, 'cap'), app.nestOn], [['1 will be added as done', '3 tasks', 'Café'], false]);
  assert.deepEqual(app.boxItems('cap').map(x => [x.p.title, x.under]), [['Groceries:', null], ['milk', null], ['eggs', null]]);
  // A subtask box has no ↳ Under first line to tap it off with: the colon is a title's there.
  app.sheet.sub.text = 'Groceries:\nmilk';
  assert.deepEqual(app.boxItems('sub').map(x => [x.p.title, x.under]), [['Groceries:', null], ['milk', null]]);
});

/* Subtasks from the add box on a project's list (addSubtasks, actions.js; the cursor, quickadd.js): Pack the van, with
   Chairs under it, the box on the task: right under it, so the first one added goes ahead of Chairs. What's added is
   the lit row (`lit`, which each row reads by its own id), so the next go after it. */
const underBox = t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const v = fakeVikunja([{ id: 9, title: 'Pack the van', project_id: 5, related_tasks: { subtask: [{ id: 8 }] } }, { id: 8, title: 'Chairs', project_id: 5, related_tasks: { parenttask: [{ id: 9 }] } }]);
  const app = component(tasks, actions, leaving, quickadd, pick(sending, 'createTask', 'linkSubtask', 'sendEntry', 'placeSent', 'pendingPlace', 'arrivedDone', 'findSent', 'refreshPending', 'keyWaiting', 'markSlow', 'cancelPending', 'flush'));
  Object.defineProperty(app, 'pendingTasks', Object.getOwnPropertyDescriptor(sending, 'pendingTasks'));
  const van = app.keep(v.task(9)), chairs = app.keep(v.task(8));
  Object.assign(app, { user: { id: 1, settings: { frontend_settings: {} } }, pending: [], failed: [], deleting: [], slow: [], positions: { 8: 100 }, projects: [], labels: [], people: [], access: {}, userKnown: {},
    accessBlocked: false, checklistIds: new Set(), remindersReach: false, canWrite: () => true, cap: newBox(), capPhotos: [], route: { name: 'project', id: 5 },
    view: { groups: [{ key: 'open', tasks: [van, chairs] }], route: '', listView: 3 }, cursor: null, lit: {}, flash(){}, $nextTick(){} });
  app.aim(van);
  const add = text => { app.cap.text = text; return app.addSubtasks('under'); };
  // The one row lit, and what the line over the box says they go after.
  const aimed = () => [Object.keys(app.lit), app.capTarget?.after];
  return { v, app, van, chairs, add, aimed, pos: id => v.task(id).position };
};

test('a subtask added from the add box is the lit row at once: its waiting row, then its task\'s, and the next goes after it', async t => {
  const { v, app, add, aimed, pos } = underBox(t);
  const rope = add('Rope');
  const waits = Object.keys(app.lit)[0];
  assert.deepEqual(aimed(), [[waits], 'Rope'], 'before it\'s kept, or sent: the task\'s own row is dark');
  assert.deepEqual(app.pendingTasks.map(x => x.id), [waits], 'and its waiting row is on the list already, to be the one lit');
  await rope;
  assert.deepEqual(aimed(), [['101'], 'Rope'], 'sent: the same row, now Vikunja\'s task');
  assert.deepEqual(app.view.groups[0].tasks.map(x => x.id), [9, 8, 101], 'on the list, where its waiting row was');
  await add('Straps');
  assert.deepEqual(aimed(), [['102'], 'Straps']);
  assert.ok(pos(101) < 100 && pos(102) > pos(101) && pos(102) < 100, 'the first ahead of Chairs, each after the one before');
  // Two typed one straight after the other, the first still on its way: the second goes after it all the same.
  const one = add('Hooks'), two = add('Tarp');
  await Promise.all([one, two]);
  assert.deepEqual([aimed(), v.task(103).title, v.task(104).title], [[['104'], 'Tarp'], 'Hooks', 'Tarp']);
  assert.ok(pos(103) > pos(102) && pos(104) > pos(103));
});

test('without a connection, the subtask added waits, lit, and is lit still once it\'s sent later', async t => {
  const { v, app, add, aimed, pos } = underBox(t);
  v.trouble = () => 'offline';
  await add('Rope');
  await add('Straps');
  const rows = app.pendingTasks.map(x => [x.id, x.title, x.position]);
  assert.deepEqual(aimed(), [[rows[1][0]], 'Straps'], 'the last one\'s waiting row, by the id the list gives it');
  assert.deepEqual(rows.map(r => r[1]), ['Rope', 'Straps']);
  assert.ok(rows[0][2] < 100 && rows[1][2] > rows[0][2] && rows[1][2] < 100, 'ahead of Chairs, each after the one before, while they wait');
  assert.deepEqual([app.cursor.wait.title, app.cursor.wait.position], [rows[1][1], rows[1][2]], 'the cursor has its row\'s words and place');
  v.trouble = () => null;
  await app.flush();
  assert.deepEqual(aimed(), [['102'], 'Straps']);
  assert.deepEqual([pos(101), pos(102)], [rows[0][2], rows[1][2]]);
  assert.equal(sync.all(1).length, 0);
});

test('a pasted list with lines under them: the lit row is the last of the task\'s own, and the next go after it', async t => {
  const { v, app, add, aimed, pos } = underBox(t);
  const sent = add('Ladder\n  Check the feet\nTables\n  Fold the legs');
  assert.match(Object.keys(app.lit)[0], /^pending-[0-9a-f]+-2$/, 'Tables, not Fold the legs under it');
  await sent;
  assert.deepEqual(aimed(), [['103'], 'Tables']);
  assert.deepEqual(v.requests.filter(r => r.path.endsWith('/relations')).map(r => [+r.path.split('/')[2], r.body.other_task_id]), [[9, 101], [101, 102], [9, 103], [103, 104]]);
  assert.equal(app.positions[103], pos(103), 'at its place in the list, which the next go after');
  assert.ok(pos(101) < pos(102) && pos(102) < pos(103) && pos(103) < pos(104), 'each after the one before');
  await add('Rope');
  assert.ok(pos(105) > pos(103), 'after Tables');
});

test('a subtask added done isn\'t lit, as it leaves with the batch: its task is, and the next goes right under the task, ahead of it', async t => {
  const { app, add, aimed, pos } = underBox(t);
  await add('x Rope');
  assert.deepEqual([aimed(), app.leaving], [[['9'], ''], { 101: 'done' }]);
  await add('Straps');
  assert.deepEqual(aimed(), [['102'], 'Straps']);
  assert.ok(pos(102) < pos(101));
});

test('a waiting subtask called off, or turned down: the light goes to its task; the line before it called off, it stays on it', async t => {
  const { v, app, add, aimed } = underBox(t);
  v.trouble = () => 'offline';
  await add('Rope\nStraps');
  const e = sync.all(1)[0].id;
  assert.deepEqual(aimed(), [[`pending-${e}-1`], 'Straps']);
  await app.cancelPending(e, 0);
  assert.deepEqual([aimed(), app.pendingTasks.map(x => [x.id, x.title])], [[[`pending-${e}-0`], 'Straps'], [[`pending-${e}-0`, 'Straps']]], 'the same line, lit, a place sooner');
  await app.cancelPending(e, 0);
  assert.deepEqual([aimed(), app.toast.msg], [[['9'], ''], 'Cancelled.'], 'called off: its task is lit');
  // Turned down by Vikunja: back in the box, with why, and the task lit.
  v.trouble = r => r.method === 'POST' ? 400 : null;
  await add('Straps');
  assert.deepEqual([aimed(), app.cap.text, app.toast.msg], [[['9'], ''], 'Straps', 'Not added: HTTP 400']);
  assert.equal(sync.all(1).length, 0);
});

/* A row ticked is held done where it is from the tap, before Vikunja answers (holdRow, leaving.js). The box under it
   stays under it meanwhile, so nothing moves: a row waiting for the batch can still be the cursor (canAim). Not saved,
   the row is let go of, open again, the box under it still. Once the batch has cleared and the row has gone, its
   task has the box, as it's asked (keepAim). */
test('the lit subtask ticked: the box stays under it while it waits for the batch, saved or not; gone, its task has it', async t => {
  const { v, app, chairs, aimed } = underBox(t);
  app.aim(chairs);
  assert.deepEqual(aimed(), [['8'], 'Chairs']);
  v.trouble = r => r.method === 'PATCH' ? 'offline' : null;
  let ticking = app.toggleDone(chairs, {});
  assert.deepEqual([chairs.done, app.leaving, app.capW], [true, { 8: 'done' }, 'under'], 'held done, the save not answered: the box is under it still');
  app.keepAim();
  assert.deepEqual(aimed(), [['8'], 'Chairs']);
  await ticking;
  assert.deepEqual([!!chairs.done, app.leaving, app.toast.msg], [false, {}, 'Not saved: no connection'], 'let go of, open again, and its row says why');
  app.keepAim();
  assert.deepEqual(aimed(), [['8'], 'Chairs'], 'and the box where it was');
  v.trouble = () => null;
  ticking = app.toggleDone(chairs, {});
  await ticking;
  app.keepAim();
  assert.deepEqual([aimed(), app.leaving, v.task(8).done], [[['8'], 'Chairs'], { 8: 'done' }, true], 'saved and marked: under it until the batch clears');
  delete app.leaving[8];
  app.keepAim();
  assert.deepEqual(aimed(), [['9'], ''], 'gone with the batch: its task has the box');
});

/* A tick never moves the box (tickRow, views.js): only a nudge does, or Add a subtask here (inline-add-box-plan). */
test('a tick never moves the box: another row ticked, and ticked back, leaves it under the row it was', async t => {
  const { v, app, chairs, add, aimed } = underBox(t), g = { depth: {} };
  app.tickRow = views.tickRow;
  // What's on its way has gone and come back: the save, the mark taken back, and the save of that.
  const quiet = async () => { for (let k = 0; k < 20; k++) { const n = v.requests.length; for (let i = 0; i < 20; i++) await new Promise(ok => setImmediate(ok)); if (v.requests.length === n) return; } };
  await add('Rope');
  assert.deepEqual(aimed(), [['101'], 'Rope']);
  app.tickRow(chairs, g, {});
  assert.deepEqual([aimed(), app.leaving], [[['101'], 'Rope'], { 8: 'done' }], 'Chairs ticked: held done, the box under Rope still');
  app.tickRow(chairs, g, {});
  await quiet();
  assert.deepEqual([aimed(), !!chairs.done, !!v.task(8).done, app.leaving], [[['101'], 'Rope'], false, false, {}], 'and taken back: the same');
});

test('a run\'s box leaves a ticked line out, with nothing to tap, and an x is a word there', () => {
  const app = boxes();
  app.runInsert.text = 'x Wipe the counter\n[x] Mop\nLock up';
  assert.deepEqual(app.chips('ins').map(c => [c.text, c.kind]), [['1 line is already ticked, so it is left out', undefined], ['2 steps', undefined]]);
  assert.deepEqual(linesOf(app, 'ins'), [['x Wipe the counter', false], ['Lock up', false]]);
});

/* A list's box (footBox, app/sheet.js): at the foot it says what it takes; under a row, what one line makes, and the
   place it left at the foot says what the box says there, for a task's subtasks, a template's steps and a checklist's. */
test('a list\'s box under a row says what a line makes, and its place at the foot says what the box says there', () => {
  const box = (of, where = 'sheet') => { const b = sheetPart.footBox.call({ subBoxCan: false, boxParsedLines: () => [], ...of }, where); return [b.under, b.says, b.rest]; };
  assert.deepEqual(box({ subBoxW: 'sub', isStepList: false, sheet: { subAt: null } }), [false, 'Add subtasks, or paste a list', 'Add subtasks, or paste a list']);
  assert.deepEqual(box({ subBoxW: 'sub', isStepList: false, sheet: { subAt: 8 } }), [true, 'Subtask', 'Add subtasks, or paste a list']);
  assert.deepEqual(box({ subBoxW: 'add:+', isStepList: true, sheet: { subAt: 8 } }), [true, 'Step', 'Add steps, or paste a list']);
  const on = { title: 'Mop the floor', pending: false };
  assert.deepEqual(box({ runAim: { on }, runBoxAt: null }, 'run'), [false, 'Add steps, or paste a list', 'Add steps, or paste a list']);
  assert.deepEqual(box({ runAim: { on }, runBoxAt: 52 }, 'run'), [true, 'Step', 'Add steps, or paste a list']);
});

/* The sheet's own box under a subtask (nudgedSub, app/sheet.js; inline-add-box-plan, part 3): where its lines go. */
test('the sheet\'s box under a subtask: the next go after it, each after the one before while they wait; at the foot, after the last', t => {
  const { app, chairs } = underBox(t);
  const straps = app.keep({ id: 7, title: 'Straps', project_id: 5 });
  Object.defineProperty(app, 'subtasks', { value: [chairs, straps], configurable: true });
  app.positions = { 8: 100, 7: 200 };
  app.sheet = { subView: 3, subAt: null, subAfter: null };
  assert.deepEqual(app.subPlaces(1), [200 + 65536], 'at the foot: after the last');
  app.sheet.subAt = 8;
  assert.deepEqual(app.subPlaces(2), [150, 175], 'under Chairs: after it, before Straps');
  assert.deepEqual(app.subPlaces(1), [187.5], 'the next, the first two still on their way: after them');
  app.sheet = { subView: null, subAt: 8, subAfter: null };
  assert.equal(app.subPlaces(1), null, 'their order not read yet: no place to give');
});
