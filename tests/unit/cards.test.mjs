// Today's cards (src/js/cards.js, and app/cards.js on a pretend component): which tasks are cards and what brought each,
// where each sits on Today, which step a card shows, and its count; where a run goes next, the one rule its card and its
// screen go by, and the bottom box aimed at its step.
import { component } from './fake.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardAt, cardGroup, countdown, todayItems } from '../../src/js/cards.js';
import { dueInfo } from '../../src/js/dates.js';
import { rowGestures } from '../../src/js/lists.js';
import cards from '../../src/js/app/cards.js';
import views from '../../src/js/app/views.js';
import alerts from '../../src/js/app/alerts.js';
import tasks from '../../src/js/app/tasks.js';
import leaving from '../../src/js/app/leaving.js';
import progress from '../../src/js/app/progress.js';
import runs from '../../src/js/app/runs.js';
import claims from '../../src/js/app/claims.js';
import checklists from '../../src/js/app/checklists.js';
import { whereNext } from '../../src/js/checklists.js';

const NONE = '0001-01-01T00:00:00Z', me = { id: 1 }, other = { id: 2 };
const at = (d, h) => `2026-10-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00Z`;
const under = (id, project = 5) => ({ parenttask: [{ id, project_id: project }] });
const task = (id, f = {}) => ({ id, title: 'Task ' + id, done: false, due_date: NONE, project_id: 5, created_by: me, assignees: [], related_tasks: {}, ...f });
const subs = (...list) => ({ subtask: list.map(([id, done = false]) => ({ id, done })) });
const ids = list => list.map(r => r.t.id);

test('a task due is a row; with open subtasks it is a card, dated by itself', () => {
  const { rows, cards } = todayItems({ tasks: [task(1, { due_date: at(8, 9) }), task(2, { due_date: at(8, 10), related_tasks: subs([3], [4, true]) }),
    task(5, { due_date: at(8, 11), related_tasks: subs([6, true]) })] }, me);
  assert.deepEqual(ids(rows), [1, 5], 'a task whose subtasks are all done is a row');
  assert.deepEqual([...cards.keys()], [2]);
  assert.equal(cards.get(2).when, at(8, 10));
  assert.equal(cardGroup(cards.get(2), false), 'dated');
});

test('a subtask due brings its task’s card, whoever’s it is, and opens it there only if it’s yours', () => {
  const { rows, cards } = todayItems({ tasks: [task(3, { due_date: at(8, 9), related_tasks: under(2) }), task(4, { due_date: at(9, 9), assignees: [me], related_tasks: under(7) })] }, me);
  assert.deepEqual(rows, [], 'subtasks are never rows of their own on Today');
  assert.deepEqual({ ...cards.get(2), from: undefined }, { when: at(8, 9), made: null, focus: null, project: 5, from: undefined });
  assert.equal(cards.get(7).focus, 4, 'yours: the card opens on it');
  assert.deepEqual(cards.get(2).from.map(t => t.id), [3], 'what brought it, to show as a row should its task not be readable');
});

test('a card sits by the earliest date that brought it: its own, or one of its subtasks’', () => {
  const { cards } = todayItems({ tasks: [task(2, { due_date: at(12, 9), related_tasks: subs([3], [4]) }), task(3, { due_date: at(9, 9), related_tasks: under(2) }),
    task(4, { due_date: at(10, 9), assignees: [me], related_tasks: under(2) })] }, me);
  assert.equal(cards.get(2).when, at(9, 9));
  assert.equal(cards.get(2).focus, 4);
});

test('undated, made today: a subtask of yours brings its task’s card, opened on it; someone else’s doesn’t', () => {
  const { rows, cards } = todayItems({ added: [
    task(3, { assignees: [me], created: at(8, 9), related_tasks: under(2) }), task(4, { assignees: [other], created: at(8, 10), related_tasks: under(6) }),
    task(5, { created_by: me, created: at(8, 8) }), task(8, { created_by: other, created: at(8, 8) }),
    task(9, { created_by: me, created: at(8, 7), related_tasks: subs([10]) }), task(11, { due_date: at(8, 20), created_by: me }),
  ] }, me);
  assert.deepEqual([...cards.keys()], [2, 9]);
  assert.deepEqual([cards.get(2).focus, cards.get(2).made, cards.get(2).when], [3, at(8, 9), null]);
  assert.equal(cardGroup(cards.get(2), false), 'nodate', 'under “Added today, no date”');
  assert.deepEqual(rows.map(r => [r.t.id, r.key]), [[5, 'nodate']], 'yours, with no date; someone else’s, and one with a date, aren’t');
});

