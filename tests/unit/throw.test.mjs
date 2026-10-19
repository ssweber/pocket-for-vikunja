// Holding a task on Today shows four date chips around the user's touch (src/js/throw.js). The tests cover what each
// direction means on each day of the week, which date a drag points at, and where the chips sit on a phone.
import './browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dateValue,
  THROW,
  throwDate,
  throwEnd,
  throwFlick,
  throwLayout,
  throwPick,
  throwTargets,
} from '../../src/js/throw.js';

// October 2026. The 12th is a Monday and the 18th is a Sunday, and the tests use dates in the weeks before and after.
const on = (d, h = 10, m = 0) => new Date(2026, 9, d, h, m);
const iso = (d, h = 0, m = 0) => on(d, h, m).toISOString();
const ZERO = '0001-01-01T00:00:00Z';
const DAYS = {
  12: 'Monday',
  13: 'Tuesday',
  14: 'Wednesday',
  15: 'Thursday',
  16: 'Friday',
  17: 'Saturday',
  18: 'Sunday',
};
// A small phone, 360px wide. The chips fit between the bottom of the header and the top of the add box.
const phone = { width: 360, height: 640, top: 56, bottom: 572 };
const box = (lay, t) => [lay.x + t.x - t.w / 2, lay.x + t.x + t.w / 2, lay.y + t.y - t.h / 2, lay.y + t.y + t.h / 2];

test('left is Today, right is Tomorrow, up is next Monday and down is No date, on each day of the week', () => {
  assert.deepEqual(
    THROW.targets.map(t => [t.at, t.name]),
    [
      ['left', 'Today'],
      ['right', 'Tomorrow'],
      ['up', 'Next week'],
      ['down', 'No date'],
    ],
    'one list defines which target is in which direction',
  );
  const want = {
    12: ['Mon 12', 'Tue 13', 'Mon 19'],
    13: ['Tue 13', 'Wed 14', 'Mon 19'],
    14: ['Wed 14', 'Thu 15', 'Mon 19'],
    15: ['Thu 15', 'Fri 16', 'Mon 19'],
    16: ['Fri 16', 'Sat 17', 'Mon 19'],
    17: ['Sat 17', 'Sun 18', 'Mon 19'],
    18: ['Sun 18', 'Mon 19', 'Mon 19'],
  };
  for (const [d, dates] of Object.entries(want)) {
    const ts = throwTargets(iso(9, 9), on(+d)),
      at = w => ts.find(t => t.at === w);
    assert.deepEqual([at('left').date, at('right').date, at('up').date], dates, DAYS[d]);
    assert.deepEqual(
      [at('down').day, at('down').date, at('down').due],
      [null, '', ZERO],
      'down removes the date, ' + DAYS[d],
    );
  }
  const sun = throwTargets(iso(9, 9), on(18));
  assert.equal(
    sun.find(t => t.id === 'week').due,
    sun.find(t => t.id === 'tomorrow').due,
    'on a Sunday, up and right both show Monday and mean the same day',
  );
  assert.equal(
    throwTargets(iso(9, 9), on(12, 23, 30)).find(t => t.id === 'week').date,
    'Mon 19',
    'on a late Monday, up is next Monday and never today',
  );
});

