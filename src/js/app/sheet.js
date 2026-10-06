// A task's sheet: its details, labels and people, comments and attachments, and deleting.
import {cache, fmtSize, INLINE_TYPES, mimeOf, sizeLimit, taskDrafts, ZERO} from '../util.js';
import {api, errText, items, NetError, patchTask} from '../api.js';
import {addDays, dueInfo, fmtTime, isSet, startOfDay} from '../dates.js';
import {pctOf, progressPatch} from '../progress.js';
import {htmlToText, sanitize, textToHtml} from '../html.js';
import {hasTemplateLabel, notesOnly, patiently, stepInfos, stepsOf, templateName, templateTitle, withLinesOf} from '../checklists.js';
import {atTime} from '../quickadd.js';
import {fileEntry, NO_ROOM, NOT_KEPT, packParsed, randomId, sync} from '../sync.js';
import {blankSheet, shared} from './core.js';
import {sliding} from './progress.js';

export let pendingSaves = 0;
// Notes written and not saved yet, kept on the phone: {text, base: what the notes said when the editing began}. An older
// Pocket kept the text only.
const notesDraft = id => { const d = taskDrafts.get('desc:' + id); return d == null ? null : typeof d === 'string' ? {text: d, base: null} : d; };
// Saves to each task: how many have begun or ended, and how many haven't ended. A copy read while one was under way can
// be older than Vikunja's, so it isn't shown (readTask).
const saving = new Map();
const saveMark = (id, open) => { const s = saving.get(id) || {n: 0, open: 0}; s.n++; s.open += open; saving.set(id, s); };
const reminderKey = r => r.relative_to ? r.relative_to + ' ' + (r.relative_period || 0) : +new Date(r.reminder);
// The reminders as Vikunja takes them back: a relative one by what it counts from, so it keeps moving with that date.
export const plainReminders = t => (t?.reminders || []).map(r => r.relative_to ? {relative_to: r.relative_to, relative_period: r.relative_period || 0} : {reminder: r.reminder});
const repeats = t => t.repeat_after > 0 || t.repeat_mode === 1;
// Whether Vikunja's copy `now` has the change `body` made to `before`. A repeating task marked done is moved to its
// next date instead.
function landed(now, body, before){
  if (body.done === true && !now.done && repeats(now)) return !!before && !before.done && now.due_date !== before.due_date;
  return Object.entries(body).every(([k, v]) => {
    if (k === 'reminders') return JSON.stringify(plainReminders(now).map(reminderKey).sort()) === JSON.stringify(v.map(reminderKey).sort());
    if (k === 'description') return htmlToText(now[k] || '') === htmlToText(v || '');
    if (k.endsWith('_date')) return Date.parse(now[k]) === Date.parse(v);
    if (typeof v === 'number') return Math.abs((now[k] || 0) - v) < 1e-6;
    return (now[k] ?? null) === (v ?? null);
  });
}
let closeTimer;
let lastFocus;

