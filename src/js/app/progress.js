// The gestures on a row: swipe, hold and nudge. Swiping right raises progress, and a full swipe marks the task done.
// Swiping left lowers progress to 0%. On a row at 0% it shows Delete, and a full swipe deletes. Nothing is saved until
// the user releases. Holding a row lets the user drag it among its siblings, or on Today pick a new date (throw.js).
// The arithmetic is in ../progress.js.
import {
  DELETE_W,
  HOLD_MS,
  inTextField,
  isNudge,
  lockDirection,
  pctOf,
  releaseSpeed,
  SWIPE_PX,
  SWIPE_SLOPE,
  swipeAt,
  swipeFeel,
  swipeStarts,
  trackMoves,
} from '../progress.js';
import { dragPlace } from '../order.js';
import { haptic } from '../haptics.js';
import { motion, store } from '../util.js';
import { SAID } from '../messages.js';

export let sliding = false; // true while a row is held or swiped, so the sheet can't be swiped away at the same time
let opened = null; // the row resting open on its Delete button
// The scroll positions of the page and the sheet when a row was swiped open. Scrolling either one further closes the
// row.
const scrolled = () => [scrollY, document.querySelector('#sheet .scroll')?.scrollTop || 0];
let openAt = [0, 0];
let swallowClick = false;
// The gestures a row's list allows besides progress. The row carries them in data-gestures, because the gesture code
// can't reach the list's options (`g`) from the element.
const allows = row => new Set((row.dataset.gestures || '').split(' '));
// Swallow the click that ends a hold or a swipe, or that closed an open row. That click is not a tap on the row.
const swallow = () => {
  swallowClick = true;
  setTimeout(() => (swallowClick = false), 400);
};
// A long press would select the text under the touch, or the nearest selectable text, such as the headings around a
// sheet's subtasks. So no selection starts while a row is held or swiped. A selection that already exists is cleared
// when the hold ends and when the row moves. This is one function so the listener is added only once.
const noSelect = e => {
  if (sliding) e.preventDefault();
};
// The values of swipeAt's `to` that show the red Delete layer. Any other value shows the progress ring on green.
const RED = new Set(['shut', 'open', 'delete']);
// The classes a swipe puts on its row (styles.css): moved aside for progress, moved aside for Delete, resting open on
// Delete, and past the point where releasing deletes.
const SWIPED = ['revealing', 'swiping', 'swiped', 'swipe-full'];

/* Only the row moves during a swipe. The row follows the touch by its transform alone (slideTo). On release, one
   animation of that transform takes the row back to rest or off the screen (glide). The layer the row uncovers does not
   move (lay). No two animations have to stay in step. That matters on a phone in power-saving mode, which animated the
   uncovered layer's width at half the frame rate of the row's transform, and the ✓ shook. */
const SLIDE_MS = 200,
  BACK_MS = 150;
const slideTo = (row, x) => {
  row.style.transform = x ? `translateX(${x}px)` : '';
};
// How far the row is from its resting position now, in px, even in the middle of a glide.
const asideOf = row => new DOMMatrix(getComputedStyle(row).transform).m41;
const gliding = new WeakMap(); // row -> the animation that is moving it
const stopGlide = row => {
  const a = gliding.get(row);
  gliding.delete(row);
  a?.cancel();
};
/* Animate a released row from where it is to `to` px from its resting position. The transform is set to `to` at once
   (the row's own transition is off while it is swiped, see styles.css), and one animation shows the move. With reduced
   motion the row jumps there. Resolves to true when the row arrives. Resolves to false if another glide or a new swipe
   took the row first (stopGlide), so the caller does nothing more. */
function glide(row, to) {
  const from = asideOf(row);
  stopGlide(row);
  slideTo(row, to);
  if (!motion() || from === to) return Promise.resolve(true);
  const a = row.animate([{ transform: `translateX(${from}px)` }, { transform: `translateX(${to}px)` }], {
    duration: SLIDE_MS,
    easing: 'ease-out',
  });
  gliding.set(row, a);
  return a.finished.then(
    () => {
      if (gliding.get(row) === a) gliding.delete(row);
      return true;
    },
    () => false,
  );
}
/* Put `el`, the layer a swiped row uncovers, under the row. The layer covers the row's full height and width, whatever
   the row's indent. It goes inside the row's offsetParent (its list, item or card), which clips the layer to rounded
   corners (styles.css names these boxes). The layer is prepended, so every row is drawn over it. It must also come
   before the list's <template>, because Alpine's x-for reorders the elements after its template and would move the
   layer. The layer is created when a swipe starts and removed when the row covers it again, so rows don't each carry
   one. If the list changes meanwhile, a ResizeObserver puts the layer back at the row's position, or removes it if the
   row is gone. */
const laid = new WeakMap(); // row -> {el, seen}: its layer and the observer
const place = (row, el) =>
  Object.assign(el.style, {
    top: row.offsetTop + row.clientTop + 'px',
    left: row.offsetLeft + 'px',
    width: row.offsetWidth + 'px',
    height: row.clientHeight + 'px',
  });
function lay(row, el) {
  unlay(row);
  const box = row.offsetParent;
  if (!box) return;
  el.classList.add('row-under');
  place(row, el);
  box.prepend(el);
  const seen = window.ResizeObserver
    ? new ResizeObserver(() => {
        if (row.isConnected) place(row, el);
        else unlay(row);
      })
    : null;
  seen?.observe(box);
  seen?.observe(row);
  laid.set(row, { el, seen });
}
function unlay(row) {
  const u = laid.get(row);
  if (!u) return;
  u.seen?.disconnect();
  u.el.remove();
  laid.delete(row);
}
// Glide the row back to rest, then remove the layer it uncovered.
const home = row =>
  glide(row, 0).then(there => {
    if (there) {
      row.classList.remove(...SWIPED);
      unlay(row);
    }
  });
// Close a row that is resting open on its Delete button. Defaults to the open row.
const shut = (row = opened) => {
  if (!row) return;
  if (opened === row) opened = null;
  row.classList.remove('swipe-full');
  laid.get(row)?.el.classList.remove('full');
  return home(row);
};
// Reset a row for a new swipe. Any glide stops and the old layer is removed. A row resting open on its Delete stays
// open, and the swipe continues from there.
const fresh = row => {
  stopGlide(row);
  if (opened === row) return;
  unlay(row);
  row.classList.remove(...SWIPED);
  slideTo(row, 0);
};