test('runs: yours in progress is a card under Checklist runs, one with no open step a row there; a step you’re on in someone else’s brings theirs', () => {
  const run = task(20, { related_tasks: subs([21, true], [22]) }), done = task(30, { related_tasks: subs([31, true]) });
  const { rows, cards } = todayItems({ mine: [run, done], claimed: [task(41, { assignees: [me], related_tasks: under(40, 9) })] }, me, t => [20, 30, 40].includes(t.id));
  assert.deepEqual(rows.map(r => [r.t.id, r.key]), [[30, 'runs']]);
  assert.equal(cardGroup(cards.get(20), true), 'runs');
  assert.equal(cards.get(40).focus, 41);
  assert.equal(cards.get(40).project, 9);
});

test('a template that comes round is a row: its steps are done, and it’s started from there', () => {
  const tpl = task(50, { due_date: at(8, 9), labels: [{ title: 'template' }], related_tasks: subs([51, true], [52, true]) });
  assert.deepEqual(ids(todayItems({ tasks: [tpl] }, me).rows), [50]);
});

test('which step a card shows: the one it was left on, or the next once that has gone', () => {
  const steps = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.equal(cardAt(steps, null, null), 0, 'the next step in order');
  assert.equal(cardAt(steps, null, 3), 2, 'the subtask of yours that brought it');
  assert.equal(cardAt(steps, null, 9), 0, 'that one gone: the next in order');
  assert.equal(cardAt(steps, { id: 2, i: 1 }, 3), 1, 'left on it by a tick or a slide');
  assert.equal(cardAt([{ id: 1 }, { id: 3 }], { id: 2, i: 1 }, null), 1, 'that step gone: the one after it, in its place');
  assert.equal(cardAt([{ id: 1 }, { id: 2 }], { id: 3, i: 2 }, null), 0, 'the last gone: round to the first');
  assert.equal(cardAt([], null, null), -1);
});

test('a run’s step’s countdown, to the minute, within a day', () => {
  const now = Date.parse(at(8, 9));
  assert.deepEqual(countdown(now + 65 * 6e4 + 1000, now), { text: 'in 1h 6m', late: false });
  assert.deepEqual(countdown(now - 12.5 * 6e4, now), { text: '12m late', late: true });
  assert.deepEqual(countdown(now + 1000, now), { text: 'in 1m', late: false }, 'never “in 0s”');
  assert.equal(countdown(now + 864e5 * 2, now), null, 'further off: its date says it');
});

// The component, with Today's cards: `parent` with its subtasks in the store, at their positions in its List view: 14,
// done, first, then Chairs, Tables and Lights.
const today = () => {
  const app = component(cards, views, alerts, tasks, leaving);
  Object.assign(app, { cardPage: {}, positions: { 11: 3, 12: 1, 13: 2, 14: 0.5 }, projById: new Map([[5, { id: 5, title: 'Café', hex_color: '' }]]), stepDone: (id, d) => d, checklistIds: new Set(), waitingByTask: new Map() });
  const parent = app.keep(task(10, { title: 'Pack the van', related_tasks: subs([11], [12], [13], [14, true]) }));
  for (const [id, title] of [[11, 'Lights'], [12, 'Chairs'], [13, 'Tables']]) app.keep(task(id, { title, related_tasks: under(10) }));
  app.view.cards = { 10: { when: null, made: null, focus: null } };
  return { app, parent, g: { cards: true } };
};

test('a card: its open steps in its List view’s order, the first showing, and its count', () => {
  const { app, parent, g } = today(), c = app.cardOf(parent, g);
  assert.deepEqual(c.steps.map(s => s.title), ['Chairs', 'Tables', 'Lights']);
  assert.deepEqual([c.step.title, c.i, c.n], ['Chairs', 0, 3]);
  assert.deepEqual(app.cardCount(c), { text: '1/4', said: '1 of 4 subtasks done' }, 'its count, at the right of its heading: the done one counted');
  assert.deepEqual([c.g.card, c.g.line], [c, true], 'the step line knows its card, and is on one line');
  assert.equal(app.cardOf(parent, { depth: {} }), null, 'only on Today’s lists');
  assert.deepEqual(app.rowMeta(c.step, c.g).map(m => m.text), [], 'not which step it is, nor the project: those are on the card');
});

