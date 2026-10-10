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
import { newBox } from '../../src/js/app/core.js';
import { todayGroups } from '../../src/js/lists.js';
import { sync } from '../../src/js/sync.js';

const DAY = 86400;
const pick = (part, ...names) => Object.fromEntries(names.map(n => [n, part[n]]));
// The component on Today, with the parts that send an entry and put what it made on the screen. The batch's timer is
// the test's, so it doesn't clear by itself.
const adding = t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const app = component(tasks, actions, leaving, pick(sending, 'createTask', 'linkSubtask', 'sendEntry', 'placeSent', 'pendingPlace', 'arrivedDone', 'findSent', 'refreshPending', 'markSlow', 'cancelPending', 'pendingNested'));
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
  await app.cancelPending(e.id, 1);
  assert.deepEqual(sync.all(1)[0].items.map(x => [x.raw, x.under]), [['Pack the van', null], ['Stack them', 0], ['Tables', 0]]);
  assert.equal(app.toast.msg, 'Cancelled. It\'s back in the box. The 1 line under it is now under “Pack the van”.');
  assert.equal(app.cap.text, 'Load chairs');
  assert.equal(app.pendingNested(e.id), true, 'lines still wait under the first');
  await app.cancelPending(e.id, 0);
  assert.deepEqual(sync.all(1)[0].items.map(x => [x.raw, x.under]), [['Stack them', null], ['Tables', null]]);
  assert.equal(app.toast.msg, 'Cancelled. It\'s back in the box. The 2 lines under it are now tasks of their own.');
  assert.equal(app.pendingNested(e.id), false);
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
  // With quick add turned off in Vikunja, it's read all the same: it's about the list, not Vikunja's shortcuts.
  app.user.settings.frontend_settings.quick_add_magic_mode = 'disabled';
  app.cap.text = '- [x] Call Sam tomorrow (50%)';
  assert.deepEqual(marksOf(app, 'cap'), ['done:[x]', 'progress:(50%)']);
  assert.deepEqual(app.boxParsedLines('cap').map(p => [p.title, p.done, p.pct]), [['Call Sam tomorrow', true, 50]]);
});

test('a list with lines that say they\'re done: one chip counts them; tapped, they\'re left out, and tapped again they\'re back', () => {
  const app = boxes();
  app.cap.text = 'Groceries\n- [x] Eggs\n- [ ] Milk tomorrow\nx Bread';
  assert.deepEqual(chipsOf(app, 'cap'), ['2 arrive done', '4 tasks', 'Café']);
  assert.deepEqual(marksOf(app, 'cap'), ['done:[x]', 'due:tomorrow', 'done:x']);
  assert.deepEqual(linesOf(app, 'cap'), [['Groceries', false], ['Eggs', true], ['Milk', false], ['Bread', true]]);
  tap(app, 'cap', 'arrive done');
  assert.deepEqual(chipsOf(app, 'cap'), ['2 ticked off already: left out', '2 tasks', 'Café']);
  assert.deepEqual(marksOf(app, 'cap'), ['due:tomorrow']);
  assert.deepEqual(linesOf(app, 'cap'), [['Groceries', false], ['Milk', false]]);
  tap(app, 'cap', 'left out');
  assert.deepEqual(chipsOf(app, 'cap'), ['2 arrive done', '4 tasks', 'Café']);
  // A subtask box reads them the same way.
  app.sheet.sub.text = '[x] Load chairs\nTables';
  assert.deepEqual(chipsOf(app, 'sub'), ['1 arrives done', '2 subtasks']);
  assert.deepEqual(linesOf(app, 'sub'), [['Load chairs', true], ['Tables', false]]);
});

