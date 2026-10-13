/* The add box under a row, one way on every screen (inline-add-box-plan): quick add's box in a project's list or on
   Today (seatBox, quickadd.js), and the box at the foot of a sheet's list or a checklist's steps (seatFoot,
   sheet.js). The row is given room under it (a class whose margin is the box's height, said once as a custom
   property), the box is laid over that room, and where the row is, is asked again as frames go by: rows above fold
   and leave, a row is held and moved, the box grows a line. Every frame while something moved in the last second,
   then a few times a second: a frame asked for costs a phone a frame of its own, an eighth of a slow CPU with the
   box sitting still (scratchpad/seat-idle.mjs). Room taken away above the screen moves everything on it, where the
   browser doesn't hold the page still itself: the page, or the sheet, is scrolled by as much in the same frame. */

// Whether the browser holds the page still itself when something above the screen changes height (Safari doesn't).
export const ANCHORS = typeof CSS !== 'undefined' && !!CSS.supports?.('overflow-anchor', 'auto');
const HOT_MS = 1000, IDLE_MS = 50;               // frames asked for every frame this long after a change, then every so often

// A seat's state: the row given room (el), how much (h), where the box is (at), and the frame or wait that asks next.
const fresh = () => ({el: null, h: 0, at: '', raf: 0, timer: 0, missed: 0, changed: false, movedAt: 0});
export const seats = {bar: fresh(), sheet: fresh(), run: fresh()};

/* Seat `s` (seats), asked again from now, by what its box is:
   box(): the box's element, or null (a sheet's, closed);
   row(): the row the box is under: an element; null, none (at the bottom or the foot); undefined, not drawn yet (one
     just added is a frame or two away), waited for, `patience` frames, then `lost()` and none;
   cls: the class that gives the row room, and prop: [element, name], where the box's height is said for it;
   place(box, row, changed): where the box goes, as a string, `changed` when the row is another since last asked;
   apply(box, at): lays the box there, once that changes; unplace(box): takes it off a row;
   sight(): {top, bottom} of what's in sight, or null not to ask (the list's cursor is watched on its own, watchCursor):
     the row out of it, and the box not being typed in, home() brings the box back;
   scrollBack(h): scrolls what the row is in by the room taken away above the screen. */
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
    let el = b ? row() : null, waiting = false;
    if (el === undefined) {
      if (++s.missed < patience) return next();                        // the row it had keeps its room meanwhile
      lost?.(); el = null; waiting = true;                             // (none to wait: asked again until it's drawn)
    } else s.missed = 0;
    room(el);
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
