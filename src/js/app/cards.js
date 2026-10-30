/* The stacked card: a task with open subtasks, or a checklist with open steps, shown the same way wherever it is
   listed. The heading shows the title and how many subtasks are done. Under it are the open subtasks as rows
   (task-row.html), with the card's own row options (g.card). On Today and in search, a card shows only its most urgent
   row (for a checklist, its next step) and a "More" footer that opens it in place. "Less", or scrolling the card off
   the screen, collapses it again. ../cards.js decides which tasks are cards on Today. readCards reads what the cards
   need once per project, not once per card. */
import { colorOf, motion, PRIOS, TZ } from '../util.js';
import { allPages, NetError } from '../api.js';
import { dueInfo, isLate, isSet, repeats, shortDue } from '../dates.js';
import { parseStep, runWithoutDay, stepsOf, whereNext } from '../checklists.js';
import { pctOf, workedOut } from '../progress.js';
import { cardRows, countdown, openSubs, ownTask, runTop, urgentFirst } from '../cards.js';
import { listViewOf, positionOrder } from '../order.js';
import { isMovedGap } from '../lists.js';
import { completeAsk, headText, ringSaid } from '../messages.js';
import { started } from './tasks.js';
import { TASK_COUNT } from '../tasks.js';

const shownStep = new Map(); // card id -> the step last on its top row, to tell when a new one arrives
let cardIO = null; // the IntersectionObserver that collapses an opened card once it is off the screen
const closing = new Set(); // parents being closed, which stay cards until they are marked (closeParent)

