/* Today's cards on screen (which tasks are cards, and why, is cards.js): a task with open subtasks or steps, its title
   over one line for a step, the shared row (task-row.html) with the card's own options (g.card); a tick or a slide on
   its step line is that step's alone. Its count, the subtasks done of all of them, is at the right of its heading
   (parent-tasks-plan, part 2: the strip that paged through its steps is gone). What a card needs is read once per
   project shown, not once per card (readCards). */
import {PRIOS, TZ} from '../util.js';
import {allPages, NetError} from '../api.js';
import {dueInfo, isLate, isSet, shortDue} from '../dates.js';
import {runWithoutDay, stepsOf, whereNext} from '../checklists.js';
import {cardAt, countdown, openSubs} from '../cards.js';
import {listViewOf, positionOrder} from '../order.js';

const shownStep = new Map();                     // card id -> the step it showed last, to tell a new one
const motion = () => !matchMedia('(prefers-reduced-motion: reduce)').matches;

export default {
  /* A task on Today shown as a card (g.cards: Today's lists): {id, step: the step showing, i: which of its open steps,
     n: how many, steps, all: every subtask, done ones too, done: how many of those are done, total, g: the step line's
     options}; null for any other row, and for one with no open step left, which is then a row like any other. A step
     ticked stays on it, done, until the batch clears (leaving.js); then the one after it comes in. */
  cardOf(t, g){
    const c = g?.cards && this.view.cards?.[t.id];
    if (!c) return null;
    const run = this.isRunTask(t), all = this.cardSubs(t, run), done = s => this.subDone(s, run);
    const steps = all.filter(s => !done(s) || this.leaving[s.id]);
    if (!steps.length) return null;
    const i = cardAt(steps, this.cardPage[t.id], c.focus, run ? this.runPick(all, done) : null);
    const card = {id: t.id, step: steps[i], i, n: steps.length, steps, all, done: all.filter(done).length, total: all.length, run};
    card.g = {depth: {}, card, line: true, key: g.key};          // (its group: under Today's heading, "Today" goes unsaid)
    return card;
  },
  // A card's count, at the right of its heading: its subtasks done, of all of them ("1/4"; a run's skipped steps count
  // as done, as its line did), and said in words.
  cardCount(c){ return {text: `${c.done}/${c.total}`, said: `${c.done} of ${c.total} ${c.run ? 'steps' : 'subtasks'} done`}; },
  /* A run's card picks its step by the run's own rule, as its screen does (whereNext): the next open one in order, even
     counting down, or a timed one whose time has come, as Today shows it (countdown); given the step that has gone (its
     id), or null as it opens. */
  runPick(all, done){
    return from => {
      const now = this.groupedAt || Date.now();
      const facts = all.map(s => { const due = isSet(s.due_date) ? +new Date(s.due_date) : Infinity; return {id: s.id, done: done(s), counting: !!countdown(due, now), dueAt: due}; });
      return all[whereNext(facts, now, from === null ? null : {id: from})]?.id ?? null;
    };
  },
  // A card's subtasks, all of them, each the copy on screen where there's one: a run's in its order line, a task's in its
  // project's List view.
  cardSubs(t, run = this.isRunTask(t)){
    const subs = run ? stepsOf(t) : [...(t.related_tasks?.subtask || [])].sort(positionOrder(this.positions));
    return subs.map(s => this.tasks[s.id] || s);
  },
  // A subtask done; a run's step counting a tick still waiting to be sent.
  subDone(s, run){ return run ? this.stepDone(s.id, !!s.done) : !!s.done; },
  /* A card's heading, on one line, worked out once per card (today-item.html): its title, a run's without the day it
     was started, which its name ends with (runWithoutDay), so it reads as a task's; its priority's bars, small, as a row
     on Today has them; and when it's due, short, at the right (shortDue: nothing for today with no time under the Today
     heading, `g`'s key). A screen reader hears the rest (`said`): when it's due, in words, its priority, and its
     project, or for a run, who it's for. */
  cardHead(t, g){
    const run = this.isRunTask(t), when = dueInfo(t.due_date), p = this.projById.get(t.project_id);
    const said = [when && (when.cls === 'overdue' ? 'Late: ' : 'Due ') + when.label, t.priority && 'Priority: ' + PRIOS[t.priority].label,
      run ? ((t.assignees || []).length ? this.forText(t) : 'Checklist run') : p?.title];
    return {title: run ? runWithoutDay(t.title, t.created) : this.rowTitle(t), prio: t.priority || 0,
      due: shortDue(t.due_date, new Date(this.groupedAt || Date.now()), {underToday: g?.key === 'today'}), said: said.filter(Boolean).join(', ')};
  },
  // A tick or a slide on a card's step: the card stays at its place, so once that step has gone, the one after it comes in.
  pinCard(c){ if (c) this.cardPage[c.id] = {id: c.step.id, i: c.i}; },
  // Leaving Today: every card back on its next step.
  resetCards(){ this.cardPage = {}; shownStep.clear(); },
  /* A card's step line, new to it (the step before gone with the batch): it fades in. Not when the card is first drawn,
     nor with less motion asked for. */
  cardEntered(el, c){
    const was = shownStep.get(c.id);
    shownStep.set(c.id, c.step.id);
    if (was === undefined || was === c.step.id || !motion()) return;
    el.animate([{opacity: 0}, {opacity: 1}], {duration: 180, easing: 'ease-out'});
  },
  // What Move all to today moves: each overdue row, and on an overdue card its task and its open subtasks overdue
  // themselves. A run's steps are timed by the run, so they stay.
  get overdueTasks(){
    const g = this.view.groups.find(x => x.key === 'overdue'), late = x => isSet(x.due_date) && isLate(x.due_date);
    return (g?.tasks || []).flatMap(t => !this.view.cards?.[t.id] ? [t] : this.isRunTask(t) ? [] : [t, ...this.cardSubs(t, false).filter(s => !s.done)].filter(late));
  },

  /* What Today's cards need besides what Today read (`known`, by id): each card's task, and its open subtasks with who's
     on each and where they are in its project's List view. One request for each project with cards: its List view, for
     the cards' tasks and their subtasks (expand=subtasks gives a task's subtasks along with it, their positions too). A
     run and its steps were read with Today (loadRunIndex). Then, in one request, whatever is still missing: a task done,
     or in a project with no List view, and a subtask in another project. Returns {parents, steps: the open subtasks,
     positions}. */
  async readCards(cards, known){
    const have = new Map(known.map(t => [t.id, t])), positions = {}, ids = [...cards.keys()];
    const keep = list => { for (const t of list) have.set(t.id, t); };
    const q = list => '/tasks?' + new URLSearchParams({filter: 'id in ' + list.join(', '), filter_timezone: TZ, expand: 'comment_count'});
    const quietly = p => p.catch(e => { if (e instanceof NetError) throw e; return []; });
    const byProject = new Map();
    for (const id of ids) {
      const t = have.get(id), pid = t?.project_id ?? cards.get(id).project;
      if (t && this.isRunTask(t)) continue;
      // Its done subtasks too, for where they are: a card counts its step among all of them ("3 of 5").
      byProject.set(pid, [...(byProject.get(pid) || []), id, ...(t?.related_tasks?.subtask || []).map(s => s.id)]);
    }
    await Promise.all([...byProject].map(async ([pid, list]) => {
      const lv = listViewOf(this.projById.get(pid));
      if (!lv) return;
      const got = await quietly(allPages(`/projects/${pid}/views/${lv.id}/tasks?expand=subtasks&` + new URLSearchParams({filter: 'id in ' + list.join(', '), filter_timezone: TZ, expand: 'comment_count'})));
      for (const t of got) positions[t.id] = t.position || 0;
      keep(got);
    }));
    const missing = ids.filter(id => !have.has(id));
    if (missing.length) keep(await quietly(allPages(q(missing))));
    const parents = ids.map(id => have.get(id)).filter(Boolean);
    const subs = parents.flatMap(openSubs).map(s => s.id), unread = subs.filter(id => !have.has(id));
    if (unread.length) keep(await quietly(allPages(q(unread))));
    return {parents, steps: subs.map(id => have.get(id)).filter(Boolean), positions};
  },
};
