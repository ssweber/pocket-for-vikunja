/* Show messages where the action happened. A row can shrink to a message with an action, then return or leave when
   the message expires. Other messages appear under a heading, beside the add box or in the sheet. Use a toast when
   none of those places is visible. Leaving the screen folds its messages, and #said announces each to screen readers. */
import {collapse, motion} from '../util.js';
import {UNDO_MS} from './toast.js';

export const SAY_MS = 4000;                             // how long a message with nothing to tap shows
const timers = new Map();
// Find list rows, cards and sheet subtasks. A sheet's own task uses messages below its fields instead.
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
  /* Show `msg` on a visible row, at the first visible `place`, or in a toast. `row` is an id or a row-line object.
     `action` supplies {label, fn}, `ms` sets the duration, and `gone` runs if the message ends without the action.
     `cls` can mark a failure. Return where the message appeared. Rows behind an open sheet don't count as visible. */
  say(msg, {row = null, place = null, action = null, ms, gone, cls = ''} = {}){
    const timing = ms === undefined ? {} : {ms}, r = row && typeof row === 'object' ? row : {id: row};
    const seen = row && rowsOf(r.id).some(el => !(this.sheet.open && this.sheet.show) || el.closest('#sheet'));
    if (seen && this.rowLine(r.id, {text: msg, action, gone, cls, ...timing, ...r})) return 'row';
    for (const p of [].concat(place || [])) if (this.sayAt(p, {text: msg, action, gone, cls: r.cls || cls, ...timing})) return 'place';
    this.notify(msg, action && {...action, gone}, null);
    return 'toast';
  },
  // Find the first row of a task so Try again can reuse the row action.
  rowEl(id){ return rowsOf(id)[0] || null; },
  // Put Undo on the row only when the whole row is visible between the header and add box, with no sheet over it.
  rowSeen(id){
    if (this.sheet.open && this.sheet.show) return false;
    const top = Math.max(0, document.querySelector('header.top')?.getBoundingClientRect().bottom || 0);
    const bottom = document.getElementById('capture')?.getBoundingClientRect().top || innerHeight;
    return rowsOf(id).some(el => { const r = el.getBoundingClientRect(); return r.height > 0 && r.top >= top && r.bottom <= bottom; });
  },

  /* ---------- a row's place ---------- */
  /* Replace task `id`'s rows with {text, title, more, action, ms, stays, gone}. The optional title is struck through.
     `stays` restores the row when the message ends. A null duration keeps it until an action or navigation.
     Return false when the task has no row on the page. */
  rowLine(id, line){
    const els = rowsOf(id);
    if (!els.length) return false;
    if (this.lines[id]) this.endLine(id, true);
    const from = els.map(el => el.offsetHeight);
    this.lines[id] = {title: '', more: '', action: null, stays: false, ...line, id};
    this.said = [line.text, line.title, line.more].filter(Boolean).join(' ') + (line.action ? `. ${line.action.label} is ${line.stays ? 'on its row' : 'where it was'}.` : '');
    // Animate the height change so replacing a row with a message doesn't jump.
    if (motion()) this.$nextTick(() => els.forEach((el, i) => el.isConnected && el.animate([{height: from[i] + 'px'}, {height: el.offsetHeight + 'px'}], {duration: 200, easing: 'ease-out'})));
    const ms = 'ms' in line ? line.ms : line.action ? UNDO_MS : SAY_MS;
    if (ms !== null) timers.set(id, setTimeout(() => this.foldLine(id), ms));
    return true;
  },
  // Collapse a departing row before ending its message. A row marked `stays` returns without collapsing.
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
  // Restore the row before running its action, without calling `gone`.
  runLineAction(id){
    const line = this.lines[id];
    if (!line) return;
    this.endLine(id, false);
    this.said = '';
    line.action?.fn();
  },
  // End marks and messages when leaving the screen or hiding Pocket, including callbacks that send held deletions.
  foldLines(){
    this.clearNow();
    for (const id of Object.keys(this.lines)) this.endLine(id, true);
    for (const k of Object.keys(this.places)) this.endPlace(k, this.places[k], true);
  },
  // Hide tasks being deleted unless their marked rows are waiting for the batch.
  get hiddenRows(){ return new Set(this.deleting.filter(id => !this.leaving[id])); },

  /* ---------- a place ---------- */
  // Keep sheet messages in the sheet so closing it removes them. Other sheets use the top, except New template's
  // subtask messages, which belong under its steps.
  placeOf(place){
    if (!place.startsWith('sheet:')) return SCREEN[place]?.(this) ? {store: this.places, key: place} : null;
    if (!this.sheet.open) return null;
    const key = place.slice(6), kind = this.sheet.kind;
    return {store: this.sheet.lines, key: (kind === 'task' && TASK_SHEET.includes(key)) || (kind === 'newtpl' && key === 'subtasks') ? key : 'top'};
  },
  /* A line at `place` ("overdue", "cap", "sheet:notes"…): {text, action, ms (null: until the screen or the sheet is
     left), gone}. Returns false if the place isn't on screen. */
  sayAt(place, line){
    const at = this.placeOf(place);
    if (!at) return false;
    const {store, key} = at, old = store[key];
    if (old) this.endPlace(key, old, true, store);
    store[key] = {action: null, ...line, place, key, n: (old?.n || 0) + 1};
    // Read back Alpine's proxy so endPlace compares the same object when the timer expires.
    const l = store[key];
    this.said = l.text + (l.action ? `. ${l.action.label} is beside it.` : '');
    const ms = 'ms' in line ? line.ms : line.action ? UNDO_MS : SAY_MS;
    if (ms !== null) setTimeout(() => this.endPlace(key, l, true, store), ms);
    return true;
  },
  // The line at a place, for the markup's x-for: [line] or [].
  placeLines(place){ const at = this.placeOf(place), l = at && at.store[at.key]; return l ? [l] : []; },
  // An old timer must not remove a newer message at the same place.
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
  // Remove an obsolete message without its callback, such as a failed save that now succeeded.
  unsay(place){ const at = this.placeOf(place); if (at) this.endPlace(at.key, at.store[at.key], false, at.store); },

  /* ---------- a row lit up ---------- */
  // Highlight tasks just added or due. Change entries by id so other rows don't have to recompute their highlights.
  flash(ids, kind = 'fresh'){
    const lit = this.flashed[kind], now = new Set(ids.map(String));
    for (const id of Object.keys(lit)) if (!now.has(id)) delete lit[id];
    for (const id of ids) if (!lit[id]) lit[id] = true;
    clearTimeout(flashTimers[kind]); flashTimers[kind] = setTimeout(() => { for (const id of Object.keys(lit)) delete lit[id]; }, 2000);
  },
};
