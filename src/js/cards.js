/* Today's cards: anything with open subtasks or steps shows on Today as a card, its title over one line for its next
   step, never as rows of its subtasks. What brings one onto Today, and where it sits there, is worked out here from
   what Today read, apart from the screen, so the unit tests can check it; app/cards.js draws them. */
import {isSet} from './dates.js';
import {durText, hasTemplateLabel} from './checklists.js';
import {MANY_STEPS} from './progress.js';

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
   - a subtask of yours, made today, with no date: its parent's card, opened on it (`focus`); one made before today
     doesn't keep a card on Today (Vikunja doesn't say when a task was assigned, so made today is what counts);
   - a task of yours made today with no date: itself, under "Added today, no date" (`key` 'nodate'), or its card;
   - a run of yours in progress: its card, or with no open step, its row under Checklist runs (`key` 'runs');
   - a step you're on in someone else's run in progress: the run's card, opened on it.
   A template that comes round is never a card: its steps are done, and it's started from its row.
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

/* The step a card shows, of its open `steps` in order: where it was paged to (`page`: {id, i}), or, once that step has
   gone (done, the batch cleared), the one that came after it, now in its place, round to the first after the last;
   unpaged, the subtask of yours that brought it (`focus`), else the first. -1 with none. */
export function cardAt(steps, page, focus){
  const n = steps.length;
  if (!n) return -1;
  const k = id => steps.findIndex(s => s.id === id);
  if (page) return k(page.id) >= 0 ? k(page.id) : page.i < n ? page.i : 0;
  return Math.max(0, k(focus));
}
// Where step `s` is among all of a card's subtasks, done ones too (0 the first): its count, "3 of 5", and the segment
// marked on its line. Paging goes through the open ones only, so from 3 it goes to 4, 5, then back to 3.
export const placeOf = (all, s) => all.findIndex(x => x.id === s?.id);
// Paging a card: the step `dir` (1 the next, -1 the one before) from `i`, of `n`, round from the last to the first.
export const turnPage = (i, n, dir) => n ? ((i + dir) % n + n) % n : -1;
/* A tap on a card's line, `x` px from its left, the line `w` wide in `n` segments, each (w + 3) / n with its 3px gap, as
   the CSS cuts it: which segment, 0 the first, a gap counting with the segment before it. -1 past MANY_STEPS, where a
   step's stretch is too narrow to tap: there only the arrows and a swipe page. */
export const segmentAt = (x, w, n) => n > MANY_STEPS || !(w > 0) || !(n > 0) ? -1 : Math.min(n - 1, Math.max(0, Math.floor(x * n / (w + 3))));
/* The open step a card's segment `k` stands for, as its index among the open `steps` it pages through; -1 for a done
   one (paging skips those), or no segment. `all`: every subtask, in the order the line draws them. */
export const stepOfSegment = (all, steps, k) => k < 0 || !all[k] ? -1 : steps.findIndex(s => s.id === all[k].id);
/* A run's step's countdown on its card, to the minute, as Today redraws once a minute: "in 1h 5m", "12m late"; null more
   than a day either way, where its date says it better. `due` and `now` in ms. */
export function countdown(due, now){
  const left = due - now, min = ms => Math.max(6e4, ms);
  if (!(Math.abs(left) < 864e5)) return null;
  return left >= 0 ? {text: 'in ' + durText(min(Math.ceil(left / 6e4) * 6e4)), late: false} : {text: durText(min(Math.floor(-left / 6e4) * 6e4)) + ' late', late: true};
}
