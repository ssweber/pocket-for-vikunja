/* Holding a task on Today shows four dates around the touch: Today to the left, Tomorrow to the right, Next week
   (next Monday) above and No date below. This file calculates what each date means on a given day, where the chips
   sit and which one the touch points at. It has no DOM code, so the unit tests cover it. app/throw.js draws the
   chips and handles the touch.

   The layout is a marking menu (Kurtenbach and Buxton). Each date is always in the same direction from where the
   hold started, so the user can hold and flick to a date without looking, even before the chips are drawn.

   On a Sunday, Next week is tomorrow, and both dates show. No date takes the same short move as the others, because
   every date set by a hold has an Undo. Releasing near the start changes nothing. Releasing without having moved out
   leaves the four dates open to tap, with Pick a date… in the middle. A date that would leave the task as it is
   (Today, on a task due later today) is dimmed. It is never moved or hidden. To change which date is where, or any
   number, change THROW. */
import {addDays, dayName, isSet, movedDue, startOfDay} from './dates.js';
import {ZERO} from './util.js';

export const THROW = {
  // Each date's direction from where the hold started (`at`), its name, and its day. `day` is a number of days from
  // today, and `weekday` is the next such weekday (0 Sunday … 6 Saturday) after today. With neither, it is No date.
  targets: [
    {id: 'today', at: 'left', name: 'Today', day: 0},
    {id: 'tomorrow', at: 'right', name: 'Tomorrow', day: 1},
    {id: 'week', at: 'up', name: 'Next week', weekday: 1},
    {id: 'none', at: 'down', name: 'No date'},
  ],
  // Sizes in px. The chips sit around a clear middle, where the touch is.
  chip: {w: 100, h: 60},                                // each chip, at least 56 each way for gloves
  mid: {w: 88, h: 56},                                  // the clear middle, as tall as a one-line row, which shows through it
  gap: 6,                                               // between the middle and each chip
  why: 56,                                              // space above the top chip for the message saying why a task can't move
  margin: 8,                                            // kept clear of the screen's edges, the header and the add box
  out: 24,                                              // moving this far from the hold highlights the date in that direction
  back: 16,                                             // moving back within this removes the highlight (less than `out`, so it doesn't flicker)
  flick: {px: 12, speed: .3},                           // releasing short of `out` but at least this far and this fast (px/ms) is a flick
  ms: 120,                                              // ms for the chips to appear
};

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// The next weekday `w` (0 Sunday … 6 Saturday) after `today`. When today is that weekday, it is a week from today.
export const nextWeekday = (today, w) => addDays(today, ((w - today.getDay()) % 7 + 7) % 7 || 7);

/* THROW.targets for a task due `due` (an ISO date, or none) at `now`. Each target gets:
   - `day`: a Date, or null for No date.
   - `due`: the task's new due date, which keeps its time of day. For today, a time that has already passed becomes
     no time, so the task is due all day.
   - `date`: "Mon 12", or '' for No date.
   - `label`: the text shown once the task has moved there ("Today", "Tomorrow" or the date), or null for No date.
   - `dim`: true when moving there would leave the date as it is. */
export function throwTargets(due, now = new Date(), targets = THROW.targets){
  const today = startOfDay(now);
  return targets.map(x => {
    const day = x.weekday !== undefined ? nextWeekday(today, x.weekday) : x.day !== undefined ? addDays(today, x.day) : null;
    const to = day ? movedDue(due, day, now) : ZERO, date = day ? `${WEEKDAY[day.getDay()]} ${day.getDate()}` : '';
    const dim = isSet(due) ? isSet(to) && Date.parse(to) === Date.parse(due) : !isSet(to);
    return {...x, day, due: to, dim, date, label: !day ? null : x.day !== undefined ? x.name : date};
  });
}

/* Where the chips go for a touch held at (x, y) on a screen `width` by `height`, between `top` (the bottom of the
   header) and `bottom` (the top of the add box). Returns the middle of the set (x, y), and each target with its
   chip's centre relative to that middle and its size (w, h). It also returns `mid` (the clear middle) and `why` (where
   the message saying why the task can't move goes, above the top chip and across the screen, or null). Near an edge
   the whole set moves onto the screen, never a single chip, and directions still count from where the hold started
   (throwPick). */