test('a date that would change nothing is dimmed, the time of day is kept, and a time already past today becomes no time', () => {
  const now = on(12, 14, 20),
    by = (due, id, at = now) => throwTargets(due, at).find(t => t.id === id);
  assert.equal(by(iso(12, 16), 'today').dim, true, 'for a task due later today, Today is dimmed but still shown');
  assert.equal(by(iso(12, 16), 'tomorrow').dim, false);
  assert.equal(by(iso(12, 16), 'tomorrow').due, iso(13, 16), 'tomorrow at 4 PM');
  assert.equal(
    by(iso(12, 9), 'today').dim,
    false,
    'for a task due this morning that has passed, Today is not dimmed and moves it on',
  );
  assert.equal(by(iso(12, 9), 'today').due, iso(12, 0), 'the task is due today with no time');
  assert.equal(by(iso(9, 9), 'week').due, iso(19, 9), 'a task overdue since Friday moves to next Monday at 9 AM');
  assert.equal(by(iso(19, 0), 'week').dim, true, 'for a task due next Monday, Next week is dimmed');
  assert.equal(by(iso(12, 0), 'today').dim, true, 'for a task due today with no time, Today is dimmed');
  assert.equal(by(iso(12, 0), 'tomorrow').due, iso(13, 0), 'a task with no time moves to tomorrow with still no time');
  assert.equal(by(ZERO, 'today').due, iso(12, 0), 'a task with no date moves to today with no time');
  assert.equal(by(ZERO, 'none').dim, true, 'for a task with no date, No date is dimmed');
  assert.deepEqual(
    [by(iso(12, 16), 'none').due, by(iso(12, 16), 'none').dim],
    [ZERO, false],
    'No date removes the date',
  );
  assert.deepEqual(
    ['today', 'tomorrow', 'week', 'none'].map(id => by(iso(12, 16), id).label),
    ['Today', 'Tomorrow', 'Mon 19', null],
    'each label is the one shown once the task has moved there',
  );
  assert.deepEqual(
    ['tomorrow', 'week'].map(id => by(iso(19, 9), id, on(18)).dim),
    [true, true],
    'on a Sunday, for a task due on the Monday, both are dimmed',
  );
});

test('a drag past 24px highlights the date in that direction, and a flick counts by its direction', () => {
  const ts = throwTargets(iso(12, 16), on(12)),
    pick = (dx, dy, lit) => throwPick(ts, dx, dy, lit)?.id ?? null;
  assert.equal(THROW.out, 24);
  assert.deepEqual(
    [pick(10, -12), pick(23, 0), pick(0, 23)],
    [null, null, null],
    'a drag near where the hold started highlights nothing',
  );
  assert.deepEqual(
    [pick(-24, 0), pick(24, 0), pick(0, -24), pick(0, 24)],
    ['today', 'tomorrow', 'week', 'none'],
    'the same short drag works in each direction',
  );
  assert.deepEqual(
    [pick(-30, 20), pick(30, -20), pick(20, -30), pick(-20, 30)],
    ['today', 'tomorrow', 'week', 'none'],
    'a drag between two directions picks the nearer one',
  );
  assert.equal(pick(30, 30), 'tomorrow', 'a drag equally far sideways and down picks sideways');
  assert.equal(pick(300, -40), 'tomorrow', 'however far the drag, it picks by direction and not by where a chip is');
  assert.deepEqual(
    [pick(20, 0, true), pick(15, 0, true), pick(20, 0, false)],
    ['tomorrow', null, null],
    'a highlighted date stays highlighted a little nearer in, so a touch at the edge does not flicker',
  );
  assert.equal(throwFlick(ts, 14, -2, 1)?.id, 'tomorrow', 'a quick flick released short of 24px counts');
  assert.equal(throwFlick(ts, 0, 14, 1)?.id, 'none', 'a quick flick down counts too');
  assert.equal(throwFlick(ts, 14, -2, 0.1), null, 'a slow move released there does not count');
  assert.equal(throwFlick(ts, 6, 0, 2), null, 'a twitch does not count');
  // The targets list decides which date goes in which direction. This swaps Next week and No date to show it.
  const swapped = throwTargets(
    iso(12, 16),
    on(12),
    THROW.targets.map(t => ({ ...t, at: { up: 'down', down: 'up' }[t.at] || t.at })),
  );
  assert.deepEqual(
    [throwPick(swapped, 0, -30).id, throwPick(swapped, 0, 30).id, throwPick(swapped, 30, 0).id],
    ['none', 'week', 'tomorrow'],
  );
});