test('a card’s heading: its priority’s bars as its row shows them, only when it has one; said, its due date, its priority and its project', () => {
  const { app, parent } = today();
  assert.deepEqual([app.cardHead(parent).title, app.cardHead(parent).prio, app.cardHead(parent).due, app.cardHead(parent).said], ['Pack the van', 0, null, 'Café'], 'no priority, no bars; no date, nothing at the right');
  const urgent = { ...parent, priority: 4, due_date: at(8, 10) }, row = app.rowMeta(urgent, { depth: {} }).find(m => m.key === 'prio'), h = app.cardHead(urgent);
  assert.equal(h.prio, 4);
  assert.equal(row.label, 'Priority: Urgent');
  const when = dueInfo(urgent.due_date);
  assert.equal(h.said, `${when.cls === 'overdue' ? 'Late: ' : 'Due '}${when.label}, ${row.label}, Café`, 'when, in words, its priority as its row says it, and its project');
  Object.assign(app, { isRunTask: t => t.id === 10, forText: t => t.assignees.length ? 'For you' : '' });
  assert.equal(app.cardHead(urgent).said.split(', ').pop(), 'Checklist run', 'a run’s for no one: what it is, instead of its project');
  assert.equal(app.cardHead({ ...urgent, assignees: [me] }).said.split(', ').pop(), 'For you', 'or who it’s for');
});

test('ticked, a step stays until the batch clears, then the next comes in', () => {
  const { app, parent, g } = today();
  const c = app.cardOf(parent, g);
  assert.equal(c.step.title, 'Chairs');
  app.pinCard(c);
  app.tasks[12].done = true; app.leaving[12] = 'done';
  assert.deepEqual([app.cardOf(parent, g).step.title, app.cardCount(app.cardOf(parent, g)).text], ['Chairs', '2/4'], 'done, still showing, counted');
  delete app.leaving[12];
  assert.equal(app.cardOf(parent, g).step.title, 'Tables', 'the batch cleared: the one after it');
  app.resetCards();
  assert.equal(app.cardOf(parent, g).step.title, 'Tables', 'leaving Today: on its next step');
  for (const id of [11, 13]) app.tasks[id].done = true;
  assert.equal(app.cardOf(parent, g), null, 'no open step left: a row like any other');
});

test('Today’s groups: a card by what brought it; one whose task can’t be read shows what brought it as rows', () => {
  const app = component(cards, views, alerts, tasks, leaving), now = new Date();
  const soon = new Date(now.getTime() + 36e5).toISOString(), made = now.toISOString();
  Object.assign(app, { view: { groups: [], cards: {} }, setBadge(){} });
  const dated = task(2, { related_tasks: subs([3]) }), undated = task(6, { related_tasks: subs([7]) }), lost = task(9, { due_date: soon, related_tasks: under(8) });
  const got = { rows: [{ t: task(1, { due_date: soon }), key: 'dated' }],
    cards: new Map([[2, { when: soon, made: null, focus: null, from: [] }], [6, { when: null, made, focus: 7, from: [] }], [8, { when: soon, made: null, focus: null, from: [lost] }]]),
    parents: [dated, undated], steps: [task(3), task(7)], positions: { 3: 1 } };
  const out = app.todayFrom(got, t => t), keys = Object.fromEntries(out.groups.map(g => [g.key, g.tasks.map(t => t.id)]));
  assert.deepEqual(keys.today.sort(), [1, 2, 9]);
  assert.deepEqual(keys.nodate, [6]);
  assert.deepEqual(out.cards, { 2: { when: soon, made: null, focus: null }, 6: { when: null, made, focus: 7 } });
  assert.deepEqual(out.steps.map(t => t.id), [3, 7]);
});

test('a finger on a card: its step line swiped is that step’s slide, which keeps the card at its place; on its heading, nothing', () => {
  const app = component(progress), pinned = [], finished = [];
  Object.assign(app, { tasks: { 10: { id: 10 } }, cardOf: () => ({ id: 10 }), pinCard: c => pinned.push(c.id) });
  const card = (cls = '') => ({ dataset: { id: '10' }, matches: sel => sel.split(', ').some(c => cls.includes(c.slice(1))) });
  const s = { el: 'row', start: 0, show(){}, finish: pct => finished.push(pct) };
  const g = app.cardGesture(card(), s);
  assert.ok(g.show, 'its slide');
  g.finish(null); g.finish(50);
  assert.deepEqual([pinned, finished], [[10], [null, 50]], 'pinned only by a slide that changed something');
  assert.deepEqual(app.cardGesture(card(), null), { el: null }, 'its heading, or nothing to slide: a swipe does nothing, not even a tap');
  assert.equal(app.cardGesture(card('.deleted'), s), null, 'deleted: only its Restore');
  assert.equal(rowGestures({ depth: {}, card: {} }), '', 'a card’s step line: no Delete of its own, as yet');
});