/* The Delete layer, shown when a row at 0% is swiped left, as in a phone's mail app. The row moves with the touch from
   its resting position, or from -DELETE_W if it is already open (`base`). The layer is red and covers the whole row
   (light red until releasing would delete, see styles.css). A real button sits at its end, labelled with the task's
   name (`name`). Only the button shows while the row rests open, so the button never moves or changes size.
   Releasing a third of the way across the button or further leaves the row open on it. Releasing sooner closes the row.
   Once the row has rested open, the red stays solid. Past the left side's full point the red turns solid and releasing
   deletes, as tapping the button does (`remove`, which calls sweep). The button exists only after a swipe, so keyboard
   and screen-reader users delete from the task's ⋯ menu. The specimen page draws its stills with this too. */
export const swipeOf = (row, remove, name = '') => ({
  base: opened === row ? -DELETE_W : 0,
  begin() {
    if (opened !== row) shut();
    row.classList.add('swiping');
    if (laid.get(row)?.el.matches('.row-red')) return; // already open on Delete: the layer exists and stays solid red
    const el = document.createElement('span'),
      del = document.createElement('button');
    el.className = 'row-red';
    el.style.setProperty('--open', DELETE_W + 'px');
    del.type = 'button';
    del.className = 'row-del';
    del.textContent = 'Delete';
    del.setAttribute('aria-label', 'Delete ' + name);
    // A tap on Delete vibrates and deletes. Taps are ignored while the row is already sliding off.
    del.addEventListener('click', () => {
      if (away.has(row)) return;
      haptic('done');
      remove();
    });
    el.append(del);
    lay(row, el);
  },
  move({ off, to }) {
    const full = to === 'delete';
    if (full !== row.classList.contains('swipe-full')) {
      row.classList.toggle('swipe-full', full);
      laid.get(row)?.el.classList.toggle('full', full);
    }
    slideTo(row, off);
  },
  end(to) {
    if (to === 'delete') {
      remove();
      return;
    } // the row slides off from where the user released it (sweep)
    if (to !== 'open') {
      shut(row);
      return;
    }
    row.classList.remove('swiping', 'swipe-full');
    row.classList.add('swiped');
    laid.get(row)?.el.classList.remove('full');
    laid.get(row)?.el.classList.add('open'); // resting open: the layer is a solid red button from now on
    opened = row;
    openAt = scrolled();
    glide(row, -DELETE_W);
  },
  // Remove the Delete layer at once, because the progress layer replaces it (revealOf).
  drop() {
    if (opened === row) opened = null;
    fresh(row);
  },
});

/* The progress layer, shown when a row is swiped to set progress. It holds a large ring shaped like the tick. The ring
   fills a quarter at a time when swiping right and empties when swiping left, so the user sees each stop even when the
   phone doesn't vibrate. Past the right side's full point the ring is full, with a ✓ on solid green. Nothing changes
   between two stops, so nothing bounces. The layer sits under the row (lay) with the ring at the list's edge, where the
   row uncovers it first. The specimen page draws its stills with this too. */
export const revealOf = row => {
  let el = null,
    shown = '';
  return {
    move({ off, pct, to }) {
      if (!el) {
        el = document.createElement('span');
        el.className = 'row-prog';
        el.setAttribute('aria-hidden', 'true');
        el.innerHTML = '<span class="ring"><svg class="i"><use href="#i-check"/></svg></span>';
        el.classList.toggle('sq', !!row.querySelector(':scope > .check.sq'));
        el.classList.toggle('head', row.matches('.card-head'));
        lay(row, el);
        row.classList.add('revealing');
      }
      const side = off < 0 ? 'right' : 'left',
        now = `${pct} ${side} ${to}`;
      if (now !== shown) {
        shown = now;
        el.dataset.pct = pct;
        el.dataset.side = side;
        el.classList.toggle('full', to === 'done');
        el.style.setProperty('--ring', pct / 100);
      }
      slideTo(row, off);
    },
    // Glide the row back to rest, then remove the layer.
    back() {
      if (el) home(row);
      el = null;
    },
    // Remove the progress layer at once, because the Delete layer replaces it (swipeOf). This happens when a row at 0%
    // is swiped back left past where it started.
    drop() {
      if (el) fresh(row);
      el = null;
    },
  };
};

/* Finish a full swipe by sliding the row off the screen. A swipe right (`right`) marks the task done. The row slides
   off over the green layer and does not slide back. The green fades, and the row shows as done in place, where tapping
   its tick undoes it. A deleted row slides off to the left over the red layer and leaves a gap with "Deleted" and
   Restore. Either way it is one animation of the row's transform (glide). With reduced motion the row changes at once.
   The result shows when the slide ends, not when Vikunja answers. `going` is the save, or the deletion held back to
   send later. The row must count as done or deleted from the moment of release, so that anything computed from the
   marks, such as a card's top row, is the same before, during and after the slide. For a tick, toggleDone's holdRow
   does that. For a deletion, `gap()` does it here (gapNow, leaving.js). markRow takes over once the mark exists.
   `host` is the element that will show the gap: the row, or the card for a card's header. It keeps its look until the
   row arrives (.sweeping, styles.css). With `wait`, no gap will appear (the sheet's own row, whose sheet closes, or a
   deleted checklist step), so the row stays off the screen until `going` settles. Resolves to the result of `going`. If
   the task was not deleted after all, the gap is gone and the row is back. */
const away = new WeakSet(); // rows sliding off the screen, which can't be swiped until they return
async function sweep(row, going, { right = false, host = row, gap = null, wait = false } = {}) {
  if (opened === row) opened = null; // a scroll or a tap elsewhere must not try to close this row
  going = Promise.resolve(going).catch(() => false);
  away.add(row);
  row.classList.add(right ? 'revealing' : 'swiping');
  host.classList.add('sweeping');
  if (!right) laid.get(row)?.el.classList.add('sure'); // deleting: the layer is solid red whether or not its button was tapped
  gap?.();
  await glide(row, right ? row.clientWidth : -row.clientWidth);
  if (wait) await going;
  // Move the row's content back to rest at once, hidden under the layer, which stays on top for now. The row's own
  // transition is still off here, so the content does not slide back.
  const under = laid.get(row)?.el;
  under?.classList.add('going');
  slideTo(row, 0);
  void row.offsetWidth;
  row.classList.remove(...SWIPED);
  host.classList.remove('sweeping');
  away.delete(row);
  if (under) {
    if (motion() && row.isConnected)
      await under
        .animate([{ opacity: 1 }, { opacity: 0 }], { duration: BACK_MS, easing: 'ease-out' })
        .finished.catch(() => {});
    if (laid.get(row)?.el === under) unlay(row);
  }
  return going;
}

