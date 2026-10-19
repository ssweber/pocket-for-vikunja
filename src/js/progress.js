/* A task's progress and the gestures that set it: the swipe through the quarters, the hold that picks a row up, the
   short slow scroll (a nudge) that moves the add box, and a parent's progress calculated from its subtasks. This file
   holds only rules and arithmetic, so the unit tests cover them. app/progress.js handles the touches. */
import { repeats } from './dates.js';

/* Vikunja keeps progress in percent_done, 0 to 1. Marking a task done leaves percent_done as it was, so unticking
   a task restores its earlier progress. A repeating task starts its next date at 0%. */
export const pctOf = t => Math.round((t?.percent_done || 0) * 100);
/* The open subtasks to mark done along with their parent, after asking (app/cards.js). A repeating parent has none,
   and a repeating subtask is left out, because marking a repeating task done only moves it to its next date. `row`
   gives each subtask as its own row shows it (subRow, app/tasks.js). */
export const openSubtasks = (t, row = s => s) =>
  repeats(t) ? [] : (t.related_tasks?.subtask || []).map(row).filter(s => !s.done && !repeats(s));
export const HOLD_MS = 450; // holding a row this long (ms) lifts it so it can be reordered

/* ---------- swipe stops ---------- */
// A swipe stops at the quarters. There are few enough stops that the phone can vibrate at each one.
export const SNAPS = [0, 25, 50, 75, 100];
export const EDGE = 48; // the last stop is this many px short of the screen's edge
export const LOCK_PX = 10; // after a hold, the first move this long (px) decides the direction
/* The Progress row on a task's sheet offers the quarters below 100% (the tick marks done). `quarterOn` is the quarter
   the task is on, shown pressed. It is null when the task's progress is between quarters or the task is done. */
export const QUARTERS = SNAPS.slice(0, -1);
export const quarterOn = t => (!t?.done && QUARTERS.includes(pctOf(t)) ? pctOf(t) : null);
/* How far the touch can still travel towards the screen's edge, `edge` px away, on a row `width` wide. The last stop
   is EDGE px short of the edge, clear of the phone's own edge gestures. It also never asks for more distance than
   the touch has left, so the last stop is always within reach. */
const roomTo = (edge, width) => Math.max(edge - EDGE, Math.min(width * 0.25, edge * 0.75), 1);
// The direction the touch moved after a hold: 'x' or 'y' once it is LOCK_PX away, null until then. Only 'y' reorders.
export const lockDirection = (dx, dy) =>
  Math.hypot(dx, dy) < LOCK_PX ? null : Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';

export const SWIPE_PX = 8; // a touch that moves this far (px) before the hold ends is a scroll or a swipe
export const SWIPE_SLOPE = 1.2; // a swipe is this many times more sideways than vertical (within about 40 degrees)
export const EDGE_GUARD = 24; // a swipe starting this close (px) to the screen's edge is the phone's Back gesture
/* Whether a touch that moved (dx, dy) from x0 before the hold ends is swiping the row. The move must be clearly
   sideways, so a slow scroll that wanders a little stays a scroll. It must also not start at the screen's edges,
   where the phone's own Back and Forward gestures begin. A row already open on its Delete (`open`) can be swiped from
   anywhere. */
export const swipeStarts = (dx, dy, x0, screen, open = false) =>
  Math.abs(dx) >= SWIPE_PX &&
  Math.abs(dx) > Math.abs(dy) * SWIPE_SLOPE &&
  (open || (x0 > EDGE_GUARD && x0 < screen - EDGE_GUARD));
/* A touch that starts in a text field belongs to the field, for its caret, selection and scrolling. It never starts a
   swipe, a hold, a nudge or the sheet's slide down. `target` is the element the touch started on. */
export const TEXT_FIELD = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
export const inTextField = target => !!target?.closest?.(TEXT_FIELD);
/* Whether `el` is a field that opens the phone's keyboard while it has focus: a textarea, anything contenteditable,
   or an input that takes text. A select, date, file or tick box is not. Those keep focus after their own picker
   closes, when there is no keyboard to close. */
const NOT_TYPED =
  /^(button|checkbox|color|date|datetime-local|file|hidden|image|month|radio|range|reset|submit|time|week)$/;
export const typedIn = el =>
  !!el &&
  (el.tagName === 'TEXTAREA' ||
    !!el.isContentEditable ||
    (el.tagName === 'INPUT' && !NOT_TYPED.test(el.type || 'text')));
/* Whether a touch may slide the sheet down to close it. Never from a text field. Always from the sheet's bar. From
   anywhere else only when the sheet is scrolled to its top and the user is not typing in a field. Pulling down beside
   a field closes the keyboard, and must not close the sheet too. */
