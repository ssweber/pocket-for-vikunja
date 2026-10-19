// A task's sheet: its details, labels and people, comments and attachments. What's done to the task is in actions.js.
import { fmtSize, INLINE_TYPES, mimeOf, sizeLimit, taskDrafts, ZERO } from '../util.js';
import { allPages, api, errText, items, NetError } from '../api.js';
import { addDays, dueInfo, fmtTime, isSet, plainReminders, startOfDay } from '../dates.js';
import { sanitize, textToHtml } from '../html.js';
import { notesOnly, stepInfos, stepsOf, templateName, templateTitle } from '../checklists.js';
import { listViewOf, positionOrder } from '../order.js';
import { atTime } from '../quickadd.js';
import { inTextField, slideStarts, typedIn } from '../progress.js';
import { fileEntry, randomId, sync } from '../sync.js';
import { couldnt, NOT_KEPT, notDone, noUser, OPEN, repeatDate, SAID, tooBigText, waitText } from '../messages.js';
import { blankSheet, shared } from './core.js';
import { sliding } from './progress.js';
import { seats, seatUnder } from './seat.js';
import { copyOf } from './tasks.js';
import { notesText, sheetPlaceOf, waitingComments } from '../ops/index.js';
import { haptic } from '../haptics.js';

// The sheet's latest edit. The outbox sends a task's edits in order, so only the latest says Saved.
let lastEdit = null;
// Notes written but not saved yet, kept on the phone as {text, base}. `base` is what the notes said when editing began.
// An older Pocket kept only the text.
const notesDraft = id => {
  const d = taskDrafts.get('desc:' + id);
  return d == null ? null : typeof d === 'string' ? { text: d, base: null } : d;
};
let closeTimer;
let lastFocus;

