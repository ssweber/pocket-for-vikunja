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
export const doneText = (closed, open, title) => (title ? `Done: ${title.length > 40 ? title.slice(0, 38) + '…' : title}` : 'Done')
  + (!open ? '' : closed === open ? `, with ${open} subtask${open === 1 ? '' : 's'}` : `, with ${closed} of its ${open} open subtasks. The rest couldn't be saved.`);
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
/* Whether a finger that has moved (dx, dy) from x0, before the hold, is swiping the row left to show its Delete: mostly
   sideways, and not from the screen's edges, where the phone's own Back and forward gestures start. */
export const swipeStarts = (dx, dy, x0, screen) => dx <= -SWIPE_PX && Math.abs(dx) > Math.abs(dy) && x0 > EDGE_GUARD && x0 < screen - EDGE_GUARD;
// How far the row is moved aside, swiped dx: with the finger, up to the button's width, then slower, like a rubber band.
export const swipeOffset = dx => dx >= 0 ? 0 : dx > -DELETE_W ? dx : -DELETE_W + (dx + DELETE_W) / 3;
// Let go at `offset`: it stays open (true) once it's been moved past a third of the button's width.
export const swipeOpens = offset => offset < -DELETE_W / 3;
// A subtask: a task with a parent. Its tick and progress show on its row only, with no message.
export const isSubtask = t => !!t?.related_tasks?.parenttask?.length;
