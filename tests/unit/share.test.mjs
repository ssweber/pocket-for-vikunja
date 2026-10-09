// Progress as a text and as a Markdown list (src/js/share.js), with the clock at Wednesday 7 October 2026, 14:20.
import './browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bar, dueWords, firstName, markdownText, progress, shareText } from '../../src/js/share.js';
import { component } from './fake.mjs';
import sharing from '../../src/js/app/sharing.js';
import cards from '../../src/js/app/cards.js';
import runs from '../../src/js/app/runs.js';
import claims from '../../src/js/app/claims.js';
import checklists from '../../src/js/app/checklists.js';
import views from '../../src/js/app/views.js';

const NOW = new Date(2026, 9, 7, 14, 20);
const on = (d, h = 0) => new Date(2026, 9, d, h).toISOString();
const day = d => new Date(2026, 9, d).toLocaleDateString([], { weekday: 'short' });
const date = d => new Date(2026, 9, d).toLocaleDateString([], { month: 'short', day: 'numeric' });
const priya = { username: 'priya', name: 'Priya Shah' }, sam = { username: 'sam', name: '' }, jo = { username: 'jo', name: 'Jo' };
const item = (title, more = {}) => ({ title, done: false, pct: 0, items: [], ...more });
const text = doc => shareText(doc, NOW), md = doc => markdownText(doc, NOW);
// The van, as agreed: its own 60%, a subtask done, one half way, one Priya's on, one not begun.
const van = { kind: 'task', ...item('Pack the van', { pct: 60 }), items: [
  item('Load chairs', { done: true }), item('Tables', { pct: 50 }), item('Sound system', { people: [priya] }), item('Lights')] };

test('the bar: five segments, one once begun, the fifth only when all done', () => {
  assert.equal(bar(0), '▱▱▱▱▱');
  assert.equal(bar(3), '▰▱▱▱▱');
  assert.equal(bar(50), '▰▰▰▱▱');
  assert.equal(bar(60), '▰▰▰▱▱');
  assert.equal(bar(99), '▰▰▰▰▱');
  assert.equal(bar(100), '▰▰▰▰▰');
});

test('a person by the first word of their name, else their username', () => {
  assert.equal(firstName(priya), 'Priya');
  assert.equal(firstName(sam), 'sam');
  assert.equal(firstName({ username: 'al', name: '  Alex  Kim ' }), 'Alex');
  assert.equal(firstName(null), '');
});

test('a task as a text, as agreed', () => {
  assert.equal(text(van), ['Pack the van  ▰▰▰▱▱ 60%', '✓ Load chairs', '◐ Tables 50%', '○ Sound system · Priya', '○ Lights'].join('\n'));
});

test('progress: its own, else its subtasks done of all of them, else none', () => {
  assert.deepEqual(progress(item('a', { pct: 40, items: [item('b', { done: true })] })), { pct: 40, words: '40%' }, 'its own comes first');
  const parent = item('Pack the van', { items: [item('a', { done: true }), item('b'), item('c'), item('d')] });
  assert.deepEqual(progress(parent), { pct: 25, words: '1 of 4 done' });
  assert.equal(text({ kind: 'task', ...parent }).split('\n')[0], 'Pack the van  ▰▱▱▱▱ 1 of 4 done');
  assert.deepEqual(progress(item('x', { done: true })), { pct: 100, words: 'done' });
  assert.deepEqual(progress(item('x', { done: true, pct: 40 })), { pct: 100, words: 'done' }, 'done is all of it, whatever was set');
  assert.equal(text({ kind: 'task', ...item('Order milk') }), 'Order milk', 'nothing to show: no bar');
  // A project's task, with only its open subtasks under it, counts all of them.
  assert.deepEqual(progress(item('x', { items: [item('a')], subs: { done: 3, total: 4 } })), { pct: 75, words: '3 of 4 done' });
});

