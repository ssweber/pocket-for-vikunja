/* When rows marked done or deleted leave the list together (app/leaving.js): BATCH_MS after the last mark, counted
   from when the finger lifts, and never while a finger is down or the list is scrolling, so nothing moves under it.
   Each mark, each touch and each scroll starts the wait again. `go` is called when it's up, once for everything waiting.
   Apart from the screen, so the unit tests can run it with their own timers. */
export const BATCH_MS = 3000;
/* A collapsed card's top row done gives its place to the next subtask sooner (clearTops, app/leaving.js): this long
   after the last mark, by the same rules. Nothing folds there, the next slides up into the same place, and it's the
   one waited for (the user, 2026-10-11: "you'd expect the next one to slide up a little sooner"). Long enough to see
   it ticked, and to tap its tick again to take it back. */
export const TOP_MS = 1500;

export function batchTimer(go, ms = BATCH_MS){
  let waiting = false, scrolling = false, timer = null;
  const fingers = new Set();
  const arm = () => { clearTimeout(timer); timer = waiting && !fingers.size && !scrolling ? setTimeout(fire, ms) : null; };
  const fire = () => { timer = null; waiting = false; go(); };
  return {
    get waiting(){ return waiting; },
    // A row marked: everything waiting goes BATCH_MS from now, or from when the finger lifts.
    mark(){ waiting = true; arm(); },
    // A finger down holds them; lifted, the wait starts again. (`id`: the pointer's, for two fingers at once.)
    down(id){ fingers.add(id); arm(); },
    up(id){ if (fingers.delete(id)) arm(); },
    // The list scrolling holds them too, until it stops.
    scroll(on){ if (scrolling === on) return; scrolling = on; arm(); },
    // Leaving the screen, or Pocket put away: the caller clears them at once, so the wait is over.
    now(){ clearTimeout(timer); timer = null; fingers.clear(); waiting = false; },
    // Nothing waiting any more (each one undone): no need to go.
    stop(){ waiting = false; arm(); },
  };
}
