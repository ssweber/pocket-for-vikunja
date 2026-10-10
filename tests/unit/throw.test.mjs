// A task held on Today, four dates around the finger (hold-to-reschedule-plan): what each direction means on each day
// of the week, which date a finger points at, and where the chips sit on a phone (src/js/throw.js).
import './browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THROW, throwEnd, throwFlick, throwLayout, throwPick, throwTargets } from '../../src/js/throw.js';

// October 2026: Monday the 12th to Sunday the 18th, and the weeks either side.
const on = (d, h = 10, m = 0) => new Date(2026, 9, d, h, m);
const iso = (d, h = 0, m = 0) => on(d, h, m).toISOString();
const ZERO = '0001-01-01T00:00:00Z';
const DAYS = { 12: 'Monday', 13: 'Tuesday', 14: 'Wednesday', 15: 'Thursday', 16: 'Friday', 17: 'Saturday', 18: 'Sunday' };
// A small phone: 360px wide, between the header's foot and the add box's top.
const phone = { width: 360, height: 640, top: 56, bottom: 572 };
const box = (lay, t) => [lay.x + t.x - t.w / 2, lay.x + t.x + t.w / 2, lay.y + t.y - t.h / 2, lay.y + t.y + t.h / 2];

test('left is Today, right Tomorrow, up next Monday and down No date, on each day of the week; on a Sunday, next Monday is tomorrow', () => {
  assert.deepEqual(THROW.targets.map(t => [t.at, t.name]), [['left', 'Today'], ['right', 'Tomorrow'], ['up', 'Next week'], ['down', 'No date']], 'one list says which is where');
  const want = { 12: ['Mon 12', 'Tue 13', 'Mon 19'], 13: ['Tue 13', 'Wed 14', 'Mon 19'], 14: ['Wed 14', 'Thu 15', 'Mon 19'], 15: ['Thu 15', 'Fri 16', 'Mon 19'],
    16: ['Fri 16', 'Sat 17', 'Mon 19'], 17: ['Sat 17', 'Sun 18', 'Mon 19'], 18: ['Sun 18', 'Mon 19', 'Mon 19'] };
  for (const [d, dates] of Object.entries(want)) {
    const ts = throwTargets(iso(9, 9), on(+d)), at = w => ts.find(t => t.at === w);
    assert.deepEqual([at('left').date, at('right').date, at('up').date], dates, DAYS[d]);
    assert.deepEqual([at('down').day, at('down').date, at('down').due], [null, '', ZERO], 'down takes the date off, ' + DAYS[d]);
  }
  const sun = throwTargets(iso(9, 9), on(18));
  assert.equal(sun.find(t => t.id === 'week').due, sun.find(t => t.id === 'tomorrow').due, 'a Sunday: up and right both show, and mean the same day');
  assert.equal(throwTargets(iso(9, 9), on(12, 23, 30)).find(t => t.id === 'week').date, 'Mon 19', 'a Monday, late: next Monday, never today');
});

test('a date that would change nothing is dimmed; the time of day is kept, one with no time stays without, and today a time gone is the next whole hour', () => {
  const now = on(12, 14, 20), by = (due, id, at = now) => throwTargets(due, at).find(t => t.id === id);
  assert.equal(by(iso(12, 16), 'today').dim, true, 'due later today: Today dimmed, still there');
  assert.equal(by(iso(12, 16), 'tomorrow').dim, false);
  assert.equal(by(iso(12, 16), 'tomorrow').due, iso(13, 16), 'tomorrow at 4 PM');
  assert.equal(by(iso(12, 9), 'today').dim, false, 'due this morning, gone: Today moves it on');
  assert.equal(by(iso(12, 9), 'today').due, iso(12, 15), 'to the next whole hour');
  assert.equal(by(iso(9, 9), 'week').due, iso(19, 9), 'overdue since Friday: next Monday at 9 AM');
  assert.equal(by(iso(19, 0), 'week').dim, true, 'due next Monday: Next week dimmed');
  assert.equal(by(iso(12, 0), 'today').dim, true, 'due today, no time: Today dimmed');
  assert.equal(by(iso(12, 0), 'tomorrow').due, iso(13, 0), 'no time: tomorrow, still with none');
  assert.equal(by(ZERO, 'today').due, iso(12, 0), 'no date: today, with no time');
  assert.equal(by(ZERO, 'none').dim, true, 'no date: No date dimmed');
  assert.deepEqual([by(iso(12, 16), 'none').due, by(iso(12, 16), 'none').dim], [ZERO, false], 'No date takes it off');
  assert.deepEqual(['today', 'tomorrow', 'week', 'none'].map(id => by(iso(12, 16), id).label), ['Today', 'Tomorrow', 'Mon 19', null], 'as each is said once it has moved there');
  assert.deepEqual(['tomorrow', 'week'].map(id => by(iso(19, 9), id, on(18)).dim), [true, true], 'a Sunday, due on the Monday: both dimmed');
});

