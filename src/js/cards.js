/* The stacked card: anything with open subtasks or steps shows as a card, its title over its open subtasks, collapsed
   on Today to the most urgent with a peek at the next; on Today never as rows of its subtasks. What brings one onto
   Today, where it sits there, and which subtask is on top, is worked out here, apart from the screen, so the unit
   tests can check it; app/cards.js draws them. */
import {isLate, isSet, startOfDay} from './dates.js';
import {durText, hasTemplateLabel} from './checklists.js';

// A task's subtasks still open, as its own copy lists them.
export const openSubs = t => (t?.related_tasks?.subtask || []).filter(s => !s.done);
// The task a subtask is under (Vikunja's short copy of it, with its id and project), or null.
const parentOf = t => t?.related_tasks?.parenttask?.[0] || null;
const yours = (t, me) => (t.assignees || []).some(u => u.id === me?.id);
const earlier = (a, b) => !a ? b : !b ? a : Date.parse(b) < Date.parse(a) ? b : a;
const later = (a, b) => !a ? b : !b ? a : Date.parse(b) > Date.parse(a) ? b : a;

/* What Today shows, from what it read: `tasks`, open and due by the end of the coming week; `added`, open and made
   today; `mine`, your runs in progress; `claimed`, steps you're on in someone else's run in progress. Each brings
   onto Today:
   - a task due, with no open subtasks: itself, a row (`rows`, `key` 'dated');
   - a task due with open subtasks, or a subtask due (a run's step too): the card of the task (or run) it's under;
   - a subtask of yours, made today, with no date: its parent's card (`focus`); one made before today
     doesn't keep a card on Today (Vikunja doesn't say when a task was assigned, so made today is what counts);
   - a task of yours made today with no date: itself, under "Added today, no date" (`key` 'nodate'), or its card;
   - a run of yours in progress: its card, or with no open step, its row under Checklist runs (`key` 'runs');
   - a step you're on in someone else's run in progress: the run's card.
   (A card's top row is its most urgent subtask, or a run's next step, not the one that brought it: `focus` is kept, as
   yet unused. parent-tasks-plan, part 2.) A template that comes round is never a card: its steps are done, and it's started from its row.
   `cards`: parent id -> {when: the earliest date that brought it (null: none), made: when the latest subtask of yours
   that brought it was made, focus: that subtask's id, project: its project as far as known, from: the tasks that brought
   it, to show as rows if the parent can't be read}. `isRun(t)`: whether it's a checklist run. */
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
    if (isSet(t.due_date)) continue;                       // dated: with `tasks`
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
/* Where a card sits on Today: by the earliest date that brought it (overdue, today, the coming week), like a row; with
   none, a run under Checklist runs, anything else under "Added today, no date". */
export const cardGroup = (c, run) => c.when ? 'dated' : run ? 'runs' : 'nodate';

/* A stacked card's open subtasks on Today and in search (parent-tasks-plan, part 2), its top row the most urgent:
   overdue first, then due today, then the earliest date, then the rest in list order (`order`: positionOrder, order.js).
   `now`: when, in ms. A sort's comparison. */
export const urgentFirst = (now, order) => {
  const day = +startOfDay(new Date(now)), next = day + 864e5;
  const due = t => isSet(t.due_date) ? +new Date(t.due_date) : Infinity;
  const rank = t => !isSet(t.due_date) ? 3 : isLate(t.due_date, new Date(now)) ? 0 : due(t) < next && due(t) >= day ? 1 : 2;
  return (a, b) => rank(a) - rank(b) || (due(a) < Infinity ? due(a) - due(b) : 0) || order(a, b);
};
/* The top of a run's card, of its open `steps` in its order: the step a tick or a slide left it on (`pinned`: its id,
   pinCard) while it's still there, done or not, waiting for the batch; else the run's own rule (`pick`: whereNext,
   checklists.js), given the step that has gone, or null, and giving the id of the step to show. Its index; the first
   if the rule gives none, -1 with no steps. */
export function runTop(steps, pinned, pick){
  if (!steps.length) return -1;
  const k = id => steps.findIndex(s => s.id === id);
  if (pinned != null && k(pinned) >= 0) return k(pinned);
  return Math.max(0, k(pick(pinned ?? null)));
}
/* A run's step's countdown on its card, to the minute, as Today redraws once a minute: "in 1h 5m", "12m late"; null more
   than a day either way, where its date says it better. `due` and `now` in ms. */
export function countdown(due, now){
  const left = due - now, min = ms => Math.max(6e4, ms);
  if (!(Math.abs(left) < 864e5)) return null;
  return left >= 0 ? {text: 'in ' + durText(min(Math.ceil(left / 6e4) * 6e4)), late: false} : {text: durText(min(Math.floor(-left / 6e4) * 6e4)) + ' late', late: true};
}