export default {
  openSheet(kind){
    this.leaveTask();
    clearTimeout(closeTimer);
    const already = this.sheet.open && this.sheet.show, dirty = already && this.sheet.dirty;   // e.g. parent -> subtask
    if (!already) lastFocus = document.activeElement;
    // An entry for the phone's Back to close it with: a new one, or a closed sheet's, used again.
    if (history.state?.sheet === 'closed') { history.replaceState({...history.state, sheet: true}, ''); shared.onClosedSheet = false; }
    else if (!history.state?.sheet) history.pushState({...(history.state || {}), sheet: true}, '');
    this.sheet = {...blankSheet(kind), open: true, show: already, dirty};
    this.picker = {open: false, loading: false, error: '', q: ''};
    const sh = document.getElementById('sheet');
    if (already) this.$nextTick(() => { sh.querySelector('.scroll').scrollTop = 0; });
    else this.$nextTick(() => { void sh.offsetHeight; this.sheet.show = true; });   // reflow so the slide-in animates
  },
  closeSheet(instant){
    if (!this.sheet.open) return;
    this.leaveTask();
    const dirty = this.sheet.dirty;
    this.sheet.show = false;
    const done = () => { this.sheet = blankSheet(''); this.picker.open = false; };
    clearTimeout(closeTimer);
    if (instant) done(); else closeTimer = setTimeout(done, 260);
    if (dirty && !instant) this.render();
    lastFocus?.focus?.();
    // Closed with ×, a swipe or Escape: its history entry is marked closed (see the popstate listener). A screen opened
    // from the sheet replaces the entry (go()).
    if (history.state?.sheet === true) { history.replaceState({...history.state, sheet: 'closed'}, ''); shared.onClosedSheet = true; shared.closedAt = location.href; }
  },
  /* Leaving a task's sheet, closed or for another task: notes being changed are saved, and a comment or subtasks being
     written are kept for when it's opened again. */
  leaveTask(){
    const sh = this.sheet, t = sh.task;
    if (!sh.open || sh.kind !== 'task' || !t) return;
    if (sh.editingDesc && sh.descDraft.trim() !== this.notesText(t).trim()) {
      const v = sh.descDraft, base = sh.descConflict ?? sh.descBase;
      sh.editingDesc = false; sh.dirty = true;
      taskDrafts.set('desc:' + t.id, {text: v, base});                       // kept until it's saved
      this.saveTask(t.id, null, now => this.notesPatch(now, v, base)).then(() => { taskDrafts.delete('desc:' + t.id); this.notify('Notes saved'); },
        e => this.notify(e.notes !== undefined ? 'Notes not saved: they were changed elsewhere while you wrote. Yours are kept: open the task to see both.'
          : e instanceof NetError ? 'Offline: the notes are kept on this phone. Open the task to save them later.' : 'Notes not saved: ' + e.message + '. They\'re kept, to save later.'));
    } else if (!sh.editingDesc) taskDrafts.delete('desc:' + t.id);
    for (const [k, v] of [['comment', sh.commentDraft], ['sub', sh.sub.text]]) taskDrafts.set(k + ':' + t.id, v);
  },
  initSwipe(){                                   // swipe down to close
    let y0 = null; const sh = this.$refs.sheet;
    sh.addEventListener('touchstart', e => { const sc = sh.querySelector('.scroll'); y0 = (sc.scrollTop <= 0 || e.target.closest('.bar')) ? e.touches[0].clientY : null; }, {passive:true});
    sh.addEventListener('touchmove', e => { if (y0 !== null && sliding) { y0 = null; sh.style.transform = ''; } if (y0 === null) return; const dy = e.touches[0].clientY - y0; if (dy > 0) sh.style.transform = `translateY(${dy}px)`; }, {passive:true});
    sh.addEventListener('touchend', e => { if (y0 === null) return; const dy = e.changedTouches[0].clientY - y0; sh.style.transform = ''; y0 = null; if (dy > 110) this.closeSheet(); });
  },
  // The header slides away once the list has scrolled down past it, and comes back as soon as it scrolls up a little.
  initHeader(){
    let anchor = scrollY;                        // where the current run of scrolling, down or up, turned around
    addEventListener('scroll', () => {
      const y = scrollY;
      if (y <= this.$refs.header.offsetHeight || this.route.name === 'search') { this.headerTucked = false; anchor = y; return; }
      const tucked = this.headerTucked;
      if (tucked ? y < anchor - 12 : y > anchor + 12) { this.headerTucked = !tucked; anchor = y; }
      else if (tucked ? y > anchor : y < anchor) anchor = y;
    }, {passive: true});
  },
  openAccount(){ this.openSheet('account'); },

  async openTask(id){
    const from = this.sheet.open && this.sheet.kind === 'task' ? this.sheet.task?.id : null;
    this.openSheet('task');
    this.sheet.from = from;
    this.sheet.commentDraft = taskDrafts.get('comment:' + id) || '';
    this.sheet.sub.text = taskDrafts.get('sub:' + id) || '';
    // Notes that couldn't be saved (offline, say): back in the editor, to save again.
    const desc = notesDraft(id);
    if (desc) Object.assign(this.sheet, {editingDesc: true, descDraft: desc.text, descBase: desc.base, descUnsaved: true});
    this.sheet.addRows = (taskDrafts.get('addsteps:' + id) || []).map(r => ({...r, focus: false}));
    const mine = this.sheet, cached = cache.get(id);
    if (cached) this.showTask(cached); else this.sheet.loading = true;
    try {
      // If it was changed while this loaded, the save brings a newer copy; the old one isn't put back.
      const t = await this.readTask(id);
      if (this.sheet !== mine) return;
      if (t) { cache.set(id, t); this.showTask(t); this.checkNotes(t); }
      this.loadComments(id); this.loadSubPeople(t || cached || {id});
    } catch (e) {
      if (!cached && this.sheet === mine) this.sheet.error = errText(e);
      else if (this.sheet === mine) { this.loadComments(id); this.loadSubPeople(cached); }   // says it can't, offline; a comment can still be written
    }
    finally { if (this.sheet === mine) this.sheet.loading = false; }
  },
  // Vikunja's copy of a task, read once the saves waiting now are done; or null if another save to it was under way
  // while it was read: that save's reply is newer.
  async readTask(id){
    await shared.saveChain;
    const before = saving.get(id), n = before?.n, t = await api('/tasks/' + id);
    return !before?.open && saving.get(id)?.n === n ? t : null;
  },
  showTask(t){
    if (this.sheet.task?.id === t.id) Object.assign(this.sheet.task, t); else this.sheet.task = {...t};
    this.keepTemplate(this.sheet.task);
    if (document.activeElement?.id !== 'd-title') this.sheet.title = this.rowTitle(t);
  },
  /* Repeat settings as Vikunja stores them: repeat_mode 1 is monthly, otherwise repeat_after is an interval in seconds. */
  get repeatValue(){
    const t = this.sheet.task; if (!t) return 'none';
    if (t.repeat_mode === 1) return 'month';
    return {0: 'none', 86400: 'day', 604800: 'week', 1209600: '2weeks'}[t.repeat_after || 0] || 'custom';
  },
  get repeatOptions(){
    const opts = [{value: 'none', label: 'Doesn’t repeat'}, {value: 'day', label: 'Every day'}, {value: 'week', label: 'Every week'},
      {value: '2weeks', label: 'Every 2 weeks'}, {value: 'month', label: 'Every month'}];
    if (this.repeatValue === 'custom') {
      const days = this.sheet.task.repeat_after / 86400;
      opts.push({value: 'custom', label: Number.isInteger(days) ? `Every ${days} days` : 'Custom (set in Vikunja)'});
    }
    return opts;
  },
  setRepeat(v){
    if (v === 'custom') return;
    const patch = v === 'month' ? {repeat_mode: 1, repeat_after: 0}
      : {repeat_mode: 0, repeat_after: {none: 0, day: 86400, week: 604800, '2weeks': 1209600}[v]};
    // A repeating task needs a due date to move forward from. A template that's done has none that counts: given one, it
    // comes round, not done.
    const tpl = this.checklistRole === 'template';
    if (v !== 'none' && !isSet(this.dueShown)) {
      const d = atTime(new Date(), this.dueTime);
      patch.due_date = (d < new Date() ? addDays(d, 1) : d).toISOString();
      if (tpl) patch.done = false;
    }
    this.save(patch);
  },
  // The due date the sheet shows: a template's is when it next comes round, so a done one has none.
  get dueShown(){ const t = this.sheet.task; return this.checklistRole === 'template' && t.done ? ZERO : t.due_date; },
  /* The due date set in the sheet. A template's is when it comes round: given one, it's left not done; taken off, it's
     done again, its repeat first, then the date and done, in two saves: in one, Vikunja would move it on to its next
     time and leave it not done. */
  async setDue(v){
    const t = this.sheet.task;
    if (this.checklistRole !== 'template') return this.save({due_date: v});
    if (isSet(v)) return this.save({due_date: v, ...t.done && {done: false}});
    if (repeats(t) && await this.save({repeat_after: 0, repeat_mode: 0}) === false) return;
    return this.save({due_date: ZERO, done: true});
  },
  // The template a step is in, by name.
  get parentTitle(){ const p = this.parentTask; return p && (this.checklistRole === 'tplstep' ? templateName(p.title) : p.title); },
  get subtasks(){ return stepsOf(this.sheet.task); },
  // A template's steps as its sheet and the start sheet show them: when each is due, or what's wrong with it.
  get templateSteps(){ return stepInfos(this.subtasks.map(s => s.title)); },
  get startSteps(){ return stepInfos((this.sheet.start?.steps || []).map(s => s.title)); },
  get parentTask(){ return this.sheet.task?.related_tasks?.parenttask?.[0] || null; },
  // A subtask ticked in its parent's sheet: as in a list, with Undo; a run's step as on the run's screen.
  async toggleSubtask(st){
    if (this.checklistRole === 'run') await this.tickRunStep(st, this.sheet.task.id, null);
    else await this.toggleDone(st, null);
    this.sheet.dirty = true;
  },
  /* The subtask box's lines, as subtasks of the open task, through the outbox like quick add: without a connection they
     wait, shown in the sheet and the lists, and are sent once Pocket reaches Vikunja. (A template's steps are added with
     addTemplateSteps.) The box keeps the focus, to type the next one. */
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
      } else if (r.ids?.length) {
        const n = r.ids.length;
        this.notify(`Added ${n} subtask${n === 1 ? '' : 's'}${but}`, {label: 'Undo', fn: async () => {
          await this.deleteTasks(r.ids);
          const t = await this.readTask(parent.id).catch(() => null);
          if (t && here()) { cache.set(t.id, t); this.showTask(t); }
        }});
      }
    } finally { b.busy = false; this.refreshPending(); }
  },
  // Subtasks of the open task still waiting to be sent, for its sheet.
  get pendingSubtasks(){ return this.pendingTasks.filter(t => t.parent === this.sheet.task?.id); },
  get descHtml(){
    const d = notesOnly(this.sheet.task?.description).replace(/<p>\s*<\/p>/g,'').trim();
    return d ? sanitize(d) : '<span class="ph">Add notes</span>';
  },

  /* Save a change to the open task. The sheet updates right away; the server's copy is applied once no other saves are queued. */
  save(patch, rebase){
    const id = this.sheet.task?.id; if (!id) return;
    Object.assign(this.sheet.task, patch);
    this.sheet.savedMsg = 'Saving…';
    pendingSaves++;
    return this.saveTask(id, patch, rebase).then(saved => {
      if (--pendingSaves || this.sheet.task?.id !== id) return;
      const repeated = patch.done === true && !saved.done;
      this.showTask(saved); this.sheet.dirty = true;
      this.sheet.savedMsg = repeated ? 'Repeats — moved to next date' : 'Saved';
      setTimeout(() => { if (this.sheet.savedMsg === 'Saved') this.sheet.savedMsg = ''; }, 1500);
    }, e => {
      pendingSaves--;
      if (this.sheet.task?.id === id) { this.sheet.savedMsg = ''; if (cache.get(id)) this.showTask(cache.get(id)); }
      this.notify(e instanceof NetError ? 'Offline — not saved' : 'Not saved: ' + e.message);
      return false;
    });
  },
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
  // Progress set in the sheet: as in the list, 100% is done, and anything else says so, with Undo.
  async sheetProgress(t, pct){
    const was = pctOf(t), patch = progressPatch(t, pct);
    if (patch.done) return this.sheetDone(patch);
    await this.save(patch);
    if (cache.get(t.id)?.percent_done === patch.percent_done)
      this.notify(`Progress set to ${pct}%`, {label: 'Undo', fn: () => this.sheet.task?.id === t.id ? this.save({percent_done: was / 100}) : this.saveTask(t.id, {percent_done: was / 100}).catch(() => {})});
  },
  nudgeProgress(step){                           // the arrow keys, on the focused bar
    if (this.isRunTask(this.sheet.task)) return;
    const t = this.sheet.task, was = pctOf(t), pct = Math.max(0, Math.min(100, Math.round(was / 10) * 10 + step));
    if (pct !== was) this.sheetProgress(t, pct);
  },
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
  // A template's name: its title keeps "TEMPLATE: " before it.
  saveTitle(){
    const t = this.sheet.task, v = this.sheet.title.trim();
    if (v && v !== this.rowTitle(t)) this.save({title: hasTemplateLabel(t) ? templateTitle(v) : v}); else this.sheet.title = this.rowTitle(t);
  },
  // The notes as text, and as saved: Pocket's lines (a template's order, a run's) are left out while they're edited, and
  // kept. Saved with the lines Vikunja has when they're sent (`t`, read then), so a step moved elsewhere stays moved.
  notesText(t){ return htmlToText(notesOnly(t.description)); },
  notesHtml(t, text){ return withLinesOf(text.trim() ? textToHtml(text) : '', t.description); },
  // Editing the notes starts from what they say now (descBase), so a save can tell if they were changed elsewhere since.
  editDesc(){
    Object.assign(this.sheet, {descDraft: this.notesText(this.sheet.task), descBase: this.notesText(this.sheet.task), descConflict: null, editingDesc: true});
  },
  cancelDesc(){
    Object.assign(this.sheet, {editingDesc: false, descUnsaved: false, descConflict: null});
    taskDrafts.delete('desc:' + this.sheet.task.id);
  },
  /* The notes to save, made to Vikunja's copy as it is when they're sent (`now`). Not if its notes were changed since
     the editing began (`base`; null: not known, from an older Pocket): those aren't written over unseen. The error
     carries them (notes) and Vikunja's copy (now). */
  notesPatch(now, text, base){
    const has = this.notesText(now).trim();
    if (base !== null && base !== undefined && has !== base.trim() && has !== text.trim())
      throw Object.assign(new Error('the notes were changed elsewhere while you wrote'), {notes: has, now});
    return {description: this.notesHtml(now, text)};
  },
  // Notes kept on the phone, opened again: if Vikunja's have changed since they were begun, both are shown.
  checkNotes(t){
    const sh = this.sheet, has = this.notesText(t).trim();
    if (sh.editingDesc && sh.descBase !== null && sh.descBase !== undefined && has !== sh.descBase.trim() && has !== sh.descDraft.trim()) sh.descConflict = has;
  },
  /* Save the notes. If they can't be saved (offline, say), they stay in the editor, and on the phone, to save later. If
     they were changed elsewhere meanwhile, Vikunja's are shown under them: saving again replaces those, once seen. */
  async saveDesc(){
    const sh = this.sheet, v = sh.descDraft, t = sh.task, base = sh.descConflict ?? sh.descBase, here = () => this.sheet.task?.id === t.id;
    Object.assign(sh, {editingDesc: false, savedMsg: 'Saving…'});
    try {
      const got = await this.saveTask(t.id, null, now => this.notesPatch(now, v, base));
      taskDrafts.delete('desc:' + t.id);
      if (!here()) return;
      this.showTask(got);
      Object.assign(this.sheet, {descUnsaved: false, descConflict: null, dirty: true, savedMsg: 'Saved'});
      setTimeout(() => { if (this.sheet.savedMsg === 'Saved') this.sheet.savedMsg = ''; }, 1500);
    } catch (e) {
      const seen = e.notes ?? null;
      taskDrafts.set('desc:' + t.id, {text: v, base});
      if (here()) {
        if (e.now) { cache.set(t.id, e.now); this.showTask(e.now); }
        Object.assign(this.sheet, {editingDesc: true, descDraft: v, descUnsaved: true, savedMsg: '', ...seen !== null && {descConflict: seen}});
      }
      this.notify(seen !== null ? 'Not saved: the notes were changed elsewhere while you wrote. Both are shown: save again to replace them with yours.'
        : e instanceof NetError ? 'Offline — not saved' : 'Not saved: ' + e.message);
    }
  },

  /* ---------- reminders ---------- */
  // Whether Vikunja's reminders reach you: it sends them by email, if the server has that on and so do you.
  get remindersReach(){ return !!this.info?.email_reminders_enabled && !!this.user?.settings?.email_reminders_enabled; },
  get remindersNote(){
    if (this.remindersReach) return '';
    return 'Vikunja sends reminders by email, and ' + (this.info?.email_reminders_enabled ? 'yours are turned off in your Vikunja settings.' : 'this server doesn\'t send them.');
  },
  // A reminder in words: "At due", "15 min before due", or when it goes off. One counted from a date the task doesn't have says so.
  reminderText(r){
    // At a set time: its day and time, even at noon or midnight, and whether it's past.
    if (!r.relative_to) { const d = new Date(r.reminder); return isSet(r.reminder) ? `${dueInfo(startOfDay(d).toISOString()).label} ${fmtTime(d)}${d < new Date() ? ' (past)' : ''}` : ''; }
    const s = Math.abs(r.relative_period || 0), from = {due_date: 'due', start_date: 'the start', end_date: 'the end'}[r.relative_to] || r.relative_to;
    const unset = !isSet(this.sheet.task?.[r.relative_to]) ? ' (no date: it won\'t go off)' : '';
    if (!s) return (r.relative_to === 'due_date' ? 'At due' : 'At ' + from) + unset;
    const [n, unit] = [[86400, 'day'], [3600, 'hour'], [60, 'min']].find(([n]) => s % n === 0 && s >= n) || [1, 'sec'];
    const k = s / n;
    return `${k} ${unit}${k === 1 || unit === 'min' || unit === 'sec' ? '' : 's'} ${r.relative_period < 0 ? 'before' : 'after'} ${from}${unset}`;
  },
  // What can be added: counted back from the due date, so it moves with it, when there is one; or a set date and time.
  get reminderPresets(){
    const t = this.sheet.task, have = new Set((t?.reminders || []).filter(r => r.relative_to === 'due_date').map(r => r.relative_period || 0));
    const before = isSet(t?.due_date) ? [[0, 'At due'], [-900, '15 min before due'], [-3600, '1 hour before due'], [-86400, '1 day before due']] : [];
    return [...before.filter(([p]) => !have.has(p)).map(([p, label]) => ({value: String(p), label})), {value: 'at', label: 'At a set date and time…'}];
  },
  addReminder(v){
    if (v === 'at') { this.sheet.remindAt = true; this.$nextTick(() => { const el = document.getElementById('d-remind-at'); el?.focus(); try { el?.showPicker(); } catch {} }); }
    else if (v) this.changeReminders({relative_to: 'due_date', relative_period: +v}, null);
  },
  addReminderAt(v){ this.sheet.remindAt = false; if (v) this.changeReminders({reminder: new Date(v).toISOString()}, null); },
  removeReminder(k){ const r = plainReminders(this.sheet.task)[k]; if (r) this.changeReminders(null, r); },
  // Add a reminder or take one out, of those Vikunja has when it's sent: one added or removed elsewhere since the sheet
  // opened stays that way.
  changeReminders(add, drop){
    const skip = new Set([add, drop].filter(Boolean).map(reminderKey));
    const edit = t => [...plainReminders(t).filter(r => !skip.has(reminderKey(r))), ...add ? [add] : []];
    return this.save({reminders: edit(this.sheet.task)}, now => ({reminders: edit(now)}));
  },

  /* ---------- labels ---------- */
  async toggleLabelPicker(){
    if (this.picker.open) { this.picker.open = false; return; }
    this.picker = {open: true, loading: true, error: '', q: ''};
    try { await this.loadLabels(); } catch (e) { this.picker.error = errText(e); }
    this.picker.loading = false;
  },
  // Enter in the label picker: the label on top of the list (the one with that name, if there is one), else a new one.
  labelEnter(){
    const q = this.picker.q.trim().toLowerCase(), m = this.pickerMatches;
    if (!q) return;
    const exact = m.find(l => l.title.toLowerCase() === q);
    if (exact || m[0]) this.addLabel(exact || m[0]); else if (this.pickerCanCreate) this.addLabel(null);
  },
  get pickerMatches(){
    const have = new Set((this.sheet.task?.labels || []).map(l => l.id)), ql = this.picker.q.trim().toLowerCase();
    return this.labels.filter(l => !have.has(l.id) && (!ql || l.title.toLowerCase().includes(ql))).slice(0, 30);
  },
  get pickerCanCreate(){
    const ql = this.picker.q.trim().toLowerCase();
    return !!ql && !this.labels.some(l => l.title.toLowerCase() === ql);
  },
  setAssignees(assignees, id = this.sheet.task.id){
    if (this.sheet.task?.id === id) { this.sheet.task.assignees = assignees; this.sheet.dirty = true; }
    const c = cache.get(id); if (c) c.assignees = assignees;
    this.syncTask({id, assignees});
  },
  /* People to assign, as @ suggests them in quick add, matching what's typed: only those who can see the task's project
     (Vikunja refuses anyone else), without those assigned already. */
  get assignSuggestions(){
    const t = this.sheet.task, q = this.sheet.assignName.trim().replace(/^@/, '').toLowerCase(), have = new Set((t?.assignees || []).map(u => u.id));
    const score = u => Math.min(...[u.username, u.name].map(n => (n || '').toLowerCase()).map(n => !q || n.startsWith(q) ? 0 : n.includes(q) ? 1 : 9));
    return (this.people || []).filter(x => !have.has(x.user.id) && x.pids.has(t?.project_id)).map(x => ({u: x.user, s: score(x.user)}))
      .filter(x => x.s < 9).sort((a, b) => a.s - b.s || (a.u.name || a.u.username).localeCompare(b.u.name || b.u.username))
      .slice(0, 6).map(x => x.u);
  },
  // Assign someone tapped in the suggestions, or, on Enter, the username typed (or the first suggestion). The box stays
  // open for the next one, until Done.
  async assign(picked){
    const typed = this.sheet.assignName.trim().replace(/^@/, ''), t = this.sheet.task;   // the task it started on
    const sg = this.assignSuggestions, exact = sg.find(u => u.username.toLowerCase() === typed.toLowerCase());
    const pick = picked || exact || (typed && sg[0]) || null, name = pick ? pick.username : typed;
    if (!name) { this.sheet.assigning = false; return; }
    try {
      const u = pick || await this.findUser(name);
      if (!u) { this.notify(`No user @${name}`); return; }
      await api(`/tasks/${t.id}/assignees`, {method:'POST', body:{user_id: u.id}});
      this.setAssignees([...(t.assignees || []).filter(x => x.id !== u.id), u], t.id);
      if (this.sheet.task?.id === t.id) { this.sheet.assignName = ''; document.getElementById('d-assign-in')?.focus(); }
    } catch (e) { this.notify('Not assigned: ' + e.message); }
  },
  async unassign(uid){
    const t = this.sheet.task;                                                // the task it started on
    try {
      await api(`/tasks/${t.id}/assignees/${uid}`, {method:'DELETE'});
      this.setAssignees((t.assignees || []).filter(u => u.id !== uid), t.id);
    } catch (e) { this.notify('Not unassigned: ' + e.message); }
  },
  setLabels(labels, id = this.sheet.task.id){
    if (this.sheet.task?.id === id) { this.sheet.task.labels = labels; this.sheet.dirty = true; }
    const c = cache.get(id); if (c) c.labels = labels;
    this.syncTask({id, labels});
  },
  async addLabel(l){
    const t = this.sheet.task;                                                // the task it started on
    try {
      if (!l) { l = await api('/labels', {method:'POST', body:{title: this.picker.q.trim()}}); this.labels.push(l); }
      await api(`/tasks/${t.id}/labels`, {method:'POST', body:{label_id: l.id}});
      this.setLabels([...(t.labels || []), l], t.id);
      if (this.sheet.task?.id === t.id) this.picker.q = '';
    } catch (err) { this.notify('Label not added: ' + err.message); }
  },
  async removeLabel(lid){
    const t = this.sheet.task;                                                // the task it started on
    try {
      await api(`/tasks/${t.id}/labels/${lid}`, {method:'DELETE'});
      this.setLabels((t.labels || []).filter(l => l.id !== lid), t.id);
    } catch (e) { this.notify('Label not removed: ' + e.message); }
  },

  /* ---------- comments, attachments, delete ---------- */
  async loadComments(id){
    if (this.info && this.info.task_comments_enabled === false) { this.sheet.commentsNote = 'Comments are turned off on this server.'; return; }
    try {
      const list = items(await api(`/tasks/${id}/comments`));
      if (this.sheet.task?.id === id) { this.sheet.comments = list; this.sheet.commentsNote = ''; }
    } catch (e) {
      if (this.sheet.task?.id !== id) return;
      if (e instanceof NetError) { this.sheet.comments ||= []; this.sheet.commentsNote = 'Offline: the comments show once Pocket reaches Vikunja. One written now is posted then.'; }
      else this.sheet.commentsNote = errText(e);
    }
  },
  // A comment goes through the outbox, as a note on a run does: without a connection it waits, and is posted later.
  async postComment(){
    const id = this.sheet.task.id, v = this.sheet.commentDraft.trim(); if (!v) return;
    this.sheet.commentDraft = ''; taskDrafts.delete('comment:' + id);
    const r = await this.act({op: 'note', task: id, html: textToHtml(v), run: null});
    if (r.status === 'offline') this.notify(r.reached ? 'Vikunja had a problem with the comment. Pocket tries again shortly.' : 'Saved offline. The comment is posted when you\'re back online.');
    if (r.status === 'error' && this.sheet.task?.id === id) this.sheet.commentDraft = v;
  },
  // Comments on the open task still waiting to be posted.
  get pendingComments(){ return this.pending.filter(e => e.kind === 'act' && e.op === 'note' && e.task === this.sheet.task?.id && !e.run); },
  // A blob: URL runs with this app's origin, so an HTML or SVG attachment opened that way could read the
  // saved token. Only types that can't run script open in a tab; everything else is downloaded.
  get attachmentsOn(){ return this.info?.task_attachments_enabled !== false; },
  // The files of these that this Vikunja won't take, said plainly; '' when they all fit. (Vikunja's own message about
  // it gives the wrong limit.)
  tooBig(files){
    const max = sizeLimit(this.info?.max_file_size), big = max ? files.filter(f => f.size > max) : [];
    return big.length ? `${big.map(f => `${f.name} (${fmtSize(f.size)})`).join(', ')} ${big.length === 1 ? 'is' : 'are'} too big: your Vikunja takes files up to ${this.info.max_file_size}.` : '';
  },
  // From the sheet's "Add a photo or file". They go through the outbox, so without a connection they wait on the
  // phone, shown in the sheet, and upload once Pocket reaches Vikunja again.
  async addFiles(list, t = this.sheet.task){
    const files = [...list];
    if (!files.length || !t) return;
    const big = this.tooBig(files); if (big) { this.notify(big); return; }
    const entry = {id: randomId(), user: this.user?.id, at: new Date().toISOString(), taskId: t.id, items: [], files: files.map(fileEntry)};
    const {kept, full} = await sync.add(entry, files); this.refreshPending();
    const r = await sync.lock(() => this.sendEntry(entry.id));
    this.refreshPending();
    if (r.status === 'offline') { sync.keep(); if (!kept) this.notify(full ? NO_ROOM : NOT_KEPT); }
    if (r.problems?.length) this.notify(r.problems.join('; '));
  },
  // From the add box's camera button.
  addCapPhotos(list){
    const files = [...list], big = this.tooBig(files);
    if (big) this.notify(big);
    const max = sizeLimit(this.info?.max_file_size);
    this.capPhotos.push(...files.filter(f => !max || f.size <= max));
    this.$refs.capture.focus();
  },
  async openAttachment(a, taskId = this.sheet.task.id){
    const inline = INLINE_TYPES.test(mimeOf(a.file?.mime));
    const w = inline ? window.open('', '_blank') : null;   // open synchronously so iOS doesn't block it
    try {
      const res = await api(`/tasks/${taskId}/attachments/${a.id}`, {raw:true});
      const blob = await res.blob(), type = mimeOf(blob.type);
      if (inline && INLINE_TYPES.test(type)) {
        const url = URL.createObjectURL(new Blob([blob], {type}));
        if (w) w.location = url; else location.href = url;
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        return;
      }
      w?.close();
      const url = URL.createObjectURL(new Blob([blob], {type: 'application/octet-stream'}));
      Object.assign(document.createElement('a'), {href: url, download: a.file?.name || 'attachment'}).click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) { w?.close(); this.notify('Couldn\'t open: ' + e.message); }
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
    let tree;
    try { tree = await this.taskTree(t.id); } catch (e) { this.notify('Not deleted: ' + e.message); return; }
    const n = tree.length - 1;
    const direct = this.subtasks.length, deeper = n > direct ? `, ${n - direct} more under ${direct === 1 ? 'it' : 'them'}` : '';
    const what = role === 'template' ? `the template “${t.title}”` + (n ? ` and its ${n} step${n === 1 ? '' : 's'}? Runs already started keep theirs.` : '?')
      : `“${t.title}”` + (n ? ` and its ${direct} subtask${direct === 1 ? '' : 's'}${deeper}?` : '?');
    if (!confirm(`Delete ${what} This can't be undone here.`)) return;
    await shared.saveChain;
    // Opened from its parent's sheet: back to the parent afterwards.
    const back = this.sheet.from && (t.related_tasks?.parenttask || []).some(x => x.id === this.sheet.from) ? this.sheet.from : null;
    try {
      await this.deleteTree(tree);
      Object.assign(this.sheet, {dirty: false, editingDesc: false, commentDraft: ''}); this.sheet.sub.text = '';
      if (back) { await this.openTask(back); this.sheet.dirty = true; } else this.closeSheet();
      this.render();
      this.notify(n ? `Deleted, with ${n} ${role === 'template' ? 'step' : 'subtask'}${n === 1 ? '' : 's'}` : 'Deleted');
    } catch (e) { this.notify(`Stopped after deleting ${e.deleted} of ${tree.length}: ${e.message}`); this.render(); }
  },
  /* A task and its subtasks, all the way down, deepest first. A subtask that's also under another task stays, with
     what's under it. */
  async taskTree(id){
    const out = [], seen = new Set();
    const walk = async (tid, from) => {
      if (seen.has(tid)) return;
      seen.add(tid);
      const t = tid === this.sheet.task?.id ? this.sheet.task : await api('/tasks/' + tid);
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
        cache.delete(id); this.removeRow(id); n++;
      }
    } catch (e) { e.deleted = n; throw e; }
  },
};
