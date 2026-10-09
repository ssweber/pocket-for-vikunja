// What a finger does on a row (parent-tasks-plan, parts 1 and 1b): swiped, one mechanism with mirrored sides (swipeAt,
// SIDES, in progress.js), each with one job, chosen as the swipe starts: right, its progress up, a full swipe done;
// left, a row with progress, down, stopping at 0%; left, a row at 0%, its Delete, a full swipe deleted. Nothing changes
// until it's let go. Held, then moved up or down, the row moves among its siblings, or on Today to another day (part
// 4). Delete and moving only where the row's list allows them (rowGestures): Today's rows are deleted and carried to
// another day, search's only deleted, a project's and a sheet's deleted and moved among their siblings. The sheet's bar
// is swiped for its progress too (trackAt). A parent (a card's header, or a parent's row: parent-tasks-plan, part 3)
// has no progress of its own: swiped right it springs back, unless all the way, its ring's tap; left, its Delete.
import {DELETE_W, HOLD_MS, isNudge, lockDirection, nextSnap, pctOf, releaseSpeed, SWIPE_PX, SWIPE_SLOPE, swipeAt, swipeFeel, swipeStarts, trackAt, trackMoves} from '../progress.js';
import {dragPlace} from '../order.js';
import {addDays, dueInfo, isSet, movedDue, repeats, startOfDay} from '../dates.js';
import {hasTemplateLabel} from '../checklists.js';
import {todayAt} from '../lists.js';
import {dayWord, STAYS} from '../messages.js';
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
// A row held or swiped is a gesture, not text: no selection starts meanwhile, anywhere the finger goes (the
// phone's long press would otherwise select the words under it, or the nearest it can, around a sheet's subtasks), and
// one made is cleared as the hold ends and as the row moves. One function, so it's added once.
const noSelect = e => { if (sliding) e.preventDefault(); };
const shut = (row = opened) => {
  if (!row) return;
  row.classList.remove('swiping', 'swiped', 'swipe-full'); row.style.removeProperty('--swipe');
  if (opened === row) opened = null;
};
// What's uncovered as a row is swiped (swipeAt's `to`): its Delete, red, or its stops, the ring on green.
const RED = new Set(['shut', 'open', 'delete']);
/* A row's Delete, uncovered as it's swiped left at 0%, as on a phone's mail: the row moves with the finger, from
   where it rests or, open, from its Delete (`base`). Let go a third of the way across the Delete button, it stays open
   on it; past the left side's full point, the Delete fills what the row left, and letting go there deletes it
   (`remove`, which carries it on off the screen: sweep). The Delete isn't in the page's tab order until it's shown: a
   keyboard or a screen reader deletes from the task's ⋯ instead. */
const swipeOf = (row, remove) => ({
  base: opened === row ? -DELETE_W : 0,
  begin(){ if (opened !== row) shut(); row.classList.add('swiping'); },
  move({off, to}){ row.style.setProperty('--swipe', off + 'px'); row.classList.toggle('swipe-full', to === 'delete'); },
  end(to){
    if (to === 'delete') { remove(); return; }            // from where the finger left it (sweep)
    row.classList.remove('swiping', 'swipe-full');
    if (to !== 'open') { shut(row); return; }
    row.classList.add('swiped'); row.style.setProperty('--swipe', -DELETE_W + 'px'); opened = row; openAt = scrolled();
  },
});

/* A row's stops, uncovered as it's swiped for its progress, either way: a large ring, the tick's shape, filling (right)
   or emptying (left) a quarter at a time, pulsing at each, the tick seen where it can't be felt; past the right side's
   full point, full with its ✓, the green solid. The space is the whole row's height, from the list's edge whatever the
   row's indent. It's an element of its own, made as the swipe starts and gone once the row is back, so a list's rows
   don't each carry one. (The specimen draws its stills with it.) */
