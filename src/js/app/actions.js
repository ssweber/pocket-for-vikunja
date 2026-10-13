/* Task actions and their Undo. Lists and sheets call these methods to save, tick, set progress, move, reorder, add
   or delete tasks. Run actions go through the outbox. A parent's ring asks before closing its open subtasks, and
   subtask changes update the parent's computed progress. Project reordering writes List view positions, while
   template steps keep their order in the template's notes. */
import {cache} from '../util.js';
import {api, NetError, patchTask} from '../api.js';
import {addDays, dueInfo, isSet, movedDue, repeats, startOfDay} from '../dates.js';
import {figurePatch, isSubtask, openSubtasks, pctOf, progressPatch} from '../progress.js';
import {dayWord, doneText, movedText, movedTo, notMoved, notMovedBack, notSaved, sentLater} from '../messages.js';
import {htmlToText} from '../html.js';
import {hasOwnOrder, hasTemplateLabel, patiently, stepsOf} from '../checklists.js';
import {between, listViewOf, placeAfter, placeMove, positionOrder, siblingBlocks} from '../order.js';
import {parentIds} from '../lists.js';
import {itemsOf, NO_ROOM, NOT_KEPT, randomId, sync} from '../sync.js';
import {shared} from './core.js';
import {UNDO_MS} from './toast.js';

// Expire a held deletion in another tab or after a restart. This tab can hold its rows longer while a touch or
// scroll keeps the batch waiting.
const HELD_MS = 60e3;

