// Holding a row, or the sheet's bar, and sliding to set progress.
import {NetError} from '../api.js';
import {HOLD_MS, pctOf, progressPatch} from '../progress.js';

export let sliding = false;                             // progress is being set: the sheet doesn't swipe away meanwhile

export default {
  rowTask(id){
    for (const g of this.view.groups) for (const t of g.tasks) if (t.id === id) return t;
    return null;
  },
  // Progress set in the list. At 100% the task is done and slides away, as when it's ticked off.
  // `undoing`: putting back what it was, exactly, without marking it done.
  async setProgress(t, pct, rowEl, undoing = false){
    const was = pctOf(t), patch = undoing ? {percent_done: pct / 100} : progressPatch(t, pct);
    if (patch.done) return this.toggleDone(t, rowEl, patch, {percent_done: was / 100});
    t.percent_done = patch.percent_done;
    try {
      await this.saveTask(t.id, patch);
      if (!undoing) this.notify(`Progress set to ${pct}%`, {label: 'Undo', fn: () => this.setProgress(t, was, null, true)});
    } catch (e) {
      t.percent_done = was / 100;
      this.notify(e instanceof NetError ? 'Offline — not saved' : 'Not saved: ' + e.message);
    }
  },
  /* Hold, then slide sideways: how progress is set, on a list row and on a task's sheet. It moves from where it was, in
     steps of 10%, like a volume bar; sliding across most of the width goes from 0% to 100%. Moving before the hold ends
     is a scroll, a swipe or a tap as usual; once it has ended, nothing scrolls or swipes until the finger lifts.
     find(target) says what was held: {start, width, show(pct), finish(pct, or null if nothing changed)}, or null. */
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
      g.timer = setTimeout(() => { g.on = true; sliding = true; s.show(g.pct); navigator.vibrate?.(10); }, HOLD_MS);
    });
    // Moves and the release are followed on the whole window, so a press that ends outside the area still ends.
    addEventListener('pointermove', e => {
      if (!g || e.pointerId !== g.id) return;
      if (!g.on) { if (Math.hypot(e.clientX - g.x0, e.clientY - g.y0) > 8) stop(false); else g.x = e.clientX; return; }
      const pct = Math.max(0, Math.min(100, g.s.start + Math.round((e.clientX - g.x) / (g.s.width * .8) * 10) * 10));
      if (pct !== g.pct) { g.pct = pct; g.s.show(pct); navigator.vibrate?.(5); }
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
  // In the list: the row fills, and at 100% the task is done and slides away.
  initProgressDrag(){
    this.holdToSlide(document.getElementById('view'), target => {
      const row = target.closest('.list:not(.tree) > .row');
      const t = row && this.rowTask(+row.dataset.id);
      if (!t || t.pending || t.done || !this.canTick(t) || this.isRunTask(t)) return null;
      return {start: Math.round(pctOf(t) / 10) * 10, width: row.clientWidth,
        show: pct => { row.classList.add('setting'); row.style.setProperty('--pct', pct / 100); row.dataset.pct = pct + '%'; },
        finish: pct => {
          if (pct !== null) this.setProgress(t, pct, row);
          row.classList.remove('setting');
          row.style.setProperty('--pct', t.done ? 0 : this.shownPct(t) / 100);
        }};
    });
  },
  // In a task's sheet: hold the progress bar, or around the title (not its text, where a long press selects).
  initSheetProgress(){
    this.holdToSlide(this.$refs.sheet, target => {
      const head = target.closest('.d-head'), t = this.sheet.task;
      if (!head || !t || this.isRunTask(t) || this.ofTemplate || target.closest('textarea, button, a, select')) return null;
      return {start: Math.round(pctOf(t) / 10) * 10, width: head.clientWidth,
        show: pct => { this.sheet.pct = pct; head.classList.add('setting'); head.style.setProperty('--pct', pct / 100); head.dataset.pct = pct + '%'; },
        finish: pct => {
          head.classList.remove('setting'); this.sheet.pct = null;
          if (pct !== null && this.sheet.task === t) this.sheetProgress(t, pct);
        }};
    });
  },
};
