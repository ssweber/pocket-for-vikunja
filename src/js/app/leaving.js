/* Ticked and deleted rows stay in place until the batch clears, so rows don't move while the user is tapping.
   Tapping the tick of a done row undoes it, and tapping a deleted row's gap restores it. A row is held from the
   gesture until the save answers (holdRow), then marked with an undo and a `gone` callback (markRow). When the
   batch clears, completed rows leave, repeating tasks show their next dates and held deletions are sent. A
   collapsed card moves on to its next top row sooner (clearTops). Leaving the screen or hiding Pocket clears the
   batch at once. */
import { app, motion } from '../util.js';
import { batchTimer, TOP_MS } from '../batch.js';
import { unmarkedSaid } from '../messages.js';

// The dismissed hint's space is removed this long after the last touch, which is sooner than rows leave.
const HINT_MS = 1000;
/* The batch state is keyed by the `leaving` object, because the markup calls these methods with a row's scope, and
   that scope shares `leaving` with the component. `marks` maps each task id to its mark. `early` holds a promise
   for each row that is held before its mark exists. Separate timers advance collapsed cards and remove the hint's
   space. */
const state = new WeakMap();
const of = c => {
  let s = state.get(c.leaving);
  if (!s)
    state.set(
      c.leaving,
      (s = {
        marks: new Map(),
        early: new Map(),
        batch: batchTimer(() => app.clearBatch()),
        tops: batchTimer(() => app.clearTops(), TOP_MS),
        hint: batchTimer(() => c.closeHint(), HINT_MS),
      }),
    );
  return s;
};
const EXIT_MS = 250;
// Collapse all leaving rows together, so the rows below move once. Returns the animations, which the caller cancels
// after the rows are removed. With reduced motion the rows fade instead.
function exit(els) {
  const hs = els.map(el => el.offsetHeight); // read before any row starts to animate
  return Promise.all(
    els.map((el, i) => {
      el.style.overflow = 'hidden';
      const a = el.animate(
        motion()
          ? [
              { height: hs[i] + 'px', opacity: 1 },
              {
                height: '0px',
                minHeight: '0px',
                opacity: 0,
                paddingTop: '0px',
                paddingBottom: '0px',
                borderTopWidth: '0px',
              },
            ]
          : [{ opacity: 1 }, { opacity: 0 }],
        { duration: motion() ? EXIT_MS : 150, easing: 'ease-in-out', fill: 'forwards' },
      );
      return a.finished.catch(() => {}).then(() => a);
    }),
  );
}
// Find the list rows and cards that can collapse. A collapsed card's top row is replaced in place instead, and a
// sheet keeps its own row.
const rowsOf = ids =>
  ids.flatMap(id => [...document.querySelectorAll(`:is(.row:not(.step-line, .own), .day-card)[data-id="${id}"]`)]);
// Whether task `id`'s only row on the screen is a collapsed card's top row.
const isTop = id => !!document.querySelector(`.row.step-line[data-id="${id}"]`) && !rowsOf([id]).length;