// Track started, finished and active saves by task id. Ignore reads made during a save because its reply may be
// newer.
const saving = new Map();
const saveMark = (id, open) => { const s = saving.get(id) || {n: 0, open: 0}; s.n++; s.open += open; saving.set(id, s); };
export const reminderKey = r => r.relative_to ? r.relative_to + ' ' + (r.relative_period || 0) : +new Date(r.reminder);
// Identify relative reminders by their reference date so they keep following that date.
export const plainReminders = t => (t?.reminders || []).map(r => r.relative_to ? {relative_to: r.relative_to, relative_period: r.relative_period || 0} : {reminder: r.reminder});
const rolls = t => t.repeat_after > 0 || t.repeat_mode === 1;
// Check whether Vikunja saved body's change to before. Completing a repeating task advances its date instead of
// leaving it done.
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
  // Save task changes in order and update their rows. Resolve to Vikunja's copy or reject a failed save.
  saveTask(id, patch, rebase){
    saveMark(id, 1); this.writing++;                                        // from its read first to its reply
    const run = shared.saveChain.then(async () => {
      // Send only changed fields to preserve edits made elsewhere. Lists and template order notes need a
      // whole-field write, so rebase applies the change to a fresh copy, or returns null when nothing remains to
      // change.
      let saved = rebase && await api('/tasks/' + id);
      const before = saved || cache.get(id), body = rebase ? rebase(saved) : patch;
      if (body) {
        try { saved = await patchTask(id, body); }
        catch (e) {
          // Read Vikunja after a lost reply to check whether the save arrived. Retrying a saved tick on a
          // repeating task would skip a date.
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
  // Wait for queued saves before reading. Return null if another save ran during the read, because its reply is
  // newer.
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
  /* Toggle a task from any row or sheet, delegating runs and their steps to the outbox. Subtasks stay unchanged
     unless extra.close requests completion of open, non-repeating subtasks. Undo restores exactly those subtasks
     and the previous progress. Hold list rows from the tap through the save, then mark them until the batch
     clears, with their tick as Undo. Repeating tasks show done until their next date appears. Sheet ticks show
     Undo for closed subtasks, while failed saves offer Try again where the action happened. extra and undoExtra
     carry progress changes through completion and Undo. */
  async toggleDone(t, rowEl, extra = {}, undoExtra = {}){
    const run = this.stepRun(t);
    if (run) return this.tickRunStep(t, run, rowEl);
    if (this.isRunTask(t) && !extra.quiet) return this.tickRunTask(t, rowEl);
    const {quiet, sub: inSheet, sheet, close = false, ...patch} = extra, sub = inSheet || isSubtask(t), was = t.done, head = was && this.isHead(t);
    const inList = !!rowEl && !quiet && !sheet && !inSheet;
    // Use the visible open subtasks. Run steps are completed on their own screen to record who did them.
    const subs = was || quiet || !close || this.isRunTask(t) ? [] : openSubtasks(t).map(s => this.tasks[s.id] || s).filter(s => !s.done);
    // Keep repeating tasks' dates and fixed reminders so Undo can restore them.
    const back = {due_date: t.due_date}, shown = {due_date: t.due_date, start_date: t.start_date, end_date: t.end_date, reminders: t.reminders};
    for (const k of ['start_date', 'end_date']) if (isSet(t[k])) back[k] = t[k];
    if ((t.reminders || []).some(r => !r.relative_to)) back.reminders = plainReminders(t);
    t.done = !was;
    const letGo = !was && inList ? this.holdRow(t.id, 'done') : null;
    try {
      const saved = await this.saveTask(t.id, {done: !was, ...patch});
      Object.assign(t, saved);
      if (sub) this.refigure(t, inSheet ? this.sheet.task?.id : null);
      if (sheet) { this.sheet.dirty = true; this.unsay('sheet:top'); }      // (a tick that wasn't saved before is now)
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
        // Keep the completed row and its old date until the batch clears, then show its next date or remove it
        // from Today.
        Object.assign(t, shown, {done: true});
        const beyond = () => this.route.name === 'today' && !(new Date(saved.due_date) < addDays(startOfDay(), 8));
        this.markRow(t.id, {kind: 'done', out: () => beyond() ? [t.id] : [], undo, said: `Done: ${t.title}. It repeats${next ? ', ' + next : ''}`,
          gone: () => { Object.assign(t, saved); if (beyond()) this.removeRow(t.id); else if (this.route.name === 'today') this.regroupToday(); }});
        return;
      }
      if (head) return this.reopenedHead(t, !inList);
      // Include closed subtasks in the row and sheet, and reopen those same subtasks on Undo.
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
      // Show the sheet's closed-subtask count and Undo under its subtasks.
      if (sheet || inSheet) {
        if (closed.length || (sheet && subs.length)) this.say(text, {place: 'sheet:subtasks', action: {label: 'Undo', fn: undo}});
        return;
      }
      if (!inList) return;
      // Show a partial completion error briefly before restoring the row.
      if (closed.length < subs.length) this.say(text, {row: {id: t.id, stays: true, cls: 'failed'}, ms: 4000});
      // Move completed rows from Today or Open after the batch. Keep a completed parent above any subtasks still
      // open.
      const moves = () => !!this.searchGroups(t);
      if (was && !moves()) { this.said = 'Not done: ' + t.title; return; }
      this.markRow(t.id, {kind: was ? 'open' : 'done', ids, undo, said: was ? 'Not done: ' + t.title : text,
        out: () => over ? closed : this.bothWays && !moves() ? [] : ids,
        gone: () => { if (over) this.moveInSearch(t, closed); else if (this.bothWays) this.moveInSearch(t, ids); else if (t.done) ids.forEach(id => this.removeRow(id)); }});
    } catch (e) {
      t.done = was;
      // Restore a failed list row after its message. The sheet's own task has no departing row, so keep its error
      // until retry, success or closing.
      this.say(notSaved(e), {row: {id: t.id, stays: true, cls: 'failed', ms: UNDO_MS}, place: 'sheet:top', ms: null, action: {label: 'Try again', fn: () => this.toggleDone(t, this.rowEl(t.id), extra, undoExtra)}});
    } finally { letGo?.(); }
  },
  /* Save a parent's computed percent_done after its subtask change, in the same save chain. Read the parent first
     and save only a changed figure, without a message. Templates are excluded, and run actions do this in their
     final outbox stage. */
  writeFigure(id){ return this.saveTask(id, null, now => hasTemplateLabel(now) ? null : figurePatch(now)); },
  // Find the parent from the task, its open sheet or the list's subtask relations.
  parentIdOf(t){
    const own = parentIds(t)[0], has = p => p?.related_tasks?.subtask?.some(s => s.id === t.id);
    return own ?? (has(this.sheet.task) ? this.sheet.task.id : Object.values(this.tasks).find(has)?.id ?? null);
  },
  // Update the parent's progress in the background after a subtask tick or progress change.
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
  // Count a completed parent in Done even while its heading remains above open subtasks.
  makeHead(t){
    const open = this.view.groups.find(x => x.key === 'open'), done = this.view.groups.find(x => x.key === 'done');
    open.heads = [...new Set([...open.heads || [], t.id])];
    if (done?.loaded && !done.tasks.includes(t)) done.tasks.unshift(t);
    if (typeof done?.count === 'number') done.count++;
    return true;
  },
  /* Reopen a completed parent in place above its open subtasks and remove its Done entry. On a list row, its tick
     can mark it done again while the list reloads. */
  reopenedHead(t, quiet){
    this.outOfDone(t.id);
    if (quiet) return;
    this.markRow(t.id, {kind: 'open', out: [], said: 'Not done: ' + t.title, undo: async () => {
      try { Object.assign(t, await this.saveTask(t.id, {done: true})); }
      catch (e) { this.say('Not undone: ' + e.message, {row: {id: t.id, stays: true, cls: 'failed'}}); }
      this.render();
    }});
  },
  // Remove a reopened task from Done and adjust the count even if that section has not loaded.
  outOfDone(id){
    const g = this.view.groups.find(x => x.key === 'done');
    if (!g) return;
    const i = g.tasks.findIndex(x => x.id === id);
    if (i >= 0) g.tasks.splice(i, 1);
    if ((i >= 0 || !g.loaded) && typeof g.count === 'number') g.count = Math.max(0, g.count - 1);
  },
  /* Finish or reopen a run through the outbox, leaving its steps unchanged. The ring asks before finishing with
     open steps. Mark list rows until the batch clears, including their steps, and use the ring as Undo. */
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
    // Show Undo at the sheet's top, or in a toast when the run has no visible row.
    if (!rowEl) { if (!was) this.say(offline ? sentLater('Finished') : said, {place: 'sheet:top', action: {label: 'Undo', fn: undo}}); return; }
    const moves = () => !!this.searchGroups(t), steps = () => stepsOf(t).map(s => s.id);
    if (was && !moves()) { this.said = said; return; }
    this.markRow(t.id, {kind: was ? 'open' : 'done', undo, said, out: () => this.bothWays && !moves() ? [] : [t.id],
      gone: () => { if (this.bothWays) this.moveInSearch(t, [t.id]); else if (t.done) [t.id, ...steps()].forEach(id => this.removeRow(id)); }});
  },
  /* Tick a run step through the outbox to record completion and support offline changes. List rows wait for the
     batch, while sheet subtasks remain visible as done. */
  async tickRunStep(t, run, rowEl){
    const was = t.done;
    t.done = !was;
    // Hold the row until the outbox has queued the tick, as toggleDone does while saving a task.
    const letGo = !was && rowEl ? this.holdRow(t.id, 'done') : null;
    try {
      const r = await this.act({op: was ? 'undone' : 'done', task: t.id, run});
      if (r.status === 'error') { if (!r.error.saved) t.done = was; return; }
      const later = !was && r.status === 'offline' ? sentLater('Done: ' + t.title) : '';
      // In a sheet, offline, its row says when it's sent.
      if (!rowEl) { if (later) this.say(later, {row: {id: t.id, text: sentLater('Done'), stays: true}, place: 'sheet:top'}); return; }
      const moves = () => !!this.searchGroups(t);
      if (was && !moves()) { this.said = 'Not done: ' + t.title; return; }
      this.markRow(t.id, {kind: was ? 'open' : 'done', said: later || (was ? 'Not done: ' : 'Done: ') + t.title, undo: () => this.tickRunStep(t, run, null),
        out: () => this.bothWays && !moves() ? [] : [t.id],
        gone: () => { if (this.bothWays) this.moveInSearch(t, [t.id]); else if (t.done) this.removeRow(t.id); }});
    } finally { letGo?.(); }
  },
  // Open and Done, in search or a project: the one a task is in, and the one its tick moves it to.
  searchGroups(t){
    if (!this.bothWays) return null;
    const from = this.view.groups.find(g => g.key === (t.done ? 'open' : 'done')), to = this.view.groups.find(g => g.key === (t.done ? 'done' : 'open'));
    return from && to && from.tasks.some(x => x.id === t.id) ? {from, to} : null;
  },
  /* Move completed tasks and closed subtasks to the top of Done, or reopened tasks back to Open. Project tasks
     return to their List view positions. Adjust only the count if Done has not loaded. Return whether a row moved. */
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
  // Close subtasks in order and return their ids. Stop at the first failed save.
  async closeSubtasks(subs){
    const closed = [];
    for (const s of subs) { try { await this.saveTask(s.id, {done: true}); closed.push(s.id); } catch { break; } }
    return closed;
  },
  // Reopen subtasks for Undo and return the ids that could not be restored.
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
  /* Set progress on a list row or sheet subtask. At 100%, complete the task. Below 100%, reopen a done task or
     show the new progress on its tick. Keep messages off successful partial progress so the next swipe is
     available. Failed saves offer Try again. undoing restores progress without marking the task done. */
  async setProgress(t, pct, rowEl, {undoing = false, sub = false} = {}){
    const was = pctOf(t), patch = undoing ? {percent_done: pct / 100} : progressPatch(t, pct);
    if (t.done && !undoing && pct < 100) return this.toggleDone(t, rowEl, {...patch, sub});
    if (patch.done) return this.toggleDone(t, rowEl, {...patch, sub}, {percent_done: was / 100});
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
  // Apply sheet progress like list progress. Complete at 100% and update a subtask's parent figure.
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
  /* Detach the open subtask from all parents and keep it in its project. With a known List view position, place it
     just after its parent. Undo restores its parents and subtask position. Recompute each old parent's progress,
     keeping its last figure if no subtasks remain. Run and template steps cannot detach because their order notes
     still name them. */
  get canOwn(){ return this.sheet.kind === 'task' && this.canEdit && !!this.parentTask && !this.checklistRole; },
  async ownTask(){
    const t = this.sheet.task;
    if (!this.canOwn) return;
    const parents = t.related_tasks.parenttask.map(p => ({id: p.id, title: p.title, project_id: p.project_id})), first = parents[0], out = [];
    const view = listViewOf(this.projById.get(t.project_id))?.id, at = this.positions[first.id], was = this.positions[t.id];
    // Apply the fresh copies to the sheet and rows. Updating each parent's figure reads that parent again.
    const fresh = async () => {
      const now = await this.readTask(t.id).catch(() => null) || await this.readTask(t.id).catch(() => null);
      if (now) { cache.set(t.id, now); this.syncTask(now); if (this.sheet.task?.id === t.id) this.showTask(now); }
      await Promise.all(parents.map(p => this.writeFigure(p.id).catch(() => {})));
      if (this.cursor?.id === t.id) this.aim(this.tasks[t.id]);              // keep quick add on the task at its new level
      this.sheet.dirty = true;
    };
    const place = async pos => {
      const had = this.positions[t.id];
      this.positions[t.id] = pos;
      const r = await this.act({op: 'position', task: t.id, view, pos, run: null});
      if (r.status !== 'error') return;
      this.positions[t.id] = had;
      this.say(notMoved(r.error), {place: 'sheet:top', cls: 'failed'});
    };
    try {
      // (Not under it any more already, taken out elsewhere: the same.)
      for (const p of parents) { await patiently(() => api(`/tasks/${p.id}/relations/subtask/${t.id}`, {method: 'DELETE'})).catch(e => { if (e.status !== 404) throw e; }); out.push(p); }
    } catch (e) {
      this.say(notSaved(e), {place: 'sheet:top', cls: 'failed', action: {label: 'Try again', fn: () => this.ownTask()}});
      if (out.length) await fresh();
      return;
    }
    let moved = false;
    if (view && at && first.project_id === t.project_id) {
      const g = this.route.name === 'project' && this.view.project?.id === t.project_id && this.listGroups.find(x => x.key === 'open');
      const tops = g ? g.tasks.filter(x => !g.depth[x.id] && !x.pending) : [], i = tops.findIndex(x => x.id === first.id);
      await place(between(at, i < 0 ? at : this.positions[tops[i + 1]?.id] || null));
      moved = true;
    }
    await fresh();
    const undo = async () => {
      try {
        for (const p of out) await patiently(() => this.linkSubtask(p.id, t.id));
        if (moved && was) await place(was);
      } catch (e) { this.say('Not undone: ' + (e instanceof NetError ? 'no connection' : e.message), {place: 'sheet:top', cls: 'failed'}); }
      await fresh();
    };
    this.say(`Now its own task, no longer under ${out.length === 1 ? `“${first.title}”` : out.length + ' tasks'}`, {place: 'sheet:top', action: {label: 'Undo', fn: undo}});
  },
  // Whether Move all to today has anything to move: not a repeating task, nor a checklist that comes round.
  get overdueMovable(){ return this.overdueTasks.some(t => !repeats(t) && !hasTemplateLabel(t)); },
  /* Move overdue tasks to today while keeping their time of day. Exclude repeating tasks because moving them would
     change their schedule. Show the result under Overdue with Undo to restore each date. reschedule uses the same
     save and Undo for one held row. */
  async moveOverdueToToday(){
    // Exclude repeating checklists so moving one does not change its future schedule.
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
  /* Restore each {t, was} move unless the task changed elsewhere. Explain failures at at with their remaining due
     date still, or no date when null. Pass restored moves to after(back) to update the screen. */
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
  /* Move a held Today row to to.due immediately, then save and offer Undo. Change only a card's parent date. If an
     earlier subtask keeps the card in place, explain why beside the add box. Put Undo on the visible destination
     row, or beside the add box when the row left Today or is offscreen. A failed save restores the old group
     before showing Try again. */
  async reschedule(t, to){
    const c = this.view.cards?.[t.id], m = {t, was: t.due_date, when: c ? c.when : undefined, key: this.todayKey(t)};
    this.placeOnToday(t, to.due);
    // (Where a task due then goes: the same rule as for one waiting to be sent.)
    const want = this.pendingPlace({due_date: to.due}), kept = c && this.todayKey(t) !== want && c.when !== t.due_date
      ? this.cardSubs(t, false).filter(s => !s.done && isSet(s.due_date)).sort((a, b) => Date.parse(a.due_date) - Date.parse(b.due_date))[0] : null;
    const saving = this.saveTask(t.id, {due_date: to.due}).then(() => null, e => e);
    // Undo waits for the save before restoring and highlighting the original position.
    const back = this.undoMoves([m], to.label && dayWord(to.label), {place: 'cap'}, done => { if (done.length) { this.placeOnToday(t, m.was, m.when, m.key); this.flash([t.id], 'arrived'); } });
    const undo = {label: 'Undo', fn: async () => { if (!await saving) await back.fn(); }};
    await this.$nextTick();                                                 // its row is where it is now
    const text = movedTo(to.label, kept?.title), where = this.say(text, {row: !kept && this.rowSeen(t.id) ? {id: t.id, stays: true} : null, place: 'cap', action: undo});
    const e = await saving;
    if (!e) return true;
    this.placeOnToday(t, m.was, m.when, m.key);
    if (where === 'place' && this.places.cap?.text === text) this.endPlace('cap', this.places.cap, false);   // by the add box: there's nothing to undo
    await this.$nextTick();                                                 // (one that had left Today has its row again)
    this.say(notSaved(e), {row: {id: t.id, stays: true, cls: 'failed'}, place: 'cap', action: {label: 'Try again', fn: () => this.reschedule(t, to)}});
    return false;
  },
  // The group of Today's that task `t` is in (its key), or null.
  todayKey(t){ return this.view.groups.find(g => g.tasks.some(x => x.id === t.id))?.key ?? null; },
  /* Place task t in the Today group for due, or remove it beyond the next seven days. Cards use the earliest
     parent or open-subtask date, unless when is supplied for a retry. Without a date, use key for the Added today,
     no date group. */
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
  /* Move t among siblings sibs in project List view view. Update the screen immediately and queue positions
     through the outbox. Rejected moves restore the old order and explain why on the row. If Vikunja renumbers
     positions, applyAct reloads the view. Return whether the task moved. */
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
  // Reload the list if Vikunja renumbered the position instead of keeping the value sent.
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
  /* Return {sibs, view, blocks} for reordering among siblings, or null when unavailable. List moves include each
     sibling's subtasks, sheet moves use the loaded subtask order, and an own-sheet move uses the visible list or
     known parent order. Exclude done, pending, read-only and cross-project subtasks, plus template and run steps
     with their own order notes. */
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
  /* Queue subtask-box lines like quick add so they appear immediately and survive connection loss. The sheet box
     inserts at its selected row or the end. The list box inserts at the cursor, following each newly added
     subtask. Save List view positions so Vikunja does not put them first. Keep input focus and use row deletion
     with Undo for mistakes. */
  /* Place n sheet subtasks after the selected row or its latest pending addition, or last when the box is at the
     foot. Return null until the order is known, and avoid positions already used by another task. */
  subPlaces(n){
    const s = this.sheet;
    if (!s.subView && this.subtasks.length) return null;
    const sibs = this.subtasks.map(x => this.positions[x.id] || 0), under = s.subAt != null;
    const places = this.clearPlaces(placeAfter(sibs, under ? s.subAfter ?? this.positions[s.subAt] ?? null : null, n), sibs);
    if (under) s.subAfter = places.at(-1);
    return places;
  },
  async addSubtasks(w = 'sub'){
    const foot = w === 'under', today = foot && this.route.name === 'today', parent = this.boxParent(w), b = this.box(w), parsed = this.boxParsedLines(w);
    if (!parent || !parsed.some(p => p.title)) return;
    const n = parsed.filter(p => p.title).length;
    const at = foot ? this.cursorPlaces(n) : this.subPlaces(n);
    const items = itemsOf(this.boxItems(w), k => at && {position: at[k]});
    const entry = {id: randomId(), user: this.user?.id, at: new Date().toISOString(), nest: false, pid: parent.project_id,
      parent: {id: parent.id, project_id: parent.project_id, title: parent.title}, items, files: []};
    // Reserve new direct subtasks on Today's card immediately, in entry order after the cursor or below the
    // header.
    if (today) {
      if (!this.cardAdded[parent.id]) this.cardAdded[parent.id] = [];
      const rows = this.cardAdded[parent.id];
      let after = this.cursor?.under != null ? this.cursor.id : null;
      items.forEach((x, i) => { if (x.under === null) { rows.push({id: `pending-${entry.id}-${i}`, after}); after = rows.at(-1).id; } });
    }
    // Follow the last new direct subtask with the highlight so the next entry follows it, rather than a nested
    // child.
    if (foot) this.aimAdded(entry, items.findLastIndex(x => x.under === null), parent);
    const here = () => foot || this.sheet.task?.id === parent.id, place = foot ? 'cap' : 'sheet:subtasks';
    // Allow another submission while this batch sends. adding counts the batches still pending.
    b.adding++; b.text = '';
    if (!foot || b.focus) this.$nextTick(() => this.boxEl(w)?.focus());
    try {
      // Show rows and the target highlight before queuing finishes. Delay the waiting appearance until sending
      // takes a while.
      const keeping = sync.add(entry, []);
      this.refreshPending();
      const {kept, full} = await keeping;
      const r = await sync.lock(() => this.sendEntry(entry.id));
      if (foot) this.refreshPending();                                    // the waiting rows, and the rows sent, swapped at once
      // Replace pending card rows with their saved tasks while preserving the target highlight.
      if (today) for (const {child, problems, arrived, was, place, ...x} of r.tasks || []) { this.keep(x); for (const a of this.cardAdded[parent.id] || []) { if (a.id === was) a.id = x.id; if (a.after === was) a.after = x.id; } }
      this.placeSent(r.tasks || []);
      const but = r.problems?.length ? `, but ${r.problems.join('; ')}` : '';
      if (r.ids?.length && foot) {
        this.flash(r.ids);
        // Reload the parent's subtask count. Today's card already holds the new rows in their insertion positions.
        this.readTask(parent.id).then(t => { if (t) { cache.set(t.id, t); this.keep(t); } }).catch(() => {});
      } else if (r.ids?.length && here()) {
        this.sheet.dirty = true;
        try { const t = await this.readTask(parent.id); if (t) { cache.set(t.id, t); if (here()) { this.showTask(t); this.loadSubPeople(t); this.loadSubOrder(t); } } } catch {}
        // Follow the last added sheet subtask so the next entry follows it.
        const last = r.ids[items.findLastIndex(x => x.under === null)];
        if (here() && this.sheet.subAt != null && last) { this.sheet.subAt = last; this.sheet.subAfter = null; this.seatFoot('sheet'); }
      }
      if (r.status === 'offline') {
        sync.keep();
        // From the add box, their rows say they're waiting.
        if (!foot || !kept || today) this.say(!kept ? (full ? NO_ROOM : NOT_KEPT) : `Saved offline. ${n === 1 ? 'It goes' : 'They go'} to Vikunja when you're back online.`, {place, cls: kept ? '' : 'failed'});
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
    if (!confirm(`Delete the template “${t.title}”` + (n ? ` and its ${n} step${n === 1 ? '' : 's'}? Checklists already started keep theirs.` : '?') + ' This can\'t be undone here.')) return;
    await shared.saveChain;
    try {
      await this.deleteTree(tree);
      await leave();
      this.render();
      this.notify(n ? `Deleted, with ${n} step${n === 1 ? '' : 's'}` : 'Deleted');                   // its sheet and row are gone
    } catch (e) { this.say(`Stopped after deleting ${e.deleted} of ${tree.length}: ${e.message}`, {place: 'sheet:top', cls: 'failed'}); this.render(); }
  },
  // Allow swipe deletion only for saved writable tasks. Runs, their steps and templates have their own deletion
  // paths.
  canDelete(t, sheet){
    return !t.pending && this.canWrite(t.project_id) && !this.isRunTask(t) && !this.stepRun(t) && !(this.checklistIds.has(t.project_id) && hasTemplateLabel(t))
      && !(sheet && ['run', 'template'].includes(this.checklistRole));
  },
  /* Hold task deletions in the outbox while marked rows keep a Restore gap until the batch clears. Delete
     descendants too, asking first when any exist. Restore removes the held entry without recreating tasks. Send
     when the rows or Undo message leave, or when Pocket closes. Persist the hold so reopening or reconnecting
     finishes the deletion. Return false if cancelled. tree reuses a deletion already confirmed. */
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
  /* Find the task and descendants to delete, deepest first, and confirm their count. Return null on cancellation
     or a read error. Swipe deletion asks before moving any row. */
  async askDelete(t){
    let tree;
    try { tree = await this.taskTree(t.id); } catch (e) { this.say('Not deleted: ' + e.message, {row: {id: t.id, stays: true, cls: 'failed'}, place: 'sheet:top'}); return null; }
    const n = tree.length - 1, direct = (t.related_tasks?.subtask || []).filter(s => tree.includes(s.id)).length;
    const deeper = n > direct ? `, ${n - direct} more under ${direct === 1 ? 'it' : 'them'}` : '';
    return n && !confirm(`Delete “${t.title}” and its ${direct} subtask${direct === 1 ? '' : 's'}${deeper}?`) ? null : tree;
  },
  /* Confirm the task tree unless tree already supplies it. Queue a held deletion and call show({id, n, ids})
     before hiding unmarked rows. Keep the entry until sendHeld or undoDelete. Return {id, n}, or null on
     cancellation. */
  async holdDelete(t, show, tree = null){
    tree ||= await this.askDelete(t);
    if (!tree) return null;
    const n = tree.length - 1;
    // Update the surviving parent's progress in the deletion action's final stage.
    const up = this.parentIdOf(t);
    const entry = {id: randomId(), kind: 'act', op: 'delete', user: this.user?.id, at: new Date().toISOString(), items: [], files: [], stage: 0, fails: 0,
      run: null, task: t.id, ids: tree, label: t.title, until: Date.now() + HELD_MS, ...typeof up === 'number' && !tree.includes(up) && {up}};
    sync.held.add(entry.id);
    const added = sync.add(entry, []);
    show?.({id: entry.id, n, ids: tree});
    this.refreshPending();                                                  // hide unmarked rows immediately while Restore gaps stay visible
    await added;
    return {id: entry.id, n};
  },
  // Cancel the held deletion and restore its rows.
  async undoDelete(id){
    if (!sync.held.delete(id)) return;
    // Restore the rows before removing the outbox entry so they do not disappear for a frame.
    const e = this.user ? sync.all(this.user.id).find(x => x.id === id) : null;
    if (e) this.deleting = this.deleting.filter(x => !e.ids.includes(x));
    await sync.lock(() => sync.remove(id));
    this.refreshPending();
  },
  // Send a deletion after its rows or Undo leave. Without id, send all held deletions when Pocket is hidden.
  async sendHeld(id){
    if (!id) { await Promise.all([...sync.held].map(h => this.sendHeld(h))); return; }
    if (!sync.held.delete(id)) return;                                      // undone, or sent already
    await sync.lock(async () => { const e = await sync.fresh(id); if (e?.until) { delete e.until; await sync.save(e); } });
    await this.sendActs(id);
  },
  /* Collect descendants deepest first. Keep a subtask and its descendants when another parent still owns it. */
  async taskTree(id){
    const out = [], seen = new Set();
    const walk = async (tid, from) => {
      if (seen.has(tid)) return;
      seen.add(tid);
      // Use cached descendants offline. Unseen subtasks cannot be included in the deletion.
      const t = tid === this.sheet.task?.id ? this.sheet.task : await api('/tasks/' + tid).catch(e => { if (e instanceof NetError) return cache.get(tid) || {id: tid}; throw e; });
      if (from && (t.related_tasks?.parenttask || []).some(p => p.id !== from)) return;
      for (const sub of t.related_tasks?.subtask || []) await walk(sub.id, tid);
      out.push(tid);
    };
    await walk(id, null);
    return out;
  },
  // Stop deleting at the first rejection and report the number already deleted in e.deleted.
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
  // Save assignee changes before applying them to the screen and cache.
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
  // Add a label, creating it with title first when l is null.
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