test('subtasks of a subtask, two spaces further in at each level', () => {
  const doc = { kind: 'task', ...item('Event'), items: [
    item('Stage', { items: [item('Lights', { done: true }), item('Cables', { items: [item('Long one', { pct: 25 })] })] }), item('Food')] };
  assert.equal(text(doc), ['Event  ▱▱▱▱▱ 0 of 2 done', '◐ Stage (1 of 2 done)', '  ✓ Lights', '  ○ Cables (0 of 1 done)', '    ◐ Long one 25%', '○ Food'].join('\n'));
  assert.equal(md(doc), ['## Event (0 of 2 done)', '', '- [ ] Stage (1 of 2 done)', '  - [x] Lights', '  - [ ] Cables (0 of 1 done)', '    - [ ] Long one (25%)', '- [ ] Food'].join('\n'));
});

test('who\'s on it: several by their names, each once; due dates in a few words', () => {
  const doc = { kind: 'task', ...item('Opening', { due: on(9, 17), people: [priya, sam] }), items: [
    item('Chairs', { people: [priya, sam, { username: 'priya2', name: 'Priya' }] }), item('Float', { due: on(7, 18) }), item('Keys', { due: on(8) }),
    item('Sign', { due: on(20) }), item('Bins', { due: on(5) }), item('Mop', { due: on(6), done: true })] };
  assert.equal(text(doc), [`Opening  ▰▱▱▱▱ 1 of 6 done · due ${day(9)} · Priya, sam`, '○ Chairs · Priya, sam', '○ Float · due today', '○ Keys · due tomorrow',
    `○ Sign · due ${date(20)}`, `○ Bins · overdue since ${day(5)}`, '✓ Mop'].join('\n'));
  assert.equal(dueWords(on(6), NOW), 'overdue since yesterday');
  assert.equal(dueWords('0001-01-01T00:00:00Z', NOW), '');
  assert.match(dueWords(new Date(2027, 0, 5).toISOString(), NOW), /2027/, 'another year says which');
});

test('a long list collapses what\'s done into one line, where the first of them was', () => {
  const done = n => Array.from({ length: n }, (_, i) => item('Done ' + (i + 1), { done: true }));
  const open = n => Array.from({ length: n }, (_, i) => item('Open ' + (i + 1)));
  const long = { kind: 'task', ...item('Inventory'), items: [item('First'), ...done(7), ...open(4)] };
  assert.equal(text(long), ['Inventory  ▰▰▰▱▱ 7 of 12 done', '○ First', '✓ 7 done', ...open(4).map(o => '○ ' + o.title)].join('\n'));
  // 5 done is few enough to list, and 10 lines short enough.
  assert.equal(text({ kind: 'task', ...item('A'), items: [...done(5), ...open(7)] }).split('\n').length, 13);
  assert.equal(text({ kind: 'task', ...item('B'), items: [...done(6), ...open(4)] }).split('\n').length, 11);
  // A Markdown list is a copy to keep: nothing collapsed.
  assert.equal(md(long).split('\n').filter(l => l.startsWith('- [x]')).length, 7);
});

test('a run: who did each step, who skipped one, who\'s on the rest', () => {
  const run = { kind: 'run', ...item('Startup · Oct 7'), items: [
    item('Check the guards', { done: true, by: [priya] }), item('Warm up the press', { done: true, skipped: true, by: [sam] }),
    item('First article check', { pct: 50, people: [jo] }), item('Sweep up', { people: [priya, jo] })] };
  assert.equal(text(run), ['Startup · Oct 7  ▰▰▰▱▱ 1 of 4 done · 1 skipped', '✓ Check the guards · Priya', '– Warm up the press · skipped by sam',
    '◐ First article check 50% · Jo', '○ Sweep up · Priya, Jo'].join('\n'));
  assert.equal(md(run), ['## Startup · Oct 7 (1 of 4 done · 1 skipped)', '', '- [x] Check the guards @priya', '- [x] ~~Warm up the press~~ (skipped by @sam)',
    '- [ ] First article check (50%) @jo', '- [ ] Sweep up @priya @jo'].join('\n'));
  // Collapsed, it still says who did them.
  const many = { kind: 'run', ...item('Close · Oct 7'), items: [...['a', 'b', 'c', 'd', 'e', 'f'].map((t, i) => item(t, { done: true, by: [i % 2 ? sam : priya] })),
    item('g', { done: true, skipped: true, by: [jo] }), ...['h', 'i', 'j', 'k'].map(t => item(t))] };
  assert.deepEqual(text(many).split('\n').slice(0, 2), ['Close · Oct 7  ▰▰▰▱▱ 6 of 11 done · 1 skipped', '✓ 6 done, 1 skipped · Priya, sam, Jo']);
});

