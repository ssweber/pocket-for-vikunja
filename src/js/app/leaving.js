/* Done and deleted, in place: a row ticked done, not done again, or deleted keeps its height and its place until the
   batch clears (batch.js), so nothing moves under a finger; then every row waiting goes at once, and the rows below
   close up once. Meanwhile the mark can be taken back from the row itself: its tick opens it again (or ticks it again),
   and a deleted row, a gap at its height holding only Restore, is restored by a tap anywhere on it; a row done by a
   full swipe is the same gap, holding Undo (`gap`, kept in `swept`). So it needs no Undo of its own. What happens when
   the batch clears is each mark's `gone`: a ticked row leaves Today, moves between Open and Done in search and a
   project, a repeating task shows its next date, a deletion is sent (held in the outbox until then: holdDelete).
   Leaving the screen, or putting Pocket away, clears it at once. A screen reader hears each mark from #said. */
import {app} from '../util.js';
import {batchTimer} from '../batch.js';

// The hint's space closes this long after it's put away, from when the finger lifts: sooner than rows leaving, as
// nothing else is waiting on it.
const HINT_MS = 1000;
/* Each component's marks (task id -> its mark; the rows shown with a mark point to the same one) and its batch, kept
   by its `leaving`: `this` in a method called from the markup is the row's scope, not the component, but `leaving` is
   the same object from either. `hint`: when the one-time hint, put away, gives its space back (closeHint), on the
   component that first asked (initBatch, as Pocket starts). */
const state = new WeakMap();
const of = c => {
  let s = state.get(c.leaving);
  if (!s) state.set(c.leaving, s = {marks: new Map(), batch: batchTimer(() => app.clearBatch()), hint: batchTimer(() => c.closeHint(), HINT_MS)});
  return s;
};
const EXIT_MS = 250;
const motion = () => !matchMedia('(prefers-reduced-motion: reduce)').matches;
// The rows leaving go together: each folds to nothing at once, so the rows below close up in one movement. With less
// motion asked for, they only fade. Resolves to the animations, to be taken off once the rows are gone.
function exit(els){
  const hs = els.map(el => el.offsetHeight);                // read before any of them starts to move
  return Promise.all(els.map((el, i) => {
    el.style.overflow = 'hidden';
    const a = el.animate(motion() ? [{height: hs[i] + 'px', opacity: 1}, {height: '0px', minHeight: '0px', opacity: 0, paddingTop: '0px', paddingBottom: '0px', borderTopWidth: '0px'}]
      : [{opacity: 1}, {opacity: 0}], {duration: motion() ? EXIT_MS : 150, easing: 'ease-in-out', fill: 'forwards'});
    return a.finished.catch(() => {}).then(() => a);
  }));
}
// A task's rows, and its card. Not a collapsed card's top row (.step-line): it doesn't fold, the next slides up into its
// place (cardEntered).
const rowsOf = ids => ids.flatMap(id => [...document.querySelectorAll(`:is(.row:not(.step-line), .day-card)[data-id="${id}"]`)]);

