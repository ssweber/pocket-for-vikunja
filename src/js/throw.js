/* Holding a task on Today shows four dates around the finger: Today to the left, Tomorrow to the right, Next week
   (next Monday) up and No date down. This file works out what each date means on a given day, where the chips sit and
   which one the finger points at. Pure, so the sums can be tested. app/throw.js draws them and handles the touch. It
   is a marking menu (Kurtenbach and Buxton): each date is always in the same direction from where the finger was held,
   so a hold and a flick find it without looking, even before anything has drawn. On a Sunday, Next week is tomorrow,
   and both show. No date takes the same short move as the others, since every date set by a hold has an Undo.
   Letting go near the start changes nothing. Letting go without having moved out leaves the four open to tap, with
   Pick a date… in the middle. A date that would leave the task as it is (Today, on a task due later today) is dimmed,
   never moved or hidden. To change which date is where, or any number, change THROW. */
import {addDays, isSet, movedDue, startOfDay} from './dates.js';
import {ZERO} from './util.js';

export const THROW = {
  // Each date's direction from where the finger was held (`at`), its name, and its day: `day` days from today, or the
  // next `weekday` (0 Sunday … 6 Saturday) after today. Neither means no date.
  targets: [
    {id: 'today', at: 'left', name: 'Today', day: 0},
    {id: 'tomorrow', at: 'right', name: 'Tomorrow', day: 1},
    {id: 'week', at: 'up', name: 'Next week', weekday: 1},
    {id: 'none', at: 'down', name: 'No date'},
  ],
  // Sizes in px. The chips sit around a clear middle, where the finger is.
  chip: {w: 100, h: 60},                                // each chip, at least 56 each way for gloves
  mid: {w: 88, h: 56},                                  // the clear middle, as tall as a one-line row, which shows through it
  gap: 6,                                               // between the middle and each chip
  why: 56,                                              // room over the top chip for the line saying why a task can't move
  margin: 8,                                            // kept from the screen's edges, the header and the add box
  out: 24,                                              // moving this far from the hold lights the date in that direction
  back: 16,                                             // moving back within this unlights it (less than `out`, so it doesn't flicker)
  flick: {px: 12, speed: .3},                           // letting go short of `out` but this far and this fast (px/ms) is a flick
  ms: 120,                                              // ms for the chips to appear
};

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// The next weekday `w` (0 Sunday … 6 Saturday) after `today`. A week on when today is that weekday.
export const nextWeekday = (today, w) => addDays(today, ((w - today.getDay()) % 7 + 7) % 7 || 7);

/* THROW.targets for a task due `due` (an ISO date, or none) at `now`, each with `day` (a Date, null for No date),
   `due` (the task's new due date, keeping its time of day; today, a time already gone becomes the next whole hour),
   `date` ("Mon 12", '' for No date), `label` (what is said once moved there: "Today", "Tomorrow" or the date; null for
   No date) and `dim` (it would leave the date as it is). */
export function throwTargets(due, now = new Date(), targets = THROW.targets){
  const today = startOfDay(now);
  return targets.map(x => {
    const day = x.weekday !== undefined ? nextWeekday(today, x.weekday) : x.day !== undefined ? addDays(today, x.day) : null;
    const to = day ? movedDue(due, day, now) : ZERO, date = day ? `${WEEKDAY[day.getDay()]} ${day.getDate()}` : '';
    const dim = isSet(due) ? isSet(to) && Date.parse(to) === Date.parse(due) : !isSet(to);
    return {...x, day, due: to, dim, date, label: !day ? null : x.day !== undefined ? x.name : date};
  });
}

/* Where the chips go for a finger held at (x, y) on a screen `width` by `height`, between `top` (the header's foot)
   and `bottom` (the add box's top). Returns the middle of the set (x, y), each target with its chip's centre relative
   to that middle and its size (w, h), `mid` (the clear middle) and `why` (where the line saying why the task can't
   move sits, over the top chip and across the screen, or null). Near an edge the whole set moves onto the screen,
   never one chip, and directions still count from where the finger was held (throwPick). */
