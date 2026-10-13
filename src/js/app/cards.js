/* The stacked card: a task with open subtasks, or a run with open steps, shown the same way wherever it is listed. Its
   heading has the title and the count of subtasks done, then its open subtasks as rows (task-row.html) with the card's
   own row options (g.card). On Today and in search the card is collapsed to its most urgent row (a run's next step)
   with a "More" footer that opens it in place. It collapses again by "Less" or once scrolled off the screen. Which
   tasks are cards on Today is decided in cards.js. readCards reads what a card needs once per project, not per card. */
import {colorOf, motion, PRIOS, TZ} from '../util.js';
import {allPages, NetError} from '../api.js';
import {dueInfo, isLate, isSet, repeats, shortDue} from '../dates.js';
import {hasTemplateLabel, parseStep, runWithoutDay, stepsOf, whereNext} from '../checklists.js';
import {pctOf, workedOut} from '../progress.js';
import {cardRows, countdown, openSubs, runTop, urgentFirst} from '../cards.js';
import {listViewOf, positionOrder} from '../order.js';
import {completeAsk} from '../messages.js';

const shownStep = new Map();                     // card id -> the step last on its top row, to tell when a new one arrives
let cardIO = null;                               // the IntersectionObserver that collapses an opened card once it is off the screen
const closing = new Set();                       // parents being closed, still cards until they're marked (closeParent)