const under = (app, w) => app.boxParsedLines(w).map(p => p.under);
test('a pasted list with headings: each a task over its lines, the chip counting them; ↳ Under first line shows on, and tapped off makes them all tasks', () => {
  const app = boxes();
  app.cap.text = '## Pack the van (38%)\n- Load chairs\n- [x] Tables\n## Set the hall\n- Lights (50%)';
  assert.deepEqual(chipsOf(app, 'cap'), ['1 arrives done', '2 tasks + 3 subtasks', 'Café']);
  assert.deepEqual(under(app, 'cap'), [null, 0, 0, null, 3]);
  assert.deepEqual(app.boxParsedLines('cap').map(p => [p.title, p.pct]), [['Pack the van', 0], ['Load chairs', 0], ['Tables', 0], ['Set the hall', 0], ['Lights', 50]], 'a parent\'s figure is dropped');
  assert.equal(app.nestOn, true, 'the first line is a parent as the list is written');
  app.tapNest();
  assert.deepEqual([app.nestOn, under(app, 'cap')], [false, [null, null, null, null, null]]);
  assert.deepEqual(chipsOf(app, 'cap'), ['1 arrives done', '5 tasks', 'Café']);
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
  assert.deepEqual(chipsOf(app, 'sub'), ['1 arrives done', '4 subtasks']);
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

test('a first line ending with a colon is the parent of the rest in quick add, its colon taken off; ↳ Under first line tapped off keeps it', () => {
  const app = boxes();
  app.cap.text = 'Groceries:\nmilk\n- [x] eggs';
  assert.deepEqual([chipsOf(app, 'cap'), app.nestOn], [['1 arrives done', '1 task + 2 subtasks', 'Café'], true]);
  assert.deepEqual(app.boxItems('cap').map(x => [x.p.title, x.under]), [['Groceries', null], ['milk', 0], ['eggs', 0]]);
  app.tapNest();
  assert.deepEqual([chipsOf(app, 'cap'), app.nestOn], [['1 arrives done', '3 tasks', 'Café'], false]);
  assert.deepEqual(app.boxItems('cap').map(x => [x.p.title, x.under]), [['Groceries:', null], ['milk', null], ['eggs', null]]);
  // A subtask box has no ↳ Under first line to tap it off with: the colon is a title's there.
  app.sheet.sub.text = 'Groceries:\nmilk';
  assert.deepEqual(app.boxItems('sub').map(x => [x.p.title, x.under]), [['Groceries:', null], ['milk', null]]);
});

/* Subtasks from the add box on a project's list (addSubtasks, actions.js): the next go after the last that's the
   task's own subtask, not after one under it. */
test('subtasks added from the add box with lines under them: the box\'s next go after the last of the task\'s own', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const v = fakeVikunja([{ id: 9, title: 'Pack the van', project_id: 5, related_tasks: {} }]);
  const app = component(tasks, actions, leaving, quickadd, pick(sending, 'createTask', 'linkSubtask', 'sendEntry', 'placeSent', 'pendingPlace', 'arrivedDone', 'findSent', 'refreshPending', 'markSlow'));
  const van = app.keep(v.task(9));
  Object.assign(app, { user: { id: 1, settings: { frontend_settings: {} } }, pending: [], failed: [], deleting: [], slow: [], positions: {}, projects: [], labels: [], people: [], access: {}, userKnown: {},
    accessBlocked: false, checklistIds: new Set(), remindersReach: false, canWrite: () => true, cap: { ...newBox(), text: 'Chairs\n  Stack them\nTables\n  Fold the legs' }, capPhotos: [],
    route: { name: 'project', id: 5 }, view: { groups: [{ key: 'open', tasks: [van] }], route: '', listView: 3 }, cursor: { id: 9, after: null }, flash(){}, $nextTick(){} });
  await app.addSubtasks('under');
  assert.deepEqual(app.cursor.after.title, 'Tables');
  assert.deepEqual(v.requests.filter(r => r.path.endsWith('/relations')).map(r => [+r.path.split('/')[2], r.body.other_task_id]), [[9, 101], [101, 102], [9, 103], [103, 104]]);
  const pos = id => v.task(id).position;
  assert.equal(app.cursor.after.pos, pos(103), 'at its place in the list, which the next go after');
  assert.ok(pos(101) < pos(102) && pos(102) < pos(103) && pos(103) < pos(104), 'each after the one before');
});

test('a run\'s box leaves a ticked line out, with nothing to tap, and an x is a word there', () => {
  const app = boxes();
  app.runInsert.text = 'x Wipe the counter\n[x] Mop\nLock up';
  assert.deepEqual(app.chips('ins').map(c => [c.text, c.kind]), [['1 line ticked off already: left out', undefined], ['2 steps', undefined]]);
  assert.deepEqual(linesOf(app, 'ins'), [['x Wipe the counter', false], ['Lock up', false]]);
});