export default {
  openSheet(kind) {
    this.leaveTask();
    clearTimeout(closeTimer);
    const already = this.sheet.open && this.sheet.show,
      dirty = already && this.sheet.dirty; // opening a subtask from its parent's sheet
    if (!already) lastFocus = document.activeElement;
    // Give the sheet a history entry so the phone's Back closes it. Reuse a closed sheet's entry, or add a new one.
    if (history.state?.sheet === 'closed') {
      history.replaceState({ ...history.state, sheet: true }, '');
      shared.onClosedSheet = false;
    } else if (!history.state?.sheet) history.pushState({ ...(history.state || {}), sheet: true }, '');
    this.sheet = { ...blankSheet(kind), open: true, show: already, dirty };
    this.picker = { open: false, loading: false, error: '', q: '' };
    const sh = document.getElementById('sheet');
    if (already)
      this.$nextTick(() => {
        sh.querySelector('.scroll').scrollTop = 0;
      });
    else
      this.$nextTick(() => {
        void sh.offsetHeight;
        this.sheet.show = true;
      }); // reflow so the slide-in animates
  },
  /* The ×, sliding the sheet down, the shade, Escape (escapeKey) and the phone's Back all close the sheet here. If the
     sheet is the question a ring asks and it was opened from a task's sheet, closing it returns to that task's sheet,
     as Cancel does. `instant` closes the sheet with no slide. It is used when the question is confirmed or when Pocket
     leaves for another screen. */
  closeSheet(instant) {
    if (!this.sheet.open) return;
    if (!instant && this.sheet.kind === 'complete' && this.sheet.complete?.back) return this.cancelComplete();
    this.leaveTask();
    const dirty = this.sheet.dirty;
    this.sheet.show = false;
    const done = () => {
      this.sheet = blankSheet('');
      this.picker.open = false;
    };
    clearTimeout(closeTimer);
    if (instant) done();
    else closeTimer = setTimeout(done, 260);
    if (dirty && !instant) this.render();
    lastFocus?.focus?.();
    // When the sheet is closed with ×, a swipe or Escape, its history entry is marked closed (see the popstate listener
    // in core.js). A screen opened from the sheet replaces the entry instead (go()).
    if (history.state?.sheet === true) {
      history.replaceState({ ...history.state, sheet: 'closed' }, '');
      shared.onClosedSheet = true;
      shared.closedAt = location.href;
    }
  },
  /* On a desktop, Escape closes the innermost thing first. That is the task's ⋯ menu (the focus returns to ⋯), then the
     sheet. A field being typed in handles Escape itself and stops it (@keydown.escape.stop in the markup). Then Escape
     cancels a title or step edit, or closes the label picker or the assign box. */
  escapeKey() {
    if (this.sheet.menu) {
      this.sheet.menu = false;
      document.getElementById('d-more')?.focus();
    } else if (this.sheet.open) this.closeSheet();
  },
  // Whether task `id`'s sheet is on screen. A closing sheet stays open while it slides down (closeSheet), and what is
  // said then belongs on the task's row.
  sheetShows(id) {
    return this.sheet.open && this.sheet.show && this.sheet.kind === 'task' && this.sheet.id === id;
  },
  /* Runs when the user leaves a task's sheet, whether it closes or another task opens. It saves notes being edited. It
     also keeps a comment or subtasks being written, for when the sheet opens again. It does nothing for a sheet that is
     already closing (a task opened again during the slide down), because the first call did the work.
     It saves a title being edited too. The title box saves when it loses focus, and tapping × takes the focus. Sliding
     the sheet down or pressing the phone's Back does not take it, and on an iPhone tapping a button doesn't focus the
     button either. saveTitle saves once, whichever comes first. */
  leaveTask() {
    const sh = this.sheet,
      t = this.sheetTask;
    if (!sh.open || !sh.show || sh.kind !== 'task' || !t) return;
    if (sh.titleEdit || document.activeElement?.id === 'd-title') {
      this.saveTitle();
      sh.titleEdit = false;
    }
    if (sh.editingDesc && sh.descDraft.trim() !== this.notesText(t).trim()) {
      const v = sh.descDraft,
        base = sh.descConflict ?? sh.descBase;
      sh.editingDesc = false;
      sh.dirty = true;
      // The message appears on the task's row once the sheet has closed. Notes changed elsewhere meanwhile come back to
      // the phone (notesRefused).
      taskDrafts.delete('desc:' + t.id);
      this.act({ op: 'edit', task: t.id, run: null, rebase: 'notes', text: v, base }).then(r => {
        if (r.status === 'sent') this.say(SAID.notesSaved, { row: { id: t.id, stays: true } });
      });
    } else if (!sh.editingDesc) taskDrafts.delete('desc:' + t.id);
    for (const [k, v] of [
      ['comment', sh.commentDraft],
      ['sub', sh.sub.text],
    ])
      taskDrafts.set(k + ':' + t.id, v);
  },
  /* The sheet follows a downward drag and closes if the user releases it past 110px. slideStarts (progress.js) decides
     where a slide may start. It may start on the bar at the top (the grab, the task's number, ⋯ and ×), or anywhere
     else when the sheet is scrolled to its top. It never starts in a text field. It does not start while a field is
     being typed in, because a pull down beside the field then only hides the keyboard.
     This is decided when the touch begins, so a slide under way carries on whatever takes the focus meanwhile. A slide
     stops if a row is held or swiped (`sliding`), and is cancelled when the phone takes the touch away. */
  initSwipe() {
    let y0 = null;
    const sh = this.$refs.sheet;
    sh.addEventListener(
      'touchstart',
      e => {
        const at = document.activeElement;
        y0 = slideStarts({
          field: inTextField(e.target),
          bar: !!e.target.closest('.bar'),
          top: sh.querySelector('.scroll').scrollTop <= 0,
          typing: sh.contains(at) && typedIn(at),
        })
          ? e.touches[0].clientY
          : null;
      },
      { passive: true },
    );
    sh.addEventListener(
      'touchmove',
      e => {
        if (y0 !== null && sliding) {
          y0 = null;
          sh.style.transform = '';
        }
        if (y0 === null) return;
        const dy = e.touches[0].clientY - y0;
        if (dy > 0) sh.style.transform = `translateY(${dy}px)`;
      },
      { passive: true },
    );
    sh.addEventListener('touchend', e => {
      if (y0 === null) return;
      const dy = e.changedTouches[0].clientY - y0;
      sh.style.transform = '';
      y0 = null;
      if (dy > 110) this.closeSheet();
    });
    // If the phone takes the touch away mid-slide (its own gesture from an edge, a call coming in), the sheet returns
    // to its place, still open, instead of staying where the touch left it.
    sh.addEventListener(
      'touchcancel',
      () => {
        if (y0 === null) return;
        y0 = null;
        sh.style.transform = '';
      },
      { passive: true },
    );
  },
  // The header slides away once the list has scrolled down past it, and comes back as soon as it scrolls up a little.
  initHeader() {
    let anchor = scrollY; // the scroll position where the scroll direction last changed
    addEventListener(
      'scroll',
      () => {
        const y = scrollY;
        if (y <= this.$refs.header.offsetHeight || this.route.name === 'search') {
          this.headerTucked = false;
          anchor = y;
          return;
        }
        const tucked = this.headerTucked;
        if (tucked ? y < anchor - 12 : y > anchor + 12) {
          this.headerTucked = !tucked;
          anchor = y;
        } else if (tucked ? y > anchor : y < anchor) anchor = y;
      },
      { passive: true },
    );
  },
  openAccount() {
    this.openSheet('account');
  },

  // Reuse the sheet's actions for a mouse or keyboard context menu. Text fields keep the browser's menu.
  rowMenu(t, e) {
    if (inTextField(e.target) || t.pending || t.key || sliding || e.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation();
    this.openTask(t.id, true);
  },
  async openTask(id, menu = false) {
    const from = this.sheet.open && this.sheet.kind === 'task' ? this.sheet.id : null;
    this.openSheet('task');
    this.sheet.menu = menu;
    this.sheet.from = from;
    this.sheet.commentDraft = taskDrafts.get('comment:' + id) || '';
    this.sheet.sub.text = taskDrafts.get('sub:' + id) || '';
    // Notes that couldn't be saved (for example, offline) go back into the editor so the user can save them again.
    const desc = notesDraft(id);
    if (desc)
      Object.assign(this.sheet, { editingDesc: true, descDraft: desc.text, descBase: desc.base, descUnsaved: true });
    this.sheet.addBox.text = (taskDrafts.get('addsteps:' + id) || [])
      .map(r => r.text)
      .filter(x => x?.trim())
      .join('\n'); // steps typed under a template and not added yet
    const mine = this.sheet,
      cached = copyOf(id);
    if (cached) this.showTask(cached);
    else this.sheet.loading = true;
    try {
      // If the task was changed while this loaded, Vikunja's copy keeps the newer answer (read).
      const t = await this.readCopy(id);
      if (this.sheet !== mine) return;
      if (t) {
        this.showTask(t);
        this.checkNotes(t);
      }
      this.loadComments(id);
      this.loadSubPeople(t || cached || { id });
      this.loadSubOrder(t || cached);
    } catch (e) {
      if (!cached && this.sheet === mine) this.sheet.error = errText(e);
      else if (this.sheet === mine) {
        this.loadComments(id);
        this.loadSubPeople(cached);
      } // offline: loadComments shows a message, and the user can still write a comment
    } finally {
      if (this.sheet === mine) this.sheet.loading = false;
    }
  },
  // Show task `t` in the sheet. The sheet reads its row, and a task opened from search, a link or a card gets one here,
  // as each of its subtasks does (subRows).
  showTask(t) {
    const row = this.row(t);
    this.subRows(row);
    this.sheet.id = t.id;
    this.keepTemplate(row);
    if (document.activeElement?.id !== 'd-title') this.sheet.title = this.rowTitle(row);
  },
  /* Repeat settings as Vikunja stores them: repeat_mode 1 is monthly, otherwise repeat_after is an interval in seconds. */
  get repeatValue() {
    const t = this.sheetTask;
    if (!t) return 'none';
    if (t.repeat_mode === 1) return 'month';
    return { 0: 'none', 86400: 'day', 604800: 'week', 1209600: '2weeks' }[t.repeat_after || 0] || 'custom';
  },
  get repeatOptions() {
    const opts = [
      { value: 'none', label: 'Doesn’t repeat' },
      { value: 'day', label: 'Every day' },
      { value: 'week', label: 'Every week' },
      { value: '2weeks', label: 'Every 2 weeks' },
      { value: 'month', label: 'Every month' },
    ];
    if (this.repeatValue === 'custom') {
      const days = this.sheetTask.repeat_after / 86400;
      opts.push({ value: 'custom', label: Number.isInteger(days) ? `Every ${days} days` : 'Custom (set in Vikunja)' });
    }
    return opts;
  },
  // Change how the task repeats, as a `repeat` op. The sheet and the task's rows show it at once, online or offline.
  setRepeat(v) {
    if (v === 'custom') return;
    const t = this.sheetTask,
      set =
        v === 'month'
          ? { repeat_mode: 1, repeat_after: 0 }
          : { repeat_mode: 0, repeat_after: { none: 0, day: 86400, week: 604800, '2weeks': 1209600 }[v] };
    // A repeating task needs a due date to move forward from. A done template shows no due date (dueShown). Giving it
    // a date makes it repeat, so it is no longer done.
    if (v !== 'none' && !isSet(this.dueShown)) {
      const d = atTime(new Date(), this.dueTime);
      set.due_date = (d < new Date() ? addDays(d, 1) : d).toISOString();
      if (this.checklistRole === 'template') set.done = false;
      // Tell the user which date was set, since it may surprise them. It is the next occurrence of the default due time
      // set in Vikunja.
      const label = dueInfo(set.due_date).label,
        when = /\d:\d\d/.test(label) ? label : label + ' ' + fmtTime(new Date(set.due_date));
      this.say(repeatDate(when), { place: 'sheet:due', ms: 8000 });
    }
    this.sheet.dirty = true;
    return this.act({
      op: 'repeat',
      task: t.id,
      set,
      was: Object.fromEntries(Object.keys(set).map(k => [k, t[k]])),
      run: null,
    });
  },
  // The due date the sheet shows. A template's due date is when it next repeats, so a done template has none.
  get dueShown() {
    const t = this.sheetTask;
    return this.checklistRole === 'template' && t.done ? ZERO : t.due_date;
  },
  /* Set the due date from the sheet, as a `due` op, which the sheet and the task's rows show at once. A template's due
     date is when it repeats. Giving a template a date leaves it not done, and removing the date makes it done again,
     with the repeat Vikunja has kept (ops/dates.js). */
  setDue(v) {
    const t = this.sheetTask,
      f = { op: 'due', task: t.id, was: this.dueShown, due: v, run: null };
    if (this.checklistRole === 'template')
      Object.assign(f, { tpl: true }, isSet(v) ? t.done && { done: false } : { done: true });
    this.sheet.dirty = true;
    return this.act(f);
  },
  // The parent's title. For a template's step, the template's name without "TEMPLATE: ".
  get parentTitle() {
    const p = this.parentTask;
    return p && (this.checklistRole === 'tplstep' ? templateName(p.title) : p.title);
  },
  /* The open task's subtasks as their own rows show them (subRow), without those being deleted. A template's or
     checklist's steps are in the order of the order line. Any other task's subtasks are in its project's List view
     order once that is read (loadSubOrder) or after a move, and until then in the order they were made. */
  get subtasks() {
    const t = this.sheetTask,
      hidden = this.hiddenRows;
    const subs = this.hasOwnOrder(t)
      ? stepsOf(t)
      : [...(t?.related_tasks?.subtask || [])].sort(positionOrder(this.positions));
    return subs.filter(s => !hidden.has(s.id)).map(s => this.subRow(s));
  },
  /* Read the positions of the open task's subtasks in its project's List view. The request asks the view for the task
     and its subtasks together, because the view returns a task's subtasks, done ones included, only while the task
     itself isn't done. Once the positions are read, the subtasks can be moved (subView). */
  async loadSubOrder(t) {
    const subs = t?.related_tasks?.subtask || [],
      lv = listViewOf(this.projById.get(t?.project_id));
    if (!subs.length || this.hasOwnOrder(t) || !lv) return;
    try {
      const filter = 'id in ' + [t.id, ...subs.map(s => s.id)].join(', ');
      const got = await allPages(
        `/projects/${t.project_id}/views/${lv.id}/tasks?` + new URLSearchParams({ filter, expand: 'subtasks' }),
      );
      if (this.sheet.id !== t.id) return;
      for (const x of got) this.positions[x.id] = x.position || 0;
      this.sheet.subView = lv.id;
    } catch {} // the subtasks stay in the order they were made
  },
  // A template's steps as its sheet and the start sheet show them. Each shows when it is due, or what is wrong with it.
  get templateSteps() {
    return stepInfos(this.subtasks.map(s => s.title));
  },
  get startSteps() {
    return stepInfos((this.sheet.start?.steps || []).map(s => s.title));
  },
  get parentTask() {
    return this.sheetTask?.related_tasks?.parenttask?.[0] || null;
  },
  // Subtasks of the open task still waiting to be sent, for its sheet.
  get pendingSubtasks() {
    const id = this.sheet.id;
    return id == null ? [] : this.pendingTasks.filter(t => t.parent === id);
  },
  get descHtml() {
    const d = notesOnly(this.sheetTask?.description)
      .replace(/<p>\s*<\/p>/g, '')
      .trim();
    return d ? sanitize(d) : '<span class="ph">Add notes</span>';
  },

  /* Change the open task's own fields as an `edit` op (ops/edit.js), which the sheet and the task's rows show at once.
     Once Vikunja has it, the sheet says Saved, for the latest edit only. Offline it waits in the Outbox. A change
     Vikunja refuses goes back and waits there too, and the sender says so beside the field. */
  async sendEdit(fields) {
    const id = this.sheet.id;
    if (!id) return;
    const mine = (lastEdit = {});
    Object.assign(this.sheet, { savedMsg: 'Saving…', dirty: true });
    const r = await this.act({ op: 'edit', task: id, run: null, ...fields });
    if (mine !== lastEdit || this.sheet.id !== id) return r;
    this.sheet.savedMsg = r.status === 'sent' ? 'Saved' : '';
    if (r.status === 'sent') {
      this.unsay(sheetPlaceOf({ op: 'edit', ...fields })); // the message from an earlier refused edit
      setTimeout(() => {
        if (this.sheet.savedMsg === 'Saved') this.sheet.savedMsg = '';
      }, 1500);
    }
    return r;
  },
  setPriority(n) {
    const t = this.sheetTask;
    return t && this.sendEdit({ set: { priority: n }, was: { priority: t.priority || 0 } });
  },
  // Tapping the title on the sheet's first row replaces it with a box to edit it (task-row.html, g.own). The title is
  // saved when the box loses focus (saveTitle). A read-only task can't be edited.
  editTitle() {
    if (this.canEdit) {
      this.sheet.title = this.rowTitle(this.sheetTask);
      this.sheet.titleEdit = true;
    }
  },
  // Save the title. A template's title keeps its "TEMPLATE: " prefix. If the title is unchanged or empty, the box shows
  // the task's title again. The box can lose focus just as the sheet closes, when there is no task left to save.
  saveTitle() {
    const t = this.sheetTask,
      v = (this.sheet.title || '').trim();
    if (!t) return;
    if (v && v !== this.rowTitle(t))
      this.sendEdit({ set: { title: this.role(t) === 'template' ? templateTitle(v) : v }, was: { title: t.title } });
    else this.sheet.title = this.rowTitle(t);
  },
  // The notes as text. The description also holds Pocket's own lines, such as a template's order line. They are left
  // out while the notes are edited, and kept when the notes are saved (ops/edit.js).
  notesText(t) {
    return notesText(t);
  },
  // Remember what the notes say when editing starts (descBase), so a save can tell if they changed elsewhere since.
  editDesc() {
    Object.assign(this.sheet, {
      descDraft: this.notesText(this.sheetTask),
      descBase: this.notesText(this.sheetTask),
      descConflict: null,
      editingDesc: true,
    });
  },
  cancelDesc() {
    Object.assign(this.sheet, { editingDesc: false, descUnsaved: false, descConflict: null });
    taskDrafts.delete('desc:' + this.sheet.id);
  },
  // When notes kept on the phone are opened again, show both versions if Vikunja's notes changed since editing began.
  checkNotes(t) {
    const sh = this.sheet,
      has = this.notesText(t).trim();
    if (
      sh.editingDesc &&
      sh.descBase !== null &&
      sh.descBase !== undefined &&
      has !== sh.descBase.trim() &&
      has !== sh.descDraft.trim()
    )
      sh.descConflict = has;
  },
  /* Save the notes, as an edit. Notes changed elsewhere since editing began aren't overwritten (notesRefused). Saving
     again replaces Vikunja's version, because the user has now seen it. */
  saveDesc() {
    const sh = this.sheet,
      base = sh.descConflict ?? sh.descBase;
    Object.assign(sh, { editingDesc: false, descUnsaved: false, descConflict: null });
    taskDrafts.delete('desc:' + sh.id);
    return this.sendEdit({ rebase: 'notes', text: sh.descDraft, base });
  },
  /* Notes Vikunja changed while the user wrote theirs come back to the phone, as a draft from Vikunja's notes, and the
     sheet shows both versions. With the sheet closed, a message on the task's row opens it. */
  notesRefused(a, e) {
    taskDrafts.set('desc:' + a.task, { text: a.text, base: a.base });
    if (this.sheetShows(a.task)) {
      Object.assign(this.sheet, {
        editingDesc: true,
        descDraft: a.text,
        descBase: a.base,
        descUnsaved: true,
        descConflict: e.notes,
      });
      this.say(SAID.notesConflict, { place: 'sheet:notes', cls: 'failed', ms: null });
    } else
      this.say(SAID.notesConflictRow, {
        row: { id: a.task, stays: true, cls: 'failed' },
        action: { label: OPEN, fn: () => this.openTask(a.task) },
      });
  },

  /* ---------- reminders ---------- */
  // Whether Vikunja's reminders reach this user. Vikunja sends them by email, when both the server and the user have
  // email reminders on.
  get remindersReach() {
    return !!this.info?.email_reminders_enabled && !!this.user?.settings?.email_reminders_enabled;
  },
  get remindersNote() {
    if (this.remindersReach) return '';
    return (
      'Vikunja sends reminders by email, and ' +
      (this.info?.email_reminders_enabled
        ? 'yours are turned off in your Vikunja settings.'
        : "this server doesn't send them.")
    );
  },
  // A reminder as text: "At due", "15 min before due", or the time it goes off. A reminder counted from a date the task
  // doesn't have says it won't be sent.
  reminderText(r) {
    // A reminder at a set time shows its day and time, even at noon or midnight, and "(past)" if that time has gone by.
    if (!r.relative_to) {
      const d = new Date(r.reminder);
      return isSet(r.reminder)
        ? `${dueInfo(startOfDay(d).toISOString()).label} ${fmtTime(d)}${d < new Date() ? ' (past)' : ''}`
        : '';
    }
    const s = Math.abs(r.relative_period || 0),
      from = { due_date: 'due', start_date: 'the start', end_date: 'the end' }[r.relative_to] || r.relative_to;
    const unset = !isSet(this.sheetTask?.[r.relative_to]) ? " (no date, so it won't be sent)" : '';
    if (!s) return (r.relative_to === 'due_date' ? 'At due' : 'At ' + from) + unset;
    const [n, unit] = [
      [86400, 'day'],
      [3600, 'hour'],
      [60, 'min'],
    ].find(([n]) => s % n === 0 && s >= n) || [1, 'sec'];
    const k = s / n;
    return `${k} ${unit}${k === 1 || unit === 'min' || unit === 'sec' ? '' : 's'} ${r.relative_period < 0 ? 'before' : 'after'} ${from}${unset}`;
  },
  // The reminders that can be added. If the task has a due date, these are offsets before it, which move with the date.
  // There is also a set date and time.
  get reminderPresets() {
    const t = this.sheetTask,
      have = new Set((t?.reminders || []).filter(r => r.relative_to === 'due_date').map(r => r.relative_period || 0));
    const before = isSet(t?.due_date)
      ? [
          [0, 'At due'],
          [-900, '15 min before due'],
          [-3600, '1 hour before due'],
          [-86400, '1 day before due'],
        ]
      : [];
    return [
      ...before.filter(([p]) => !have.has(p)).map(([p, label]) => ({ value: String(p), label })),
      { value: 'at', label: 'At a set date and time…' },
    ];
  },
  addReminder(v) {
    if (v === 'at') {
      this.sheet.remindAt = true;
      this.$nextTick(() => {
        const el = document.getElementById('d-remind-at');
        el?.focus();
        try {
          el?.showPicker();
        } catch {}
      });
    } else if (v) this.changeReminders({ relative_to: 'due_date', relative_period: +v }, null);
  },
  /* A tap anywhere on one of the sheet's label-and-value rows (Due, Reminders, Labels, Assigned) activates the row's
     control, which is marked data-tap. That opens a date's picker, opens a select's list (or focuses the select where
     the phone can't open the list from here), or presses the row's Add. A tap on a control, or on a button in the row
     (a date's ×, a chip's ×), does that control's own action instead. The control stays the only Tab stop, and the row
     is not a second one.
     Repeats and Project don't need this, because their select covers the whole row (.prop.sel). */
  propTap(e) {
    const el = e.currentTarget.querySelector('[data-tap]');
    if (!el || el.disabled || e.target.closest('button, a, input, select, textarea, label, form')) return;
    if (el.tagName === 'BUTTON') {
      el.click();
      return;
    }
    el.focus();
    try {
      el.showPicker();
    } catch {}
  },
  addReminderAt(v) {
    this.sheet.remindAt = false;
    if (v) this.changeReminders({ reminder: new Date(v).toISOString() }, null);
  },
  removeReminder(k) {
    const r = plainReminders(this.sheetTask)[k];
    return r && this.changeReminders(null, r);
  },
  // Add or remove a reminder in the list Vikunja has when the edit is sent, so a reminder added or removed elsewhere
  // since the sheet opened stays as it is.
  changeReminders(add, drop) {
    return this.sendEdit({ rebase: 'reminders', add: add ? [add] : [], drop: drop ? [drop] : [] });
  },

  /* ---------- labels ---------- */
  async toggleLabelPicker() {
    if (this.picker.open) {
      this.picker.open = false;
      return;
    }
    this.picker = { open: true, loading: true, error: '', q: '' };
    try {
      await this.loadLabels();
    } catch (e) {
      this.picker.error = errText(e);
    }
    this.picker.loading = false;
  },
  // Pressing Enter in the label picker adds the label with exactly the typed name if there is one, else the top label
  // in the list. If the list is empty, it creates a new label.
  labelEnter() {
    const q = this.picker.q.trim().toLowerCase(),
      m = this.pickerMatches;
    if (!q) return;
    const exact = m.find(l => l.title.toLowerCase() === q);
    if (exact || m[0]) this.addLabel(exact || m[0]);
    else if (this.pickerCanCreate) this.addLabel(null);
  },
  get pickerMatches() {
    const have = new Set((this.sheetTask?.labels || []).map(l => l.id)),
      ql = this.picker.q.trim().toLowerCase();
    return this.labels.filter(l => !have.has(l.id) && (!ql || l.title.toLowerCase().includes(ql))).slice(0, 30);
  },
  get pickerCanCreate() {
    const ql = this.picker.q.trim().toLowerCase();
    return !!ql && !this.labels.some(l => l.title.toLowerCase() === ql);
  },
  /* The people who can be assigned, as @ suggests them in quick add, filtered by what is typed. Only people who can see
     the task's project are listed, because Vikunja refuses anyone else. People already assigned are left out. */
  get assignSuggestions() {
    const t = this.sheetTask,
      q = this.sheet.assignName.trim().replace(/^@/, '').toLowerCase(),
      have = new Set((t?.assignees || []).map(u => u.id));
    const score = u =>
      Math.min(
        ...[u.username, u.name]
          .map(n => (n || '').toLowerCase())
          .map(n => (!q || n.startsWith(q) ? 0 : n.includes(q) ? 1 : 9)),
      );
    return (this.people || [])
      .filter(x => !have.has(x.user.id) && x.pids.has(t?.project_id))
      .map(x => ({ u: x.user, s: score(x.user) }))
      .filter(x => x.s < 9)
      .sort((a, b) => a.s - b.s || (a.u.name || a.u.username).localeCompare(b.u.name || b.u.username))
      .slice(0, 6)
      .map(x => x.u);
  },
  // Assign the person tapped in the suggestions. On Enter, assign the username typed, or the first suggestion. The box
  // stays open for the next person until the user taps Done.
  async assign(picked) {
    const typed = this.sheet.assignName.trim().replace(/^@/, ''),
      t = this.sheetTask; // the task shown when this started
    const sg = this.assignSuggestions,
      exact = sg.find(u => u.username.toLowerCase() === typed.toLowerCase());
    const pick = picked || exact || (typed && sg[0]) || null,
      name = pick ? pick.username : typed;
    if (!name) {
      this.sheet.assigning = false;
      return;
    }
    try {
      const u = pick || (await this.findUser(name));
      if (!u) {
        this.say(noUser(name), { place: 'sheet:props', cls: 'failed' });
        return;
      }
      await this.addAssignee(t, u);
      if (this.sheet.id === t.id) {
        this.sheet.assignName = '';
        document.getElementById('d-assign-in')?.focus();
      }
    } catch (e) {
      this.say(notDone('assigned', e.message), { place: 'sheet:props', cls: 'failed' });
    }
  },
  unassign(uid) {
    return this.removeAssignee(this.sheetTask, uid);
  },
  async addLabel(l) {
    const t = this.sheetTask; // the task shown when this started
    await this.addLabelTo(t, l, this.picker.q.trim());
    if (this.sheet.id === t.id) this.picker.q = '';
  },
  removeLabel(lid) {
    return this.removeLabelFrom(this.sheetTask, lid);
  },

  /* ---------- comments, attachments, delete ---------- */
  async loadComments(id) {
    if (this.info && this.info.task_comments_enabled === false) {
      this.sheet.commentsNote = 'Comments are turned off on this server.';
      return;
    }
    try {
      const list = items(await api(`/tasks/${id}/comments`));
      if (this.sheet.id === id) {
        this.sheet.comments = list;
        this.sheet.commentsNote = '';
      }
    } catch (e) {
      if (this.sheet.id !== id) return;
      if (e instanceof NetError) {
        this.sheet.comments ||= [];
        this.sheet.commentsNote =
          'Offline. Comments load when Pocket reaches Vikunja. A comment you write now is posted then.';
      } else this.sheet.commentsNote = errText(e);
    }
  },
  // A comment goes through the outbox, as a note on a checklist does. Offline, it waits and is posted later.
  async postComment() {
    const id = this.sheet.id,
      v = this.sheet.commentDraft.trim();
    if (!v) return;
    this.sheet.commentDraft = '';
    taskDrafts.delete('comment:' + id);
    const r = await this.act({ op: 'note', task: id, html: textToHtml(v), run: null });
    if (r.status === 'offline') this.say(waitText(r), { place: 'sheet:comments' });
    if (r.status === 'error' && this.sheet.id === id) this.sheet.commentDraft = v;
  },
  // Comments on the open task still waiting to be posted.
  get pendingComments() {
    return waitingComments(this.pending, this.sheet.id);
  },
  get attachmentsOn() {
    return this.info?.task_attachments_enabled !== false;
  },
  // A message naming the files this Vikunja won't accept because they are too big, or '' when they all fit. Vikunja's
  // own error message gives the wrong limit.
  tooBig(files) {
    const max = sizeLimit(this.info?.max_file_size),
      big = max ? files.filter(f => f.size > max) : [];
    return big.length
      ? tooBigText(
          big.map(f => `${f.name} (${fmtSize(f.size)})`),
          this.info.max_file_size,
        )
      : '';
  },
  // Handles the sheet's "Add a photo or file". The files go through the outbox, so without a connection they wait on
  // the phone, listed in the sheet, and upload once Pocket reaches Vikunja again.
  async addFiles(list, t = this.sheetTask) {
    const files = [...list];
    if (!files.length || !t) return;
    const at = ['sheet:files', 'step'],
      big = this.tooBig(files); // where messages go: a task's sheet, or a checklist step's card
    if (big) {
      this.say(big, { place: at, cls: 'failed' });
      return;
    }
    const entry = {
      id: randomId(),
      user: this.user?.id,
      at: new Date().toISOString(),
      taskId: t.id,
      files: files.map(fileEntry),
    };
    const { kept } = await sync.add(entry, files);
    this.refreshPending();
    const r = await sync.lock(() => this.sendEntry(entry.id));
    this.refreshPending();
    if (r.status === 'offline') {
      sync.keep();
      if (!kept) this.say(NOT_KEPT, { place: at, cls: 'failed' });
    }
    if (r.problems?.length) this.say(r.problems.join('; '), { place: at, cls: 'failed' });
  },
  // Handles the add box's camera button.
  addCapPhotos(list) {
    const files = [...list],
      big = this.tooBig(files);
    if (big) this.say(big, { place: 'cap', cls: 'failed' });
    const max = sizeLimit(this.info?.max_file_size);
    this.capPhotos.push(...files.filter(f => !max || f.size <= max));
    this.$refs.capture.focus();
  },
  // A blob: URL runs with this app's origin, so an HTML or SVG attachment opened that way could read the saved token.
  // Only types that can't run script open in a tab. Everything else is downloaded.
  async openAttachment(a, taskId = this.sheet.id) {
    const inline = INLINE_TYPES.test(mimeOf(a.file?.mime));
    const w = inline ? window.open('', '_blank') : null; // opened synchronously so iOS doesn't block it
    try {
      const res = await api(`/tasks/${taskId}/attachments/${a.id}`, { raw: true });
      const blob = await res.blob(),
        type = mimeOf(blob.type);
      if (inline && INLINE_TYPES.test(type)) {
        const url = URL.createObjectURL(new Blob([blob], { type }));
        if (w) w.location = url;
        else location.href = url;
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        return;
      }
      w?.close();
      const url = URL.createObjectURL(new Blob([blob], { type: 'application/octet-stream' }));
      Object.assign(document.createElement('a'), { href: url, download: a.file?.name || 'attachment' }).click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      w?.close();
      this.say(couldnt('open', e.message), { place: ['sheet:files', 'step'], cls: 'failed' });
    }
  },
  /* ---------- the sheet's list, and its box under a row ---------- */
  /* The sheet's list (sheet/sub-list.html) shows the open task's subtasks, a template's steps, or in New template the
     steps written so far, which aren't in Vikunja yet (checklists.js). It is one list, drawn by the task row, with one
     add box at its bottom. `subBoxW` is the box's name as box() uses it: 'sub' for a task, 'add:+' for a template, and
     'new:+' for New template. */
  get subList() {
    return this.sheet.kind === 'newtpl'
      ? this.sheet.newTpl?.rows || []
      : this.sheet.kind === 'task'
        ? this.subtasks
        : [];
  },
  get isStepList() {
    return this.sheet.kind === 'newtpl' || this.checklistRole === 'template';
  },
  get subBoxW() {
    if (this.sheet.kind === 'newtpl') return 'new:+';
    if (this.sheet.kind !== 'task' || !this.canEdit || this.checklistRole === 'run') return '';
    return this.checklistRole === 'template' ? 'add:+' : 'sub';
  },
  // Whether the box's button would add anything. For subtasks, at least one line has a title. For steps, the typed text
  // has no problem.
  get subBoxCan() {
    const w = this.subBoxW;
    if (!w) return false;
    if (w === 'sub') return this.boxParsedLines('sub').some(p => p.title);
    return !!(this.box(w).text || '').trim() && !this.draft(this.stepWhich).info.get('+')?.problem;
  },
  /* A step as its row shows it (task-row.html, g.step): its index among the steps, its number and its text. A step
     written in New template has a `key`. Its number and text are read together with the other rows there (draft), and
     the add box's text counts at the position of the box. */
  stepAt(t) {
    return this.subList.findIndex(s => s.id === t.id);
  },
  stepNo(t) {
    return (t.key ? (this.draft('new').info.get(t.key)?.i ?? this.stepAt(t)) : this.stepAt(t)) + 1;
  },
  stepShown(t) {
    if (!t.key) return this.templateSteps[this.stepAt(t)] || { title: t.title };
    const d = this.draft('new'),
      info = d.info.get(t.key),
      s = info && stepInfos(d.added)[info.i];
    // The title shows what a saved step's title will be. It leaves out the @people, *labels and !priority that quick
    // add will take when the step is created. It keeps the text of any chip the user turned off (t.ignore), because
    // that text stays in the title.
    const title = text => this.stepParsed(text, t.ignore).title || text;
    return s
      ? { ...s, title: title(s.title), problem: info.problem || s.problem }
      : { title: title(t.text), text: '', problem: '' };
  },
  /* The add box at the bottom of a list (markup/list-box.html), chosen by where the list is: 'sheet' (a task's
     subtasks, a template's steps, or New template's) or 'run' (a checklist's steps on its screen).
     Returns the box's name as box() uses it, its ids, the text it shows (`says`), whether it is under a row, whether its
     button would add anything, and on a checklist the step Repeat would copy. `rest` is the text the box shows at the
     bottom, and the placeholder there shows it while the box is under a row. Returns null when there is no box (a
     finished checklist, or a read-only one). */
  footBox(where) {
    if (where === 'run') {
      const a = this.runAim;
      if (!a) return null;
      const under = this.runBoxAt != null && !this.runBoxEnd;
      const rest = 'Add steps, or paste a list';
      return {
        w: 'ins',
        id: 'run-box',
        in: 'run-in',
        under,
        steps: false,
        can: this.boxParsedLines('ins').some(p => p.title),
        repeat: { title: a.above.title, can: !a.above.pending },
        says: under ? 'Step' : rest,
        rest,
        add: 'Add steps',
        home: 'Add after the last step instead',
      };
    }
    const w = this.subBoxW;
    if (!w) return null;
    const steps = this.isStepList,
      under = this.sheet.subAt != null && !this.sheet.subEnd,
      rest = steps ? 'Add steps, or paste a list' : 'Add subtasks, or paste a list';
    return {
      w,
      id: 'd-subbox',
      in: 'd-subin',
      under,
      steps,
      can: this.subBoxCan,
      repeat: null,
      says: under ? (steps ? 'Step' : 'Subtask') : rest,
      rest,
      add: steps ? 'Add steps' : 'Add subtasks',
      home: steps ? 'Add after the last step instead' : 'Add after the last subtask instead',
    };
  },
  /* Nudging a row of a list (watchNudges, progress.js) puts the list's add box under that row, so the next task is
     added after it. In a sheet this sets sheet.subAt. On a checklist's screen it sets runBoxAt.
     The row gets bottom padding as tall as the box, and the box is positioned over that padding. The box's element
     never leaves the page, so its text and focus are kept. Its placeholder at the bottom stays, drawn dashed. Tapping
     the placeholder puts the box back at the bottom. So does scrolling the row out of sight while the box isn't being
     typed in. Nudging the row the box is already under changes nothing.
     The box at the bottom is already under the last row. A nudge there only highlights the row, so that every nudge
     shows it worked (subEnd, runBoxEnd). The box says what it says at the bottom, and there is no placeholder.
     seatFoot checks where the row is on each frame, the same way seatBox (quickadd.js) does for a list's box. Both go
     through seat.js. */
  nudgedSub(id) {
    const s = this.subList.find(x => String(x.id) === String(id));
    // A template's steps are done tasks, so a done step is still allowed. Nothing happens while a step is being edited,
    // because its edit box is in the way.
    if (!s || (s.done && !this.isStepList) || !this.subBoxW || this.sheet.stepEdit) return;
    if (String(this.sheet.subAt ?? '') !== String(s.id)) haptic('tick');
    this.sheet.subAt = s.id;
    this.sheet.subAfter = null;
    this.sheet.subEnd = this.lastRow('#d-subtasks', s.id);
    this.$nextTick(() => this.seatFoot('sheet'));
  },
  // Handles a nudge on a checklist step (nudged, quickadd.js). The step on the card stays.
  nudgedStep(s) {
    this.runBoxAt = s.id;
    this.runBoxEnd = this.lastRow('#run-steps', s.id);
    this.$nextTick(() => this.seatFoot('run'));
  },
  // Whether the row with this id is the last one in list `sel`.
  lastRow(sel, id) {
    return [...document.querySelectorAll(sel + ' > .row[data-id]')].at(-1)?.dataset.id === String(id);
  },
  footHome(where) {
    if (where === 'run') this.runBoxAt = null;
    else {
      this.sheet.subAt = null;
      this.sheet.subAfter = null;
    }
    this.seatFoot(where);
  },
  seatFoot(where) {
    const run = where === 'run',
      list = run ? '#run-steps' : '#d-subtasks',
      boxId = run ? 'run-box' : 'd-subbox';
    // The visible area of the list: the screen, or the sheet's scrolling area.
    const sight = () =>
      run
        ? { top: 0, bottom: innerHeight }
        : document.getElementById('sheet-body')?.getBoundingClientRect() || { top: 0, bottom: innerHeight };
    // Whether any row comes after `el` in the list. If none does, a box under `el` is the box at the bottom.
    const later = el => {
      for (let n = el.nextElementSibling; n; n = n.nextElementSibling) if (n.matches('.row[data-id]')) return true;
      return false;
    };
    // The id of the row the box is under. A step added a moment ago is known by its outbox entry until Vikunja has it.
    const at = () =>
      run
        ? this.route.name === 'run' && this.runBoxAt != null
          ? this.actTask({ task: this.runBoxAt })
          : null
        : this.sheet.open
          ? this.sheet.subAt
          : null;
    const foot = () => {
      if (run) this.runBoxAt = null;
      else {
        this.sheet.subAt = null;
        this.sheet.subAfter = null;
      }
    };
    seatUnder(seats[where], {
      box: () => document.getElementById(boxId),
      cls: 'sub-boxed',
      prop: () => [document.getElementById(boxId).parentElement, '--sub-h'],
      sight,
      // Returns undefined when the row isn't drawn yet. A row just added is a frame or two away, so seatUnder waits. If
      // the row is still missing after about a second, seatUnder treats it as lost.
      row: () => {
        const id = at();
        return id == null ? null : (document.querySelector(`${list} > .row[data-id="${id}"]`) ?? undefined);
      },
      // A row that is now last (nudged there, just added at the end, or the rows after it deleted) has the box at the
      // bottom under it. The flag tells footBox, which can't see the page.
      atEnd: el => {
        const end = !later(el);
        if (run) {
          if (this.runBoxEnd !== end) this.runBoxEnd = end;
        } else if (this.sheet.subEnd !== end) this.sheet.subEnd = end;
        return end;
      },
      lost: foot,
      home: () => this.footHome(where),
      place: (b, el) => el.offsetTop + el.offsetHeight + 'px',
      apply: (b, top) => {
        b.style.top = top;
      },
      unplace: b => {
        if (b) b.style.top = '';
      },
      scrollBack: h => {
        if (run) scrollBy(0, -h);
        else document.getElementById('sheet-body').scrollTop -= h;
      },
    });
  },
};