test('a project: its counts, its open tasks with a bar where there\'s progress, subtasks under them, what\'s done counted', () => {
  const doc = { kind: 'project', title: 'Café', open: 6, doneCount: 5, items: [
    item('Order milk', { due: on(9) }),
    { ...item('Pack the van', { pct: 60, people: [priya] }), items: [item('Tables', { pct: 50 }), item('Sound system', { people: [sam] })], subs: { done: 1, total: 3 } },
    { ...item('Deep clean'), items: [item('Fridge')], subs: { done: 2, total: 3 } },
    { ...item('Old menu', { done: true }), items: [item('Reprint')], subs: { done: 0, total: 1 } }] };
  assert.equal(text(doc), ['Café  6 open · 5 done', `○ Order milk · due ${day(9)}`, '◐ Pack the van  ▰▰▰▱▱ 60% · Priya', '  ◐ Tables 50%', '  ○ Sound system · sam',
    '◐ Deep clean  ▰▰▰▱▱ 2 of 3 done', '  ○ Fridge', '✓ Old menu', '  ○ Reprint', '✓ 5 done'].join('\n'));
  assert.equal(md(doc), ['# Café', '', '6 open · 5 done', '', `- [ ] Order milk (due ${day(9)})`, '- [ ] Pack the van (60%) @priya', '  - [ ] Tables (50%)',
    '  - [ ] Sound system @sam', '- [ ] Deep clean (2 of 3 done)', '  - [ ] Fridge', '- [x] Old menu', '  - [ ] Reprint'].join('\n'));
  assert.equal(text({ kind: 'project', title: 'Empty', open: 0, doneCount: 0, items: [] }), 'Empty  0 open');
});

test('the van as a Markdown list', () => {
  assert.equal(md(van), ['## Pack the van (60%)', '', '- [x] Load chairs', '- [ ] Tables (50%)', '- [ ] Sound system @priya', '- [ ] Lights'].join('\n'));
  assert.equal(md({ ...van, due: on(9), people: [priya] }).split('\n').slice(0, 2).join('\n'), `## Pack the van (60%)\nDue ${day(9)} · @priya`);
});

/* A parent's progress is the figure its ring shows (parent-tasks-plan, part 5): the average of its subtasks' progress, a
   done one 100%, with a bar of one segment per subtask, filled for each done. */
test('a parent: its ring\'s worked-out figure, and a bar of a segment per subtask, filled for each done', () => {
  const doc = { kind: 'task', ...item('A test task', { due: on(7, 18), people: [sam], ring: { pct: 13, done: 0, total: 4 } }), items: [
    item('One subtask', { pct: 50, due: on(7, 18), people: [sam] }), item('Another'), item('And another'), item('And another')] };
  assert.equal(text(doc), ['A test task  ▱▱▱▱ 13% · due today · sam', '◐ One subtask 50% · due today · sam', '○ Another', '○ And another', '○ And another'].join('\n'));
  assert.equal(md(doc).split('\n')[0], '## A test task (13%)');
  assert.equal(bar(60, { pct: 60, done: 2, total: 3 }), '▰▰▱');
  assert.deepEqual(progress(item('x', { pct: 40, ring: { pct: 70, done: 1, total: 2 } })).pct, 70, 'the ring\'s, not a figure of its own');
  // A run: its skipped steps are done in its ring, and said apart.
  const run = { kind: 'run', ...item('Close'), ring: { pct: 67, done: 2, total: 3 }, items: [item('a', { done: true }), item('b', { done: true, skipped: true }), item('c')] };
  assert.equal(text(run).split('\n')[0], 'Close  ▰▰▱ 67% · 1 skipped');
  // A project's parent: its ring, on its line's bar.
  const project = { kind: 'project', title: 'Café', open: 1, doneCount: 0, items: [{ ...item('Deep clean'), items: [item('Fridge', { pct: 50 })], subs: { done: 2, total: 3 }, ring: { pct: 83, done: 2, total: 3 } }] };
  assert.equal(text(project).split('\n')[1], '◐ Deep clean  ▰▰▱ 83%');
});

