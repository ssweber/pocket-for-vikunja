// Today's cards (src/js/cards.js, and app/cards.js on a pretend component): which tasks are cards and what brought each,
// where each sits on Today, which step a card shows and how it pages, and its task's line.
import { component } from './fake.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardAt, cardGroup, countdown, placeOf, segmentAt, stepOfSegment, todayItems, turnPage } from '../../src/js/cards.js';
import { pageOffset, pageStarts, pageTurn } from '../../src/js/progress.js';
import { rowGestures } from '../../src/js/lists.js';
import cards from '../../src/js/app/cards.js';
import views from '../../src/js/app/views.js';
import alerts from '../../src/js/app/alerts.js';
import tasks from '../../src/js/app/tasks.js';
import leaving from '../../src/js/app/leaving.js';
import progress from '../../src/js/app/progress.js';

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

test('which step a card shows, and paging it round', () => {
  const steps = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.equal(cardAt(steps, null, null), 0, 'the next step in order');
  assert.equal(cardAt(steps, null, 3), 2, 'the subtask of yours that brought it');
  assert.equal(cardAt(steps, null, 9), 0, 'that one gone: the next in order');
  assert.equal(cardAt(steps, { id: 2, i: 1 }, 3), 1, 'paged');
  assert.equal(cardAt([{ id: 1 }, { id: 3 }], { id: 2, i: 1 }, null), 1, 'the step paged to gone: the one after it, in its place');
  assert.equal(cardAt([{ id: 1 }, { id: 2 }], { id: 3, i: 2 }, null), 0, 'the last gone: round to the first');
  assert.equal(cardAt([], null, null), -1);
  assert.deepEqual([turnPage(2, 3, 1), turnPage(0, 3, -1), turnPage(1, 3, 1)], [0, 2, 2], 'round from the last to the first, and back');
});