test('a direction past 24px lights its date, No date by the same short move; back near where it was held, none; a flick counts by its direction', () => {
  const ts = throwTargets(iso(12, 16), on(12)), pick = (dx, dy, lit) => throwPick(ts, dx, dy, lit)?.id ?? null;
  assert.equal(THROW.out, 24);
  assert.deepEqual([pick(10, -12), pick(23, 0), pick(0, 23)], [null, null, null], 'near where it was held: none');
  assert.deepEqual([pick(-24, 0), pick(24, 0), pick(0, -24), pick(0, 24)], ['today', 'tomorrow', 'week', 'none'], 'each way, the same short move');
  assert.deepEqual([pick(-30, 20), pick(30, -20), pick(20, -30), pick(-20, 30)], ['today', 'tomorrow', 'week', 'none'], 'between two: the one it\'s more towards');
  assert.equal(pick(30, 30), 'tomorrow', 'as far sideways as down: sideways');
  assert.equal(pick(300, -40), 'tomorrow', 'however far: by its direction, not by where a chip is');
  assert.deepEqual([pick(20, 0, true), pick(15, 0, true), pick(20, 0, false)], ['tomorrow', null, null], 'one lit stays lit a little nearer in, so a finger at the edge doesn\'t flicker it');
  assert.equal(throwFlick(ts, 14, -2, 1)?.id, 'tomorrow', 'a quick flick, let go short of 24px, counts');
  assert.equal(throwFlick(ts, 0, 14, 1)?.id, 'none', 'down too');
  assert.equal(throwFlick(ts, 14, -2, .1), null, 'a slow move let go there doesn\'t');
  assert.equal(throwFlick(ts, 6, 0, 2), null, 'nor a twitch');
  // Which is where is the list's to say: Next week and No date changed places.
  const swapped = throwTargets(iso(12, 16), on(12), THROW.targets.map(t => ({ ...t, at: { up: 'down', down: 'up' }[t.at] || t.at })));
  assert.deepEqual([throwPick(swapped, 0, -30).id, throwPick(swapped, 0, 30).id, throwPick(swapped, 30, 0).id], ['none', 'week', 'tomorrow']);
});

test('the chips sit around the finger, each in its direction and at least 56px each way, the middle left clear', () => {
  const ts = throwTargets(iso(12, 16), on(12)), lay = throwLayout(ts, { x: 180, y: 300, ...phone }), by = id => lay.targets.find(t => t.id === id);
  assert.deepEqual([lay.x, lay.y], [180, 300], 'room enough: around the finger');
  assert.ok(lay.targets.every(t => t.w >= 56 && t.h >= 56), 'for gloves');
  assert.ok(lay.mid.w >= 56 && lay.mid.h >= 56, 'the middle too, where Pick a date… is tapped');
  assert.ok(by('today').x < 0 && by('today').y === 0 && by('tomorrow').x > 0 && by('tomorrow').y === 0, 'Today left, Tomorrow right');
  assert.ok(by('week').y < 0 && by('week').x === 0 && by('none').y > 0 && by('none').x === 0, 'Next week above, No date below');
  const boxes = [...lay.targets.map(t => box(lay, t)), [lay.x - lay.mid.w / 2, lay.x + lay.mid.w / 2, lay.y - lay.mid.h / 2, lay.y + lay.mid.h / 2]];
  const apart = ([l, r, t, b], [l2, r2, t2, b2]) => r <= l2 || r2 <= l || b <= t2 || b2 <= t;
  assert.ok(boxes.every((a, i) => boxes.every((b, k) => i === k || apart(a, b))), 'no chip over another, nor over the middle');
  assert.equal(lay.why, null, 'no line saying why, for a task that can move');
});

