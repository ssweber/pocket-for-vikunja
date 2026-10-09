/* The ring a task held on Today is thrown at, to a new date (parent-tasks-plan, 4b): its targets, what each means on a
   given day, where they sit around the finger, and which one a finger is on. Pure, so the sums can be tested; what's
   drawn and felt is app/throw.js's. A marking menu (Kurtenbach and Buxton): each target always in the same direction,
   so a hold and a flick find it without looking, and a flick counts before the ring has drawn.
   - Left, Today; right, Tomorrow: the quickest flicks, on the sideways axis.
   - Above, an arc of five tiles, Monday to Friday, always in that order. Each is the next such day after tomorrow, so
     early in the week most are this week's and by Wednesday most are next week's. This week's are always the arc's
     right end, the later week's its left: a gap where the week changes, a label over each week, and the later week's
     tiles a quieter shade (never the colour alone).
   - Down, a long pull past the ring: No date, the due date taken off. A short flick down does nothing.
   - The middle keeps it where it is.
   A target that would leave the date as it is (Today, on a task due later today) is dimmed, never moved or hidden.
   To try another set, or other numbers, change THROW: */
import {addDays, isSet, movedDue, startOfDay} from './dates.js';
import {ZERO} from './util.js';

export const THROW = {
  // Each tile: the next such weekday after tomorrow ('after-tomorrow'), or always next week's Monday to Friday
  // ('next-week').
  weekdays: 'after-tomorrow',
  // Where each target sits ('left', 'right', 'arc' in order from the left, 'down'), its name, and its day: `day` days
  // from today, or the weekday `weekday` (1 Monday … 5 Friday) by the rule above; 'down' has none.
  targets: [
    {id: 'today', at: 'left', name: 'Today', day: 0},
    {id: 'tomorrow', at: 'right', name: 'Tomorrow', day: 1},
    {id: 'mon', at: 'arc', name: 'Mon', weekday: 1},
    {id: 'tue', at: 'arc', name: 'Tue', weekday: 2},
    {id: 'wed', at: 'arc', name: 'Wed', weekday: 3},
    {id: 'thu', at: 'arc', name: 'Thu', weekday: 4},
    {id: 'fri', at: 'arc', name: 'Fri', weekday: 5},
    {id: 'none', at: 'down', name: 'No date'},
  ],
  // The labels over the arc's weeks: this week, next week, the week after (only on a Sunday, for Monday's tile).
  weeks: ['this week', 'next week', 'week after next'],
  // Sizes in px, from the ring's middle, where the finger was held:
  side: {x: 112, w: 96, h: 64},                         // Today and Tomorrow: their middles this far left and right
  arc: {y: 128, w: 64, h: 60, gap: 4, week: 16, bow: 20, label: 20, from: 25},   // the tiles: the middle one this far up, the
                                                        // ends `bow` lower; `week`: the extra gap where the week changes;
                                                        // `label`: room above for the week's name; `from`: the arc's
                                                        // directions start this many degrees above the sideways axis
  down: {y: 216, w: 136, h: 52, min: 120, half: 45},    // No date: this far down (about twice side.x), or less where the
                                                        // finger has less room (never under `min`); its slice 45° each side
  middle: 28,                                           // let go within this of where it was held: it stays
  pad: 4,                                               // a target's box counts this far beyond its edges
  flick: {px: 14, speed: .3},                           // let go this far out, this fast (px/ms): a flick, its direction counts
  margin: 8,                                            // kept from the screen's edges, the header and the add box
  ms: {draw: 140, fly: 180},                            // the ring drawing in; the box flying to its target, or back
};

const DAY = 864e5;
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// The Monday a day's week starts on.
const weekOf = d => addDays(startOfDay(d), -((d.getDay() + 6) % 7));
// Whole days from a to b, midnight to midnight (a day of 23 or 25 hours too).
const daysTo = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / DAY);
// Weekday `w` (1 Monday … 5 Friday) as a tile means it, from `today`.
export function tileDay(today, w, rule = THROW.weekdays){
  if (rule === 'next-week') return addDays(weekOf(today), 7 + w - 1);
  const after = addDays(today, 2);                      // after tomorrow
  return addDays(after, ((w - after.getDay()) % 7 + 7) % 7);
}

/* Each target for a task due `due` (an ISO date, or none), at `now`: THROW.targets' own, with `day` (its Date, null for
   No date), `due` (the task's new due date: movedDue keeps its time of day, and today, a time already gone becomes the
   next whole hour; No date: none), `date` ("Thu 15"), `week` (0 this week, 1 next, 2 the one after; the arc groups by
   it), and `dim`: it would leave the date as it is. */
export function throwTargets(due, now = new Date(), {weekdays = THROW.weekdays, targets = THROW.targets} = {}){
  const today = startOfDay(now), week0 = weekOf(today);
  return targets.map(x => {
    const day = x.at === 'down' ? null : x.weekday ? tileDay(today, x.weekday, weekdays) : addDays(today, x.day);
    const to = day ? movedDue(due, day, now) : ZERO;
    const dim = isSet(due) ? isSet(to) && Date.parse(to) === Date.parse(due) : !isSet(to);
    return {...x, day, due: to, dim, date: day ? `${WEEKDAY[day.getDay()]} ${day.getDate()}` : '', week: day ? Math.round(daysTo(week0, weekOf(day)) / 7) : null};
  });
}

