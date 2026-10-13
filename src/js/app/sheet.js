// A task's sheet: its details, labels and people, comments and attachments. What's done to the task is in actions.js.
import {cache, fmtSize, INLINE_TYPES, mimeOf, sizeLimit, taskDrafts, ZERO} from '../util.js';
import {allPages, api, errText, items, NetError} from '../api.js';
import {addDays, dueInfo, fmtTime, isSet, startOfDay} from '../dates.js';
import {htmlToText, sanitize, textToHtml} from '../html.js';
import {hasOwnOrder, hasTemplateLabel, notesOnly, stepInfos, stepsOf, templateName, templateTitle, withLinesOf} from '../checklists.js';
import {listViewOf, positionOrder} from '../order.js';
import {atTime} from '../quickadd.js';
import {notSaved} from '../messages.js';
import {inTextField, slideStarts, typedIn} from '../progress.js';
import {fileEntry, NO_ROOM, NOT_KEPT, randomId, sync} from '../sync.js';
import {plainReminders, reminderKey} from './actions.js';
import {blankSheet, shared} from './core.js';
import {sliding} from './progress.js';
import {seats, seatUnder} from './seat.js';
import {haptic} from '../haptics.js';

export let pendingSaves = 0;
// Notes written but not saved yet, kept on the phone: {text, base: what the notes said when editing began}. An older
// Pocket kept the text only.
const notesDraft = id => { const d = taskDrafts.get('desc:' + id); return d == null ? null : typeof d === 'string' ? {text: d, base: null} : d; };
const repeats = t => t.repeat_after > 0 || t.repeat_mode === 1;
let closeTimer;
let lastFocus;

