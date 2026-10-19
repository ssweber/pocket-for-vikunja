/* The timer that lets rows marked done or deleted leave the list together (app/leaving.js). The rows leave BATCH_MS
   after the last mark. Each mark, touch and scroll restarts the wait. The wait never ends while the user is touching
   the screen or the list is scrolling, so no row moves while the user is touching it. `go` is called once for
   everything waiting. The timer touches no screen code, so the unit tests can drive it with their own timers. */
export const BATCH_MS = 3000;
/* On a collapsed card, a top row marked done is replaced by the card's next subtask after TOP_MS (clearTops,
   app/leaving.js). The user is waiting to see that subtask, so this wait is shorter than BATCH_MS. It is still long
   enough to see the tick and to tap it again to undo it. */
export const TOP_MS = 1500;

export function batchTimer(go, ms = BATCH_MS) {
  let waiting = false,
    pended = false, // a regroup waits, which outlasts the marks (pend)
    scrolling = false,
    timer = null;
  const fingers = new Set(),
    idle = []; // what waits for the user to stop touching and scrolling (free)
  const arm = () => {
    clearTimeout(timer);
    timer = waiting && !fingers.size && !scrolling ? setTimeout(fire, ms) : null;
    if (!fingers.size && !scrolling) idle.splice(0).forEach(ok => ok());
  };
  const fire = () => {
    timer = null;
    waiting = pended = false;
    go();
  };
  return {
    get waiting() {
      return waiting;
    },
    // Whether rows must stay where they are now: something waits to leave, or the user is touching or scrolling.
    get holding() {
      return waiting || fingers.size > 0 || scrolling;
    },
    // A regroup waits for the batch. Unlike a mark, it doesn't restart the wait, and it still runs when every mark is
    // undone (stop).
    pend() {
      pended = true;
      if (waiting) return;
      waiting = true;
      arm();
    },
    // A promise that settles when the user stops touching the screen and scrolling, or null if they aren't.
    free() {
      return fingers.size || scrolling ? new Promise(ok => idle.push(ok)) : null;
    },
    // A row was marked. Everything waiting leaves `ms` from now, or from when the user stops touching the screen.
    mark() {
      waiting = true;
      arm();
    },
    // A touch holds everything. When it ends, the wait starts over. `id` is the pointer's id, because two touches can
    // be down at once.
    down(id) {
      fingers.add(id);
      arm();
    },
    up(id) {
      if (fingers.delete(id)) arm();
    },
    // Scrolling holds everything until it stops.
    scroll(on) {
      if (scrolling === on) return;
      scrolling = on;
      arm();
    },
    // The caller already cleared the rows, because the user left the screen or put Pocket away. Nothing is waiting.
    now() {
      clearTimeout(timer);
      timer = null;
      fingers.clear();
      waiting = pended = false;
      idle.splice(0).forEach(ok => ok());
    },
    // Every mark was undone. Only a regroup still waiting keeps the wait going.
    stop() {
      waiting = pended;
      arm();
    },
  };
}