export const slideStarts = ({ field, bar, top, typing }) => !field && (bar || (top && !typing));

/* ---------- swiping a row ----------
   The row's content moves with the touch, and the layer it uncovers shows what releasing there will do. Nothing
   changes until the user releases. The direction of the swipe and the row's state when the swipe starts decide which
   of three sides it is:
   - `up` (swiped right) raises progress through the quarters above the current one. The phone vibrates at each stop,
     and the stops are spread evenly up to the full point. Past the full point the task is done, and the row slides
     off the screen and shows as done in its place.
   - `down` (swiped left on a row with progress, or on a done row being reopened) lowers progress through the quarters
     in the same way. It stops at 0% at the full point, with a firmer vibration, however far the touch moves. The same
     swipe never shows Delete.
   - `delete` (swiped left on a row at 0%, or on a row whose progress can't be swiped) shows its Delete button, `open`
     px wide. Releasing past a third of the button leaves the row open on it. Past the full point the task is
     deleted, and Restore appears in the gap.
   Releasing on a stop sets that progress, and the row springs back. Each side's stops are at most `gap` px apart. They
   end at the full point, which is `full` of the row's width, or sooner when the touch started too near the screen's
   edge to get that far (roomTo). styles.css ("Swiped") draws the uncovered layer. To tune a side, change its numbers
   here. */
export const SIDES = {
  up: { gap: Infinity, full: 0.5 }, // 25, 50, 75 over the first half of the row, done past it
  down: { gap: Infinity, full: 0.5 }, // 75, 50, 25, 0 the same way, then it stops
  delete: { full: 0.5, open: 88 }, // open on its 88px button, deleted past half the row
};
export const DELETE_W = SIDES.delete.open; // px wide: the Delete button a row rests open on
// How far the row's content moves aside for `dx`. It follows the touch to the left only, never past the row's width.
export const swipeOffset = (dx, width) => Math.max(-width, Math.min(0, dx));
/* What releasing at `offset` does on the Delete side. Past the full point it deletes at once, as a full swipe does in
   a phone's mail app. Past a third of the Delete button the row stays open on it. Otherwise the row closes. */
export const swipeEnd = (offset, width) =>
  offset < -width * SIDES.delete.full ? 'delete' : offset < -SIDES.delete.open / 3 ? 'open' : 'shut';
/* Where a swipe stands and what releasing would do. `start` is the row's progress when the swipe began (100 for a
   done row, null for a row whose progress can't be swiped or one open on its Delete). The touch started at `x` and
   has moved `dx`. `base` is where the content rested (-DELETE_W for an open row). `del` is true when the row has a
   Delete. `one` is true for a parent's header, whose right side has only its full point, which opens the question
   about its open subtasks.
   `side` is the side the swipe started on ('right' or 'left', set by its first sideways move). The swipe stays on that
   side. If the touch is dragged back past the start, the content stops at the start and the swipe never becomes the
   other side's action. Returns `off` (where the content is), `pct` (the progress that releasing would set) and `to`:
   'stop' (set the progress and spring back), 'done' or 'delete' (the full action), 'open' or 'shut' (on the Delete
   side). */
export function swipeAt({ start = null, dx, x, width, screen, del = false, base = 0, one = false, side = null }) {
  const raw = base + dx,
    d = side === 'right' ? Math.max(0, raw) : side === 'left' ? Math.min(0, raw) : raw;
  if (d === 0 && (side === 'right' || start > 0)) return { off: 0, pct: start, to: 'stop' }; // back where it started
  if (d > 0 || (start > 0 && d < 0)) {
    const up = d > 0,
      side = up ? SIDES.up : SIDES.down;
    const stops =
      start === null ? [] : up ? (one ? [100] : SNAPS.filter(p => p > start)) : SNAPS.filter(p => p < start).reverse();
    if (!stops.length) return start === null ? { off: 0, pct: null, to: 'shut' } : { off: 0, pct: start, to: 'stop' }; // nothing that way
    const n = stops.length,
      gap = Math.min(side.gap, (side.full * width) / n, roomTo(up ? screen - x : x, width) / n);
    const dist = Math.min(Math.abs(d), width),
      i = Math.min(Math.floor(dist / gap), n),
      pct = i ? stops[i - 1] : start;
    if (up) return { off: dist, pct, to: i >= n ? 'done' : 'stop' };
    return { off: -Math.min(dist, n * gap), pct, to: 'stop' }; // at 0%, it goes no further
  }
  if (!del) return { off: 0, pct: start, to: 'stop' };
  const off = swipeOffset(d, width);
  return { off, pct: start === null ? null : 0, to: swipeEnd(off, width) };
}
/* The vibration as a swipe goes from `was` to `now` (both from swipeAt). A light one ('tick') at each stop passed and
   at the Delete button, and a firmer one ('done') at a full point and at 0%, where lowering stops. */
