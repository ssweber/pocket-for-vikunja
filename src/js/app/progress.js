// Holding a row, or the sheet's bar, and sliding to set progress.
import {HOLD_MS, pctOf} from '../progress.js';

const EDGE = 48;                                        // px short of the screen's edge where 100% (or 0%) is reached
export let sliding = false;                             // progress is being set: the sheet doesn't swipe away meanwhile

export default {
  rowTask(id){
    for (const g of this.view.groups) for (const t of g.tasks) if (t.id === id) return t;
    return null;
  },
  /* While sliding, the row is drawn from --slide, not --pct: the screen redraws a row's --pct as it updates (a run's
     steps every second, for their countdowns), which would put the line back to what's saved under the finger. */
  /* Hold, then slide sideways: how progress is set, on a list row and on a task's sheet. It moves from where it was, in
     steps of 10%, like a volume bar. The room the finger has is the rest of the way: from 60% held on the right of a
     row, 100% is still within reach. It ends a touch target (EDGE) short of the screen's edge, clear of the phone's own
     edge gestures and easy for a thumb; past it stays at 100% (or 0%). At least a quarter of the row's width, so a
     little room isn't jumpy, but never more than the finger has before the edge: held near it, 100% (or 0%) is still
     reached, closer to the edge. Moving before the hold ends
     is a scroll, a swipe or a tap as usual; once it has ended, nothing scrolls or swipes until the finger lifts.
     find(target) says what was held: {start, width, show(pct, x: where the finger is), finish(pct, or null if nothing
     changed)}, or null. */
  holdToSlide(area, find){
    let g = null, swallowClick = false;
    const stop = commit => {
      if (!g) return;
      clearTimeout(g.timer); sliding = false;
      const {s, on, pct} = g; g = null;
      s.finish(on && commit && pct !== s.start ? pct : null);
    };
    area.addEventListener('pointerdown', e => {
      if (g || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
      const s = find(e.target); if (!s) return;
      g = {s, id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, on: false, pct: s.start};
      g.timer = setTimeout(() => { g.on = true; sliding = true; s.show(g.pct, g.x); navigator.vibrate?.(10); }, HOLD_MS);
    });
    // Moves and the release are followed on the whole window, so a press that ends outside the area still ends.
    addEventListener('pointermove', e => {
      if (!g || e.pointerId !== g.id) return;
      if (!g.on) { if (Math.hypot(e.clientX - g.x0, e.clientY - g.y0) > 8) stop(false); else g.x = e.clientX; return; }
      const dx = e.clientX - g.x, edge = dx > 0 ? innerWidth - g.x : g.x, room = Math.max(edge - EDGE, Math.min(g.s.width * .25, edge * .75), 1);
      const pct = Math.max(0, Math.min(100, g.s.start + Math.round(dx / room * (dx > 0 ? 100 - g.s.start : g.s.start) / 10) * 10));
      if (pct !== g.pct) { g.pct = pct; g.s.show(pct, e.clientX); navigator.vibrate?.(5); }
    });
    addEventListener('pointerup', e => {
      if (!g || e.pointerId !== g.id) return;
      if (g.on) { swallowClick = true; setTimeout(() => swallowClick = false, 400); }   // the release isn't a tap
      stop(true);
    });
    addEventListener('pointercancel', e => { if (g && e.pointerId === g.id) stop(false); });
    // While sliding, nothing scrolls, and a long press doesn't open the browser's menu.
    area.addEventListener('touchmove', e => { if (g?.on) e.preventDefault(); }, {passive: false});
    area.addEventListener('contextmenu', e => { if (g) e.preventDefault(); });
    area.addEventListener('click', e => { if (swallowClick) { swallowClick = false; e.preventDefault(); e.stopPropagation(); } }, true);
  },
  // What's being set, filled to `pct`, with its percentage on the side away from the finger (at `x`).
  showSlide(el, pct, x){
    el.classList.add('setting'); el.style.setProperty('--slide', pct / 100); el.dataset.pct = pct + '%';
    const r = el.getBoundingClientRect();
    el.dataset.side = x > r.left + r.width / 2 ? 'left' : 'right';
  },
  // In the list: the row fills, and at 100% the task is done and slides away. A run's step the same, through the outbox.
  initProgressDrag(){
    this.holdToSlide(document.getElementById('view'), target => {
      const row = target.closest('.list:not(.tree) > .row');
      if (row && row.parentElement.id === 'run-steps') return this.stepSlide(row, target);
      const t = row && this.rowTask(+row.dataset.id);
      if (!t || t.pending || t.done || !this.canTick(t) || this.isRunTask(t)) return null;
      return {start: Math.round(pctOf(t) / 10) * 10, width: row.clientWidth,
        show: (pct, x) => this.showSlide(row, pct, x),
        finish: pct => {
          if (pct !== null) this.setProgress(t, pct, row);
          row.classList.remove('setting');
          row.style.setProperty('--pct', t.done ? 0 : this.shownPct(t) / 100);
        }};
    });
  },
  // A run's step held on its row: not one done, waiting to be sent, or in a finished run, nor from its buttons.
  stepSlide(row, target){
    const v = this.runView, s = v?.steps.find(x => String(x.id) === row.dataset.id);
    if (!s || s.done || s.pending || v.finished || !this.canWrite(this.view.run.run.project_id) || target.closest('button:not(.body)')) return null;
    return {start: Math.round(s.pct / 10) * 10, width: row.clientWidth,
      show: (pct, x) => this.showSlide(row, pct, x),
      finish: pct => { row.classList.remove('setting'); if (pct !== null) this.stepProgress(s, pct); }};
  },
  // In a task's sheet: hold the progress bar, or around the title (not its text, where a long press selects).
  initSheetProgress(){
    this.holdToSlide(this.$refs.sheet, target => {
      const head = target.closest('.d-head'), t = this.sheet.task;
      if (!head || !t || this.isRunTask(t) || this.ofTemplate || target.closest('textarea, button, a, select')) return null;
      return {start: Math.round(this.shownPct(t) / 10) * 10, width: head.clientWidth,
        show: (pct, x) => { this.sheet.pct = pct; this.showSlide(head, pct, x); },
        finish: pct => {
          head.classList.remove('setting'); this.sheet.pct = null;
          if (pct !== null && this.sheet.task === t) this.sheetProgress(t, pct);
        }};
    });
  },
};
