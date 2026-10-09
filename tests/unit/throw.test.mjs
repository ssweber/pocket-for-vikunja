// The ring a task held on Today is thrown at (parent-tasks-plan, 4b): what each target means on each day of the week,
// where they sit on a phone, and which one a finger is on (src/js/throw.js).
import './browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THROW, throwFlick, throwLayout, throwPick, throwTargets, thrownText } from '../../src/js/throw.js';

// October 2026: Monday the 12th to Sunday the 18th, and the weeks either side.
const on = (d, h = 10, m = 0) => new Date(2026, 9, d, h, m);
const iso = (d, h = 0, m = 0) => on(d, h, m).toISOString();
const DAYS = { 12: 'Monday', 13: 'Tuesday', 14: 'Wednesday', 15: 'Thursday', 16: 'Friday', 17: 'Saturday', 18: 'Sunday' };
const tiles = (now, weekdays) => throwTargets(iso(9, 9), now, { weekdays }).filter(t => t.at === 'arc').map(t => `${t.name} ${t.day.getDate()} w${t.week}`);
const phone = { width: 375, height: 667, top: 60, bottom: 600 };

test('each tile is the next such weekday after tomorrow, this week\'s at the arc\'s right end and the later week\'s at its left', () => {
  const want = {
    12: ['Mon 19 w1', 'Tue 20 w1', 'Wed 14 w0', 'Thu 15 w0', 'Fri 16 w0'],
    13: ['Mon 19 w1', 'Tue 20 w1', 'Wed 21 w1', 'Thu 15 w0', 'Fri 16 w0'],
    14: ['Mon 19 w1', 'Tue 20 w1', 'Wed 21 w1', 'Thu 22 w1', 'Fri 16 w0'],
    15: ['Mon 19 w1', 'Tue 20 w1', 'Wed 21 w1', 'Thu 22 w1', 'Fri 23 w1'],
    16: ['Mon 19 w1', 'Tue 20 w1', 'Wed 21 w1', 'Thu 22 w1', 'Fri 23 w1'],
    17: ['Mon 19 w1', 'Tue 20 w1', 'Wed 21 w1', 'Thu 22 w1', 'Fri 23 w1'],
    18: ['Mon 26 w2', 'Tue 20 w1', 'Wed 21 w1', 'Thu 22 w1', 'Fri 23 w1'],
  };
  for (const [d, days] of Object.entries(want)) assert.deepEqual(tiles(on(+d)), days, DAYS[d]);
  for (const d of [12, 14, 17, 18]) assert.deepEqual(tiles(on(d), 'next-week'), ['Mon 19 w1', 'Tue 20 w1', 'Wed 21 w1', 'Thu 22 w1', 'Fri 23 w1'], 'always next week\'s, ' + DAYS[d]);
  assert.equal(THROW.weekdays, 'after-tomorrow', 'the rule the app uses');
});

test('the arc has a gap where the week changes, and a label over each week; one label when they\'re all one week', () => {
  const lay = now => throwLayout(throwTargets(iso(9, 9), now), { x: 187, y: 300, ...phone });
  const step = (l, a, b) => { const x = id => l.targets.find(t => t.id === id).x; return x(b) - x(a); };
  const mon = lay(on(12));
  assert.deepEqual(mon.weeks.map(w => w.text), ['next week', 'this week']);
  assert.equal(step(mon, 'mon', 'tue'), THROW.arc.w + THROW.arc.gap);
  assert.equal(step(mon, 'tue', 'wed'), THROW.arc.w + THROW.arc.gap + THROW.arc.week, 'the gap where the week changes');
  assert.ok(mon.weeks[0].x < mon.weeks[1].x, 'next week over the left, this week over the right');
  const wed = lay(on(14));
  assert.deepEqual(wed.weeks.map(w => w.text), ['next week', 'this week']);
  assert.ok(step(wed, 'thu', 'fri') > step(wed, 'wed', 'thu'), 'Wednesday: only Friday is this week\'s');
  assert.deepEqual(lay(on(16)).weeks.map(w => w.text), ['next week'], 'Friday: all next week, one label');
  assert.deepEqual(lay(on(18)).weeks.map(w => w.text), ['week after next', 'next week'], 'Sunday: Monday\'s is the week after next');
  assert.ok(lay(on(12)).targets.filter(t => t.at === 'arc').every((t, i, a) => !i || t.x > a[i - 1].x), 'Monday always at the left');
});