/* Scroll the page, or the sheet (`scroller`), while a held row is near its top or bottom edge. The closer the touch
   (`y()`) is to the edge, the faster it scrolls. `moved()` repositions the held rows after each scroll. */
const ZONE = 72; // px from an edge where auto-scroll starts
const edgeRoll = (scroller, y, moved) => {
  let frame = null;
  const top = () => (scroller ? scroller.scrollTop : scrollY);
  const view = () => {
    const r = scroller?.getBoundingClientRect();
    return r ? [r.top, r.bottom] : [0, innerHeight - (document.getElementById('capture')?.offsetHeight || 0)];
  };
  const roll = () => {
    const [lo, hi] = view(),
      at = y(),
      v = at < lo + ZONE ? -(lo + ZONE - at) / 6 : at > hi - ZONE ? (at - hi + ZONE) / 6 : 0;
    if (v) {
      const was = top();
      if (scroller) scroller.scrollTop += Math.max(-14, Math.min(14, v));
      else scrollBy(0, Math.max(-14, Math.min(14, v)));
      if (top() !== was) moved();
    }
    frame = requestAnimationFrame(roll);
  };
  return {
    top,
    start() {
      frame = requestAnimationFrame(roll);
    },
    stop() {
      cancelAnimationFrame(frame);
    },
  };
};
/* After a drag ends, animate the held rows from their old tops (`was`) to where they are now drawn. That is the new
   position, or the old one if nothing moved. A row that was redrawn is found by its id. */
const slideHome = (els, was, all = els) =>
  requestAnimationFrame(() => {
    const slide = motion();
    els.forEach((el, i) => {
      const now = el.isConnected ? el : document.querySelector(`#view .list > [data-id="${el.dataset.id}"]`);
      const d = now && was[i] - now.getBoundingClientRect().top;
      if (slide && now && Math.abs(d) > 1)
        now.animate([{ transform: `translateY(${d}px)` }, { transform: 'none' }], {
          duration: 160,
          easing: 'ease-out',
        });
    });
    for (const el of all) el.style.transition = '';
  });

/* The drag that follows a hold: move a row up or down among its siblings. `blocks` holds each sibling's rows in order
   (a task and the subtasks under it), and `k` is the index of the held sibling. Its rows follow the touch. Each sibling
   whose middle it passes shifts to make space, and the phone vibrates (dragPlace). Near the top or bottom edge, the
   page or the sheet (`scroller`) scrolls (edgeRoll). On release every row's transform is cleared, and `drop(to)` gets
   the new index if the row moved, so the list can redraw in the new order. The held rows then slide into place
   (slideHome). */
const dragOf = (blocks, k, scroller, drop, begin) => {
  let boxes,
    fy = 0,
    y = 0,
    at = k,
    from = 0;
  const all = blocks.flat(),
    mine = blocks[k],
    list = mine[0].parentElement;
  const place = () => {
    const p = dragPlace(boxes, k, fy + roll.top() - from);
    blocks.forEach((els, i) => {
      for (const el of els)
        el.style.transform = i === k ? `translateY(${p.dy}px)` : p.shifts[i] ? `translateY(${p.shifts[i]}px)` : '';
    });
    if (p.at !== at) {
      at = p.at;
      haptic('tick');
    }
  };
  const roll = edgeRoll(scroller, () => y, place);
  return {
    start(y0) {
      begin?.();
      y = y0;
      from = roll.top();
      boxes = blocks.map(els => {
        const a = els[0].getBoundingClientRect(),
          b = els.at(-1).getBoundingClientRect();
        return { top: a.top, height: b.bottom - a.top };
      });
      list.classList.add('reordering');
      for (const el of mine) el.classList.add('dragged');
      roll.start();
    },
    move(dy, y1) {
      fy = dy;
      y = y1;
      place();
    },
    end(commit) {
      roll.stop();
      const was = mine.map(el => el.getBoundingClientRect().top);
      for (const el of all) {
        el.style.transition = 'none';
        el.style.transform = '';
      }
      list.classList.remove('reordering');
      for (const el of mine) el.classList.remove('dragged');
      if (commit && at !== k) drop(at);
      slideHome(mine, was, all); // the list has redrawn in its new order by now
    },
  };
};

