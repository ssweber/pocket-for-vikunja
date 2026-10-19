// How quick add reads dates (src/js/quickadd.js), with the page's chrono, in a region that writes the month first and
// in one that writes the day first. tests/parse.mjs holds the other phrases. The clock is Monday 19 October 2026.
import './browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { parseCapture } from '../../src/js/quickadd.js';

globalThis.chrono = await import(
  '../../pocket/app/' + readdirSync(new URL('../../pocket/app/', import.meta.url)).find(f => /^chrono-.*\.js$/.test(f))
);
// A second copy of quick add, loaded while the phone's region writes the day first (DAY_FIRST).
const Format = Intl.DateTimeFormat;
Intl.DateTimeFormat = function (locale, opts) {
  return new Format('en-GB', opts);
};
const dayFirst = await import('../../src/js/quickadd.js?day-first');
Intl.DateTimeFormat = Format;

const REGIONS = { 'month first': parseCapture, 'day first': dayFirst.parseCapture },
  HOURS = [5, 10, 14, 21];
// What a line typed at `now` is read as: its title, its due date as "month/day hour:minute", and the text its date
// chip marks.
const read = (parse, text, now) => {
  const p = parse(text, [], { now }),
    d = p.due;
  return {
    title: p.title,
    due: d && `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`,
    marked: p.marks.filter(m => m.kind === 'due').map(m => text.slice(m.start, m.end)),
  };
};
// Each line typed at 5am, 10am, 2pm and 9pm in both regions reads as `want`.
const sameAtEveryHour = (text, want) => {
  for (const [region, parse] of Object.entries(REGIONS))
    for (const h of HOURS)
      assert.deepEqual(read(parse, text, new Date(2026, 9, 19, h)), want, `${text}, typed at ${h}:00, ${region}`);
};

test('the second copy reads numeric dates day first', () => {
  const now = new Date(2026, 9, 19, 10);
  assert.deepEqual(
    [read(parseCapture, 'Call mom 2/11', now).due, read(dayFirst.parseCapture, 'Call mom 2/11', now).due],
    ['2/11 12:00', '11/2 12:00'],
  );
});

test('a month name and a day read the same in both regions', () =>
  sameAtEveryHour('Call mom Oct 24', { title: 'Call mom', due: '10/24 12:00', marked: ['Oct 24'] }));