const BACK_MS = 150, SPRING_MS = 200;                    // the row's own transition back: .row, styles.css
export const revealOf = row => {
  let el = null;
  return {
    move({off, pct, to}){
      if (!el) {
        el = document.createElement('span'); el.className = 'row-prog'; el.setAttribute('aria-hidden', 'true');
        el.innerHTML = '<span class="ring"><svg class="i"><use href="#i-check"/></svg></span>';
        el.classList.toggle('sq', !!row.querySelector(':scope > .check.sq'));
        row.append(el);
      }
      row.classList.add('revealing'); row.style.setProperty('--swipe', off + 'px');
      if (el.dataset.pct && el.dataset.pct !== String(pct)) el.dataset.tick = el.dataset.tick === 'a' ? 'b' : 'a';
      el.dataset.pct = pct; el.dataset.side = off > 0 ? 'left' : 'right'; el.classList.toggle('full', to === 'done');
      el.style.width = Math.abs(off) + 'px'; el.style.setProperty('--ring', pct / 100);
    },
    // Back in its place: it springs back (.row's transition), the space shrinking with it, then goes.
    back(){
      row.classList.remove('revealing'); row.style.removeProperty('--swipe');
      const was = el; el = null;
      if (was) { was.classList.add('going'); setTimeout(() => was.remove(), SPRING_MS + 50); }   // (not the next swipe's)
    },
    // Gone at once: its Delete takes the space (swipeOf), swiped back left past where a row at 0% started.
    drop(){ el?.remove(); el = null; row.classList.remove('revealing'); },
  };
};

/* A row deleted by a full swipe, or its Delete tapped, follows through: it carries on to the left, off the screen, the
   red filling the row behind it, and doesn't come back. Its place stays, at its height, as a gap (removeTask,
   `going`, marks it meanwhile: task-row.html), the red fading into it, holding only "Deleted" and Restore. A full swipe
   right (`right`) is done the same way: on off to the right, the green filling the row, a gap with "Done" and Undo
   (setProgress, `gap`). Only its content moves, so nothing around it does. With less motion asked for, it only
   changes. Resolves to what `going` did: not deleted after all (a question about its subtasks said no), or no gap (a
   tick not saved), the row fades back in. */
const SWEEP_MS = 200;
async function sweep(row, going, right = false){
  if (opened === row) opened = null;                      // it's no longer open, for a scroll or a tap elsewhere to shut
  const fill = row.querySelector(right ? ':scope > .row-prog:not(.going)' : ':scope > .row-del'), w = row.clientWidth, from = parseFloat(row.style.getPropertyValue('--swipe')) || 0;
  const moving = fill && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!right) row.classList.add('swiping', 'swipe-full');
  // The row's offset and the fill's width move together, so the fill always reaches the list's edge.
  const go = {duration: SWEEP_MS, easing: 'ease-out', fill: 'forwards'}, anims = moving
    ? [row.animate([{transform: `translateX(${from}px)`}, {transform: `translateX(${right ? w : -w}px)`}], go), fill.animate([{width: Math.abs(from) + 'px'}, {width: w + 'px'}], go)] : [];
  const [done] = await Promise.all([going, ...anims.map(a => a.finished.catch(() => {}))]);
  // Its content back in its place at once, unseen under the gap, not sliding back (.row's transition).
  const color = fill && getComputedStyle(fill).backgroundColor;
  row.style.transition = 'none'; shut(row); anims.forEach(a => a.cancel());
  if (right) { fill?.remove(); row.classList.remove('revealing'); row.style.removeProperty('--swipe'); }
  void row.offsetWidth; row.style.transition = '';
  if (!moving || !row.isConnected) return done;
  const gap = row.querySelector(':scope > .del-gap'), fade = {duration: BACK_MS, easing: 'ease-out'};
  if (!gap) { row.animate([{opacity: 0}, {opacity: 1}], fade); return done; }
  gap.animate([{backgroundColor: color}, {backgroundColor: getComputedStyle(gap).backgroundColor}], fade);
  for (const el of gap.children) el.animate([{opacity: 0}, {opacity: 1}], fade);
  return done;
}

/* Near the top or the bottom of the screen, or of the sheet (`scroller`), while a row is held there (`y()`: where the
   finger is), the page scrolls on by itself, faster the nearer it is, and `moved()` places what's held again. */
const ZONE = 72;                                        // px from an edge where the page scrolls by itself
const edgeRoll = (scroller, y, moved) => {
  let frame = null;
  const top = () => scroller ? scroller.scrollTop : scrollY;
  const view = () => { const r = scroller?.getBoundingClientRect(); return r ? [r.top, r.bottom] : [0, innerHeight - (document.getElementById('capture')?.offsetHeight || 0)]; };
  const roll = () => {
    const [lo, hi] = view(), at = y(), v = at < lo + ZONE ? -(lo + ZONE - at) / 6 : at > hi - ZONE ? (at - hi + ZONE) / 6 : 0;
    if (v) { const was = top(); if (scroller) scroller.scrollTop += Math.max(-14, Math.min(14, v)); else scrollBy(0, Math.max(-14, Math.min(14, v))); if (top() !== was) moved(); }
    frame = requestAnimationFrame(roll);
  };
  return {top, start(){ frame = requestAnimationFrame(roll); }, stop(){ cancelAnimationFrame(frame); }};
};
/* Let go, what was held slides from where it was (`was`: each one's top then) into its place, once it's drawn there:
   its new one, or back where it was. One drawn again elsewhere (moved to another of Today's groups) is found by its id.
   `before()`: first, once it's drawn. */
