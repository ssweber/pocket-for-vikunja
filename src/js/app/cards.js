/* The stacked card (parent-tasks-plan, part 2): a task with open subtasks, or a run with open steps, is one component
   wherever it's listed. Its heading (its title, which opens the task, and its count, the subtasks done of all of them),
   then its open subtasks on the shared row (task-row.html) with the card's own options (g.card), each acting as any
   row does. On Today and in search it's collapsed: its top row, the most urgent (a run's, its next step), and under it
   a peek at the next, a tap opening it in place; opened, it collapses again once scrolled off the screen, or by Show
   less. Which tasks are cards on Today, and why, is cards.js; what a card needs is read once per project shown, not
   once per card (readCards). */
import {PRIOS, TZ} from '../util.js';
import {allPages, NetError} from '../api.js';
import {dueInfo, isLate, isSet, shortDue} from '../dates.js';
import {hasTemplateLabel, runWithoutDay, stepsOf, whereNext} from '../checklists.js';
import {countdown, openSubs, runTop, urgentFirst} from '../cards.js';
import {listViewOf, positionOrder} from '../order.js';

const shownStep = new Map();                     // card id -> the step on its top row last, to tell a new one
let cardIO = null;                               // what tells when an opened card is scrolled off the screen
const motion = () => !matchMedia('(prefers-reduced-motion: reduce)').matches;

export default {
  /* Task `t`, in list `g`, as a stacked card: null for any other row, and for one with no open subtask left, which is
     then a row like any other. Where its list has cards (g.cards, screenRows): on Today ('today') the tasks Today brought
     as cards (view.cards); in search ('found') any open task with open subtasks or steps. {id, run, step: its top row,
     steps: its open subtasks in the card's order (a step ticked stays, done, until the batch clears: leaving.js), rows:
     those shown (the top one; opened, all), n, peek: the next, shown under a collapsed card, more: how many it stands
     for, open, folds: whether it can be collapsed, all: every subtask, done ones too, done, total (its count), g: its
     rows' options (a row's on that screen: Delete; on Today, one line)}. */
  cardOf(t, g){
    const kind = g?.cards;
    if (!kind || t.pending || t.done || (kind === 'today' ? !this.view.cards?.[t.id] : hasTemplateLabel(t))) return null;
    const run = this.isRunTask(t), all = this.cardSubs(t, run), done = s => this.subDone(s, run);
    let steps = all.filter(s => !done(s) || this.leaving[s.id]);
    if (!steps.length) return null;
    // A run's top row is its next step, by its own rule, then the rest in its order; a task's, the most urgent.
    if (run) { const k = runTop(steps, this.cardPage[t.id], this.runPick(all, done)); steps = [steps[k], ...steps.filter((_, i) => i !== k)]; }
    else steps = [...steps].sort(urgentFirst(this.rowNow(), positionOrder(this.positions)));
    const n = steps.length, open = n > 1 && !!this.cardOpen[t.id];
    const card = {id: t.id, run, step: steps[0], steps, rows: open ? steps : steps.slice(0, 1), n, peek: !open && n > 1 ? steps[1] : null, more: n - 1,
      open, folds: true, all, done: all.filter(done).length, total: all.length};
    card.g = {depth: {}, card, line: g.line, key: g.key, delete: true};   // (its group: under Today's heading, "Today" goes unsaid)
    return card;
  },
  // A card's count, at the right of its heading: its subtasks done, of all of them ("1/4"; a run's skipped steps count
  // as done, as its line does), and said in words.
  cardCount(c){ return {text: `${c.done}/${c.total}`, said: `${c.done} of ${c.total} ${c.run ? 'steps' : 'subtasks'} done`}; },
  /* A run's card picks its top row by the run's own rule, as its screen does (whereNext): the next open one in order,
     even counting down, or a timed one whose time has come, as Today shows it (countdown); given the step that has gone
     (its id), or null as it opens. */
  runPick(all, done){
    return from => {
      const now = this.rowNow();
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
  /* A card's heading, on one line, worked out once per card (list-item.html): its title, a run's without the day it
     was started, which its name ends with (runWithoutDay), so it reads as a task's; its priority's bars, small, as a row
     on Today has them; and when it's due, short, at the right (shortDue: nothing for today with no time under the Today
     heading, `g`'s key). A screen reader hears the rest (`said`): when it's due, in words, its priority, and its
     project, or for a run, who it's for. */
  cardHead(t, g){
    const run = this.isRunTask(t), when = dueInfo(t.due_date), p = this.projById.get(t.project_id);
    const said = [when && (when.cls === 'overdue' ? 'Late: ' : 'Due ') + when.label, t.priority && 'Priority: ' + PRIOS[t.priority].label,
      run ? ((t.assignees || []).length ? this.forText(t) : 'Checklist run') : p?.title];
    return {title: run ? runWithoutDay(t.title, t.created) : this.rowTitle(t), prio: t.priority || 0,
      due: shortDue(t.due_date, new Date(this.rowNow()), {underToday: g?.key === 'today'}), said: said.filter(Boolean).join(', ')};
  },
  // A tick or a slide on a card's row: a run's card stays on its top row until that has gone, then goes by its rule from
  // there (runTop). (A task's top row is the most urgent, which a tick doesn't change.)
  pinCard(c){ if (c) this.cardPage[c.id] = c.step.id; },
  // Leaving the screen: every card back on its next step, and collapsed.
  resetCards(){ this.cardPage = {}; this.cardOpen = {}; shownStep.clear(); },
  /* The peek tapped: the card opens in place, every open subtask listed, the rows below pushed down by that tap. It's
     watched (watchCard) to collapse again once it's off the screen. */
  openCard(c){ this.cardOpen[c.id] = true; },
  /* Collapsed again: by Show less, or (watchCard) once it's off the screen. Above it, out of sight, the screen is kept
     still as it shrinks: what's in sight doesn't move (the browser may do that itself, then this does nothing). */
  foldCard(id, el = null){
    const was = el?.getBoundingClientRect().bottom;
    delete this.cardOpen[id];
    if (el && was <= 0) this.$nextTick(() => { const d = el.getBoundingClientRect().bottom - was; if (d && el.isConnected) scrollBy(0, d); });
  },
  // An opened card that can collapse, as it's drawn: watched, so it collapses once it's off the screen.
  watchCard(el){
    if (!window.IntersectionObserver) return;
    cardIO ||= new IntersectionObserver(es => { for (const e of es) if (!e.isIntersecting) { cardIO.unobserve(e.target); if (this.cardOpen[e.target.dataset.id]) this.foldCard(e.target.dataset.id, e.target); } });
    cardIO.observe(el);
  },
  /* A collapsed card's top row, new to it (the one before gone with the batch): it slides up from where the peek was,
     fading in. Not when the card is first drawn, nor in an opened card, where the rows below close up instead, nor with
     less motion asked for. */
  cardEntered(el, c, t){
    if (t.id !== c.step.id) return;
    const was = shownStep.get(c.id);
    shownStep.set(c.id, t.id);
    if (c.open || was === undefined || was === t.id || !motion()) return;
    el.animate([{transform: 'translateY(24px)', opacity: 0}, {transform: 'none', opacity: 1}], {duration: 200, easing: 'ease-out'});
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
