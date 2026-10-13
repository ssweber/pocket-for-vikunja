/* Keep ticked and deleted rows in place until the batch clears, so rows don't move under a finger. The row's tick
   undoes completion, and tapping a deleted row's gap restores it. Hold rows from the gesture until the save answers,
   then mark them with an undo and a `gone` callback. Clearing the batch moves completed rows, shows repeating tasks'
   next dates and sends held deletions. A collapsed card advances its top row sooner. Leaving the screen or hiding
   Pocket clears the batch immediately. */
import {app, motion} from '../util.js';
import {batchTimer, TOP_MS} from '../batch.js';

// Remove the dismissed hint's spacing sooner than rows leave, once the finger lifts.
const HINT_MS = 1000;
/* Key batch state by `leaving` because markup calls methods with the row's scope, which shares that object with
   the component. `marks` maps each affected task id to its mark. `early` holds save promises before marks exist.
   Separate timers advance collapsed cards and remove hint spacing. */
const state = new WeakMap();
const of = c => {
  let s = state.get(c.leaving);
  if (!s) state.set(c.leaving, s = {marks: new Map(), early: new Map(), batch: batchTimer(() => app.clearBatch()), tops: batchTimer(() => app.clearTops(), TOP_MS),
    hint: batchTimer(() => c.closeHint(), HINT_MS)});
  return s;
};
const EXIT_MS = 250;
// Collapse all leaving rows together so the rows below move once. Return the animations to cancel after removal.
// With reduced motion, fade the rows instead.
function exit(els){
  const hs = els.map(el => el.offsetHeight);                // read before any of them starts to move
  return Promise.all(els.map((el, i) => {
    el.style.overflow = 'hidden';
    const a = el.animate(motion() ? [{height: hs[i] + 'px', opacity: 1}, {height: '0px', minHeight: '0px', opacity: 0, paddingTop: '0px', paddingBottom: '0px', borderTopWidth: '0px'}]
      : [{opacity: 1}, {opacity: 0}], {duration: motion() ? EXIT_MS : 150, easing: 'ease-in-out', fill: 'forwards'});
    return a.finished.catch(() => {}).then(() => a);
  }));
}
// Find list rows and cards that can collapse. A collapsed card's top row advances in place, and a sheet keeps its own row.
const rowsOf = ids => ids.flatMap(id => [...document.querySelectorAll(`:is(.row:not(.step-line, .own), .day-card)[data-id="${id}"]`)]);
// Whether task `id`'s only row on the screen is a collapsed card's top row.
const isTop = id => !!document.querySelector(`.row.step-line[data-id="${id}"]`) && !rowsOf([id]).length;