const slideHome = (els, was, all = els, before = null) => requestAnimationFrame(() => {
  before?.();
  const slide = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  els.forEach((el, i) => {
    const now = el.isConnected ? el : document.querySelector(`#view .list > [data-id="${el.dataset.id}"]`);
    const d = now && was[i] - now.getBoundingClientRect().top;
    if (slide && now && Math.abs(d) > 1) now.animate([{transform: `translateY(${d}px)`}, {transform: 'none'}], {duration: 160, easing: 'ease-out'});
  });
  for (const el of all) el.style.transition = '';
});
// What's on the screen at `el` kept where it is as something above it opens or closes: called once that's drawn, it
// scrolls the page by what `el` moved.
const steady = el => { const was = el.getBoundingClientRect().top; return () => { const d = el.isConnected ? el.getBoundingClientRect().top - was : 0; if (d) scrollBy(0, d); }; };

/* A row moved up or down after the hold, among its siblings: `blocks`, each the rows of one sibling (a task and its
   subtasks under it), in order, the one held `k`. Its rows follow the finger, and the siblings it passes the middle of
   move aside to make room, a tick felt at each (dragPlace). Near the top or the bottom of the screen, or of the sheet
   (`scroller`), the page scrolls on by itself (edgeRoll). Let go, every row is put back as it was, and `drop(to)` is
   told where it landed, if it moved, for the list to be drawn in its new order; the held rows then slide into their
   place (slideHome). */
const dragOf = (blocks, k, scroller, drop, begin) => {
  let boxes, fy = 0, y = 0, at = k, from = 0;
  const all = blocks.flat(), mine = blocks[k], list = mine[0].parentElement;
  const place = () => {
    const p = dragPlace(boxes, k, fy + roll.top() - from);
    blocks.forEach((els, i) => { for (const el of els) el.style.transform = i === k ? `translateY(${p.dy}px)` : p.shifts[i] ? `translateY(${p.shifts[i]}px)` : ''; });
    if (p.at !== at) { at = p.at; haptic('tick'); }
  };
  const roll = edgeRoll(scroller, () => y, place);
  return {
    start(y0){
      begin?.();
      y = y0; from = roll.top();
      boxes = blocks.map(els => { const a = els[0].getBoundingClientRect(), b = els.at(-1).getBoundingClientRect(); return {top: a.top, height: b.bottom - a.top}; });
      list.classList.add('reordering'); for (const el of mine) el.classList.add('dragged');
      roll.start();
    },
    move(dy, y1){ fy = dy; y = y1; place(); },
    end(commit){
      roll.stop();
      const was = mine.map(el => el.getBoundingClientRect().top);
      for (const el of all) { el.style.transition = 'none'; el.style.transform = ''; }
      list.classList.remove('reordering'); for (const el of mine) el.classList.remove('dragged');
      if (commit && at !== k) drop(at);
      slideHome(mine, was, all);                       // drawn in its new order by now
    },
  };
};

/* A row or a card held on Today and moved up or down, to another day (parent-tasks-plan, part 4): `item`, its place in
   the list, follows the finger (`el` is what's lifted: the row, or the card), out of its list, the page scrolling near
   the edges as for a move among siblings (edgeRoll); nothing else moves, as the drop is a day, not a place among the
   rows, but for room made for it: as it starts, Today's and Next 7 days' sections show even with nothing in them
   (`room(true)`), the page kept still where the finger is (steady). Where it would go is `aim(y, home)` (dropAt;
   `home`: the finger is over the place it left), shown as it changes, a tick felt each time: the section lit
   (.drop-on), in Next 7 days the row or card whose day it'd take (.drop-day), and a tag on what's held naming the day.
   Let go there, `drop(to)`; anywhere else (Overdue, its own day, a section that isn't a day), it springs back
   (slideHome). Either way the empty sections go again, the page kept still where it was let go. */
