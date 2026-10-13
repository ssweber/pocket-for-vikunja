/* A task's progress and the gestures that set it: the swipe through the quarters, the hold that picks a row up, the
   short slow scroll (a nudge) that aims the add box, and a parent's progress worked out from its subtasks. Only rules
   and arithmetic here, so the unit tests cover them. app/progress.js handles the touches. */
import {repeats} from './dates.js';

/* Vikunja keeps progress in percent_done, 0 to 1. Marking a task done leaves percent_done as it was, so unticking
   brings the task back to where it had got to. A repeating task starts its next date at 0%. */
export const pctOf = t => Math.round((t?.percent_done || 0) * 100);
/* The open subtasks to mark done along with their parent, after asking (app/cards.js). None for a repeating parent,
   and none that repeat themselves: marking a repeating task done only moves it to its next date. */
export const openSubtasks = t => repeats(t) ? [] : (t.related_tasks?.subtask || []).filter(s => !s.done && !repeats(s));
// Whether a patch is an Undo putting progress back, which shows no message of its own.
export const undoing = extra => 'percent_done' in extra && !extra.done;
export const progressPatch = (t, pct) => pct >= 100 ? {done: true, ...repeats(t) && {percent_done: 0}} : {percent_done: pct / 100};
export const HOLD_MS = 450;                             // hold a row this long (ms) to pick it up and reorder it

/* ---------- swipe stops ---------- */
// A swipe stops at the quarters. Few enough that each stop is felt as a tick on the way.
export const SNAPS = [0, 25, 50, 75, 100];
export const EDGE = 48;                                 // the last stop sits this many px short of the screen's edge
export const LOCK_PX = 10;                              // after a hold, the first move this long decides the direction
/* The Progress line on a task's sheet offers the quarters below 100% (done is the tick). `quarterOn` is the one the
   task sits on, pressed, or null when its progress is between quarters or it is done. */
export const QUARTERS = SNAPS.slice(0, -1);
export const quarterOn = t => !t?.done && QUARTERS.includes(pctOf(t)) ? pctOf(t) : null;
/* How far a finger can still travel towards the screen's edge, `edge` px away, on a row `width` wide. Stops EDGE
   short of the edge, clear of the phone's own edge gestures, and never asks for more than the finger has, so the last
   stop is always within reach. */
const roomTo = (edge, width) => Math.max(edge - EDGE, Math.min(width * .25, edge * .75), 1);
// The direction a held finger moved: 'x' or 'y' once it is LOCK_PX away, null until then. Only 'y' reorders the row.
export const lockDirection = (dx, dy) => Math.hypot(dx, dy) < LOCK_PX ? null : Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';

export const SWIPE_PX = 8;                              // a finger that moves this far before the hold is scrolling or swiping
export const SWIPE_SLOPE = 1.2;                         // a swipe is this many times more sideways than vertical (within about 40 degrees)
export const EDGE_GUARD = 24;                           // a swipe starting this close to the screen's edge is the phone's Back gesture
/* Whether a finger moved (dx, dy) from x0 before the hold is swiping the row. The move must be clearly sideways, so a
   slow scroll that wanders a little stays a scroll, and must not start at the screen's edges, where the phone's own
   Back and Forward gestures begin. A row already open on its Delete (`open`) swipes from anywhere. */
export const swipeStarts = (dx, dy, x0, screen, open = false) => Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy) * SWIPE_SLOPE
  && (open || (x0 > EDGE_GUARD && x0 < screen - EDGE_GUARD));
/* A touch that starts in a text field belongs to the field, for its caret, selection and scrolling. It never starts a
   swipe, a hold, a nudge or the sheet's slide down. `target` is the element the finger went down on. */
export const TEXT_FIELD = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
export const inTextField = target => !!target?.closest?.(TEXT_FIELD);
/* Whether `el` is a field the phone's keyboard is up for while it has focus: a textarea, anything contenteditable,
   or an input that takes text. Not a select, date, file or tick box. Those keep focus after their own picker closes,
   with no keyboard to put away. */
const NOT_TYPED = /^(button|checkbox|color|date|datetime-local|file|hidden|image|month|radio|range|reset|submit|time|week)$/;
export const typedIn = el => !!el && (el.tagName === 'TEXTAREA' || !!el.isContentEditable || (el.tagName === 'INPUT' && !NOT_TYPED.test(el.type || 'text')));
/* Whether a touch may slide the sheet down to close it. Never from a text field. Always from the sheet's bar. From
   anywhere else only when the sheet is scrolled to its top and no field is being typed in: pulling down beside a field
   puts the keyboard away, and must not close the sheet too. */