test('Today is dimmed where it would change nothing; the time of day is kept, and today a time gone is the next whole hour', () => {
  const now = on(12, 14, 20), by = (due, id) => throwTargets(due, now).find(t => t.id === id);
  assert.equal(by(iso(12, 16), 'today').dim, true, 'due later today: Today dimmed, still there');
  assert.equal(by(iso(12, 16), 'tomorrow').dim, false);
  assert.equal(by(iso(12, 16), 'tomorrow').due, iso(13, 16), 'tomorrow at 4 PM');
  assert.equal(by(iso(12, 9), 'today').dim, false, 'due this morning, gone: Today moves it on');
  assert.equal(by(iso(12, 9), 'today').due, iso(12, 15), 'to the next whole hour');
  assert.equal(by(iso(9, 9), 'thu').due, iso(15, 9), 'overdue since Friday: Thursday at 9 AM');
  assert.equal(by(iso(14, 0), 'wed').dim, true, 'due Wednesday: Wednesday\'s tile dimmed');
  assert.equal(by(iso(12, 0), 'today').dim, true, 'due today, no time: Today dimmed');
  assert.equal(by('0001-01-01T00:00:00Z', 'today').due, iso(12, 0), 'no date: today, with no time');
  assert.equal(by('0001-01-01T00:00:00Z', 'none').dim, true, 'no date: No date dimmed');
  assert.equal(by(iso(12, 16), 'none').due, '0001-01-01T00:00:00Z', 'No date takes it off');
  assert.equal(by(iso(12, 16), 'fri').date, 'Fri 16');
});

test('sideways is Today and Tomorrow, up the tiles, the middle keeps it, and down only a long pull is No date', () => {
  const lay = throwLayout(throwTargets(iso(12, 16), on(12)), { x: 187, y: 300, ...phone }), pick = (dx, dy) => throwPick(lay, dx, dy)?.id ?? null;
  assert.equal(pick(10, -12), null, 'the middle');
  assert.equal(pick(-40, 0), 'today');
  assert.equal(pick(40, 8), 'tomorrow');
  assert.equal(pick(0, -40), 'wed', 'straight up: the middle tile');
  assert.equal(pick(-30, -40), 'tue');
  assert.equal(pick(30, -20), 'fri', 'up and to the right, short of the arc: by its direction');
  const mon = lay.targets.find(t => t.id === 'mon');
  assert.equal(pick(mon.x, mon.y), 'mon', 'over a tile: that tile');
  assert.equal(pick(0, 60), null, 'a short pull down does nothing');
  assert.equal(pick(50, 120), null, 'down and to the side, still short');
  assert.equal(lay.reach, THROW.down.y - THROW.down.h / 2, 'room enough: the whole long pull');
  assert.equal(pick(0, lay.reach + 2), 'none', 'the long pull: No date');
  assert.ok(lay.reach >= 2 * THROW.side.x - THROW.down.h, 'about twice the ring\'s radius');
  assert.equal(throwFlick(lay, 16, -2, 1)?.id, 'tomorrow', 'a quick flick from the middle counts');
  assert.equal(throwFlick(lay, 16, -2, .1), null, 'a slow one doesn\'t');
  assert.equal(throwFlick(lay, 0, 20, 2), null, 'a flick down is never No date');
});

test('the ring fits a 375px screen and shifts onto it near an edge, clear of the header and the add box', () => {
  const ts = throwTargets(iso(12, 16), on(12));
  for (const width of [375, 390]) for (const x of [12, 187, 360]) for (const y of [70, 300, 590]) {
    const lay = throwLayout(ts, { x, y, ...phone, width }), boxes = lay.targets.map(t => [lay.x + t.x - t.w / 2, lay.x + t.x + t.w / 2, lay.y + t.y - t.h / 2, lay.y + t.y + t.h / 2]);
    const where = `${width}px, held at ${x},${y}`;
    assert.ok(boxes.every(([l, r]) => l >= THROW.margin && r <= width - THROW.margin), 'on the screen sideways, ' + where);
    assert.ok(lay.weeks.every(w => lay.y + w.y - THROW.arc.label >= phone.top), 'the labels below the header, ' + where);
    assert.ok(boxes.every(([, , t, b]) => t >= phone.top + THROW.margin && b <= phone.bottom - THROW.margin), 'between the header and the add box, ' + where);
  }
  assert.equal(throwLayout(ts, { x: 187, y: 300, ...phone }).y, 300, 'room enough: around the finger');
  const low = throwLayout(ts, { x: 187, y: 590, ...phone });
  assert.ok(low.reach < THROW.down.y - THROW.down.h / 2 && low.reach >= THROW.down.min - THROW.down.h / 2, 'held low: No date nearer, as far as the finger can go');
});

test('what a screen reader hears once a task is thrown', () => {
  const ts = throwTargets(iso(12, 16), new Date()), by = id => ts.find(t => t.id === id);
  assert.equal(thrownText('Order the cups', by('tomorrow')), 'Moved “Order the cups” to tomorrow');
  assert.equal(thrownText('Order the cups', by('none')), 'Took the date off “Order the cups”');
  assert.match(thrownText('Order the cups', by('fri')), /^Moved “Order the cups” to Fri \d+$/);
});
