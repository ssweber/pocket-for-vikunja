/* The timer that lets rows marked done or deleted leave the list together (app/leaving.js). They go BATCH_MS after the
   last mark. Each mark, touch and scroll starts the wait over, and it never runs out while a finger is down or the
   list is scrolling, so nothing moves under a finger. `go` is called once for everything waiting. There is no screen
   in here, so the unit tests can drive it with their own timers. */
export const BATCH_MS = 3000;
/* On a collapsed card, a top row marked done gives its place to the next subtask after TOP_MS, by the same rules
   (clearTops, app/leaving.js). The next subtask is what the user is waiting for, so it comes sooner. Long enough to
   see the tick, and to tap it again to take it back. */
export const TOP_MS = 1500;

export function batchTimer(go, ms = BATCH_MS){
  let waiting = false, scrolling = false, timer = null;
  const fingers = new Set();
  const arm = () => { clearTimeout(timer); timer = waiting && !fingers.size && !scrolling ? setTimeout(fire, ms) : null; };
  const fire = () => { timer = null; waiting = false; go(); };
  return {
    get waiting(){ return waiting; },
    // A row was marked. Everything waiting goes `ms` from now, or from when the finger lifts.
    mark(){ waiting = true; arm(); },
    // A finger down holds everything. When it lifts, the wait starts over. `id` is the pointer's, as two fingers can
    // be down at once.
    down(id){ fingers.add(id); arm(); },
    up(id){ if (fingers.delete(id)) arm(); },
    // Scrolling holds everything too, until it stops.
    scroll(on){ if (scrolling === on) return; scrolling = on; arm(); },
    // The caller has cleared the rows itself, on leaving the screen or putting Pocket away, so nothing is waiting.
    now(){ clearTimeout(timer); timer = null; fingers.clear(); waiting = false; },
    // Every mark was undone, so there is nothing to go.
    stop(){ waiting = false; arm(); },
  };
}