export const slideStarts = ({field, bar, top, typing}) => !field && (bar || (top && !typing));

/* ---------- swiping a row ----------
   A row swiped either way works the same: its content moves with the finger, the space uncovered shows what letting
   go there does, and nothing changes until the finger lifts. Each side has one job, chosen by the direction and by the
   row's state when the swipe starts:
   - `up` (swiped right): progress up through the quarters above where it is, a tick at each, spread evenly up to the
     full point. Past the full point, done: the row carries on off the screen and is shown done in its place.
   - `down` (swiped left on a row with progress, or a done row being reopened): progress down the same way, stopping
     at 0% at the full point with a firmer tick, however far it is pulled. No Delete on the same swipe.
   - `delete` (swiped left on a row at 0%, or one whose progress can't be swiped): its Delete button, `open` px wide,
     stays open if let go past a third of it. Past the full point, deleted, with Restore in the gap.
   Let go on a stop, that progress is set and the row springs back. Each side's stops are at most `gap` px apart and
   end at the full point, `full` of the row's width, or sooner when the finger started too near the screen's edge to
   get that far (roomTo). styles.css ("Swiped") draws what is uncovered. To tune a side, change its numbers here. */
export const SIDES = {
  up: {gap: Infinity, full: .5},                        // 25, 50, 75 over the first half of the row, done past it
  down: {gap: Infinity, full: .5},                      // 75, 50, 25, 0 the same way, then it stops
  delete: {full: .5, open: 88},                         // open on its 88px button, deleted past half the row
};
export const DELETE_W = SIDES.delete.open;              // px wide: the Delete button a row rests open on
// How far the row's content moves aside for `dx`: with the finger, to the left only, never past the row's width.
export const swipeOffset = (dx, width) => Math.max(-width, Math.min(0, dx));
/* What letting go at `offset` in the Delete does. Past the full point, delete straight away, as a full swipe does in a
   phone's mail app. Past a third of the Delete button, stay open on it. Else shut. */
export const swipeEnd = (offset, width) => offset < -width * SIDES.delete.full ? 'delete' : offset < -SIDES.delete.open / 3 ? 'open' : 'shut';
/* Where a swipe stands and what letting go would do. `start` is the row's progress when the swipe began (100 for a
   done row, null for a row whose progress can't be swiped or one open on its Delete). The finger went down at `x` and
   has moved `dx`; `base` is where the content rested (-DELETE_W for an open row). `del`: the row has a Delete. `one`:
   a parent's header, whose right side has only its full point, which opens the question about its open subtasks.
   `side` is the side the swipe started on ('right' or 'left', by its first sideways move), and the swipe stays there:
   dragged back past the start it stops at the start and never becomes the other side's job. Returns `off` (where the
   content is), `pct` (the progress letting go would set) and `to`: 'stop' (set it and spring back), 'done' or
   'delete' (the full action), 'open' or 'shut' (in the Delete). */
export function swipeAt({start = null, dx, x, width, screen, del = false, base = 0, one = false, side = null}){
  const raw = base + dx, d = side === 'right' ? Math.max(0, raw) : side === 'left' ? Math.min(0, raw) : raw;
  if (d === 0 && (side === 'right' || start > 0)) return {off: 0, pct: start, to: 'stop'};   // back where it started
  if (d > 0 || (start > 0 && d < 0)) {
    const up = d > 0, side = up ? SIDES.up : SIDES.down;
    const stops = start === null ? [] : up ? (one ? [100] : SNAPS.filter(p => p > start)) : SNAPS.filter(p => p < start).reverse();
    if (!stops.length) return start === null ? {off: 0, pct: null, to: 'shut'} : {off: 0, pct: start, to: 'stop'};   // nothing that way
    const n = stops.length, gap = Math.min(side.gap, side.full * width / n, roomTo(up ? screen - x : x, width) / n);
    const dist = Math.min(Math.abs(d), width), i = Math.min(Math.floor(dist / gap), n), pct = i ? stops[i - 1] : start;
    if (up) return {off: dist, pct, to: i >= n ? 'done' : 'stop'};
    return {off: -Math.min(dist, n * gap), pct, to: 'stop'};                  // at 0%, it goes no further
  }
  if (!del) return {off: 0, pct: start, to: 'stop'};
  const off = swipeOffset(d, width);
  return {off, pct: start === null ? null : 0, to: swipeEnd(off, width)};
}
/* The vibration as a swipe goes from `was` to `now` (both from swipeAt): a light tick at each stop passed and at the
   Delete button, a firmer one ('done') at a full point and at 0%, where lowering stops. */