test('a swipe pages a card only sideways, away from the screen’s edges, and only far enough', () => {
  assert.ok(pageStarts(-12, 3, 200, 390));
  assert.ok(pageStarts(12, 3, 200, 390), 'either way');
  assert.ok(!pageStarts(-12, 20, 200, 390), 'mostly up or down: a scroll');
  assert.ok(!pageStarts(-12, 0, 10, 390), 'from the edge: the phone’s Back');
  assert.ok(!pageStarts(-5, 0, 200, 390), 'not yet');
  assert.deepEqual([pageTurn(-60), pageTurn(60), pageTurn(-20)], [1, -1, 0], 'swiped left: the next, as a page is turned');
  assert.deepEqual([pageOffset(-40), pageOffset(400)], [-20, 64]);
  assert.equal(rowGestures({ depth: {}, card: {}, paging: true }), 'paging');
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

test('a card: its open steps in its List view’s order, the first showing, its line a segment per subtask', () => {
  const { app, parent, g } = today(), c = app.cardOf(parent, g);
  assert.deepEqual(c.steps.map(s => s.title), ['Chairs', 'Tables', 'Lights']);
  assert.deepEqual([c.step.title, c.i, c.n], ['Chairs', 0, 3]);
  assert.deepEqual([c.at, c.total], [1, 4], 'its count, 2 of 4: its place among all its subtasks, the done one first');
  assert.deepEqual(c.line, { segs: 4, done: 1, many: false });
  assert.equal(c.lineText, '1 of 4 subtasks done');
  assert.deepEqual([c.g.paging, c.g.card === c], [true, true], 'the step line pages, and knows its card');
  assert.equal(app.cardOf(parent, { depth: {} }), null, 'only on Today’s lists');
  assert.deepEqual(app.rowMeta(c.step, c.g).map(m => m.text), [], 'not which step it is (that’s on the card’s title now), nor the project');
});

test('under a card’s title: its due date, its priority’s bars as its row shows them, only when it has one, and its project', () => {
  const { app, parent } = today();
  assert.deepEqual(app.cardMeta(parent).map(m => m.key), ['p'], 'no priority, no bars');
  const urgent = { ...parent, priority: 4, due_date: at(8, 10) }, row = app.rowMeta(urgent, { depth: {} }).find(m => m.key === 'prio');
  assert.deepEqual(app.cardMeta(urgent).map(m => m.key), ['due', 'prio', 'p']);
  assert.deepEqual(app.cardMeta(urgent).find(m => m.key === 'prio'), row, 'the same as on its row');
  assert.equal(row.label, 'Priority: Urgent');
});

test('a card’s count is its step’s real place, done steps included; paging skips the done ones and goes round; its line marks that place', () => {
  const steps = [{ id: 1, done: true }, { id: 2, done: true }, { id: 3 }, { id: 4 }, { id: 5 }];
  assert.deepEqual([placeOf(steps, steps[2]), placeOf(steps, { id: 9 }), placeOf(steps, null)], [2, -1, -1]);
  const { app, parent, g } = today();
  app.tasks[12].done = true;                                               // 14 and Chairs done: Tables is 3 of 4
  const seen = [];
  for (let k = 0; k < 4; k++) {
    const c = app.cardOf(parent, g);
    seen.push([c.step.title, c.at + 1, c.total, c.line.done]);
    app.pageCard(c, 1);
  }
  assert.deepEqual(seen, [['Tables', 3, 4, 2], ['Lights', 4, 4, 2], ['Tables', 3, 4, 2], ['Lights', 4, 4, 2]], 'from 3 to 4, then back to 3: never a done one');
  assert.equal(app.said, 'Step 3 of 4: Tables', 'a screen reader hears its real place');
  app.pageCard(app.cardOf(parent, g), -1);
  assert.equal(app.cardOf(parent, g).at, 3, 'back: the marked segment is the fourth');
});

test('a tap on a card’s line: the segment under it, an open step’s showing it, a done one’s nothing, none past 12 steps', () => {
  // 5 segments over 197px: each (197 + 3) / 5 = 40px with its gap.
  assert.deepEqual([0, 39, 40, 119.9, 196, 230, -5].map(x => segmentAt(x, 197, 5)), [0, 0, 1, 2, 4, 4, 0], 'its stretch, a gap with the one before it, the ends kept');
  assert.deepEqual([segmentAt(60, 300, 12), segmentAt(60, 300, 13), segmentAt(60, 0, 3)], [2, -1, -1], 'past MANY_STEPS too narrow to tap; none without a line');
  const all = [{ id: 1, done: true }, { id: 2 }, { id: 3, done: true }, { id: 4 }], open = [all[1], all[3]];
  assert.deepEqual([0, 1, 2, 3, -1, 9].map(k => stepOfSegment(all, open, k)), [-1, 0, -1, 1, -1, -1], 'a done step’s segment is none, as paging skips it');
  const { app, parent, g } = today(), line = { getBoundingClientRect: () => ({ left: 100, width: 197 }) };   // 4 segments, 50px each
  app.tasks[12].done = true;                                               // 14 and Chairs done: Tables (3 of 4) showing
  app.tapSegment(app.cardOf(parent, g), 100 + 160, line);
  assert.deepEqual([app.cardOf(parent, g).step.title, app.cardOf(parent, g).at, app.said], ['Lights', 3, 'Step 4 of 4: Lights'], 'the fourth, open: it shows, and a screen reader hears it');
  for (const x of [100 + 10, 100 + 60]) app.tapSegment(app.cardOf(parent, g), x, line);
  assert.equal(app.cardOf(parent, g).step.title, 'Lights', 'a done one’s segment: nothing');
  app.tapSegment(app.cardOf(parent, g), 100 + 110, line);
  assert.equal(app.cardOf(parent, g).step.title, 'Tables', 'back to the third');
});

test('paged round, a screen reader hears which step; ticked, a step stays until the batch clears, then the next comes in', () => {
  const { app, parent, g } = today();
  app.pageCard(app.cardOf(parent, g), -1);
  assert.equal(app.cardOf(parent, g).step.title, 'Lights', 'from the first back round to the last');
  assert.equal(app.said, 'Step 4 of 4: Lights', 'its place among all four, the done one too');
  app.pageCard(app.cardOf(parent, g), 1);
  let c = app.cardOf(parent, g);
  assert.equal(c.step.title, 'Chairs');
  app.pageCard(c, 1);
  c = app.cardOf(parent, g);
  app.pinCard(c);
  app.tasks[13].done = true; app.leaving[13] = 'done';
  assert.deepEqual([app.cardOf(parent, g).step.title, app.cardOf(parent, g).line.done], ['Tables', 2], 'done, still showing, the line filled');
  delete app.leaving[13];
  assert.equal(app.cardOf(parent, g).step.title, 'Lights', 'the batch cleared: the one after it');
  app.resetCards();
  assert.equal(app.cardOf(parent, g).step.title, 'Chairs', 'leaving Today: back on its next step');
  for (const id of [11, 12]) app.tasks[id].done = true;
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

test('a finger on a card: its step line held is that step’s slide, which keeps the card at its place; a swipe anywhere pages it', () => {
  const app = component(progress), pinned = [], finished = [];
  Object.assign(app, { tasks: { 10: { id: 10 } }, cardOf: () => ({ id: 10 }), pinCard: c => pinned.push(c.id) });
  const step = gestures => ({ dataset: { gestures }, classList: { add(){}, remove(){} }, style: { setProperty(){}, removeProperty(){} } });
  const card = (gestures, cls = '') => ({ dataset: { id: '10' }, matches: sel => sel.split(', ').some(c => cls.includes(c.slice(1))), querySelector: () => step(gestures) });
  const s = { el: 'row', start: 0, show(){}, finish: pct => finished.push(pct) };
  const g = app.cardGesture(card('paging'), s);
  assert.ok(g.page && g.show, 'both: its slide, and its paging');
  g.finish(null); g.finish(50);
  assert.deepEqual([pinned, finished], [[10], [null, 50]], 'pinned only by a slide that changed something');
  assert.ok(app.cardGesture(card('paging'), null).page, 'its title: only paging');
  assert.equal(app.cardGesture(card(''), null), null, 'one open step: nothing to page');
  assert.equal(app.cardGesture(card('paging', '.deleted'), s), null, 'deleted: only its Restore');
});
