/* What's done to tasks, a function for each thing: ticking (done, or not done again), setting progress, deleting,
   moving, adding subtasks, people and labels, and saving a change. Each one makes the request, takes the subtasks along
   where they go too, changes what's on screen and offers the Undo, so the lists and the sheet call these, not api().
   A task is ticked one way, toggleDone, from a list or its sheet (sheetDone). A run and a run's step are ticked through
   the outbox (act, in runs.js): toggleDone hands them to tickRunTask and tickRunStep, and a run finished with steps not
   done leaves them not done (its ring asks first: app/cards.js). A parent (a task with subtasks, a run) is closed from
   its ring (ringTap, app/cards.js), and its progress is worked out from its subtasks, written to it with each change to
   them (writeFigure). Reordering: a task among its
   siblings in its project's List view (reorder), and a template's steps by moveStep (checklists.js), which writes their
   order line. */
import {cache} from '../util.js';
import {api, NetError, patchTask} from '../api.js';
import {addDays, dueInfo, isSet, movedDue, repeats, startOfDay} from '../dates.js';
import {figurePatch, isSubtask, openSubtasks, pctOf, progressPatch} from '../progress.js';
import {doneText, movedText, movedTo, notMoved, notMovedBack, notSaved, sentLater} from '../messages.js';
import {htmlToText} from '../html.js';
import {hasOwnOrder, hasTemplateLabel, patiently, stepsOf} from '../checklists.js';
import {listViewOf, placeAfter, placeMove, positionOrder, siblingBlocks} from '../order.js';
import {parentIds} from '../lists.js';
import {itemsOf, NO_ROOM, NOT_KEPT, randomId, sync} from '../sync.js';
import {shared} from './core.js';

// How long a deletion is held in another tab, or after Pocket was closed without sending it: its rows can stay a while
// in this tab, as long as a finger is down or the batch keeps being restarted (leaving.js).
const HELD_MS = 60e3;

// Saves to each task: how many have begun or ended, and how many haven't ended. A copy read while one was under way can
// be older than Vikunja's, so it isn't shown (readTask).
const saving = new Map();
const saveMark = (id, open) => { const s = saving.get(id) || {n: 0, open: 0}; s.n++; s.open += open; saving.set(id, s); };
export const reminderKey = r => r.relative_to ? r.relative_to + ' ' + (r.relative_period || 0) : +new Date(r.reminder);
// The reminders as Vikunja takes them back: a relative one by what it counts from, so it keeps moving with that date.
export const plainReminders = t => (t?.reminders || []).map(r => r.relative_to ? {relative_to: r.relative_to, relative_period: r.relative_period || 0} : {reminder: r.reminder});
const rolls = t => t.repeat_after > 0 || t.repeat_mode === 1;
// Whether Vikunja's copy `now` has the change `body` made to `before`. A repeating task marked done is moved to its
// next date instead.
function landed(now, body, before){
  if (body.done === true && !now.done && rolls(now)) return !!before && !before.done && now.due_date !== before.due_date;
  return Object.entries(body).every(([k, v]) => {
    if (k === 'reminders') return JSON.stringify(plainReminders(now).map(reminderKey).sort()) === JSON.stringify(v.map(reminderKey).sort());
    if (k === 'description') return htmlToText(now[k] || '') === htmlToText(v || '');
    if (k.endsWith('_date')) return Date.parse(now[k]) === Date.parse(v);
    if (typeof v === 'number') return Math.abs((now[k] || 0) - v) < 1e-6;
    return (now[k] ?? null) === (v ?? null);
  });
}

