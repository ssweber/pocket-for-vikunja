/* Stacked cards. A task with open subtasks or steps shows as a card: its title over its open subtasks. On Today the
   card is collapsed to the most urgent subtask, with "More" under it. This file calculates why a card is on Today,
   where it sits and which subtask is on top. It has no DOM code, so the unit tests can check it. app/cards.js draws
   the cards. */
import {isLate, isSet, startOfDay} from './dates.js';
import {durText, hasTemplateLabel} from './checklists.js';

// A task's open subtasks, as listed in its own related_tasks.
export const openSubs = t => (t?.related_tasks?.subtask || []).filter(s => !s.done);
// A subtask's parent, as Vikunja's short copy that has its id and project, or null.
const parentOf = t => t?.related_tasks?.parenttask?.[0] || null;
const yours = (t, me) => (t.assignees || []).some(u => u.id === me?.id);
const earlier = (a, b) => !a ? b : !b ? a : Date.parse(b) < Date.parse(a) ? b : a;
const later = (a, b) => !a ? b : !b ? a : Date.parse(b) > Date.parse(a) ? b : a;

/* What Today shows. `tasks` are the open tasks due by the end of the coming week. `added` are the open tasks made
   today. `mine` are your checklists in progress. `claimed` are the steps you're on in someone else's checklist.
   `isRun(t)` returns true when a task is a checklist. Each of these puts something on Today:
   - A due task with no open subtasks appears as itself, a row (`key` 'dated').
   - A due task with open subtasks, or a due subtask, appears as its parent's card.
   - A subtask assigned to you, made today, with no date appears as its parent's card. Vikunja doesn't record when a
     task was assigned, so the day it was made is what counts.
   - A task of yours made today with no date appears as itself under "Added today, no date" (`key` 'nodate'), or as
     its card.
   - A checklist of yours in progress appears as its card, or as a row under Checklists (`key` 'runs') when no step
     is open.
   - A step you're on in someone else's checklist appears as that checklist's card.

   A card's top row is its most urgent subtask, or a checklist's next step. It is not the subtask that put the card
   on Today. views.js reads `focus`. A template is never a card. Its steps are all marked done, and a checklist is
   started from its row.

   Returns `rows`, and `cards` by parent id, each {when, made, focus, project, from}:
   - `when` is the earliest date that put the card on Today, or null.
   - `made` is when the latest subtask of yours that put it on Today was made.
   - `focus` is that subtask's id.
   - `project` is the card's project, as far as known.
   - `from` is the tasks that put the card on Today. They are shown as rows if the parent can't be read. */
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
/* Which of Today's groups a card sits in. Like a row, it goes by the earliest date that put it on Today. With no
   date, a checklist goes under Checklists and anything else under "Added today, no date". */
export const cardGroup = (c, run) => c.when ? 'dated' : run ? 'runs' : 'nodate';

/* A sort comparison that puts a card's most urgent subtask first. The order is overdue, then due today, then by date,
   then the rest in list order (`order`, from positionOrder in order.js). `now` is in ms. */
export const urgentFirst = (now, order) => {
  const day = +startOfDay(new Date(now)), next = day + 864e5;
  const due = t => isSet(t.due_date) ? +new Date(t.due_date) : Infinity;
  const rank = t => !isSet(t.due_date) ? 3 : isLate(t.due_date, new Date(now)) ? 0 : due(t) < next && due(t) >= day ? 1 : 2;
  return (a, b) => rank(a) - rank(b) || (due(a) < Infinity ? due(a) - due(b) : 0) || order(a, b);
};
/* A card's rows on Today. `sorted` is its open subtasks, most urgent first. `added` is the subtasks typed into the
   card's add box during this visit, each {t, after}. `after` is the id of the row the box was under, or null if it
   was under the header. Each added subtask stays after that row until the user leaves the screen, or goes on top if
   the row is gone. A collapsed card shows the most urgent subtask and the added rows. An open card shows every row.

   Returns {list, rows, step, peek, more}. `list` is every row in the card's order, `rows` the rows shown, `step` the
   most urgent subtask, `peek` the first row that "More" hides, and `more` how many rows it hides. */
export function cardRows(sorted, added, open){
  const list = sorted.filter(s => !added.some(a => a.t.id === s.id));
  for (const a of added) { const i = a.after == null ? -1 : list.findIndex(x => x.id === a.after); list.splice(i + 1, 0, a.t); }
  const step = sorted.find(s => !added.some(a => a.t.id === s.id)) || list[0] || null;
  const rows = open ? list : list.filter(x => x === step || added.some(a => a.t === x));
  return {list, rows, step, peek: !open ? list.find(x => !rows.includes(x)) || null : null, more: list.length - rows.length};
}
/* The index in `steps` of the step that a checklist's card shows on top. A step that was ticked or swiped keeps the
   top position (`pinned`, its id) while it is still in `steps`, waiting for the batch. After that, `pick` (whereNext,
   checklists.js) receives the id of the step that left the card, or null, and returns the id to show. If that finds
   nothing, the first step is used, or -1 when there are no steps. */
export function runTop(steps, pinned, pick){
  if (!steps.length) return -1;
  const k = id => steps.findIndex(s => s.id === id);
  if (pinned != null && k(pinned) >= 0) return k(pinned);
  return Math.max(0, k(pick(pinned ?? null)));
}
/* A step's countdown on a checklist's card, to the minute, because Today redraws once a minute: "in 1h 5m" or "12m
   late". Null when the step is more than a day away in either direction, because the date reads better there. `due`
   and `now` are in ms. */
export function countdown(due, now){
  const left = due - now, min = ms => Math.max(6e4, ms);
  if (!(Math.abs(left) < 864e5)) return null;
  return left >= 0 ? {text: 'in ' + durText(min(Math.ceil(left / 6e4) * 6e4)), late: false} : {text: durText(min(Math.floor(-left / 6e4) * 6e4)) + ' late', late: true};
}