export const swipeFeel = (was, now) =>
  now.to === 'done' || now.to === 'delete'
    ? was.to !== now.to
      ? 'done'
      : null
    : now.to === 'open'
      ? was.to !== 'open'
        ? 'tick'
        : null
      : now.to === 'stop' && now.pct !== was.pct
        ? now.pct === 0 && was.pct > 0
          ? 'done'
          : 'tick'
        : null;
/* The vibration when a tick is tapped, chosen by whether the task was `done` before. Marking done gives the firmer
   one, the same as a full swipe, so both ways of marking done vibrate alike. Reopening gives the light one. */
export const tickFeel = done => (done ? 'tick' : 'done');
// Whether a swipe in direction `dx` can change progress from `start`: not up from 100%, not down from 0%.
export const trackMoves = (start, dx) => (dx > 0 ? start < 100 : start > 0);
// A subtask is a task with a parent. Changing its tick or progress shows on its row only, with no message.
export const isSubtask = t => !!t?.related_tasks?.parenttask?.length;

/* ---------- claims ---------- */
// Whether swiping progress on a row also claims it. It does only when nobody has the task yet and the slot can be
// tapped (the task is not done or read only). Someone else's claim is never replaced.
export const claimsOnSlide = slot => !!slot?.can && !slot.users?.length;

/* ---------- a parent's progress ---------- */
/* A task with subtasks has no progress of its own. Its progress is the rounded average of its subtasks' progress,
   and a done subtask (a skipped step is one) counts as 100%. One subtask at 50% out of four gives 13%. `subs` is
   [{done, pct}]. Returns {pct, done, total}, or null with no subtasks. A parent whose subtasks are all removed keeps
   the percentage it had. */
export function workedOut(subs) {
  if (!subs.length) return null;
  const sum = subs.reduce((n, s) => n + (s.done ? 100 : Math.max(0, Math.min(100, s.pct || 0))), 0);
  return { pct: Math.round(sum / subs.length), done: subs.filter(s => s.done).length, total: subs.length };
}
// A parent's progress from Vikunja's copy of it, which lists each subtask's done and percent_done.
export const figureOf = t => workedOut((t?.related_tasks?.subtask || []).map(s => ({ done: !!s.done, pct: pctOf(s) })));
/* The patch that writes a parent's calculated progress to its percent_done. It is null when nothing changed or the
   task has no subtasks. */
export const figurePatch = now => {
  const w = figureOf(now);
  return w && w.pct !== pctOf(now) ? { percent_done: w.pct / 100 } : null;
};

/* ---------- a nudge ---------- */
/* On a project's list, a touch that starts on a row and becomes a short, slow scroll moves the add box under that row,
   as opening the row's sheet does. A longer or faster scroll (a flick) only scrolls. Tune it here. */
export const NUDGE_MIN_PX = 10; // less than this is a tap or a hold
export const NUDGE_MAX_PX = 56; // more than about a row's height is a scroll
export const NUDGE_MAX_SPEED = 0.5; // px/ms at release. Faster, and the page keeps scrolling
export const NUDGE_SPEED_MS = 100; // how far back (ms) that speed is measured
export const NUDGE_TICK = true; // vibrate lightly when a nudge moves the target
/* The touch's speed in px/ms when it was released at (t, y). `moves` is [{t, y}] since the touch started. The speed
   is measured from the first move within the last NUDGE_SPEED_MS. If that move is the last one, it is measured from
   the move before it, because a phone may send few moves. If no move is that recent, it is measured from the last
   move. */
export function releaseSpeed(moves, t, y) {
  let i = moves.findIndex(m => t - m.t <= NUDGE_SPEED_MS);
  if (i < 0) i = moves.length - 1;
  else if (i && i === moves.length - 1) i--;
  const ref = moves[i];
  return ref ? Math.abs(y - ref.y) / Math.max(t - ref.t, 1) : 0;
}
/* Whether a touch was a nudge: mostly vertical, further than a tap, within about a row's height, and slow. `dy` is
   its furthest vertical move and `dx` its sideways move, over `ms`. `speed` is the speed at release (default: the
   average speed). */
export const isNudge = ({ dx = 0, dy, ms, speed = Math.abs(dy) / Math.max(ms, 1) }) =>
  Math.abs(dy) >= NUDGE_MIN_PX &&
  Math.abs(dy) > Math.abs(dx) &&
  Math.abs(dy) <= NUDGE_MAX_PX &&
  speed <= NUDGE_MAX_SPEED;