export default {
  /* ---------- saving a change ---------- */
  // Saves changes to a task from anywhere (the sheet, a list row), one save at a time, and updates its rows.
  // Resolves to Vikunja's copy; rejects if not saved.
  saveTask(id, patch, rebase){
    saveMark(id, 1); this.writing++;                                        // from its read first to its reply
    const run = shared.saveChain.then(async () => {
      // Only the change is sent, so anything changed elsewhere since Pocket loaded the task (notes edited on the web,
      // say) stays as it is. A field holding a list, or a template's order line in its notes, is sent whole: `rebase`
      // makes the change to Vikunja's copy as it is now, read first (null: nothing to change).
      let saved = rebase && await api('/tasks/' + id);
      const before = saved || cache.get(id), body = rebase ? rebase(saved) : patch;
      if (body) {
        try { saved = await patchTask(id, body); }
        catch (e) {
          // A reply lost on the way back (a dropped connection, a timeout) doesn't mean the change didn't reach Vikunja:
          // its copy, read now, says. Ticking a repeating task again would skip a date.
          const now = e instanceof NetError && await api('/tasks/' + id).catch(() => null);
          if (!now || !landed(now, body, before)) throw e;
          saved = now;
        }
      }
      cache.set(id, saved); this.syncTask(saved);
      return saved;
    }).finally(() => { saveMark(id, -1); this.writing--; });
    shared.saveChain = run.catch(() => {});
    return run;
  },
  // Vikunja's copy of a task, read once the saves waiting now are done; or null if another save to it was under way
  // while it was read: that save's reply is newer.
  async readTask(id){
    await shared.saveChain;
    const before = saving.get(id), n = before?.n, t = await api('/tasks/' + id);
    return !before?.open && saving.get(id)?.n === n ? t : null;
  },
  // Whether a task is still as Pocket last saved it, so an Undo doesn't write over a change made since, elsewhere.
  async unchanged(t){ const now = await api('/tasks/' + t.id); return !t.updated || now.updated === t.updated; },
  // Saves [task, patch] pairs one after another; resolves to the tasks that saved.
  async saveEach(pairs){
    const results = await Promise.allSettled(pairs.map(([t, patch]) => this.saveTask(t.id, patch)));
    return pairs.filter((p, i) => results[i].status === 'fulfilled').map(([t]) => t);
  },

  /* ---------- done, and not done again ---------- */
  /* Ticking a task done, or not done again: the one way it's done, from its row in a list (rowEl), its own sheet
     (extra.sheet: sheetDone), or a subtask's row in its parent's sheet (extra.sub). A run and a run's step are handed to
     tickRunTask and tickRunStep, which go through the outbox. A parent's subtasks stay as they are (parent-tasks-plan,
     part 3: its ring asks first, completeParent), unless `extra.close`: then its open subtasks are closed with it (not
     those that repeat, nor a repeating task's), and its undo opens exactly those again, its progress as it was. A
     subtask's tick changes its parent's worked-out progress, written to it right after (refigure).
     `extra` is saved along with it, and `undoExtra` with the undo: progress uses these to mark a task done at 100%.
     In a list, the row shows it where it is, with the subtasks closed with it, until the batch clears (markRow,
     leaving.js): then they leave Today, or move to Done in search and a project; its tick meanwhile is the undo. A
     repeating task shows done, then its next date. From its sheet, whose tick shows it, only subtasks closed are said,
     under them, with an Undo; a subtask in its parent's sheet stays where it is, done. Not saved, its row says so, with
     Try again. A done task shown over its open subtasks (isHead), opened again, stays where it is (reopenedHead).
     `extra.gap`: done by a full swipe, or a parent completed, its row (or card) a gap holding Undo until the batch
     clears (markRow), a subtask's in its parent's sheet too, which then shows it done. */
  async toggleDone(t, rowEl, extra = {}, undoExtra = {}){
    const run = this.stepRun(t);
    if (run) return this.tickRunStep(t, run, rowEl, extra.gap);
    if (this.isRunTask(t) && !extra.quiet) return this.tickRunTask(t, rowEl);
    const {quiet, sub: inSheet, sheet, gap = false, close = false, ...patch} = extra, sub = inSheet || isSubtask(t), was = t.done, head = was && this.isHead(t);
    const inList = !!rowEl && !quiet && !sheet && !inSheet;
    // Its open subtasks as they're shown (a run's steps are ticked on its screen, with who did each)
    const subs = was || quiet || !close || this.isRunTask(t) ? [] : openSubtasks(t).map(s => this.tasks[s.id] || s).filter(s => !s.done);
    // A repeating task moves on its dates, and its reminders at a set time: the undo puts them back.
    const back = {due_date: t.due_date}, shown = {due_date: t.due_date, start_date: t.start_date, end_date: t.end_date, reminders: t.reminders};
    for (const k of ['start_date', 'end_date']) if (isSet(t[k])) back[k] = t[k];
    if ((t.reminders || []).some(r => !r.relative_to)) back.reminders = plainReminders(t);
    t.done = !was;
    try {
      const saved = await this.saveTask(t.id, {done: !was, ...patch});
      Object.assign(t, saved);
      if (sub) this.refigure(t, inSheet ? this.sheet.task?.id : null);
      if (sheet) this.sheet.dirty = true;
      if (!was && !saved.done) {                 // repeating task rolled forward: the undo puts its date back
        const err = {row: {id: t.id, stays: true, cls: 'failed'}, place: 'sheet:top'};
        const undo = async () => {
          try {
            if (!await this.unchanged(t)) { this.say(`Not undone: “${t.title}” was changed since`, err); return; }
            Object.assign(t, await this.saveTask(t.id, {...back, ...undoExtra}));
          } catch (e) { this.say('Not undone: ' + e.message, err); }
          this.render();
        };
        const d = dueInfo(saved.due_date), next = d ? 'next ' + d.label : '';
        if (sheet) { this.say(next ? 'Repeats · ' + next : 'Done — repeats', {place: 'sheet:top', action: {label: 'Undo', fn: undo}}); return; }
        if (!inList) return;
        // Shown done, with the date it had, until the batch clears: then open, with its next date, or off Today if that's
        // past the coming week.
        Object.assign(t, shown, {done: true});
        const beyond = () => this.route.name === 'today' && !(new Date(saved.due_date) < addDays(startOfDay(), 8));
        this.markRow(t.id, {kind: 'done', out: () => beyond() ? [t.id] : [], undo, gap, said: `Done: ${t.title}. It repeats${next ? ', ' + next : ''}`,
          gone: () => { Object.assign(t, saved); if (beyond()) this.removeRow(t.id); else if (this.route.name === 'today') this.regroupToday(); }});
        return;
      }
      if (head) return this.reopenedHead(t, !inList);
      // Its open subtasks are done with it, on its row's count and in its sheet too, and the undo opens them again.
      const closed = was ? [] : await this.closeSubtasks(subs), ids = [t.id, ...closed];
      const mark = (list, done) => { for (const s of t.related_tasks?.subtask || []) if (list.includes(s.id)) s.done = done; };
      mark(closed, true);
      if (closed.length) this.writeFigure(t.id).catch(() => {});             // its worked-out progress, with them done
      // Subtasks left open under it on a project's list (one that repeats, or one not saved): it stays over them.
      const over = !was && !sub && !sheet && this.leftOpenUnder(t) && this.makeHead(t);
      const undo = was ? async () => { await this.toggleDone(t, null, {quiet: true, sheet, sub: inSheet}); this.render(); }
        : async () => {
          await this.toggleDone(t, null, {...undoExtra, quiet: true, sheet, sub: inSheet});
          const failed = await this.reopen(closed);
          mark(closed.filter(id => !failed.includes(id)), false);
          if (closed.length) this.writeFigure(t.id).catch(() => {});
          if (failed.length) this.say(`Not all undone: ${failed.length} subtask${failed.length === 1 ? '' : 's'} couldn't be marked not done`, {row: {id: t.id, stays: true, cls: 'failed'}, place: 'sheet:subtasks'});
          this.render();
        };
      const text = doneText(closed.length, subs.length, t.title);
      // From a sheet, the subtasks closed are said under them, with the Undo: its own tick, or a subtask's there.
      if (sheet || inSheet) {
        if (closed.length || (sheet && subs.length)) this.say(text, {place: 'sheet:subtasks', action: {label: 'Undo', fn: undo}});
        if (gap && inSheet) this.markRow(t.id, {kind: 'done', out: [], undo, gap, said: text});   // its gap, then done in its place
        return;
      }
      if (!inList) return;
      // Some subtasks couldn't be closed: its row says so for a moment, then it's back.
      if (closed.length < subs.length) this.say(text, {row: {id: t.id, stays: true, cls: 'failed'}, ms: 4000});
      // Done, it leaves Today, or moves to Done in search and a project; opened again in Done, it moves back to Open. A
      // task left over its subtasks still open stays, and only those closed with it go.
      const moves = () => !!this.searchGroups(t);
      if (was && !moves()) { this.said = 'Not done: ' + t.title; return; }
      this.markRow(t.id, {kind: was ? 'open' : 'done', ids, undo, gap, said: was ? 'Not done: ' + t.title : text,
        out: () => over ? closed : this.bothWays && !moves() ? [] : ids,
        gone: () => { if (over) this.moveInSearch(t, closed); else if (this.bothWays) this.moveInSearch(t, ids); else if (t.done) ids.forEach(id => this.removeRow(id)); }});
    } catch (e) {
      t.done = was;
      this.say(notSaved(e), {row: {id: t.id, stays: true, cls: 'failed'}, place: 'sheet:top', action: {label: 'Try again', fn: () => this.toggleDone(t, this.rowEl(t.id), extra, undoExtra)}});
    }
  },
  /* A parent's worked-out progress (parent-tasks-plan, part 3), written to its percent_done after a change to its
     subtasks, with that change: in the same chain of saves, right after it, Vikunja's copy read first and only a figure
     that changed saved, with nothing said (figurePatch). Not a template's. Resolves to Vikunja's copy. A run's step goes
     through the outbox instead, its act's last part doing the same (`figure`, sync.js). */
  writeFigure(id){ return this.saveTask(id, null, now => hasTemplateLabel(now) ? null : figurePatch(now)); },
  // The task a subtask is under: its own copy says, or the sheet it's in, or the task on screen it's listed under.
  parentIdOf(t){
    const own = parentIds(t)[0], has = p => p?.related_tasks?.subtask?.some(s => s.id === t.id);
    return own ?? (has(this.sheet.task) ? this.sheet.task.id : Object.values(this.tasks).find(has)?.id ?? null);
  },
  // After a subtask's tick or progress, in a list or its parent's sheet (`up`): its parent's figure, in the background.
  refigure(t, up = null){
    const id = up ?? this.parentIdOf(t);
    if (typeof id === 'number') this.writeFigure(id).catch(() => {});
  },
  // A done task on a project's open list, struck through over its subtasks still open there (loadProject).
  isHead(t){ return !!t?.done && this.route.name === 'project' && !!this.view.groups.find(g => g.key === 'open')?.heads?.includes(t.id); },
  // Whether a task on a project's open list has subtasks still open under it there.
  leftOpenUnder(t){
    const g = this.route.name === 'project' && this.view.groups.find(x => x.key === 'open');
    return !!g && g.tasks.includes(t) && g.tasks.some(x => !x.done && !(this.deleting || []).includes(x.id) && parentIds(x).includes(t.id));
  },
  // A task ticked done that stays over its open subtasks, as a head: counted done, and in the Done section too.
  makeHead(t){
    const open = this.view.groups.find(x => x.key === 'open'), done = this.view.groups.find(x => x.key === 'done');
    open.heads = [...new Set([...open.heads || [], t.id])];
    if (done?.loaded && !done.tasks.includes(t)) done.tasks.unshift(t);
    if (typeof done?.count === 'number') done.count++;
    return true;
  },
  /* A done task shown over its open subtasks, on a project's list (isHead), opened again, from its row or its sheet: an
     open task where it is, no longer in the Done section. On its row (not from its sheet, whose tick shows it), its tick
     meanwhile makes it done again, over them as it was: the list, read again, shows it so. */
  reopenedHead(t, quiet){
    this.outOfDone(t.id);
    if (quiet) return;
    this.markRow(t.id, {kind: 'open', out: [], said: 'Not done: ' + t.title, undo: async () => {
      try { Object.assign(t, await this.saveTask(t.id, {done: true})); }
      catch (e) { this.say('Not undone: ' + e.message, {row: {id: t.id, stays: true, cls: 'failed'}}); }
      this.render();
    }});
  },
  // A task opened again outside the Done section: out of it, and out of its count, which, not loaded yet, counts it.
  outOfDone(id){
    const g = this.view.groups.find(x => x.key === 'done');
    if (!g) return;
    const i = g.tasks.findIndex(x => x.id === id);
    if (i >= 0) g.tasks.splice(i, 1);
    if ((i >= 0 || !g.loaded) && typeof g.count === 'number') g.count = Math.max(0, g.count - 1);
  },
  /* A run finished, or opened again, from its ring or its Close (parent-tasks-plan, part 3: a run is a parent, its steps
     its subtasks), or its sheet, as on its screen, through the outbox. Its steps are ticked one by one on its screen, with
     who did each, so finishing it leaves them as they are: with steps not done, its ring asks first (askComplete). In a
     list, it's shown in place, its card a gap holding Undo, until the batch clears, as a task's tick is; its steps go
     with it. */
  async tickRunTask(t, rowEl){
    const was = t.done, head = was && this.isHead(t);
    const r = await this.act({op: was ? 'reopen' : 'finish', task: t.id, run: t.id});
    if (r.status === 'error') return;
    t.done = !was;
    if (this.sheet.task?.id === t.id) this.sheet.task.done = t.done;
    // A finished run over its steps still open (isHead), opened again: where it is.
    if (head) return this.outOfDone(t.id);
    const offline = r.status === 'offline', said = was ? 'Not done: ' + t.title : offline ? sentLater('Finished ' + t.title) : 'Finished ' + t.title;
    const undo = async () => { await this.act({op: was ? 'finish' : 'reopen', task: t.id, run: t.id}); t.done = was; this.render(); };
    // From its sheet: said at its top, with its Undo; with no row of it on screen, by the toast.
    if (!rowEl) { if (!was) this.say(offline ? sentLater('Finished') : said, {place: 'sheet:top', action: {label: 'Undo', fn: undo}}); return; }
    const moves = () => !!this.searchGroups(t), steps = () => stepsOf(t).map(s => s.id);
    if (was && !moves()) { this.said = said; return; }
    this.markRow(t.id, {kind: was ? 'open' : 'done', undo, said, gap: !was, out: () => this.bothWays && !moves() ? [] : [t.id],
      gone: () => { if (this.bothWays) this.moveInSearch(t, [t.id]); else if (t.done) [t.id, ...steps()].forEach(id => this.removeRow(id)); }});
  },
  /* A run's step ticked in a list or a sheet: as on the run's screen, with a ✅ for who did it, through the outbox, so it
     waits without a connection (felt where it was tapped, tickRow, or swiped). In a list, it's shown in place until the batch clears, as a task's tick is (by a full
     swipe, `gap`, a gap with Undo); in a sheet, it stays, done. */
  async tickRunStep(t, run, rowEl, gap = false){
    const was = t.done;
    t.done = !was;
    const r = await this.act({op: was ? 'undone' : 'done', task: t.id, run});
    if (r.status === 'error') { if (!r.error.saved) t.done = was; return; }
    const later = !was && r.status === 'offline' ? sentLater('Done: ' + t.title) : '';
    // In a sheet, offline, its row says when it's sent.
    if (!rowEl) { if (later) this.say(later, {row: {id: t.id, text: sentLater('Done'), stays: true}, place: 'sheet:top'}); return; }
    const moves = () => !!this.searchGroups(t);
    if (was && !moves()) { this.said = 'Not done: ' + t.title; return; }
    this.markRow(t.id, {kind: was ? 'open' : 'done', gap, said: later || (was ? 'Not done: ' : 'Done: ') + t.title, undo: () => this.tickRunStep(t, run, null),
      out: () => this.bothWays && !moves() ? [] : [t.id],
      gone: () => { if (this.bothWays) this.moveInSearch(t, [t.id]); else if (t.done) this.removeRow(t.id); }});
  },
  // Open and Done, in search or a project: the one a task is in, and the one its tick moves it to.
  searchGroups(t){
    if (!this.bothWays) return null;
    const from = this.view.groups.find(g => g.key === (t.done ? 'open' : 'done')), to = this.view.groups.find(g => g.key === (t.done ? 'done' : 'open'));
    return from && to && from.tasks.some(x => x.id === t.id) ? {from, to} : null;
  },
  /* A task ticked (and the subtasks ticked with it) moves to Done, at the top, or back to Open: in search at its top, in a
     project to its place in the List view, which is read again. A Done section not loaded yet only counts it. Returns
     whether it moved. */
  moveInSearch(t, ids){
    const g = this.searchGroups(t);
    if (!g) return false;
    for (const id of ids) {
      const i = g.from.tasks.findIndex(x => x.id === id);
      if (i < 0) continue;
      const [x] = g.from.tasks.splice(i, 1);
      x.done = t.done;
      if (g.to.loaded !== false && !g.to.tasks.includes(x)) g.to.tasks.unshift(x);
      for (const k of ['from', 'to']) if (typeof g[k].count === 'number') g[k].count += k === 'to' ? 1 : -1;
    }
    if (this.route.name === 'project' && !t.done) this.render();
    return true;
  },
  // Mark these subtasks of a task just done, done too, one by one. Returns the ids marked; stops at the first that fails.
  async closeSubtasks(subs){
    const closed = [];
    for (const s of subs) { try { await this.saveTask(s.id, {done: true}); closed.push(s.id); } catch { break; } }
    return closed;
  },
  // Mark these subtasks not done again (an Undo). Resolves to the ids that couldn't be.
  async reopen(ids){
    const failed = [];
    for (const id of ids) await this.saveTask(id, {done: false}).catch(() => failed.push(id));
    return failed;
  },
  // The sheet's tick, or its progress taken to 100%: as a row's tick, and its Undo puts its progress back.
  async sheetDone(patch = null){
    const t = this.sheet.task;
    if (!t || (patch && t.done)) return;
    await this.toggleDone(t, null, {...patch, sheet: true}, patch ? {percent_done: pctOf(t) / 100} : {});
    this.sheet.dirty = true;
  },
  // A subtask ticked in its parent's sheet: as in a list; a run's step as on the run's screen.
  async toggleSubtask(st){
    if (this.checklistRole === 'run') await this.tickRunStep(st, this.sheet.task.id, null);
    else await this.toggleDone(st, null, {sub: true});
    this.sheet.dirty = true;
  },

  /* ---------- progress ---------- */
  /* Progress set in a list, or on a subtask's row in its parent's sheet (`sub`). At 100% the task is done, as when it's
     ticked off; a done one set below it is opened again, at that progress, as its tick would (its tick again is the
     undo). Below that, it shows on its row only, with no message: the row's tick is what was set, and
     swiping it back is the undo (a line over the row would hide it, and stop the next slide). Not saved, the row says
     so, with Try again. `undoing`: putting back what it was, exactly, without marking it done. `gap`: 100% by a full
     swipe, the row a gap with Undo until the batch clears (toggleDone). */
  async setProgress(t, pct, rowEl, {undoing = false, sub = false, gap = false} = {}){
    const was = pctOf(t), patch = undoing ? {percent_done: pct / 100} : progressPatch(t, pct);
    if (t.done && !undoing && pct < 100) return this.toggleDone(t, rowEl, {...patch, sub});
    if (patch.done) return this.toggleDone(t, rowEl, {...patch, sub, gap}, {percent_done: was / 100});
    t.percent_done = patch.percent_done;
    try {
      await this.saveTask(t.id, patch);
      this.said = `Progress of ${t.title} set to ${pct}%`;
      if (sub || isSubtask(t)) this.refigure(t, sub ? this.sheet.task?.id : null);
    } catch (e) {
      t.percent_done = was / 100;
      this.say(notSaved(e), {row: {id: t.id, stays: true, cls: 'failed'}, action: {label: 'Try again', fn: () => this.setProgress(t, pct, this.rowEl(t.id), {undoing, sub})}});
    }
  },
  // Progress set in the sheet (its row, or its Progress line: setSheetProgress): as in the list, 100% is done, and
  // anything else shows on its row's tick (save says if it isn't saved); a subtask's changes its parent's figure.
  async sheetProgress(t, pct){
    const patch = progressPatch(t, pct);
    if (t.done && pct < 100) return this.toggleDone(t, null, {...patch, sheet: true});   // opened again, at that progress
    if (patch.done) return this.sheetDone(patch);
    if (await this.save(patch) === false) return;
    this.said = `Progress set to ${pct}%`;
    if (isSubtask(t)) this.refigure(t);
  },

  /* ---------- moving ---------- */
  // Move the open task to another project, its subtasks (all the way down) with it.
  async moveTask(pid){
    const t = this.sheet.task, kids = [];
    if (!t || pid === t.project_id) return;
    const walk = async (id, seen = new Set([t.id])) => {
      const x = id === t.id ? t : (cache.get(id) || await api('/tasks/' + id));
      for (const sub of x.related_tasks?.subtask || []) if (!seen.has(sub.id)) { seen.add(sub.id); kids.push(sub.id); await walk(sub.id, seen); }
    };
    await this.save({project_id: pid});
    if (cache.get(t.id)?.project_id !== pid) return;                        // not moved
    try {
      await walk(t.id);
      for (const id of kids) await this.saveTask(id, {project_id: pid});
      if (kids.length) this.say(`Moved, with ${kids.length} subtask${kids.length === 1 ? '' : 's'}`, {place: 'sheet:props'});
    } catch (e) { this.say(`Moved, but not all its subtasks: ${e.message}`, {place: 'sheet:props', cls: 'failed'}); }
    this.sheet.dirty = true;
  },
  // Whether Move all to today has anything to move: not a repeating task, nor a checklist that comes round.
  get overdueMovable(){ return this.overdueTasks.some(t => !repeats(t) && !hasTemplateLabel(t)); },
  /* "Move all to today": each overdue task to today, at the time of day it had (movedDue). Undo puts every date back
     (undoMoves). Not a repeating task: moved, its next times would follow the new date; ticked, it moves on to its next
     date. What it did is said under the Overdue heading, which stays meanwhile. A row or a card thrown on Today to a new
     date is the same, one at a time (reschedule). */
  async moveOverdueToToday(){
    // Nor a checklist that comes round: moved, a weekly one would come round on another day from then on.
    // On a card, its task and subtasks that are overdue themselves (overdueTasks).
    const overdue = this.overdueTasks, tasks = overdue.filter(t => !repeats(t) && !hasTemplateLabel(t));
    const tpl = overdue.filter(t => hasTemplateLabel(t)).length, stay = overdue.length - tasks.length - tpl;
    const stays = [stay && `${stay === 1 ? '1 repeating task stays' : stay + ' repeating tasks stay'}: tick ${stay === 1 ? 'it' : 'them'} to move on to the next date.`,
      tpl && `${tpl === 1 ? '1 checklist stays' : tpl + ' checklists stay'}: start ${tpl === 1 ? 'it' : 'them'} to move on to the next time.`].filter(Boolean).join(' ');
    if (!tasks.length && stays) { this.say(movedText(0, 0, stays), {place: 'overdue'}); return; }
    if (!tasks.length || this.movingOverdue) return;
    this.movingOverdue = true;
    const now = new Date(), moves = tasks.map(t => ({t, was: t.due_date, due: movedDue(t.due_date, now, now)}));
    const moved = await this.saveEach(moves.map(m => [m.t, {due_date: m.due}]));
    this.movingOverdue = false;
    const left = moves.length - moved.length, n = moved.length;
    if (!n) return this.say(this.offline ? 'Not moved: no connection' : 'Not moved: Vikunja didn\'t save the changes', {place: 'overdue', cls: 'failed'});
    this.say(movedText(n, left, stays), {place: 'overdue', action: this.undoMoves(moves.filter(m => moved.includes(m.t)), 'today', {place: 'overdue'}, () => this.render())});
    this.render();
  },
  /* The Undo of tasks moved to other dates (`moves`: {t, was}), Move all to today's: each put
     back, unless it was changed since, elsewhere; those that couldn't be are said (`at`: where, as say's), still due
     `still`. `after(back)`: given the moves put back, to show them. */
  undoMoves(moves, still, at, after){
    return {label: 'Undo', fn: async () => {
      const same = [];                                                      // not changed since, elsewhere
      for (const m of moves) if (await this.unchanged(m.t).catch(() => false)) same.push(m);
      const back = await this.saveEach(same.map(m => [m.t, {due_date: m.was}]));
      const k = moves.length - back.length;
      if (k) this.say(notMovedBack(k, still), {...at, cls: 'failed'});
      after(same.filter(m => back.includes(m.t)));
    }};
  },
  /* A row or a card thrown on Today to a new date (its ring: app/throw.js): Move all to today, one at a time. `to`:
     {due: its new date (movedDue: its time of day kept; none for No date), label: the day's name, null for No date}. A
     card's is its task's date only, its subtasks as they are. It's moved on screen at once (placeOnToday), then saved,
     with no Undo: the throw could be called off before it was let go (design rule 8's one exception). A card whose
     subtask is due sooner stays where that puts it, and its place says why. Not saved, it goes back, and its place says
     so, with Try again. */
  async reschedule(t, to){
    const c = this.view.cards?.[t.id], m = {was: t.due_date, when: c ? c.when : undefined, key: this.todayKey(t)};
    this.placeOnToday(t, to.due);
    // (Where a task due then goes: the same rule as for one waiting to be sent.)
    const want = this.pendingPlace({due_date: to.due}), kept = c && this.todayKey(t) !== want && c.when !== t.due_date
      ? this.cardSubs(t, false).filter(s => !s.done && isSet(s.due_date)).sort((a, b) => Date.parse(a.due_date) - Date.parse(b.due_date))[0] : null;
    if (kept) this.say(movedTo(to.label, kept.title), {row: {id: t.id, stays: true}});
    try { await this.saveTask(t.id, {due_date: to.due}); }
    catch (e) {
      this.placeOnToday(t, m.was, m.when, m.key);
      this.say(notSaved(e), {row: {id: t.id, stays: true, cls: 'failed'}, action: {label: 'Try again', fn: () => this.reschedule(t, to)}});
      return false;
    }
    return true;
  },
  // The group of Today's that task `t` is in (its key), or null.
  todayKey(t){ return this.view.groups.find(g => g.tasks.some(x => x.id === t.id))?.key ?? null; },
  /* Task `t` due `due` on Today's screen, at once: in the group its date puts it in, among the others there in their
     order (regroupToday), or off Today, past its next 7 days. A card goes by the earliest of its task's date and its open
     subtasks' (`when`, as cards.js works it out as Today loads), or is given `when` (a Try again's). With no date, it
     goes back to `key` (Added today, no date, which shows only those made today). */
  placeOnToday(t, due, when, key = 'nodate'){
    t.due_date = due;
    const c = this.view.cards?.[t.id];
    if (c) c.when = when !== undefined ? when : [due, ...this.cardSubs(t, false).filter(s => !s.done).map(s => s.due_date)].filter(isSet)
      .reduce((a, b) => !a || Date.parse(b) < Date.parse(a) ? b : a, null);
    const at = c ? c.when : due, dated = isSet(at), groups = this.view.groups;
    const into = dated && new Date(at) >= addDays(startOfDay(), 8) ? null : groups.find(g => g.key === (dated ? 'today' : key));
    for (const g of groups) g.tasks = g.tasks.filter(x => x.id !== t.id);
    into?.tasks.push(t);
    this.regroupToday();
  },

  /* ---------- reordering ---------- */
  /* Move task `t` to place `to` among its siblings (`sibs`: tasks in their order on screen, it among them) in its
     project's List view `view`. The screen changes at once, and the positions are written (placeMove) through the
     outbox, so a move made without a connection waits, and is sent later. Turned down, it goes back, and its row says
     why. (If Vikunja keeps another position than the one sent, it renumbered the view: applyAct reads it again.)
     Resolves to whether it moved. */
  async reorder(t, sibs, to, view){
    const from = sibs.findIndex(s => s.id === t.id);
    if (from < 0 || to === from || to < 0 || to >= sibs.length || !view) return false;
    const writes = placeMove(sibs.map(s => ({id: s.id, pos: this.positions[s.id] || 0})), from, to);
    const was = Object.fromEntries(writes.map(([id]) => [id, this.positions[id]]));
    for (const [id, pos] of writes) this.positions[id] = pos;
    this.said = `Moved ${t.title}: ${to + 1} of ${sibs.length}`;
    for (const [id, pos] of writes) {
      const r = await this.act({op: 'position', task: id, view, pos, run: null});
      if (r.status !== 'error') continue;
      Object.assign(this.positions, was);
      this.say(notMoved(r.error), {row: {id: t.id, stays: true, cls: 'failed'}, place: 'sheet:top'});
      return false;
    }
    this.saveProject();
    return true;
  },
  // A move Vikunja has, where it kept it: not where it was sent, it renumbered the view, so the list is read again.
  positionSent(a){
    if (typeof a.got !== 'number' || Math.abs(a.got - a.pos) < 1e-6) return;
    this.positions[a.task] = a.got;
    if (this.route.name === 'project') this.render();
    if (this.sheet.subView) this.loadSubOrder(this.sheet.task);
  },
  // One place up (-1) or down (1): the ⋯'s Move up and Move down, and Alt+↑ or ↓ on a row (orderOf's `where`).
  moveBy(t, dir, where){
    const o = this.orderOf(t, where), i = o ? o.sibs.findIndex(s => s.id === t.id) : -1;
    return i >= 0 ? this.reorder(t, o.sibs, i + dir, o.view) : false;
  },
  /* Where task `t` can be moved: {sibs, view, blocks}, or null. Only among its siblings: on a project's list ('list'),
     the tasks under the same parent there, each with its subtasks (blocks, siblingBlocks); in a task's sheet ('sheet'),
     its subtasks, once their order is read (subView); from its own sheet ('own'), on the list under it if it's there,
     else among its parent's subtasks, when where each of them is is known. Not a task done, waiting to be sent, or read
     only; nor a step of a template or a run, which keep their order line, nor a subtask in another project than its
     parent's, which has no place in that project's list. */
  orderOf(t, where){
    if (!t || t.pending || t.done || this.lines[t.id] || this.leaving[t.id] || !this.canWrite(t.project_id)) return null;
    const under = p => !!p && !hasOwnOrder(p) && p.project_id === t.project_id;
    if (where === 'sheet') return this.sheet.subView && under(this.sheet.task) ? {sibs: this.subtasks, view: this.sheet.subView} : null;
    const g = this.route.name === 'project' && this.view.listView && this.view.project?.id === t.project_id && this.listGroups.find(x => x.key === 'open');
    if (g && g.tasks.some(x => x.id === t.id)) {
      const blocks = siblingBlocks(g.tasks, g.depth, t.id).filter(b => !b.task.pending);
      const parent = g.depth[t.id] && g.tasks[g.tasks.findIndex(x => x.id === blocks[0].id) - 1];
      return !parent || under(parent) ? {sibs: blocks.map(b => b.task), view: this.view.listView, blocks} : null;
    }
    if (where !== 'own') return null;
    // Among its parent's subtasks, as Vikunja last gave them.
    const pid = t.related_tasks?.parenttask?.[0]?.id, parent = pid && (this.tasks[pid] || cache.get(pid));
    const subs = under(parent) && parent.related_tasks?.subtask, view = listViewOf(this.projById.get(t.project_id))?.id;
    if (!subs?.length || !view || subs.some(s => !(s.id in this.positions))) return null;
    return {sibs: [...subs].sort(positionOrder(this.positions)), view};
  },
  // The ⋯'s Move up and Move down for the open task: whether each can be done.
  get sheetMoves(){
    const t = this.sheet.task, o = this.sheet.kind === 'task' && this.orderOf(t, 'own'), i = o ? o.sibs.findIndex(s => s.id === t.id) : -1;
    return i < 0 ? null : {up: i > 0, down: i < o.sibs.length - 1};
  },

  /* ---------- adding subtasks ---------- */
  /* A subtask box's lines, as subtasks, through the outbox like quick add: without a connection they wait, shown in the
     sheet and the lists, and are sent once Pocket reaches Vikunja. The sheet's box ('sub') adds them to the open task,
     after its subtasks; the add box on a project's list ('under'), to the task it's on (the cursor, quickadd.js), after
     the cursor's subtask or the last one added from there, each after the one before. Each is sent with its place in its
     project's List view, once where they are is known (Vikunja would put each first). (A template's steps are added with
     addTemplateSteps.) The box keeps the focus, to type the next one. Added, they show on their rows, with no message
     unless there's a problem: one added by mistake is deleted from its row, which has an Undo. */
  async addSubtasks(w = 'sub'){
    const foot = w === 'under', parent = this.boxParent(w), b = this.box(w), parsed = this.boxParsedLines(w);
    if (!parent || !parsed.some(p => p.title)) return;
    const n = parsed.filter(p => p.title).length;
    const at = foot ? this.cursorPlaces(n) : this.sheet.subView || !this.subtasks.length ? placeAfter(this.subtasks.map(s => this.positions[s.id] || 0), null, n) : null;
    const items = itemsOf(this.boxItems(w), k => at && {position: at[k]});
    const entry = {id: randomId(), user: this.user?.id, at: new Date().toISOString(), nest: false, pid: parent.project_id,
      parent: {id: parent.id, project_id: parent.project_id, title: parent.title}, items, files: []};
    // The next ones from the add box go after these.
    if (foot) this.cursor.after = {pos: at?.at(-1) ?? null, title: items.at(-1).p.title};
    const here = () => foot || this.sheet.task?.id === parent.id, place = foot ? 'cap' : 'sheet:subtasks';
    // The next can be sent while this one is on its way (the outbox sends them in turn): `adding` counts them.
    b.adding++; b.text = '';
    if (!foot || b.focus) this.$nextTick(() => this.boxEl(w)?.focus());
    try {
      // On screen at once, where they'll be: they look waiting only if sending takes a while.
      const {kept, full} = await sync.add(entry, []);
      this.refreshPending();
      const r = await sync.lock(() => this.sendEntry(entry.id));
      if (foot) this.refreshPending();                                     // the waiting rows, and the rows sent, swapped at once
      this.placeSent(r.tasks || []);
      const but = r.problems?.length ? `, but ${r.problems.join('; ')}` : '';
      if (r.ids?.length && foot) {
        this.flash(r.ids);
        // Its row's count of subtasks, with these.
        this.readTask(parent.id).then(t => { if (t) { cache.set(t.id, t); this.keep(t); } }).catch(() => {});
      } else if (r.ids?.length && here()) {
        this.sheet.dirty = true;
        try { const t = await this.readTask(parent.id); if (t) { cache.set(t.id, t); if (here()) { this.showTask(t); this.loadSubPeople(t); this.loadSubOrder(t); } } } catch {}
      }
      if (r.status === 'offline') {
        sync.keep();
        // From the add box, their rows say they're waiting.
        if (!foot || !kept) this.say(!kept ? (full ? NO_ROOM : NOT_KEPT) : `Saved offline. ${n === 1 ? 'It goes' : 'They go'} to Vikunja when you're back online.`, {place, cls: kept ? '' : 'failed'});
      } else if (r.status === 'error') {
        if (here()) b.text = [r.unsent.join('\n'), b.text].filter(Boolean).join('\n');      // keep what wasn't added
        this.say(r.ids.length ? `Added ${r.ids.length} of ${n}${but}. Stopped: ${r.error.message}` : 'Not added: ' + r.error.message, {place, cls: 'failed'});
      } else if (r.ids?.length && but) this.say(`Added ${r.ids.length === 1 ? '1 subtask' : r.ids.length + ' subtasks'}${but}`, {place, cls: 'failed'});
    } finally { b.adding--; this.refreshPending(); }
  },

  /* ---------- deleting ---------- */
  // An Undo of tasks just added: deleted, saying if any couldn't be.
  async deleteTasks(ids){
    let failed = 0;
    for (const id of [...ids].reverse()) await api('/tasks/' + id, {method:'DELETE'}).catch(e => { if (e.status !== 404) failed++; });
    if (failed) this.notify(`Not all undone: ${failed} of ${ids.length} couldn't be deleted.`);
    this.render();
  },
  // What deleting the open task deletes: its subtasks go with it, a template's steps too, and a run's.
  get deleteLabel(){
    const n = this.subtasks.length, role = this.checklistRole;
    if (role === 'run') return 'Delete run';
    if (role === 'template') return n ? `Delete template and its ${n} step${n === 1 ? '' : 's'}` : 'Delete template';
    return n ? `Delete task and its ${n} subtask${n === 1 ? '' : 's'}` : 'Delete task';
  },
  // `asked`: what it deletes, if that was asked about already (its row swiped: swipeDelete, app/progress.js).
  async deleteTask(asked = null){
    const t = this.sheet.task, role = this.checklistRole;
    if (role === 'run') return this.confirmDeleteRun({id: t.id, title: t.title, steps: this.subtasks});
    // Opened from its parent's sheet: back to the parent afterwards.
    const back = this.sheet.from && (t.related_tasks?.parenttask || []).some(x => x.id === this.sheet.from) ? this.sheet.from : null;
    const leave = async () => {
      Object.assign(this.sheet, {dirty: false, editingDesc: false, commentDraft: ''}); this.sheet.sub.text = '';
      if (back) { await this.openTask(back); this.sheet.dirty = true; } else this.closeSheet();
    };
    if (role !== 'template') { if (await this.removeTask(t, asked)) await leave(); return; }
    // A template's steps are its runs' to come: it's deleted at once, after asking.
    let tree;
    try { tree = await this.taskTree(t.id); } catch (e) { this.say('Not deleted: ' + e.message, {place: 'sheet:top', cls: 'failed'}); return; }
    const n = tree.length - 1;
    if (!confirm(`Delete the template “${t.title}”` + (n ? ` and its ${n} step${n === 1 ? '' : 's'}? Runs already started keep theirs.` : '?') + ' This can\'t be undone here.')) return;
    await shared.saveChain;
    try {
      await this.deleteTree(tree);
      await leave();
      this.render();
      this.notify(n ? `Deleted, with ${n} step${n === 1 ? '' : 's'}` : 'Deleted');                   // its sheet and row are gone
    } catch (e) { this.say(`Stopped after deleting ${e.deleted} of ${tree.length}: ${e.message}`, {place: 'sheet:top', cls: 'failed'}); this.render(); }
  },
  // Whether a row can be swiped to its Delete: not a run, a step of one, a template, a task waiting to be sent, or one
  // in a project shared with you to read; in a sheet (`sheet`), not a run's or a template's steps.
  canDelete(t, sheet){
    return !t.pending && this.canWrite(t.project_id) && !this.isRunTask(t) && !this.stepRun(t) && !(this.checklistIds.has(t.project_id) && hasTemplateLabel(t))
      && !(sheet && ['run', 'template'].includes(this.checklistRole));
  },
  /* Deleting a task, from its row's Delete or its sheet's ⋯: its subtasks go with it, all the way down (taskTree), and
     with any it asks first. Its row stays where it is, a gap holding only Restore, with its subtasks' rows, until
     the batch clears (markRow, leaving.js): then they go, and it's sent; or at once if the screen is left, or Pocket is
     put away or closed. Meanwhile it waits in the outbox, kept on the phone, held back (sync.held): so it's sent even
     if Pocket is closed before then, the next time it opens, and without a connection, once there's one. Restore takes
     it out of the outbox: nothing was sent, so nothing has to be made again. With no row of it on screen, a message
     says so, with an Undo, and it's sent when that goes. Resolves to whether it's deleted (not if it was called off).
     `tree`: what it deletes, if that was asked about already (askDelete). */
  async removeTask(t, tree = null){
    const d = await this.holdDelete(t, d => {
      const undo = () => this.undoDelete(d.id), gone = () => this.sendHeld(d.id);
      if (this.rowEl(t.id)) return this.markRow(t.id, {kind: 'deleted', ids: d.ids, undo, gone, said: `Deleted: ${t.title}. Restore is in its place`});
      const title = t.title.length > 40 ? t.title.slice(0, 38) + '…' : t.title;
      this.notify(`Deleted “${title}”` + (d.n ? ` + ${d.n} subtask${d.n === 1 ? '' : 's'}` : ''), {label: 'Undo', fn: undo, gone});
    }, tree);
    return !!d;
  },
  // Whether a task has subtasks, as far as the phone knows: by its own copy, the one on screen, or Vikunja's last.
  hasSubtasks(t){ return [t, this.tasks[t.id], cache.get(t.id)].some(x => x?.related_tasks?.subtask?.length); },
  /* What deleting `t` deletes: itself and its subtasks, all the way down (taskTree), asked about first if there are any,
     saying how many. Resolves to their ids, deepest first, or null: called off, or not read (its row says so). A row
     swiped to delete a task with subtasks asks here before the row goes anywhere (swipeDelete, app/progress.js). */
  async askDelete(t){
    let tree;
    try { tree = await this.taskTree(t.id); } catch (e) { this.say('Not deleted: ' + e.message, {row: {id: t.id, stays: true, cls: 'failed'}, place: 'sheet:top'}); return null; }
    const n = tree.length - 1, direct = (t.related_tasks?.subtask || []).filter(s => tree.includes(s.id)).length;
    const deeper = n > direct ? `, ${n - direct} more under ${direct === 1 ? 'it' : 'them'}` : '';
    return n && !confirm(`Delete “${t.title}” and its ${direct} subtask${direct === 1 ? '' : 's'}${deeper}?`) ? null : tree;
  },
  /* The deletion itself, apart from how it's shown (`show`, given {id, n: its subtasks, ids: the task's and theirs} just
     before the rows go): asked first if it has subtasks (askDelete; not again, given the `tree` that was asked about),
     then off the lists at once (but rows deleted in place), and kept in the outbox, held back (sync.held), until
     sendHeld or undoDelete. Resolves to {id, n}, or null if it was called off. */
  async holdDelete(t, show, tree = null){
    tree ||= await this.askDelete(t);
    if (!tree) return null;
    const n = tree.length - 1;
    // A subtask deleted changes its parent's worked-out progress: written once it's sent (`up`, the act's last part).
    const up = this.parentIdOf(t);
    const entry = {id: randomId(), kind: 'act', op: 'delete', user: this.user?.id, at: new Date().toISOString(), items: [], files: [], stage: 0, fails: 0,
      run: null, task: t.id, ids: tree, label: t.title, until: Date.now() + HELD_MS, ...typeof up === 'number' && !tree.includes(up) && {up}};
    sync.held.add(entry.id);
    const added = sync.add(entry, []);
    show?.({id: entry.id, n, ids: tree});
    this.refreshPending();                                                  // off the lists at once, but rows deleted in place
    await added;
    return {id: entry.id, n};
  },
  // Restore, or Undo: the deletion isn't sent, and the rows are back.
  async undoDelete(id){
    if (!sync.held.delete(id)) return;
    // Back on its list at once, not once it's out of the outbox: its row, restored where it is, mustn't blink out.
    const e = this.user ? sync.all(this.user.id).find(x => x.id === id) : null;
    if (e) this.deleting = this.deleting.filter(x => !e.ids.includes(x));
    await sync.lock(() => sync.remove(id));
    this.refreshPending();
  },
  // Send a deletion whose rows have gone, or whose Undo has (`id`), or, with none, every one still held: Pocket is being
  // put away.
  async sendHeld(id){
    if (!id) { await Promise.all([...sync.held].map(h => this.sendHeld(h))); return; }
    if (!sync.held.delete(id)) return;                                      // undone, or sent already
    await sync.lock(async () => { const e = await sync.fresh(id); if (e?.until) { delete e.until; await sync.save(e); } });
    await this.sendActs(id);
  },
  /* A task and its subtasks, all the way down, deepest first. A subtask that's also under another task stays, with
     what's under it. */
  async taskTree(id){
    const out = [], seen = new Set();
    const walk = async (tid, from) => {
      if (seen.has(tid)) return;
      seen.add(tid);
      // Without a connection: as last loaded, so a task with subtasks Pocket hasn't seen goes without them.
      const t = tid === this.sheet.task?.id ? this.sheet.task : await api('/tasks/' + tid).catch(e => { if (e instanceof NetError) return cache.get(tid) || {id: tid}; throw e; });
      if (from && (t.related_tasks?.parenttask || []).some(p => p.id !== from)) return;
      for (const sub of t.related_tasks?.subtask || []) await walk(sub.id, tid);
      out.push(tid);
    };
    await walk(id, null);
    return out;
  },
  // Delete what taskTree found. A refusal stops it, saying how many went (e.deleted).
  async deleteTree(ids){
    let n = 0;
    try {
      for (const id of ids) {
        await patiently(() => api('/tasks/' + id, {method: 'DELETE'})).catch(e => { if (e.status !== 404) throw e; });
        this.forget(id); n++;
      }
    } catch (e) { e.deleted = n; throw e; }
  },

  /* ---------- people and labels ---------- */
  // Assign someone to a task, or take them off; resolves once Vikunja has it, and it's on screen.
  async addAssignee(t, u){
    await api(`/tasks/${t.id}/assignees`, {method:'POST', body:{user_id: u.id}});
    this.setAssignees([...(t.assignees || []).filter(x => x.id !== u.id), u], t.id);
  },
  async removeAssignee(t, uid){
    await api(`/tasks/${t.id}/assignees/${uid}`, {method:'DELETE'});
    this.setAssignees((t.assignees || []).filter(u => u.id !== uid), t.id);
  },
  setAssignees(assignees, id = this.sheet.task.id){
    if (this.sheet.task?.id === id) { this.sheet.task.assignees = assignees; this.sheet.dirty = true; }
    const c = cache.get(id); if (c) c.assignees = assignees;
    this.syncTask({id, assignees});
  },
  // Label a task, or take a label off. `l` null: a new label called `title`, made first.
  async addLabelTo(t, l, title){
    if (!l) { l = await api('/labels', {method:'POST', body:{title}}); this.labels.push(l); }
    await api(`/tasks/${t.id}/labels`, {method:'POST', body:{label_id: l.id}});
    this.setLabels([...(t.labels || []), l], t.id);
  },
  async removeLabelFrom(t, lid){
    await api(`/tasks/${t.id}/labels/${lid}`, {method:'DELETE'});
    this.setLabels((t.labels || []).filter(l => l.id !== lid), t.id);
  },
  setLabels(labels, id = this.sheet.task.id){
    if (this.sheet.task?.id === id) { this.sheet.task.labels = labels; this.sheet.dirty = true; }
    const c = cache.get(id); if (c) c.labels = labels;
    this.syncTask({id, labels});
  },
};
