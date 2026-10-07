// What a finger does on a row: held, then slid sideways, it sets progress (also on the sheet's bar); swiped left, it
// shows the row's Delete.
import {DELETE_W, HOLD_MS, lockDirection, nextSnap, pctOf, slidePct, swipeEnd, SWIPE_PX, swipeOffset, swipeStarts} from '../progress.js';
import {haptic} from '../haptics.js';

export let sliding = false;                             // a row is held or swiped: the sheet doesn't swipe away meanwhile
let opened = null;                                      // the row swiped open, its Delete showing
// Where the page and the sheet were scrolled to when it opened: scrolled further, it shuts.
const scrolled = () => [scrollY, document.querySelector('#sheet .scroll')?.scrollTop || 0];
let openAt = [0, 0];
let swallowClick = false;
// The click a hold, a swipe, or a tap that shut a row ends with isn't a tap on the row.
const swallow = () => { swallowClick = true; setTimeout(() => swallowClick = false, 400); };
const shut = (row = opened) => {
  if (!row) return;
  row.classList.remove('swiping', 'swiped', 'swipe-full'); row.style.removeProperty('--swipe');
  if (opened === row) opened = null;
};
/* A row swiped left, as on a phone's mail: it moves with the finger, from where it rests or, open, from its Delete. Let
   go a third of the way across the Delete button, it stays open on it; past half the row, the Delete fills it, a tick
   is felt, and letting go there deletes it (`remove`); back under half, it doesn't. The Delete isn't in the page's tab
   order until it's shown: a keyboard or a screen reader deletes from the task's ⋯ instead. */
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
    row.classList.remove('swiping', 'swipe-full');
    const to = dx === null ? 'shut' : swipeEnd(swipeOffset(this.base + dx, row.clientWidth), row.clientWidth);
    if (to !== 'open') { shut(row); if (to === 'delete') remove(); return; }
    row.classList.add('swiped'); row.style.setProperty('--swipe', -DELETE_W + 'px'); opened = row; openAt = scrolled();
  },
});

export default {
  /* While sliding, the row is drawn from --slide, not --pct: the screen redraws a row's --pct as it updates (a run's
     steps every second, for their countdowns), which would put the line back to what's saved under the finger. */
  /* A finger on a row, or on a task sheet's progress. find(target) says what it's on, or null: `swipe` if the row can be
     swiped to its Delete (swipeOf), and if its progress can be set, {el: the row, start, width, show(pct, x: where the
     finger is), finish(pct, or null if nothing changed)}.
     Moving before the hold ends is a scroll or a tap as usual, or, sideways to the left, the swipe; once the hold has
     ended (a tick is felt, and the row lifts), nothing scrolls or swipes until the finger lifts. The first LOCK_PX it
     moves then decide the way: sideways sets progress, from where it was, in snaps of 25% (slidePct), a tick felt at
     each and a stronger one at 100%. Up or down is for reordering: find() gives `reorder`, {start(), move(dy),
     end(commit)}, where a row can be moved (Order, in the plan); anywhere else it lets go, changing nothing. */
  holdToSlide(area, find){
    let g = null;
    const stop = commit => {
      if (!g) return;
      clearTimeout(g.timer); sliding = false;
      const {s, mode, pct, dx} = g; g = null;
      s.el?.classList.remove('held');
      if (mode === 'swipe') { s.swipe.end(commit ? dx : null); return; }
      if (mode === 'reorder') s.reorder.end(commit);
      if (mode !== 'wait') s.finish(commit && mode === 'slide' && pct !== s.start ? pct : null);
    };
    area.addEventListener('pointerdown', e => {
      if (g || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
      const s = find(e.target); if (!s) return;
      if (s.swipe?.base) delete s.show;                 // an open row is swiped on, or tapped shut: not held
      g = {s, id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, dx: 0, mode: 'wait', pct: s.start};
      if (s.show) g.timer = setTimeout(() => { g.mode = 'held'; sliding = true; s.el?.classList.add('held'); s.show(g.pct, g.x); haptic('hold'); }, HOLD_MS);
    });
    // Moves and the release are followed on the whole window, so a press that ends outside the area still ends.
    addEventListener('pointermove', e => {
      if (!g || e.pointerId !== g.id) return;
      const s = g.s;
      if (g.mode === 'wait') {
        const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
        if (Math.hypot(dx, dy) <= SWIPE_PX) { g.x = e.clientX; g.y = e.clientY; return; }
        if (!s.swipe || !swipeStarts(dx, dy, g.x0, innerWidth, !!s.swipe.base)) { stop(false); return; }
        clearTimeout(g.timer); g.mode = 'swipe'; sliding = true; s.swipe.begin();
      }
      if (g.mode === 'swipe') { g.dx = e.clientX - g.x0; s.swipe.move(g.dx); return; }
      if (g.mode === 'held') {
        const way = lockDirection(e.clientX - g.x, e.clientY - g.y);
        if (!way) return;
        if (way === 'y' && !s.reorder) { swallow(); stop(false); return; }
        g.mode = way === 'x' ? 'slide' : 'reorder';
        if (g.mode === 'reorder') s.reorder.start();
      }
      if (g.mode === 'reorder') { s.reorder.move(e.clientY - g.y); return; }
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
     that can't be ticked, nor a run (its progress is its steps), nor a step in a run's sheet. Swiped, its Delete. */
  rowGesture(t, row, sheet){
    if (this.lines[t.id]) return null;                    // a line in its place: only its Undo
    const slides = !t.pending && !t.done && (sheet ? this.canWrite(t.project_id) && this.checklistRole !== 'run' : this.canTick(t) && !this.isRunTask(t));
    const swipe = this.canDelete(t, sheet) ? swipeOf(row, () => this.swipeDelete(t, sheet)) : null;
    if (!slides) return swipe && {swipe};
    return {el: row, swipe, start: pctOf(t), width: row.clientWidth,
      show: (pct, x) => this.showSlide(row, pct, x),
      finish: pct => {
        if (pct !== null) { this.setProgress(t, pct, sheet ? null : row, {sub: sheet || undefined}); if (sheet) this.sheet.dirty = true; }
        this.endSlide(row);
        row.style.setProperty('--pct', t.done ? 0 : this.shownPct(t) / 100);
      }};
  },
  // A row's Delete, once it's swiped open: the row closes as its line takes its place.
  async swipeDelete(t, sheet){ shut(); if (await this.removeTask(t) && sheet) this.sheet.dirty = true; },
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
        const st = this.checklistRole !== 'template' && !target.closest('.row-del') && this.subtasks.find(s => String(s.id) === row.dataset.id);
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