export default {
  /* Handle touches on the rows in `area`. `find(target)` returns what the touched row allows, or null: {el: the row,
     swipe: its Delete layer if it has one (swipeOf), reorder: the hold gesture if the row can be held (dragOf), and if
     its progress can be swiped: start (100 for a done task), width, finish(pct) (null if nothing changed, 100 for a
     full swipe), and springs (the row returns to rest whatever the release did, as a parent's row and the sheet's own
     row do)}.
     A clear sideways move with no hold is a swipe (swipeStarts, swipeAt). The row's content moves with the touch, and
     the uncovered layer shows what releasing will do: the progress stops (revealOf) or Delete (swipeOf). The phone
     vibrates at each stop (swipeFeel). Nothing is saved until release. Swiping left only lowers a row with progress, to
     0%. A row at 0% shows Delete. A row whose progress can't be swiped has only Delete, to the left. A row already open
     on Delete can be swiped either way.
     A vertical move is a scroll. So is a sideways move the row doesn't accept, which does nothing and is not a tap.
     Holding still lifts the row, and the phone vibrates. A lifted row can only be dragged up or down (`reorder`:
     start(y), move(dy, y), end(commit)). Nothing scrolls or swipes until release, and a sideways move drops the row
     without changing anything. A hold with `reorder.lift` (the dates on Today, throw.js) starts at once with lift(x,
     y), and then follows the touch in any direction with move(dy, y, x).
     A touch that starts in a text field belongs to the field (inTextField). A touch on a row beside a focused field is
     still a gesture, because swiping while the add box is focused is the fast way to work. */
  holdToSlide(area, find) {
    let g = null;
    document.addEventListener('selectstart', noSelect, true);
    const stop = commit => {
      if (!g) return;
      clearTimeout(g.timer);
      sliding = false;
      const { s, mode, r, ring } = g;
      g = null;
      s.el?.classList.remove('held');
      s.reorder?.el?.classList.remove('held');
      if (mode === 'reorder') {
        s.reorder.end(commit);
        return;
      }
      if (mode !== 'swipe') return;
      /* Releasing on a stop sets the progress, and the row returns to rest with its tick showing the new value.
         Releasing on the row's own stop changes nothing. On the Delete layer (a row at 0%), the row stays open on the
         button or closes. Past a side's full point the full action runs and the row slides off the screen: `finish` for
         done, or the Delete layer's `remove` for deleted, which leaves the progress as it was. If the system cancels
         the touch (pointercancel), the row returns to rest and nothing changes. */
      const to = commit ? r.to : 'shut',
        set = commit && to !== 'delete' && r.pct !== null && r.pct !== s.start;
      if (s.springs && set) {
        s.finish(r.pct);
        ring.back();
        return;
      } // a parent's row asks its question, and the sheet's own row ticks in place
      if (RED.has(r.to)) s.swipe.end(to);
      else if (to !== 'done' || s.springs) ring.back();
      s.finish?.(set ? r.pct : null);
      if (set) this.hintSeen(); // the first swipe that sets progress dismisses the swipe hint
    };
    // Whether the row accepts a sideways swipe in direction `dx`: to change progress, if progress can move that way, or
    // to show Delete, to the left.
    const wayOf = (s, dx) =>
      s.swipe?.base || (s.finish && trackMoves(s.start, dx)) || (dx < 0 && s.swipe) ? 'swipe' : null;
    area.addEventListener('pointerdown', e => {
      if (g || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
      swallowClick = false; // a new press, so its click must not be swallowed
      // A touch in a text field, such as a title being edited in a row, belongs to the field and is never a gesture.
      let s = inTextField(e.target) ? null : find(e.target);
      if (!s || away.has(s.slide || s.el)) return;
      if (s.swipe?.base) s = { el: s.el, slide: s.slide, swipe: s.swipe, width: s.width }; // a row open on Delete can be swiped or tapped closed, but not held, and its progress is 0%
      g = { s, id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, mode: 'wait' };
      // After HOLD_MS the row lifts. On a project's list the whole card lifts. On Today the dates appear at once.
      if (s.reorder)
        g.timer = setTimeout(() => {
          sliding = true;
          getSelection()?.removeAllRanges();
          haptic('hold');
          if (s.reorder.lift) {
            g.mode = 'reorder';
            s.reorder.lift(g.x, g.y);
            return;
          }
          g.mode = 'held';
          (s.reorder.el || s.el)?.classList.add('held');
          s.reorder.held?.(); // prepare for a drag (reorderOf draws the rest of a long list)
        }, HOLD_MS);
    });
    // Where a row swiped by `dx` sits, and what releasing there does (swipeAt).
    const at = (s, dx) =>
      swipeAt({
        start: s.finish ? s.start : null,
        dx,
        x: g.x0,
        width: s.width ?? s.el.clientWidth,
        screen: innerWidth,
        del: !!s.swipe,
        base: s.swipe?.base || 0,
        one: !!s.one,
        side: g.side,
      });
    // Moves and the release are listened for on the window, so a press that ends outside `area` still ends.
    addEventListener('pointermove', e => {
      if (!g || e.pointerId !== g.id) return;
      const s = g.s;
      if (g.mode === 'wait') {
        const dx = e.clientX - g.x0,
          dy = e.clientY - g.y0;
        if (Math.hypot(dx, dy) <= SWIPE_PX) {
          g.x = e.clientX;
          g.y = e.clientY;
          return;
        }
        // The move is more sideways than vertical, but not clearly so (SWIPE_SLOPE). Wait until it is clear, or until
        // the page scrolls. The touch has moved too far to be a hold, so the hold timer is cancelled and a pause here
        // won't lift the row.
        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) <= Math.abs(dy) * SWIPE_SLOPE) {
          clearTimeout(g.timer);
          g.moved = true;
          return;
        }
        const way = swipeStarts(dx, dy, g.x0, innerWidth, !!s.swipe?.base) && wayOf(s, dx);
        // The row doesn't accept this swipe. A sideways move does nothing, and its click is swallowed so that releasing
        // a mouse doesn't open the task. A vertical move is a scroll.
        if (!way) {
          if (Math.abs(dx) > Math.abs(dy)) swallow();
          stop(false);
          return;
        }
        clearTimeout(g.timer);
        g.mode = way;
        sliding = true;
        // A swipe stays on the side it starts on, which this first sideways move decides. A row open on Delete is on
        // the left side.
        if (way === 'swipe') {
          g.side = s.swipe?.base || dx < 0 ? 'left' : 'right';
          fresh(s.slide || s.el);
          g.ring = revealOf(s.slide || s.el);
          g.r = at(s, 0);
          g.red = null;
        }
      }
      if (g.mode === 'swipe') {
        const r = at(s, e.clientX - g.x0),
          red = RED.has(r.to);
        // Switch between the Delete layer and the progress layer when the swipe crosses from one to the other.
        if (red !== g.red) {
          if (red) {
            g.ring.drop();
            s.swipe.begin();
          } else if (g.red) s.swipe.drop();
          g.red = red;
        }
        if (red) s.swipe.move(r);
        else g.ring.move(r);
        const feel = swipeFeel(g.r, r);
        if (feel) haptic(feel);
        g.r = r;
        return;
      }
      if (getSelection()?.rangeCount) getSelection().removeAllRanges(); // clear any text the long press selected near the row
      if (g.mode === 'held') {
        const way = lockDirection(e.clientX - g.x, e.clientY - g.y);
        if (!way) return;
        // A held row can only move up or down, so a sideways move ends the hold.
        if (way === 'x') {
          swallow();
          stop(false);
          return;
        }
        g.mode = 'reorder';
        s.reorder.start(e.clientY);
      }
      if (g.mode === 'reorder') s.reorder.move(e.clientY - g.y, e.clientY, e.clientX);
    });
    addEventListener('pointerup', e => {
      if (!g || e.pointerId !== g.id) return;
      if (g.mode === 'wait' && g.s.swipe?.base) shut(); // a tap on an open row only closes it
      if (g.mode !== 'wait' || g.s.swipe?.base || g.moved) swallow(); // a move that never became a swipe is not a tap either
      stop(true);
    });
    addEventListener('pointercancel', e => {
      if (g && e.pointerId === g.id) stop(false);
    });
    // While a row is held or swiped, the page must not scroll, and a long press must not open the browser's menu.
    area.addEventListener(
      'touchmove',
      e => {
        if (g && g.mode !== 'wait') e.preventDefault();
      },
      { passive: false },
    );
    area.addEventListener('contextmenu', e => {
      if (g) e.preventDefault();
    });
    area.addEventListener(
      'click',
      e => {
        if (swallowClick) {
          swallowClick = false;
          e.preventDefault();
          e.stopPropagation();
        }
      },
      true,
    );
  },
  // Set up the gestures on the main screen's rows: swipe for progress or Delete, hold to move. A checklist step works
  // the same way, through the outbox.
  initProgressDrag() {
    // A row resting open on Delete closes when the user touches anything else, or when anything scrolls. A touch on the
    // row itself swipes it or taps it closed (holdToSlide). A touch on its Delete button deletes.
    document.addEventListener(
      'pointerdown',
      e => {
        if (opened && !opened.contains(e.target) && !laid.get(opened)?.el.contains(e.target)) shut();
      },
      true,
    );
    addEventListener(
      'scroll',
      () => {
        if (opened && !sliding && scrolled().some((y, i) => Math.abs(y - openAt[i]) > 10)) shut();
      },
      { capture: true, passive: true },
    );
    this.holdToSlide(document.getElementById('view'), target => {
      // On a stacked card, each row behaves like any row (cardGesture), and the header takes the parent's gestures
      // (headGesture). On a project's list, holding the header moves the card (cardHold). The footer (More, Less) and
      // Close only take taps.
      if (target.closest('#run-own > .row')) return this.runRowGesture(target.closest('.row'));
      const card = target.closest('.day-card'),
        row = target.closest('.card-rows > .row, .list:not(.tree) > .row, .item > .row');
      // A visible Delete layer is under its row, not inside it, so a touch on it finds no row and stays a plain tap.
      if (card && !row)
        return target.closest('.card-head')
          ? this.cardGesture(card, this.headGesture(card), this.cardHold(card))
          : null;
      if (!row) return null;
      if (row.parentElement.id === 'run-steps') return this.stepSlide(row, target);
      const t = this.rowTask(+row.dataset.id),
        s = t && this.rowGesture(t, row, false);
      return card ? this.cardGesture(card, s) : s;
    });
    this.watchNudges(document.getElementById('view'));
    // In a sheet's list (a task's subtasks, a template's steps, or New template's steps), a nudge on a row moves the
    // list's add box under that row (nudgedSub, sheet.js).
    this.watchNudges(
      document.getElementById('sheet'),
      target => target.closest('#d-subtasks > .row[data-id]')?.dataset.id ?? null,
      id => this.nudgedSub(id),
    );
  },
  /* Watch for nudges in `area`. A nudge is a touch that starts on a row and becomes a short, slow scroll. It moves the
     add box under that row. It works on a project's list, on Today and on a checklist's steps. isNudge (../progress.js)
     has the thresholds, and `nudged` (quickadd.js) acts on the nudge. A fast flick is only a scroll.
     This listens to passive touch events, so it never blocks scrolling. Pointer events can't be used for touch, because
     the phone ends them (pointercancel) once the page scrolls, while touch events continue. A hold, a swipe or a second
     finger cancels the nudge. A touch that starts in a text field is never a nudge (inTextField).
     A mouse can nudge too: press a row, drag the same short, slow way, and release. The page doesn't scroll under a
     mouse drag, so pointer events continue, and the nudge is read when the button is released. The hold gives up when
     the mouse moves up or down (holdToSlide). The click that follows would open the row, so it is swallowed. */
  watchNudges(area, pick = null, nudged = id => this.nudged(id)) {
    // The id that a press on `target` nudges: the task of a row, of a card's row or of a card's header. With `pick`,
    // whatever `pick` returns for the target. Null in a text field.
    const idOf = target => {
      if (inTextField(target)) return null;
      if (pick) return pick(target);
      const run = this.route.name === 'run';
      if (!run && !['project', 'today'].includes(this.route.name)) return null;
      const row =
        target.closest('.card-rows > .row, .item > .row, .list:not(.tree) > .row') ||
        target.closest('.card-head')?.closest('.day-card');
      return row ? (run ? row.dataset.id : +row.dataset.id) : null;
    };
    const press = (id, x, y, t) => ({ id, x0: x, y0: y, t0: t, far: 0, moves: [{ t, y }] });
    const move = (p, y, t) => {
      p.far = Math.max(p.far, Math.abs(y - p.y0));
      p.moves.push({ t, y });
    };
    const lifted = (p, x, y, t) =>
      isNudge({
        dx: x - p.x0,
        dy: Math.max(p.far, Math.abs(y - p.y0)),
        ms: t - p.t0,
        speed: releaseSpeed(p.moves, t, y),
      });
    let n = null;
    area.addEventListener(
      'touchstart',
      e => {
        n = null;
        const id = e.touches.length === 1 ? idOf(e.target) : null;
        if (id == null) return;
        n = press(id, e.touches[0].clientX, e.touches[0].clientY, e.timeStamp);
      },
      { passive: true },
    );
    area.addEventListener(
      'touchmove',
      e => {
        if (!n) return;
        if (sliding || e.touches.length !== 1) {
          n = null;
          return;
        }
        move(n, e.touches[0].clientY, e.timeStamp);
      },
      { passive: true },
    );
    area.addEventListener(
      'touchend',
      e => {
        const was = n,
          p = e.changedTouches[0];
        n = null;
        if (!was || e.touches.length || !p) return;
        if (lifted(was, p.clientX, p.clientY, e.timeStamp)) nudged(was.id);
      },
      { passive: true },
    );
    area.addEventListener(
      'touchcancel',
      () => {
        n = null;
      },
      { passive: true },
    );
    // Mouse moves and the release are listened for on the window, because a drag can end off the row. A hold or a swipe
    // that starts during the drag sets `sliding` before this handler sees the move, so the drag is not a nudge.
    let m = null;
    area.addEventListener('pointerdown', e => {
      m = null;
      if (e.pointerType !== 'mouse' || e.button !== 0 || !e.isPrimary) return;
      const id = idOf(e.target);
      if (id != null) m = { pid: e.pointerId, ...press(id, e.clientX, e.clientY, e.timeStamp) };
    });
    addEventListener('pointermove', e => {
      if (!m || e.pointerId !== m.pid) return;
      if (sliding) {
        m = null;
        return;
      }
      move(m, e.clientY, e.timeStamp);
    });
    addEventListener('pointerup', e => {
      const was = m;
      m = null;
      if (!was || e.pointerId !== was.pid) return;
      if (lifted(was, e.clientX, e.clientY, e.timeStamp)) {
        swallow();
        nudged(was.id);
      }
    });
    addEventListener('pointercancel', e => {
      if (m && e.pointerId === m.pid) m = null;
    });
  },
  /* The gestures for a task's row, in a list or in a task's sheet (`sheet`). Swiping sets the task's progress. That is
     off for a task waiting to be sent, a task that can't be ticked, a checklist (its progress comes from its steps) and
     a step in a checklist's sheet. A done task can only be swiped down, which reopens it (setProgress). If no one is
     assigned, changing the progress assigns the task to the user (claimOnSlide). A full swipe marks the task done: the
     row slides off the screen and shows as done in place, like a ticked row (sweep). Where the list allows it (allows),
     swiping left at 0% shows Delete, and holding does what holdOf returns. */
  rowGesture(t, row, sheet) {
    if (this.lines[t.id] || this.leaving[t.id]) return null; // a row replaced by a message, or marked done or deleted, only takes taps
    const slides = sheet
      ? !t.pending && this.canWrite(t.project_id) && this.checklistRole !== 'run'
      : this.rowSlides(t);
    const can = allows(row),
      swipe =
        can.has('delete') && this.canDelete(t, sheet)
          ? swipeOf(row, () => this.swipeDelete(t, sheet, row), t.title)
          : null;
    const reorder = this.holdOf(t, row, sheet, can);
    // A parent's row has a ring, not a tick, and no progress to set. A full swipe counts as a tap on its ring
    // (ringSwipe).
    if (!sheet && this.rowRing(t, { depth: {} })) {
      const r = { el: row, swipe, reorder, ...this.ringSwipe(t, row) };
      return (r.finish || swipe || reorder) && r;
    }
    if (!slides) return (swipe || reorder) && { el: row, swipe, reorder };
    return {
      el: row,
      swipe,
      reorder,
      start: t.done ? 100 : pctOf(t),
      width: row.clientWidth,
      finish: pct => {
        if (pct === null) return;
        this.claimOnSlide(sheet ? this.subSlot(t) : this.rowSlot(t, {}))(true);
        const setting = this.setProgress(t, pct, sheet ? null : row, { sub: sheet || undefined });
        if (pct >= 100) sweep(row, setting, { right: true }); // setProgress already holds the row in place
        if (sheet) this.sheet.dirty = true;
      },
    };
  },
  /* What holding a row does, where its list allows it. On a project's list and in a task's sheet, the row can be
     dragged among its siblings (reorderOf). On Today (`reschedule`), four date chips appear around the touch
     (rescheduleOf, throw.js), and holding a card's row holds the whole card. In search, holding does nothing. */
  holdOf(t, row, sheet, can) {
    if (can.has('reschedule')) {
      const card = row.closest('.day-card');
      return card ? this.rescheduleOf(this.tasks[+card.dataset.id], card) : this.rescheduleOf(t, row);
    }
    return can.has('reorder') ? this.reorderOf(t, row, sheet) : null;
  },
  // Whether a list's row can be swiped to set progress (rowGesture). False for a task waiting to be sent, a task that
  // can't be ticked (read only, or a template), a parent (a checklist, or an open task with subtasks, whose progress
  // comes from them), and a row that is marked or replaced by a message. A done task can be swiped, down only.
  rowSlides(t) {
    return (
      !this.lines[t.id] &&
      !this.leaving[t.id] &&
      !t.pending &&
      this.canTick(t) &&
      !this.isRunTask(t) &&
      !(!t.done && this.ringOf(t))
    );
  },
  /* Pick the row for the one-time hint, "Swipe right to start working on it". It goes on the first open row that can be
     swiped for progress. A card's top row counts, and the hint is stored against the card (`at`), so the card's next
     top row keeps it. The row is picked once, when a screen is first drawn (hint.pick, set by render), so the hint
     never pushes rows down while the user is touching the list. A swipe that sets progress anywhere, or a tap on the
     hint, dismisses it. The hint then fades and keeps its space until no touch is down and the list is still, then
     closes (hintAway, leaving.js). The phone remembers that it was dismissed. A screen reader hears the hint once. */
  pickHint() {
    this.hint.pick = false;
    if (this.hint.done) return;
    for (const g of this.listGroups)
      if (!g.fold)
        for (const t of g.items || g.tasks) {
          const c = this.cardOf(t, g),
            x = c ? c.step : t;
          if (!x || x.done || !this.rowSlides(x)) continue;
          this.hint.at = t.id;
          if (store.get('hint.slide') !== 'said') {
            this.said = SAID.swipeHint;
            store.set('hint.slide', 'said');
          }
          return;
        }
  },
  // Whether the row of `t` in list `g` shows the hint. On a card, that is the card's top row.
  hintOn(t, g) {
    return (
      !g.sheet &&
      !g.run &&
      !g.own &&
      this.hint.at !== null &&
      (g.card ? g.card.step.id === t.id && this.hint.at === g.card.id : this.hint.at === t.id)
    );
  },
  hintSeen() {
    if (this.hint.done) return;
    this.hint.done = true;
    store.set('hint.slide', 'done');
    this.hintAway();
  },
  /* The gestures for a touch on a stacked card (cards.js). `s` is the touched row's gesture (rowGesture), and its swipe
     changes that subtask only. After such a swipe, a checklist's card keeps its top row until that row has left
     (pinCard). `hold` is what holding does to the card (cardHold). A touch on the header takes the parent's swipe
     (headGesture) and lifts the whole card when held. */
  cardGesture(card, s, hold = null) {
    if (card.matches('.deleted, .lined')) return null; // a deleted card, or one replaced by a message, only takes taps
    if (s?.slide) return { ...s, el: hold ? card : s.slide, reorder: hold };
    if (!s) return { el: hold ? card : null, reorder: hold };
    // A card's top row is the same on every screen, so 'found' is enough here: it only requires an open task with open
    // subtasks.
    const id = +card.dataset.id,
      pin = () => {
        const t = this.tasks[id];
        this.pinCard(t && this.cardOf(t, { cards: 'found' }));
      };
    return {
      ...s,
      finish:
        s.finish &&
        (pct => {
          if (pct !== null) pin();
          s.finish(pct);
        }),
    };
  },
  /* The swipe on a card's header. A parent has no progress to set, so a swipe right returns to rest unless it is a full
     swipe. A full swipe asks about the open subtasks, or closes the task when they are all done (ringSwipe, ringTap). A
     swipe left shows Delete where the list allows it, and deleting asks about the subtasks (removeTask). Only the
     header moves. The card and its rows stay. Returns null when there is nothing to swipe. */
  headGesture(card) {
    const t = this.tasks[+card.dataset.id],
      head = card.querySelector(':scope > .card-head');
    if (!t || !head || this.leaving[t.id] || this.lines[t.id]) return null;
    const swipe =
        allows(card).has('delete') && this.canDelete(t)
          ? swipeOf(head, () => this.swipeDelete(t, false, head), t.title)
          : null,
      r = this.ringSwipe(t, head, card);
    return r.finish || swipe ? { slide: head, swipe, ...r } : null;
  },
  // What holding a card's header does, where its list allows it (data-gestures, as on a row). On a project's list the
  // card can be dragged among the top-level tasks, as a row can (reorderOf). On Today, four date chips appear around
  // the touch (rescheduleOf).
  cardHold(card) {
    const t = this.tasks[+card.dataset.id],
      can = allows(card);
    return !t
      ? null
      : can.has('reschedule')
        ? this.rescheduleOf(t, card)
        : can.has('reorder')
          ? this.reorderOf(t, card, false)
          : null;
  },
  /* The drag that moves a task's row among its siblings (orderOf), on a project's list or in a task's sheet. Releasing
     in a new position saves the move (reorder). At the top level of a list with cards, each sibling moves as its whole
     item (a row, or a card with its rows). On a card or in a sheet, each sibling moves as its row. */
  reorderOf(t, row, sheet) {
    const o = this.orderOf(t, sheet ? 'sheet' : 'list');
    if (!o || o.sibs.length < 2) return null;
    const el = row.parentElement.matches('.item') ? row.parentElement : row,
      box = el.parentElement;
    const drag = () => {
      /* Find each sibling's rows in one pass over the list. Asking the list for each sibling's rows walked the whole
         list once per sibling, and this runs on every touch on a row. With 660 rows that took a third of a second
         before a tap, a swipe or a scroll got a response, and seconds on a slow phone. */
      const at = new Map();
      for (const x of box.children) {
        const id = x.dataset?.id;
        if (id !== undefined) at.set(id, [...(at.get(id) || []), x]);
      }
      const blocks = (o.blocks || o.sibs.map(s => ({ ids: [s.id] }))).map(b =>
        b.ids.flatMap(id => at.get(String(id)) || []),
      );
      return blocks.some(b => !b.length)
        ? null
        : dragOf(
            blocks,
            o.sibs.findIndex(s => s.id === t.id),
            sheet ? this.$refs.sheet.querySelector('.scroll') : null,
            to => this.reorder(t, o.sibs, to, o.view),
          );
    };
    if (sheet || !this.drawing) return drag();
    // A list still being drawn in batches (drawFrom, views.js) is drawn in full when the hold starts (`held`), not on
    // touch down, because a touch may be a tap or a scroll. The siblings are found when the row starts to move.
    let d = null;
    return {
      held: () => this.drawAll(),
      start: y => (d = drag())?.start(y),
      move: (dy, y) => d?.move(dy, y),
      end: commit => d?.end(commit),
    };
  },
  // The gestures for a step in a template's sheet or in New template. Holding and dragging changes the step's position
  // in the template's order line, or among the unsaved rows (moveStep). Off while a step is being edited or the
  // template is saving.
  stepReorder(row, target) {
    const steps = this.subList,
      i = steps.findIndex(s => String(s.id) === row.dataset.id),
      can = this.sheet.kind === 'newtpl' || this.canEdit;
    if (i < 0 || !can || this.sheet.stepEdit || this.sheet.checklistBusy || target.closest('button:not(.body)'))
      return null;
    const blocks = steps.map(s => [...row.parentElement.querySelectorAll(`:scope > .row[data-id="${s.id}"]`)]);
    const reorder =
      steps.length > 1 && !blocks.some(b => !b.length)
        ? dragOf(blocks, i, this.$refs.sheet.querySelector('.scroll'), to => this.moveStep(i, to - i, true))
        : null;
    // Swiping left shows Delete, which asks first, as the step's × does (removeStep). If the user cancels, the row
    // closes.
    return {
      el: row,
      reorder,
      swipe: swipeOf(
        row,
        async () => {
          await this.removeStep(i);
          if (row.isConnected) shut();
        },
        row.querySelector('.title')?.textContent || 'this step',
      ),
    };
  },
  /* Delete a task from its row, after a tap on its Delete button or a full swipe. The phone has already vibrated: on
     the tap (swipeOf), or when the swipe passed half way. The row slides off the screen and leaves a gap of the same
     height with Restore (sweep, removeTask).
     A task with subtasks asks before its row slides away. If the phone already knows the task has subtasks
     (hasSubtasks), the row waits where it was released while the subtasks are read and the question is asked
     (askDelete). If the user cancels, the row closes and nothing has changed. If the phone only finds the subtasks
     later, the question comes after the row has gone, and cancelling removes the gap and brings the row back.
     `own` is the sheet's own row. It deletes as the sheet's ⋯ menu does: the sheet closes, and the list shows the gap
     with Restore (deleteTask). No gap is made here. */
  async swipeDelete(t, sheet, row, own = false) {
    if (away.has(row)) return;
    let tree = null;
    if (this.hasSubtasks(t)) {
      if (opened === row) opened = null; // a touch elsewhere must not close the row while the question is open
      away.add(row);
      try {
        tree = await this.askDelete(t);
      } finally {
        away.delete(row);
      }
      if (!tree) {
        shut(row);
        return;
      }
    }
    // For a card's header, the gap belongs to the card.
    const removing = own ? this.deleteTask(tree) : this.removeTask(t, tree),
      host = row.matches('.card-head') ? row.parentElement : row;
    if ((await sweep(row, removing, own ? { wait: true } : { host, gap: () => this.gapNow(t.id, removing) })) && sheet)
      this.sheet.dirty = true;
  },
  /* Delete a step that was inserted or repeated in a checklist, from its row. It asks first, as the × on the step card
     does (askDeleteStep), before the row moves, like a task with subtasks. If the user cancels, the row closes. There
     is no Restore. Once the step is deleted (deleteAddedStep), its row stays hidden in place until the checklist is
     redrawn without it. */
  async swipeDeleteStep(s, row) {
    if (away.has(row)) return;
    if (!this.askDeleteStep(s)) {
      shut(row);
      return;
    }
    await sweep(
      row,
      this.deleteAddedStep(s, false, true).then(ok => {
        if (ok) row.style.visibility = 'hidden';
        return ok;
      }),
      { wait: true },
    );
  },
  /* The gestures for a checklist step's row, the same as a task's. Off for a step waiting to be sent, and in a finished
     checklist. A done step can only be swiped down, and the swipe never marks it done a second time (stepProgress). If
     no one is assigned, changing the progress assigns the step to the user, as for a task. A full swipe marks the step
     done through the outbox, as tapping its box does. The step shows as done in place, and tapping its box unticks it.
     Swiping left at 0% shows Delete only for a step that was inserted or repeated in this checklist and is not done
     (swipeDeleteStep). A step from the template stops at 0%. */
  stepSlide(row, target) {
    const v = this.runView,
      s = v?.steps.find(x => String(x.id) === row.dataset.id);
    if (!s || s.pending || v.finished || !this.canWrite(this.runTask.project_id) || target.closest('.step-del'))
      return null;
    return {
      el: row,
      start: s.done ? 100 : s.pct,
      width: row.clientWidth,
      swipe: s.added && !s.done ? swipeOf(row, () => this.swipeDeleteStep(s, row), s.title) : null,
      finish: pct => {
        if (pct === null) return;
        this.claimOnSlide(s.slot)(true);
        const setting = this.stepProgress(s, pct);
        if (pct >= 100) sweep(row, setting, { right: true });
      },
    };
  },
  // Set up the gestures in a task's sheet: on its own row (sheetRowGesture) and on its subtasks' rows, as in a list.
  initSheetProgress() {
    this.holdToSlide(this.$refs.sheet, target => {
      const own = target.closest('.row.own');
      if (own) return this.sheetRowGesture(own);
      const row = target.closest('#d-subtasks > .row[data-id]:not(.pending)');
      if (!row) return null;
      if (this.isStepList) return this.stepReorder(row, target);
      const st = this.subtasks.find(s => String(s.id) === row.dataset.id);
      return st ? this.rowGesture(st, row, true) : null;
    });
  },
  /* The gestures for the sheet's own row (sheet/task-card.html). It swipes as a row in a list does, for this one task.
     Swiping right sets progress, and a full swipe ticks the task in place: the row returns to rest and shows it done.
     Swiping left lowers progress to 0%. At 0% it shows Delete, which deletes the task as the sheet's ⋯ menu does: the
     sheet closes, and the list shows the gap with Restore (deleteTask). A parent's row behaves like a card's header: a
     swipe right returns to rest, and a full swipe counts as a tap on its ring, from the sheet (ringSwipe). Off for a
     template and its steps (they have no row), for a read-only task, and while the title is being edited. */
  sheetRowGesture(row) {
    const t = this.sheetTask;
    if (!t || this.ofTemplate || !this.canEdit || this.sheet.titleEdit) return null;
    const swipe = this.canDelete(t) ? swipeOf(row, () => this.swipeDelete(t, false, row, true), t.title) : null;
    if (this.sheetRing) {
      const r = this.ringSwipe(t, row, row, true);
      return (r.finish || swipe) && { el: row, swipe, ...r };
    }
    return {
      el: row,
      swipe,
      start: t.done ? 100 : pctOf(t),
      width: row.clientWidth,
      springs: true,
      finish: pct => {
        if (pct !== null) this.setSheetProgress(pct);
      },
    };
  },
  /* The gestures for a checklist's own row at the top of its screen (RUN_ROW). It swipes as a parent's row does: a
     swipe right returns to rest, and a full swipe counts as a tap on its ring, which asks to finish the checklist
     (runRingTap). There is no Delete here. A checklist is deleted from its ⋯ menu, which asks first because its steps
     are deleted too. Off for a finished checklist and a read-only one, as in ringSwipe. */
  runRowGesture(row) {
    const run = this.runOwn;
    if (!run || run.done || !this.canWrite(run.project_id) || !this.runRing) return null;
    return {
      el: row,
      start: 0,
      one: true,
      springs: true,
      width: row.clientWidth,
      finish: pct => {
        if (pct === 100) this.runRingTap();
      },
    };
  },
  // The ring of the sheet's task when it is a parent (a task with subtasks, or a checklist). A parent's progress comes
  // from its subtasks.
  get sheetRing() {
    return this.sheet.kind === 'task' && !this.ofTemplate ? this.ringOf(this.sheetTask) : null;
  },
  // The assignee slot of the sheet's task, the same as its row has (claimSlot). Setting progress from the sheet, by a
  // swipe on its row or in Details, assigns an unassigned task to the user, as a row's swipe does. The Assigned row
  // then shows it (peopleOf).
  get sheetSlot() {
    const t = this.sheetTask;
    return t && this.claimSlot(t, this.peopleOf(t.id, t.assignees), t.done, this.stepRun(t));
  },
  /* Set the progress of the sheet's task, from a swipe on its row or a tap on a quarter in Details. 100% marks it done,
     and a done task reopens at the tapped quarter (sheetProgress). An unassigned task is assigned to the user. The
     claim is sent after the save, because the save's reply predates the claim and would otherwise overwrite it on
     screen. Does nothing for a parent, whose progress comes from its subtasks. */
  setSheetProgress(pct) {
    const t = this.sheetTask;
    if (!t || this.sheetRing || (!t.done && pct === pctOf(t))) return;
    const claimed = this.claimOnSlide(this.sheetSlot);
    return this.sheetProgress(t, pct).finally(() => claimed(true));
  },
};