const carryOf = (item, el, {aim, drop, room}) => {
  let fy = 0, y = 0, top0 = 0, tr = 0, to = null, tag = null;
  const list = item.parentElement;
  const light = a => {
    for (const x of document.querySelectorAll('#view .drop-on, #view .drop-day')) x.classList.remove('drop-on', 'drop-day');
    a?.section.classList.add('drop-on'); a?.over?.classList.add('drop-day');
    tag.hidden = !a; tag.textContent = a ? 'Move to ' + dayWord(a.label) : '';
  };
  // It follows the finger, however the page scrolls or what's above it opens: from where it is in the list now.
  const place = () => {
    const r = item.getBoundingClientRect(), at = r.top - tr;
    tr = top0 + fy - at; item.style.transform = `translateY(${tr}px)`;
    const a = aim(y, y >= at && y < at + r.height);
    if (a?.due !== to?.due || a?.over !== to?.over) { light(a); if (a) haptic('tick'); }
    to = a;
  };
  const roll = edgeRoll(null, () => y, place);
  return {el,
    start(y0){
      y = y0; top0 = item.getBoundingClientRect().top;
      tag = document.createElement('span'); tag.className = 'drop-tag'; tag.hidden = true; tag.setAttribute('aria-hidden', 'true'); item.append(tag);
      list.classList.add('carrying'); item.classList.add('dragged');
      const keep = steady(item);
      room(true);
      requestAnimationFrame(() => { keep(); place(); });
      roll.start();
    },
    move(dy, y1){ fy = dy; y = y1; place(); },
    end(commit){
      roll.stop();
      const was = [item.getBoundingClientRect().top], keep = steady(to?.section || item.closest('[data-group]') || item);
      light(null); tag.remove();
      item.style.transition = 'none'; item.style.transform = '';
      list.classList.remove('carrying'); item.classList.remove('dragged');
      if (commit && to) drop(to);
      room(false);
      slideHome([item], was, [item], keep);
    },
  };
};

