// What a finger does on a row: held, then slid sideways, it sets progress (also on the sheet's bar), or moved up or
// down, it moves the row among its siblings; swiped left, it shows the row's Delete. The last two only where the row's
// list allows them (rowGestures): not on Today.
import {DELETE_W, HOLD_MS, lockDirection, nextSnap, pctOf, slidePct, swipeEnd, SWIPE_PX, swipeOffset, swipeStarts} from '../progress.js';
import {dragPlace} from '../order.js';
import {haptic} from '../haptics.js';

export let sliding = false;                             // a row is held or swiped: the sheet doesn't swipe away meanwhile
let opened = null;                                      // the row swiped open, its Delete showing
// Where the page and the sheet were scrolled to when it opened: scrolled further, it shuts.
const scrolled = () => [scrollY, document.querySelector('#sheet .scroll')?.scrollTop || 0];
let openAt = [0, 0];
let swallowClick = false;
// What a row's list allows it, besides progress: written on the row (data-gestures), as its list's options (`g`) can't
// be reached from its element.
const allows = row => new Set((row.dataset.gestures || '').split(' '));
// The click a hold, a swipe, or a tap that shut a row ends with isn't a tap on the row.
const swallow = () => { swallowClick = true; setTimeout(() => swallowClick = false, 400); };
const shut = (row = opened) => {
  if (!row) return;
  row.classList.remove('swiping', 'swiped', 'swipe-full'); row.style.removeProperty('--swipe');
  if (opened === row) opened = null;
};
/* A row swiped left, as on a phone's mail: it moves with the finger, from where it rests or, open, from its Delete. Let
   go a third of the way across the Delete button, it stays open on it; past half the row, the Delete fills it, a tick
   is felt, and letting go there deletes it (`remove`, which carries it on off the screen: sweep); back under half, it
   doesn't. The Delete isn't in the page's tab order until it's shown: a keyboard or a screen reader deletes from the
   task's ⋯ instead. */
const swipeOf = (row, remove) => ({
  base: opened === row ? -DELETE_W : 0,
  begin(){ if (opened !== row) shut(); row.classList.add('swiping'); },
  move(dx){
    const w = row.clientWidth, to = swipeEnd(swipeOffset(this.base + dx, w), w);
    row.style.setProperty('--swipe', swipeOffset(this.base + dx, w) + 'px');
    row.classList.toggle('swipe-full', to === 'delete');
    if (to !== this.to && this.to !== undefined && to !== 'shut') haptic(to === 'delete' ? 'done' : 'tick');
    this.to = to;
  },
  end(dx){
    const to = dx === null ? 'shut' : swipeEnd(swipeOffset(this.base + dx, row.clientWidth), row.clientWidth);
    if (to === 'delete') { remove(); return; }            // from where the finger left it (sweep)
    row.classList.remove('swiping', 'swipe-full');
    if (to !== 'open') { shut(row); return; }
    row.classList.add('swiped'); row.style.setProperty('--swipe', -DELETE_W + 'px'); opened = row; openAt = scrolled();
  },
});

/* A row deleted by a full swipe, or its Delete tapped, follows through: it carries on to the left, off the screen, the
   red filling the row behind it, and doesn't come back. Its place stays, at its height, as a gap (removeTask,
   `removing`, marks it meanwhile: task-row.html), the red fading into it, holding only "Deleted" and Restore. Only its
   content moves, so nothing around it does. With less motion asked for, it only changes. Resolves to what `removing`
   did: not deleted after all (a question about its subtasks said no), the row fades back in. */