export default {
  /* Task `t` in list `g` as a stacked card, or null for an ordinary row. Which lists have cards is `g.cards`: on Today
     ('today') the tasks Today brought as cards (view.cards), in search ('found') any open task with open subtasks or
     steps, on a project's list ('list') listCard. Anywhere, an open task whose subtasks are all done is a card with
     no rows and a Close button (`closes`). A task ticked in place, or a step, stays on its card until the batch clears
     (leaving.js). The card: {id, run, step: the top row, steps: the open subtasks in the card's order, rows: those
     shown, n, peek: the next one under a collapsed card, more: how many it stands for, open, folds: whether it can be
     collapsed, all: every subtask, ring: ringOf, closes, project, g: the rows' options}. */
  cardOf(t, g){
    const kind = g?.cards;
    if (kind === 'list') return this.listCard(t, g);
    if (!kind || t.pending || (t.done && !this.leaving[t.id] && !closing.has(t.id)) || hasTemplateLabel(t)) return null;
    const run = this.isRunTask(t), all = this.cardSubs(t, run), done = s => this.subDone(s, run);
    let steps = all.filter(s => !done(s) || this.leaving[s.id]);
    // Subtasks added from Today's box this visit, each where the box was (addedRows), including ones still waiting to send.
    const added = kind === 'today' ? this.addedRows(t) : [];
    if (!steps.length && !added.length) return all.length ? this.closingCard(t, g, run, all) : null;
    // A task given a subtask from Today's box stays a card until the screen is left, whatever its date, so what was added stays in sight.
    if (kind === 'today' && !this.view.cards?.[t.id] && !added.length) return null;
    // A run's top row is its next step (runTop), then the rest in order. A task's top row is the most urgent.
    if (run) { const k = runTop(steps, this.cardPage[t.id], this.runPick(all, done)); steps = [steps[k], ...steps.filter((_, i) => i !== k)]; }
    else steps = [...steps].sort(urgentFirst(this.rowNow(), positionOrder(this.positions)));
    const n = steps.length + added.filter(a => !steps.some(s => s.id === a.t.id)).length, open = n > 1 && !!this.cardOpen[t.id];
    const r = cardRows(steps, added, open);
    const card = {id: t.id, run, step: r.step, steps: r.list, rows: r.rows, n, peek: r.peek, more: r.more,
      open, folds: true, all, ring: this.ringOf(t), closes: false, project: t.project_id};
    // The rows' options. `key` lets a row under the Today heading leave "Today" unsaid; `reschedule` lets a held row move the card to another day.
    card.g = {depth: {}, card, line: g.line, key: g.key, delete: true, reschedule: g.reschedule};
    return card;
  },
  // A card with no rows, for a task whose subtasks are all done: its header, a full ring, and "All subtasks done" with
  // Close.
  closingCard(t, g, run, all){
    const card = {id: t.id, run, step: null, steps: [], rows: [], n: 0, peek: null, more: 0, open: false, folds: false, all, ring: this.ringOf(t), closes: true, project: t.project_id};
    card.g = {depth: {}, card, key: g.key};
    return card;
  },
  /* A card on a project's list. It is always open and can't be collapsed. Its rows are the subtasks nested under it
     (g.kids) in List view order (a run's steps in its order line), which can be reordered there, with new ones waiting
     to send among them. A subtask with open subtasks of its own stays an ordinary row, with a ring that opens its
     sheet. A done task over open subtasks (g.heads) is a card with its heading struck through. Not a task waiting to be
     sent, nor a template. The ring counts the subtasks Vikunja has and those waiting to be sent. With every subtask
     done and none waiting, the closing card. */
  listCard(t, g){
    const rows = g.kids?.get(t.id) || [];
    if (g.depth?.[t.id] || t.pending || hasTemplateLabel(t)) return null;
    const run = this.isRunTask(t), all = this.cardSubs(t, run), waiting = rows.filter(s => s.pending).length;
    if (!rows.length) return all.length && (!t.done || this.leaving[t.id] || closing.has(t.id)) && all.every(s => this.subDone(s, run)) ? this.closingCard(t, g, run, all) : null;
    const card = {id: t.id, run, step: rows[0], steps: rows, rows, n: rows.length, peek: null, more: rows.length - 1, open: true, folds: false,
      all, ring: this.ringOf(t, waiting), closes: false, project: t.project_id};
    // heads and tasks are getters: reading them here would remake every card whenever a row came or went
    card.g = {depth: {}, card, key: g.key, delete: g.delete, reorder: g.reorder, get heads(){ return g.heads; }, get tasks(){ return g.tasks; }};
    return card;
  },

  /* ---------- a parent's ring ---------- */
  /* A task with subtasks, or a run with steps, has a ring instead of a tick, on its card's header and on its row. The
     ring is drawn thin and never quarter-filled, so it isn't taken for the task's own progress. Its arc is the
     computed figure (workedOut): each subtask's progress, a done or skipped one at 100%. `waiting`: subtasks being
     sent, counted at 0%. Null for a task with no subtasks, a template, or one waiting to be sent. Returns {pct, done,
     total, open, run, said: in words, label: what a tap does}. */
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
  // A row's ring in place of its tick: for a run, done or not, and for an open task with subtasks. Not in a sheet, nor
  // on a run's steps. The run's own row at the top of its screen gets the screen's ring (runRing).
  rowRing(t, g){ if (g.top) return this.runRing; return g.run || g.sheet || (t.done && !this.isRunTask(t)) ? null : this.ringOf(t); },
  /* A parent's ring tapped, its header or row swiped right all the way, or its Close. Nothing closes behind the
     user's back: one open subtask closes with the parent, with Undo; more than one, or a run with steps not done,
     asks first (askComplete). A parent marked in place and waiting for the batch is unmarked. A done parent is
     reopened. A repeating task is marked done, which moves it to its next date with its subtasks as they are. `el`:
     its card or row. `sheet`: tapped from its own sheet. */
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
  // The open subtasks that close with the task. Not a repeating one: done, it would only move to its next date.
  closable(t){ return this.cardSubs(t, false).filter(s => !s.done && !repeats(s)); },
  /* Close a parent, with its open subtasks if `close`. Its card or row shows done in place until the batch clears,
     with its ring as the undo, as a ticked row does. From its sheet, or with no row on screen, the undo is a message.
     The task stays a card meanwhile (closing). A run is finished instead. */
  async closeParent(t, el, {sheet = false, close = false} = {}){
    if (this.isRunTask(t)) return this.tickRunTask(t, sheet ? null : el);
    closing.add(t.id);
    try { await this.toggleDone(t, sheet ? null : el, {close, sheet: sheet || !el}); }
    finally { closing.delete(t.id); }
  },
  /* Ask before completing, in a sheet of its own (sheet/complete.html). "Complete “Pack the van”?" names the open
     subtasks that close with it (completeAsk). For a run, "Finish this run with 2 steps not done?": finishing a run
     leaves its steps as they are. `back`: asked from the parent's own sheet, which Cancel returns to. */
  askComplete(t, back = false){
    const run = this.isRunTask(t), subs = this.cardSubs(t, run).filter(s => !this.subDone(s, run));
    const open = subs.map(s => ({id: s.id, title: run ? parseStep(s.title).title : s.title, stays: !run && repeats(s)}));
    const n = run ? open.length : this.closable(t).length, title = run ? runWithoutDay(t.title, t.created) : t.title;
    this.openSheet('complete');
    this.sheet.complete = {id: t.id, task: t, run, back, title, open, n, stay: open.length - n,
      ask: completeAsk({title, run, names: open.filter(s => !s.stays).map(s => s.title), stay: open.length - n})};
  },
  // Confirmed: complete the parent and its open subtasks, or finish the run. Asked on the run's own screen
  // (`screen`), it finishes as the Finish button does.
  async confirmComplete(){
    const c = this.sheet.complete;
    if (!c) return;
    const t = this.tasks[c.id] || c.task;
    this.closeSheet(true);
    if (c.screen) return this.finishRun();
    await this.closeParent(t, this.rowEl(t.id), {close: !c.run});
  },
  cancelComplete(){ const c = this.sheet.complete; if (c?.back) this.openTask(c.id); else this.closeSheet(); },
  /* A parent's header or row swiped. Right: it has no progress of its own, so it springs back unless swiped all the
     way, which counts as a ring tap. Left: Delete, where the list has one. Not a done parent, nor a read-only one.
     `shown`: the element marked done. `sheet`: the parent's own row in its sheet. */
  ringSwipe(t, el, shown = el, sheet = false){
    if (t.done || !this.canWrite(t.project_id)) return {};
    return {start: 0, one: true, springs: true, width: el.clientWidth, finish: pct => { if (pct === 100) this.ringTap(t, sheet ? null : shown, sheet); }};
  },
  // How a run's card picks its top row, by the run's own rule (whereNext): the next open step in order, one counting
  // down, or a timed one whose time has come. Given the id of the step that has gone, or null as the card opens.
  runPick(all, done){
    return from => {
      const now = this.rowNow();
      const facts = all.map(s => { const due = isSet(s.due_date) ? +new Date(s.due_date) : Infinity; return {id: s.id, done: done(s), counting: !!countdown(due, now), dueAt: due}; });
      return all[whereNext(facts, now, from === null ? null : {id: from})]?.id ?? null;
    };
  },
  // All of a card's subtasks in order (a run's by its order line, a task's by List view position), each the copy on
  // screen where there is one.
  cardSubs(t, run = this.isRunTask(t)){
    const subs = run ? stepsOf(t) : [...(t.related_tasks?.subtask || [])].sort(positionOrder(this.positions));
    return subs.map(s => this.tasks[s.id] || s);
  },
  // Whether a subtask is done. A run's step counts a tick still waiting to be sent.
  subDone(s, run){ return run ? this.stepDone(s.id, !!s.done) : !!s.done; },
  /* A card's heading, computed once per card (list-item.html): the title (a run's without the day it was started),
     small priority bars, a short due date (nothing for today with no time under the Today heading), and the project's
     colour dot on Today and in search, not on the project's own list. `said` is what a screen reader hears: done over
     open subtasks, the ring's count, the due date, the priority, and the project or who a run is for. */
  cardHead(t, g){
    const run = this.isRunTask(t), when = dueInfo(t.due_date), p = this.projById.get(t.project_id);
    const said = [t.done && 'Done, with subtasks still open', this.ringOf(t)?.said, when && (when.cls === 'overdue' ? 'Late: ' : 'Due ') + when.label, t.priority && 'Priority: ' + PRIOS[t.priority].label,
      run ? ((t.assignees || []).length ? this.forText(t) : 'Checklist') : this.route.name !== 'project' && p?.title];
    return {title: run ? runWithoutDay(t.title, t.created) : this.rowTitle(t), prio: t.priority || 0,
      due: shortDue(t.due_date, new Date(this.rowNow()), {underToday: g?.key === 'today'}),
      color: p && this.route.name !== 'project' ? colorOf(p.hex_color) : null, said: said.filter(Boolean).join(', ')};
  },
  // After a tick or a slide on a card's row, a run's card keeps its top row until that row has gone, then picks the
  // next from there (runTop).
  pinCard(c){ if (c?.step) this.cardPage[c.id] = c.step.id; },
  // The subtasks added to a card from Today's box this visit (cardAdded) as rows, each with the row it went under. One
  // still on its way is its waiting row, one sent is its task. One done or deleted is left out.
  addedRows(t){
    const rows = this.cardAdded[t.id] || [], waiting = rows.some(a => typeof a.id === 'string') ? this.pendingTasks : [];
    return rows.map(a => ({t: typeof a.id === 'string' ? waiting.find(x => x.id === a.id) : this.tasks[a.id], after: a.after}))
      .filter(a => a.t && (a.t.pending || !a.t.done || this.leaving[a.t.id]));
  },
  // On leaving the screen, every card goes back to its next step and collapses.
  resetCards(){ this.cardPage = {}; this.cardOpen = {}; this.cardAdded = {}; shownStep.clear(); },
  // More tapped: the card opens in place. watchCard collapses it again once it is off the screen.
  openCard(c){ this.cardOpen[c.id] = true; },
  // Collapse a card, by Less or by watchCard. A card above the viewport shrinks without moving what is in sight: scroll
  // by the difference (the browser may do this itself, then the difference is 0).
  foldCard(id, el = null){
    const was = el?.getBoundingClientRect().bottom;
    delete this.cardOpen[id];
    if (el && was <= 0) this.$nextTick(() => { const d = el.getBoundingClientRect().bottom - was; if (d && el.isConnected) scrollBy(0, d); });
  },
  // Watch an opened card so it collapses once it is off the screen.
  watchCard(el){
    if (!window.IntersectionObserver) return;
    cardIO ||= new IntersectionObserver(es => { for (const e of es) if (!e.isIntersecting) { cardIO.unobserve(e.target); if (this.cardOpen[e.target.dataset.id]) this.foldCard(e.target.dataset.id, e.target); } });
    cardIO.observe(el);
  },
  // A collapsed card's new top row (the one before left with the batch) slides up from under it. Not when the card is
  // first drawn, not in an opened card, and not with reduced motion.
  cardEntered(el, c, t){
    if (t.id !== c.step.id) return;
    const was = shownStep.get(c.id);
    shownStep.set(c.id, t.id);
    if (c.open || was === undefined || was === t.id || !motion()) return;
    el.animate([{transform: 'translateY(24px)', opacity: 0}, {transform: 'none', opacity: 1}], {duration: 200, easing: 'ease-out'});
  },
  // What Move all to today moves: each overdue row, and on an overdue card its task and its overdue open subtasks. A
  // run's steps are timed by the run, so they stay.
  get overdueTasks(){
    const g = this.view.groups.find(x => x.key === 'overdue'), late = x => isSet(x.due_date) && isLate(x.due_date);
    return (g?.tasks || []).flatMap(t => !this.view.cards?.[t.id] ? [t] : this.isRunTask(t) ? [] : [t, ...this.cardSubs(t, false).filter(s => !s.done)].filter(late));
  },

  /* Read what Today's cards need beyond what Today read (`known`): each card's task, and its open subtasks with their
     assignees and List view positions. One request per project with cards, to its List view (expand=subtasks returns
     each task's subtasks with their positions). A run and its steps were read with Today (loadRunIndex). Then one
     request for what is still missing: a done task, one in a project with no List view, or a subtask in another
     project. Returns {parents, steps: the open subtasks, positions}. */
  async readCards(cards, known){
    const have = new Map(known.map(t => [t.id, t])), positions = {}, ids = [...cards.keys()];
    const keep = list => { for (const t of list) have.set(t.id, t); };
    const q = list => '/tasks?' + new URLSearchParams({filter: 'id in ' + list.join(', '), filter_timezone: TZ, expand: 'comment_count'});
    const quietly = p => p.catch(e => { if (e instanceof NetError) throw e; return []; });
    const byProject = new Map();
    for (const id of ids) {
      const t = have.get(id), pid = t?.project_id ?? cards.get(id).project;
      if (t && this.isRunTask(t)) continue;
      // Done subtasks too: a card counts "3 of 5" over all of them.
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
