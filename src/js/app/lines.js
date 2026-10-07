/* A message in a row's place (markup/row-line.html): the row shrinks to a slim line saying what happened to it, with an
   action at its end. A task ticked off its list, or deleted, has its Undo here ("Deleted “Load chairs”  Undo"), rather
   than at the bottom of the screen. Each row's line is its own, so a few done one after another each keep theirs. After
   its time (`ms`, an Undo's by default) it folds away, and what it was for is done (`gone`): a ticked row goes (the
   tick was saved at once), a deletion is sent. Leaving the screen, or putting Pocket away, folds them all at once, so a
   deletion is never left waiting. What a line shows is apart from what it's for: a deletion waits in the outbox
   (holdDelete), and its line only says when to send it. */
import {collapse} from '../util.js';
import {UNDO_MS} from './toast.js';

const timers = new Map();
const motion = () => !matchMedia('(prefers-reduced-motion: reduce)').matches;
// The rows of a task on the page: in the list, and in a task's sheet.
const rowsOf = id => [...document.querySelectorAll(`.row[data-id="${id}"]`)];

export default {
  /* A line in place of task `id`'s rows: {text: what happened ("Deleted", "Done:"), title: the task's, shown struck
     through (or none), more: after it (" + 4 subtasks"), action: {label, fn} (Undo), ms: how long it stays (null: until
     its action, or the screen is left), hide: ids of rows that go with it (subtasks ticked with it), gone(): called when
     it folds}. Returns false when no row of it is on screen, for a message at the bottom instead. */
  rowLine(id, line){
    const els = rowsOf(id);
    if (!els.length) return false;
    if (this.lines[id]) this.endLine(id, true);
    const from = els.map(el => el.offsetHeight);
    this.lines[id] = {title: '', more: '', hide: [], action: null, ...line};
    this.said = [line.text, line.title, line.more].filter(Boolean).join(' ') + (line.action ? `. ${line.action.label} is where it was.` : '');
    // It shrinks to the line, rather than jumping.
    if (motion()) this.$nextTick(() => els.forEach((el, i) => el.isConnected && el.animate([{height: from[i] + 'px'}, {height: el.offsetHeight + 'px'}], {duration: 200, easing: 'ease-out'})));
    const ms = 'ms' in line ? line.ms : UNDO_MS;
    if (ms !== null) timers.set(id, setTimeout(() => this.foldLine(id), ms));
    return true;
  },
  // Its time is up: it folds away, then what it was for is done.
  async foldLine(id){
    if (!this.lines[id]) return;
    clearTimeout(timers.get(id)); timers.delete(id);
    await Promise.all(rowsOf(id).map(collapse));
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
  // Leaving the screen, or Pocket put away: every line goes at once, and what it was for is done.
  foldLines(){ for (const id of Object.keys(this.lines)) this.endLine(id, true); },
  // Rows not shown: those being deleted (but one with a line, in its row's place), and those that went with a line.
  get hiddenRows(){
    const out = new Set(this.deleting.filter(id => !this.lines[id]));
    for (const l of Object.values(this.lines)) for (const id of l.hide) out.add(id);
    return out;
  },
};
