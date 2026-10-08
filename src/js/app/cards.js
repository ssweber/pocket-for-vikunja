/* Today's cards on screen (which tasks are cards, and why, is cards.js): a task with open subtasks or steps, its title
   over one line for a step, the shared row (task-row.html) with the card's own options (g.card: paging, no Delete, no
   moving it). The step line pages through its open steps, by its ‹ › or a swipe, and a tick or a slide there is that
   step's alone. What a card needs is read once per project shown, not once per card (readCards). */
import {colorOf, TZ} from '../util.js';
import {allPages, NetError} from '../api.js';
import {dueInfo, isLate, isSet} from '../dates.js';
import {stepsOf} from '../checklists.js';
import {cardAt, openSubs, placeOf, turnPage} from '../cards.js';
import {listViewOf, positionOrder} from '../order.js';
import {runLine} from '../progress.js';

const entering = new Map();                      // card id -> the way its next step comes in: 1 from the right, -1 the left
const shownStep = new Map();                     // card id -> the step it showed last, to tell a new one
const motion = () => !matchMedia('(prefers-reduced-motion: reduce)').matches;

export default {
  /* A task on Today shown as a card (g.cards: Today's lists): {id, step: the step showing, i: which of its open steps,
     n: how many, steps, at: the step's place among all its subtasks, done ones too, of `total` (its count, "3 of 5", and
     the segment marked on its line), all, line: its task's line, a segment per subtask (runLine), lineText, g: the step
     line's options}; null for any other row, and for one with no open step left, which is then a row like any other. A
     step ticked stays on it, done, until the batch clears (leaving.js); then the one after it comes in. */
  cardOf(t, g){
    const c = g?.cards && this.view.cards?.[t.id];
    if (!c) return null;
    const run = this.isRunTask(t), all = this.cardSubs(t, run), done = s => this.subDone(s, run);
    const steps = all.filter(s => !done(s) || this.leaving[s.id]);
    if (!steps.length) return null;
    const i = cardAt(steps, this.cardPage[t.id], c.focus), d = all.filter(done).length;
    const card = {id: t.id, step: steps[i], i, n: steps.length, steps, at: placeOf(all, steps[i]), total: all.length, all,
      line: runLine(all.length, d), lineText: `${d} of ${all.length} ${run ? 'steps' : 'subtasks'} done`};
    card.g = {depth: {}, card, paging: steps.length > 1};
    return card;
  },
  // A card's subtasks, all of them, each the copy on screen where there's one: a run's in its order line, a task's in its
  // project's List view.
  cardSubs(t, run = this.isRunTask(t)){
    const subs = run ? stepsOf(t) : [...(t.related_tasks?.subtask || [])].sort(positionOrder(this.positions));
    return subs.map(s => this.tasks[s.id] || s);
  },
  // A subtask done; a run's step counting a tick still waiting to be sent.
  subDone(s, run){ return run ? this.stepDone(s.id, !!s.done) : !!s.done; },
  // Under a card's title: when its task is due, and its project, or for a run, who it's for.
  cardMeta(t){
    const out = [], due = dueInfo(t.due_date), p = this.projById.get(t.project_id);
    if (due) out.push({key: 'due', cls: 'due num ' + due.cls, text: due.label});
    if (this.isRunTask(t)) out.push({key: 'run', icon: 'checklist', text: (t.assignees || []).length ? this.forText(t) : 'Checklist run'});
    else if (p) out.push({key: 'p', color: colorOf(p.hex_color), text: p.title});
    return out;
  },
  /* Paged, by its ‹ › or a swipe: the step after it (dir 1) or before it (-1), round from the last to the first. A screen
     reader hears which. The arrows stay where they are, so the one tapped keeps the focus. */
  pageCard(c, dir){
    if (!c || c.n < 2) return;
    const i = turnPage(c.i, c.n, dir), s = c.steps[i];
    this.cardPage[c.id] = {id: s.id, i};
    entering.set(c.id, dir);
    this.said = `Step ${placeOf(c.all, s) + 1} of ${c.total}: ${this.rowTitle(s)}`;
  },
  pageCardOf(id, dir){ const t = this.tasks[id]; this.pageCard(t && this.cardOf(t, {cards: true}), dir); },
  // A tick or a slide on a card's step: the card stays at its place, so once that step has gone, the one after it comes in.
  pinCard(c){ if (c) this.cardPage[c.id] = {id: c.step.id, i: c.i}; },
  // Leaving Today: every card back on its next step.
  resetCards(){ this.cardPage = {}; entering.clear(); shownStep.clear(); },
  /* A card's step line, new to it (paged, or the step before gone with the batch): it slides in from the way it was paged,
     or fades in. Not when the card is first drawn, nor with less motion asked for. */
  cardEntered(el, c){
    const was = shownStep.get(c.id), dir = entering.get(c.id) || 0;
    shownStep.set(c.id, c.step.id); entering.delete(c.id);
    if (was === undefined || was === c.step.id || !motion()) return;
    el.animate([{transform: `translateX(${dir * 32}px)`, opacity: 0}, {transform: 'none', opacity: 1}], {duration: 180, easing: 'ease-out'});
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
