/* A task held on Today: four dates, around the finger (hold-to-reschedule-plan). Which date is in which direction, what
   each means on a given day, where they sit and which one a finger points at. Pure, so the sums can be tested; what's
   drawn and felt is app/throw.js's. A marking menu (Kurtenbach and Buxton): each date always in the same direction
   from where the finger was held, so a hold and a flick find it without looking, and a flick counts before anything
   has drawn.
   - Left, Today; right, Tomorrow: the quickest flicks, on the sideways axis.
   - Up, Next week: next Monday. On a Sunday that's tomorrow, and both show.
   - Down, No date: the due date taken off. It takes the same short move as the others, as every date changed by a hold
     has an Undo (reschedule, app/actions.js).
   - Back near where it was held, none: letting go there changes nothing. Let go without ever having moved out, the
     four stay open, to tap (throwEnd), with Pick a date… in the middle, for any other day (throwDate).
   A date that would leave the task as it is (Today, on a task due later today) is dimmed, never moved or hidden.
   To change which is where (Next week and No date may change places), or any number, change THROW: */
import {addDays, isSet, movedDue, startOfDay} from './dates.js';
import {ZERO} from './util.js';

export const THROW = {
  // Each date: its direction from where the finger was held (`at`: 'left', 'right', 'up' or 'down'), its name, and its
  // day: `day` days from today, or the next `weekday` (1 Monday … 6 Saturday, 0 Sunday) after today; with neither, no
  // date.
  targets: [
    {id: 'today', at: 'left', name: 'Today', day: 0},
    {id: 'tomorrow', at: 'right', name: 'Tomorrow', day: 1},
    {id: 'week', at: 'up', name: 'Next week', weekday: 1},
    {id: 'none', at: 'down', name: 'No date'},
  ],
  // Sizes in px. The dates are chips around a middle left clear, where the finger is:
  chip: {w: 100, h: 60},                                // each chip: at least 56 each way, for gloves
  mid: {w: 88, h: 56},                                  // the middle: as tall as a row on one line, which shows through it
  gap: 6,                                               // between the middle and each chip
  why: 56,                                              // room over the top chip for the line saying why a task can't move
  margin: 8,                                            // kept from the screen's edges, the header and the add box
  out: 24,                                              // moved this far from where it was held, a direction lights its date;
  back: 16,                                             // back within this, none is lit (less than `out`, so it doesn't flicker)
  flick: {px: 12, speed: .3},                           // let go short of `out`, but this far and this fast (px/ms): a flick
  ms: 120,                                              // the chips drawing in
};

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// The next weekday `w` (0 Sunday … 6 Saturday) after `today`: a week on, if today is one.
export const nextWeekday = (today, w) => addDays(today, ((w - today.getDay()) % 7 + 7) % 7 || 7);

/* Each date for a task due `due` (an ISO date, or none), at `now`: THROW.targets' own, with `day` (its Date, null for
   No date), `due` (the task's new due date: movedDue keeps its time of day, and today, a time already gone becomes the
   next whole hour; No date: none), `date` ("Mon 12", '' for No date), `label` (as it's said once moved there: "Today",
   "Tomorrow", "Mon 12"; null for No date), and `dim`: it would leave the date as it is. */
export function throwTargets(due, now = new Date(), targets = THROW.targets){
  const today = startOfDay(now);
  return targets.map(x => {
    const day = x.weekday !== undefined ? nextWeekday(today, x.weekday) : x.day !== undefined ? addDays(today, x.day) : null;
    const to = day ? movedDue(due, day, now) : ZERO, date = day ? `${WEEKDAY[day.getDay()]} ${day.getDate()}` : '';
    const dim = isSet(due) ? isSet(to) && Date.parse(to) === Date.parse(due) : !isSet(to);
    return {...x, day, due: to, dim, date, label: !day ? null : x.day !== undefined ? x.name : date};
  });
}

/* Where the chips go, for the finger held at (x, y) on a screen `width` by `height`, between `top` (the header's foot)
   and `bottom` (the add box's top): {x, y: the middle of the set, targets: each with its chip's middle (x, y, from
   the set's) and size (w, h), mid: the middle left clear (w, h), why: where the line saying why sits, when there's
   one (`why`): over the top chip, across the screen ({x: its middle, y: its foot, from the set's; w: its most})}. The set is around the finger; near an edge the whole set moves
   onto the screen, never one chip, and the directions still count from where the finger was held (throwPick), not
   from where the set is. */
