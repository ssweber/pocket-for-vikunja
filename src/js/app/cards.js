/* Today's cards on screen (which tasks are cards, and why, is cards.js): a task with open subtasks or steps, its title
   over one line for a step, the shared row (task-row.html) with the card's own options (g.card: no Delete, no
   moving it). The card pages through its open steps on its strip only: its ‹ ›, a tap on a step's segment, or a finger
   dragged along it (cardScrub); a tick or a slide on its step line is that step's alone. A run's screen has the same
   strip on its step card (runView.card, runs.js), paged by the same code. What a card needs is read once per project
   shown, not once per card (readCards). */
import {colorOf, PRIOS, TZ} from '../util.js';
import {allPages, NetError} from '../api.js';
import {dueInfo, isLate, isSet, shortDue} from '../dates.js';
import {stepsOf, whereNext} from '../checklists.js';
import {cardAt, countdown, openSubs, placeOf, scrubTo, segmentAt, segmentOf, stepOfSegment, turnPage} from '../cards.js';
import {haptic} from '../haptics.js';
import {listViewOf, positionOrder} from '../order.js';
import {pctOf, runLine} from '../progress.js';

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
    const i = cardAt(steps, this.cardPage[t.id], c.focus, run ? this.runPick(all, done) : null), d = all.filter(done).length, step = steps[i];
    // Its line: each done step's segment full, the one showing filled by its progress (the step line has no bar of its own).
    const fill = all.map(s => done(s) ? 1 : s.id === step.id ? pctOf(s) / 100 : 0);
    const card = {id: t.id, step, i, n: steps.length, steps, at: placeOf(all, step), total: all.length, all,
      line: runLine(all.length, d, fill), lineText: `${d} of ${all.length} ${run ? 'steps' : 'subtasks'} done`};
    card.g = {depth: {}, card, line: true};
    return card;
  },
  /* A run's card picks its step by the run's own rule, as its screen does (whereNext): the next it can do now, past any
     still counting down, as Today shows it (countdown); given the step that has gone (its id), or null as it opens. */
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
  /* A card's heading on one line: its title, its priority's bars, small (it has no tick to colour), and when it's due,
     short, at the right (shortDue); the rest of cardMeta to a screen reader (`said`). */
  cardWhen(t){
    const due = shortDue(t.due_date, new Date(this.groupedAt || Date.now()));
    return {prio: t.priority || 0, due, said: this.cardMeta(t).map(m => m.label || m.text).filter(Boolean).join(', ')};
  },
  // What a card's heading says to a screen reader: when its task is due, its priority, and its project, or for a run,
  // who it's for.
  cardMeta(t){
    const out = [], due = dueInfo(t.due_date), p = this.projById.get(t.project_id);
    if (due) out.push({key: 'due', cls: 'due num ' + due.cls, text: due.label, label: (due.cls === 'overdue' ? 'Late: ' : 'Due ') + due.label});
    if (t.priority) out.push({key: 'prio', prio: t.priority, text: '', label: 'Priority: ' + PRIOS[t.priority].label});
    if (this.isRunTask(t)) out.push({key: 'run', icon: 'checklist', text: (t.assignees || []).length ? this.forText(t) : 'Checklist run'});
    else if (p) out.push({key: 'p', color: colorOf(p.hex_color), text: p.title});
    return out;
  },
  /* Paged by its ‹ ›: the step after it (dir 1) or before it (-1), stopping at the first and the last, where that arrow
     is dimmed and does nothing. A screen reader hears which. The arrows stay where they are, so the one tapped keeps the
     focus. */
  pageCard(c, dir){
    if (!c || c.n < 2) return;
    const i = turnPage(c.i, c.n, dir);
    if (i !== c.i) this.showCardStep(c, i, dir);
  },
  /* A segment of its line tapped, at the pointer's `x`: that step, if it's open (a done one is skipped, as paging skips
     it), coming in from the side it's on. Past MANY_STEPS a step's stretch is too narrow to tap, so nothing. A pointer's
     shortcut only: the arrows are a keyboard's and a screen reader's way, rather than a stop for each step. */
  tapSegment(c, x, line){
    if (!c || c.n < 2 || !line) return;
    const r = line.getBoundingClientRect(), k = segmentAt(x - r.left, r.width, c.total), i = stepOfSegment(c.all, c.steps, k);
    if (i >= 0 && i !== c.i) this.showCardStep(c, i, Math.sign(k - c.at) || 1);
  },
  /* The card on its open step `i`, coming in from the side `dir` says (or, 'none', just there, as while scrubbing); a
     screen reader hears its place among all, unless `quiet` (scrubbing, which says where it stopped: cardScrub). The run
     screen's step card (runView.card, runs.js) has the same strip: there, the step goes on the card (showStep). */
  showCardStep(c, i, dir, quiet = false){
    const s = c.steps[i];
    if (c.runScreen) this.showStep(s.i);
    else { this.cardPage[c.id] = {id: s.id, i}; entering.set(c.id, dir); }
    if (!quiet) this.said = this.stepSaid(c, s);
  },
  stepSaid(c, s = c.step){ return `Step ${placeOf(c.all, s) + 1} of ${c.total}: ${this.rowTitle(s)}`; },
  /* A finger pressed on a card's strip and dragged along it, mostly sideways (holdToSlide, app/progress.js): the step
     under it shows, the marker following, from open step to open step (scrubTo), a tick felt at each, the step line
     switching to it as it goes; let go, it stays there, and a screen reader hears where. Past MANY_STEPS too: it's a
     drag, not a tap. With one open step, nothing. On Today, the card `card`; on a run's screen, its step card (stripScrub
     with runView.card). */
  cardScrub(card){
    if (card.matches('.deleted, .lined')) return null;
    const id = +card.dataset.id;
    return this.stripScrub(card, () => { const t = this.tasks[id]; return t && this.cardOf(t, {cards: true}); });
  },
  // The strip in `el` scrubbed, `now()` giving its card as it is at each move.
  stripScrub(el, now){
    const line = el.querySelector('.card-line'), c0 = now();
    if (!c0 || c0.n < 2 || !line) return null;
    let last = 0, moved = false;
    return {el: null, page: {
      begin(){},
      move: (dx, x) => {
        const c = now(), r = line.getBoundingClientRect(), dir = Math.sign(dx - last) || 1;
        last = dx;
        const i = c ? scrubTo(c.all, c.steps, segmentOf(x - r.left, r.width, c.total), dir) : -1;
        if (i < 0 || i === c.i) return;
        haptic('tick'); this.showCardStep(c, i, 'none', true); moved = true;
      },
      end: () => { const c = moved && now(); if (c) this.said = this.stepSaid(c); },
    }};
  },
  // A tick or a slide on a card's step: the card stays at its place, so once that step has gone, the one after it comes in.
  pinCard(c){ if (c) this.cardPage[c.id] = {id: c.step.id, i: c.i}; },
  // Leaving Today: every card back on its next step.
  resetCards(){ this.cardPage = {}; entering.clear(); shownStep.clear(); },
  /* A card's step line, new to it (paged, or the step before gone with the batch): it slides in from the way it was paged,
     or fades in. Not when the card is first drawn, nor while scrubbing, nor with less motion asked for. */
  cardEntered(el, c){
    const was = shownStep.get(c.id), dir = entering.get(c.id) || 0;
    shownStep.set(c.id, c.step.id); entering.delete(c.id);
    if (was === undefined || was === c.step.id || dir === 'none' || !motion()) return;
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
