/* The stacked card (parent-tasks-plan, part 2): a task with open subtasks, or a run with open steps, is one component
   wherever it's listed. Its heading (its title, which opens the task, and its count, the subtasks done of all of them),
   then its open subtasks on the shared row (task-row.html) with the card's own options (g.card), each acting as any
   row does. On Today and in search it's collapsed: its top row, the most urgent (a run's, its next step), and under it
   a slim footer, "More", a tap opening it in place; opened, it collapses again once scrolled off the screen, or by
   "Less". Which tasks are cards on Today, and why, is cards.js; what a card needs is read once per project shown, not
   once per card (readCards). */
import {motion, PRIOS, TZ} from '../util.js';
import {allPages, NetError} from '../api.js';
import {dueInfo, isLate, isSet, repeats, shortDue} from '../dates.js';
import {hasTemplateLabel, parseStep, runWithoutDay, stepsOf, whereNext} from '../checklists.js';
import {pctOf, workedOut} from '../progress.js';
import {countdown, openSubs, runTop, urgentFirst} from '../cards.js';
import {listViewOf, positionOrder} from '../order.js';
import {completeAsk} from '../messages.js';

const shownStep = new Map();                     // card id -> the step on its top row last, to tell a new one
let cardIO = null;                               // what tells when an opened card is scrolled off the screen
const closing = new Set();                       // parents being closed, still cards until they're marked (closeParent)

