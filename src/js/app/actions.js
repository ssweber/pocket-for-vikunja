/* What's done to tasks, a function for each thing: ticking (done, or not done again), setting progress, deleting,
   moving, adding subtasks, people and labels, and saving a change. Each one makes the request, takes the subtasks along
   where they go too, changes what's on screen and offers the Undo, so the lists and the sheet call these, not api().
   A run and a run's step are ticked through the outbox (act, in runs.js): toggleDone and sheetDone hand them to
   tickRunTask and tickRunStep, and tickRunTask keeps a run's own rule, that finishing it with steps not done asks
   first and leaves them not done. Reordering: a template's steps are moved by moveStep (checklists.js), which writes
   their order line. */
import {cache, collapse} from '../util.js';
import {api, NetError, patchTask} from '../api.js';
import {dueInfo, isLate, isSet, repeats} from '../dates.js';
import {doneText, isSubtask, openSubtasks, pctOf, progressPatch, undoing} from '../progress.js';
import {htmlToText} from '../html.js';
import {hasTemplateLabel, patiently} from '../checklists.js';
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
    saveMark(id, 1);
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
    }).finally(() => saveMark(id, -1));
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
     message, unless it closed subtasks of its own, whose Undo opens them again. */
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
        const d = dueInfo(saved.due_date);
        this.notify(d ? 'Repeats · next ' + d.label : 'Done — repeats', {label: 'Undo', fn: async () => {
          try {
            if (!await this.unchanged(t)) { this.notify(`Not undone: “${t.title}” was changed since.`); return; }
            Object.assign(t, await this.saveTask(t.id, {...back, ...undoExtra}));
          } catch (e) { this.notify('Not undone: ' + e.message); }
          this.render();
        }});
        this.render(); return;
      }
      // Its open subtasks are done with it, and Undo opens them again too.
      const closed = was ? [] : await this.closeSubtasks(subs), ids = [t.id, ...closed];
      const undo = async () => { await this.toggleDone(t, null, {...undoExtra, quiet: true}); await this.reopen(closed); this.render(); };
      /* Ticked off a list it leaves: its Undo is a line in its row's place, with the subtasks ticked with it, which go
         when it folds. Anywhere else (search, which keeps it under Done; a sheet's subtask that closed its own), a
         message. Some subtasks not saved: a message says so, as well. */
      const leaves = !was && rowEl && !sub && this.route.name !== 'search' && t.done !== this.viewWantsDone();
      if (leaves && this.rowLine(t.id, {text: 'Done:', title: t.title, more: closed.length ? `+ ${closed.length} subtask${closed.length === 1 ? '' : 's'}` : '', hide: closed, action: {label: 'Undo', fn: undo},
        gone: () => { if (t.done !== this.viewWantsDone()) ids.forEach(id => this.removeRow(id)); }})) {
        if (closed.length < subs.length) this.notify(doneText(closed.length, subs.length, t.title));
        return;
      }
      if (!was && (!sub || closed.length)) this.notify(doneText(closed.length, subs.length, t.title), {label: 'Undo', fn: undo});
      else if (was && !sub && !extra.quiet && !undoing(extra)) this.notify('Marked not done', {label: 'Undo', fn: async () => { await this.toggleDone(t, null, {quiet: true}); this.render(); }});
      this.afterTick(t, rowEl, was, ids, sub);
    } catch (e) {
      t.done = was;
      this.notify(e instanceof NetError ? 'Offline — not saved' : 'Not saved: ' + e.message);
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
    if (!was) this.notify(r.status === 'offline' ? `Finished. It's sent once Pocket reaches Vikunja.` : 'Finished ' + t.title,
      {label: 'Undo', fn: async () => { await this.act({op: 'reopen', task: t.id, run: t.id}); t.done = false; this.render(); }});
    this.afterTick(t, rowEl, was);
  },
  /* A run's step ticked in a list or a sheet: as on the run's screen, with a ✅ for who did it, through the outbox, so it
     waits without a connection. */
  async tickRunStep(t, run, rowEl){
    const was = t.done;
    t.done = !was;
    navigator.vibrate?.(10);
    const r = await this.act({op: was ? 'undone' : 'done', task: t.id, run});
    if (r.status === 'error') { if (!r.error.saved) t.done = was; return; }
    // A step of a run is a subtask: its tick shows on its row, which stays, done. Offline, it says when it's sent.
    if (!was && r.status === 'offline') this.notify(`Done: ${t.title}. It's sent once Pocket reaches Vikunja.`);
    this.afterTick(t, rowEl, was, [t.id], true);
  },
  /* After a tick in a list, once it has registered: the row slides away if the list doesn't show tasks done (or not
     done) now, with the subtasks ticked with it; a subtask's stays, done, so it can be ticked back. In search, which
     shows both, it moves between Open and Done. */
  afterTick(t, rowEl, was, ids = [t.id], sub = false){
    if (!rowEl) return;
    setTimeout(async () => {
      if (this.route.name === 'search') {
        const from = this.view.groups.find(g => g.key === (t.done ? 'open' : 'done')), to = this.view.groups.find(g => g.key === (t.done ? 'done' : 'open'));
        if (!from || !to || !from.tasks.some(x => x.id === t.id)) return;
        await collapse(rowEl);
        for (const id of ids) {
          const i = from.tasks.findIndex(x => x.id === id);
          if (i >= 0) { const [x] = from.tasks.splice(i, 1); x.done = t.done; to.tasks.unshift(x); }
        }
        return;
      }
      if (sub || t.done === this.viewWantsDone()) return;
      await collapse(rowEl);
      if (t.done !== this.viewWantsDone()) ids.forEach(id => this.removeRow(id));
    }, was ? 0 : 700);
  },
  // Mark these subtasks of a task just done, done too, one by one. Returns the ids marked; stops at the first that fails.
  async closeSubtasks(subs){
    const closed = [];
    for (const s of subs) { try { await this.saveTask(s.id, {done: true}); closed.push(s.id); } catch { break; } }
    return closed;
  },
  // Mark these subtasks not done again (an Undo), saying if any couldn't be.
  async reopen(ids){
    let failed = 0;
    for (const id of ids) await this.saveTask(id, {done: false}).catch(() => failed++);
    if (failed) this.notify(`Not all undone: ${failed} subtask${failed === 1 ? '' : 's'} couldn't be marked not done.`);
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
    this.notify(doneText(closed.length, subs.length, t.title), {label: 'Undo', done: true, says: closed.length < subs.length, fn: async () => {
      await this.saveTask(t.id, {done: false, percent_done: pctWas / 100}).catch(e => this.notify('Not undone: ' + e.message));
      await this.reopen(closed);
      const back = await api('/tasks/' + t.id).catch(() => null);
      if (back && this.sheet.task?.id === t.id) { cache.set(back.id, back); this.showTask(back); }
      this.render();
    }});
  },
  // A subtask ticked in its parent's sheet: as in a list; a run's step as on the run's screen.
  async toggleSubtask(st){
    if (this.checklistRole === 'run') await this.tickRunStep(st, this.sheet.task.id, null);
    else await this.toggleDone(st, null, {sub: true});
    this.sheet.dirty = true;
  },

  /* ---------- progress ---------- */
  /* Progress set in a list, or on a subtask's row in its parent's sheet. At 100% the task is done and slides away, as
     when it's ticked off. A subtask's (`sub`) shows on its row only, as its tick does. `undoing`: putting back what it
     was, exactly, without marking it done. */
  async setProgress(t, pct, rowEl, {undoing = false, sub = isSubtask(t)} = {}){
    const was = pctOf(t), patch = undoing ? {percent_done: pct / 100} : progressPatch(t, pct);
    if (patch.done) return this.toggleDone(t, rowEl, {...patch, sub}, {percent_done: was / 100});
    t.percent_done = patch.percent_done;
    try {
      await this.saveTask(t.id, patch);
      if (!undoing && !sub) this.notify(`Progress set to ${pct}%`, {label: 'Undo', fn: () => this.setProgress(t, was, null, {undoing: true})});
    } catch (e) {
      t.percent_done = was / 100;
      this.notify(e instanceof NetError ? 'Offline — not saved' : 'Not saved: ' + e.message);
    }
  },
  // Progress set in the sheet: as in the list, 100% is done, and anything else says so, with Undo (but a subtask's, as
  // in the list, only on its bar).
  async sheetProgress(t, pct){
    const was = pctOf(t), patch = progressPatch(t, pct);
    if (patch.done) return this.sheetDone(patch);
    await this.save(patch);
    if (cache.get(t.id)?.percent_done === patch.percent_done && !isSubtask(t))
      this.notify(`Progress set to ${pct}%`, {label: 'Undo', fn: () => this.sheet.task?.id === t.id ? this.save({percent_done: was / 100}) : this.saveTask(t.id, {percent_done: was / 100}).catch(() => {})});
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
      if (kids.length) this.notify(`Moved, with ${kids.length} subtask${kids.length === 1 ? '' : 's'}`);
    } catch (e) { this.notify(`Moved, but not all its subtasks: ${e.message}`); }
    this.sheet.dirty = true;
  },
  // Whether Move all to today has anything to move: not a repeating task, nor a checklist that comes round.
  get overdueMovable(){ return (this.view.groups.find(g => g.key === 'overdue')?.tasks || []).some(t => !repeats(t) && !hasTemplateLabel(t)); },
  /* "Move all to today": each overdue task to today, at the time of day it had. Undo puts every date back. Not a
     repeating task: moved, its next times would follow the new date; ticked, it moves on to its next date. */
  async moveOverdueToToday(){
    // Nor a checklist that comes round: moved, a weekly one would come round on another day from then on.
    const overdue = this.view.groups.find(g => g.key === 'overdue')?.tasks || [], tasks = overdue.filter(t => !repeats(t) && !hasTemplateLabel(t));
    const tpl = overdue.filter(t => hasTemplateLabel(t)).length, stay = overdue.length - tasks.length - tpl;
    const stays = [stay && `${stay === 1 ? '1 repeating task stays' : stay + ' repeating tasks stay'}: tick ${stay === 1 ? 'it' : 'them'} to move on to the next date.`,
      tpl && `${tpl === 1 ? '1 checklist stays' : tpl + ' checklists stay'}: start ${tpl === 1 ? 'it' : 'them'} to move on to the next time.`].filter(Boolean).join(' ');
    if (!tasks.length && stays) { this.notify('Nothing moved. ' + stays); return; }
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
      if (k) this.notify(`${k === 1 ? '1 task' : k + ' tasks'} couldn't be moved back (changed since, or not saved) and ${k === 1 ? 'is' : 'are'} still due today.`);
      this.render();
    }};
    if (!n) return this.notify(this.offline ? 'Offline — not moved' : 'Not moved: Vikunja didn\'t save the changes');
    this.notify(`Moved ${n === 1 ? '1 task' : n + ' tasks'} to today` + (left ? `. ${left === 1 ? '1 wasn\'t' : left + ' weren\'t'} saved and ${left === 1 ? 'is' : 'are'} still overdue.` : '.') + (stays ? ' ' + stays : ''), undo);
    this.render();
  },

  /* ---------- adding subtasks ---------- */
  /* The subtask box's lines, as subtasks of the open task, through the outbox like quick add: without a connection they
     wait, shown in the sheet and the lists, and are sent once Pocket reaches Vikunja. (A template's steps are added with
     addTemplateSteps.) The box keeps the focus, to type the next one. Added, they show in the sheet, with no message
     unless there's a problem: one added by mistake is deleted from its row, which has an Undo. */
  async addSubtasks(){
    const parent = this.sheet.task, b = this.sheet.sub, lines = this.boxLines('sub'), parsed = this.boxParsedLines('sub');
    if (!parent || b.busy || !parsed.some(p => p.title)) return;
    const items = lines.map((raw, i) => ({raw, p: parsed[i]})).filter(x => x.p.title)
      .map(x => ({raw: x.raw, p: packParsed({...x.p, remind: this.remindOn('sub', lines)}), taskId: null, done: false, linked: false}));
    const entry = {id: randomId(), user: this.user?.id, at: new Date().toISOString(), nest: false, pid: parent.project_id,
      parent: {id: parent.id, project_id: parent.project_id, title: parent.title}, items, files: []};
    const here = () => this.sheet.task?.id === parent.id;
    b.busy = true; b.text = '';
    this.$nextTick(() => document.getElementById('d-subin')?.focus());
    try {
      const {kept, full} = await sync.add(entry, []);
      const slow = setTimeout(() => this.refreshPending(), 400);           // on a slow connection, shown as waiting meanwhile
      const r = await sync.lock(() => this.sendEntry(entry.id));
      clearTimeout(slow);
      this.placeSent(r.tasks || []);
      const n = items.length, but = r.problems?.length ? `, but ${r.problems.join('; ')}` : '';
      if (r.ids?.length && here()) {
        this.sheet.dirty = true;
        try { const t = await this.readTask(parent.id); if (t) { cache.set(t.id, t); if (here()) { this.showTask(t); this.loadSubPeople(t); } } } catch {}
      }
      if (r.status === 'offline') {
        sync.keep();
        this.notify(!kept ? (full ? NO_ROOM : NOT_KEPT) : `Saved offline. ${n === 1 ? 'It goes' : 'They go'} to Vikunja when you're back online.`);
      } else if (r.status === 'error') {
        if (here()) b.text = [r.unsent.join('\n'), b.text].filter(Boolean).join('\n');      // keep what wasn't added
        this.notify(r.ids.length ? `Added ${r.ids.length} of ${n}${but}. Stopped: ${r.error.message}` : 'Not added: ' + r.error.message);
      } else if (r.ids?.length && but) this.notify(`Added ${r.ids.length === 1 ? '1 subtask' : r.ids.length + ' subtasks'}${but}`);
    } finally { b.busy = false; this.refreshPending(); }
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
    try { tree = await this.taskTree(t.id); } catch (e) { this.notify('Not deleted: ' + e.message); return; }
    const n = tree.length - 1;
    if (!confirm(`Delete the template “${t.title}”` + (n ? ` and its ${n} step${n === 1 ? '' : 's'}? Runs already started keep theirs.` : '?') + ' This can\'t be undone here.')) return;
    await shared.saveChain;
    try {
      await this.deleteTree(tree);
      await leave();
      this.render();
      this.notify(n ? `Deleted, with ${n} step${n === 1 ? '' : 's'}` : 'Deleted');
    } catch (e) { this.notify(`Stopped after deleting ${e.deleted} of ${tree.length}: ${e.message}`); this.render(); }
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
    try { tree = await this.taskTree(t.id); } catch (e) { this.notify('Not deleted: ' + e.message); return null; }
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