test('the set stays on a 360px screen for a row at the top and at the bottom: the whole set moves, never one chip', () => {
  const ts = throwTargets(iso(12, 16), on(12)), mid = throwLayout(ts, { x: 180, y: 300, ...phone });
  for (const width of [360, 375, 390, 430]) for (const x of [10, width / 2, width - 10]) for (const y of [phone.top + 28, 300, phone.bottom - 28]) for (const why of [false, true]) {
    const lay = throwLayout(ts, { x, y, ...phone, width, why }), boxes = lay.targets.map(t => box(lay, t)), where = `${width}px, held at ${x},${y}${why ? ', with its line' : ''}`;
    assert.ok(boxes.every(([l, r]) => l >= THROW.margin && r <= width - THROW.margin), 'on the screen sideways, ' + where);
    assert.ok(boxes.every(([, , t, b]) => t >= phone.top + THROW.margin && b <= phone.bottom - THROW.margin), 'between the header and the add box, ' + where);
    assert.deepEqual(lay.targets.map(t => [t.id, t.x, t.y]), mid.targets.map(t => [t.id, t.x, t.y]), 'each chip where it is in the set, ' + where);
    if (!why) continue;
    assert.ok(lay.y + lay.why.y <= Math.min(...boxes.map(b => b[2])) && lay.y + lay.why.y - THROW.why >= phone.top + THROW.margin, 'the line saying why over the top chip, under the header, ' + where);
    assert.deepEqual([lay.x + lay.why.x, lay.why.w], [width / 2, width - 2 * THROW.margin], 'across the screen, ' + where);
  }
  const top = throwLayout(ts, { x: 180, y: phone.top + 28, ...phone }), low = throwLayout(ts, { x: 180, y: phone.bottom - 28, ...phone });
  assert.ok(top.y > phone.top + 28 && low.y < phone.bottom - 28, 'the first row: moved down; the last: moved up');
  assert.ok(throwLayout(ts, { x: 350, y: 300, ...phone }).x < 350 && throwLayout(ts, { x: 10, y: 300, ...phone }).x > 10, 'near a side: moved in');
  // What's picked never asks where the set is: the directions count from where the finger was held.
  assert.equal(throwPick(ts, 30, 0).id, 'tomorrow');
  const squeezed = throwLayout(ts, { x: 180, y: 100, ...phone, bottom: phone.top + 120 });
  assert.ok(Math.min(...squeezed.targets.map(t => box(squeezed, t)[2])) >= phone.top + THROW.margin, 'with no room for it (the keyboard up): clear of the header');
});

test('let go with a date lit, the task moves; back near where it was held after moving out, nothing; never moved out, the dates stay open to tap', () => {
  const ts = throwTargets(iso(12, 16), on(12)), by = id => ts.find(t => t.id === id), end = o => { const e = throwEnd(o); return [e.then, e.to?.id ?? null]; };
  assert.deepEqual(end({ commit: true, on: by('tomorrow'), out: true }), ['move', 'tomorrow']);
  assert.deepEqual(end({ commit: true, flick: by('none') }), ['move', 'none'], 'a flick, before any date was lit');
  assert.deepEqual(end({ commit: true, out: true }), ['close', null], 'moved out, then back near where it was held: closed, nothing changed');
  assert.deepEqual(end({ commit: true }), ['open', null], 'never moved out: left open');
  assert.deepEqual([end({ commit: true, on: by('today'), out: true }), end({ commit: true, flick: by('today') })], [['close', null], ['close', null]], 'a dimmed date, pointed at or flicked at: nothing');
  assert.deepEqual(end({ commit: true, on: by('tomorrow'), out: true, why: 'repeats' }), ['close', null], 'a task that can\'t move: nothing');
  assert.deepEqual(end({ commit: true, why: 'repeats' }), ['open', null], 'but held without a move, its dates are left open too, dimmed, to read why');
  assert.deepEqual([end({ commit: false, on: by('tomorrow'), out: true }), end({ commit: false })], [['close', null], ['close', null]], 'taken away by the phone: nothing, and nothing left open');
});
