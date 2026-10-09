// What a finger does on a row (parent-tasks-plan, part 1): swiped right, its progress goes up, and a full swipe is done
// (also on the sheet's bar); swiped left, it goes down, and past 0% on into the row's Delete, one track (trackAt); held,
// then moved up or down, the row moves among its siblings. Delete and moving only where the row's list allows them
// (rowGestures): Today's rows are deleted but not moved, search's the same, a project's and a sheet's both.
import {DELETE_W, HOLD_MS, isNudge, lockDirection, nextSnap, pctOf, releaseSpeed, swipeEnd, SWIPE_PX, SWIPE_SLOPE, swipeOffset, swipeStarts, trackAt, trackMoves} from '../progress.js';
import {dragPlace} from '../order.js';
import {haptic} from '../haptics.js';
import {store} from '../util.js';

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
// A row held, swiped or paged is a gesture, not text: no selection starts meanwhile, anywhere the finger goes (the
// phone's long press would otherwise select the words under it, or the nearest it can, around a sheet's subtasks), and
// one made is cleared as the hold ends and as the row moves. One function, so it's added once.
const noSelect = e => { if (sliding) e.preventDefault(); };
const shut = (row = opened) => {
  if (!row) return;
  row.classList.remove('swiping', 'swiped', 'swipe-full'); row.style.removeProperty('--swipe');
  if (opened === row) opened = null;
};
/* A row swiped left past 0% (trackAt), as on a phone's mail: it moves with the finger, from where it rests or, open,
   from its Delete. Let go a third of the way across the Delete button, it stays open on it; past half the row, the
   Delete fills it, a tick is felt, and letting go there deletes it (`remove`, which carries it on off the screen:
   sweep); back under half, it doesn't. The Delete isn't in the page's tab order until it's shown: a keyboard or a
   screen reader deletes from the task's ⋯ instead. */
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
     swiped to its Delete (swipeOf), `reorder` if it can be held and moved (dragOf), and if its progress can be set, {el:
     the row, start (a done one's 100), width, show(pct, x: where the finger is), begin() as its progress starts to move,
     finish(pct, or null if nothing changed)}.
     A plain swipe, clearly sideways (swipeStarts), with no hold: on a row whose progress can be set, one track (trackAt,
     `track`): right, up in snaps of 25%, a tick felt at each and a stronger one at 100%; left, down, and past 0% on into
     its Delete, if it has one (`off`: how far it's moved aside). A row whose progress can't be set is only swiped left,
     to its Delete (`swipe`), as is one already open on it, either way. Up or down is a scroll, as is a sideways move the
     row can't take (doing nothing, not even a tap). Held still (a tick is felt, and the row lifts), it can only be moved
     up or down (`reorder`: start(y), move(dy, y), end(commit)): nothing scrolls or swipes until the finger lifts, and
     moved sideways, it's let go, changing nothing. */
  holdToSlide(area, find){
    let g = null;
    document.addEventListener('selectstart', noSelect, true);
    const stop = commit => {
      if (!g) return;
      clearTimeout(g.timer); sliding = false;
      const {s, mode, pct, dx, off} = g; g = null;
      s.el?.classList.remove('held');
      if (mode === 'swipe') { s.swipe.end(commit ? dx : null); return; }
      if (mode === 'reorder') { s.reorder.end(commit); return; }
      if (mode !== 'track') return;
      // Let go past half the row, it's deleted, its progress left as it was; anywhere else, its progress is where the
      // finger left it (0% with its Delete open), and the row goes back or stays open on its Delete.
      const gone = commit && off < 0 && swipeEnd(off, s.el.clientWidth) === 'delete', set = commit && !gone && pct !== s.start;
      s.finish?.(set ? pct : null);
      if (off < 0) s.swipe.end(commit ? off : null);
      if (set) this.hintSeen();                         // the first swipe that sets progress, anywhere: the hint has done its job
    };
    // Which way a sideways swipe takes the row (dx: which way it went): its progress, then its Delete, on one track;
    // only its Delete; or nothing.
    const wayOf = (s, dx) => s.swipe?.base ? 'swipe' : s.show && (trackMoves(s.start, dx) || (dx < 0 && s.swipe)) ? 'track' : dx < 0 && s.swipe ? 'swipe' : null;
    area.addEventListener('pointerdown', e => {
      if (g || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
      swallowClick = false;                             // a new tap: its click is its own
      const s = find(e.target); if (!s) return;
      if (s.swipe?.base) { delete s.show; delete s.reorder; }   // an open row is swiped on, or tapped shut: not held
      g = {s, id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, dx: 0, off: 0, mode: 'wait', pct: s.start};
      if (s.reorder) g.timer = setTimeout(() => { g.mode = 'held'; sliding = true; getSelection()?.removeAllRanges(); s.el?.classList.add('held'); haptic('hold'); }, HOLD_MS);
    });
    // Moves and the release are followed on the whole window, so a press that ends outside the area still ends.
    addEventListener('pointermove', e => {
      if (!g || e.pointerId !== g.id) return;
      const s = g.s;
      if (g.mode === 'wait') {
        const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
        if (Math.hypot(dx, dy) <= SWIPE_PX) { g.x = e.clientX; g.y = e.clientY; return; }
        // More sideways than not, but not clearly (SWIPE_SLOPE): not decided yet, until it is, or the page scrolls.
        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) <= Math.abs(dy) * SWIPE_SLOPE) { g.moved = true; return; }
        const way = swipeStarts(dx, dy, g.x0, innerWidth, !!s.swipe?.base) && wayOf(s, dx);
        // Not a swipe it can take: a sideways move does nothing, not even open the task where a mouse lets go; up or
        // down is a scroll.
        if (!way) { if (Math.abs(dx) > Math.abs(dy)) swallow(); stop(false); return; }
        else { clearTimeout(g.timer); g.mode = way; sliding = true; if (way === 'swipe') s.swipe.begin(); }
      }
      if (g.mode === 'swipe') { g.dx = e.clientX - g.x0; s.swipe.move(g.dx); return; }
      if (g.mode === 'track') {
        g.dx = e.clientX - g.x0;
        const {pct, off} = trackAt({start: s.start, dx: g.dx, x: g.x0, width: s.width, screen: innerWidth, del: !!s.swipe});
        if (off < 0) {
          // Past 0%, into its Delete: the fill gives way to the row moving aside.
          if (!(g.off < 0)) { this.endSlide(s.el); s.swipe.begin(); }
          s.swipe.move(off);
        } else {
          if (g.off < 0) shut(s.el);                  // back out of its Delete, to its progress
          // Its progress starts to move: shown from then on, and the claim with it (begin).
          if (!g.shown && trackMoves(s.start, g.dx)) { g.shown = true; s.begin?.(); s.show(pct, e.clientX); }
          else if (g.shown && (pct !== g.pct || g.off < 0)) s.show(pct, e.clientX);
          if (pct !== g.pct) haptic(pct === 100 ? 'done' : 'tick');
        }
        g.pct = pct; g.off = off;
        return;
      }
      if (getSelection()?.rangeCount) getSelection().removeAllRanges();     // whatever the long press selected near the row
      if (g.mode === 'held') {
        const way = lockDirection(e.clientX - g.x, e.clientY - g.y);
        if (!way) return;
        // A hold only moves a row up or down (on Today, later, to another day: parent-tasks-plan, part 4).
        if (way === 'x') { swallow(); stop(false); return; }
        g.mode = 'reorder'; s.reorder.start(e.clientY);
      }
      if (g.mode === 'reorder') s.reorder.move(e.clientY - g.y, e.clientY);
    });
    addEventListener('pointerup', e => {
      if (!g || e.pointerId !== g.id) return;
      if (g.mode === 'wait' && g.s.swipe?.base) shut();   // an open row tapped: it only shuts
      if (g.mode !== 'wait' || g.s.swipe?.base || g.moved) swallow();   // a move never decided isn't a tap either
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
      // A stacked card: each of its rows as any row (cardGesture); its heading only a tap, a swipe there doing nothing
      // (part 3 makes it the parent's header); its peek, and Show less, only a tap.
      const card = target.closest('.day-card'), row = target.closest('.card-rows > .row, .list:not(.tree) > .row, .item > .row');
      if (card && !row) return target.closest('.card-head') ? this.cardGesture(card, null) : null;
      if (!row || target.closest('.row-del')) return null;
      if (row.parentElement.id === 'run-steps') return this.stepSlide(row, target);
      const t = this.rowTask(+row.dataset.id), s = t && this.rowGesture(t, row, false);
      return card ? this.cardGesture(card, s) : s;
    });
    this.watchNudges(document.getElementById('view'));
  },
  /* A nudge (motion-and-rows-plan.md, part 7): on a project's list, or a run's steps, a touch that starts on a row and
     turns into a short, slow scroll aims the add box at that row (isNudge, in progress.js beside app/, where its numbers
     are; `nudged`, app/quickadd.js: on a run, the step goes on the card); a fling is only a scroll. Followed by touch events, passive, so it never stops the page
     scrolling: once the phone scrolls, it ends the pointer events (pointercancel), but these carry on. A hold, a swipe
     or a second finger on the way, and it's not one. */
  watchNudges(area){
    let n = null;
    area.addEventListener('touchstart', e => {
      n = null;
      const run = this.route.name === 'run';
      const row = e.touches.length === 1 && (run || this.route.name === 'project') && !e.target.closest('.row-del') && e.target.closest('.list:not(.tree) > .row');
      if (!row) return;
      const p = e.touches[0];
      n = {id: run ? row.dataset.id : +row.dataset.id, x0: p.clientX, y0: p.clientY, t0: e.timeStamp, far: 0, moves: [{t: e.timeStamp, y: p.clientY}]};
    }, {passive: true});
    area.addEventListener('touchmove', e => {
      if (!n) return;
      if (sliding || e.touches.length !== 1) { n = null; return; }
      const p = e.touches[0];
      n.far = Math.max(n.far, Math.abs(p.clientY - n.y0)); n.moves.push({t: e.timeStamp, y: p.clientY});
    }, {passive: true});
    area.addEventListener('touchend', e => {
      const was = n, p = e.changedTouches[0]; n = null;
      if (!was || e.touches.length || !p) return;
      const dy = Math.max(was.far, Math.abs(p.clientY - was.y0));
      if (isNudge({dx: p.clientX - was.x0, dy, ms: e.timeStamp - was.t0, speed: releaseSpeed(was.moves, e.timeStamp, p.clientY)})) this.nudged(was.id);
    }, {passive: true});
    area.addEventListener('touchcancel', () => { n = null; }, {passive: true});
  },
  /* A task's row, in a list or (sheet) a task's sheet. Swiped, its progress: not one waiting to be sent, or that can't
     be ticked, nor a run (its progress is its steps), nor a step in a run's sheet; a done one only down, opened again
     (setProgress); with no one on it, it's then yours (claimOnSlide). Where its list allows (allows), swiped left past
     0%, its Delete, and held, what a hold does there (holdOf). */
  rowGesture(t, row, sheet){
    if (this.lines[t.id] || this.leaving[t.id]) return null;   // a line in its place, or marked done or deleted: only its tap
    const slides = sheet ? !t.pending && this.canWrite(t.project_id) && this.checklistRole !== 'run' : this.rowSlides(t);
    const can = allows(row), swipe = can.has('delete') && this.canDelete(t, sheet) ? swipeOf(row, () => this.swipeDelete(t, sheet, row)) : null;
    const reorder = this.holdOf(t, row, sheet, can);
    if (!slides) return (swipe || reorder) && {el: row, swipe, reorder};
    let claimed = null;
    return {el: row, swipe, reorder, start: t.done ? 100 : pctOf(t), width: row.clientWidth,
      show: (pct, x) => this.showSlide(row, pct, x),
      begin: () => { claimed = this.claimOnSlide(sheet ? this.subSlots[t.id] : this.rowSlot(t, {})); },
      finish: pct => {
        claimed?.(pct !== null);
        if (pct !== null) { this.setProgress(t, pct, sheet ? null : row, {sub: sheet || undefined}); if (sheet) this.sheet.dirty = true; else this.aimAfterTick(t); }
        this.endSlide(row);
        row.style.setProperty('--pct', t.done ? 0 : this.shownPct(t) / 100);
      }};
  },
  /* What a row held does, where its list allows it: on a project's list and in a task's sheet, moved up or down, its
     place among its siblings (reorderOf). Elsewhere nothing, as yet: on Today a hold will move a row to another day
     (parent-tasks-plan, part 4), given here as a dragOf whose drop sets its date. Search has no order of its own. */
  holdOf(t, row, sheet, can){ return can.has('reorder') ? this.reorderOf(t, row, sheet) : null; },
  // Whether a list's row takes a swipe for its progress (rowGesture): not one waiting to be sent, that can't be ticked
  // (read only, a template), nor a run, nor one marked or with a line in its place. A done one does, down only.
  rowSlides(t){ return !this.lines[t.id] && !this.leaving[t.id] && !t.pending && this.canTick(t) && !this.isRunTask(t); },
  /* A one-time hint, "Swipe right to start working on it", on the first open row of a list that takes a swipe for its
     progress (a card's top row counts: the card is `at`, so its next top row keeps it). It's picked once, as a
     screen is first drawn (hint.pick, set by render), never later, so it can't push rows down under a finger. Gone (a
     swipe that sets progress anywhere, or a tap on it), it fades, keeping its space until no finger is down and the list is still,
     then closes (hintAway, leaving.js). Remembered on the phone; a screen reader hears it once. */
  pickHint(){
    this.hint.pick = false;
    if (this.hint.done) return;
    for (const g of this.listGroups) if (!g.fold) for (const t of g.items || g.tasks) {
      const c = this.cardOf(t, g), x = c ? c.step : t;
      if (x.done || !this.rowSlides(x)) continue;
      this.hint.at = t.id;
      if (store.get('hint.slide') !== 'said') { this.said = 'Tip: swipe a task to the right to start working on it.'; store.set('hint.slide', 'said'); }
      return;
    }
  },
  // Whether the row of `t` in list `g` has the hint's place: a card's top row for its card.
  hintOn(t, g){ return !g.sheet && !g.run && this.hint.at !== null && (g.card ? g.card.step.id === t.id && this.hint.at === g.card.id : this.hint.at === t.id); },
  hintSeen(){ if (this.hint.done) return; this.hint.done = true; store.set('hint.slide', 'done'); this.hintAway(); },
  /* A stacked card (app/cards.js), one of its rows touched: that row's gesture `s` (rowGesture), whose swipe is that
     subtask's alone, and a run's card then staying on its top row until that has gone (pinCard). A plain swipe on its
     heading (`s` null) does nothing, not even a tap. */
  cardGesture(card, s){
    if (card.matches('.deleted, .lined')) return null;                     // only its Restore, or its line's action
    if (!s) return {el: null};
    // (Its top row is the same on any screen's card: 'found' asks only that it's an open task with open subtasks.)
    const id = +card.dataset.id, pin = () => { const t = this.tasks[id]; this.pinCard(t && this.cardOf(t, {cards: 'found'})); };
    return {...s, finish: s.finish && (pct => { if (pct !== null) pin(); s.finish(pct); })};
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
  /* A step inserted or repeated during a run, swiped to its Delete or its Delete tapped: deleteAddedStep, which asks
     first, as the × on the card's step does, and has no Restore; deleted, its row stays hidden in its place until the
     run is drawn again without it. Said no to, it comes back. */
  async swipeDeleteStep(s, row = null){
    if (!row) { row = opened; haptic('done'); }
    const removing = this.deleteAddedStep(s).then(ok => { if (ok && row) row.style.visibility = 'hidden'; return ok; });
    await (row ? sweep(row, removing) : removing);
  },
  /* A run's step swiped on its row, as a task's is: not one waiting to be sent, or in a finished run; a done one only
     down, not done again (stepProgress). With no one on it, it's then yours, as a task's is. Swiped left past 0%, only a
     step inserted or repeated during the run, not done, has a Delete (swipeDeleteStep); a template's step stops at 0%. */
  stepSlide(row, target){
    const v = this.runView, s = v?.steps.find(x => String(x.id) === row.dataset.id);
    if (!s || s.pending || v.finished || !this.canWrite(this.view.run.run.project_id) || target.closest('.step-del')) return null;
    let claimed = null;
    return {el: row, start: s.done ? 100 : s.pct, width: row.clientWidth, swipe: s.added && !s.done ? swipeOf(row, () => this.swipeDeleteStep(s, row)) : null,
      show: (pct, x) => this.showSlide(row, pct, x),
      begin: () => { claimed = this.claimOnSlide(s.slot); },
      finish: pct => { claimed?.(pct !== null); this.endSlide(row); if (pct !== null) this.stepProgress(s, pct); }};
  },
  // In a task's sheet: swipe the progress bar, or around the title (not what's typed there); and its subtasks' rows, as
  // in a list.
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
      let claimed = null;
      return {start: this.shownPct(t), width: head.clientWidth,
        show: (pct, x) => { this.sheet.pct = pct; this.showSlide(head, pct, x); },
        begin: () => { claimed = this.claimOnSlide(this.sheetSlot); },
        finish: pct => {
          this.endSlide(head); this.sheet.pct = null;
          const set = pct !== null && this.sheet.task === t;
          // The claim after the save: the save's reply, from before it, would otherwise be shown over it.
          (set ? this.sheetProgress(t, pct) : Promise.resolve()).finally(() => claimed?.(set));
        }};
    });
  },
  // The sheet's task's slot for who's doing it, as its row has (claimSlot): its bar, slid or moved by a key, claims it
  // as a row's slide does, if no one is doing it; its Assigned row shows it (peopleOf).
  get sheetSlot(){ const t = this.sheet.task; return t && this.claimSlot(t, this.peopleOf(t.id, t.assignees), t.done, this.stepRun(t)); },
  nudgeProgress(dir){                            // the arrow keys, on the focused bar: to the next snap
    const t = this.sheet.task;
    if (this.isRunTask(t)) return;
    const was = pctOf(t), pct = nextSnap(was, dir);
    if (pct === was) return;
    const claimed = this.claimOnSlide(this.sheetSlot);
    this.sheetProgress(t, pct).finally(() => claimed(true));
  },
};
