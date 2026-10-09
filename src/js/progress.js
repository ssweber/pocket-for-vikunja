// A task's progress, and marking it done.
import {repeats} from './dates.js';

/* Vikunja keeps a task's progress in percent_done, from 0 to 1. Pocket sets it in steps of 10%, and 100% marks the
   task done, its progress left as it was: marked not done again, it's back where it had got to (a step of a run too).
   A repeating task starts its next time at 0%. Done, it shows as 100% (shownPct). */
export const pctOf = t => Math.round((t?.percent_done || 0) * 100);
/* A task's subtasks still open, to mark done with it. Not for a repeating task, which only moves to its next date, and
   not a subtask that repeats: marked done, it would only move to its next date too. */
export const openSubtasks = t => repeats(t) ? [] : (t.related_tasks?.subtask || []).filter(s => !s.done && !repeats(s));
// An Undo putting back what was there: no message of its own.
export const undoing = extra => 'percent_done' in extra && !extra.done;
export const progressPatch = (t, pct) => pct >= 100 ? {done: true, ...repeats(t) && {percent_done: 0}} : {percent_done: pct / 100};
export const HOLD_MS = 450;                             // hold this long to pick a row up, to move it up or down

/* ---------- progress in snaps ---------- */
// Progress set by a swipe stops at these, the quarters: few enough that each is felt, as a tick, on the way.
export const SNAPS = [0, 25, 50, 75, 100];
export const EDGE = 48;                                 // px short of the screen's edge where 100% (or 0%) is reached
export const LOCK_PX = 10;                              // after a hold, this far decides the way: up and down moves it
export const QUARTER_PX = 48;                           // the sheet's bar swiped left: a quarter less progress each this far
/* Where a slide puts progress: the snap nearest the finger, or where it started, so progress set elsewhere (40%, say)
   stays as it is until it's slid, then moves to the nearest snap. */
export const snapPct = (start, raw) => [start, ...SNAPS].reduce((best, p) => Math.abs(p - raw) < Math.abs(best - raw) ? p : best);
// The next snap up (dir 1) or down (-1) from pct: the arrow keys on the sheet's bar.
export const nextSnap = (pct, dir) => dir > 0 ? SNAPS.find(p => p > pct) ?? 100 : SNAPS.findLast(p => p < pct) ?? 0;
/* The progress under the finger, put down at x on a row `width` wide, on a screen `screen` wide, and moved dx since. It
   moves from where it was, like a volume bar: the room the finger has is the rest of the way, so from 60% held on the
   right of a row, 100% is still within reach. It ends EDGE short of the screen's edge, clear of the phone's own edge
   gestures and easy for a thumb; past it stays at 100% (or 0%). At least a quarter of the row's width, so a little room
   isn't jumpy, but never more than the finger has before the edge: held near it, 100% (or 0%) is still reached, closer
   to the edge. */
export function slidePct({start, dx, x, width, screen}){
  const room = roomTo(dx > 0 ? screen - x : x, width);
  return snapPct(start, Math.max(0, Math.min(100, start + dx / room * (dx > 0 ? 100 - start : start))));
}
// The room a finger has, `edge` from the screen's edge it's going towards, on a row `width` wide (slidePct).
const roomTo = (edge, width) => Math.max(edge - EDGE, Math.min(width * .25, edge * .75), 1);
// Which way a finger went after a hold: once it's LOCK_PX away, 'x' (nothing: a hold only moves a row) or 'y'
// (moving it); null until then.
export const lockDirection = (dx, dy) => Math.hypot(dx, dy) < LOCK_PX ? null : Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';

export const SWIPE_PX = 8;                              // moved this far before the hold, a finger is scrolling or swiping
export const SWIPE_SLOPE = 1.2;                         // a swipe is this much more sideways than up or down (within ~40°)
export const EDGE_GUARD = 24;                           // a swipe starting this close to the screen's edge is the phone's (Back)
/* Whether a finger that has moved (dx, dy) from x0, before the hold, is swiping the row, either way: clearly sideways,
   so a slow scroll that wanders a little (a nudge) stays a scroll, and not from the screen's edges, where the phone's
   own Back and forward gestures start; on a row already open on its Delete, from anywhere, to carry on or to close it.
   Which way it can go is the row's (holdToSlide, app/progress.js). */
export const swipeStarts = (dx, dy, x0, screen, open = false) => Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy) * SWIPE_SLOPE
  && (open || (x0 > EDGE_GUARD && x0 < screen - EDGE_GUARD));