export function throwLayout(targets, {x, y, width, height, top = 0, bottom = height, why = false}){
  const {chip, mid, gap, margin} = THROW, sx = mid.w / 2 + gap + chip.w / 2, sy = mid.h / 2 + gap + chip.h / 2;
  const at = {left: [-sx, 0], right: [sx, 0], up: [0, -sy], down: [0, sy]};
  const half = sx + chip.w / 2, down = sy + chip.h / 2, up = down + (why ? gap + THROW.why : 0);
  const fit = (v, lo, hi) => lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v));
  // (With no room for it between the header and the add box, it keeps clear of the header.)
  const lo = top + margin + up, hi = bottom - margin - down;
  const cx = fit(x, margin + half, width - margin - half);
  return {x: cx, y: lo > hi ? lo : fit(y, lo, hi), mid: {...mid}, targets: targets.map(t => ({...t, x: at[t.at][0], y: at[t.at][1], w: chip.w, h: chip.h})),
    why: why ? {x: width / 2 - cx, y: -down - gap, w: width - 2 * margin} : null};
}

// The direction a finger has gone, moved (dx, dy) from where it was held: sideways if it's as far sideways as up or down.
const way = (dx, dy) => Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'up' : 'down';
/* The date a finger points at, moved (dx, dy) from where it was held: the one in its direction, once it's out past
   THROW.out; none near where it was held. `lit`: one is lit now, and stays so until the finger is back within
   THROW.back, so a finger resting at the edge doesn't flicker it. */
export function throwPick(targets, dx, dy, lit = false){
  if (Math.hypot(dx, dy) < (lit ? THROW.back : THROW.out)) return null;
  return targets.find(t => t.at === way(dx, dy)) || null;
}
// Let go near where it was held, but moving fast (`speed`, px/ms) and past a few px: a flick, taken by its direction,
// as a marking menu takes one.
export const throwFlick = (targets, dx, dy, speed) => Math.hypot(dx, dy) >= THROW.flick.px && speed >= THROW.flick.speed ? targets.find(t => t.at === way(dx, dy)) || null : null;
/* What letting go does, as {then, to}. With a date lit (`on`), or flicked at (`flick`): 'move', the task to it (`to`),
   unless it's dimmed, or the task can't move (`why`): then 'close', nothing changed. With none: back near where it
   was held after having moved out (`out`), 'close'; never moved out at all, 'open': the dates stay, to tap. Taken away
   by the phone (not `commit`): 'close'. */
export function throwEnd({commit, on = null, flick = null, out = false, why = null}){
  const p = commit ? on || flick : null;
  if (p) return !p.dim && !why ? {then: 'move', to: p} : {then: 'close', to: null};
  return {then: commit && !out ? 'open' : 'close', to: null};
}

/* A day picked with the phone's own date picker (Pick a date…), for a task due `due`: `value` is the picker's
   ("2026-10-15"). As a date of throwTargets': {id, day, due (movedDue: its time of day kept), label (as it's said once
   moved there: "Today", "Tomorrow", else "Thu, Oct 15", with the year when it isn't this one's), dim: it's the day it
   has}. null for no day, or one before today: a hold moves a task on, and the picker is given today as its first day
   (dateValue). */
export function throwDate(due, value, now = new Date()){
  const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(value || ''), day = m && new Date(+m[1], m[2] - 1, +m[3]), today = startOfDay(now);
  if (!day || day < today) return null;
  const to = movedDue(due, day, now), n = Math.round((day - today) / 864e5);
  const label = n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : day.toLocaleDateString([], {weekday: 'short', month: 'short', day: 'numeric', year: day.getFullYear() !== today.getFullYear() ? 'numeric' : undefined});
  return {id: 'pick', day, due: to, label, dim: isSet(due) && Date.parse(to) === Date.parse(due)};
}
// A day as a date picker has it ("2026-10-15"): the day `due` is on; with no date, today (the picker's first day).
export const dateValue = (due, now = new Date()) => { const d = isSet(due) ? new Date(due) : now, p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

// Why a task held on Today can't be moved, said with its dates all dimmed: as Move all to today leaves them.
export const THROW_STAYS = {repeats: 'It repeats: tick it to move on to its next date.', checklist: 'A checklist comes round by itself: start it to move on.',
  run: 'A checklist run keeps the dates it was started with.'};
