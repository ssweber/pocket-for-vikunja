/* What's done to tasks, a function for each thing: ticking (done, or not done again), setting progress, deleting,
   moving, adding subtasks, people and labels, and saving a change. Each one makes the request, takes the subtasks along
   where they go too, changes what's on screen and offers the Undo, so the lists and the sheet call these, not api().
   A run and a run's step are ticked through the outbox (act, in runs.js): toggleDone and sheetDone hand them to
   tickRunTask and tickRunStep, and tickRunTask keeps a run's own rule, that finishing it with steps not done asks
   first and leaves them not done. Reordering: a task among its siblings in its project's List view (reorder), and a
   template's steps by moveStep (checklists.js), which writes their order line. */
import {cache, collapse} from '../util.js';
import {api, NetError, patchTask} from '../api.js';
import {dueInfo, isLate, isSet, repeats} from '../dates.js';
import {doneText, isSubtask, openSubtasks, pctOf, progressPatch, undoing} from '../progress.js';
import {movedText, notMoved, notSaved, sentLater} from '../messages.js';
import {htmlToText} from '../html.js';
import {hasOwnOrder, hasTemplateLabel, patiently} from '../checklists.js';
import {listViewOf, placeAfter, placeMove, positionOrder, siblingBlocks} from '../order.js';
import {NO_ROOM, NOT_KEPT, packParsed, randomId, sync} from '../sync.js';
import {shared} from './core.js';
import {UNDO_MS} from './toast.js';

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
  /* `extra` is saved along with it, and `undoExtra` with the Undo: progress uses these to mark a task done at 100%. A
     subtask (`extra.sub`, or one with a parent) shows its tick on its row only, which stays where it is, done: no
     message, unless it closed subtasks of its own, whose Undo opens them again. What's said is said on the task's row
     (say): a line in its place, with the Undo, or Try again if it wasn't saved. */
  async toggleDone(t, rowEl, extra = {}, undoExtra = {}){
    const run = this.stepRun(t);
    if (run) return this.tickRunStep(t, run, rowEl);
    if (this.isRunTask(t) && !extra.quiet) return this.tickRunTask(t, rowEl);
    const was = t.done, subs = this.isRunTask(t) || extra.quiet ? [] : openSubtasks(t);   // a run's steps are ticked on its screen, with who did each
    // A repeating task moves on its dates, and its reminders at a set time: Undo puts them back.
    const back = {due_date: t.due_date};
    for (const k of ['start_date', 'end_date']) if (isSet(t[k])) back[k] = t[k];
    if ((t.reminders || []).some(r => !r.relative_to)) back.reminders = plainReminders(t);
    t.done = !was;
    try {
      const {quiet, sub: inSheet, ...patch} = extra, sub = inSheet || isSubtask(t);
      const saved = await this.saveTask(t.id, {done: !was, ...patch});
      Object.assign(t, saved);
      if (!was && !saved.done) {                 // repeating task rolled forward: Undo puts its date back
        if (sub) { this.render(); return; }
        // Its row stays, with its next date: the line on it says so, then gives it back.
        const d = dueInfo(saved.due_date), row = {id: t.id, stays: true}, err = {row: {...row, cls: 'failed'}, place: 'sheet:top'};
        this.say(d ? 'Repeats · next ' + d.label : 'Done — repeats', {row, place: 'sheet:top', action: {label: 'Undo', fn: async () => {
          try {
            if (!await this.unchanged(t)) { this.say(`Not undone: “${t.title}” was changed since`, err); return; }
            Object.assign(t, await this.saveTask(t.id, {...back, ...undoExtra}));
          } catch (e) { this.say('Not undone: ' + e.message, err); }
          this.render();
        }}});
        this.render(); return;
      }
      // Its open subtasks are done with it, and Undo opens them again too.
      const closed = was ? [] : await this.closeSubtasks(subs), ids = [t.id, ...closed];
      // No message: a subtask's tick (but one that closed subtasks of its own), and an Undo's.
      if (was ? sub || extra.quiet || undoing(extra) : sub && !closed.length) return this.afterTick(t, rowEl, was, ids, sub);
      const undo = was ? async () => { await this.toggleDone(t, null, {quiet: true}); this.render(); }
        : async () => {
          await this.toggleDone(t, null, {...undoExtra, quiet: true});
          const failed = await this.reopen(closed);
          if (failed) this.say(`Not all undone: ${failed} subtask${failed === 1 ? '' : 's'} couldn't be marked not done`, {row: {id: t.id, stays: true, cls: 'failed'}, place: 'sheet:subtasks'});
          this.render();
        };
      /* A line in its row's place, with its Undo. Off a list it leaves, with the subtasks ticked with it, which go when it
         folds; in search, or a project with its Done section, it moves to Done (or back to Open) then. On a row that stays
         (a sheet's subtask that closed its own), it gives the row back. Some subtasks not saved: the line says so too. */
      const both = !sub && this.bothWays, leaves = !sub && !both && t.done, stays = !leaves && !both;
      const more = !closed.length && !subs.length ? '' : `+ ${closed.length === subs.length ? closed.length : `${closed.length} of ${subs.length}`} subtask${subs.length === 1 ? '' : 's'}`
        + (closed.length < subs.length ? ': the rest weren\'t saved' : '');
      const where = this.say(was ? 'Marked not done' : doneText(closed.length, subs.length, t.title), {
        row: {id: t.id, text: was ? 'Not done:' : 'Done:', title: t.title, more, hide: stays ? [] : closed, stays},
        action: {label: 'Undo', fn: undo},
        gone: () => { if (both) this.moveInSearch(t, ids); else if (leaves && t.done) ids.forEach(id => this.removeRow(id)); }});
      if (where !== 'row') this.afterTick(t, rowEl, was, ids, sub);
    } catch (e) {
      t.done = was;
      this.say(notSaved(e), {row: {id: t.id, stays: true, cls: 'failed'}, place: 'sheet:top', action: {label: 'Try again', fn: () => this.toggleDone(t, this.rowEl(t.id), extra, undoExtra)}});
    }
  },
  /* A run ticked in its project's list or its sheet: finished, or opened again, as on its screen, through the outbox. Its
     steps are ticked one by one on its screen, with who did each, so ticking the run leaves them as they are: with steps
     not done, it asks first. */
  async tickRunTask(t, rowEl){
    const was = t.done, open = (t.related_tasks?.subtask || []).filter(s => !s.done).length;
    if (!was && open && !confirm(`Finish “${t.title}” with ${open} step${open === 1 ? '' : 's'} not done? ${open === 1 ? 'It stays' : 'They stay'} not done.`)) return;
    const r = await this.act({op: was ? 'reopen' : 'finish', task: t.id, run: t.id});
    if (r.status === 'error') return;
    t.done = !was;
    if (this.sheet.task?.id === t.id) this.sheet.task.done = t.done;
    if (was) return this.afterTick(t, rowEl, was);
    // As a task's tick: a line in its row's place (from its sheet, at the sheet's top), its Undo opening it again.
    const offline = r.status === 'offline', leaves = !!rowEl && this.route.name !== 'search' && t.done;
    const where = this.say(offline ? sentLater('Finished') : 'Finished ' + t.title, {
      row: rowEl && {id: t.id, text: 'Finished:', title: t.title, more: offline ? '· sent once Pocket reaches Vikunja' : '', stays: !leaves},
      place: 'sheet:top', action: {label: 'Undo', fn: async () => { await this.act({op: 'reopen', task: t.id, run: t.id}); t.done = false; this.render(); }},
      gone: () => { if (leaves && t.done) this.moveInSearch(t, [t.id]) || this.removeRow(t.id); }});
    if (where !== 'row') this.afterTick(t, rowEl, was);
  },
  /* A run's step ticked in a list or a sheet: as on the run's screen, with a ✅ for who did it, through the outbox, so it
     waits without a connection. */
  async tickRunStep(t, run, rowEl){
    const was = t.done;
    t.done = !was;
    navigator.vibrate?.(10);
    const r = await this.act({op: was ? 'undone' : 'done', task: t.id, run});
    if (r.status === 'error') { if (!r.error.saved) t.done = was; return; }
    // A step of a run is a subtask: its tick shows on its row, which stays, done. Offline, the row says when it's sent.
    if (!was && r.status === 'offline') this.say(sentLater('Done: ' + t.title), {row: {id: t.id, text: sentLater('Done'), stays: true}, place: 'sheet:top'});
    this.afterTick(t, rowEl, was, [t.id], true);
  },
  /* After a tick in a list, once it has registered: the row slides away if the list doesn't show tasks done now, with
     the subtasks ticked with it; a subtask's stays, done, so it can be ticked back. In search, and a project with its
     Done section, which show both, it moves between Open and Done: in a project, a subtask only out of Done. */
  afterTick(t, rowEl, was, ids = [t.id], sub = false){
    if (!rowEl) return;
    setTimeout(async () => {
      const g = this.searchGroups(t);
      if (g && (this.route.name === 'search' || !sub || g.from.key === 'done')) { await collapse(rowEl); this.moveInSearch(t, ids); return; }
      if (sub || !t.done || this.bothWays) return;
      await collapse(rowEl);
      if (t.done) ids.forEach(id => this.removeRow(id));
    }, was ? 0 : 700);
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
      if (g.to.loaded !== false) g.to.tasks.unshift(x);
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
  // Mark these subtasks not done again (an Undo). Resolves to how many couldn't be.
  async reopen(ids){
    let failed = 0;
    for (const id of ids) await this.saveTask(id, {done: false}).catch(() => failed++);
    return failed;
  },
  /* The sheet's tick, or its progress taken to 100%: done, and its open subtasks with it, as in the list. */
  async sheetDone(patch = null){
    const t = this.sheet.task;
    if (!t) return;
    if (this.checklistRole === 'step' && this.parentTask) { await this.tickRunStep(t, this.parentTask.id, null); this.sheet.dirty = true; return; }
    if (this.isRunTask(t)) { await this.tickRunTask(t, null); this.sheet.dirty = true; return; }
    if (!patch && t.done) return this.save({done: false});                  // the tick, on a done task: not done after all
    const subs = this.isRunTask(t) ? [] : openSubtasks(t), pctWas = pctOf(t);
    await this.save(patch || {done: true});
    if (!subs.length || !cache.get(t.id)?.done) return;                     // not saved, or it repeats
    const closed = await this.closeSubtasks(subs);
    // The parent's save brought Vikunja's copy of its subtasks, still open then: those are the ones the sheet shows.
    for (const s of t.related_tasks?.subtask || []) if (closed.includes(s.id)) s.done = true;
    this.sheet.dirty = true;
    // Said under its subtasks, which it ticked.
    const err = {place: 'sheet:subtasks', cls: 'failed'};
    this.say(doneText(closed.length, subs.length, t.title), {place: 'sheet:subtasks', action: {label: 'Undo', fn: async () => {
      await this.saveTask(t.id, {done: false, percent_done: pctWas / 100}).catch(e => this.say('Not undone: ' + e.message, err));
      const failed = await this.reopen(closed);
      if (failed) this.say(`Not all undone: ${failed} subtask${failed === 1 ? '' : 's'} couldn't be marked not done`, err);
      const back = await api('/tasks/' + t.id).catch(() => null);
      if (back && this.sheet.task?.id === t.id) { cache.set(back.id, back); this.showTask(back); }
      this.render();
    }}});
  },
  // A subtask ticked in its parent's sheet: as in a list; a run's step as on the run's screen.
  async toggleSubtask(st){
    if (this.checklistRole === 'run') await this.tickRunStep(st, this.sheet.task.id, null);
    else await this.toggleDone(st, null, {sub: true});
    this.sheet.dirty = true;
  },

  /* ---------- progress ---------- */
  /* Progress set in a list, or on a subtask's row in its parent's sheet. At 100% the task is done and slides away, as
     when it's ticked off. Below that, it shows on its row only, with no message: the row's bar is what was set, and
     sliding it back is the undo (a line over the row would hide it, and stop the next slide). Not saved, the row says
     so, with Try again. `undoing`: putting back what it was, exactly, without marking it done. */
  async setProgress(t, pct, rowEl, {undoing = false, sub = isSubtask(t)} = {}){
    const was = pctOf(t), patch = undoing ? {percent_done: pct / 100} : progressPatch(t, pct);
    if (patch.done) return this.toggleDone(t, rowEl, {...patch, sub}, {percent_done: was / 100});
    t.percent_done = patch.percent_done;
    try {
      await this.saveTask(t.id, patch);
      this.said = `Progress of ${t.title} set to ${pct}%`;
    } catch (e) {
      t.percent_done = was / 100;
      this.say(notSaved(e), {row: {id: t.id, stays: true, cls: 'failed'}, action: {label: 'Try again', fn: () => this.setProgress(t, pct, this.rowEl(t.id), {undoing, sub})}});
    }
  },
  // Progress set in the sheet: as in the list, 100% is done, and anything else shows on its bar (save says if it isn't
  // saved).
  async sheetProgress(t, pct){
    const patch = progressPatch(t, pct);
    if (patch.done) return this.sheetDone(patch);
    if (await this.save(patch) !== false) this.said = `Progress set to ${pct}%`;
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
  get overdueMovable(){ return (this.view.groups.find(g => g.key === 'overdue')?.tasks || []).some(t => !repeats(t) && !hasTemplateLabel(t)); },
  /* "Move all to today": each overdue task to today, at the time of day it had. Undo puts every date back. Not a
     repeating task: moved, its next times would follow the new date; ticked, it moves on to its next date. What it did
     is said under the Overdue heading, which stays meanwhile. */
  async moveOverdueToToday(){
    // Nor a checklist that comes round: moved, a weekly one would come round on another day from then on.
    const overdue = this.view.groups.find(g => g.key === 'overdue')?.tasks || [], tasks = overdue.filter(t => !repeats(t) && !hasTemplateLabel(t));
    const tpl = overdue.filter(t => hasTemplateLabel(t)).length, stay = overdue.length - tasks.length - tpl;
    const stays = [stay && `${stay === 1 ? '1 repeating task stays' : stay + ' repeating tasks stay'}: tick ${stay === 1 ? 'it' : 'them'} to move on to the next date.`,
      tpl && `${tpl === 1 ? '1 checklist stays' : tpl + ' checklists stay'}: start ${tpl === 1 ? 'it' : 'them'} to move on to the next time.`].filter(Boolean).join(' ');
    if (!tasks.length && stays) { this.say(movedText(0, 0, stays), {place: 'overdue'}); return; }
    if (!tasks.length || this.movingOverdue) return;
    this.movingOverdue = true;
    const now = new Date();
    // Each at the time of day it had, or, if that time's gone today, the next whole hour (in the day's last hour, 11:59
    // PM), so it isn't overdue again.
    const next = new Date(now); next.setHours(now.getHours() + 1, 0, 0, 0);
    if (next.getDate() !== now.getDate()) next.setTime(new Date(now).setHours(23, 59, 0, 0));
    const moves = tasks.map(t => {
      const d = new Date(t.due_date);
      d.setFullYear(now.getFullYear(), now.getMonth(), now.getDate());
      return {t, was: t.due_date, due: (isLate(d.toISOString(), now) ? next : d).toISOString()};
    });
    const moved = await this.saveEach(moves.map(m => [m.t, {due_date: m.due}]));
    this.movingOverdue = false;
    const left = moves.length - moved.length, n = moved.length;
    const undo = {label: 'Undo', fn: async () => {
      const still = [];                                                       // not changed since, elsewhere
      for (const m of moves.filter(m => moved.includes(m.t))) if (await this.unchanged(m.t).catch(() => false)) still.push(m);
      const back = await this.saveEach(still.map(m => [m.t, {due_date: m.was}]));
      const k = n - back.length;
      if (k) this.say(`${k === 1 ? '1 task' : k + ' tasks'} couldn't be moved back (changed since, or not saved) and ${k === 1 ? 'is' : 'are'} still due today.`, {place: 'overdue', cls: 'failed'});
      this.render();
    }};
    if (!n) return this.say(this.offline ? 'Not moved: no connection' : 'Not moved: Vikunja didn\'t save the changes', {place: 'overdue', cls: 'failed'});
    this.say(movedText(n, left, stays), {place: 'overdue', action: undo});
    this.render();
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
    if (!t || t.pending || t.done || this.lines[t.id] || !this.canWrite(t.project_id)) return null;
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
    const foot = w === 'under', parent = this.boxParent(w), b = this.box(w), lines = this.boxLines(w), parsed = this.boxParsedLines(w);
    if (!parent || !parsed.some(p => p.title)) return;
    const n = parsed.filter(p => p.title).length;
    const at = foot ? this.cursorPlaces(n) : this.sheet.subView || !this.subtasks.length ? placeAfter(this.subtasks.map(s => this.positions[s.id] || 0), null, n) : null;
    const items = lines.map((raw, i) => ({raw, p: parsed[i]})).filter(x => x.p.title)
      .map((x, k) => ({raw: x.raw, p: {...packParsed({...x.p, remind: this.remindOn(w, lines)}), ...at && {position: at[k]}}, taskId: null, done: false, linked: false}));
    const entry = {id: randomId(), user: this.user?.id, at: new Date().toISOString(), nest: false, pid: parent.project_id,
      parent: {id: parent.id, project_id: parent.project_id, title: parent.title}, items, files: []};
    // The next ones from the add box go after these.
    if (foot) this.cursor.after = {pos: at?.at(-1) ?? null, title: items.at(-1).p.title};
    const here = () => foot || this.sheet.task?.id === parent.id, place = foot ? 'cap' : 'sheet:subtasks';
    // The next can be sent while this one is on its way (the outbox sends them in turn): `adding` counts them.
    b.adding++; b.text = '';
    if (!foot || b.focus) this.$nextTick(() => this.boxEl(w)?.focus());
    try {
      const {kept, full} = await sync.add(entry, []);
      const slow = setTimeout(() => this.refreshPending(), 400);           // on a slow connection, shown as waiting meanwhile
      const r = await sync.lock(() => this.sendEntry(entry.id));
      clearTimeout(slow);
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
  async deleteTask(){
    const t = this.sheet.task, role = this.checklistRole;
    if (role === 'run') return this.confirmDeleteRun({id: t.id, title: t.title, steps: this.subtasks});
    // Opened from its parent's sheet: back to the parent afterwards.
    const back = this.sheet.from && (t.related_tasks?.parenttask || []).some(x => x.id === this.sheet.from) ? this.sheet.from : null;
    const leave = async () => {
      Object.assign(this.sheet, {dirty: false, editingDesc: false, commentDraft: ''}); this.sheet.sub.text = '';
      if (back) { await this.openTask(back); this.sheet.dirty = true; } else this.closeSheet();
    };
    if (role !== 'template') { if (await this.removeTask(t)) await leave(); return; }
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
     with any it asks first. It's off the screen at once, with an Undo in its row's place, and it's sent once the Undo has
     gone: its line folds, the screen is left, or Pocket is put away or closed. Meanwhile it waits in the outbox, kept on the phone,
     held back (sync.held): so it's sent even if Pocket is closed before then, the next time it opens, and without a
     connection, once there's one. Undo takes it out of the outbox: nothing was sent, so nothing has to be made again.
     Resolves to whether it's deleted (not if it was called off). */
  async removeTask(t){
    // Its line, in its row's place (in the list, or in its parent's sheet), shown before the row is hidden; with no row
    // on screen, a message.
    let shown = false;
    const d = await this.holdDelete(t, d => {
      const more = d.n ? `+ ${d.n} subtask${d.n === 1 ? '' : 's'}` : '', action = {label: 'Undo', fn: () => this.undoDelete(d.id)}, gone = () => this.sendHeld(d.id);
      shown = this.rowLine(t.id, {text: 'Deleted', title: t.title, more, action, gone}) || {more, action, gone};
    });
    if (!d) return false;
    if (shown !== true) {
      const title = t.title.length > 40 ? t.title.slice(0, 38) + '…' : t.title;
      this.notify(`Deleted “${title}”` + (shown.more && ' ' + shown.more), {...shown.action, gone: shown.gone});
    }
    return true;
  },
  /* The deletion itself, apart from how its Undo is shown (`show`, given {id, n: its subtasks} just before the rows go):
     asked first if it has subtasks, then off the lists at once, and kept in the outbox, held back (sync.held), until
     sendHeld or undoDelete. Resolves to {id, n}, or null if it was called off. */
  async holdDelete(t, show){
    let tree;
    try { tree = await this.taskTree(t.id); } catch (e) { this.say('Not deleted: ' + e.message, {row: {id: t.id, stays: true, cls: 'failed'}, place: 'sheet:top'}); return null; }
    const n = tree.length - 1, direct = (t.related_tasks?.subtask || []).filter(s => tree.includes(s.id)).length;
    const deeper = n > direct ? `, ${n - direct} more under ${direct === 1 ? 'it' : 'them'}` : '';
    if (n && !confirm(`Delete “${t.title}” and its ${direct} subtask${direct === 1 ? '' : 's'}${deeper}?`)) return null;
    const entry = {id: randomId(), kind: 'act', op: 'delete', user: this.user?.id, at: new Date().toISOString(), items: [], files: [], stage: 0, fails: 0,
      run: null, task: t.id, ids: tree, label: t.title, until: Date.now() + UNDO_MS};
    sync.held.add(entry.id);
    const added = sync.add(entry, []);
    show?.({id: entry.id, n});
    this.refreshPending();                                                  // off the lists at once
    await added;
    setTimeout(() => this.sendHeld(entry.id), UNDO_MS * 2);                // whatever became of its Undo
    return {id: entry.id, n};
  },
  // Undo: the deletion isn't sent, and the rows are back.
  async undoDelete(id){
    if (!sync.held.delete(id)) return;
    await sync.lock(() => sync.remove(id));
    this.refreshPending();
  },
  // Send a deletion whose Undo has gone (`id`), or, with none, every one still held: Pocket is being put away.
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
