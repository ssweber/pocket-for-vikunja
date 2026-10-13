/* Moves an add box under a row on Today, a project's list, a sheet or a checklist. A margin on the row reserves space
   for the box, and the box follows the row as rows leave, reorder or grow. The position is checked every frame for a
   second after a change, then every 50ms to save CPU. When the browser doesn't keep the scroll position itself,
   removing the margin of a row above the screen would shift the content, so the code scrolls back by that height. */

// Whether the browser keeps the scroll position itself when content above the screen changes height (overflow-anchor).
// Safari doesn't, so Pocket has to.
export const ANCHORS = typeof CSS !== 'undefined' && !!CSS.supports?.('overflow-anchor', 'auto');
const HOT_MS = 1000, IDLE_MS = 50;               // check every frame for HOT_MS after a change, then every IDLE_MS

// Each box tracks its row (el), reserved height (h), position (at) and next check (raf or timer).
const fresh = () => ({el: null, box: null, h: 0, at: '', raf: 0, timer: 0, missed: 0, changed: false, movedAt: 0});
export const seats = {bar: fresh(), sheet: fresh(), run: fresh()};

/* Keep the box under the row that row() returns. `s` is the seat's state (seats.bar, seats.sheet or seats.run). A null
   row puts the box at the bottom. An undefined row means the row isn't rendered yet, so the check waits up to
   `patience` times, then calls lost() and keeps checking. `cls` is the class that reserves space on the row. prop()
   returns [element, custom property] for the box's height. place() returns a string for the box's position, apply()
   sets that position when the string changes, and unplace() removes it. sight() returns the visible bounds, or null
   to skip the check. home() puts an unfocused box back at the bottom when its row scrolls out of sight.
   scrollBack(h) compensates for space removed above the screen. */
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
    // Alpine can render the box after its row, so keep checking until both exist.
    if (el === undefined || (!b && el !== null)) {
      if (++s.missed < patience) return next();                        // keep the previous row's spacing while rendering
      lost?.(); el = null; waiting = true;                             // release the spacing, but keep checking for the row
    } else s.missed = 0;
    room(el);
    // A box that Alpine rendered again needs its position and spacing set again, even if its size is the same.
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