test('the chips sit around the touch, each in its direction and at least 56px each way, with the middle clear', () => {
  const ts = throwTargets(iso(12, 16), on(12)),
    lay = throwLayout(ts, { x: 180, y: 300, ...phone }),
    by = id => lay.targets.find(t => t.id === id);
  assert.deepEqual([lay.x, lay.y], [180, 300], 'with enough space, the chips sit around the touch');
  assert.ok(
    lay.targets.every(t => t.w >= 56 && t.h >= 56),
    'every chip is large enough to tap with gloves on',
  );
  assert.ok(
    lay.mid.w >= 56 && lay.mid.h >= 56,
    'the middle is also large enough, because Pick a date… is tapped there',
  );
  assert.ok(
    by('today').x < 0 && by('today').y === 0 && by('tomorrow').x > 0 && by('tomorrow').y === 0,
    'Today is on the left and Tomorrow on the right',
  );
  assert.ok(
    by('week').y < 0 && by('week').x === 0 && by('none').y > 0 && by('none').x === 0,
    'Next week is above and No date below',
  );
  const boxes = [
    ...lay.targets.map(t => box(lay, t)),
    [lay.x - lay.mid.w / 2, lay.x + lay.mid.w / 2, lay.y - lay.mid.h / 2, lay.y + lay.mid.h / 2],
  ];
  const apart = ([l, r, t, b], [l2, r2, t2, b2]) => r <= l2 || r2 <= l || b <= t2 || b2 <= t;
  assert.ok(
    boxes.every((a, i) => boxes.every((b, k) => i === k || apart(a, b))),
    'no chip overlaps another chip or the middle',
  );
  assert.equal(lay.why, null, 'a task that can move has no line explaining why it cannot');
});

test('the chips stay on the screen for a row at the top and at the bottom, by moving the whole set and never a single chip', () => {
  const ts = throwTargets(iso(12, 16), on(12)),
    mid = throwLayout(ts, { x: 180, y: 300, ...phone });
  for (const width of [360, 375, 390, 430])
    for (const x of [10, width / 2, width - 10])
      for (const y of [phone.top + 28, 300, phone.bottom - 28])
        for (const why of [false, true]) {
          const lay = throwLayout(ts, { x, y, ...phone, width, why }),
            boxes = lay.targets.map(t => box(lay, t)),
            where = `${width}px, held at ${x},${y}${why ? ', with its line' : ''}`;
          assert.ok(
            boxes.every(([l, r]) => l >= THROW.margin && r <= width - THROW.margin),
            'the chips fit across the screen, ' + where,
          );
          assert.ok(
            boxes.every(([, , t, b]) => t >= phone.top + THROW.margin && b <= phone.bottom - THROW.margin),
            'the chips fit between the header and the add box, ' + where,
          );
          assert.deepEqual(
            lay.targets.map(t => [t.id, t.x, t.y]),
            mid.targets.map(t => [t.id, t.x, t.y]),
            'each chip keeps its position within the set, ' + where,
          );
          if (!why) continue;
          assert.ok(
            lay.y + lay.why.y <= Math.min(...boxes.map(b => b[2])) &&
              lay.y + lay.why.y - THROW.why >= phone.top + THROW.margin,
            'the explanation line is above the top chip and below the header, ' + where,
          );
          assert.deepEqual(
            [lay.x + lay.why.x, lay.why.w],
            [width / 2, width - 2 * THROW.margin],
            'the explanation line spans the screen, ' + where,
          );
        }
  const top = throwLayout(ts, { x: 180, y: phone.top + 28, ...phone }),
    low = throwLayout(ts, { x: 180, y: phone.bottom - 28, ...phone });
  assert.ok(
    top.y > phone.top + 28 && low.y < phone.bottom - 28,
    'the set moves down for the first row and up for the last row',
  );
  assert.ok(
    throwLayout(ts, { x: 350, y: 300, ...phone }).x < 350 && throwLayout(ts, { x: 10, y: 300, ...phone }).x > 10,
    'the set moves inwards near a side',
  );
  // throwPick ignores where the chips are. Directions are measured from the point where the user started holding.
  assert.equal(throwPick(ts, 30, 0).id, 'tomorrow');
  const squeezed = throwLayout(ts, { x: 180, y: 100, ...phone, bottom: phone.top + 120 });
  assert.ok(
    Math.min(...squeezed.targets.map(t => box(squeezed, t)[2])) >= phone.top + THROW.margin,
    'with too little space, such as when the keyboard is open, the chips still clear the header',
  );
});