export default {
  /* Mark task `id` and the related `ids` until the batch clears. `out` is the ids whose rows leave, or a function
     that returns them, and defaults to all `ids`. Tapping the tick or Restore calls `undo`. Clearing the batch
     calls `gone`. `said` is announced to screen readers. A new mark for a task replaces its old one. */
  markRow(id, { kind, ids = [id], out, undo = null, gone = null, said = '' }) {
    const { marks, batch, tops } = of(this);
    // A row marked deleted keeps its mark, whose `gone` sends the held delete. Taken into another mark, the delete
    // would wait until Pocket is hidden.
    ids = ids.filter(x => marks.get(x)?.kind !== 'deleted');
    const m = { id, kind, ids, out, undo, gone, going: false };
    for (const x of ids) {
      const old = marks.get(x);
      if (old && old !== m) this.dropMark(old, x);
      marks.set(x, m);
    }
    this.change(w => {
      for (const x of ids) w.leave(x, kind);
    });
    if (said) this.said = said;
    batch.mark();
    if (kind === 'done') tops.mark();
  },
  /* Hold a row in place while its save runs, as the kind of mark that will follow. Without this, a ticked row
     would leave its card during the save and come back when it is marked. Returns a function to call when the
     save answers. By then a mark keeps the row in place, or the save failed and the row goes back to normal. Undo
     and Restore wait for the answer. */
  holdRow(id, kind) {
    const s = of(this);
    if (s.marks.has(id) || s.early.has(id)) return () => {};
    this.change(w => w.leave(id, kind));
    let answered;
    s.early.set(
      id,
      new Promise(ok => {
        answered = ok;
      }),
    );
    return () => {
      s.early.delete(id);
      if (!s.marks.has(id)) this.change(w => w.leave(id));
      answered();
    };
  },
  /* Reserve the deleted row's gap as soon as the user releases the row, until `settled` answers. The gap has to be
     there when the row finishes sliding off, however long the deletion takes. */
  gapNow(id, settled) {
    const letGo = this.holdRow(id, 'deleted');
    Promise.resolve(settled)
      .catch(() => {})
      .then(letGo);
  },
  /* Undo a row's mark, after any pending save has answered. A subtask that was closed together with its parent is
     removed from the parent's mark, so a normal tick can reopen it. Returns false for a normal tick, or true or a
     promise if the mark handled it. */
  unmark(id) {
    const m = of(this).marks.get(id),
      early = of(this).early.get(id);
    if (!m) return early ? early.then(() => this.unmark(id)) : false;
    if (m.going) return true; // the row is already leaving, so it is too late
    if (id !== m.id && m.kind !== 'deleted') {
      this.dropMark(m, id);
      return false;
    }
    this.dropMark(m);
    const title = this.tasks[id]?.title || '';
    this.said = unmarkedSaid(m.kind, title);
    return m.undo?.() || true;
  },
  /* A deleted list row shows as a gap until the batch clears. Sheet headings and checklist screens keep their own
     layout. */
  isGap(t, g) {
    return !g.own && !g.top && !g.run && this.leaving[t.id] === 'deleted';
  },
  // A tap anywhere on the gap restores the row, without also triggering the row's controls.
  tapGap(t, g, e) {
    if (this.isGap(t, g)) {
      e.stopPropagation();
      e.preventDefault();
      this.restoreRow(t.id);
    }
  },
  /* Restore the deleted rows, sliding them in from the left. If the deletion is still waiting for an answer, wait
     for it before undoing the mark. */
  restoreRow(id) {
    const early = of(this).early.get(id);
    if (early) return early.then(() => this.restoreRow(id));
    const m = of(this).marks.get(id);
    const els = m?.kind === 'deleted' && !m.going && motion() ? rowsOf(m.ids) : [],
      r = this.unmark(id);
    for (const el of els)
      el.animate([{ transform: `translateX(${-el.clientWidth}px)` }, { transform: 'none' }], {
        duration: 200,
        easing: 'ease-out',
      });
    return r;
  },
  /* Remove the mark from all its rows, or only from `only`, and show each task as the store has it now: a row marked
     done stays as it was while marked (show, tasks.js). Stops the batch timer when no marks remain. */
  dropMark(m, only) {
    const { marks, batch } = of(this);
    this.change(w => {
      for (const x of only === undefined ? m.ids : [only])
        if (marks.get(x) === m) {
          marks.delete(x);
          w.leave(x);
        }
    });
    if (only !== undefined) m.ids = m.ids.filter(x => x !== only);
    if (!marks.size) batch.stop();
  },
  /* Remove all marked rows together, then call each mark's `gone`. With `atOnce` there is no animation. That is
     used when leaving the screen or hiding Pocket. */
  async clearBatch(atOnce = false) {
    const all = [...new Set(of(this).marks.values())].filter(m => !m.going);
    if (!all.length) return;
    for (const m of all) m.going = true;
    const out = all.flatMap(m => (typeof m.out === 'function' ? m.out() : m.out) ?? m.ids);
    const anims = atOnce || !out.length ? [] : await exit(rowsOf(out));
    for (const m of all) this.dropMark(m);
    for (const m of all) m.gone?.();
    // Cancel the animations after the render removes the rows, so a row that stayed becomes visible again.
    if (anims.length)
      setTimeout(() =>
        anims.forEach(a => {
          a.cancel();
          a.effect.target.style.overflow = '';
        }),
      );
  },
  /* Move a collapsed card on to its next top row early, when its completed top row appears nowhere else. Only marks
     for a single row are cleared, so a parent and its closed subtasks still leave together. The next row takes the
     same space without collapsing. */
  clearTops() {
    for (const m of new Set(of(this).marks.values())) {
      if (m.going || m.kind !== 'done' || m.ids.length !== 1 || !isTop(m.id)) continue;
      m.going = true;
      this.dropMark(m);
      m.gone?.();
    }
  },
  // Clear the batch at once when leaving the screen or hiding Pocket.
  clearNow() {
    const s = of(this);
    s.batch.now();
    s.tops.now();
    this.clearBatch(true);
  },
  /* Remove the faded hint's space after HINT_MS without a touch or scroll. The row then goes back to its normal
     height. */
  hintAway() {
    of(this).hint.mark();
  },
  async closeHint() {
    if (this.hint?.at == null) return; // the screen it was on has been left
    if (motion())
      await Promise.all(
        [...document.querySelectorAll('.slide-hint')].map(el => {
          el.style.overflow = 'hidden';
          return el
            .animate(
              [
                { height: el.offsetHeight + 'px' },
                { height: '0px', marginTop: '0px', paddingTop: '0px', paddingBottom: '0px' },
              ],
              { duration: 200, easing: 'ease-in-out', fill: 'forwards' },
            )
            .finished.catch(() => {});
        }),
      );
    this.hint.at = null;
  },
  /* Pause all the batch timers while a pointer is down or any list or sheet is scrolling. The wait restarts when
     both stop. */
  initBatch() {
    const { batch, tops, hint } = of(this),
      both = [batch, tops, hint];
    document.addEventListener('pointerdown', e => both.forEach(b => b.down(e.pointerId)), true);
    for (const k of ['pointerup', 'pointercancel'])
      addEventListener(k, e => both.forEach(b => b.up(e.pointerId)), true);
    let still;
    const scroll = on => both.forEach(b => b.scroll(on));
    addEventListener(
      'scroll',
      () => {
        scroll(true);
        clearTimeout(still);
        still = setTimeout(() => scroll(false), 150);
      },
      { capture: true, passive: true },
    );
  },
};