/* ---------- swiping a row: one mechanism, mirrored sides (parent-tasks-plan, 1b) ----------
   A row swiped either way works the same: its content moves with the finger, the space it uncovers shows what letting
   go there does, and nothing changes until it's let go. Each side has one job, chosen by which way the finger goes and
   by the row as the swipe starts:
   - `up` (right): its progress up, through the quarters above where it is, a tick felt at each, spread evenly over
     the way to its full point; past it, done (the full action: the row carries on off the screen and leaves a gap with
     Undo, sweep in app/progress.js).
   - `down` (left, a row with progress, or a done one, opened again): its progress down the same way, stopping at 0%
     at its full point with a firmer tick, however far it's pulled: no Delete on the same swipe.
   - `delete` (left, a row at 0%, or one whose progress isn't swiped): its Delete, open on its button, `open` px wide,
     if let go past a third of it; past its full point, deleted (the gap with Restore).
   Let go on a stop, that progress is set and the row springs back, its tick showing it.
   Each side's stops are at most `gap` px apart and end at its full point, `full` of the row's width (or sooner, put
   down too near the screen's edge to get that far: slidePct's room, so the last is always within reach).
   What's uncovered (styles.css, "Swiped"): up, green, with a large ring, the tick's shape, filling a quarter at a
   time, then solid with its ✓ past the full point; down, the ring on green, emptying; delete, the red Delete.
   To tune a side, change its numbers here: */
export const SIDES = {
  up: {gap: Infinity, full: .5},                        // 25, 50, 75 spread over the first half of the row; done past it
  down: {gap: Infinity, full: .5},                      // 75, 50, 25, 0 the same way, then it stops
  delete: {full: .5, open: 88},                         // open on its 88px button; deleted past half the row
};
export const DELETE_W = SIDES.delete.open;              // px: the Delete button a row slides aside for, and rests open on
// How far a row `width` wide is moved aside, `dx` from where it rests: with the finger, to the left only.
export const swipeOffset = (dx, width) => Math.max(-width, Math.min(0, dx));
/* Let go at `offset`, in its Delete: past its full point, deleted straight away (a full swipe, as on a phone's mail);
   past a third of the Delete button, it stays open on it; else it goes back. */
export const swipeEnd = (offset, width) => offset < -width * SIDES.delete.full ? 'delete' : offset < -SIDES.delete.open / 3 ? 'open' : 'shut';
/* A row swiped from its progress `start` (a done one from 100; null for a row whose progress isn't swiped, or one open
   on its Delete), put down at x and moved dx from where it rests (`base`: an open row's -DELETE_W), on a row `width`
   wide and a screen `screen` wide; `del`, whether it has a Delete. Returns where its content is (`off`), the progress
   letting go would set (`pct`), and what letting go does (`to`): 'stop' (set it, spring back), 'done' or 'delete' (the
   full action), 'open' or 'shut' (in its Delete: stay open on its button, or go back). */
