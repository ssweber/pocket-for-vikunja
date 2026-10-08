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
export const HOLD_MS = 450;                             // hold this long to start setting progress

/* ---------- sliding a row ---------- */
// Progress set by sliding stops at these, the quarters: few enough that each is felt, as a tick, on the way.
export const SNAPS = [0, 25, 50, 75, 100];
export const EDGE = 48;                                 // px short of the screen's edge where 100% (or 0%) is reached
export const LOCK_PX = 10;                              // after a hold, this far decides the way: sideways or up and down
/* Where a slide puts progress: the snap nearest the finger, or where it started, so progress set elsewhere (40%, say)
   stays as it is until it's slid, then moves to the nearest snap. */
export const snapPct = (start, raw) => [start, ...SNAPS].reduce((best, p) => Math.abs(p - raw) < Math.abs(best - raw) ? p : best);
// The next snap up (dir 1) or down (-1) from pct: the arrow keys on the sheet's bar.
export const nextSnap = (pct, dir) => dir > 0 ? SNAPS.find(p => p > pct) ?? 100 : SNAPS.findLast(p => p < pct) ?? 0;
/* The progress under the finger, held at x on a row `width` wide, on a screen `screen` wide, and moved dx since. It
   moves from where it was, like a volume bar: the room the finger has is the rest of the way, so from 60% held on the
   right of a row, 100% is still within reach. It ends EDGE short of the screen's edge, clear of the phone's own edge
   gestures and easy for a thumb; past it stays at 100% (or 0%). At least a quarter of the row's width, so a little room
   isn't jumpy, but never more than the finger has before the edge: held near it, 100% (or 0%) is still reached, closer
   to the edge. */
export function slidePct({start, dx, x, width, screen}){
  const edge = dx > 0 ? screen - x : x, room = Math.max(edge - EDGE, Math.min(width * .25, edge * .75), 1);
  return snapPct(start, Math.max(0, Math.min(100, start + dx / room * (dx > 0 ? 100 - start : start))));
}
// Which way a finger went after a hold: once it's LOCK_PX away, 'x' (progress) or 'y' (reordering); null until then.
export const lockDirection = (dx, dy) => Math.hypot(dx, dy) < LOCK_PX ? null : Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';

/* ---------- swiping a row to show its Delete ---------- */
export const DELETE_W = 88;                             // px: the Delete button a row slides aside for
export const SWIPE_PX = 8;                              // moved this far before the hold, a finger is scrolling or swiping
export const EDGE_GUARD = 24;                           // a swipe starting this close to the screen's edge is the phone's (Back)
/* Whether a finger that has moved (dx, dy) from x0, before the hold, is swiping the row: from rest, to the left, mostly
   sideways, and not from the screen's edges, where the phone's own Back and forward gestures start; on a row already
   open, either way, to carry on or to close it. */
export const swipeStarts = (dx, dy, x0, screen, open = false) => Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy)
  && (open || (dx < 0 && x0 > EDGE_GUARD && x0 < screen - EDGE_GUARD));
// How far a row `width` wide is moved aside, `dx` from where it rests: with the finger, to the left only.
export const swipeOffset = (dx, width) => Math.max(-width, Math.min(0, dx));
/* Let go at `offset`: past half the row's width, it's deleted straight away (a full swipe, as on a phone's mail);
   past a third of the Delete button, it stays open on it; else it goes back. */
export const swipeEnd = (offset, width) => offset < -width / 2 ? 'delete' : offset < -DELETE_W / 3 ? 'open' : 'shut';
/* ---------- paging a card on Today ---------- */
/* Whether a finger that has moved (dx, dy) from x0, before the hold, is paging a card (app/cards.js): mostly sideways,
   either way, and not from the screen's edges, where the phone's own Back and forward start. Held first, it's progress
   instead; mostly up or down, the page scrolls. */
export const pageStarts = (dx, dy, x0, screen) => Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy) && x0 > EDGE_GUARD && x0 < screen - EDGE_GUARD;
export const PAGE_PX = 40;                              // swiped this far and let go, the card shows the next step
// Let go `dx` from where it started: 1, the step after (swiped left, as a page is turned); -1, the one before; 0, none.
export const pageTurn = dx => dx <= -PAGE_PX ? 1 : dx >= PAGE_PX ? -1 : 0;
// How far the step line follows the finger meanwhile: half as far, and never more than 64px, so it reads as a pull.
export const pageOffset = dx => Math.sign(dx) * Math.min(Math.abs(dx) / 2, 64);
// A subtask: a task with a parent. Its tick and progress show on its row only, with no message.
export const isSubtask = t => !!t?.related_tasks?.parenttask?.length;

/* ---------- who's doing it, and a run's line ---------- */
// Whether sliding progress on a row says you're doing it: only where no one is yet and its slot can be tapped (not done,
// not shared with you to read). Someone else's is never replaced, and yours is already yours (claimSlot, app/claims.js).
export const claimsOnSlide = slot => !!slot?.can && !slot.users?.length;
/* A run's progress line is in segments, one per step; past MANY_STEPS they'd be too short to read, so it's one line with
   a small tick at each step instead. `segs` is at least 1, for the CSS to divide by. Given which steps are done
   (`which`, in the line's order), each segment, or past MANY_STEPS each step's stretch between two ticks, is filled by
   whether its own step is done (`fill`, the line's background), so a filled one is always a done step; given only how
   many (`done`), the steps done are filled from the left. */
export const MANY_STEPS = 12;
export const runLine = (total, done, which = null) => {
  const many = total > MANY_STEPS;
  return {segs: Math.max(total, 1), done: Math.max(0, Math.min(done, total)), many, fill: which && total && which.length === total ? segFill(which) : null};
};
/* The line's background, each step's stretch filled or not: a stop at k / n of the way, which always falls in the gap
   before segment k (the CSS cuts each segment (100% + 3px) / n wide, less a 3px gap), or past MANY_STEPS on the tick
   between two stretches. Steps alike side by side are one stretch. */
const segFill = which => {
  const n = which.length, at = k => +(k / n * 100).toFixed(3) + '%', parts = [];
  for (let k = 0, j; k < n; k = j) {
    for (j = k + 1; j < n && !!which[j] === !!which[k];) j++;
    parts.push(`var(${which[k] ? '--accent' : '--track'}) ${at(k)} ${at(j)}`);
  }
  return `linear-gradient(to right,${parts.join(',')})`;
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
