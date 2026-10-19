/* Messages appear where the action happened. A row can shrink to a message that has an action, and the row comes
   back or leaves when the message expires. Other messages appear under a heading, beside the add box or in the
   sheet. If none of those places is visible, a toast is used. Leaving the screen folds its messages, and #said
   announces each message to screen readers. */
import { collapse, motion } from '../util.js';
import { UNDO_MS } from './toast.js';
import { besideIt, rowLineSaid } from '../messages.js';

export const SAY_MS = 4000; // how long a message with nothing to tap shows
const timers = new Map();
// Find list rows, cards and sheet subtasks. A sheet's own task shows its messages below its fields instead.
const rowsOf = id => [...document.querySelectorAll(`:is(.row:not(.own), .day-card)[data-id="${id}"]`)];
// The places where a message can appear, each with a test for whether it is on the current screen. A sheet's places
// ("sheet:notes") exist while the sheet is open.
const SCREEN = {
  overdue: a => a.route.name === 'today',
  donetoday: a => a.route.name === 'today', // under Done today's heading
  project: a => a.route.name === 'project', // under a project's title
  done: a => a.route.name === 'project', // under a project's Done heading
  more: a => ['project', 'search'].includes(a.route.name), // under the row that shows more done tasks (showMore)
  cap: a => ['today', 'project'].includes(a.route.name) || (a.route.name === 'run' && !!a.runAim), // by the add box
  checklists: a => a.route.name === 'checklists',
  projects: a => a.route.name === 'projects',
  setup: a => ['projects', 'checklists'].includes(a.route.name),
  run: a => a.route.name === 'run',
  step: a => a.route.name === 'run' && !!a.runView?.step,
};
// The places in a task's sheet, each below the part of the sheet it is about. Any other sheet shows its message at
// the top.
const TASK_SHEET = ['top', 'due', 'notes', 'files', 'asks', 'subtasks', 'comments', 'props'];
const flashTimers = {};

