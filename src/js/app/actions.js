/* Task actions and their Undo. Lists and sheets call these methods to save, tick, set progress, move, reorder, add
   or delete tasks. Actions on a checklist and its steps go through the outbox. Changing a subtask also updates the
   parent's computed progress. Reordering in a project writes List view positions. A template keeps its step order
   in its notes instead. */
import {api, NetError, patchTask} from '../api.js';
import {dueInfo, isSet, movedDue, repeats} from '../dates.js';
import {figurePatch, isSubtask, openSubtasks, pctOf, progressPatch} from '../progress.js';
import {dayWord, doneText, movedText, movedTo, movedToProject, notKnown, notReordered, notMovedBack, notSaved, sentLater, toOutbox} from '../messages.js';
import {htmlToText} from '../html.js';
import {DONE_MARK, patiently, stepsOf} from '../checklists.js';
import {between, listViewOf, placeAfter, placeMove, positionOrder, siblingBlocks} from '../order.js';
import {dayGroup, parentIds} from '../lists.js';
import {itemsOf, NO_ROOM, NOT_KEPT, sync, uuid7} from '../sync.js';
import {addLines} from '../ops/index.js';
import {shared} from './core.js';
import {UNDO_MS} from './toast.js';
import {copyOf, started, TASK} from './tasks.js';

// How long a held deletion stays valid. After that, another tab or a restarted Pocket may send it. This tab can keep
// its rows longer if a touch or scroll keeps the batch waiting.
const HELD_MS = 60e3;

