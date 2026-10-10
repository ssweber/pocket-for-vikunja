/* Where Pocket says what happened: in the place it happened, not at the bottom of the screen.
   - The row itself: a tick or a deletion shows on the row, which stays where it is until the batch clears (leaving.js),
     and a screen reader hears it.
   - A row's place (markup/row-line.html): the row shrinks to a slim line saying what went wrong with it, with an action
     at its end: a tick not saved ("Not saved: no connection  Try again"), a move turned down. After its time (`ms`) it
     folds away and gives the row back (`stays`), or, on a row that goes, folds it away; then `gone` is called. Leaving
     the screen, or putting Pocket away, folds them all at once.
   - A place (markup/place-line.html): under a list's heading (Move all to today, under Overdue), by the add box (where
     a task went, when it isn't on the screen; on a run, a step repeated), in the open sheet under what it's about (a
     save that failed), on a run's step card. A sheet's lines go with it.
   - Only where there's none of those: the toast at the bottom (toast.js).
   A screen reader hears each from #said. */
import {collapse, motion} from '../util.js';
import {UNDO_MS} from './toast.js';

export const SAY_MS = 4000;                             // how long a message with nothing to tap shows
const timers = new Map();
// The rows of a task on the page: in the list (its card, on Today), and in a task's sheet.
// (Not a sheet's own row, its task's head: what's said about the task in a sheet goes in the sheet's places.)
const rowsOf = id => [...document.querySelectorAll(`:is(.row:not(.own), .day-card)[data-id="${id}"]`)];
// The places on a screen, and when each is on it. A sheet's ("sheet:notes") are there while it's open.
const SCREEN = {
  overdue: a => a.route.name === 'today',
  done: a => a.route.name === 'project',                 // under a project's Done heading
  more: a => ['project', 'search'].includes(a.route.name),   // under the row that shows more done tasks (showMore)
  cap: a => ['today', 'project'].includes(a.route.name) || (a.route.name === 'run' && !!a.runAim),   // by the add box
  checklists: a => a.route.name === 'checklists',
  projects: a => a.route.name === 'projects',
  setup: a => ['projects', 'checklists'].includes(a.route.name),
  run: a => a.route.name === 'run',
  step: a => a.route.name === 'run' && !!a.runView?.step,
};
// The places in a task's sheet, under what each is about; any other sheet has its message at its top.
const TASK_SHEET = ['top', 'due', 'notes', 'files', 'subtasks', 'comments', 'props'];
const flashTimers = {};