/* Where the ring goes, for the finger held at (x, y) on a screen `width` by `height`, between `top` (the header's foot)
   and `bottom` (the add box's top): {x, y: its middle, reach: how far down No date is reached, targets: each with its
   box's middle (x, y, from the ring's middle) and size (w, h), weeks: the label over each of the arc's weeks {text, x,
   y: its foot}}. Near an edge it shifts onto the screen and keeps its directions: what's picked is where the finger
   goes from where it was held (throwPick), not where it is on the screen. */
export function throwLayout(targets, {x, y, width, height, top = 0, bottom = height}){
  const {side, arc, down, margin} = THROW, out = [], weeks = [];
  // The arc: left to right, a wider gap where the week changes.
  const tiles = targets.filter(t => t.at === 'arc'), n = tiles.length;
  const gaps = tiles.map((t, i) => i ? arc.gap + (t.week !== tiles[i - 1].week ? arc.week : 0) : 0);
  const span = n * arc.w + gaps.reduce((a, b) => a + b, 0);
  let left = -span / 2;
  tiles.forEach((t, i) => {
    left += gaps[i];
    const k = n > 1 ? (i - (n - 1) / 2) / ((n - 1) / 2) : 0;
    out.push({...t, x: left + arc.w / 2, y: -arc.y + arc.bow * k * k, w: arc.w, h: arc.h});
    left += arc.w;
  });
  for (const t of out) {
    const w = weeks.at(-1);
    if (w && w.week === t.week) w.tiles.push(t); else weeks.push({week: t.week, tiles: [t]});
  }
  // The room the finger has below it, for the long pull: No date comes nearer, down to its least.
  const room = height - y - margin, downY = Math.max(down.min, Math.min(down.y, room + down.h / 2 - margin));
  for (const t of targets) {
    if (t.at === 'left' || t.at === 'right') out.push({...t, x: t.at === 'left' ? -side.x : side.x, y: 0, w: side.w, h: side.h});
    if (t.at === 'down') out.push({...t, x: 0, y: downY, w: down.w, h: down.h});
  }
  // On the screen, clear of the header and the add box: as near the finger as that allows.
  const half = Math.max(side.x + side.w / 2, span / 2), up = arc.y + arc.h / 2 + arc.label, below = out.some(t => t.at === 'down') ? downY + down.h / 2 : side.h / 2;
  const fit = (v, lo, hi) => lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v));
  const cx = fit(x, margin + half, width - margin - half), lo = top + margin + up, cy = lo > bottom - margin - below ? lo : fit(y, lo, bottom - margin - below);
  return {x: cx, y: cy, reach: downY - down.h / 2, targets: out,
    weeks: weeks.map(w => ({text: THROW.weeks[w.week] ?? '', week: w.week, x: (w.tiles[0].x + w.tiles.at(-1).x) / 2, y: Math.min(...w.tiles.map(t => t.y - t.h / 2)) - 4}))};
}

// The target in the direction (dx, dy) from the middle: sideways Today or Tomorrow; up, the tile of the arc whose
// direction, as it's drawn, is nearest; down, No date only once `far` (the long pull); null, the empty slice under a
// short pull.
const angle = (x, y) => Math.atan2(-y, x) * 180 / Math.PI;     // up is positive, 0 to the right
function slice(lay, dx, dy, far){
  const a = angle(dx, dy), {from} = THROW.arc, at = w => lay.targets.find(t => t.at === w) || null;
  const tiles = lay.targets.filter(t => t.at === 'arc');
  if (a >= from && a <= 180 - from && tiles.length) return tiles.reduce((p, t) => Math.abs(angle(t.x, t.y) - a) < Math.abs(angle(p.x, p.y) - a) ? t : p);
  if (a > -90 + THROW.down.half && a < from) return at('right');
  if (a > 180 - from || a < -90 - THROW.down.half) return at('left');
  return far ? at('down') : null;
}
/* The target a finger is on, moved (dx, dy) from where it was held, with the ring laid out as `lay`: the one whose box it's
   over; else, out of the middle, the one in its direction (slice); null in the middle, or down short of the long pull. */
export function throwPick(lay, dx, dy){
  const {pad, middle} = THROW;
  const hit = lay.targets.find(t => Math.abs(dx - t.x) <= t.w / 2 + pad && Math.abs(dy - t.y) <= t.h / 2 + pad);
  if (hit) return hit;
  return Math.hypot(dx, dy) < middle ? null : slice(lay, dx, dy, dy >= lay.reach);
}
// Let go in the middle, but moving fast (`speed`, px/ms) and past a few px: a flick, taken by its direction, as a marking
// menu takes one. Never No date: that needs the long pull.
export const throwFlick = (lay, dx, dy, speed) => Math.hypot(dx, dy) >= THROW.flick.px && speed >= THROW.flick.speed ? slice(lay, dx, dy, false) : null;

// What a screen reader hears once a task is thrown: "Moved “Order the cups” to Thu 15", or "Took the date off …".
export const thrownText = (title, t) => t.at === 'down' ? `Took the date off “${title}”` : `Moved “${title}” to ${t.day && daysTo(new Date(), t.day) < 2 ? t.name.toLowerCase() : t.date}`;
// Why a task held on Today can't be thrown, said in the ring under it (its targets all dimmed): as Move all to today
// leaves them.
export const THROW_STAYS = {repeats: 'It repeats: tick it to move on to its next date.', checklist: 'A checklist comes round by itself: start it to move on.',
  run: 'A checklist run keeps the dates it was started with.'};