export const swipeFeel = (was, now) => now.to === 'done' || now.to === 'delete' ? (was.to !== now.to ? 'done' : null)
  : now.to === 'open' ? (was.to !== 'open' ? 'tick' : null)
  : now.to === 'stop' && now.pct !== was.pct ? (now.pct === 0 && was.pct > 0 ? 'done' : 'tick') : null;
/* The vibration when a tick is tapped, by whether the task was `done` before. Marking done gives the firmer one, the
   same as a full swipe, so done feels the same either way. Reopening gives a light tick. */
export const tickFeel = done => done ? 'tick' : 'done';
// Whether a swipe in direction `dx` can change progress from `start`: not up from 100%, not down from 0%.
export const trackMoves = (start, dx) => dx > 0 ? start < 100 : start > 0;
// A subtask is a task with a parent. Its tick and progress show on its row only, with no message.
export const isSubtask = t => !!t?.related_tasks?.parenttask?.length;

/* ---------- claims ---------- */
// Whether sliding progress on a row also claims it. Only when nobody has it yet and the slot can be tapped (not done,
// not read-only). Someone else's claim is never replaced.
export const claimsOnSlide = slot => !!slot?.can && !slot.users?.length;

/* ---------- a parent's progress ---------- */
/* A task with subtasks has no progress of its own. Its progress is the rounded average of its subtasks', a done
   subtask (a skipped step is one) counting 100%: one subtask at 50% of four gives 13%. `subs` is [{done, pct}].
   Returns {pct, done, total}, or null with no subtasks: a parent whose subtasks are all removed keeps the figure it
   had. */
export function workedOut(subs){
  if (!subs.length) return null;
  const sum = subs.reduce((n, s) => n + (s.done ? 100 : Math.max(0, Math.min(100, s.pct || 0))), 0);
  return {pct: Math.round(sum / subs.length), done: subs.filter(s => s.done).length, total: subs.length};
}
// A parent's progress from Vikunja's copy of it, which lists each subtask's done and percent_done.
export const figureOf = t => workedOut((t?.related_tasks?.subtask || []).map(s => ({done: !!s.done, pct: pctOf(s)})));
/* The patch that writes a parent's worked-out progress to its percent_done, or null when nothing changed or the task
   has no subtasks. */
export const figurePatch = now => { const w = figureOf(now); return w && w.pct !== pctOf(now) ? {percent_done: w.pct / 100} : null; };

/* ---------- a nudge ---------- */
/* On a project's list, a touch that starts on a row and becomes a short, slow scroll aims the add box at that row, as
   opening its sheet does. A longer or faster scroll, a fling, only scrolls. Tune it here. */
export const NUDGE_MIN_PX = 10;                         // less than this is a tap or a hold
export const NUDGE_MAX_PX = 56;                         // more than about a row's height is a scroll
export const NUDGE_MAX_SPEED = 0.5;                     // px/ms as the finger lifts. Faster, and the page keeps scrolling
export const NUDGE_SPEED_MS = 100;                      // how far back that speed is measured
export const NUDGE_TICK = true;                         // vibrate lightly when a nudge moves the target
/* The finger's speed in px/ms as it lifted at (t, y). `moves` is [{t, y}] since it went down. Measured from the first
   move within the last NUDGE_SPEED_MS, or from the one before it when that move is the last, since a phone may send
   few moves. With no move that recent, from the last move. */
export function releaseSpeed(moves, t, y){
  let i = moves.findIndex(m => t - m.t <= NUDGE_SPEED_MS);
  if (i < 0) i = moves.length - 1; else if (i && i === moves.length - 1) i--;
  const ref = moves[i];
  return ref ? Math.abs(y - ref.y) / Math.max(t - ref.t, 1) : 0;
}
/* Whether a touch was a nudge. `dy` is its furthest vertical move, `dx` sideways, over `ms`, lifting at `speed`
   (default: its average). Mostly vertical, further than a tap, within about a row, and slow. */
export const isNudge = ({dx = 0, dy, ms, speed = Math.abs(dy) / Math.max(ms, 1)}) => Math.abs(dy) >= NUDGE_MIN_PX
  && Math.abs(dy) > Math.abs(dx) && Math.abs(dy) <= NUDGE_MAX_PX && speed <= NUDGE_MAX_SPEED;