export default {
  /* Says `msg` where it belongs: in task `row`'s place (an id, or {id, text, title, more, hide, stays, cls} for a line
     that isn't just `msg`), else at `place`, the first of them on screen; else in the toast. `action` ({label, fn}) is
     at its end, `ms` how long it shows, `gone` called when it goes without the action, `cls` "failed" for something that
     went wrong. `place` can be a list, the first on screen taken. Returns where it went. A row behind an open sheet
     can't be seen, so it isn't one. */
  say(msg, {row = null, place = null, action = null, ms, gone, cls = ''} = {}){
    const timing = ms === undefined ? {} : {ms}, r = row && typeof row === 'object' ? row : {id: row};
    const seen = row && rowsOf(r.id).some(el => !(this.sheet.open && this.sheet.show) || el.closest('#sheet'));
    if (seen && this.rowLine(r.id, {text: msg, action, gone, cls, ...timing, ...r})) return 'row';
    for (const p of [].concat(place || [])) if (this.sayAt(p, {text: msg, action, gone, cls: r.cls || cls, ...timing})) return 'place';
    this.notify(msg, action && {...action, gone}, null);
    return 'toast';
  },
  // A task's row on screen (the first, if it's in the list and a sheet), to carry on from: a Try again.
  rowEl(id){ return rowsOf(id)[0] || null; },
  // Whether a row of task `id` is in sight: all of it between the header and the add box, not scrolled away, nor
  // behind an open sheet. What's said with an Undo goes on its row only then (reschedule), else where it's seen.
  rowSeen(id){
    if (this.sheet.open && this.sheet.show) return false;
    const top = Math.max(0, document.querySelector('header.top')?.getBoundingClientRect().bottom || 0);
    const bottom = document.getElementById('capture')?.getBoundingClientRect().top || innerHeight;
    return rowsOf(id).some(el => { const r = el.getBoundingClientRect(); return r.height > 0 && r.top >= top && r.bottom <= bottom; });
  },

  /* ---------- a row's place ---------- */
  /* A line in place of task `id`'s rows: {text: what happened ("Not saved: no connection"), title: the task's, shown
     struck through (or none), more: after it, action: {label, fn} (Try again), ms: how long it stays (null: until its
     action, or the screen is left), stays: the row comes back when it goes, gone(): called when it folds}. Returns false
     when no row of it is on screen. */
  rowLine(id, line){
    const els = rowsOf(id);
    if (!els.length) return false;
    if (this.lines[id]) this.endLine(id, true);
    const from = els.map(el => el.offsetHeight);
    this.lines[id] = {title: '', more: '', action: null, stays: false, ...line, id};
    this.said = [line.text, line.title, line.more].filter(Boolean).join(' ') + (line.action ? `. ${line.action.label} is ${line.stays ? 'on its row' : 'where it was'}.` : '');
    // It shrinks to the line, rather than jumping.
    if (motion()) this.$nextTick(() => els.forEach((el, i) => el.isConnected && el.animate([{height: from[i] + 'px'}, {height: el.offsetHeight + 'px'}], {duration: 200, easing: 'ease-out'})));
    const ms = 'ms' in line ? line.ms : line.action ? UNDO_MS : SAY_MS;
    if (ms !== null) timers.set(id, setTimeout(() => this.foldLine(id), ms));
    return true;
  },
  // Its time is up: it folds away, then what it was for is done. A row that stays is back as it was.
  async foldLine(id){
    const line = this.lines[id];
    if (!line) return;
    clearTimeout(timers.get(id)); timers.delete(id);
    if (!line.stays) await Promise.all(rowsOf(id).map(collapse));
    this.endLine(id, true);
  },
  endLine(id, gone){
    const line = this.lines[id];
    if (!line) return;
    clearTimeout(timers.get(id)); timers.delete(id);
    delete this.lines[id];
    if (gone) line.gone?.();
  },
  // Its action tapped (Undo): the row is back, and what it was for isn't done.
  runLineAction(id){
    const line = this.lines[id];
    if (!line) return;
    this.endLine(id, false);
    this.said = '';
    line.action?.fn();
  },
  // Leaving the screen, or Pocket put away: the rows marked done or deleted go at once (a deletion is sent), every line
  // goes, and what it was for is done; so do the screen's places'.
  foldLines(){
    this.clearNow();
    for (const id of Object.keys(this.lines)) this.endLine(id, true);
    for (const k of Object.keys(this.places)) this.endPlace(k, this.places[k], true);
  },
  // Rows not shown: those being deleted, but those deleted in place, waiting for the batch (leaving.js).
  get hiddenRows(){ return new Set(this.deleting.filter(id => !this.leaving[id])); },

  /* ---------- a place ---------- */
  // Where a place's line is kept: a sheet's in the sheet, so it goes with it; in a sheet that isn't a task's, at its top.
  placeOf(place){
    if (!place.startsWith('sheet:')) return SCREEN[place]?.(this) ? {store: this.places, key: place} : null;
    if (!this.sheet.open) return null;
    const key = place.slice(6);
    return {store: this.sheet.lines, key: this.sheet.kind === 'task' && TASK_SHEET.includes(key) ? key : 'top'};
  },
  /* A line at `place` ("overdue", "cap", "sheet:notes"…): {text, action, ms (null: until the screen or the sheet is
     left), gone}. Returns false if the place isn't on screen. */
  sayAt(place, line){
    const at = this.placeOf(place);
    if (!at) return false;
    const {store, key} = at, old = store[key];
    if (old) this.endPlace(key, old, true, store);
    store[key] = {action: null, ...line, place, key, n: (old?.n || 0) + 1};
    // (As the store gives it back: Alpine keeps a copy of its own of what's put there, and that's the one endPlace
    // is asked about once its time is up. Kept as it was put, it was never the line showing, and never went.)
    const l = store[key];
    this.said = l.text + (l.action ? `. ${l.action.label} is beside it.` : '');
    const ms = 'ms' in line ? line.ms : line.action ? UNDO_MS : SAY_MS;
    if (ms !== null) setTimeout(() => this.endPlace(key, l, true, store), ms);
    return true;
  },
  // The line at a place, for the markup's x-for: [line] or [].
  placeLines(place){ const at = this.placeOf(place), l = at && at.store[at.key]; return l ? [l] : []; },
  // That line goes, if it's still the one showing.
  endPlace(key, l, gone, store = this.places){
    if (!l || store[key] !== l) return;
    delete store[key];
    if (gone) l.gone?.();
  },
  runPlaceAction(l){
    const store = l.place.startsWith('sheet:') ? this.sheet.lines : this.places;
    if (store[l.key] !== l) return;
    this.endPlace(l.key, l, false, store);
    this.said = '';
    l.action?.fn();
  },
  // A place's line, taken back: what it said is no longer so (a save that failed, done again).
  unsay(place){ const at = this.placeOf(place); if (at) this.endPlace(at.key, at.store[at.key], false, at.store); },

  /* ---------- a row lit up ---------- */
  // Rows that light up for a moment, to show where they are: tasks just added (fresh), or just come due (due).
  flash(ids, kind = 'fresh'){
    this.flashed[kind] = ids;
    clearTimeout(flashTimers[kind]); flashTimers[kind] = setTimeout(() => { this.flashed[kind] = []; }, 2000);
  },
};