export function throwLayout(targets, {x, y, width, height, top = 0, bottom = height, why = false}){
  const {chip, mid, gap, margin} = THROW, sx = mid.w / 2 + gap + chip.w / 2, sy = mid.h / 2 + gap + chip.h / 2;
  const at = {left: [-sx, 0], right: [sx, 0], up: [0, -sy], down: [0, sy]};
  const half = sx + chip.w / 2, down = sy + chip.h / 2, up = down + (why ? gap + THROW.why : 0);
  const fit = (v, lo, hi) => lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v));
  // With no space between the header and the add box, the set stays clear of the header.
  const lo = top + margin + up, hi = bottom - margin - down;
  const cx = fit(x, margin + half, width - margin - half);
  return {x: cx, y: lo > hi ? lo : fit(y, lo, hi), mid: {...mid}, targets: targets.map(t => ({...t, x: at[t.at][0], y: at[t.at][1], w: chip.w, h: chip.h})),
    why: why ? {x: width / 2 - cx, y: -down - gap, w: width - 2 * margin} : null};
}

// The direction of a move (dx, dy): sideways when it is at least as far sideways as vertical.
const way = (dx, dy) => Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'up' : 'down';
/* The date the touch points at after moving (dx, dy) from the hold. It is the date in that direction once the touch is
   past THROW.out, and none while it is nearer. When a date is already highlighted (`lit`), it stays highlighted until
   the touch is back within THROW.back, so a touch resting at the edge doesn't make it flicker. */
export function throwPick(targets, dx, dy, lit = false){
  if (Math.hypot(dx, dy) < (lit ? THROW.back : THROW.out)) return null;
  return targets.find(t => t.at === way(dx, dy)) || null;
}
// A flick is a release near the hold at a high `speed` (px/ms), after moving a few px. Its direction picks the date,
// as in a marking menu.
export const throwFlick = (targets, dx, dy, speed) => Math.hypot(dx, dy) >= THROW.flick.px && speed >= THROW.flick.speed ? targets.find(t => t.at === way(dx, dy)) || null : null;
/* What releasing does, as {then, to}. With a date highlighted (`on`) or flicked to (`flick`), the result is 'move' the
   task to it. If that date is dimmed or the task can't move (`why`), the result is 'close'. With no date, the result is
   'close' if the touch moved out and came back, and 'open' (the dates stay, to tap) if it never moved out. If the
   phone cancels the touch (not `commit`), the result is 'close'. */
export function throwEnd({commit, on = null, flick = null, out = false, why = null}){
  const p = commit ? on || flick : null;
  if (p) return !p.dim && !why ? {then: 'move', to: p} : {then: 'close', to: null};
  return {then: commit && !out ? 'open' : 'close', to: null};
}

/* A day picked with the phone's date picker (Pick a date…). `value` is the picker's string ("2026-10-15"). Returns a
   target like the ones throwTargets returns: {id, day, due, label, dim}. `due` keeps the task's time of day. `label`
   is "Today", "Tomorrow", or else "Thu, Oct 15" (with the year when it isn't this year). `dim` is true when the task
   is already on that day. Returns null for no day or a day before today, because a hold only moves a task later and
   the picker starts at today (dateValue). */
export function throwDate(due, value, now = new Date()){
  const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(value || ''), day = m && new Date(+m[1], m[2] - 1, +m[3]), today = startOfDay(now);
  if (!day || day < today) return null;
  const to = movedDue(due, day, now);
  return {id: 'pick', day, due: to, label: dayName(to, now), dim: isSet(due) && Date.parse(to) === Date.parse(due)};
}
// The day `due` is on, as a date picker writes it ("2026-10-15"). With no date, today.
export const dateValue = (due, now = new Date()) => { const d = isSet(due) ? new Date(due) : now, p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

// The messages for why a held task can't move. They show with all four dates dimmed. These are the same tasks that
// Move all to today leaves alone.
export const THROW_STAYS = {repeats: 'This task repeats. Tick it to move it to its next date.', checklist: 'A template repeats on its own schedule. Start it to move it to its next date.',
  run: 'A checklist keeps the dates it was started with.'};