export default {
  /* Task `t` in list `g` as a stacked card, or null for an ordinary row. `g.cards` says whether the list has cards.
     On Today ('today') the cards are the tasks in view.cards. In search ('found') any open task with open subtasks or
     steps is a card. On a project's list ('list') listCard decides. On every list, an open task whose subtasks are all
     done is a card with no rows and a Close button (`closes`). A ticked subtask or step stays on its card until the
     batch clears (leaving.js). The gap a moved row leaves on Today is never a card (isMovedGap). On Today a done task
     stays the card of its open subtasks, as a project's list keeps it above them, and `head` is the line that says so.

     The card is {id, run, step, steps, rows, n, peek, more, open, folds, all, ring, closes, head, project, g}.
     `step` is the top row. `steps` is the open subtasks in the card's order, and `rows` is the ones shown.
     `n` is the number of open subtasks. `peek` is the first row that "More" hides, and `more` is how many rows it
     hides. `open` says the card is expanded, and `folds` that it can be collapsed. `all` is every subtask.
     `ring` is ringOf. `g` is the options for the card's rows. */
  cardOf(t, g) {
    const kind = g?.cards;
    if (kind === 'list') return this.listCard(t, g);
    const marked = t.done && (!!this.leaving[t.id] || closing.has(t.id)),
      head = kind === 'today' && t.done && !marked && !this.isRunTask(t);
    if (!kind || isMovedGap(t) || t.pending || (t.done && !marked && !head) || this.role(t) === 'template') return null;
    const run = this.isRunTask(t),
      all = this.cardSubs(t, run),
      done = s => this.subDone(s, run);
    let steps = all.filter(s => !done(s) || this.leaving[s.id]);
    // Subtasks added from Today's box during this visit (addedRows), including ones still waiting to be sent.
    const added = kind === 'today' ? this.addedRows(t) : [];
    if (!steps.length && !added.length) return all.length && !head ? this.closingCard(t, g, run, all) : null;
    // A task that got a subtask from Today's box stays a card until the user leaves the screen, whatever its date.
    // That keeps the new subtask visible.
    if (kind === 'today' && !this.view.cards?.[t.id] && !added.length) return null;
    // A checklist's top row is its next step (runTop), then the rest in order. A task's top row is its most urgent
    // subtask.
    if (run) {
      const k = runTop(steps, this.cardPage[t.id], this.runPick(all, done));
      steps = [steps[k], ...steps.filter((_, i) => i !== k)];
    } else steps = [...steps].sort(urgentFirst(this.rowNow(), positionOrder(this.positions)));
    const n = steps.length + added.filter(a => !steps.some(s => s.id === a.t.id)).length,
      open = n > 1 && !!this.cardOpen[t.id];
    const r = cardRows(steps, added, open);
    const card = {
      id: t.id,
      run,
      step: r.step,
      steps: r.list,
      rows: r.rows,
      n,
      peek: r.peek,
      more: r.more,
      open,
      folds: true,
      all,
      ring: this.ringOf(t),
      closes: false,
      head: head ? headText(r.list.filter(s => s.pending || !done(s)).length) : null,
      project: t.project_id,
    };
    // The options for the card's rows. `line` makes a row on Today a single line (rowWhen), so a collapsed card keeps
    // its height while its steps are ticked. `key` lets a row under the Today heading leave out the word "Today".
    // `reschedule` lets holding a row move the card to another day.
    card.g = { depth: {}, card, line: g.cards === 'today', key: g.key, delete: true, reschedule: g.reschedule };
    return card;
  },
  // An item's classes in a list with cards: has-card when it holds a card, and has-tab when the card has a footer. The
  // stylesheet spaces and rounds the items by these classes.
  itemClass(t, g) {
    const c = this.cardOf(t, g);
    return !c ? '' : c.peek || (c.open && c.folds) ? 'has-card has-tab' : 'has-card';
  },
  // A card with no rows, for a task whose subtasks are all done. It shows the header, a full ring, and "All subtasks
  // done" with a Close button.
  closingCard(t, g, run, all) {
    const card = {
      id: t.id,
      run,
      step: null,
      steps: [],
      rows: [],
      n: 0,
      peek: null,
      more: 0,
      open: false,
      folds: false,
      all,
      ring: this.ringOf(t),
      closes: true,
      head: null,
      project: t.project_id,
    };
    card.g = { depth: {}, card, key: g.key };
    return card;
  },
  /* A card on a project's list. It is always open and can't be collapsed. Its rows are the subtasks nested under it
     (g.kids), including new ones waiting to be sent. They follow List view order, or for a checklist its order line,
     and the user can reorder them there. A subtask that has open subtasks itself stays an ordinary row, with a ring
     that opens its sheet. A done task with open subtasks (g.heads) is a card with a struck-through heading.

     A task waiting to be sent and a template are never cards. The ring counts the subtasks Vikunja has and the ones
     waiting to be sent. When every subtask is done and none is waiting, the card is a closing card. */
  listCard(t, g) {
    const rows = g.kids?.get(t.id) || [];
    if (g.depth?.[t.id] || t.pending || this.role(t) === 'template') return null;
    const run = this.isRunTask(t),
      all = this.cardSubs(t, run),
      waiting = rows.filter(s => s.pending).length;
    if (!rows.length)
      return all.length && (!t.done || this.leaving[t.id] || closing.has(t.id)) && all.every(s => this.subDone(s, run))
        ? this.closingCard(t, g, run, all)
        : null;
    const card = {
      id: t.id,
      run,
      step: rows[0],
      steps: rows,
      rows,
      n: rows.length,
      peek: null,
      more: rows.length - 1,
      open: true,
      folds: false,
      all,
      ring: this.ringOf(t, waiting),
      closes: false,
      head: null,
      project: t.project_id,
    };
    // heads and tasks are getters. Reading them here would rebuild every card whenever a row was added or removed.
    card.g = {
      depth: {},
      card,
      key: g.key,
      delete: g.delete,
      reorder: g.reorder,
      get heads() {
        return g.heads;
      },
      get tasks() {
        return g.tasks;
      },
    };
    return card;
  },

  /* ---------- a parent's ring ---------- */
  /* A task with subtasks, or a checklist with steps, has a ring instead of a tick, on its card's header and on its
     row. The ring is drawn thin and never quarter-filled, so it isn't mistaken for the task's own progress. Its arc is
     the progress calculated from the subtasks (workedOut), where a done or skipped subtask counts as 100%. `waiting`
     is the number of subtasks still being sent, which count as 0%. Returns null for a task with no subtasks, a
     template, and a task waiting to be sent.

     Returns {pct, done, total, open, run, said, label}. `pct`, `done` and `total` come from workedOut. `open` is the
     number of subtasks not done. `said` is the sentence a screen reader reads. `label` is the name of what tapping the
     ring does. */
  ringOf(t, waiting = 0) {
    if (!t || t.pending || this.role(t) === 'template') return null;
    const run = this.isRunTask(t),
      all = this.cardSubs(t, run);
    if (!all.length && !waiting) return null;
    const w = workedOut([
      ...all.map(s => ({ done: this.subDone(s), pct: pctOf(s) })),
      ...Array.from({ length: waiting }, () => ({ done: false, pct: 0 })),
    ]);
    const open = w.total - w.done,
      what = run ? 'step' : 'subtask',
      n = (k, x) => `${k} ${x}${k === 1 ? '' : 's'}`,
      title = `“${t.title}”`;
    const label = t.done
      ? 'Mark not done: ' + t.title
      : !open
        ? `Close ${title}: all its ${what}s are done`
        : run
          ? `Finish ${title}, with ${n(open, 'step')} not done`
          : repeats(t)
            ? 'Mark done: ' + t.title
            : `Complete ${title} and its ${n(open, 'open subtask')}`;
    return { ...w, open, run, said: ringSaid(w.done, w.total, what, w.pct), label };
  },
  // A row shows a ring instead of its tick for a checklist, done or not, and for an open task with subtasks. Rows in a
  // sheet and a checklist's steps have no ring. A checklist's own row at the top of its screen gets that screen's ring
  // (runRing).
  rowRing(t, g) {
    if (g.top) return this.runRing;
    return g.run || g.sheet || (t.done && !this.isRunTask(t)) ? null : this.ringOf(t);
  },
  /* Runs when the user taps a parent's ring, swipes its header or row all the way right, or taps Close. Nothing closes
     without the user knowing. A single open subtask closes with the parent, and the user can undo it. Two or more open
     subtasks, or a checklist with steps not done, make Pocket ask first (askComplete). A parent marked done in place
     and waiting for the batch is unmarked. A done parent is reopened. A repeating task is marked done, which moves it
     to its next date and leaves its subtasks as they are. `el` is its card or row. `sheet` is true when the tap came
     from its own sheet. */
  async ringTap(t, el = null, sheet = false) {
    const back = this.unmark(t.id);
    if (back) return back;
    const r = this.ringOf(t);
    if (!r || !this.canWrite(t.project_id) || this.lines[t.id]) return;
    if (t.done) return this.isRunTask(t) ? this.tickRunTask(t, el) : this.toggleDone(t, el, sheet ? { sheet } : {});
    const closable = r.run ? [] : this.closable(t);
    if (r.open && (r.run || r.open > 1 || closable.length !== 1) && !repeats(t)) return this.askComplete(t, sheet);
    return this.closeParent(t, el, { sheet, close: !!closable.length });
  },
  // The open subtasks that close with the task. A repeating subtask is left out, because marking it done would only
  // move it to its next date.
  closable(t) {
    return this.cardSubs(t, false).filter(s => !s.done && !repeats(s));
  },
  /* Close a parent, and its open subtasks if `close` is true. Its card or row shows as done in place until the batch
     clears, and tapping its ring undoes it, as for a ticked row. From its sheet, or with no row on screen, a message
     offers the undo instead. The task stays a card until then (closing). A checklist is finished instead. */
  async closeParent(t, el, { sheet = false, close = false } = {}) {
    if (this.isRunTask(t)) return this.tickRunTask(t, sheet ? null : el);
    closing.add(t.id);
    try {
      await this.toggleDone(t, sheet ? null : el, { close, sheet: sheet || !el });
    } finally {
      closing.delete(t.id);
    }
  },
  /* Ask before completing, in a sheet (sheet/complete.html). For a task, the question is "Complete “Pack the van”?"
     and it names the open subtasks that close with the task (completeAsk). For a checklist, the question is "Finish
     this checklist with 2 steps not done?", and finishing leaves its steps as they are. `back` is true when the
     question was asked from the parent's own sheet, which Cancel returns to. */
  askComplete(t, back = false) {
    const run = this.isRunTask(t),
      subs = this.cardSubs(t, run).filter(s => !this.subDone(s, run));
    const open = subs.map(s => ({
      id: s.id,
      title: run ? parseStep(s.title).title : s.title,
      stays: !run && repeats(s),
    }));
    const n = run ? open.length : this.closable(t).length,
      title = run ? runWithoutDay(t.title, t.created) : t.title;
    this.openSheet('complete');
    this.sheet.complete = {
      id: t.id,
      task: t,
      run,
      back,
      title,
      open,
      n,
      stay: open.length - n,
      ask: completeAsk({ title, run, names: open.filter(s => !s.stays).map(s => s.title), stay: open.length - n }),
    };
  },
  // The user confirmed: complete the parent and its open subtasks, or finish the checklist. If the question came from
  // the checklist's own screen (`screen`), the checklist finishes as the Finish button does.
  async confirmComplete() {
    const c = this.sheet.complete;
    if (!c) return;
    const t = this.tasks[c.id] || c.task;
    this.closeSheet(true);
    if (c.screen) return this.finishRun();
    await this.closeParent(t, this.rowEl(t.id), { close: !c.run });
  },
  cancelComplete() {
    const c = this.sheet.complete;
    if (c?.back) this.openTask(c.id);
    else this.closeSheet();
  },
  /* The gesture options for a swipe on a parent's header or row. A parent has no progress of its own, so a swipe right
     springs back unless it goes all the way, which counts as a tap on the ring. A swipe left shows Delete, where the
     list has one. Returns {} for a done parent and a read-only one. `shown` is the element that gets marked done.
     `sheet` is true for the parent's own row in its sheet. */
  ringSwipe(t, el, shown = el, sheet = false) {
    if (t.done || !this.canWrite(t.project_id)) return {};
    return {
      start: 0,
      one: true,
      springs: true,
      width: el.clientWidth,
      finish: pct => {
        if (pct === 100) this.ringTap(t, sheet ? null : shown, sheet);
      },
    };
  },
  // Returns the function that picks a checklist card's top row by the checklist's own rule (whereNext). The pick is the
  // next open step in order, a step that is counting down, or a timed step whose time has come. The function takes the
  // id of the step that just left the card, or null when the card opens.
  runPick(all, done) {
    return from => {
      const now = this.rowNow();
      const facts = all.map(s => {
        const due = isSet(s.due_date) ? +new Date(s.due_date) : Infinity;
        return { id: s.id, done: done(s), counting: !!countdown(due, now), dueAt: due };
      });
      return all[whereNext(facts, now, from === null ? null : { id: from })]?.id ?? null;
    };
  },
  // All of a card's subtasks in order: a checklist's by its order line, a task's by List view position. Each is its
  // own row where there is one (subRow).
  cardSubs(t, run = this.isRunTask(t)) {
    const subs = run ? stepsOf(t) : [...(t.related_tasks?.subtask || [])].sort(positionOrder(this.positions));
    return subs.map(s => this.subRow(s));
  },
  // Whether a subtask is done. A checklist step's tick still waiting to be sent is on its row already.
  subDone(s) {
    return !!s.done;
  },
  /* A card's heading, computed once per card (list-item.html). It holds the title (for a checklist, without the day it
     was started), small priority bars, a short due date and the project's colour dot. The due date is left out for a
     task due today with no time, under the Today heading. The dot shows on Today and in search, not on the project's
     own list. `said` is the text a screen reader reads: whether the task is done with subtasks still open, the ring's
     count, the due date, the priority, and the project (for a checklist, who it is for). */
  cardHead(t, g) {
    const run = this.isRunTask(t),
      when = dueInfo(t.due_date),
      p = this.projById.get(t.project_id);
    const said = [
      t.done && 'Done, with subtasks still open',
      this.ringOf(t)?.said,
      when && (when.cls === 'overdue' ? 'Late: ' : 'Due ') + when.label,
      t.priority && 'Priority: ' + PRIOS[t.priority].label,
      run ? ((t.assignees || []).length ? this.forText(t) : 'Checklist') : this.route.name !== 'project' && p?.title,
    ];
    return {
      title: run ? runWithoutDay(t.title, t.created) : this.rowTitle(t),
      prio: t.priority || 0,
      due: shortDue(t.due_date, new Date(this.rowNow()), { underToday: g?.key === 'today' }),
      color: p && this.route.name !== 'project' ? colorOf(p.hex_color) : null,
      said: said.filter(Boolean).join(', '),
    };
  },
  // After the user ticks or swipes a card's row, a checklist's card keeps that row on top until it has left the card.
  // Then the card picks the next row from there (runTop).
  pinCard(c) {
    if (c?.step) this.cardPage[c.id] = c.step.id;
  },
  // The subtasks added to a card from Today's box during this visit (cardAdded), as rows. Each has `after`, the row it
  // was added under. A subtask still waiting to be sent is its waiting row, and a sent subtask is its task. A subtask
  // that is done or deleted is left out, unless it is marked and waiting for the batch.
  addedRows(t) {
    const rows = this.cardAdded[t.id] || [],
      waiting = rows.some(a => typeof a.id === 'string') ? this.pendingTasks : [];
    return rows
      .map(a => ({ t: typeof a.id === 'string' ? waiting.find(x => x.id === a.id) : this.tasks[a.id], after: a.after }))
      .filter(a => a.t && (a.t.pending || !a.t.done || this.leaving[a.t.id]));
  },
  // When the user leaves the screen, every card goes back to its next step and collapses.
  resetCards() {
    this.cardPage = {};
    this.cardOpen = {};
    this.cardAdded = {};
    shownStep.clear();
  },
  // Open the card in place when the user taps More. watchCard collapses it again once it is off the screen.
  openCard(c) {
    this.cardOpen[c.id] = true;
  },
  // Collapse a card, from Less or from watchCard. A card above the viewport shrinks without moving what the user is
  // looking at, so the page scrolls by the difference in height. The browser may already do this, and then the
  // difference is 0.
  foldCard(id, el = null) {
    const was = el?.getBoundingClientRect().bottom;
    delete this.cardOpen[id];
    if (el && was <= 0)
      this.$nextTick(() => {
        const d = el.getBoundingClientRect().bottom - was;
        if (d && el.isConnected) scrollBy(0, d);
      });
  },
  // Watch an opened card so it collapses once it is off the screen.
  watchCard(el) {
    if (!window.IntersectionObserver) return;
    cardIO ||= new IntersectionObserver(es => {
      for (const e of es)
        if (!e.isIntersecting) {
          cardIO.unobserve(e.target);
          if (this.cardOpen[e.target.dataset.id]) this.foldCard(e.target.dataset.id, e.target);
        }
    });
    cardIO.observe(el);
  },
  // A collapsed card's new top row slides up from under it after the previous top row leaves with the batch. It does
  // not slide when the card is first drawn, when the card is open, or with reduced motion.
  cardEntered(el, c, t) {
    if (t.id !== c.step.id) return;
    const was = shownStep.get(c.id);
    shownStep.set(c.id, t.id);
    if (c.open || was === undefined || was === t.id || !motion()) return;
    el.animate(
      [
        { transform: 'translateY(24px)', opacity: 0 },
        { transform: 'none', opacity: 1 },
      ],
      { duration: 200, easing: 'ease-out' },
    );
  },
  /* Whether Today shows task `t` (listGroups), by the settings of its project and labels (todayFilter). None hides it.
     Yours keeps only the user's own tasks, and a card with an open subtask of theirs. A moved row's gap goes with its
     task. view.groups still holds the hidden tasks, so whatever acts on Today's tasks (Move all, the badge, due
     alerts) asks this too. */
  todayShows(t) {
    if (isMovedGap(t)) t = this.tasks[t.gapOf] || t;
    const f = this.todayFilter,
      sets = [f['p' + t.project_id]?.set, ...(t.labels || []).map(l => f['l' + l.id]?.set)];
    if (sets.includes('none')) return false;
    if (!sets.includes('yours') || ownTask(t, this.user)) return true;
    return !!this.view.cards?.[t.id] && this.cardSubs(t).some(s => !s.done && ownTask(s, this.user));
  },
  // The tasks that Move all to today moves: each overdue row Today shows (todayShows), and for an overdue card the task
  // and its overdue open subtasks. A checklist card moves nothing, because the checklist times its own steps. A done task's date no longer
  // places it, so it stays as it is.
  get overdueTasks() {
    const g = this.view.groups.find(x => x.key === 'overdue'),
      late = x => !x.done && isSet(x.due_date) && isLate(x.due_date);
    return (g?.tasks || [])
      .filter(t => this.todayShows(t))
      .flatMap(t =>
        !this.view.cards?.[t.id] ? [t] : this.isRunTask(t) ? [] : [t, ...this.cardSubs(t, false)].filter(late),
      );
  },

  /* Read what Today's cards need beyond what Today already read (`known`): each card's task, and its open subtasks
     with their assignees and List view positions. This makes one request per project that has cards, to the project's
     List view. `expand=subtasks` returns each task's subtasks with their positions. Checklists and their steps were
     already read with Today (loadRunIndex). A last request reads whatever is still missing: a done task, a task in a
     project with no List view, or a subtask in another project. Returns {parents, steps, positions}, where `steps` is
     the open subtasks. */
  async readCards(cards, known) {
    const have = new Map(known.map(t => [t.id, t])),
      positions = {},
      ids = [...cards.keys()],
      at = started();
    const keep = list => {
      this.change(w => w.read(list, TASK_COUNT, at));
      for (const t of list) have.set(t.id, t);
    };
    const q = list =>
      '/tasks?' +
      new URLSearchParams({ filter: 'id in ' + list.join(', '), filter_timezone: TZ, expand: 'comment_count' });
    const quietly = p =>
      p.catch(e => {
        if (e instanceof NetError) throw e;
        return [];
      });
    const byProject = new Map();
    for (const id of ids) {
      const t = have.get(id),
        pid = t?.project_id ?? cards.get(id).project;
      if (t && this.isRunTask(t)) continue;
      // Include done subtasks, because a card shows "3 of 5" counted over all of them.
      byProject.set(pid, [...(byProject.get(pid) || []), id, ...(t?.related_tasks?.subtask || []).map(s => s.id)]);
    }
    await Promise.all(
      [...byProject].map(async ([pid, list]) => {
        const lv = listViewOf(this.projById.get(pid));
        if (!lv) return;
        const got = await quietly(
          allPages(
            `/projects/${pid}/views/${lv.id}/tasks?expand=subtasks&` +
              new URLSearchParams({ filter: 'id in ' + list.join(', '), filter_timezone: TZ, expand: 'comment_count' }),
          ),
        );
        for (const t of got) positions[t.id] = t.position || 0;
        keep(got);
      }),
    );
    const missing = ids.filter(id => !have.has(id));
    if (missing.length) keep(await quietly(allPages(q(missing))));
    const parents = ids.map(id => have.get(id)).filter(Boolean);
    const subs = parents.flatMap(openSubs).map(s => s.id),
      unread = subs.filter(id => !have.has(id));
    if (unread.length) keep(await quietly(allPages(q(unread))));
    return { parents, steps: subs.map(id => have.get(id)).filter(Boolean), positions };
  },
};