export default {
  /* A finger on a row, or on a task sheet's progress. find(target) says what it's on, or null: on a row, {el: the row,
     swipe: its Delete if it has one (swipeOf), reorder: if it can be held and moved (dragOf), and if its progress can
     be swiped, start (a done one's 100), width, finish(pct, or null if nothing changed; 100 is a full swipe)}. The
     sheet's bar has start, width, finish, show(pct, x: where the finger is), and begin() as its progress starts to move.
     A plain swipe, clearly sideways (swipeStarts), with no hold: on a row, one mechanism either way (`swipe`: swipeAt):
     its content moves with the finger, what's uncovered shows what letting go does, its stops (revealOf) or its Delete
     (swipeOf), a tick felt at each (swipeFeel), and nothing changes until it's let go. Left, a row with progress is
     only lowered, to 0%; at 0%, it has its Delete. A row whose progress can't be swiped has only its Delete, to the
     left, as has one already open on it, either way. The sheet's bar shows its
     progress as it goes (`bar`: trackAt, show). Up or down is a scroll, as is a sideways move the row can't take (doing
     nothing, not even a tap). Held still (a tick is felt, and the row lifts), it can only be moved up or down
     (`reorder`: start(y), move(dy, y), end(commit)): nothing scrolls or swipes until the finger lifts, and moved
     sideways, it's let go, changing nothing. */
  holdToSlide(area, find){
    let g = null;
    document.addEventListener('selectstart', noSelect, true);
    const stop = commit => {
      if (!g) return;
      clearTimeout(g.timer); sliding = false;
      const {s, mode, pct, r, ring} = g; g = null;
      s.el?.classList.remove('held'); s.reorder?.el?.classList.remove('held');
      if (mode === 'reorder') { s.reorder.end(commit); return; }
      if (mode === 'bar') {                             // its progress where the finger left it
        const set = commit && pct !== s.start;
        s.finish(set ? pct : null);
        if (set) this.hintSeen();
        return;
      }
      if (mode !== 'swipe') return;
      /* Let go on a stop, its progress is set, and the row springs back, its tick showing it (on its own, nothing
         changes); in its Delete (a row at 0%), it stays open on its button, or goes back; past a side's full
         point, the full action, the row carrying on off the screen (finish: done; the Delete's remove: deleted, its
         progress left as it was). Taken away from the finger (pointercancel), it goes back, changing nothing. */
      const to = commit ? r.to : 'shut', set = commit && to !== 'delete' && r.pct !== null && r.pct !== s.start;
      if (s.springs && set) { s.finish(r.pct); ring.back(); return; }      // a parent's: its question, no progress set
      if (RED.has(r.to)) s.swipe.end(to); else if (to !== 'done' || s.springs) ring.back();
      s.finish?.(set ? r.pct : null);
      if (set) this.hintSeen();                         // the first swipe that sets progress, anywhere: the hint has done its job
    };
    // Whether a sideways swipe that way (dx) is one the row takes: its progress, if that moves that way, or its Delete,
    // to the left; on the sheet's bar, its progress.
    const wayOf = (s, dx) => s.show ? (trackMoves(s.start, dx) ? 'bar' : null)
      : s.swipe?.base || (s.finish && trackMoves(s.start, dx)) || (dx < 0 && s.swipe) ? 'swipe' : null;
    area.addEventListener('pointerdown', e => {
      if (g || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
      swallowClick = false;                             // a new tap: its click is its own
      let s = find(e.target); if (!s) return;
      if (s.swipe?.base) s = {el: s.el, slide: s.slide, swipe: s.swipe, width: s.width};   // an open row is swiped on, or tapped shut: not held, its progress 0%
      g = {s, id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, mode: 'wait', pct: s.start};
      // Held: lifted (what's lifted can be more than the row: on Today, its card), or, for what a hold can't move there,
      // told why (refuse), and nothing more until the finger lifts.
      if (s.reorder) g.timer = setTimeout(() => {
        sliding = true; getSelection()?.removeAllRanges(); haptic('hold');
        if (s.reorder.refuse) { g.mode = 'refused'; s.reorder.refuse(); return; }
        g.mode = 'held'; (s.reorder.el || s.el)?.classList.add('held');
      }, HOLD_MS);
    });
    // Where a row swiped `dx` is, and what letting go there does (swipeAt).
    const at = (s, dx) => swipeAt({start: s.finish ? s.start : null, dx, x: g.x0, width: s.width ?? s.el.clientWidth, screen: innerWidth, del: !!s.swipe, base: s.swipe?.base || 0, one: !!s.one, side: g.side});
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
        clearTimeout(g.timer); g.mode = way; sliding = true;
        // The side it starts on, by this first sideways move, is the side it stays on (an open row's: its Delete's).
        if (way === 'swipe') { g.side = s.swipe?.base || dx < 0 ? 'left' : 'right'; g.ring = revealOf(s.slide || s.el); g.r = at(s, 0); g.red = null; }
      }
      if (g.mode === 'swipe') {
        const r = at(s, e.clientX - g.x0), red = RED.has(r.to);
        // Its Delete (red) or its stops, as the side it started on has them.
        if (red !== g.red) { if (red) { g.ring.drop(); s.swipe.begin(); } else if (g.red) shut(s.slide || s.el); g.red = red; }
        if (red) s.swipe.move(r); else g.ring.move(r);
        const feel = swipeFeel(g.r, r);
        if (feel) haptic(feel);
        g.r = r;
        return;
      }
      if (g.mode === 'bar') {
        const dx = e.clientX - g.x0, pct = trackAt({start: s.start, dx, x: g.x0, width: s.width, screen: innerWidth});
        // Its progress starts to move: shown from then on, and the claim with it (begin).
        if (!g.shown && trackMoves(s.start, dx)) { g.shown = true; s.begin?.(); s.show(pct, e.clientX); }
        else if (g.shown && pct !== g.pct) s.show(pct, e.clientX);
        if (pct !== g.pct) haptic(pct === 100 ? 'done' : 'tick');
        g.pct = pct;
        return;
      }
      if (getSelection()?.rangeCount) getSelection().removeAllRanges();     // whatever the long press selected near the row
      if (g.mode === 'held') {
        const way = lockDirection(e.clientX - g.x, e.clientY - g.y);
        if (!way) return;
        // A hold only moves a row up or down (on Today, to another day: parent-tasks-plan, part 4).
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
  // The sheet's bar being set (a row shows what it'll do beside it instead: revealOf): filled to `pct`, with its
  // percentage on the side away from the finger (at `x`). The percentage pulses at each snap, the tick seen (where it
  // can't be felt), and at 100% the tick fills.
  showSlide(el, pct, x){
    if (el.dataset.pct && el.dataset.pct !== pct + '%') el.dataset.tick = el.dataset.tick === 'a' ? 'b' : 'a';
    el.classList.add('setting'); el.classList.toggle('full', pct >= 100);
    el.style.setProperty('--slide', pct / 100); el.dataset.pct = pct + '%';
    const r = el.getBoundingClientRect();
    el.dataset.side = x > r.left + r.width / 2 ? 'left' : 'right';
  },
  endSlide(el){ el.classList.remove('setting', 'full'); delete el.dataset.tick; delete el.dataset.pct; },
  // In the list: a row swiped for its progress, its Delete, or held to move it. A run's step the same, through the outbox.
  initProgressDrag(){
    // A row swiped open shuts again when anything else is touched, or anything scrolls. (Touched itself, it's swiped on,
    // or tapped shut: holdToSlide.)
    document.addEventListener('pointerdown', e => { if (opened && !opened.contains(e.target)) shut(); }, true);
    addEventListener('scroll', () => { if (opened && !sliding && scrolled().some((y, i) => Math.abs(y - openAt[i]) > 10)) shut(); }, {capture: true, passive: true});
    this.holdToSlide(document.getElementById('view'), target => {
      // A stacked card: each of its rows as any row (cardGesture); its header the parent's (headGesture), and held, on a
      // project's list, the card moved up or down (cardHold); its footer (More, Less) and Close, only a tap.
      const card = target.closest('.day-card'), row = target.closest('.card-rows > .row, .list:not(.tree) > .row, .item > .row');
      if (card && !row) return target.closest('.card-head') && !target.closest('.row-del') ? this.cardGesture(card, this.headGesture(card), this.cardHold(card)) : null;
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
      // (a row, a card's row, or a card's heading, for its task)
      const row = e.touches.length === 1 && (run || this.route.name === 'project') && !e.target.closest('.row-del')
        && (e.target.closest('.card-rows > .row, .item > .row, .list:not(.tree) > .row') || e.target.closest('.card-head')?.closest('.day-card'));
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
     (setProgress). Let go having changed it, with no one on it, it's then yours (claimOnSlide); a full swipe is done,
     the row carrying on off the screen and leaving a gap with "Done" and Undo (sweep, setProgress's `gap`). Where its
     list allows (allows), swiped left at 0%, its Delete, and held, what a hold does there (holdOf). */
  rowGesture(t, row, sheet){
    if (this.lines[t.id] || this.leaving[t.id]) return null;   // a line in its place, or marked done or deleted: only its tap
    const slides = sheet ? !t.pending && this.canWrite(t.project_id) && this.checklistRole !== 'run' : this.rowSlides(t);
    const can = allows(row), swipe = can.has('delete') && this.canDelete(t, sheet) ? swipeOf(row, () => this.swipeDelete(t, sheet, row)) : null;
    const reorder = this.holdOf(t, row, sheet, can);
    // A parent's row (its ring for a tick): no progress of its own, a full swipe its ring's tap (ringSwipe).
    if (!sheet && this.rowRing(t, {depth: {}})) { const r = {el: row, swipe, reorder, ...this.ringSwipe(t, row)}; return (r.finish || swipe || reorder) && r; }
    if (!slides) return (swipe || reorder) && {el: row, swipe, reorder};
    return {el: row, swipe, reorder, start: t.done ? 100 : pctOf(t), width: row.clientWidth,
      finish: pct => {
        if (pct === null) return;
        this.claimOnSlide(sheet ? this.subSlots[t.id] : this.rowSlot(t, {}))(true);
        const setting = this.setProgress(t, pct, sheet ? null : row, {sub: sheet || undefined, gap: pct >= 100});
        if (pct >= 100) sweep(row, setting, true);
        if (sheet) this.sheet.dirty = true; else this.aimAfterTick(t);
      }};
  },
  /* What a row held does, where its list allows it: on a project's list and in a task's sheet, moved up or down, its
     place among its siblings (reorderOf); on Today, carried to another day (rescheduleOf), a card's row lifting its
     card. Search has no order of its own: nothing. */
  holdOf(t, row, sheet, can){
    if (can.has('reschedule')) { const card = row.closest('.day-card'); return card ? this.rescheduleOf(this.tasks[+card.dataset.id], card) : this.rescheduleOf(t, row); }
    return can.has('reorder') ? this.reorderOf(t, row, sheet) : null;
  },
  /* A row or a card held on Today (parent-tasks-plan, part 4: `el`, the row or the card): carried up or down and let go
     on Today or a day in the week ahead (dropAt), its date moves there, as Move all to today does (reschedule). Not one
     marked, with a line in its place, waiting to be sent or that can't be written to: nothing. What Move all to today
     leaves where it is, a hold leaves too, saying why in its place (STAYS): a repeating task (moved, its next times would
     follow the new date; ticked, it moves on to its next), a checklist that comes round, a checklist run. The tap path
     is the sheet's Due. */
  rescheduleOf(t, el){
    if (!t || t.pending || t.done || this.leaving[t.id] || this.lines[t.id] || !this.canWrite(t.project_id)) return null;
    const why = this.isRunTask(t) ? 'run' : hasTemplateLabel(t) ? 'checklist' : repeats(t) ? 'repeats' : null;
    if (why) return {el, refuse: () => this.say(STAYS[why], {row: {id: t.id, stays: true}})};
    return carryOf(el.closest('.item') || el, el, {aim: (y, home) => this.dropAt(t, y, home), drop: to => this.reschedule(t, to), room: on => { this.carrying = on; }});
  },
  /* Where task `t`, held on Today, would go if let go with the finger at `y` (on the screen): {key: its section's,
     section, over: in Next 7 days, the row or card whose day it takes, due: its new date (movedDue), label: the day}, or
     null where it stays. Today's section: today. Next 7 days: the day of the row or card under the finger (each shows
     its day at its right), or tomorrow over its heading. Not Overdue, Checklist runs or Added today, no date; not where
     it is (`home`: over the place it left), nor a day that gives it the date it has; not under the add box. */
  dropAt(t, y, home){
    if (home || y > innerHeight - (document.getElementById('capture')?.offsetHeight || 0)) return null;
    const within = el => { const r = el.getBoundingClientRect(); return y >= r.top && y < r.bottom; };
    const section = [...document.querySelectorAll('#view [data-group]')].find(within), key = section?.dataset.group;
    if (key !== 'today' && key !== 'week') return null;
    const now = new Date();
    let day = startOfDay(now), over = null;
    if (key === 'week') {
      over = [...section.querySelectorAll(':scope .list > [data-id]')].find(x => +x.dataset.id !== t.id && within(x)) || null;
      const o = over && this.tasks[+over.dataset.id], d = o && todayAt(this.view.cards)(o).due_date;
      day = isSet(d) ? startOfDay(new Date(d)) : addDays(day, 1);
    }
    const due = movedDue(t.due_date, day, now);
    if (isSet(t.due_date) && Date.parse(due) === Date.parse(t.due_date)) return null;
    return {key, section, over, due, label: dueInfo(day.toISOString()).label};
  },
  // Whether a list's row takes a swipe for its progress (rowGesture): not one waiting to be sent, that can't be ticked
  // (read only, a template), nor a parent (a run, or an open task with subtasks: its progress is theirs), nor one marked
  // or with a line in its place. A done one does, down only.
  rowSlides(t){ return !this.lines[t.id] && !this.leaving[t.id] && !t.pending && this.canTick(t) && !this.isRunTask(t) && !(!t.done && this.ringOf(t)); },
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
      if (!x || x.done || !this.rowSlides(x)) continue;
      this.hint.at = t.id;
      if (store.get('hint.slide') !== 'said') { this.said = 'Tip: swipe a task to the right to start working on it.'; store.set('hint.slide', 'said'); }
      return;
    }
  },
  // Whether the row of `t` in list `g` has the hint's place: a card's top row for its card.
  hintOn(t, g){ return !g.sheet && !g.run && this.hint.at !== null && (g.card ? g.card.step.id === t.id && this.hint.at === g.card.id : this.hint.at === t.id); },
  hintSeen(){ if (this.hint.done) return; this.hint.done = true; store.set('hint.slide', 'done'); this.hintAway(); },
  /* A stacked card (app/cards.js), one of its rows touched: that row's gesture `s` (rowGesture), whose swipe is that
     subtask's alone, and a run's card then staying on its top row until that has gone (pinCard). Its header (`hold`:
     what a hold does to the card, cardHold): the parent's swipe (headGesture), lifting the card when held. */
  cardGesture(card, s, hold = null){
    if (card.matches('.deleted, .lined, .swept')) return null;             // only its Restore or Undo, or its line's action
    if (s?.slide) return {...s, el: hold ? card : s.slide, reorder: hold};
    if (!s) return {el: hold ? card : null, reorder: hold};
    // (Its top row is the same on any screen's card: 'found' asks only that it's an open task with open subtasks.)
    const id = +card.dataset.id, pin = () => { const t = this.tasks[id]; this.pinCard(t && this.cardOf(t, {cards: 'found'})); };
    return {...s, finish: s.finish && (pct => { if (pct !== null) pin(); s.finish(pct); })};
  },
  /* A card's header swiped (parent-tasks-plan, part 3): a parent has no progress of its own, so right it springs back,
     unless all the way, which asks about its open subtasks, or closes it with them all done (ringSwipe, ringTap); left,
     its Delete where its list has one, with the question about its subtasks (removeTask). What moves is the header (the
     card stays, its rows under it). Null: nothing to swipe. */
  headGesture(card){
    const t = this.tasks[+card.dataset.id], head = card.querySelector(':scope > .card-head');
    if (!t || !head || this.leaving[t.id] || this.lines[t.id]) return null;
    const swipe = allows(card).has('delete') && this.canDelete(t) ? swipeOf(head, () => this.swipeDelete(t, false, head)) : null, r = this.ringSwipe(t, head, card);
    return r.finish || swipe ? {slide: head, swipe, ...r} : null;
  },
  // A card's heading held, where its list allows (data-gestures, as a row's): the card moved up or down among the tasks
  // at the top of a project's list, as a row is (reorderOf); on Today, carried to another day (rescheduleOf).
  cardHold(card){
    const t = this.tasks[+card.dataset.id], can = allows(card);
    return !t ? null : can.has('reschedule') ? this.rescheduleOf(t, card) : can.has('reorder') ? this.reorderOf(t, card, false) : null;
  },
  /* A task's row moved up or down, among its siblings (orderOf): on a project's list, or in a task's sheet. Let go
     somewhere else, it's moved there (reorder). What moves for each sibling: at the top of a list with cards, its item,
     a row or a card with its rows; on a card, or in a sheet, its row. */
  reorderOf(t, row, sheet){
    const o = this.orderOf(t, sheet ? 'sheet' : 'list');
    if (!o || o.sibs.length < 2) return null;
    const el = row.parentElement.matches('.item') ? row.parentElement : row;
    const box = el.parentElement, rows = id => [...box.querySelectorAll(`:scope > [data-id="${id}"]`)];
    const blocks = (o.blocks || o.sibs.map(s => ({ids: [s.id]}))).map(b => b.ids.flatMap(rows));
    if (blocks.some(b => !b.length)) return null;
    return dragOf(blocks, o.sibs.findIndex(s => s.id === t.id), sheet ? this.$refs.sheet.querySelector('.scroll') : null,
      to => this.reorder(t, o.sibs, to, o.view));
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
  /* A run's step swiped on its row, as a task's is: not one waiting to be sent, or in a finished run, or done by a full
     swipe and waiting for the batch (its gap: only its Undo); a done one only down, not done again (stepProgress). With
     no one on it, it's then yours, as a task's is; a full swipe is done, through the outbox, leaving a gap whose Undo
     unticks it. Swiped left at 0%, only a step inserted or repeated during the run, not done, has a Delete
     (swipeDeleteStep); a template's step stops at 0%. */
  stepSlide(row, target){
    const v = this.runView, s = v?.steps.find(x => String(x.id) === row.dataset.id);
    if (!s || s.pending || this.swept[s.id] || v.finished || !this.canWrite(this.view.run.run.project_id) || target.closest('.step-del')) return null;
    return {el: row, start: s.done ? 100 : s.pct, width: row.clientWidth, swipe: s.added && !s.done ? swipeOf(row, () => this.swipeDeleteStep(s, row)) : null,
      finish: pct => {
        if (pct === null) return;
        this.claimOnSlide(s.slot)(true);
        const setting = this.stepProgress(s, pct);
        if (pct >= 100) sweep(row, setting, true);
      }};
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
      if (!head || !t || this.sheetRing || this.ofTemplate || target.closest('textarea, button, a, select')) return null;
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
  // The sheet's task's ring, when it's a parent (a task with subtasks, or a run): its progress is theirs.
  get sheetRing(){ return this.sheet.kind === 'task' && !this.ofTemplate ? this.ringOf(this.sheet.task) : null; },
  // The sheet's task's slot for who's doing it, as its row has (claimSlot): its bar, slid or moved by a key, claims it
  // as a row's slide does, if no one is doing it; its Assigned row shows it (peopleOf).
  get sheetSlot(){ const t = this.sheet.task; return t && this.claimSlot(t, this.peopleOf(t.id, t.assignees), t.done, this.stepRun(t)); },
  nudgeProgress(dir){                            // the arrow keys, on the focused bar: to the next snap
    const t = this.sheet.task;
    if (this.sheetRing) return;                  // a parent's progress is its subtasks'
    const was = pctOf(t), pct = nextSnap(was, dir);
    if (pct === was) return;
    const claimed = this.claimOnSlide(this.sheetSlot);
    this.sheetProgress(t, pct).finally(() => claimed(true));
  },
};