// The text shared from a task's sheet, and from a run's screen, against the ring the same task has on screen.
const NONE = '0001-01-01T00:00:00Z';
const shared = () => {
  const app = component(sharing, cards, runs, claims, checklists, views);
  Object.assign(app, { user: { id: 1 }, pending: [], slow: [], perms: {}, positions: {}, projects: [], checklistIds: new Set(), hiddenRows: new Set(), pendingTasks: [], clock: Date.now(), actTask: a => a.task });
  return app;
};
test('the text shared from a task\'s sheet matches its ring: the percent and a segment per subtask, each done filled', () => {
  const app = shared();
  const sub = (id, f = {}) => ({ id, title: 'Sub ' + id, done: false, percent_done: 0, due_date: NONE, project_id: 5, assignees: [], related_tasks: {}, ...f });
  const subs = [sub(2, { percent_done: .5 }), sub(3), sub(4, { done: true }), sub(5, { percent_done: .25 })];
  const t = { id: 1, title: 'Paint the back wall', done: false, percent_done: 0, due_date: NONE, project_id: 5, assignees: [], related_tasks: { subtask: subs } };
  for (const x of [t, ...subs]) app.tasks[x.id] = x;
  Object.assign(app, { sheet: { task: t, subPeople: {} }, subtasks: subs, pendingSubtasks: [] });
  const ring = app.ringOf(t), head = shareText(app.shareDoc('task'), NOW).split('\n')[0];
  assert.deepEqual([ring.pct, ring.done, ring.total], [44, 1, 4], '(50 + 0 + 100 + 25) / 4');
  assert.equal(head, `Paint the back wall  ${'▰'.repeat(ring.done)}${'▱'.repeat(ring.total - ring.done)} ${ring.pct}%`);
  assert.equal(markdownText(app.shareDoc('task'), NOW).split('\n')[0], `## Paint the back wall (${ring.pct}%)`);
  // A subtask with subtasks of its own: its ring's figure on its line.
  subs[1].related_tasks = { subtask: [sub(6, { done: true }), sub(7)] }; app.tasks[6] = sub(6, { done: true }); app.tasks[7] = sub(7);
  assert.equal(shareText(app.shareDoc('task'), NOW).split('\n')[2], `◐ Sub 3 ${app.ringOf(subs[1]).pct}%`);
});

test('the text shared from a run\'s screen matches its ring, a tick waiting to be sent counted as its ring counts it', () => {
  const app = shared(), now = Date.now();
  const step = (id, title, f = {}) => ({ id, title, done: false, done_at: NONE, due_date: NONE, updated: new Date(now - 36e5).toISOString(), percent_done: 0, description: '',
    project_id: 5, assignees: [], attachments: [], reactions: {}, comments: [], related_tasks: {}, ...f });
  const steps = [step(51, 'Mop', { done: true, done_at: new Date(now - 6e4).toISOString(), reactions: { '✅': [{ id: 1 }] } }), step(52, 'Wipe', { percent_done: .5 }), step(53, 'Lock up'), step(54, 'Lights')];
  const run = { id: 50, title: 'Closing up', done: false, project_id: 5, assignees: [], created_by: { id: 1 }, comments: [], description: '', related_tasks: { subtask: steps } };
  app.isRunTask = t => t.id === 50;
  for (const x of [run, ...steps]) app.tasks[x.id] = x;
  app.view = { groups: [], run: { run: { id: 50, title: 'Closing up', done: false, project_id: 5, assignees: [], created_by: { id: 1 }, comments: [] }, steps, at: null, last: null } };
  app.pending = [{ kind: 'act', id: 9, run: 50, task: 53, op: 'done', at: new Date().toISOString() }];   // Lock up ticked, not sent yet
  const ring = app.ringOf(run), head = shareText(app.shareDoc('run'), NOW).split('\n')[0];
  assert.deepEqual([ring.pct, ring.done, ring.total], [63, 2, 4], '(100 + 50 + 100 + 0) / 4');
  assert.equal(head, `Closing up  ▰▰▱▱ ${ring.pct}%`);
});
