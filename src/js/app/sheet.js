// A task's sheet: its details, labels and people, comments and attachments. What's done to the task is in actions.js.
import {cache, fmtSize, INLINE_TYPES, mimeOf, sizeLimit, taskDrafts, ZERO} from '../util.js';
import {api, errText, items, NetError} from '../api.js';
import {addDays, dueInfo, fmtTime, isSet, startOfDay} from '../dates.js';
import {htmlToText, sanitize, textToHtml} from '../html.js';
import {hasTemplateLabel, notesOnly, stepInfos, stepsOf, templateName, templateTitle, withLinesOf} from '../checklists.js';
import {atTime} from '../quickadd.js';
import {notSaved} from '../messages.js';
import {fileEntry, NO_ROOM, NOT_KEPT, randomId, sync} from '../sync.js';
import {plainReminders, reminderKey} from './actions.js';
import {blankSheet, shared} from './core.js';
import {sliding} from './progress.js';

export let pendingSaves = 0;
// Notes written and not saved yet, kept on the phone: {text, base: what the notes said when the editing began}. An older
// Pocket kept the text only.
const notesDraft = id => { const d = taskDrafts.get('desc:' + id); return d == null ? null : typeof d === 'string' ? {text: d, base: null} : d; };
const repeats = t => t.repeat_after > 0 || t.repeat_mode === 1;
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
     written are kept for when it's opened again. Not again for a sheet already closing (a task opened again within its
     slide down): that was done as it closed. */
  leaveTask(){
    const sh = this.sheet, t = sh.task;
    if (!sh.open || !sh.show || sh.kind !== 'task' || !t) return;
    if (sh.editingDesc && sh.descDraft.trim() !== this.notesText(t).trim()) {
      const v = sh.descDraft, base = sh.descConflict ?? sh.descBase;
      sh.editingDesc = false; sh.dirty = true;
      taskDrafts.set('desc:' + t.id, {text: v, base});                       // kept until it's saved
      // Said on the task's row, once the sheet has gone; not saved, with Open, to see them.
      const row = {id: t.id, stays: true}, open = {label: 'Open', fn: () => this.openTask(t.id)};
      this.saveTask(t.id, null, now => this.notesPatch(now, v, base)).then(() => { taskDrafts.delete('desc:' + t.id); this.say('Notes saved', {row}); },
        e => this.say(e.notes !== undefined ? 'Notes not saved: they were changed elsewhere while you wrote. Yours are kept: open the task to see both.'
          : e instanceof NetError ? 'Notes not saved: no connection. They\'re kept on this phone: open the task to save them later.' : 'Notes not saved: ' + e.message + '. They\'re kept, to save later.',
          {row: {...row, cls: 'failed'}, action: open}));
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
      // Said, so it isn't a surprise: the date is the next time of day you have as Vikunja's default due time.
      const label = dueInfo(patch.due_date).label, when = /\d:\d\d/.test(label) ? label : label + ' ' + fmtTime(new Date(patch.due_date));
      this.say(`It repeats from ${when}: change the date above if that's not when.`, {place: 'sheet:due', ms: 8000});
    }
    this.save(patch);
  },
  // The due date the sheet shows: a template's is when it next comes round, so a done one has none.
  get dueShown(){ const t = this.sheet.task; return this.checklistRole === 'template' && t.done ? ZERO : t.due_date; },
  /* The due date set in the sheet. A template's is when it comes round: given one, it's left not done; taken off, it's
     done again. Its repeat is taken off first, then the date and done, in two saves (in one, Vikunja would move it on to
     its next time and leave it not done), then put back, so a date given again comes round as it did. */
  async setDue(v){
    const t = this.sheet.task;
    if (this.checklistRole !== 'template') return this.save({due_date: v});
    if (isSet(v)) return this.save({due_date: v, ...t.done && {done: false}});
    const rep = repeats(t) && {repeat_after: t.repeat_after, repeat_mode: t.repeat_mode};
    if (rep && await this.save({repeat_after: 0, repeat_mode: 0}) === false) return;
    if (await this.save({due_date: ZERO, done: true}) === false || !rep) return;
    return this.save(rep);
  },
  // The template a step is in, by name.
  get parentTitle(){ const p = this.parentTask; return p && (this.checklistRole === 'tplstep' ? templateName(p.title) : p.title); },
  get subtasks(){ const hidden = this.hiddenRows; return stepsOf(this.sheet.task).filter(s => !hidden.has(s.id)); },   // not those being deleted
  // A template's steps as its sheet and the start sheet show them: when each is due, or what's wrong with it.
  get templateSteps(){ return stepInfos(this.subtasks.map(s => s.title)); },
  get startSteps(){ return stepInfos((this.sheet.start?.steps || []).map(s => s.title)); },
  get parentTask(){ return this.sheet.task?.related_tasks?.parenttask?.[0] || null; },
  // Subtasks of the open task still waiting to be sent, for its sheet.
  get pendingSubtasks(){ return this.pendingTasks.filter(t => t.parent === this.sheet.task?.id); },
  get descHtml(){
    const d = notesOnly(this.sheet.task?.description).replace(/<p>\s*<\/p>/g,'').trim();
    return d ? sanitize(d) : '<span class="ph">Add notes</span>';
  },

  /* Save a change to the open task. The sheet updates right away; the server's copy is applied once no other saves are
     queued. Not saved, it goes back, and the top of the sheet says so, with Try again. Resolves to false then. */
  save(patch, rebase){
    const id = this.sheet.task?.id; if (!id) return;
    Object.assign(this.sheet.task, patch);
    this.sheet.savedMsg = 'Saving…';
    pendingSaves++;
    return this.saveTask(id, patch, rebase).then(saved => {
      if (--pendingSaves || this.sheet.task?.id !== id) return;
      const repeated = patch.done === true && !saved.done;
      this.showTask(saved); this.sheet.dirty = true; this.unsay('sheet:top');   // a save that failed before is done now
      this.sheet.savedMsg = repeated ? 'Repeats — moved to next date' : 'Saved';
      setTimeout(() => { if (this.sheet.savedMsg === 'Saved') this.sheet.savedMsg = ''; }, 1500);
    }, e => {
      pendingSaves--;
      if (this.sheet.task?.id === id) {
        this.sheet.savedMsg = ''; if (cache.get(id)) this.showTask(cache.get(id));
        this.say(notSaved(e), {place: 'sheet:top', cls: 'failed', ms: null, action: {label: 'Try again', fn: () => this.save(patch, rebase)}});
      } else this.notify(notSaved(e));                                        // its sheet has gone
      return false;
    });
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
      // Said under them, as they're kept in the box.
      this.say(seen !== null ? 'Not saved: the notes were changed elsewhere while you wrote. Both are shown: save again to replace them with yours.'
        : notSaved(e), {place: 'sheet:notes', cls: 'failed', ms: null});
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
      if (!u) { this.say(`No user @${name}`, {place: 'sheet:props', cls: 'failed'}); return; }
      await this.addAssignee(t, u);
      if (this.sheet.task?.id === t.id) { this.sheet.assignName = ''; document.getElementById('d-assign-in')?.focus(); }
    } catch (e) { this.say('Not assigned: ' + e.message, {place: 'sheet:props', cls: 'failed'}); }
  },
  async unassign(uid){
    const t = this.sheet.task;                                                // the task it started on
    try {
      await this.removeAssignee(t, uid);
    } catch (e) { this.say('Not unassigned: ' + e.message, {place: 'sheet:props', cls: 'failed'}); }
  },
  async addLabel(l){
    const t = this.sheet.task;                                                // the task it started on
    try {
      await this.addLabelTo(t, l, this.picker.q.trim());
      if (this.sheet.task?.id === t.id) this.picker.q = '';
    } catch (err) { this.say('Label not added: ' + err.message, {place: 'sheet:props', cls: 'failed'}); }
  },
  async removeLabel(lid){
    const t = this.sheet.task;                                                // the task it started on
    try {
      await this.removeLabelFrom(t, lid);
    } catch (e) { this.say('Label not removed: ' + e.message, {place: 'sheet:props', cls: 'failed'}); }
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
    if (r.status === 'offline') this.say(r.reached ? 'Vikunja had a problem with the comment. Pocket tries again shortly.' : 'Saved offline. The comment is posted when you\'re back online.', {place: 'sheet:comments'});
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
    const at = ['sheet:files', 'step'], big = this.tooBig(files);                // in a task's sheet, or on a run's step card
    if (big) { this.say(big, {place: at, cls: 'failed'}); return; }
    const entry = {id: randomId(), user: this.user?.id, at: new Date().toISOString(), taskId: t.id, items: [], files: files.map(fileEntry)};
    const {kept, full} = await sync.add(entry, files); this.refreshPending();
    const r = await sync.lock(() => this.sendEntry(entry.id));
    this.refreshPending();
    if (r.status === 'offline') { sync.keep(); if (!kept) this.say(full ? NO_ROOM : NOT_KEPT, {place: at, cls: 'failed'}); }
    if (r.problems?.length) this.say(r.problems.join('; '), {place: at, cls: 'failed'});
  },
  // From the add box's camera button.
  addCapPhotos(list){
    const files = [...list], big = this.tooBig(files);
    if (big) this.say(big, {place: 'cap', cls: 'failed'});
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
    } catch (e) { w?.close(); this.say('Couldn\'t open: ' + e.message, {place: ['sheet:files', 'step'], cls: 'failed'}); }
  },
};