export default {
  openSheet(kind){
    this.leaveTask();
    clearTimeout(closeTimer);
    const already = this.sheet.open && this.sheet.show, dirty = already && this.sheet.dirty;   // opening a subtask from its parent's sheet
    if (!already) lastFocus = document.activeElement;
    // A history entry so the phone's Back closes the sheet: a new one, or a closed sheet's used again.
    if (history.state?.sheet === 'closed') { history.replaceState({...history.state, sheet: true}, ''); shared.onClosedSheet = false; }
    else if (!history.state?.sheet) history.pushState({...(history.state || {}), sheet: true}, '');
    this.sheet = {...blankSheet(kind), open: true, show: already, dirty};
    this.picker = {open: false, loading: false, error: '', q: ''};
    const sh = document.getElementById('sheet');
    if (already) this.$nextTick(() => { sh.querySelector('.scroll').scrollTop = 0; });
    else this.$nextTick(() => { void sh.offsetHeight; this.sheet.show = true; });   // reflow so the slide-in animates
  },
  /* The ×, a slide down, the shade, Escape (escapeKey) and the phone's Back all come here. The question a ring asks,
     when asked from a task's sheet, goes back to that sheet, as Cancel does. `instant` (confirmed, or leaving for a
     screen) closes it outright. */
  closeSheet(instant){
    if (!this.sheet.open) return;
    if (!instant && this.sheet.kind === 'complete' && this.sheet.complete?.back) return this.cancelComplete();
    this.leaveTask();
    const dirty = this.sheet.dirty;
    this.sheet.show = false;
    const done = () => { this.sheet = blankSheet(''); this.picker.open = false; };
    clearTimeout(closeTimer);
    if (instant) done(); else closeTimer = setTimeout(done, 260);
    if (dirty && !instant) this.render();
    lastFocus?.focus?.();
    // Closed with ×, a swipe or Escape, the sheet's history entry is marked closed (see the popstate listener). A screen
    // opened from the sheet replaces the entry instead (go()).
    if (history.state?.sheet === true) { history.replaceState({...history.state, sheet: 'closed'}, ''); shared.onClosedSheet = true; shared.closedAt = location.href; }
  },
  /* Escape on a desktop closes the innermost thing first: the task's ⋯ menu, with the focus back on ⋯, then the sheet.
     A field being typed in takes Escape itself and stops it there (@keydown.escape.stop in the markup): it cancels a
     title or step being changed, or closes the label picker or the assign box. */
  escapeKey(){
    if (this.sheet.menu) { this.sheet.menu = false; document.getElementById('d-more')?.focus(); }
    else if (this.sheet.open) this.closeSheet();
  },
  /* Leaving a task's sheet, whether closed or for another task: save notes being changed, and keep a comment or
     subtasks being written for when the sheet opens again. Not again for a sheet already closing (a task opened again
     during its slide down): that was done as it closed. A title being changed is saved too. Its box saves when it loses
     the focus, which the × takes, but a sheet slid down or closed by the phone's Back doesn't take it, and on an iPhone
     a tap gives a button no focus either. saveTitle saves once, whichever comes first. */
  leaveTask(){
    const sh = this.sheet, t = sh.task;
    if (!sh.open || !sh.show || sh.kind !== 'task' || !t) return;
    if (sh.titleEdit || document.activeElement?.id === 'd-title') { this.saveTitle(); sh.titleEdit = false; }
    if (sh.editingDesc && sh.descDraft.trim() !== this.notesText(t).trim()) {
      const v = sh.descDraft, base = sh.descConflict ?? sh.descBase;
      sh.editingDesc = false; sh.dirty = true;
      taskDrafts.set('desc:' + t.id, {text: v, base});                       // kept until it's saved
      // Said on the task's row once the sheet has gone. If not saved, with Open, to see them.
      const row = {id: t.id, stays: true}, open = {label: 'Open', fn: () => this.openTask(t.id)};
      this.saveTask(t.id, null, now => this.notesPatch(now, v, base)).then(() => { taskDrafts.delete('desc:' + t.id); this.say('Notes saved', {row}); },
        e => this.say(e.notes !== undefined ? 'Notes not saved: they were changed elsewhere while you wrote. Yours are kept: open the task to see both.'
          : e instanceof NetError ? 'Notes not saved: no connection. They\'re kept on this phone: open the task to save them later.' : 'Notes not saved: ' + e.message + '. They\'re kept, to save later.',
          {row: {...row, cls: 'failed'}, action: open}));
    } else if (!sh.editingDesc) taskDrafts.delete('desc:' + t.id);
    for (const [k, v] of [['comment', sh.commentDraft], ['sub', sh.sub.text]]) taskDrafts.set(k + ':' + t.id, v);
  },
  /* The sheet slides down with a finger and closes if let go past 110px. slideStarts (progress.js) says where that may
     start: from the bar at its top (the grab, the task's number, ⋯ and ×), or from anywhere else when the sheet is
     scrolled to its top, but never from a text field, and not while a field is being typed in, since a pull down
     beside the field then only puts the keyboard away. This is decided as the finger goes down, so a slide under way
     carries on whatever takes the focus meanwhile. Not while a row is held or swiped (`sliding`), and called off when
     the phone takes the touch away. */
  initSwipe(){
    let y0 = null; const sh = this.$refs.sheet;
    sh.addEventListener('touchstart', e => {
      const at = document.activeElement;
      y0 = slideStarts({field: inTextField(e.target), bar: !!e.target.closest('.bar'), top: sh.querySelector('.scroll').scrollTop <= 0, typing: sh.contains(at) && typedIn(at)}) ? e.touches[0].clientY : null;
    }, {passive:true});
    sh.addEventListener('touchmove', e => { if (y0 !== null && sliding) { y0 = null; sh.style.transform = ''; } if (y0 === null) return; const dy = e.touches[0].clientY - y0; if (dy > 0) sh.style.transform = `translateY(${dy}px)`; }, {passive:true});
    sh.addEventListener('touchend', e => { if (y0 === null) return; const dy = e.changedTouches[0].clientY - y0; sh.style.transform = ''; y0 = null; if (dy > 110) this.closeSheet(); });
    // When the phone takes the touch away mid-slide (its own gesture from an edge, a call coming in), the sheet goes
    // back up, still open, rather than staying where the finger left it.
    sh.addEventListener('touchcancel', () => { if (y0 === null) return; y0 = null; sh.style.transform = ''; }, {passive:true});
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

  // Reuse the sheet's actions for a mouse or keyboard context menu. Text fields keep the browser's menu.
  rowMenu(t, e){
    if (inTextField(e.target) || t.pending || t.key || sliding || e.defaultPrevented) return;
    e.preventDefault(); e.stopPropagation();
    this.openTask(t.id, true);
  },
  async openTask(id, menu = false){
    const from = this.sheet.open && this.sheet.kind === 'task' ? this.sheet.task?.id : null;
    this.openSheet('task');
    this.sheet.menu = menu;
    this.sheet.from = from;
    this.sheet.commentDraft = taskDrafts.get('comment:' + id) || '';
    this.sheet.sub.text = taskDrafts.get('sub:' + id) || '';
    // Notes that couldn't be saved (offline, say) go back in the editor, to save again.
    const desc = notesDraft(id);
    if (desc) Object.assign(this.sheet, {editingDesc: true, descDraft: desc.text, descBase: desc.base, descUnsaved: true});
    this.sheet.addBox.text = (taskDrafts.get('addsteps:' + id) || []).map(r => r.text).filter(x => x?.trim()).join('\n');   // steps written under a template, not added yet
    const mine = this.sheet, cached = cache.get(id);
    if (cached) this.showTask(cached); else this.sheet.loading = true;
    try {
      // If the task was changed while this loaded, the save brings a newer copy, and the old one isn't put back.
      const t = await this.readTask(id);
      if (this.sheet !== mine) return;
      if (t) { cache.set(id, t); this.showTask(t); this.checkNotes(t); }
      this.loadComments(id); this.loadSubPeople(t || cached || {id}); this.loadSubOrder(t || cached);
    } catch (e) {
      if (!cached && this.sheet === mine) this.sheet.error = errText(e);
      else if (this.sheet === mine) { this.loadComments(id); this.loadSubPeople(cached); }   // offline, loadComments says so, and a comment can still be written
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
    // A repeating task needs a due date to move forward from. A done template's date doesn't count: given one, it comes
    // round, and is no longer done.
    const tpl = this.checklistRole === 'template';
    if (v !== 'none' && !isSet(this.dueShown)) {
      const d = atTime(new Date(), this.dueTime);
      patch.due_date = (d < new Date() ? addDays(d, 1) : d).toISOString();
      if (tpl) patch.done = false;
      // Say which date was picked, since it may surprise: the next time of day set as this person's default due time in Vikunja.
      const label = dueInfo(patch.due_date).label, when = /\d:\d\d/.test(label) ? label : label + ' ' + fmtTime(new Date(patch.due_date));
      this.say(`It repeats from ${when}: change the date above if that's not when.`, {place: 'sheet:due', ms: 8000});
    }
    this.save(patch);
  },
  // The due date the sheet shows: a template's is when it next comes round, so a done one has none.
  get dueShown(){ const t = this.sheet.task; return this.checklistRole === 'template' && t.done ? ZERO : t.due_date; },
  /* Set the due date from the sheet. A template's due date is when it comes round: given one, the template is left not
     done; taken off, it is done again. Its repeat is taken off first, then the date and done are saved (in one save
     with the repeat, Vikunja would move it on to its next time and leave it not done), then the repeat is put back, so
     a date given again comes round as before. */
  async setDue(v){
    const t = this.sheet.task;
    if (this.checklistRole !== 'template') return this.save({due_date: v});
    if (isSet(v)) return this.save({due_date: v, ...t.done && {done: false}});
    const rep = repeats(t) && {repeat_after: t.repeat_after, repeat_mode: t.repeat_mode};
    if (rep && await this.save({repeat_after: 0, repeat_mode: 0}) === false) return;
    if (await this.save({due_date: ZERO, done: true}) === false || !rep) return;
    return this.save(rep);
  },
  // The parent's title. For a template's step, the template's name without "TEMPLATE: ".
  get parentTitle(){ const p = this.parentTask; return p && (this.checklistRole === 'tplstep' ? templateName(p.title) : p.title); },
  /* The open task's subtasks, without those being deleted: a template's or a run's steps in their order line, and any
     other task's in its project's List view order once read (loadSubOrder) or moved, and until then in the order they
     were made. */
  get subtasks(){
    const t = this.sheet.task, hidden = this.hiddenRows;
    const subs = hasOwnOrder(t) ? stepsOf(t) : [...(t?.related_tasks?.subtask || [])].sort(positionOrder(this.positions));
    return subs.filter(s => !hidden.has(s.id));
  },
  /* Read where the open task's subtasks sit in its project's List view, by asking the view for the task and its
     subtasks. The view gives a task's subtasks, done ones too, while the task itself isn't done. Once read, they can be
     moved (subView). */
  async loadSubOrder(t){
    const subs = t?.related_tasks?.subtask || [], lv = listViewOf(this.projById.get(t?.project_id));
    if (!subs.length || hasOwnOrder(t) || !lv) return;
    try {
      const filter = 'id in ' + [t.id, ...subs.map(s => s.id)].join(', ');
      const got = await allPages(`/projects/${t.project_id}/views/${lv.id}/tasks?` + new URLSearchParams({filter, expand: 'subtasks'}));
      if (this.sheet.task?.id !== t.id) return;
      for (const x of got) this.positions[x.id] = x.position || 0;
      this.sheet.subView = lv.id;
    } catch {}                                                              // left in the order they were made
  },
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

  /* Save a change to the open task. The sheet updates right away, and the server's copy is applied once no other saves
     are queued. If the save fails, the change is undone and the top of the sheet says so, with Try again. Resolves to
     false then. */
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
  // Tapping the title on the sheet's leading row opens a box in its place to change it (task-row.html, g.own), saved
  // when the box is left (saveTitle). Not for a task shared read only.
  editTitle(){ if (this.canEdit) { this.sheet.title = this.rowTitle(this.sheet.task); this.sheet.titleEdit = true; } },
  // Save the title. A template's keeps "TEMPLATE: " before it. If it is unchanged or emptied, the box shows the task's
  // title again. (The box may lose the focus only as its sheet goes, with no task left to save.)
  saveTitle(){
    const t = this.sheet.task, v = (this.sheet.title || '').trim();
    if (!t) return;
    if (v && v !== this.rowTitle(t)) this.save({title: hasTemplateLabel(t) ? templateTitle(v) : v}); else this.sheet.title = this.rowTitle(t);
  },
  // The notes as text, and as saved. Pocket's own lines in the description (a template's order, a run's) are left out
  // while the notes are edited, and kept. The notes are saved with the lines Vikunja has at that moment (`t`, read
  // then), so a step moved elsewhere meanwhile stays moved.
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
  /* The notes to save, built on Vikunja's copy as it is when they are sent (`now`). If its notes changed since editing
     began (`base`; null means unknown, from an older Pocket), they aren't written over unseen: the error carries them
     (notes) and Vikunja's copy (now). */
  notesPatch(now, text, base){
    const has = this.notesText(now).trim();
    if (base !== null && base !== undefined && has !== base.trim() && has !== text.trim())
      throw Object.assign(new Error('the notes were changed elsewhere while you wrote'), {notes: has, now});
    return {description: this.notesHtml(now, text)};
  },
  // Notes kept on the phone and opened again: if Vikunja's have changed since editing began, both are shown.
  checkNotes(t){
    const sh = this.sheet, has = this.notesText(t).trim();
    if (sh.editingDesc && sh.descBase !== null && sh.descBase !== undefined && has !== sh.descBase.trim() && has !== sh.descDraft.trim()) sh.descConflict = has;
  },
  /* Save the notes. If they can't be saved (offline, say), they stay in the editor, and on the phone, to save later. If
     they were changed elsewhere meanwhile, Vikunja's are shown under them, and saving again replaces those, once seen. */
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
      // Said under the notes, which stay in the box.
      this.say(seen !== null ? 'Not saved: the notes were changed elsewhere while you wrote. Both are shown: save again to replace them with yours.'
        : notSaved(e), {place: 'sheet:notes', cls: 'failed', ms: null});
    }
  },

  /* ---------- reminders ---------- */
  // Whether Vikunja's reminders reach this person: it sends them by email, if the server has that on and so do they.
  get remindersReach(){ return !!this.info?.email_reminders_enabled && !!this.user?.settings?.email_reminders_enabled; },
  get remindersNote(){
    if (this.remindersReach) return '';
    return 'Vikunja sends reminders by email, and ' + (this.info?.email_reminders_enabled ? 'yours are turned off in your Vikunja settings.' : 'this server doesn\'t send them.');
  },
  // A reminder in words: "At due", "15 min before due", or when it goes off. One counted from a date the task doesn't have says so.
  reminderText(r){
    // At a set time: its day and time, even at noon or midnight, and whether it is past.
    if (!r.relative_to) { const d = new Date(r.reminder); return isSet(r.reminder) ? `${dueInfo(startOfDay(d).toISOString()).label} ${fmtTime(d)}${d < new Date() ? ' (past)' : ''}` : ''; }
    const s = Math.abs(r.relative_period || 0), from = {due_date: 'due', start_date: 'the start', end_date: 'the end'}[r.relative_to] || r.relative_to;
    const unset = !isSet(this.sheet.task?.[r.relative_to]) ? ' (no date: it won\'t go off)' : '';
    if (!s) return (r.relative_to === 'due_date' ? 'At due' : 'At ' + from) + unset;
    const [n, unit] = [[86400, 'day'], [3600, 'hour'], [60, 'min']].find(([n]) => s % n === 0 && s >= n) || [1, 'sec'];
    const k = s / n;
    return `${k} ${unit}${k === 1 || unit === 'min' || unit === 'sec' ? '' : 's'} ${r.relative_period < 0 ? 'before' : 'after'} ${from}${unset}`;
  },
  // Reminders that can be added: counted back from the due date, so they move with it, when there is one; or a set date and time.
  get reminderPresets(){
    const t = this.sheet.task, have = new Set((t?.reminders || []).filter(r => r.relative_to === 'due_date').map(r => r.relative_period || 0));
    const before = isSet(t?.due_date) ? [[0, 'At due'], [-900, '15 min before due'], [-3600, '1 hour before due'], [-86400, '1 day before due']] : [];
    return [...before.filter(([p]) => !have.has(p)).map(([p, label]) => ({value: String(p), label})), {value: 'at', label: 'At a set date and time…'}];
  },
  addReminder(v){
    if (v === 'at') { this.sheet.remindAt = true; this.$nextTick(() => { const el = document.getElementById('d-remind-at'); el?.focus(); try { el?.showPicker(); } catch {} }); }
    else if (v) this.changeReminders({relative_to: 'due_date', relative_period: +v}, null);
  },
  /* A tap anywhere on one of the sheet's label-and-value rows (Due, Reminders, Labels, Assigned) works its control,
     marked data-tap: a date's picker, a select's list (or where the phone can't open one from here, the select is
     focused), or the row's Add. A tap on a control, or on a button in the row (a date's ×, a chip's ×), is its own. The
     control stays the one Tab stop. The row isn't a second. Repeats and Project don't need this: their select lies
     over the whole row (.prop.sel). */
  propTap(e){
    const el = e.currentTarget.querySelector('[data-tap]');
    if (!el || el.disabled || e.target.closest('button, a, input, select, textarea, label, form')) return;
    if (el.tagName === 'BUTTON') { el.click(); return; }
    el.focus();
    try { el.showPicker(); } catch {}
  },
  addReminderAt(v){ this.sheet.remindAt = false; if (v) this.changeReminders({reminder: new Date(v).toISOString()}, null); },
  removeReminder(k){ const r = plainReminders(this.sheet.task)[k]; if (r) this.changeReminders(null, r); },
  // Add a reminder or take one out, among those Vikunja has when the save is sent, so one added or removed elsewhere
  // since the sheet opened stays that way.
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
  // Enter in the label picker adds the label at the top of the list (the one with that exact name, if there is one), else a new one.
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
  // Assign the person tapped in the suggestions, or on Enter, the username typed (or the first suggestion). The box
  // stays open for the next one, until Done.
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
  // A comment goes through the outbox, as a note on a run does: without a connection it waits and is posted later.
  async postComment(){
    const id = this.sheet.task.id, v = this.sheet.commentDraft.trim(); if (!v) return;
    this.sheet.commentDraft = ''; taskDrafts.delete('comment:' + id);
    const r = await this.act({op: 'note', task: id, html: textToHtml(v), run: null});
    if (r.status === 'offline') this.say(r.reached ? 'Vikunja had a problem with the comment. Pocket tries again shortly.' : 'Saved offline. The comment is posted when you\'re back online.', {place: 'sheet:comments'});
    if (r.status === 'error' && this.sheet.task?.id === id) this.sheet.commentDraft = v;
  },
  // Comments on the open task still waiting to be posted.
  get pendingComments(){ return this.pending.filter(e => e.kind === 'act' && e.op === 'note' && e.task === this.sheet.task?.id && !e.run); },
  get attachmentsOn(){ return this.info?.task_attachments_enabled !== false; },
  // Which of these files this Vikunja won't take, said plainly, or '' when they all fit. Vikunja's own message gives
  // the wrong limit.
  tooBig(files){
    const max = sizeLimit(this.info?.max_file_size), big = max ? files.filter(f => f.size > max) : [];
    return big.length ? `${big.map(f => `${f.name} (${fmtSize(f.size)})`).join(', ')} ${big.length === 1 ? 'is' : 'are'} too big: your Vikunja takes files up to ${this.info.max_file_size}.` : '';
  },
  // From the sheet's "Add a photo or file". The files go through the outbox, so without a connection they wait on the
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
  // A blob: URL runs with this app's origin, so an HTML or SVG attachment opened that way could read the saved token.
  // Only types that can't run script open in a tab. Everything else is downloaded.
  async openAttachment(a, taskId = this.sheet.task.id){
    const inline = INLINE_TYPES.test(mimeOf(a.file?.mime));
    const w = inline ? window.open('', '_blank') : null;   // opened synchronously so iOS doesn't block it
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
  /* ---------- the sheet's list, and its box under a row ---------- */
  /* The sheet's list (sheet/sub-list.html): the open task's subtasks, a template's steps, or in New template the steps
     written so far, which aren't in Vikunja yet (checklists.js). One list, drawn by the task row, with one box at its
     foot (`subBoxW`, as box() names it: 'sub' for a task, 'add:+' for a template, 'new:+' for New template). */
  get subList(){ return this.sheet.kind === 'newtpl' ? this.sheet.newTpl?.rows || [] : this.sheet.kind === 'task' ? this.subtasks : []; },
  get isStepList(){ return this.sheet.kind === 'newtpl' || this.checklistRole === 'template'; },
  get subBoxW(){
    if (this.sheet.kind === 'newtpl') return 'new:+';
    if (this.sheet.kind !== 'task' || !this.canEdit || this.checklistRole === 'run') return '';
    return this.checklistRole === 'template' ? 'add:+' : 'sub';
  },
  // Whether the box's button adds anything: for subtasks, a line with a title; for steps, nothing wrong in them and none on its way.
  get subBoxCan(){
    const w = this.subBoxW;
    if (!w) return false;
    if (w === 'sub') return this.boxParsedLines('sub').some(p => p.title);
    return !this.sheet.subBusy && !!(this.box(w).text || '').trim() && !this.draft(this.stepWhich).info.get('+')?.problem;
  },
  /* A step as its row has it (task-row.html, g.step): its index among the steps, its number, and how it reads. A step
     written in New template (it has a `key`) reads together with the rows there (draft), with the box's own line
     counted where the box is. */
  stepAt(t){ return this.subList.findIndex(s => s.id === t.id); },
  stepNo(t){ return (t.key ? this.draft('new').info.get(t.key)?.i ?? this.stepAt(t) : this.stepAt(t)) + 1; },
  stepShown(t){
    if (!t.key) return this.templateSteps[this.stepAt(t)] || {title: t.title};
    const d = this.draft('new'), info = d.info.get(t.key), s = info && stepInfos(d.added)[info.i];
    // The title reads as a saved step's does: without the @people, *labels and !priority that quick add will take when
    // the step is created, but with the words of a chip tapped off (t.ignore), which stay in the title.
    const title = text => this.stepParsed(text, t.ignore).title || text;
    return s ? {...s, title: title(s.title), problem: info.problem || s.problem} : {title: title(t.text), text: '', problem: ''};
  },
  /* The add box at a list's foot (markup/list-box.html), by where the list is: 'sheet' (a task's subtasks, a template's
     steps, or New template's) or 'run' (a checklist's steps on its screen). Returns the box's name as box() has it, its
     ids, what it says, whether it is under a row, whether its button adds anything, and on a checklist the step Repeat
     would copy. `rest` is what it says at the foot, which its place there shows while the box is under a row. Null
     where there is no box (a checklist finished, or shared read only). */
  footBox(where){
    if (where === 'run') {
      const a = this.runAim;
      if (!a) return null;
      const under = this.runBoxAt != null;
      const rest = 'Add steps, or paste a list';
      return {w: 'ins', id: 'run-box', in: 'run-in', under, steps: false, can: this.boxParsedLines('ins').some(p => p.title), repeat: {title: a.on.title, can: !a.on.pending},
        says: under ? 'Step' : rest, rest, add: 'Add steps', home: 'Add after the last step instead'};
    }
    const w = this.subBoxW;
    if (!w) return null;
    const steps = this.isStepList, under = this.sheet.subAt != null, rest = steps ? 'Add steps, or paste a list' : 'Add subtasks, or paste a list';
    return {w, id: 'd-subbox', in: 'd-subin', under, steps, can: this.subBoxCan, repeat: null, says: under ? (steps ? 'Step' : 'Subtask') : rest, rest,
      add: steps ? 'Add steps' : 'Add subtasks', home: steps ? 'Add after the last step instead' : 'Add after the last subtask instead'};
  },
  /* A nudge on a row of a list (watchNudges, progress.js) puts the list's box under that row, to add after it: in a
     sheet, sheet.subAt; on a checklist's screen, runBoxAt. The box is laid over room given to the row, never taken off
     the page, and its place at the foot stays, dashed. A tap there, or its row scrolled out of sight while the box
     isn't being typed in, puts it back. Nudging the row the box is already under changes nothing. seatFoot asks where
     the row is as frames go by, the same way seatBox (quickadd.js) does for a list's box: both through seat.js. */
  nudgedSub(id){
    const s = this.subList.find(x => String(x.id) === String(id));
    // A template's steps are done tasks, so done doesn't rule them out. Not while a step is being changed: its box is in the way.
    if (!s || (s.done && !this.isStepList) || !this.subBoxW || this.sheet.stepEdit) return;
    const at = this.underRow('#d-subtasks', s.id);
    if (String(this.sheet.subAt ?? '') !== String(at ?? '')) haptic('tick');
    this.sheet.subAt = at; this.sheet.subAfter = null;
    this.$nextTick(() => this.seatFoot('sheet'));
  },
  // A checklist's step nudged on its screen (nudged, quickadd.js, which also puts the box on the card).
  nudgedStep(s){ this.runBoxAt = this.underRow('#run-steps', s.id); this.$nextTick(() => this.seatFoot('run')); },
  // Where the box goes for a row nudged in list `sel`: under it, by id, or at the foot (null) when it is the last row.
  underRow(sel, id){ return [...document.querySelectorAll(sel + ' > .row[data-id]')].at(-1)?.dataset.id === String(id) ? null : id; },
  footHome(where){
    if (where === 'run') this.runBoxAt = null; else { this.sheet.subAt = null; this.sheet.subAfter = null; }
    this.seatFoot(where);
  },
  seatFoot(where){
    const run = where === 'run', list = run ? '#run-steps' : '#d-subtasks', boxId = run ? 'run-box' : 'd-subbox';
    // What's in sight of the list: the screen, or the sheet's own scroller.
    const sight = () => run ? {top: 0, bottom: innerHeight} : document.getElementById('sheet-body')?.getBoundingClientRect() || {top: 0, bottom: innerHeight};
    // Whether a row comes after `el` in the list. With none, the box under it is the box at the foot.
    const later = el => { for (let n = el.nextElementSibling; n; n = n.nextElementSibling) if (n.matches('.row[data-id]')) return true; return false; };
    // The row the box is under, as the page has it. A step added a moment ago is known by its entry until it is in Vikunja.
    const at = () => run ? (this.route.name === 'run' && this.runBoxAt != null ? this.actTask({task: this.runBoxAt}) : null) : this.sheet.open ? this.sheet.subAt : null;
    const foot = () => { if (run) this.runBoxAt = null; else { this.sheet.subAt = null; this.sheet.subAfter = null; } };
    seatUnder(seats[where], {
      box: () => document.getElementById(boxId), cls: 'sub-boxed', prop: () => [document.getElementById(boxId).parentElement, '--sub-h'], sight,
      // The row isn't drawn yet: a row just added is a frame or two away, so wait. One gone for a second is lost. One
      // that is now last (just added at the end, or the rows after it deleted) sends the box to the foot.
      row: () => {
        const id = at();
        if (id == null) return null;
        const el = document.querySelector(`${list} > .row[data-id="${id}"]`);
        if (!el) return undefined;
        if (!later(el)) { foot(); return null; }
        return el;
      },
      lost: foot, home: () => this.footHome(where),
      place: (b, el) => el.offsetTop + el.offsetHeight + 'px',
      apply: (b, top) => { b.style.top = top; }, unplace: b => { if (b) b.style.top = ''; },
      scrollBack: h => { if (run) scrollBy(0, -h); else document.getElementById('sheet-body').scrollTop -= h; },
    });
  },
};