export default {
  /* Show `msg` on a visible row, at the first visible `place`, or in a toast. `row` is a task id or an object with
     the options for rowLine. `action` is {label, fn}, `ms` is the duration, and `gone` runs if the message ends
     without the action. `cls` can mark a failure. Returns where the message appeared. Rows behind an open sheet
     don't count as visible. */
  say(msg, { row = null, place = null, action = null, ms, gone, cls = '' } = {}) {
    const timing = ms === undefined ? {} : { ms },
      r = row && typeof row === 'object' ? row : { id: row };
    const seen = row && rowsOf(r.id).some(el => !(this.sheet.open && this.sheet.show) || el.closest('#sheet'));
    if (seen && this.rowLine(r.id, { text: msg, action, gone, cls, ...timing, ...r })) return 'row';
    for (const p of [].concat(place || []))
      if (this.sayAt(p, { text: msg, action, gone, cls: r.cls || cls, ...timing })) return 'place';
    this.notify(msg, action && { ...action, gone }, null);
    return 'toast';
  },
  // Find a task's first row, so Try again can use the same row as the original action.
  rowEl(id) {
    return rowsOf(id)[0] || null;
  },
  // Undo goes on the row only if the whole row is visible between the header and the add box, with no sheet over it.
  rowSeen(id) {
    if (this.sheet.open && this.sheet.show) return false;
    const top = Math.max(0, document.querySelector('header.top')?.getBoundingClientRect().bottom || 0);
    const bottom = document.getElementById('capture')?.getBoundingClientRect().top || innerHeight;
    return rowsOf(id).some(el => {
      const r = el.getBoundingClientRect();
      return r.height > 0 && r.top >= top && r.bottom <= bottom;
    });
  },

  /* ---------- a message in place of a row ---------- */
  /* Replace task `id`'s rows with a message {text, title, more, action, ms, stays, gone}. The optional `title` is
     struck through. With `stays`, the row comes back when the message ends. A null `ms` keeps the message until the
     user taps the action or leaves the screen. Returns false if the task has no row on the page. */
  rowLine(id, line) {
    const els = rowsOf(id);
    if (!els.length) return false;
    if (this.lines[id]) this.endLine(id, true);
    const from = els.map(el => el.offsetHeight);
    this.lines[id] = { title: '', more: '', action: null, stays: false, ...line, id };
    this.said = rowLineSaid([line.text, line.title, line.more].filter(Boolean).join(' '), line.action, line.stays);
    // Animate the height change, so replacing a row with a message doesn't jump.
    if (motion())
      this.$nextTick(() =>
        els.forEach(
          (el, i) =>
            el.isConnected &&
            el.animate([{ height: from[i] + 'px' }, { height: el.offsetHeight + 'px' }], {
              duration: 200,
              easing: 'ease-out',
            }),
        ),
      );
    const ms = 'ms' in line ? line.ms : line.action ? UNDO_MS : SAY_MS;
    if (ms !== null)
      timers.set(
        id,
        setTimeout(() => this.foldLine(id), ms),
      );
    return true;
  },
  // Collapse a leaving row before ending its message. A row with `stays` comes back without collapsing.
  async foldLine(id) {
    const line = this.lines[id];
    if (!line) return;
    clearTimeout(timers.get(id));
    timers.delete(id);
    if (!line.stays) await Promise.all(rowsOf(id).map(collapse));
    this.endLine(id, true);
  },
  endLine(id, gone) {
    const line = this.lines[id];
    if (!line) return;
    clearTimeout(timers.get(id));
    timers.delete(id);
    delete this.lines[id];
    if (gone) line.gone?.();
  },
  // Restore the row, then run the message's action. `gone` is not called.
  runLineAction(id) {
    const line = this.lines[id];
    if (!line) return;
    this.endLine(id, false);
    this.said = '';
    line.action?.fn();
  },
  // End all marks and messages when leaving the screen or hiding Pocket. Their `gone` callbacks run, which sends held
  // deletions.
  foldLines() {
    this.clearNow();
    for (const id of Object.keys(this.lines)) this.endLine(id, true);
    for (const k of Object.keys(this.places)) this.endPlace(k, this.places[k], true);
  },

  /* ---------- a message at a place ---------- */
  // Sheet messages are kept in the sheet, so closing the sheet removes them. A sheet that is not a task's shows its
  // messages at the top, except New template's subtask messages, which go under its steps.
  placeOf(place) {
    if (!place.startsWith('sheet:')) return SCREEN[place]?.(this) ? { store: this.places, key: place } : null;
    if (!this.sheet.open) return null;
    const key = place.slice(6),
      kind = this.sheet.kind;
    return {
      store: this.sheet.lines,
      key: (kind === 'task' && TASK_SHEET.includes(key)) || (kind === 'newtpl' && key === 'subtasks') ? key : 'top',
    };
  },
  /* Show a message at `place`, such as "overdue", "cap" or "sheet:notes". `line` is {text, action, ms, gone}. A null
     `ms` keeps the message until the screen or the sheet is left. Returns false if the place isn't on the screen. */
  sayAt(place, line) {
    const at = this.placeOf(place);
    if (!at) return false;
    const { store, key } = at,
      old = store[key];
    if (old) this.endPlace(key, old, true, store);
    store[key] = { action: null, ...line, place, key, n: (old?.n || 0) + 1 };
    // Read back Alpine's proxy so endPlace compares the same object when the timer expires.
    const l = store[key];
    this.said = besideIt(l.text, l.action);
    const ms = 'ms' in line ? line.ms : line.action ? UNDO_MS : SAY_MS;
    if (ms !== null) setTimeout(() => this.endPlace(key, l, true, store), ms);
    return true;
  },
  // The message at a place as [message], or [] if there is none. The markup loops over it with x-for.
  placeLines(place) {
    const at = this.placeOf(place),
      l = at && at.store[at.key];
    return l ? [l] : [];
  },
  // End the message `l` at a place. Does nothing if a newer message has replaced it, so an old timer can't remove the
  // newer one.
  endPlace(key, l, gone, store = this.places) {
    if (!l || store[key] !== l) return;
    delete store[key];
    if (gone) l.gone?.();
  },
  runPlaceAction(l) {
    const store = l.place.startsWith('sheet:') ? this.sheet.lines : this.places;
    if (store[l.key] !== l) return;
    this.endPlace(l.key, l, false, store);
    this.said = '';
    l.action?.fn();
  },
  // Remove a message that no longer applies, without its callback. For example, a failed save that later succeeded.
  unsay(place) {
    const at = this.placeOf(place);
    if (at) this.endPlace(at.key, at.store[at.key], false, at.store);
  },

  /* ---------- a highlighted row ---------- */
  // Highlight tasks for 2 seconds. `kind` is 'fresh' for tasks just added, 'due' for tasks that just came due, and
  // 'arrived' for tasks a refresh or a move brought in. Entries are keyed by id, so other rows don't have to recompute
  // their highlights.
  flash(ids, kind = 'fresh') {
    const lit = this.flashed[kind],
      now = new Set(ids.map(String));
    for (const id of Object.keys(lit)) if (!now.has(id)) delete lit[id];
    for (const id of ids) if (!lit[id]) lit[id] = true;
    clearTimeout(flashTimers[kind]);
    flashTimers[kind] = setTimeout(() => {
      for (const id of Object.keys(lit)) delete lit[id];
    }, 2000);
  },
};