const SWEEP_MS = 200, BACK_MS = 150;
async function sweep(row, removing){
  if (opened === row) opened = null;                      // it's no longer open, for a scroll or a tap elsewhere to shut
  const del = row.querySelector(':scope > .row-del'), w = row.clientWidth, from = parseFloat(row.style.getPropertyValue('--swipe')) || 0;
  const moving = del && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  row.classList.add('swiping', 'swipe-full');
  // The row's offset and the red's width move together, so the red always reaches the list's edge.
  const go = {duration: SWEEP_MS, easing: 'ease-out', fill: 'forwards'}, anims = moving
    ? [row.animate([{transform: `translateX(${from}px)`}, {transform: `translateX(${-w}px)`}], go), del.animate([{width: -from + 'px'}, {width: w + 'px'}], go)] : [];
  const [done] = await Promise.all([removing, ...anims.map(a => a.finished.catch(() => {}))]);
  // Its content back in its place at once, unseen under the gap, not sliding back (.row's transition).
  const red = del && getComputedStyle(del).backgroundColor;
  row.style.transition = 'none'; shut(row); anims.forEach(a => a.cancel());
  void row.offsetWidth; row.style.transition = '';
  if (!moving || !row.isConnected) return done;
  const gap = row.querySelector(':scope > .del-gap'), fade = {duration: BACK_MS, easing: 'ease-out'};
  if (!gap) { row.animate([{opacity: 0}, {opacity: 1}], fade); return done; }
  gap.animate([{backgroundColor: red}, {backgroundColor: getComputedStyle(gap).backgroundColor}], fade);
  for (const el of gap.children) el.animate([{opacity: 0}, {opacity: 1}], fade);
  return done;
}

/* A row moved up or down after the hold, among its siblings: `blocks`, each the rows of one sibling (a task and its
   subtasks under it), in order, the one held `k`. Its rows follow the finger, and the siblings it passes the middle of
   move aside to make room, a tick felt at each (dragPlace). Near the top or the bottom of the screen, or of the sheet
   (`scroller`), the page scrolls on by itself. Let go, every row is put back as it was, and `drop(to)` is told where it
   landed, if it moved, for the list to be drawn in its new order; the held rows then slide into their place. */
const ZONE = 72;                                        // px from an edge where the page scrolls by itself
const dragOf = (blocks, k, scroller, drop, begin) => {
  let boxes, fy = 0, y = 0, at = k, from = 0, frame = null;
  const all = blocks.flat(), mine = blocks[k], list = mine[0].parentElement;
  const top = () => scroller ? scroller.scrollTop : scrollY;
  const view = () => { const r = scroller?.getBoundingClientRect(); return r ? [r.top, r.bottom] : [0, innerHeight - (document.getElementById('capture')?.offsetHeight || 0)]; };
  const place = () => {
    const p = dragPlace(boxes, k, fy + top() - from);
    blocks.forEach((els, i) => { for (const el of els) el.style.transform = i === k ? `translateY(${p.dy}px)` : p.shifts[i] ? `translateY(${p.shifts[i]}px)` : ''; });
    if (p.at !== at) { at = p.at; haptic('tick'); }
  };
  // Held near an edge, the page scrolls, faster the nearer it is, and the rows are placed again.
  const roll = () => {
    const [lo, hi] = view(), v = y < lo + ZONE ? -(lo + ZONE - y) / 6 : y > hi - ZONE ? (y - hi + ZONE) / 6 : 0;
    if (v) { const was = top(); if (scroller) scroller.scrollTop += Math.max(-14, Math.min(14, v)); else scrollBy(0, Math.max(-14, Math.min(14, v))); if (top() !== was) place(); }
    frame = requestAnimationFrame(roll);
  };
  return {
    start(y0){
      begin?.();
      y = y0; from = top();
      boxes = blocks.map(els => { const a = els[0].getBoundingClientRect(), b = els.at(-1).getBoundingClientRect(); return {top: a.top, height: b.bottom - a.top}; });
      list.classList.add('reordering'); for (const el of mine) el.classList.add('dragged');
      frame = requestAnimationFrame(roll);
    },
    move(dy, y1){ fy = dy; y = y1; place(); },
    end(commit){
      cancelAnimationFrame(frame);
      const was = mine.map(el => el.getBoundingClientRect().top);
      for (const el of all) { el.style.transition = 'none'; el.style.transform = ''; }
      list.classList.remove('reordering'); for (const el of mine) el.classList.remove('dragged');
      if (commit && at !== k) drop(at);
      // Drawn in its new order by now: the held rows slide from where they were let go into their place.
      requestAnimationFrame(() => {
        const slide = !matchMedia('(prefers-reduced-motion: reduce)').matches;
        mine.forEach((el, i) => { const d = was[i] - el.getBoundingClientRect().top; if (slide && el.isConnected && Math.abs(d) > 1) el.animate([{transform: `translateY(${d}px)`}, {transform: 'none'}], {duration: 160, easing: 'ease-out'}); });
        for (const el of all) el.style.transition = '';
      });
    },
  };
};

