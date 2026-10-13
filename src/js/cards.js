/* Stacked cards. A task with open subtasks or steps shows as a card: its title over its open subtasks, and on Today
   collapsed to the most urgent subtask with "More" under it. This file works out why a card is on Today, where
   it sits and which subtask is on top, with no screen in it, so the unit tests can check it. app/cards.js draws
   the cards. */
import {isLate, isSet, startOfDay} from './dates.js';
import {durText, hasTemplateLabel} from './checklists.js';

// A task's open subtasks, as listed in its own related_tasks.
export const openSubs = t => (t?.related_tasks?.subtask || []).filter(s => !s.done);
// A subtask's parent, as Vikunja's short copy with its id and project, or null.
const parentOf = t => t?.related_tasks?.parenttask?.[0] || null;
const yours = (t, me) => (t.assignees || []).some(u => u.id === me?.id);
const earlier = (a, b) => !a ? b : !b ? a : Date.parse(b) < Date.parse(a) ? b : a;
const later = (a, b) => !a ? b : !b ? a : Date.parse(b) > Date.parse(a) ? b : a;

/* What Today shows. `tasks` are the open tasks due by the end of the coming week, `added` the open tasks made today,
   `mine` your runs in progress, and `claimed` the steps you're on in someone else's run. Each puts something on
   Today:
   - a due task with no open subtasks: itself, as a row (`key` 'dated');
   - a due task with open subtasks, or a due subtask: its parent's card;
   - a subtask assigned to you, made today, with no date: its parent's card. Vikunja doesn't record when a task was
     assigned, so made today is what counts;
   - a task of yours made today with no date: itself under "Added today, no date" (`key` 'nodate'), or its card;
   - a run of yours in progress: its card, or a row under Checklists (`key` 'runs') when no step is open;
   - a step you're on in someone else's run: the run's card.
   A card's top row is its most urgent subtask, or a run's next step, not the subtask that put it on Today. views.js reads `focus`. A repeating template is never a card: its steps are done, and it starts from its row.
   Returns `rows`, and `cards` by parent id: {when: the earliest date that put it on Today, or null; made: when the latest
   subtask of yours that put it on Today was made; focus: that subtask's id; project: its project as far as known; from: the
   tasks that put it on Today, shown as rows if the parent can't be read}. `isRun(t)` says whether a task is a run. */
export function todayItems({tasks = [], added = [], mine = [], claimed = []}, me, isRun = () => false){
  const cards = new Map(), rows = new Map();
  const card = (p, why, {when = null, made = null, focus = null} = {}) => {
    const c = cards.get(p.id) || {when: null, made: null, focus: null, project: p.project_id ?? null, from: []};
    c.when = earlier(c.when, isSet(when) ? when : null); c.made = later(c.made, made); c.focus ??= focus;
    if (why && !c.from.includes(why)) c.from.push(why);
    cards.set(p.id, c);
  };
  const row = (t, key) => { if (!rows.has(t.id)) rows.set(t.id, {t, key}); };
  for (const t of tasks) {
    const p = parentOf(t);
    if (p) card(p, t, {when: t.due_date, focus: yours(t, me) ? t.id : null});
    else if (openSubs(t).length && !hasTemplateLabel(t)) card(t, null, {when: t.due_date});
    else row(t, 'dated');
  }
  for (const t of added) {
    if (isSet(t.due_date)) continue;                       // a due task came in `tasks`
    const p = parentOf(t);
    if (p) { if (yours(t, me)) card(p, t, {made: t.created, focus: t.id}); }
    else if (isRun(t) || t.created_by?.id !== me?.id) continue;
    else if (openSubs(t).length) card(t, null, {made: t.created});
    else row(t, 'nodate');
  }
  for (const t of mine) if (!isSet(t.due_date)) { if (openSubs(t).length) card(t, null); else row(t, 'runs'); }
  for (const t of claimed) { const p = parentOf(t); if (p) card(p, t, {focus: t.id}); }
  return {rows: [...rows.values()].filter(r => !cards.has(r.t.id)), cards};
}
/* Which of Today's groups a card sits in: by the earliest date that put it on Today, like a row. With no date, a run goes
   under Checklists and anything else under "Added today, no date". */
export const cardGroup = (c, run) => c.when ? 'dated' : run ? 'runs' : 'nodate';

/* A sort comparison that puts a card's most urgent subtask first: overdue, then due today, then by date, then the rest
   in list order (`order`, from positionOrder in order.js). `now` is in ms. */
export const urgentFirst = (now, order) => {
  const day = +startOfDay(new Date(now)), next = day + 864e5;
  const due = t => isSet(t.due_date) ? +new Date(t.due_date) : Infinity;
  const rank = t => !isSet(t.due_date) ? 3 : isLate(t.due_date, new Date(now)) ? 0 : due(t) < next && due(t) >= day ? 1 : 2;
  return (a, b) => rank(a) - rank(b) || (due(a) < Infinity ? due(a) - due(b) : 0) || order(a, b);
};
/* A card's rows on Today. `sorted` is its open subtasks, most urgent first. `added` is the subtasks typed into the
   card's add box this visit, each {t, after: the id of the row the box was under, or null under the header}. Each
   added subtask stays after that row, or on top when the row has gone, until the screen is left. A collapsed card
   shows the most urgent subtask and the added rows. An open card shows every row. Returns {list: every row in the
   card's order, rows: the rows shown, step: the most urgent, peek: the first row "More" hides, more: how many it
   hides}. */
export function cardRows(sorted, added, open){
  const list = sorted.filter(s => !added.some(a => a.t.id === s.id));
  for (const a of added) { const i = a.after == null ? -1 : list.findIndex(x => x.id === a.after); list.splice(i + 1, 0, a.t); }
  const step = sorted.find(s => !added.some(a => a.t.id === s.id)) || list[0] || null;
  const rows = open ? list : list.filter(x => x === step || added.some(a => a.t === x));
  return {list, rows, step, peek: !open ? list.find(x => !rows.includes(x)) || null : null, more: list.length - rows.length};
}
/* The index in `steps` of the step a run's card shows on top. While the step a tick or swipe left the card on
   (`pinned`, its id) is still in `steps`, waiting for the batch, it stays on top. Otherwise `pick` (whereNext,
   checklists.js) is given the id of the step that has gone, or null, and returns the id to show. Falls back to the
   first step, or -1 with no steps. */
export function runTop(steps, pinned, pick){
  if (!steps.length) return -1;
  const k = id => steps.findIndex(s => s.id === id);
  if (pinned != null && k(pinned) >= 0) return k(pinned);
  return Math.max(0, k(pick(pinned ?? null)));
}
/* A step's countdown on a run's card, to the minute, since Today redraws once a minute: "in 1h 5m" or "12m late".
   Null when more than a day away either way, where the date says it better. `due` and `now` are in ms. */
export function countdown(due, now){
  const left = due - now, min = ms => Math.max(6e4, ms);
  if (!(Math.abs(left) < 864e5)) return null;
  return left >= 0 ? {text: 'in ' + durText(min(Math.ceil(left / 6e4) * 6e4)), late: false} : {text: durText(min(Math.floor(-left / 6e4) * 6e4)) + ' late', late: true};
}