export function swipeAt({start = null, dx, x, width, screen, del = false, base = 0}){
  const d = base + dx;
  if (d > 0 || (start > 0 && d < 0)) {
    const up = d > 0, side = up ? SIDES.up : SIDES.down;
    const stops = start === null ? [] : up ? SNAPS.filter(p => p > start) : SNAPS.filter(p => p < start).reverse();
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
/* What's felt as a swipe goes from `was` to `now` (swipeAt's): a tick at each stop passed, and at its Delete's button;
   a firmer one at a full point, and at 0%, where lowering stops. */
export const swipeFeel = (was, now) => now.to === 'done' || now.to === 'delete' ? (was.to !== now.to ? 'done' : null)
  : now.to === 'open' ? (was.to !== 'open' ? 'tick' : null)
  : now.to === 'stop' && now.pct !== was.pct ? (now.pct === 0 && was.pct > 0 ? 'done' : 'tick') : null;
/* The sheet's bar swiped from its progress `start` (a done task from 100), put down at x and moved dx: it shows as it
   goes, being the bar itself. To the right, up (slidePct: the room is the rest of the way to the screen's edge, so
   100% is always within reach), done staying done; to the left, down a quarter each QUARTER_PX (closer together put
   down near the left edge, so 0% is still reached). */
export function trackAt({start, dx, x, width, screen}){
  if (dx >= 0) return start >= 100 ? 100 : slidePct({start, dx, x, width, screen});
  const reach = start > 0 ? Math.min(start / 25 * QUARTER_PX, roomTo(x, width)) : 0;
  return -dx < reach ? snapPct(start, start + dx / reach * start) : 0;
}
// Whether a swipe that way (dx) changes a row's progress, from `start`: not up from done, nor down from 0%.
export const trackMoves = (start, dx) => dx > 0 ? start < 100 : start > 0;
// A subtask: a task with a parent. Its tick and progress show on its row only, with no message.
export const isSubtask = t => !!t?.related_tasks?.parenttask?.length;

/* ---------- who's doing it, and a run's line ---------- */
// Whether sliding progress on a row says you're doing it: only where no one is yet and its slot can be tapped (not done,
// not shared with you to read). Someone else's is never replaced, and yours is already yours (claimSlot, app/claims.js).
export const claimsOnSlide = slot => !!slot?.can && !slot.users?.length;
/* A run's progress line is in segments, one per step; past MANY_STEPS they'd be too short to read, so it's one line with
   a small tick at each step instead. `segs` is at least 1, for the CSS to divide by. Given which steps are done
   (`which`, in the line's order), each segment, or past MANY_STEPS each step's stretch between two ticks, is filled by
   whether its own step is done (`fill`, the line's background), so a filled one is always a done step; a number from 0
   to 1 instead fills that much of it from the left (a card's step showing, by its progress). With no steps, no fill:
   the line is its track. */
export const MANY_STEPS = 12;
export const runLine = which => ({segs: Math.max(which.length, 1), many: which.length > MANY_STEPS, fill: which.length ? segFill(which) : null});
/* The line's background, each step's stretch filled or not: a stop at k / n of the way, which always falls in the gap
   before segment k (the CSS cuts each segment (100% + 3px) / n wide, less a 3px gap), or past MANY_STEPS on the tick
   between two stretches; a step part done, a stop that far into its stretch. Stretches alike side by side are one. */
const segFill = which => {
  const n = which.length, at = x => +(x / n * 100).toFixed(3) + '%', parts = [];
  const add = (on, a, b) => { const last = parts.at(-1); if (last && last[0] === on && last[2] === a) last[2] = b; else parts.push([on, a, b]); };
  which.forEach((v, k) => {
    const f = Math.max(0, Math.min(1, v === true ? 1 : +v || 0));
    if (f > 0) add(true, k, k + f);
    if (f < 1) add(false, k + f, k + 1);
  });
  return `linear-gradient(to right,${parts.map(([on, a, b]) => `var(${on ? '--accent' : '--track'}) ${at(a)} ${at(b)}`).join(',')})`;
};

/* ---------- a nudge: a short, slow scroll that aims the add box (an experiment) ---------- */
/* On a project's list, a touch that starts on a row and turns into a short, slow scroll makes that row the add box's
   target, as opening its sheet does (app/progress.js, `nudged` in app/quickadd.js); a longer or faster one, a fling,
   is only a scroll. Tune it here: */
export const NUDGE_MIN_PX = 10;                         // moved less than this, it was a tap, or a hold
export const NUDGE_MAX_PX = 56;                         // moved further than about a row's height, it was a scroll
export const NUDGE_MAX_SPEED = 0.5;                     // px/ms as the finger lifts: faster, the page flies on
export const NUDGE_SPEED_MS = 100;                      // how far back that speed is measured
export const NUDGE_TICK = true;                         // a light tick felt when a nudge moves the target
/* How fast the finger was going as it lifted at (t, y), in px/ms: from its first move in the last NUDGE_SPEED_MS,
   `moves` being [{t, y}] from where it went down, or the one before when that's its last (a phone may send few, the
   last where it lifts); with none that recent, from its last (held still, that's 0). */
export function releaseSpeed(moves, t, y){
  let i = moves.findIndex(m => t - m.t <= NUDGE_SPEED_MS);
  if (i < 0) i = moves.length - 1; else if (i && i === moves.length - 1) i--;
  const ref = moves[i];
  return ref ? Math.abs(y - ref.y) / Math.max(t - ref.t, 1) : 0;
}
/* Whether a touch was a nudge: `dy` its furthest up or down, `dx` sideways, over `ms`, lifting at `speed` (if not
   given, its average). Mostly up or down (sideways is a swipe), past a tap, within about a row, and slow. */
export const isNudge = ({dx = 0, dy, ms, speed = Math.abs(dy) / Math.max(ms, 1)}) => Math.abs(dy) >= NUDGE_MIN_PX
  && Math.abs(dy) > Math.abs(dx) && Math.abs(dy) <= NUDGE_MAX_PX && speed <= NUDGE_MAX_SPEED;