// The ✅ requests, sent one after another in the order their ticks saved. Otherwise a slow untick's request could
// arrive after the next tick's and take that ✅ off.
let marks = Promise.resolve();
export const reminderKey = r => r.relative_to ? r.relative_to + ' ' + (r.relative_period || 0) : +new Date(r.reminder);
// A relative reminder is saved as its reference date and offset, so it keeps following that date.
export const plainReminders = t => (t?.reminders || []).map(r => r.relative_to ? {relative_to: r.relative_to, relative_period: r.relative_period || 0} : {reminder: r.reminder});
const rolls = t => t.repeat_after > 0 || t.repeat_mode === 1;
// Whether `now`, Vikunja's copy, already has the change `body` made to `before`. Completing a repeating task moves
// its due date forward and leaves it open, so that counts as saved.
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
  // Save task changes one after another, and put Vikunja's answer into its copy, which shows it on the rows. Resolves
  // to Vikunja's copy, or rejects if the save fails. The caller writes nothing more, since the copy has it.
  saveTask(id, patch, rebase){
    this.writing++;                                                         // counts until the reply arrives
    const run = shared.saveChain.then(async () => {
      // Only the changed fields are sent, so edits made elsewhere survive. A change to a whole field, such as a list
      // or a template's order notes, uses `rebase` instead. It applies the change to a fresh copy of the task and
      // returns null when nothing is left to change. That copy is a read, not an answer.
      let saved = null;
      if (rebase) { const at = started(); saved = await api('/tasks/' + id); this.change(w => w.read([saved], TASK, at)); }
      const before = saved || copyOf(id), body = rebase ? rebase(saved) : patch;
      if (body) {
        try { saved = await patchTask(id, body); }
        catch (e) {
          // After a lost reply, read the task to see whether the save arrived. Sending a tick again on a repeating
          // task that was already saved would skip a date.
          const now = e instanceof NetError && await api('/tasks/' + id).catch(() => null);
          if (!now || !landed(now, body, before)) throw e;
          saved = now;
        }
        this.change(w => w.answer([saved], TASK));
      }
      if (body && 'done' in body && saved.done === body.done && before?.done !== saved.done && this.role(before) !== 'template' && this.role(this.tasks[id]) !== 'template') this.signTick(saved);
      return saved;
    }).finally(() => { this.writing--; });
    shared.saveChain = run.catch(() => {});
    return run;
  },
  /* Put the user's ✅ on a task they tick, and take it off when they untick it, as a checklist's step has. Vikunja
     doesn't record who ticked a task, and Done today finds the user's ticks by it (doneByMe). A project only the user
     can see needs none, since everything in it is theirs. A ✅ that fails to save leaves the tick as it is. */
  signTick(t){
    if (this.seenBy?.[t.project_id] === 0 || this.role(t) === 'template') return;
    marks = marks.then(() => api(`/tasks/${t.id}/reactions${t.done ? '' : '/delete'}`, {method: 'POST', body: {value: DONE_MARK}}).catch(() => {}));
  },
  /* On Today, a task ticked there joins Done today when the batch clears, so Copy includes it at once. A checklist's
     step doesn't, since its checklist stands for it. */
  intoDoneToday(ids){
    const g = this.route.name === 'today' && this.view.groups.find(x => x.key === 'donetoday');
    for (const id of g ? ids : []) { const t = this.tasks[id]; if (t?.done && !this.stepRun(t) && !g.tasks.includes(t)) g.tasks.unshift(t); }
  },
  // saveTask, for a task the caller holds.
  async saveFor(t, patch){
    const e = this.change(w => w.edit(t.id, {}));
    try { const got = await this.saveTask(t.id, patch); this.change(() => e.ok()); return got; } catch (x) { this.change(() => e.undo()); throw x; }
  },
  // Whether a task is still as Pocket last saved it. Undo checks this so it doesn't overwrite a change made elsewhere.
  async unchanged(t){ const now = await api('/tasks/' + t.id); return !t.updated || now.updated === t.updated; },
  // Saves [task, patch] pairs and resolves to the tasks that saved.
  async saveEach(pairs){
    const results = await Promise.allSettled(pairs.map(([t, patch]) => this.saveTask(t.id, patch)));
    return pairs.filter((p, i) => results[i].status === 'fulfilled').map(([t]) => t);
  },

  /* ---------- done, and not done again ---------- */
  /* Toggle a task from any row or sheet. A checklist and its steps go through the outbox instead. Ticking a task
     leaves its subtasks open unless `extra.close` asks to close its open, non-repeating subtasks too. Undo reopens
     exactly those subtasks and restores the earlier progress.

     A ticked list row stays in place from the tap until the save answers (holdRow). Then it is marked until the
     batch clears, and tapping its tick undoes it. A repeating task shows as done until its next date appears.
     A tick in a sheet shows Undo only when it closed subtasks. A failed save shows Try again where the user ticked.

     `extra` and `undoExtra` are patches, such as progress, that are saved with the tick and with Undo. */
  async toggleDone(t, rowEl, extra = {}, undoExtra = {}){
    const run = this.stepRun(t);
    if (run) return this.tickRunStep(t, run, rowEl);
    if (this.isRunTask(t) && !extra.quiet) return this.tickRunTask(t, rowEl);
    const {quiet, sub: inSheet, sheet, close = false, ...patch} = extra, sub = inSheet || isSubtask(t), was = t.done, head = was && this.isHead(t);
    const inList = !!rowEl && !quiet && !sheet && !inSheet;
    // The open subtasks shown to the user, each with its own row, where the ring and the sheet show it closed. A
    // checklist's steps are ticked on its own screen, which records who did them.
    const subs = was || quiet || !close || this.isRunTask(t) ? [] : openSubtasks(t, s => this.row(s));
    // Remember the dates and reminders a repeating task changes when ticked, so Undo can restore them.
    const back = {due_date: t.due_date};
    for (const k of ['start_date', 'end_date']) if (isSet(t[k])) back[k] = t[k];
    if ((t.reminders || []).some(r => !r.relative_to)) back.reminders = plainReminders(t);
    // A ticked list row is held, so it keeps every field, a repeating task's old date included, until its batch clears.
    const ticked = this.change(w => w.edit(t.id, {done: !was}));
    const letGo = !was && inList ? this.holdRow(t.id, 'done') : null;
    try {
      const saved = await this.saveTask(t.id, {done: !was, ...patch});
      this.change(() => ticked.ok());
      if (sub) this.refigure(t, inSheet ? this.sheet.id : null);
      if (sheet) { this.sheet.dirty = true; this.unsay('sheet:top'); }      // clears the message from an earlier failed save
      if (!was && !saved.done) {                 // a repeating task moved to its next date, so Undo puts the old date back
        const err = {row: {id: t.id, stays: true, cls: 'failed'}, place: 'sheet:top'};
        const undo = async () => {
          try {
            if (!await this.unchanged(t)) { this.say(`Not undone: “${t.title}” has changed since then`, err); return; }
            await this.saveFor(t, {...back, ...undoExtra});
          } catch (e) { this.say('Not undone: ' + e.message, err); }
          this.render();
        };
        const d = dueInfo(saved.due_date), next = d ? 'next ' + d.label : '';
        if (sheet) { this.say(next ? 'Repeats · ' + next : 'Done — repeats', {place: 'sheet:top', action: {label: 'Undo', fn: undo}}); return; }
        if (!inList) return;
        // The completed row keeps its old date until the batch clears, then shows its next date or leaves Today.
        const beyond = () => this.route.name === 'today' && dayGroup(saved.due_date) === null;
        this.markRow(t.id, {kind: 'done', out: () => beyond() ? [t.id] : [], undo, said: `Done: ${t.title}. It repeats${next ? ', ' + next : ''}`,
          gone: () => { if (beyond()) this.removeRow(t.id); else if (this.route.name === 'today') this.regroupToday(); }});
        return;
      }
      if (head) return this.reopenedHead(t, !inList);
      // The subtasks closed with the parent show as done on their own rows, and the parent's progress is written after
      // them. Undo reopens the same subtasks.
      const closed = was ? [] : await this.closeSubtasks(subs), ids = [t.id, ...closed], figure = () => this.writeFigure(t.id).catch(() => {});
      if (closed.length) figure();
      // On a project's list, a done parent stays above the subtasks that are still open. Those are subtasks that
      // repeat or that were not saved.
      const over = !was && !sub && !sheet && this.leftOpenUnder(t) && this.makeHead(t);
      const undo = was ? async () => { await this.toggleDone(t, null, {quiet: true, sheet, sub: inSheet}); this.render(); }
        : async () => {
          await this.toggleDone(t, null, {...undoExtra, quiet: true, sheet, sub: inSheet});
          const failed = await this.reopen(closed);
          if (closed.length > failed.length) figure();
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
      // After the batch clears, completed rows leave Today or Open. A completed parent stays above subtasks that are
      // still open.
      const moves = () => !!this.searchGroups(t);
      if (was && !moves()) { this.said = 'Not done: ' + t.title; return; }
      this.markRow(t.id, {kind: was ? 'open' : 'done', ids, undo, said: was ? 'Not done: ' + t.title : text,
        out: () => over ? closed : this.bothWays && !moves() ? [] : ids,
        gone: () => { if (over) this.moveInSearch(t, closed); else if (this.bothWays) this.moveInSearch(t, ids); else if (t.done) { ids.forEach(id => this.removeRow(id)); this.intoDoneToday(ids); } }});
    } catch (e) {
      this.change(() => ticked.undo());
      // The list row comes back after the message. The sheet's own task has no row to bring back, so its message
      // stays until the user retries, succeeds or closes the sheet.
      this.say(notSaved(e), {row: {id: t.id, stays: true, cls: 'failed', ms: UNDO_MS}, place: 'sheet:top', ms: null, action: {label: 'Try again', fn: () => this.toggleDone(t, this.rowEl(t.id), extra, undoExtra)}});
    } finally { letGo?.(); }
  },
  /* Save a parent's computed percent_done after one of its subtasks changes, in the same save chain. It reads the
     parent first and saves only if the percentage changed, without a message. Templates are skipped. Actions on a
     checklist do this in their last outbox stage instead. */
  writeFigure(id){ return this.saveTask(id, null, now => this.role(now) === 'template' ? null : figurePatch(now)); },
  // Find a task's parent from the task itself, from the open sheet, or from the subtask relations of the loaded tasks.
  parentIdOf(t){
    const own = parentIds(t)[0], has = p => p?.related_tasks?.subtask?.some(s => s.id === t.id);
    return own ?? (has(this.sheetTask) ? this.sheet.id : Object.values(this.tasks).find(has)?.id ?? null);
  },
  // Update the parent's progress in the background after a subtask is ticked or its progress changes.
  refigure(t, up = null){
    const id = up ?? this.parentIdOf(t);
    if (typeof id === 'number') this.writeFigure(id).catch(() => {});
  },
  // Whether a done task is shown struck through on a project's open list, above subtasks that are still open
  // (loadProject).
  isHead(t){ return !!t?.done && this.route.name === 'project' && !!this.view.groups.find(g => g.key === 'open')?.heads?.includes(t.id); },
  // Whether a task on a project's open list has subtasks still open under it there.
  leftOpenUnder(t){
    const g = this.route.name === 'project' && this.view.groups.find(x => x.key === 'open');
    return !!g && g.tasks.includes(t) && g.tasks.some(x => !x.done && !this.beingDeleted(x.id) && parentIds(x).includes(t.id));
  },
  // Add a completed parent to Done and its count, while its heading stays on the open list above its open subtasks.
  makeHead(t){
    const open = this.view.groups.find(x => x.key === 'open'), done = this.view.groups.find(x => x.key === 'done');
    open.heads = [...new Set([...open.heads || [], t.id])];
    if (done?.loaded && !done.tasks.includes(t)) done.tasks.unshift(t);
    if (typeof done?.count === 'number') done.count++;
    return true;
  },
  /* Reopen a completed parent in place above its open subtasks and remove it from Done. Unless `quiet`, the row is
     marked, so tapping its tick marks the task done again. */
  reopenedHead(t, quiet){
    this.outOfDone(t.id);
    if (quiet) return;
    this.markRow(t.id, {kind: 'open', out: [], said: 'Not done: ' + t.title, undo: async () => {
      try { await this.saveFor(t, {done: true}); }
      catch (e) { this.say('Not undone: ' + e.message, {row: {id: t.id, stays: true, cls: 'failed'}}); }
      this.render();
    }});
  },
  // Remove a reopened task from Done and lower the count. The count is lowered even if Done has not loaded.
  outOfDone(id){
    const g = this.view.groups.find(x => x.key === 'done');
    if (!g) return;
    const i = g.tasks.findIndex(x => x.id === id);
    if (i >= 0) g.tasks.splice(i, 1);
    if ((i >= 0 || !g.loaded) && typeof g.count === 'number') g.count = Math.max(0, g.count - 1);
  },
  /* Finish or reopen a checklist through the outbox, leaving its steps as they are. The ring asks before finishing
     a checklist that has open steps. A list row is marked until the batch clears, and tapping the ring undoes it. */
  async tickRunTask(t, rowEl){
    const was = t.done, head = was && this.isHead(t);
    const r = await this.act({op: was ? 'reopen' : 'finish', task: t.id, run: t.id});
    if (r.status === 'error') return;
    // A finished checklist shown above steps that are still open (isHead) stays in place when reopened. It only
    // leaves Done.
    if (head) return this.outOfDone(t.id);
    const offline = r.status === 'offline', said = was ? 'Not done: ' + t.title : offline ? sentLater('Finished ' + t.title) : 'Finished ' + t.title;
    const undo = async () => { await this.act({op: was ? 'finish' : 'reopen', task: t.id, run: t.id}); this.render(); };
    // Without a visible row, show Undo at the top of the sheet, or in a toast.
    if (!rowEl) { if (!was) this.say(offline ? sentLater('Finished') : said, {place: 'sheet:top', action: {label: 'Undo', fn: undo}}); return; }
    const moves = () => !!this.searchGroups(t), steps = () => stepsOf(t).map(s => s.id);
    if (was && !moves()) { this.said = said; return; }
    this.markRow(t.id, {kind: was ? 'open' : 'done', undo, said, out: () => this.bothWays && !moves() ? [] : [t.id],
      gone: () => { if (this.bothWays) this.moveInSearch(t, [t.id]); else if (t.done) { [t.id, ...steps()].forEach(id => this.removeRow(id)); this.intoDoneToday([t.id]); } }});
  },
  /* Tick a checklist step through the outbox, which records who did it and works offline. The op shows the tick on
     the step's row while it waits. A list row waits for the batch to clear. In a sheet the step stays visible as done. */
  async tickRunStep(t, run, rowEl){
    const was = t.done, acting = this.act({op: was ? 'undone' : 'done', task: t.id, run});
    // Hold the row until the outbox has queued the tick, as toggleDone does while saving a task. The row is held only
    // after the op is on it, because a row held done takes no op until its batch clears.
    const letGo = !was && rowEl ? this.holdRow(t.id, 'done') : null;
    try {
      const r = await acting;
      if (r.status === 'error') return;
      const later = !was && r.status === 'offline' ? sentLater('Done: ' + t.title) : '';
      // In a sheet while offline, the step's row says it will be sent later.
      if (!rowEl) { if (later) this.say(later, {row: {id: t.id, text: sentLater('Done'), stays: true}, place: 'sheet:top'}); return; }
      const moves = () => !!this.searchGroups(t);
      if (was && !moves()) { this.said = 'Not done: ' + t.title; return; }
      this.markRow(t.id, {kind: was ? 'open' : 'done', said: later || (was ? 'Not done: ' : 'Done: ') + t.title, undo: () => this.tickRunStep(t, run, null),
        out: () => this.bothWays && !moves() ? [] : [t.id],
        gone: () => { if (this.bothWays) this.moveInSearch(t, [t.id]); else if (t.done) this.removeRow(t.id); }});
    } finally { letGo?.(); }
  },
  // In search and in a project, Open and Done show together. Returns the group a task is in and the group its tick
  // moves it to, or null.
  searchGroups(t){
    if (!this.bothWays) return null;
    const from = this.view.groups.find(g => g.key === (t.done ? 'open' : 'done')), to = this.view.groups.find(g => g.key === (t.done ? 'done' : 'open'));
    return from && to && from.tasks.some(x => x.id === t.id) ? {from, to} : null;
  },
  /* Move completed tasks and closed subtasks to the top of Done, or reopened tasks back to Open. In a project,
     reopened tasks go back to their List view positions. If Done has not loaded, only its count changes. Returns
     whether a row moved. */
  moveInSearch(t, ids){
    const g = this.searchGroups(t);
    if (!g) return false;
    for (const id of ids) {
      const i = g.from.tasks.findIndex(x => x.id === id);
      if (i < 0) continue;
      const [x] = g.from.tasks.splice(i, 1);
      if (g.to.loaded !== false && !g.to.tasks.includes(x)) g.to.tasks.unshift(x);
      for (const k of ['from', 'to']) if (typeof g[k].count === 'number') g[k].count += k === 'to' ? 1 : -1;
    }
    if (this.route.name === 'project' && !t.done) this.render();
    return true;
  },
  // Close subtasks in order and return the ids that closed. Stops at the first failed save.
  async closeSubtasks(subs){
    const closed = [];
    for (const s of subs) { try { await this.saveTask(s.id, {done: true}); closed.push(s.id); } catch { break; } }
    return closed;
  },
  // Reopen subtasks for Undo and return the ids that could not be reopened.
  async reopen(ids){
    const failed = [];
    for (const id of ids) await this.saveTask(id, {done: false}).catch(() => failed.push(id));
    return failed;
  },
  // Tick the sheet's task, or take its progress to 100%, the same as a row's tick. Undo puts the earlier progress back.
  async sheetDone(patch = null){
    const t = this.sheetTask;
    if (!t || (patch && t.done)) return;
    await this.toggleDone(t, null, {...patch, sheet: true}, patch ? {percent_done: pctOf(t) / 100} : {});
    this.sheet.dirty = true;
  },
  // Tick a subtask in its parent's sheet, the same as in a list. A checklist's step is ticked as on the checklist's
  // own screen.
  async toggleSubtask(st){
    if (this.checklistRole === 'run') await this.tickRunStep(st, this.sheet.id, null);
    else await this.toggleDone(st, null, {sub: true});
    this.sheet.dirty = true;
  },

  /* ---------- progress ---------- */
  /* Set progress on a list row or a sheet subtask. At 100% the task is completed. Below 100% a done task reopens,
     and any other task shows the new progress on its tick. A partial change shows no message when it saves, so the
     next swipe is not blocked. A failed save offers Try again. With `undoing`, the progress is restored without
     marking the task done. */
  async setProgress(t, pct, rowEl, {undoing = false, sub = false} = {}){
    const was = pctOf(t), patch = undoing ? {percent_done: pct / 100} : progressPatch(t, pct);
    if (t.done && !undoing && pct < 100) return this.toggleDone(t, rowEl, {...patch, sub});
    if (patch.done) return this.toggleDone(t, rowEl, {...patch, sub}, {percent_done: was / 100});
    const set = this.change(w => w.edit(t.id, {percent_done: patch.percent_done}));
    try {
      await this.saveTask(t.id, patch);
      this.change(() => set.ok());
      this.said = `Progress of ${t.title} set to ${pct}%`;
      if (sub || isSubtask(t)) this.refigure(t, sub ? this.sheet.id : null);
    } catch (e) {
      this.change(() => set.undo());
      this.say(notSaved(e), {row: {id: t.id, stays: true, cls: 'failed'}, action: {label: 'Try again', fn: () => this.setProgress(t, pct, this.rowEl(t.id), {undoing, sub})}});
    }
  },
  // Set progress from the sheet the same way a list does. 100% completes the task, and a subtask's parent gets its
  // progress recalculated.
  async sheetProgress(t, pct){
    const patch = progressPatch(t, pct);
    if (t.done && pct < 100) return this.toggleDone(t, null, {...patch, sheet: true});   // reopens at that progress
    if (patch.done) return this.sheetDone(patch);
    if (await this.save(patch) === false) return;
    this.said = `Progress set to ${pct}%`;
    if (isSubtask(t)) this.refigure(t);
  },

  /* ---------- moving ---------- */
  // Whether the open task can move to another project. A template, a checklist and their steps can't, because Pocket
  // finds them by their checklist project.
  get canMove(){ return this.sheet.kind === 'task' && this.canEdit && [null, 'candidate'].includes(this.checklistRole); },
  /* Move the open task to project `pid`, with its subtasks at every level. The message at `at` has an Undo, which
     puts the task and each subtask that moved back in the project it came from. */
  async moveTask(pid, at = 'sheet:props'){
    const t = this.sheetTask, from = t?.project_id, kids = [], moved = [];
    if (!t || pid === from || !this.canMove) return;
    const walk = async (id, seen = new Set([t.id])) => {
      const x = id === t.id ? t : (copyOf(id) || await api('/tasks/' + id));
      for (const sub of x.related_tasks?.subtask || []) if (!seen.has(sub.id)) { seen.add(sub.id); kids.push({id: sub.id, was: sub.project_id ?? from}); await walk(sub.id, seen); }
    };
    await this.save({project_id: pid});
    if (copyOf(t.id)?.project_id !== pid) return;                        // the move failed
    const undo = async () => {
      if (this.sheet.id !== t.id || await this.save({project_id: from}) === false) return;   // save says why it failed
      const left = moved.length - (await this.saveEach(moved.map(k => [k, {project_id: k.was}]))).length;
      if (left) this.say(`Moved back, but not ${left === 1 ? '1 subtask' : left + ' subtasks'}`, {place: at, cls: 'failed'});
      else this.said = 'Moved back to ' + (this.projById.get(from)?.title || 'its project');
      this.sheet.dirty = true;
    };
    const to = this.projById.get(pid)?.title, action = {label: 'Undo', fn: undo};
    try {
      await walk(t.id);
      for (const k of kids) if (k.was !== pid) { await this.saveTask(k.id, {project_id: pid}); moved.push(k); }
      this.say(movedToProject(to, moved.length), {place: at, action});
    } catch (e) { this.say(`Moved, but not all its subtasks: ${e.message}`, {place: at, cls: 'failed', action}); }
    this.sheet.dirty = true;
  },
  /* Detach the open subtask from all its parents and keep it in its project. If its parent's List view position is
     known, the task is placed just after the parent. Undo restores the parents and the position. Each old parent's
     progress is recalculated, and keeps its last value if no subtasks remain. A checklist step or a template step
     cannot be detached, because the order notes still name it. */
  get canOwn(){ return this.sheet.kind === 'task' && this.canEdit && !!this.parentTask && !this.checklistRole; },
  async ownTask(){
    const t = this.sheetTask;
    if (!this.canOwn) return;
    const parents = t.related_tasks.parenttask.map(p => ({id: p.id, title: p.title, project_id: p.project_id})), first = parents[0], out = [];
    const view = listViewOf(this.projById.get(t.project_id))?.id, at = this.positions[first.id], was = this.positions[t.id];
    // Refresh the sheet and rows from Vikunja's copies. Recalculating each parent's progress reads that parent again.
    const fresh = async () => {
      const now = await this.readCopy(t.id).catch(() => null) || await this.readCopy(t.id).catch(() => null);
      if (now && this.sheet.id === t.id) this.showTask(now);
      await Promise.all(parents.map(p => this.writeFigure(p.id).catch(() => {})));
      if (this.cursor?.id === t.id) this.aim(this.tasks[t.id]);              // keeps the add box on the task at its new level
      this.sheet.dirty = true;
    };
    const place = async pos => {
      const had = this.positions[t.id];
      this.positions[t.id] = pos;
      const r = await this.act({op: 'position', task: t.id, view, pos, run: null});
      if (r.status !== 'error') return;
      this.positions[t.id] = had;
      this.say(notReordered(r.error), {place: 'sheet:top', cls: 'failed'});
    };
    try {
      // A 404 means the task is already not a subtask of this parent, for example because it was detached elsewhere.
      // That counts as success.
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
    this.say(`No longer a subtask of ${out.length === 1 ? `“${first.title}”` : out.length + ' tasks'}`, {place: 'sheet:top', action: {label: 'Undo', fn: undo}});
  },
  // Whether Move all to today has anything to move. Repeating tasks and repeating checklists don't count.
  get overdueMovable(){ return this.overdueTasks.some(t => !repeats(t) && this.role(t) !== 'template'); },
  /* Move overdue tasks to today, keeping their time of day. Repeating tasks and repeating checklists stay, because
     moving them would change their schedule. The result shows under Overdue with an Undo that restores each date.
     `reschedule` uses the same save and Undo for one held row. */
  async moveOverdueToToday(){
    // A card counts its own task and those of its subtasks that are overdue themselves (overdueTasks).
    const overdue = this.overdueTasks, tasks = overdue.filter(t => !repeats(t) && this.role(t) !== 'template');
    const tpl = overdue.filter(t => this.role(t) === 'template').length, stay = overdue.length - tasks.length - tpl;
    const stays = [stay && `${stay === 1 ? '1 repeating task stays' : stay + ' repeating tasks stay'}. Tick ${stay === 1 ? 'it' : 'them'} to move ${stay === 1 ? 'it to its' : 'them to their'} next date.`,
      tpl && `${tpl === 1 ? '1 checklist stays' : tpl + ' checklists stay'}. Start ${tpl === 1 ? 'it' : 'them'} to move ${tpl === 1 ? 'it to its' : 'them to their'} next date.`].filter(Boolean).join(' ');
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
  /* Undo each {t, was} move, except for a task that was changed elsewhere since. For the tasks that could not be
     moved back, a message at `at` names the date they still have (`still`), or says they have no date when `still`
     is null. The moves that were undone are passed to after(back) to update the screen. */
  undoMoves(moves, still, at, after){
    return {label: 'Undo', fn: async () => {
      const same = [];                                                      // tasks not changed elsewhere since
      for (const m of moves) if (await this.unchanged(m.t).catch(() => false)) same.push(m);
      const back = await this.saveEach(same.map(m => [m.t, {due_date: m.was}]));
      const k = moves.length - back.length;
      if (k) this.say(notMovedBack(k, still), {...at, cls: 'failed'});
      after(same.filter(m => back.includes(m.t)));
    }};
  },
  /* Move a held Today row to `to.due` at once, then save it and offer Undo. On a card, only the parent's date
     changes. If an earlier subtask keeps the card where it is, a message beside the add box says why. Undo is shown
     on the destination row, or beside the add box if the row left Today or is offscreen. A failed save puts the
     task back in its old group and shows Try again. */
  async reschedule(t, to){
    const c = this.view.cards?.[t.id], m = {t, was: t.due_date, when: c ? c.when : undefined, key: this.todayKey(t)};
    const moving = this.change(w => w.edit(t.id, {due_date: to.due}));
    this.placeOnToday(t, to.due);
    // A task due on that date goes in the same group as a task waiting to be sent with that date (pendingPlace).
    const want = this.pendingPlace({due_date: to.due}), kept = c && this.todayKey(t) !== want && c.when !== t.due_date
      ? this.cardSubs(t, false).filter(s => !s.done && isSet(s.due_date)).sort((a, b) => Date.parse(a.due_date) - Date.parse(b.due_date))[0] : null;
    const saving = this.saveTask(t.id, {due_date: to.due}).then(() => { this.change(() => moving.ok()); return null; }, e => e);
    // Undo waits for the save to finish, then puts the task back and highlights it.
    const back = this.undoMoves([m], to.label && dayWord(to.label), {place: 'cap'}, done => { if (done.length) { this.placeOnToday(t, m.was, m.when, m.key); this.flash([t.id], 'arrived'); } });
    const undo = {label: 'Undo', fn: async () => { if (!await saving) await back.fn(); }};
    await this.$nextTick();                                                 // waits until the row has moved
    const text = movedTo(to.label, kept?.title), where = this.say(text, {row: !kept && this.rowSeen(t.id) ? {id: t.id, stays: true} : null, place: 'cap', action: undo});
    const e = await saving;
    if (!e) return true;
    this.change(() => moving.undo());
    this.placeOnToday(t, m.was, m.when, m.key);
    if (where === 'place' && this.places.cap?.text === text) this.endPlace('cap', this.places.cap, false);   // the save failed, so the Undo beside the add box has nothing to undo
    await this.$nextTick();                                                 // waits until a task that left Today has its row back
    this.say(notSaved(e), {row: {id: t.id, stays: true, cls: 'failed'}, place: 'cap', action: {label: 'Try again', fn: () => this.reschedule(t, to)}});
    return false;
  },
  // The key of the Today group that task `t` is in, or null.
  todayKey(t){ return this.view.groups.find(g => g.tasks.some(x => x.id === t.id))?.key ?? null; },
  /* Put task `t`, whose row already has the date `due`, in the Today group for that date, or remove it from Today if
     the date is beyond the next seven days. A card uses the earliest date of its parent and open subtasks, unless
     `when` is given for a retry. A task without a date goes in the group `key`, which is the Added today, no date
     group by default. */
  placeOnToday(t, due, when, key = 'nodate'){
    const c = this.view.cards?.[t.id];
    if (c) c.when = when !== undefined ? when : [due, ...this.cardSubs(t, false).filter(s => !s.done).map(s => s.due_date)].filter(isSet)
      .reduce((a, b) => !a || Date.parse(b) < Date.parse(a) ? b : a, null);
    const k = dayGroup(c ? c.when : due), groups = this.view.groups, into = k && groups.find(g => g.key === (k === 'nodate' ? key : k));
    for (const g of groups) g.tasks = g.tasks.filter(x => x.id !== t.id);
    into?.tasks.push(t);
    this.regroupToday();
  },

  /* ---------- reordering ---------- */
  /* Move `t` among its siblings `sibs` in the project's List view `view`. The screen updates at once, and the new
     positions are queued through the outbox. If a move is rejected, the old order comes back and a message on the
     row says why. If Vikunja renumbers the positions, positionSent reloads the view. Returns whether the task moved. */
  async reorder(t, sibs, to, view){
    const from = sibs.findIndex(s => s.id === t.id);
    if (from < 0 || to === from || to < 0 || to >= sibs.length || !view) return false;
    const writes = placeMove(sibs.map(s => ({id: s.id, pos: this.positions[s.id] || 0})), from, to);
    const was = Object.fromEntries(writes.map(([id]) => [id, this.positions[id]]));
    for (const [id, pos] of writes) this.positions[id] = pos;
    this.said = `${t.title} is now ${to + 1} of ${sibs.length}`;
    for (const [id, pos] of writes) {
      const r = await this.act({op: 'position', task: id, view, pos, run: null});
      if (r.status !== 'error') continue;
      Object.assign(this.positions, was);
      this.say(notReordered(r.error), {row: {id: t.id, stays: true, cls: 'failed'}, place: 'sheet:top'});
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
    if (this.sheet.subView) this.loadSubOrder(this.sheetTask);
  },
  // Move a task one position up (-1) or down (1) from its menu. `where` is passed to orderOf.
  moveBy(t, dir, where){
    const o = this.orderOf(t, where), i = o ? o.sibs.findIndex(s => s.id === t.id) : -1;
    return i >= 0 ? this.reorder(t, o.sibs, i + dir, o.view) : false;
  },
  /* Returns {sibs, view, blocks} for reordering a task among its siblings, or null if it can't be reordered. In a
     list, each sibling's block includes its subtasks. In a sheet, the loaded subtask order is used. For the sheet's
     own task, the visible list or the parent's known subtask order is used. Done, pending, read-only and
     cross-project subtasks are left out. So are template steps and checklist steps, which keep their order in notes. */
  orderOf(t, where){
    if (!t || t.pending || t.done || this.lines[t.id] || this.leaving[t.id] || !this.canWrite(t.project_id)) return null;
    const under = p => !!p && !this.hasOwnOrder(p) && p.project_id === t.project_id;
    if (where === 'sheet') return this.sheet.subView && under(this.sheetTask) ? {sibs: this.subtasks, view: this.sheet.subView} : null;
    const g = this.route.name === 'project' && this.view.listView && this.view.project?.id === t.project_id && this.listGroups.find(x => x.key === 'open');
    if (g && g.tasks.some(x => x.id === t.id)) {
      const blocks = siblingBlocks(g.tasks, g.depth, t.id).filter(b => !b.task.pending);
      const parent = g.depth[t.id] && g.tasks[g.tasks.findIndex(x => x.id === blocks[0].id) - 1];
      return !parent || under(parent) ? {sibs: blocks.map(b => b.task), view: this.view.listView, blocks} : null;
    }
    if (where !== 'own') return null;
    // Reorder among the parent's subtasks, as Vikunja last returned them.
    const pid = t.related_tasks?.parenttask?.[0]?.id, parent = pid && (this.tasks[pid] || copyOf(pid));
    const subs = under(parent) && parent.related_tasks?.subtask, view = listViewOf(this.projById.get(t.project_id))?.id;
    if (!subs?.length || !view || subs.some(s => !(s.id in this.positions))) return null;
    return {sibs: [...subs].sort(positionOrder(this.positions)), view};
  },
  // Whether the ⋯ menu's Up one place and Down one place apply to the open task, or null if neither does.
  get sheetMoves(){
    const t = this.sheetTask, o = this.sheet.kind === 'task' && this.orderOf(t, 'own'), i = o ? o.sibs.findIndex(s => s.id === t.id) : -1;
    return i < 0 ? null : {up: i > 0, down: i < o.sibs.length - 1};
  },

  /* ---------- adding subtasks ---------- */
  /* Subtasks typed in a subtask box are queued like quick add, so they appear at once and survive a lost
     connection. The sheet's box inserts at its selected row, or at the end. The list's box inserts at the cursor and
     then follows each newly added subtask. List view positions are saved so Vikunja doesn't put the new subtasks
     first. The input keeps focus, and a mistake is fixed by deleting the row and using Undo. */
  /* Positions for `n` new sheet subtasks. They go after the selected row or its latest pending addition, or last
     when the box is at the end. Returns null until the order is known. No position is one that another task
     already has. */
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
    const items = itemsOf(this.boxItems(w), k => at && {position: at[k]}), lastTop = items.findLastIndex(x => x.under === null);
    const entries = addLines(items, {parent: {id: parent.id, project_id: parent.project_id, title: parent.title}}).map(f => this.actEntry(f));
    // Add placeholder rows for the new direct subtasks to Today's card at once. They go in the order typed, after
    // the cursor row or below the header.
    if (today) {
      if (!this.cardAdded[parent.id]) this.cardAdded[parent.id] = [];
      const rows = this.cardAdded[parent.id];
      let after = this.cursor?.under != null ? this.cursor.id : null;
      items.forEach((x, i) => { if (x.under === null) { rows.push({id: 'pending-' + entries[i].id, after}); after = rows.at(-1).id; } });
    }
    // Move the highlight to the last new direct subtask, so the next entry goes after it and not under a nested
    // child.
    if (foot) this.aimAdded(entries[lastTop], parent);
    const here = () => foot || this.sheet.id === parent.id, place = foot ? 'cap' : 'sheet:subtasks';
    // `adding` counts the batches still sending, so the user can submit another batch meanwhile.
    b.adding++; b.text = '';
    if (!foot || b.focus) this.$nextTick(() => this.boxEl(w)?.focus());
    try {
      // The rows and the highlight appear before queuing finishes. The waiting look is delayed until sending takes
      // a while.
      const r = await this.sendLines(entries), {kept, full} = r;
      if (foot) this.refreshPending();                                    // swaps the waiting rows for the sent rows at once
      // Replace the pending card rows with their saved tasks, and keep the highlight on the right row.
      if (today) this.change(w => { for (const {child, problems, arrived, was, place, ...x} of r.tasks || []) { w.base(x); for (const a of this.cardAdded[parent.id] || []) { if (a.id === was) a.id = x.id; if (a.after === was) a.after = x.id; } } });
      this.placeSent(r.tasks || []);
      const but = r.problems?.length ? `, but ${r.problems.join('; ')}` : '';
      if (r.ids?.length && foot) {
        this.flash(r.ids);
        // Reload the parent's subtask count. Today's card already holds the new rows in their insertion positions.
        this.readCopy(parent.id).catch(() => {});
      } else if (r.ids?.length && here()) {
        this.sheet.dirty = true;
        try { const t = await this.readCopy(parent.id); if (t && here()) { this.showTask(t); this.loadSubPeople(t); this.loadSubOrder(t); } } catch {}
        // Move the selection to the last added sheet subtask, so the next entry goes after it.
        const last = sync.taskOf(entries[lastTop].id);
        if (here() && this.sheet.subAt != null && last) { this.sheet.subAt = last; this.sheet.subAfter = null; this.seatFoot('sheet'); }
      }
      if (r.status === 'offline') {
        sync.keep();
        // When the subtasks were added from the add box, their rows show that they are waiting, so no message.
        if (!foot || !kept || today) this.say(!kept ? (full ? NO_ROOM : NOT_KEPT) : `Saved offline. ${n === 1 ? 'It goes' : 'They go'} to Vikunja when you're back online.`, {place, cls: kept ? '' : 'failed'});
      } else if (r.status === 'error') {
        if (here() && r.unsent.length) b.text = [r.unsent.join('\n'), b.text].filter(Boolean).join('\n');   // puts the lines that weren't added back in the box
        // A line whose answer is unknown stays in the Outbox, and the message's button opens the Outbox.
        const added = r.ids.length ? `Added ${r.ids.length} of ${n}${but}. ` : '';
        if (r.error.code === 'unknown') this.say(added + notKnown(r.error.what), {place, cls: 'failed', action: toOutbox(this)});
        else this.say(r.ids.length ? `Added ${r.ids.length} of ${n}${but}. Stopped: ${r.error.message}` : 'Not added: ' + r.error.message, {place, cls: 'failed'});
      } else if (r.ids?.length && but) this.say(`Added ${r.ids.length === 1 ? '1 subtask' : r.ids.length + ' subtasks'}${but}`, {place, cls: 'failed'});
    } finally { b.adding--; this.refreshPending(); }
  },

  /* ---------- deleting ---------- */
  // Undo for tasks just added. Deletes them and shows a message if any couldn't be deleted.
  async deleteTasks(ids){
    let failed = 0;
    for (const id of [...ids].reverse()) await api('/tasks/' + id, {method:'DELETE'}).catch(e => { if (e.status !== 404) failed++; });
    if (failed) this.notify(`Not all undone: ${failed} of ${ids.length} couldn't be deleted.`);
    this.render();
  },
  // The label for deleting the open task. Deleting also deletes its subtasks, or a template's or checklist's steps.
  get deleteLabel(){
    const n = this.subtasks.length, role = this.checklistRole;
    if (role === 'run') return 'Delete checklist';
    if (role === 'template') return n ? `Delete template and its ${n} step${n === 1 ? '' : 's'}` : 'Delete template';
    return n ? `Delete task and its ${n} subtask${n === 1 ? '' : 's'}` : 'Delete task';
  },
  // `asked` is the list of tasks to delete when the user was already asked, as with a swiped row (swipeDelete,
  // progress.js).
  async deleteTask(asked = null){
    const t = this.sheetTask, role = this.checklistRole;
    if (role === 'run') return this.confirmDeleteRun(t, this.subtasks);
    // If the sheet was opened from the parent's sheet, go back to the parent afterwards.
    const back = this.sheet.from && (t.related_tasks?.parenttask || []).some(x => x.id === this.sheet.from) ? this.sheet.from : null;
    const leave = async () => {
      Object.assign(this.sheet, {dirty: false, editingDesc: false, commentDraft: ''}); this.sheet.sub.text = '';
      if (back) { await this.openTask(back); this.sheet.dirty = true; } else this.closeSheet();
    };
    if (role !== 'template') { if (await this.removeTask(t, asked)) await leave(); return; }
    // A template is deleted at once after asking, with no Undo. Checklists already started from it keep their steps.
    let tree;
    try { tree = await this.taskTree(t.id); } catch (e) { this.say('Not deleted: ' + e.message, {place: 'sheet:top', cls: 'failed'}); return; }
    const n = tree.length - 1;
    if (!confirm(`Delete the template “${t.title}”` + (n ? ` and its ${n} step${n === 1 ? '' : 's'}? Checklists already started keep their steps.` : '?') + ' This can\'t be undone in Pocket.')) return;
    await shared.saveChain;
    try {
      await this.deleteTree(tree);
      await leave();
      this.render();
      this.notify(n ? `Deleted, with ${n} step${n === 1 ? '' : 's'}` : 'Deleted');                   // a toast, because the sheet and row are gone
    } catch (e) { this.say(`Stopped after deleting ${e.deleted} of ${tree.length}: ${e.message}`, {place: 'sheet:top', cls: 'failed'}); this.render(); }
  },
  // Only saved, writable tasks can be deleted by swiping. Checklists, their steps and templates have their own ways
  // to delete.
  canDelete(t, sheet){
    return !t.pending && this.canWrite(t.project_id) && !['run', 'step', 'template'].includes(this.role(t)) && !(sheet && ['run', 'template'].includes(this.checklistRole));
  },
  /* Delete a task and its descendants, asking first if it has any. The deletion is held in the outbox while the
     marked rows keep a Restore gap until the batch clears. Restore removes the held entry, so no task has to be
     recreated. The deletion is sent when the rows or the Undo message leave, or when Pocket closes. The hold is
     saved, so reopening Pocket or reconnecting finishes the deletion. Returns false if the user cancels. `tree`
     reuses a deletion the user already confirmed. */
  async removeTask(t, tree = null){
    const d = await this.holdDelete(t, d => {
      const undo = () => this.undoDelete(d.id), gone = () => this.sendHeld(d.id);
      if (this.rowEl(t.id)) return this.markRow(t.id, {kind: 'deleted', ids: d.ids, undo, gone, said: `Deleted ${t.title}. Restore is where the row was.`});
      const title = t.title.length > 40 ? t.title.slice(0, 38) + '…' : t.title;
      this.notify(`Deleted “${title}”` + (d.n ? ` + ${d.n} subtask${d.n === 1 ? '' : 's'}` : ''), {label: 'Undo', fn: undo, gone});
    }, tree);
    return !!d;
  },
  // Whether a task has subtasks as far as the phone knows, judging by its own copy, the copy on screen, or the last
  // copy from Vikunja.
  hasSubtasks(t){ return [t, this.tasks[t.id], copyOf(t.id)].some(x => x?.related_tasks?.subtask?.length); },
  /* Find the task and its descendants to delete, deepest first, and ask the user to confirm how many. Returns null
     if the user cancels or a read fails. A swipe asks before the row moves. */
  async askDelete(t){
    let tree;
    try { tree = await this.taskTree(t.id); } catch (e) { this.say('Not deleted: ' + e.message, {row: {id: t.id, stays: true, cls: 'failed'}, place: 'sheet:top'}); return null; }
    const n = tree.length - 1, direct = (t.related_tasks?.subtask || []).filter(s => tree.includes(s.id)).length;
    const deeper = n > direct ? `, ${n - direct} more under ${direct === 1 ? 'it' : 'them'}` : '';
    return n && !confirm(`Delete “${t.title}” and its ${direct} subtask${direct === 1 ? '' : 's'}${deeper}?`) ? null : tree;
  },
  /* Ask the user to confirm the deletion, unless `tree` is given. Queue a held deletion and call show({id, n, ids})
     before the unmarked rows are hidden. The entry stays until sendHeld or undoDelete. Returns {id, n}, or null if
     the user cancels. */
  async holdDelete(t, show, tree = null){
    tree ||= await this.askDelete(t);
    if (!tree) return null;
    const n = tree.length - 1;
    // The deletion's last stage updates the progress of the parent that stays.
    const up = this.parentIdOf(t);
    const entry = {id: uuid7(), kind: 'act', op: 'delete', user: this.user?.id, at: new Date().toISOString(), files: [], stage: 0, fails: 0,
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
    if (e) this.change(w => w.offTasks(e));
    await sync.lock(() => sync.remove(id));
    this.refreshPending();
  },
  // Send a deletion after its rows or Undo leave. Without id, send all held deletions when Pocket is hidden.
  async sendHeld(id){
    if (!id) { await Promise.all([...sync.held].map(h => this.sendHeld(h))); return; }
    if (!sync.held.delete(id)) return;                                      // already undone or sent
    await sync.lock(async () => { const e = await sync.fresh(id); if (e?.until) { delete e.until; await sync.save(e); } });
    await this.sendActs(id);
  },
  /* Collect the task and its descendants from the store, deepest first. A subtask that still has another parent is
     left out, with its descendants, and so is a subtask that a waiting delete already deletes. */
  async taskTree(id){
    const out = [], seen = new Set();
    const walk = async (tid, from) => {
      if (seen.has(tid) || (from && this.beingDeleted(tid))) return;
      seen.add(tid);
      // Each task is read into the store first. Offline, Vikunja's last copy is used. A subtask that was never loaded
      // can't be included in the deletion.
      if (tid !== this.sheet.id || !this.sheetTask) await this.readCopy(tid).catch(e => { if (!(e instanceof NetError)) throw e; });
      const t = this.shownAs(tid) || {id: tid};
      if (from && (t.related_tasks?.parenttask || []).some(p => p.id !== from)) return;
      for (const sub of t.related_tasks?.subtask || []) await walk(sub.id, tid);
      out.push(tid);
    };
    await walk(id, null);
    return out;
  },
  // Delete in order and stop at the first rejection. The error's `deleted` is how many were already deleted.
  async deleteTree(ids){
    let n = 0;
    try {
      for (const id of ids) {
        await patiently(() => api('/tasks/' + id, {method: 'DELETE'})).catch(e => { if (e.status !== 404) throw e; });
        this.change(w => w.forget(id)); n++;
      }
    } catch (e) { e.deleted = n; throw e; }
  },

  /* ---------- people and labels ---------- */
  // Save assignee changes before applying them to the screen and to Vikunja's copy.
  async addAssignee(t, u){
    await api(`/tasks/${t.id}/assignees`, {method:'POST', body:{user_id: u.id}});
    this.setAssignees([...(t.assignees || []).filter(x => x.id !== u.id), u], t.id);
  },
  async removeAssignee(t, uid){
    await api(`/tasks/${t.id}/assignees/${uid}`, {method:'DELETE'});
    this.setAssignees((t.assignees || []).filter(u => u.id !== uid), t.id);
  },
  setAssignees(assignees, id = this.sheet.id){
    if (this.sheet.id === id) this.sheet.dirty = true;
    if (copyOf(id)) this.change(w => w.answer([{id, assignees}], ['assignees']));
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
  setLabels(labels, id = this.sheet.id){
    if (this.sheet.id === id) this.sheet.dirty = true;
    if (copyOf(id)) this.change(w => w.answer([{id, labels}], ['labels']));
  },
};