test('releasing with a date highlighted moves the task, releasing back near the start does nothing, and releasing without moving leaves the dates open', () => {
  const ts = throwTargets(iso(12, 16), on(12)),
    by = id => ts.find(t => t.id === id),
    end = o => {
      const e = throwEnd(o);
      return [e.then, e.to?.id ?? null];
    };
  assert.deepEqual(end({ commit: true, on: by('tomorrow'), out: true }), ['move', 'tomorrow']);
  assert.deepEqual(
    end({ commit: true, flick: by('none') }),
    ['move', 'none'],
    'a flick moves the task even before any date was highlighted',
  );
  assert.deepEqual(
    end({ commit: true, out: true }),
    ['close', null],
    'after dragging out and back near the start, the chips close and nothing changes',
  );
  assert.deepEqual(end({ commit: true }), ['open', null], 'without dragging out, the chips stay open');
  assert.deepEqual(
    [end({ commit: true, on: by('today'), out: true }), end({ commit: true, flick: by('today') })],
    [
      ['close', null],
      ['close', null],
    ],
    'pointing or flicking at a dimmed date does nothing',
  );
  assert.deepEqual(
    end({ commit: true, on: by('tomorrow'), out: true, why: 'repeats' }),
    ['close', null],
    'a task that cannot move does nothing',
  );
  assert.deepEqual(
    end({ commit: true, why: 'repeats' }),
    ['open', null],
    'holding a task that cannot move without dragging leaves the dimmed dates open, so the user can read why',
  );
  assert.deepEqual(
    [end({ commit: false, on: by('tomorrow'), out: true }), end({ commit: false })],
    [
      ['close', null],
      ['close', null],
    ],
    'when the phone cancels the touch, nothing changes and nothing stays open',
  );
});

test("a day picked in the phone's date picker keeps the task's time of day and is labelled by its day, and the current day is dimmed", () => {
  const now = on(12, 14, 20),
    day = (d, m = 9) =>
      new Date(2026, m, d).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const pick = (due, value) => {
    const p = throwDate(due, value, now);
    return p && [p.due, p.label, p.dim];
  };
  assert.deepEqual(pick(iso(12, 16), '2026-10-22'), [iso(22, 16), day(22), false], 'the 22nd at 4 PM');
  assert.deepEqual(
    pick(iso(12, 0), '2026-11-03'),
    [new Date(2026, 10, 3).toISOString(), day(3, 10), false],
    'a task with no time keeps no time',
  );
  assert.deepEqual(
    pick(ZERO, '2026-10-22'),
    [iso(22, 0), day(22), false],
    'a task with no date gets that day with no time',
  );
  assert.deepEqual(
    pick(iso(12, 16), '2026-10-13'),
    [iso(13, 16), 'Tomorrow', false],
    'tomorrow is labelled "Tomorrow"',
  );
  assert.deepEqual(
    pick(iso(9, 9), '2026-10-12'),
    [iso(12, 0), 'Today', false],
    'today with its time already past becomes today with no time',
  );
  assert.deepEqual(pick(iso(22, 16), '2026-10-22'), [iso(22, 16), day(22), true], "the task's current day is dimmed");
  assert.equal(
    throwDate(iso(12, 16), '2027-01-04', now).label,
    new Date(2027, 0, 4).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }),
    'a date in another year shows the year',
  );
  assert.deepEqual(
    [pick(iso(12, 16), '2026-10-11'), pick(iso(12, 16), ''), pick(iso(12, 16), 'soon')],
    [null, null, null],
    'a past day, an empty value or an invalid value picks nothing',
  );
  assert.deepEqual(
    [dateValue(iso(22, 16), now), dateValue(ZERO, now), dateValue(null, now)],
    ['2026-10-22', '2026-10-12', '2026-10-12'],
    "the picker starts on the task's day, or on today",
  );
});