export default {
  /* Task `t`, in list `g`, as a stacked card: null for any other row. Where its list has cards (g.cards, screenRows):
     on Today ('today') the tasks Today brought as cards (view.cards); in search ('found') any open task with open
     subtasks or steps. And anywhere, an open task (or run) whose subtasks are all done: a card with no rows, its header
     saying so with Close (`closes`: parent-tasks-plan, part 3; nothing closes behind your back). {id, run, step: its top
     row, steps: its open subtasks in the card's order (a step ticked stays, done, until the batch clears: leaving.js),
     rows: those shown (the top one; opened, all), n, peek: the next, under a collapsed card (its footer, More, shows
     for it), more: how many it stands for, open, folds: whether it can be collapsed, all: every subtask, done ones too, ring: its ring (ringOf),
     closes, g: its rows' options (a row's on that screen: Delete; on Today, one line)}. A task marked done in place
     (its ring, Close) stays a card until the batch clears. */
  cardOf(t, g){
    const kind = g?.cards;
    if (kind === 'list') return this.listCard(t, g);
    if (!kind || t.pending || (t.done && !this.leaving[t.id] && !closing.has(t.id)) || hasTemplateLabel(t)) return null;
    const run = this.isRunTask(t), all = this.cardSubs(t, run), done = s => this.subDone(s, run);
    let steps = all.filter(s => !done(s) || this.leaving[s.id]);
    if (!steps.length) return all.length ? this.closingCard(t, g, run, all) : null;
    if (kind === 'today' && !this.view.cards?.[t.id]) return null;
    // A run's top row is its next step, by its own rule, then the rest in its order; a task's, the most urgent.
    if (run) { const k = runTop(steps, this.cardPage[t.id], this.runPick(all, done)); steps = [steps[k], ...steps.filter((_, i) => i !== k)]; }
    else steps = [...steps].sort(urgentFirst(this.rowNow(), positionOrder(this.positions)));
    const n = steps.length, open = n > 1 && !!this.cardOpen[t.id];
    const card = {id: t.id, run, step: steps[0], steps, rows: open ? steps : steps.slice(0, 1), n, peek: !open && n > 1 ? steps[1] : null, more: n - 1,
      open, folds: true, all, ring: this.ringOf(t), closes: false};
    // (its group: under Today's heading, "Today" goes unsaid; on Today, a row held carries the card to another day)
    card.g = {depth: {}, card, line: g.line, key: g.key, delete: true, reschedule: g.reschedule};
    return card;
  },
  // An open task whose subtasks are all done, as a card: its header, its ring full, and "All subtasks done" with Close,
  // in place of its rows.
  closingCard(t, g, run, all){
    const card = {id: t.id, run, step: null, steps: [], rows: [], n: 0, peek: null, more: 0, open: false, folds: false, all, ring: this.ringOf(t), closes: true};
    card.g = {depth: {}, card, key: g.key};
    return card;
  },
  /* On a project's list ('list'), a card is open, and can't be collapsed: its rows are its subtasks on the list, under
     it there (g.kids: nestSubtasks), in its List view's order (a run's steps in its order line), each moved up or down
     among them as on the list, and new ones from the add box, waiting to be sent, among them. One of those with open
     subtasks of its own is a row as any, its ring for its tick (rowRing), which opens its sheet: it isn't a card itself,
     and its own subtasks aren't on this one. A task done with subtasks still open (g.heads) is a card too, its heading
     struck through. Not a task waiting to be sent, or a template. Its ring counts its subtasks as Vikunja has them, and
     those waiting to be sent. With every subtask done, and none waiting, its closing card. */
  listCard(t, g){
    const rows = g.kids?.get(t.id) || [];
    if (g.depth?.[t.id] || t.pending || hasTemplateLabel(t)) return null;
    const run = this.isRunTask(t), all = this.cardSubs(t, run), waiting = rows.filter(s => s.pending).length;
    if (!rows.length) return all.length && (!t.done || this.leaving[t.id] || closing.has(t.id)) && all.every(s => this.subDone(s, run)) ? this.closingCard(t, g, run, all) : null;
    const card = {id: t.id, run, step: rows[0], steps: rows, rows, n: rows.length, peek: null, more: rows.length - 1, open: true, folds: false,
      all, ring: this.ringOf(t, waiting), closes: false};
    card.g = {depth: {}, card, key: g.key, delete: g.delete, reorder: g.reorder, heads: g.heads, tasks: g.tasks};
    return card;
  },

  /* ---------- a parent's ring (parent-tasks-plan, part 3) ---------- */
  /* A task with subtasks, or a run with steps (a run is a parent too), has a ring instead of a tick, on its card's
     header and on its row: drawn thin, never filled by a quarter, so it isn't taken for a task's own tick, its count of
     done of all inside it. Its arc is the worked-out figure (workedOut): each subtask's progress, a done one 100%, a
     run's skipped step done too. `waiting`: subtasks being sent, counted at 0%. Null for any other task, a template, or
     one waiting to be sent. {pct, done, total, open, run, said: in words, label: what a tap does}. */
  ringOf(t, waiting = 0){
    if (!t || t.pending || hasTemplateLabel(t)) return null;
    const run = this.isRunTask(t), all = this.cardSubs(t, run);
    if (!all.length && !waiting) return null;
    const w = workedOut([...all.map(s => ({done: this.subDone(s, run), pct: run ? this.stepPct(s) : pctOf(s)})), ...Array.from({length: waiting}, () => ({done: false, pct: 0}))]);
    const open = w.total - w.done, what = run ? 'step' : 'subtask', n = (k, x) => `${k} ${x}${k === 1 ? '' : 's'}`, title = `“${t.title}”`;
    const label = t.done ? 'Mark not done: ' + t.title : !open ? `Close ${title}: all its ${what}s are done` : run ? `Finish ${title}, with ${n(open, 'step')} not done`
      : repeats(t) ? 'Mark done: ' + t.title : `Complete ${title} and its ${n(open, 'open subtask')}`;
    return {...w, open, run, said: `${w.done} of ${n(w.total, what)} done, ${w.pct}%`, label};
  },
  // A row's ring, in place of its tick: a run's, done or not, and an open task's with subtasks, wherever it's listed (a
  // card's own rows too). Not in a sheet, nor a run's steps. A run's own row atop its screen, the screen's (runRing).
  rowRing(t, g){ if (g.top) return this.runRing; return g.run || g.sheet || (t.done && !this.isRunTask(t)) ? null : this.ringOf(t); },
  /* A parent's ring tapped, or its header (or row) swiped right all the way, or its Close (`el`: its card or row;
     `sheet`: from its own sheet). Design rules 7 and 8: nothing closes behind your back; bulk actions confirm, single
     ones undo. Marked in place, waiting for the batch: taken back. Done (a done task over its open subtasks, a finished
     run): opened again. Every subtask done: closed (Close), with Undo. A repeating task: done, which moves it to its next
     date, its subtasks as they are, as before. One open subtask: it and the parent completed, with Undo. More: asked
     first (askComplete). A run with steps not done: asked first too, as finishing it leaves them not done. */
  async ringTap(t, el = null, sheet = false){
    const back = this.unmark(t.id);
    if (back) return back;
    const r = this.ringOf(t);
    if (!r || !this.canWrite(t.project_id) || this.lines[t.id]) return;
    if (t.done) return this.isRunTask(t) ? this.tickRunTask(t, el) : this.toggleDone(t, el, sheet ? {sheet} : {});
    const closable = r.run ? [] : this.closable(t);
    if (r.open && (r.run || r.open > 1 || closable.length !== 1) && !repeats(t)) return this.askComplete(t, sheet);
    return this.closeParent(t, el, {sheet, close: !!closable.length});
  },
  // A task's open subtasks its completion closes: not one that repeats (done, it would only move to its next date).
  closable(t){ return this.cardSubs(t, false).filter(s => !s.done && !repeats(s)); },
  /* A parent done: closed (its open subtasks with it, `close`), its card or row a gap with Undo until the batch clears;
     from its sheet, or with no row of it on screen, said with an Undo. A run's is its finish. It stays a card meanwhile
     (closing). */
  async closeParent(t, el, {sheet = false, close = false} = {}){
    if (this.isRunTask(t)) return this.tickRunTask(t, sheet ? null : el);
    closing.add(t.id);
    try { await this.toggleDone(t, sheet ? null : el, {gap: !sheet && !!el, close, sheet: sheet || !el}); }
    finally { closing.delete(t.id); }
  },
  /* The question, in a sheet of its own (sheet/complete.html): "Complete “Pack the van”?", the open subtasks completed
     with it named in a sentence (completeAsk, messages.js); for a run, "Finish this run with 2 steps not done?", which
     leaves them not done, as finishing a run always has (a run's steps are ticked on its screen, with who did each).
     `back`: asked from the parent's own sheet, which Cancel goes back to. */
  askComplete(t, back = false){
    const run = this.isRunTask(t), subs = this.cardSubs(t, run).filter(s => !this.subDone(s, run));
    const open = subs.map(s => ({id: s.id, title: run ? parseStep(s.title).title : s.title, stays: !run && repeats(s)}));
    const n = run ? open.length : this.closable(t).length, title = run ? runWithoutDay(t.title, t.created) : t.title;
    this.openSheet('complete');
    this.sheet.complete = {id: t.id, task: t, run, back, title, open, n, stay: open.length - n,
      ask: completeAsk({title, run, names: open.filter(s => !s.stays).map(s => s.title), stay: open.length - n})};
  },
  /* Confirmed: the parent and its open subtasks completed (a run finished), shown on its card or row as a tap would.
     Asked on the run's own screen (`screen`, runRingTap): finished as its Finish run does, off its screen, with Undo. */
  async confirmComplete(){
    const c = this.sheet.complete;
    if (!c) return;
    const t = this.tasks[c.id] || c.task;
    this.closeSheet(true);
    if (c.screen) return this.finishRun();
    await this.closeParent(t, this.rowEl(t.id), {close: !c.run});
  },
  cancelComplete(){ const c = this.sheet.complete; if (c?.back) this.openTask(c.id); else this.closeSheet(); },
  /* A parent's header swiped (cardGesture), or a parent's row (rowGesture): right, it has no progress of its own to set,
     so it springs back unless it's swiped all the way, which is its ring's tap (ringTap); left, its Delete, where its
     list has one. Not a done one, nor one shared with you to read. `shown`: where it's marked done (a header's card);
     `sheet`: the parent's own row in its sheet, which asks from there (sheetRowGesture). */
  ringSwipe(t, el, shown = el, sheet = false){
    if (t.done || !this.canWrite(t.project_id)) return {};
    return {start: 0, one: true, springs: true, width: el.clientWidth, finish: pct => { if (pct === 100) this.ringTap(t, sheet ? null : shown, sheet); }};
  },
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
     heading, `g`'s key). A screen reader hears the rest (`said`): done, on a project's list over subtasks still open;
     when it's due, in words, its priority, and its project (not on its own list), or for a run, who it's for. */
  cardHead(t, g){
    const run = this.isRunTask(t), when = dueInfo(t.due_date), p = this.projById.get(t.project_id);
    const said = [t.done && 'Done, with subtasks still open', this.ringOf(t)?.said, when && (when.cls === 'overdue' ? 'Late: ' : 'Due ') + when.label, t.priority && 'Priority: ' + PRIOS[t.priority].label,
      run ? ((t.assignees || []).length ? this.forText(t) : 'Checklist run') : this.route.name !== 'project' && p?.title];
    return {title: run ? runWithoutDay(t.title, t.created) : this.rowTitle(t), prio: t.priority || 0,
      due: shortDue(t.due_date, new Date(this.rowNow()), {underToday: g?.key === 'today'}), said: said.filter(Boolean).join(', ')};
  },
  // A tick or a slide on a card's row: a run's card stays on its top row until that has gone, then goes by its rule from
  // there (runTop). (A task's top row is the most urgent, which a tick doesn't change.)
  pinCard(c){ if (c?.step) this.cardPage[c.id] = c.step.id; },
  // Leaving the screen: every card back on its next step, and collapsed.
  resetCards(){ this.cardPage = {}; this.cardOpen = {}; shownStep.clear(); },
  /* Its footer's More tapped: the card opens in place, every open subtask listed, the rows below pushed down by that tap. It's
     watched (watchCard) to collapse again once it's off the screen. */
  openCard(c){ this.cardOpen[c.id] = true; },
  /* Collapsed again: by its footer's Less, or (watchCard) once it's off the screen. Above it, out of sight, the screen is kept
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
  /* A collapsed card's top row, new to it (the one before gone with the batch): it slides up from under it,
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