test('a row on Today, on one line: when it is due, short, its project’s dot, and the rest said to a screen reader', () => {
  const { app } = today();
  app.route = { name: 'today' };
  const due = new Date(); due.setHours(23, 30, 0, 0);
  const t = app.keep(task(20, { title: 'Post the rota', due_date: due.toISOString(), priority: 3, project_id: 5, labels: [{ id: 1, title: 'Front' }], comment_count: 2 }));
  const w = app.rowWhen(t, { line: true, depth: {} });
  assert.equal(w.due.text, due.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
  assert.equal(w.prio, 3, 'its priority, as bars before its time (one-concept-plan, part 4)');
  assert.ok(w.color, 'its project’s dot');
  assert.match(w.said, /^Due Today .*, Priority: High, Café$/, 'when in words, its priority and its project; not its label nor its comments');
  assert.equal(app.rowWhen({ ...t, priority: 0 }, { line: true, depth: {} }).prio, 0, 'no priority, no bars');
  // Due today with no time: "Today" under Overdue's heading and elsewhere, nothing under Today's, which says it.
  const day = new Date(); day.setHours(0, 0, 0, 0);
  const u = app.keep(task(21, { title: 'Order the cups', due_date: day.toISOString(), project_id: 5 }));
  assert.equal(app.rowWhen(u, { line: true, depth: {}, key: 'overdue' }).due.text, 'Today');
  assert.equal(app.rowWhen(u, { line: true, depth: {}, key: 'today' }).due, null, 'under Today: no time, nothing');
  assert.match(app.rowWhen(u, { line: true, depth: {}, key: 'today' }).said, /^Due Today/, 'a screen reader still hears it');
  assert.equal(app.rowWhen(t, { line: true, depth: {}, key: 'today' }).due.text, w.due.text, 'a time still shows');
  // Its attachments are a count, unsaid; photos still waiting to upload are work still to send, said.
  assert.doesNotMatch(app.rowWhen({ ...t, attachments: [{ id: 1 }] }, { line: true, depth: {} }).said, /Attachments/);
  app.waitingByTask.set(20, [{ key: 'f' }]);
  assert.match(app.rowWhen(t, { line: true, depth: {} }).said, /, Attachments, 1 waiting to upload$/);
  app.waitingByTask.delete(20);
  // A run's step counting down: its countdown at the right, as under its title elsewhere, and said.
  const soon = app.keep(task(22, { title: 'Proof the dough', due_date: new Date(Date.now() + 10 * 6e4 + 3e4).toISOString(), related_tasks: under(50) }));
  app.stepRun = x => x.id === 22 ? 50 : null;
  const s = app.rowWhen(soon, { line: true, depth: {}, key: 'today' });
  assert.deepEqual([s.due, s.said.split(', ')[0]], [{ text: 'in 11m', cls: 'today' }, 'Due in 11m']);
  assert.equal(app.rowMeta(soon, { depth: {} }).find(m => m.key === 'due').text, 'in 11m');
  assert.equal(app.cardHead(u, { key: 'today' }).due, null, 'a card’s heading the same');
  assert.equal(app.cardHead(u, { key: 'week' }).due.text, 'Today');
});

test('a run’s card has a heading like a task’s: its name without the day it was started, and when it’s due at the right', () => {
  const { app } = today();
  app.route = { name: 'today' };
  const made = new Date(2026, 9, 8, 7, 30), day = d => d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  const run = task(30, { title: `Opening up · run 2 · ${day(made)}`, created: made.toISOString(), project_id: 5 });
  app.isRunTask = t => t.id === 30;
  assert.equal(app.cardHead(run).title, 'Opening up · run 2');
  assert.equal(app.cardHead({ ...run, title: `Opening up · Saturday · ${day(new Date(2026, 9, 6))}` }).title, 'Opening up · Saturday', 'started offline, made in Vikunja later');
  assert.equal(app.cardHead({ ...run, title: `Opening up · run 2 · ${day(new Date(2026, 8, 20))}` }).title, `Opening up · run 2 · ${day(new Date(2026, 8, 20))}`, 'not a day it was started: kept');
  assert.equal(app.cardHead({ ...run, title: 'Opening up' }).title, 'Opening up', 'a name of its own: kept whole');
  assert.equal(app.cardHead({ ...run, created: NONE }).title, run.title, 'not made yet: kept whole');
  assert.equal(app.cardHead(task(31, { title: `Pack the van · front · ${day(made)}`, created: made.toISOString() })).title, `Pack the van · front · ${day(made)}`, 'a task’s title as it is');
  // Due when its template was (started from Today), it shows that at the right, as a task's card does.
  const due = new Date(); due.setHours(23, 30, 0, 0);
  assert.equal(app.cardHead({ ...run, due_date: due.toISOString() }, { key: 'today' }).due.text, due.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
  assert.equal(app.cardHead(run, { key: 'today' }).due, null, 'none: nothing at the right');
});

test('where a run goes next: the next open step in order, even counting down; before it, a timed step whose time has come', () => {
  const now = 1000, s = (id, f = {}) => ({ id, done: false, counting: false, dueAt: Infinity, ...f });
  const steps = [s(1, { done: true }), s(2, { counting: true, dueAt: 1600 }), s(3), s(4, { counting: true, dueAt: 900 }), s(5)];
  assert.equal(whereNext(steps, now), 3, 'opening: the timed one whose time has come, 4, first');
  assert.equal(whereNext(steps, now, steps[3]), 4, 'after it: the next in order');
  assert.equal(whereNext(steps, now, steps[2]), 3, 'after a tick on 3: 4, next anyway');
  const later = [s(1, { done: true }), s(2, { counting: true, dueAt: 1600 }), s(3), s(4)];
  assert.equal(whereNext(later, now), 1, 'opening: the first open in order, still counting down');
  assert.equal(whereNext(later, now, later[1]), 2, 'after it: the next');
  assert.equal(whereNext(later, now, later[2]), 3, 'after 3: 4, with 2 still counting down');
  assert.equal(whereNext(later, now, later[3]), 1, 'none after it: round to the first open');
  assert.equal(whereNext(later, 1600, later[2]), 1, 'its countdown at zero: 2, before 4');
  assert.equal(whereNext([s(1, { done: true }), s(2), s(3, { counting: true, dueAt: 5000 })], now, { id: 2 }), 2, 'one that starts counting down with this tick: next, with its countdown');
  assert.equal(whereNext([s(1, { counting: true, dueAt: 500 }), s(2, { counting: true, dueAt: 200 })], now), 0, 'two whose time has come: the first in order');
  assert.equal(whereNext([s(1, { done: true }), s(2)], now, { id: 2 }), -1, 'none open but the one ticked');
});

test('a run’s card on Today opens on the step its screen would, and goes by the same rule once the step ticked has gone', () => {
  const { app, parent, g } = today();
  app.isRunTask = t => t.id === 10;                                        // its steps in its order: Lights, Chairs, Tables, then 14, done
  const soon = m => new Date(Date.now() + m * 6e4).toISOString();
  app.tasks[11].due_date = soon(10); app.tasks[13].due_date = soon(20);   // Lights and Tables counting down
  const c = app.cardOf(parent, g);
  assert.deepEqual([c.step.title, app.cardCount(c)], ['Lights', { text: '1/4', said: '1 of 4 steps done' }], 'the first in order, counting down');
  assert.equal(cardAt([{ id: 1 }, { id: 2 }], null, 2, () => 1), 1, 'a step of yours that brought it still comes first');
  app.pinCard(c);
  app.tasks[11].done = true; app.leaving[11] = 'done';
  assert.equal(app.cardOf(parent, g).step.title, 'Lights', 'ticked, it stays until the batch clears');
  delete app.leaving[11];
  assert.equal(app.cardOf(parent, g).step.title, 'Chairs', 'then the next in order');
  app.tasks[13].due_date = soon(-1);
  app.resetCards();
  assert.equal(app.cardOf(parent, g).step.title, 'Tables', 'a timed step whose time has come, before it');
});

// A run on its screen (runView, runs.js): A done a minute ago; B timed 30 minutes from A, counting down; C and D.
const runScreen = () => {
  const app = component(runs, claims, checklists, cards, views), now = Date.now(), NONE = '0001-01-01T00:00:00Z';
  const step = (id, title, f = {}) => ({ id, title, done: false, done_at: NONE, due_date: NONE, updated: new Date(now - 36e5).toISOString(), percent_done: 0, description: '',
    assignees: [], attachments: [], reactions: {}, comments: [], tpl: title, added: '', from: null, ...f });
  Object.assign(app, { user: me, pending: [], slow: [], perms: {}, clock: now, actTask: a => a.task,
    view: { run: { run: { id: 50, title: 'Opening up', done: false, project_id: 5, assignees: [me], created_by: me, comments: [] },
      steps: [step(51, 'A', { done: true, done_at: new Date(now - 6e4).toISOString(), reactions: { '✅': [me] } }), step(52, 'B', { tpl: 'B T#30m' }), step(53, 'C', { percent_done: .5 }), step(54, 'D')], at: null, last: null } } });
  return app;
};

test('a run’s screen opens on the next step in order, counting down, and a tick goes on to the next', () => {
  const app = runScreen(), v = app.runView;
  assert.deepEqual([v.step.title, v.at], ['B', 1], 'B, counting down');
  assert.equal(v.card, undefined, 'no strip: its steps, listed, say where it is');
  assert.equal(app.nextStep(v.steps[1]), 2, 'ticked, on to C');
  assert.equal(app.nextStep(v.steps[2]), 3, 'C ticked, on to D, with B still counting down');
  app.showStep(0);                                                         // A tapped in the list
  assert.deepEqual([app.runView.step.title, app.runView.step.done], ['A', true], 'a done step comes on the card from its row');
});

test('the step card shows who’s on its step, as its row does, until it’s done', () => {
  const app = runScreen(), v = app.runView;
  assert.deepEqual(app.rowSlot(v.step, { run: true }), v.step.slot);
  assert.equal(app.rowSlot(v.steps[0], { run: true }), null, 'done: its row and card say who did it instead');
});

test('a run’s bottom box aims at the card’s step; steps added go each after the last, until the card’s step changes', async () => {
  const app = runScreen(), added = [], aim = () => { const a = app.runAim; return [a.on.title, a.after, a.title, a.before]; };
  app.addStep = async f => { added.push(f); };
  app.showStep(2);                                                         // C tapped, on the card
  assert.deepEqual(aim(), ['C', 53, 'C', 54], 'after C, before D');
  const ids = await app.addSteps([{ title: 'X' }, { title: 'Y' }]);
  assert.deepEqual(added.map(f => [f.id, f.title, f.after, f.before]), [[ids[0], 'X', 53, 54], [ids[1], 'Y', 'pending-' + ids[0], 54]], 'a pasted list in order');
  assert.deepEqual(aim(), ['C', 'pending-' + ids[1], 'Y', 54], 'the next goes after Y, still before D');
  app.showStep(3);
  assert.deepEqual(aim(), ['D', 54, 'D', null], 'D on the card: after it, at the end');
  app.showStep(2);
  assert.deepEqual(aim(), ['C', 53, 'C', 54], 'back on C, from C again');
});

test('a run’s bottom box: every step done, after the last; none on a run finished or read only', () => {
  const app = runScreen();
  for (const s of app.view.run.steps) Object.assign(s, { done: true, done_at: new Date().toISOString() });
  assert.equal(app.runView.step, null, 'no step on the card');
  assert.deepEqual([app.runAim.on.title, app.runAim.before], ['D', null]);
  app.perms[5] = 0;
  assert.equal(app.runAim, null, 'read only');
  app.perms[5] = 1; app.view.run.run.done = true;
  assert.equal(app.runAim, null, 'finished');
});

test('Repeat copies the card’s step where the box aims, with an Undo that puts the aim back', async () => {
  const app = runScreen(), added = [], said = [];
  app.addStep = async f => { added.push(f); };
  app.showStep(2);                                                         // C tapped, on the card
  app.say = (text, o) => said.push({ text, ...o });
  app.dropStep = async () => false;                                        // still waiting: not sent
  await app.addSteps([{ title: 'X' }]);
  await app.repeatCard();
  assert.deepEqual([added[1].title, added[1].tpl, added[1].after, added[1].before], ['C', 'C', 'pending-' + added[0].id, 54], 'a copy of C, after X');
  assert.deepEqual([said[0].text, said[0].place, said[0].action.label], ['Repeated “C”', 'cap', 'Undo']);
  assert.equal(app.runAim.after, 'pending-' + added[1].id);
  await said[0].action.fn();
  assert.deepEqual([app.runAim.after, app.runAim.title, app.said], ['pending-' + added[0].id, 'X', 'Not repeated: C'], 'after X again');
});