export default {
  /* Task `id`'s row marked, until the batch clears: {kind: 'done', 'open' (not done again) or 'deleted'; ids: the rows
     shown with it (the subtasks closed with a task, or deleted with it); out: those that leave when it clears (all of
     them unless said; a function, to be worked out then); undo: what its tick (or Restore) does meanwhile; gone: what's
     done when it clears; said: for a screen reader; gap: done by a full swipe, its row (`id`'s, not those shown with it)
     a gap at its height holding "Done" and Undo, as a deleted one's holds Restore}. A row marked again keeps only the
     new mark. */
  markRow(id, {kind, ids = [id], out, undo = null, gone = null, said = '', gap = false}){
    const {marks, batch} = of(this), m = {id, kind, ids, out, undo, gone, going: false};
    for (const x of ids) { const old = marks.get(x); if (old && old !== m) this.dropMark(old, x); marks.set(x, m); this.leaving[x] = kind; }
    if (gap) this.swept[id] = true;
    if (said) this.said = said;
    batch.mark();
  },
  /* A marked row's tick, or a deleted row tapped: the mark taken back (its undo), and it doesn't go. A subtask that was
     closed with its parent is only taken out of the parent's mark: its tick then opens it as any other. Returns whether
     the tap was the mark's: its undo's promise, if it has one. */
  unmark(id){
    const m = of(this).marks.get(id);
    if (!m) return false;
    if (m.going) return true;                              // on its way out: too late
    if (id !== m.id && m.kind !== 'deleted') { this.dropMark(m, id); return false; }
    this.dropMark(m);
    const title = this.tasks[id]?.title || '';
    this.said = m.kind === 'deleted' ? 'Restored: ' + title : m.kind === 'done' ? 'Not done: ' + title : 'Done: ' + title;
    return m.undo?.() || true;
  },
  /* A gap tapped: a deleted row restored (unmark), its rows sliding back in from the left, where the delete took them;
     a row done by a full swipe not done again, sliding back in from the right. */
  restoreRow(id){
    const m = of(this).marks.get(id), back = m?.kind === 'deleted' ? -1 : 1;
    const els = m && !m.going && motion() ? back < 0 ? rowsOf(m.ids) : [...document.querySelectorAll(`.row[data-id="${id}"]`)] : [], r = this.unmark(id);
    for (const el of els) el.animate([{transform: `translateX(${back * el.clientWidth}px)`}, {transform: 'none'}], {duration: 200, easing: 'ease-out'});
    return r;
  },
  // A mark taken off its rows (or off row `only`); with none left waiting, the batch has nothing to clear.
  dropMark(m, only){
    const {marks, batch} = of(this);
    for (const x of only === undefined ? m.ids : [only]) if (marks.get(x) === m) { marks.delete(x); delete this.leaving[x]; delete this.swept[x]; }
    if (only !== undefined) m.ids = m.ids.filter(x => x !== only);
    if (!marks.size) batch.stop();
  },
  /* The batch clears: every marked row that leaves goes at once, then what each mark was for is done. `atOnce`: the
     screen is being left, or Pocket put away, so with no motion. */
  async clearBatch(atOnce = false){
    const all = [...new Set(of(this).marks.values())].filter(m => !m.going);
    if (!all.length) return;
    for (const m of all) m.going = true;
    const out = all.flatMap(m => (typeof m.out === 'function' ? m.out() : m.out) ?? m.ids);
    const anims = atOnce || !out.length ? [] : await exit(rowsOf(out));
    for (const m of all) this.dropMark(m);
    for (const m of all) m.gone?.();
    // The rows are off the list by the next turn; one that stayed (it wasn't for this list after all) comes back.
    if (anims.length) setTimeout(() => anims.forEach(a => { a.cancel(); a.effect.target.style.overflow = ''; }));
  },
  // Leaving the screen, or Pocket put away: the batch clears at once.
  clearNow(){ of(this).batch.now(); this.clearBatch(true); },
  /* The one-time hint put away (hintSeen, progress.js): it has faded, keeping its space, and gives it back by the
     batch's rules, never under a finger or while the list scrolls: HINT_MS after the finger lifts, its row closing to
     its own height, the rows below with it (with less motion, at once). */
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
  /* What holds the batch back (and the hint's space closing): a finger down anywhere, and the list (or a sheet)
     scrolling. Each starts its wait again once it's over. */
  initBatch(){
    const {batch, hint} = of(this), both = [batch, hint];
    document.addEventListener('pointerdown', e => both.forEach(b => b.down(e.pointerId)), true);
    for (const k of ['pointerup', 'pointercancel']) addEventListener(k, e => both.forEach(b => b.up(e.pointerId)), true);
    let still;
    const scroll = on => both.forEach(b => b.scroll(on));
    addEventListener('scroll', () => { scroll(true); clearTimeout(still); still = setTimeout(() => scroll(false), 150); }, {capture: true, passive: true});
  },
};