export default {
  /* While sliding, the row is drawn from --slide, not --pct: the screen redraws a row's --pct as it updates (a run's
     steps every second, for their countdowns), which would put the line back to what's saved under the finger. */
  /* A finger on a row, or on a task sheet's progress. find(target) says what it's on, or null: `swipe` if the row can be
     swiped to its Delete (swipeOf), `reorder` if it can be moved (dragOf), and if its progress can be set, {el: the row,
     start, width, show(pct, x: where the finger is), finish(pct, or null if nothing changed)}.
     Moving before the hold ends is a scroll or a tap as usual, or, sideways to the left, the swipe; once the hold has
     ended (a tick is felt, and the row lifts), nothing scrolls or swipes until the finger lifts. The first LOCK_PX it
     moves then decide the way: sideways sets progress, from where it was, in snaps of 25% (slidePct), a tick felt at
     each and a stronger one at 100%. Up or down moves the row (`reorder`: start(y), move(dy, y), end(commit)). A way the
     row can't go lets it go, changing nothing. */
  holdToSlide(area, find){
    let g = null;
    const stop = commit => {
      if (!g) return;
      clearTimeout(g.timer); sliding = false;
      const {s, mode, pct, dx} = g; g = null;
      s.el?.classList.remove('held');
      if (mode === 'swipe') { s.swipe.end(commit ? dx : null); return; }
      if (mode === 'reorder') s.reorder.end(commit);
      if (mode !== 'wait') s.finish?.(commit && mode === 'slide' && pct !== s.start ? pct : null);
    };
    area.addEventListener('pointerdown', e => {
      if (g || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
      swallowClick = false;                             // a new tap: its click is its own
      const s = find(e.target); if (!s) return;
      if (s.swipe?.base) { delete s.show; delete s.reorder; }   // an open row is swiped on, or tapped shut: not held
      g = {s, id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, dx: 0, mode: 'wait', pct: s.start};
      if (s.show || s.reorder) g.timer = setTimeout(() => { g.mode = 'held'; sliding = true; s.el?.classList.add('held'); s.show?.(g.pct, g.x); haptic('hold'); }, HOLD_MS);
    });
    // Moves and the release are followed on the whole window, so a press that ends outside the area still ends.
    addEventListener('pointermove', e => {
      if (!g || e.pointerId !== g.id) return;
      const s = g.s;
      if (g.mode === 'wait') {
        const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
        if (Math.hypot(dx, dy) <= SWIPE_PX) { g.x = e.clientX; g.y = e.clientY; return; }
        // Not a swipe it can take (none on Today, or to the right): a sideways move does nothing, not even open the task
        // where a mouse lets go; up or down is a scroll.
        if (!s.swipe || !swipeStarts(dx, dy, g.x0, innerWidth, !!s.swipe.base)) { if (Math.abs(dx) > Math.abs(dy)) swallow(); stop(false); return; }
        clearTimeout(g.timer); g.mode = 'swipe'; sliding = true; s.swipe.begin();
      }
      if (g.mode === 'swipe') { g.dx = e.clientX - g.x0; s.swipe.move(g.dx); return; }
      if (g.mode === 'held') {
        const way = lockDirection(e.clientX - g.x, e.clientY - g.y);
        if (!way) return;
        if (!(way === 'x' ? s.show : s.reorder)) { swallow(); stop(false); return; }
        g.mode = way === 'x' ? 'slide' : 'reorder';
        if (g.mode === 'reorder') s.reorder.start(e.clientY);
      }
      if (g.mode === 'reorder') { s.reorder.move(e.clientY - g.y, e.clientY); return; }
      const pct = slidePct({start: s.start, dx: e.clientX - g.x, x: g.x, width: s.width, screen: innerWidth});
      if (pct !== g.pct) { g.pct = pct; s.show(pct, e.clientX); haptic(pct === 100 ? 'done' : 'tick'); }
    });
    addEventListener('pointerup', e => {
      if (!g || e.pointerId !== g.id) return;
      if (g.mode === 'wait' && g.s.swipe?.base) shut();   // an open row tapped: it only shuts
      if (g.mode !== 'wait' || g.s.swipe?.base) swallow();
      stop(true);
    });
    addEventListener('pointercancel', e => { if (g && e.pointerId === g.id) stop(false); });
    // While held or swiped, nothing scrolls, and a long press doesn't open the browser's menu.
    area.addEventListener('touchmove', e => { if (g && g.mode !== 'wait') e.preventDefault(); }, {passive: false});
    area.addEventListener('contextmenu', e => { if (g) e.preventDefault(); });
    area.addEventListener('click', e => { if (swallowClick) { swallowClick = false; e.preventDefault(); e.stopPropagation(); } }, true);
  },
  // What's being set, filled to `pct`, with its percentage on the side away from the finger (at `x`). The percentage
  // pulses at each snap, the tick seen (where it can't be felt), and at 100% the tick fills.
  showSlide(el, pct, x){
    if (el.dataset.pct && el.dataset.pct !== pct + '%') el.dataset.tick = el.dataset.tick === 'a' ? 'b' : 'a';
    el.classList.add('setting'); el.classList.toggle('full', pct >= 100);
    el.style.setProperty('--slide', pct / 100); el.dataset.pct = pct + '%';
    const r = el.getBoundingClientRect();
    el.dataset.side = x > r.left + r.width / 2 ? 'left' : 'right';
  },
  endSlide(el){ el.classList.remove('setting', 'full'); delete el.dataset.tick; delete el.dataset.pct; },
  // In the list: the row fills, and at 100% the task is done. A run's step the same, through the outbox.
  initProgressDrag(){
    // A row swiped open shuts again when anything else is touched, or anything scrolls. (Touched itself, it's swiped on,
    // or tapped shut: holdToSlide.)
    document.addEventListener('pointerdown', e => { if (opened && !opened.contains(e.target)) shut(); }, true);
    addEventListener('scroll', () => { if (opened && !sliding && scrolled().some((y, i) => Math.abs(y - openAt[i]) > 10)) shut(); }, {capture: true, passive: true});
    this.holdToSlide(document.getElementById('view'), target => {
      const row = target.closest('.list:not(.tree) > .row');
      if (!row || target.closest('.row-del')) return null;
      if (row.parentElement.id === 'run-steps') return this.stepSlide(row, target);
      const t = this.rowTask(+row.dataset.id);
      return t && this.rowGesture(t, row, false);
    });
  },
  /* A task's row, in a list or (sheet) a task's sheet. Held and slid, its progress: not one done, waiting to be sent, or
     that can't be ticked, nor a run (its progress is its steps), nor a step in a run's sheet. Where its list allows
     (allows), held and moved up or down, its place among its siblings (reorderOf), and swiped, its Delete: on Today,
     neither (screenRows). */
  rowGesture(t, row, sheet){
    if (this.lines[t.id] || this.leaving[t.id]) return null;   // a line in its place, or marked done or deleted: only its tap
    const slides = !t.pending && !t.done && (sheet ? this.canWrite(t.project_id) && this.checklistRole !== 'run' : this.canTick(t) && !this.isRunTask(t));
    const can = allows(row), swipe = can.has('delete') && this.canDelete(t, sheet) ? swipeOf(row, () => this.swipeDelete(t, sheet, row)) : null;
    const reorder = can.has('reorder') ? this.reorderOf(t, row, sheet) : null;
    if (!slides) return (swipe || reorder) && {el: row, swipe, reorder};
    return {el: row, swipe, reorder, start: pctOf(t), width: row.clientWidth,
      show: (pct, x) => this.showSlide(row, pct, x),
      finish: pct => {
        if (pct !== null) { this.setProgress(t, pct, sheet ? null : row, {sub: sheet || undefined}); if (sheet) this.sheet.dirty = true; else this.aimAfterTick(t); }
        this.endSlide(row);
        row.style.setProperty('--pct', t.done ? 0 : this.shownPct(t) / 100);
      }};
  },
  /* A task's row moved up or down, among its siblings (orderOf): on a project's list, or in a task's sheet. Let go
     somewhere else, it's moved there (reorder). */
  reorderOf(t, row, sheet){
    const o = this.orderOf(t, sheet ? 'sheet' : 'list');
    if (!o || o.sibs.length < 2) return null;
    const box = row.parentElement, rows = id => [...box.querySelectorAll(`:scope > .row[data-id="${id}"]`)];
    const blocks = (o.blocks || o.sibs.map(s => ({ids: [s.id]}))).map(b => b.ids.flatMap(rows));
    if (blocks.some(b => !b.length)) return null;
    return dragOf(blocks, o.sibs.findIndex(s => s.id === t.id), sheet ? this.$refs.sheet.querySelector('.scroll') : null,
      to => this.reorder(t, o.sibs, to, o.view), () => this.endSlide(row));
  },
  // A template's step held and moved up or down: its place in the template's order line (moveStep). Not while a step
  // is being changed, or the template is saving.
  stepReorder(row, target){
    const i = this.subtasks.findIndex(s => String(s.id) === row.dataset.id);
    if (i < 0 || this.subtasks.length < 2 || !this.canEdit || this.sheet.stepEdit || this.sheet.checklistBusy || target.closest('button:not(.body)')) return null;
    const blocks = this.subtasks.map(s => [...row.parentElement.querySelectorAll(`:scope > .row[data-id="${s.id}"]`)]);
    if (blocks.some(b => !b.length)) return null;
    return {el: row, reorder: dragOf(blocks, i, this.$refs.sheet.querySelector('.scroll'), to => this.moveStep(i, to - i, true))};
  },
  /* A row's Delete, tapped once it's swiped open (a tick felt then), or a full swipe let go (felt as it passed half): the
     row carries on off the screen, leaving a gap at its height with Restore (sweep, removeTask). */
  async swipeDelete(t, sheet, row = null){
    if (!row) { row = opened; haptic('done'); }
    const removing = this.removeTask(t);
    if (await (row ? sweep(row, removing) : removing) && sheet) this.sheet.dirty = true;
  },
  // A run's step held on its row: not one done, waiting to be sent, or in a finished run, nor from its buttons.
  stepSlide(row, target){
    const v = this.runView, s = v?.steps.find(x => String(x.id) === row.dataset.id);
    if (!s || s.done || s.pending || v.finished || !this.canWrite(this.view.run.run.project_id) || target.closest('button:not(.body)')) return null;
    return {el: row, start: s.pct, width: row.clientWidth,
      show: (pct, x) => this.showSlide(row, pct, x),
      finish: pct => { this.endSlide(row); if (pct !== null) this.stepProgress(s, pct); }};
  },
  // In a task's sheet: hold the progress bar, or around the title (not its text, where a long press selects); and its
  // subtasks' rows, as in a list.
  initSheetProgress(){
    this.holdToSlide(this.$refs.sheet, target => {
      const t = this.sheet.task, row = target.closest('#d-subtasks > .row[data-id]:not(.pending)');
      if (row) {
        if (this.checklistRole === 'template') return this.stepReorder(row, target);
        const st = !target.closest('.row-del') && this.subtasks.find(s => String(s.id) === row.dataset.id);
        return st ? this.rowGesture(st, row, true) : null;
      }
      const head = target.closest('.d-head');
      if (!head || !t || this.isRunTask(t) || this.ofTemplate || target.closest('textarea, button, a, select')) return null;
      return {start: this.shownPct(t), width: head.clientWidth,
        show: (pct, x) => { this.sheet.pct = pct; this.showSlide(head, pct, x); },
        finish: pct => {
          this.endSlide(head); this.sheet.pct = null;
          if (pct !== null && this.sheet.task === t) this.sheetProgress(t, pct);
        }};
    });
  },
  nudgeProgress(dir){                            // the arrow keys, on the focused bar: to the next snap
    const t = this.sheet.task;
    if (this.isRunTask(t)) return;
    const was = pctOf(t), pct = nextSnap(was, dir);
    if (pct !== was) this.sheetProgress(t, pct);
  },
};