export default {
  /* Mark task `id` and related `ids` until the batch clears. `out` selects leaving rows, directly or through a
     function, and defaults to all ids. The tick or Restore calls `undo`. Clearing calls `gone`. `said` announces
     the change to a screen reader. A new mark replaces the old one. */
  markRow(id, {kind, ids = [id], out, undo = null, gone = null, said = ''}){
    const {marks, batch, tops} = of(this), m = {id, kind, ids, out, undo, gone, going: false};
    for (const x of ids) { const old = marks.get(x); if (old && old !== m) this.dropMark(old, x); marks.set(x, m); this.leaving[x] = kind; }
    if (said) this.said = said;
    batch.mark();
    if (kind === 'done') tops.mark();
  },
  /* Hold the row before its save answers, using the mark's future kind. Otherwise a ticked row would leave its card
     during the save and return when marked. Return a release function to call after the answer. A mark then keeps
     the row in place, or a failed save restores it. Undo and Restore wait for this answer. */
  holdRow(id, kind){
    const s = of(this);
    if (s.marks.has(id) || s.early.has(id)) return () => {};
    this.leaving[id] = kind;
    let answered;
    s.early.set(id, new Promise(ok => { answered = ok; }));
    return () => {
      s.early.delete(id);
      if (!s.marks.has(id)) delete this.leaving[id];
      answered();
    };
  },
  /* Reserve the deleted row's gap immediately after release, until `settled` answers. The gap must appear when the
     row finishes sliding away, regardless of how long the deletion takes. */
  gapNow(id, settled){
    const letGo = this.holdRow(id, 'deleted');
    Promise.resolve(settled).catch(() => {}).then(letGo);
  },
  /* Undo a row's mark, waiting for a pending save first. A subtask closed with its parent leaves the parent's mark
     so its normal tick can reopen it. Return false for a normal tick, or true or a promise when the mark handles it. */
  unmark(id){
    const m = of(this).marks.get(id), early = of(this).early.get(id);
    if (!m) return early ? early.then(() => this.unmark(id)) : false;
    if (m.going) return true;                              // on its way out: too late
    if (id !== m.id && m.kind !== 'deleted') { this.dropMark(m, id); return false; }
    this.dropMark(m);
    const title = this.tasks[id]?.title || '';
    this.said = m.kind === 'deleted' ? 'Restored: ' + title : m.kind === 'done' ? 'Not done: ' + title : 'Done: ' + title;
    return m.undo?.() || true;
  },
  /* Show a gap for a deleted list row until the batch clears. Sheet headings and run screens keep their own layout. */
  isGap(t, g){ return !g.own && !g.top && !g.run && this.leaving[t.id] === 'deleted'; },
  // Restore from any tap on the gap, without also activating the row's controls.
  tapGap(t, g, e){ if (this.isGap(t, g)) { e.stopPropagation(); e.preventDefault(); this.restoreRow(t.id); } },
  /* Restore the deleted rows from the left. Wait for a pending deletion to answer before undoing its mark. */
  restoreRow(id){
    const early = of(this).early.get(id);
    if (early) return early.then(() => this.restoreRow(id));
    const m = of(this).marks.get(id);
    const els = m?.kind === 'deleted' && !m.going && motion() ? rowsOf(m.ids) : [], r = this.unmark(id);
    for (const el of els) el.animate([{transform: `translateX(${-el.clientWidth}px)`}, {transform: 'none'}], {duration: 200, easing: 'ease-out'});
    return r;
  },
  // Remove the mark from all its rows, or just `only`. Stop the batch when no marks remain.
  dropMark(m, only){
    const {marks, batch} = of(this);
    for (const x of only === undefined ? m.ids : [only]) if (marks.get(x) === m) { marks.delete(x); delete this.leaving[x]; }
    if (only !== undefined) m.ids = m.ids.filter(x => x !== only);
    if (!marks.size) batch.stop();
  },
  /* Remove all marked rows together, then call each mark's `gone`. Skip animation when leaving the screen or hiding
     Pocket (`atOnce`). */
  async clearBatch(atOnce = false){
    const all = [...new Set(of(this).marks.values())].filter(m => !m.going);
    if (!all.length) return;
    for (const m of all) m.going = true;
    const out = all.flatMap(m => (typeof m.out === 'function' ? m.out() : m.out) ?? m.ids);
    const anims = atOnce || !out.length ? [] : await exit(rowsOf(out));
    for (const m of all) this.dropMark(m);
    for (const m of all) m.gone?.();
    // Cancel animations after rendering removes the rows, so any row that stayed becomes visible again.
    if (anims.length) setTimeout(() => anims.forEach(a => { a.cancel(); a.effect.target.style.overflow = ''; }));
  },
  /* Advance a collapsed card sooner when its completed top row appears nowhere else. Clear only single-row marks
     so a parent and its closed subtasks still leave together. The next row enters the same space without collapsing. */
  clearTops(){
    for (const m of new Set(of(this).marks.values())) {
      if (m.going || m.kind !== 'done' || m.ids.length !== 1 || !isTop(m.id)) continue;
      m.going = true;
      this.dropMark(m);
      m.gone?.();
    }
  },
  // Clear immediately when leaving the screen or hiding Pocket.
  clearNow(){ const s = of(this); s.batch.now(); s.tops.now(); this.clearBatch(true); },
  /* Remove the faded hint's spacing after HINT_MS without a touch or scroll. The row returns to its normal height. */
  hintAway(){ of(this).hint.mark(); },
  async closeHint(){
    if (this.hint?.at == null) return;                     // the screen it was on has been left
    if (motion()) await Promise.all([...document.querySelectorAll('.slide-hint')].map(el => {
      el.style.overflow = 'hidden';
      return el.animate([{height: el.offsetHeight + 'px'}, {height: '0px', marginTop: '0px', paddingTop: '0px', paddingBottom: '0px'}],
        {duration: 200, easing: 'ease-in-out', fill: 'forwards'}).finished.catch(() => {});
    }));
    this.hint.at = null;
  },
  /* Hold all batch timers while a pointer is down or any list or sheet scrolls. Restart the wait when both stop. */
  initBatch(){
    const {batch, tops, hint} = of(this), both = [batch, tops, hint];
    document.addEventListener('pointerdown', e => both.forEach(b => b.down(e.pointerId)), true);
    for (const k of ['pointerup', 'pointercancel']) addEventListener(k, e => both.forEach(b => b.up(e.pointerId)), true);
    let still;
    const scroll = on => both.forEach(b => b.scroll(on));
    addEventListener('scroll', () => { scroll(true); clearTimeout(still); still = setTimeout(() => scroll(false), 150); }, {capture: true, passive: true});
  },
};