export function throwLayout(targets, {x, y, width, height, top = 0, bottom = height, why = false}){
  const {chip, mid, gap, margin} = THROW, sx = mid.w / 2 + gap + chip.w / 2, sy = mid.h / 2 + gap + chip.h / 2;
  const at = {left: [-sx, 0], right: [sx, 0], up: [0, -sy], down: [0, sy]};
  const half = sx + chip.w / 2, down = sy + chip.h / 2, up = down + (why ? gap + THROW.why : 0);
  const fit = (v, lo, hi) => lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v));
  // With no room between the header and the add box, the set keeps clear of the header.
  const lo = top + margin + up, hi = bottom - margin - down;
  const cx = fit(x, margin + half, width - margin - half);
  return {x: cx, y: lo > hi ? lo : fit(y, lo, hi), mid: {...mid}, targets: targets.map(t => ({...t, x: at[t.at][0], y: at[t.at][1], w: chip.w, h: chip.h})),
    why: why ? {x: width / 2 - cx, y: -down - gap, w: width - 2 * margin} : null};
}

// The direction of a move (dx, dy): sideways when it is at least as far sideways as vertical.
const way = (dx, dy) => Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'up' : 'down';
/* The date the finger points at, moved (dx, dy) from the hold: the one in its direction once it is past THROW.out,
   none nearer. With one `lit`, it stays lit until the finger is back within THROW.back, so a finger resting at the
   edge doesn't flicker it. */
export function throwPick(targets, dx, dy, lit = false){
  if (Math.hypot(dx, dy) < (lit ? THROW.back : THROW.out)) return null;
  return targets.find(t => t.at === way(dx, dy)) || null;
}
// A flick: let go near the hold but moving fast (`speed`, px/ms) and past a few px. Taken by its direction, as a
// marking menu takes one.
export const throwFlick = (targets, dx, dy, speed) => Math.hypot(dx, dy) >= THROW.flick.px && speed >= THROW.flick.speed ? targets.find(t => t.at === way(dx, dy)) || null : null;
/* What letting go does, as {then, to}. With a date lit (`on`) or flicked at (`flick`), 'move' the task to it, unless
   it is dimmed or the task can't move (`why`): then 'close'. With none, 'close' if the finger had moved out and come
   back, 'open' (the dates stay, to tap) if it never moved out. A touch the phone took away (not `commit`) closes. */
export function throwEnd({commit, on = null, flick = null, out = false, why = null}){
  const p = commit ? on || flick : null;
  if (p) return !p.dim && !why ? {then: 'move', to: p} : {then: 'close', to: null};
  return {then: commit && !out ? 'open' : 'close', to: null};
}

/* A day picked with the phone's date picker (Pick a date…), `value` as the picker gives it ("2026-10-15"), as a
   target like throwTargets': {id, day, due (the time of day kept), label ("Today", "Tomorrow", else "Thu, Oct 15",
   with the year when it isn't this year), dim (it is the day the task already has)}. Null for no day or a day before
   today: a hold moves a task on, and the picker starts at today (dateValue). */
export function throwDate(due, value, now = new Date()){
  const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(value || ''), day = m && new Date(+m[1], m[2] - 1, +m[3]), today = startOfDay(now);
  if (!day || day < today) return null;
  const to = movedDue(due, day, now), n = Math.round((day - today) / 864e5);
  const label = n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : day.toLocaleDateString([], {weekday: 'short', month: 'short', day: 'numeric', year: day.getFullYear() !== today.getFullYear() ? 'numeric' : undefined});
  return {id: 'pick', day, due: to, label, dim: isSet(due) && Date.parse(to) === Date.parse(due)};
}
// The day `due` is on, as a date picker writes it ("2026-10-15"). With no date, today.
export const dateValue = (due, now = new Date()) => { const d = isSet(due) ? new Date(due) : now, p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

// Why a held task can't be moved, shown with all four dates dimmed. The same tasks Move all to today leaves alone.
export const THROW_STAYS = {repeats: 'This task repeats. Tick it to move it to its next date.', checklist: 'A template repeats on its own schedule. Start it to move it to its next date.',
  run: 'A checklist keeps the dates it was started with.'};
