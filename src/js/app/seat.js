/* Position the add box under a row on Today, a project's list, a sheet or a checklist. A margin reserves the box's
   height under the row, and the box follows the row as rows leave, reorder or grow. Check every frame for a second
   after a change, then every 50ms to reduce idle CPU use. Compensate for removed spacing above the screen when the
   browser doesn't preserve the scroll position. */

// Safari needs Pocket to preserve the scroll position when content above the screen changes height.
export const ANCHORS = typeof CSS !== 'undefined' && !!CSS.supports?.('overflow-anchor', 'auto');
const HOT_MS = 1000, IDLE_MS = 50;               // check every frame for HOT_MS after a change, then every IDLE_MS

// Each box tracks its row (el), reserved height (h), position (at) and next check (raf or timer).
const fresh = () => ({el: null, box: null, h: 0, at: '', raf: 0, timer: 0, missed: 0, changed: false, movedAt: 0});
export const seats = {bar: fresh(), sheet: fresh(), run: fresh()};

/* Keep box `s` under the row returned by row(). A null row puts the box at the bottom. An undefined row waits up to
   `patience` checks for rendering, then calls lost() and keeps checking. `cls` reserves spacing on the row, and
   prop() returns [element, custom property] for the box's height. place() computes a position string, apply() sets
   that position when it changes, and unplace() removes it. sight() returns the visible bounds or null to skip the
   check. home() returns an unfocused box to the bottom when its row scrolls out of sight. scrollBack(h) compensates
   for spacing removed above the screen. */
export function seatUnder(s, {box, row, cls, prop, place, apply, unplace, sight = () => null, home, lost, scrollBack, patience = 60}){
  cancelAnimationFrame(s.raf); clearTimeout(s.timer);
  const room = el => {
    const was = s.el;
    if (was === el) return;
    if (was) {
      const above = was.isConnected && !ANCHORS && was.getBoundingClientRect().bottom + s.h <= (sight()?.top || 0);
      was.classList.remove(cls);
      if (above) scrollBack(s.h);
    }
    el?.classList.add(cls);
    s.el = el; s.changed = true;
  };
  const next = () => {
    const hot = performance.now() - s.movedAt < HOT_MS;
    if (hot) s.raf = requestAnimationFrame(step);
    else s.timer = setTimeout(() => { s.raf = requestAnimationFrame(step); }, IDLE_MS);
  };
  const step = () => {
    const b = box();
    let el = row(), waiting = false;
    // Alpine can draw the form after its row. Keep checking until both are available.
    if (el === undefined || (!b && el !== null)) {
      if (++s.missed < patience) return next();                        // keep the previous row's spacing while rendering
      lost?.(); el = null; waiting = true;                             // release the spacing, but keep checking for the row
    } else s.missed = 0;
    room(el);
    // A form drawn again needs its position and spacing even when its size has not changed.
    if (b && b !== s.box) { s.box = b; s.h = 0; s.at = ''; }
    b?.classList.toggle('inline', !!el);
    if (!el) { if (s.at) { s.at = ''; unplace(b); } if (waiting) next(); return; }
    const h = b.offsetHeight;
    if (h !== s.h) { s.h = h; prop()[0].style.setProperty(prop()[1], h + 'px'); s.movedAt = performance.now(); }
    const at = place(b, el, s.changed);
    s.changed = false;
    if (at !== s.at) { s.at = at; s.movedAt = performance.now(); apply(b, at); }
    const r = el.getBoundingClientRect(), v = sight();
    if (v && (r.bottom + h < v.top || r.top > v.bottom) && !b.contains(document.activeElement)) return home();
    next();
  };
  s.movedAt = performance.now();
  step();
}
