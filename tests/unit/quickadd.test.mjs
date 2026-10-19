// How quick add reads dates and parts of the day (src/js/quickadd.js), with the page's chrono, in a region that writes
// the month first and in one that writes the day first, and what a @user, *label or +project leaves in the title.
// tests/parse.mjs holds the other phrases. The clock is Monday 19 October 2026.
import './browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { parseCapture, removeAssignees } from '../../src/js/quickadd.js';

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

test('"this" with a part of the day is today at that time, even once the time has passed', () => {
  for (const [phrase, time] of [
    ['this morning', '9:00'],
    ['this afternoon', '15:00'],
    ['this evening', '18:00'],
    ['tonight', '20:00'],
  ])
    sameAtEveryHour('Call mom ' + phrase, { title: 'Call mom', due: '10/19 ' + time, marked: [phrase] });
});

test('"tomorrow" with a part of the day is tomorrow at that time', () => {
  for (const [part, time] of [
    ['morning', '9:00'],
    ['afternoon', '15:00'],
    ['evening', '18:00'],
    ['night', '20:00'],
  ])
    sameAtEveryHour('Call mom tomorrow ' + part, {
      title: 'Call mom',
      due: '10/20 ' + time,
      marked: ['tomorrow ' + part],
    });
});

test('a bare hour after an evening or a night is PM, and one written with am stays AM', () => {
  for (const [phrase, due] of [
    ['tonight at 10', '10/19 22:00'],
    ['this evening at 9', '10/19 21:00'],
    ['tomorrow evening at 10', '10/20 22:00'],
    ['tomorrow night at 11', '10/20 23:00'],
    ['tonight at 10:30', '10/19 22:30'],
    ['tonight at 10am', '10/19 10:00'],
  ])
    sameAtEveryHour('Call mom ' + phrase, { title: 'Call mom', due, marked: [phrase] });
  sameAtEveryHour('Call mom tomorrow morning at 10', {
    title: 'Call mom',
    due: '10/20 10:00',
    marked: ['tomorrow morning at 10'],
  });
});

test('a bare hour after a morning is read as written', () => {
  for (const [phrase, due] of [
    ['tomorrow morning at 6', '10/20 6:00'],
    ['this morning at 5', '10/19 5:00'],
    ['tomorrow morning at 7pm', '10/20 19:00'],
  ])
    sameAtEveryHour('Call mom ' + phrase, { title: 'Call mom', due, marked: [phrase] });
});

test('after tonight or a night, 12 and midnight end that day, and a bare 1 to 4 is in the small hours after it', () => {
  for (const [phrase, due] of [
    ['tonight at 12', '10/20 0:00'],
    ['tonight at midnight', '10/20 0:00'],
    ['tonight at 12:30', '10/20 0:30'],
    ['tonight at 1', '10/20 1:00'],
    ['tonight at 4', '10/20 4:00'],
    ['tonight at 5', '10/19 17:00'],
    ['tomorrow night at 2', '10/21 2:00'],
    ['tonight at 12pm', '10/19 12:00'],
  ])
    sameAtEveryHour('Call mom ' + phrase, { title: 'Call mom', due, marked: [phrase] });
  sameAtEveryHour('Call mom at midnight', { title: 'Call mom', due: '10/20 0:00', marked: ['at midnight'] });
});

test('a part of the day with no day sets nothing, and stays in the title', () => {
  for (const part of ['morning', 'afternoon', 'evening', 'night'])
    sameAtEveryHour('Call mom ' + part, { title: 'Call mom ' + part, due: null, marked: [] });
  sameAtEveryHour('Call mom  morning', { title: 'Call mom morning', due: null, marked: [] });
});

test('a weekday or a date with a part of the day is that day at that time', () => {
  sameAtEveryHour('Call mom friday evening', { title: 'Call mom', due: '10/23 18:00', marked: ['friday evening'] });
  sameAtEveryHour('Call mom Oct 24 morning', { title: 'Call mom', due: '10/24 9:00', marked: ['Oct 24 morning'] });
  sameAtEveryHour('Call mom on the 24th afternoon', {
    title: 'Call mom',
    due: '10/24 15:00',
    marked: ['on the 24th afternoon'],
  });
  sameAtEveryHour('Call mom tomorrow evening at 7', {
    title: 'Call mom',
    due: '10/20 19:00',
    marked: ['tomorrow evening at 7'],
  });
});

test('a part of the day after a repeat sets the time it repeats at, and leaves the title with it', () => {
  for (const [phrase, due] of [
    ['every tuesday evening', '10/20 18:00'],
    ['every tuesday night', '10/20 20:00'],
    ['every friday afternoon', '10/23 15:00'],
    ['every tuesday evening at 9', '10/20 21:00'],
  ])
    sameAtEveryHour('Call mom ' + phrase, { title: 'Call mom', due, marked: phrase.endsWith('9') ? ['at 9'] : [] });
  for (const [region, parse] of Object.entries(REGIONS))
    for (const h of HOURS) {
      const p = parse('Call mom every monday evening', [], { now: new Date(2026, 9, 19, h) });
      assert.deepEqual(
        [p.repeat.label, p.marks.map(m => m.kind + ':' + 'Call mom every monday evening'.slice(m.start, m.end))],
        ['Every Monday', ['repeat:every monday evening']],
        `typed at ${h}:00, ${region}`,
      );
    }
});

test("a weekly repeat on today's weekday starts today, or next week once its time has passed", () => {
  for (const [text, hour] of [
    ['Gym every monday morning at 6', 6],
    ['Call mom every monday evening', 18],
    ['Team sync every monday at 10', 10],
  ])
    for (const [region, parse] of Object.entries(REGIONS))
      for (const h of HOURS) {
        const now = new Date(2026, 9, 19, h),
          day = new Date(2026, 9, 19, hour) < now ? 26 : 19;
        assert.deepEqual(read(parse, text, now).due, `10/${day} ${hour}:00`, `${text}, typed at ${h}:00, ${region}`);
      }
});

test("a day after a repeat's part of the day keeps the part's time", () =>
  sameAtEveryHour('Water plants every day evening tomorrow', {
    title: 'Water plants',
    due: '10/20 18:00',
    marked: ['tomorrow'],
  }));

test('a repeat with a part of the day and no day starts at the next time of that part', () => {
  for (const [phrase, label] of [
    ['every day morning', 'Every day'],
    ['every 2 days evening', 'Every 2 days'],
  ])
    for (const [region, parse] of Object.entries(REGIONS))
      for (const h of HOURS) {
        const text = 'Water plants ' + phrase,
          p = parse(text, [], { now: new Date(2026, 9, 19, h) }),
          at = phrase.endsWith('morning') ? 9 : 18;
        assert.deepEqual(
          [p.title, p.repeat.label, p.due.getDate(), p.due.getHours(), p.dueFromRepeat, p.timeRead, p.marks.length],
          ['Water plants', label, h < at ? 19 : 20, at, true, true, 1],
          `${text}, typed at ${h}:00, ${region}`,
        );
      }
});

test('with dates tapped off, a part of the day after a repeat stays in the title', () => {
  const p = parseCapture('Call mom every monday evening', [], {
    now: new Date(2026, 9, 19, 10),
    ignore: { due: true },
  });
  assert.deepEqual([p.title, p.repeat.label, p.due], ['Call mom evening', 'Every Monday', null]);
});

// What a line's task is called once it is added, by a user whose @people can all see the project: the add op removes
// each @username left in the title (prepare, ops/add.js).
const PROJECTS = [{ id: 1, title: 'home' }];
const added = (text, opts = {}) => {
  const p = parseCapture(text, PROJECTS, { now: new Date(2026, 9, 19, 10), ...opts });
  return {
    title: removeAssignees(p.title, '@', p.assignees, p.mid),
    assignees: p.assignees,
    labels: p.labels,
    project: p.project?.title ?? p.projectMiss,
  };
};

test('a @user, *label or +project in the middle of the title leaves its word there, and one at the end is removed', () => {
  for (const [text, title, assignees, labels, project] of [
    ['Ask @bob about the invoice', 'Ask bob about the invoice', ['bob'], [], null],
    ['Fix the *urgent leak in the sink', 'Fix the urgent leak in the sink', [], ['urgent'], null],
    ['Pack for the +home move', 'Pack for the home move', [], [], 'home'],
    ['Call the plumber @bob *home', 'Call the plumber', ['bob'], ['home'], null],
    ['@bob call the plumber', 'call the plumber', ['bob'], [], null],
  ])
    assert.deepEqual(added(text), { title, assignees, labels, project }, text);
});

test('a @user, *label or +project is removed at the start or the end, and before a date at the end', () => {
  for (const [sign, read] of [
    ['@', p => p.assignees],
    ['*', p => p.labels],
    ['+', p => [p.project]],
  ])
    for (const [text, title] of [
      [`Fix the ${sign}home leak`, 'Fix the home leak'],
      [`${sign}home fix the leak`, 'fix the leak'],
      [`Fix the leak ${sign}home`, 'Fix the leak'],
      [`Fix the leak ${sign}home tomorrow`, 'Fix the leak'],
      [`Fix the leak ${sign}home !2 50%`, 'Fix the leak'],
    ]) {
      const p = added(text);
      assert.deepEqual([p.title, read(p)], [title, ['home']], text);
    }
});

test('a quoted label or project in the middle of the title leaves its words without the quotes', () => {
  assert.equal(added('Fix the *"burst pipe" leak').title, 'Fix the burst pipe leak');
  assert.equal(added("Pack for the +'home' move").title, 'Pack for the home move');
  assert.equal(added('Ask @"bob" about it').title, 'Ask bob about it');
});

test('a word whose chip is tapped off stays as typed, and still counts as one at the end for the others', () => {
  assert.equal(added('Fix the *urgent leak', { ignore: { labels: true } }).title, 'Fix the *urgent leak');
  assert.equal(added('Call the plumber @bob *home', { ignore: { labels: true } }).title, 'Call the plumber *home');
  assert.equal(added('Call the plumber *home @bob', { ignore: { assignees: true } }).title, 'Call the plumber @bob');
});

test('a date, repeat, priority or percentage counts at the end with its chip tapped off', () => {
  for (const [text, ignore, title] of [
    ['Call the plumber @bob tomorrow', { due: true }, 'Call the plumber tomorrow'],
    ['Fix the leak *home by friday evening', { due: true }, 'Fix the leak by friday evening'],
    ['Water the plants +home every day', { repeat: true }, 'Water the plants every day'],
    ['Water the plants @bob every day evening', { due: true }, 'Water the plants evening'],
    ['Call the plumber @bob !2', { priority: true }, 'Call the plumber !2'],
    ['Paint the fence *home 50%', { progress: true }, 'Paint the fence 50%'],
  ])
    assert.equal(added(text, { ignore }).title, title, text);
});

test('with people tapped off, a @user keeps its @ in the middle and still counts at the end', () => {
  assert.equal(added('Ask @bob *now about it', { ignore: { assignees: true } }).title, 'Ask @bob now about it');
  assert.equal(
    added('Call the plumber @bob *home tomorrow', { ignore: { assignees: true, due: true } }).title,
    'Call the plumber @bob tomorrow',
  );
});

test('a @user in the middle of the title keeps its @ until it is assigned, and only the @ goes then', () => {
  const p = parseCapture('Ask @nobody about it @bob then @bob again', PROJECTS, { now: new Date(2026, 9, 19, 10) });
  assert.deepEqual([p.title, p.mid], ['Ask @nobody about it @bob then @bob again', [4, 21, 31]]);
  assert.equal(removeAssignees(p.title, '@', [], p.mid), p.title, 'nobody is assigned');
  assert.equal(removeAssignees(p.title, '@', ['bob'], p.mid), 'Ask @nobody about it bob then bob again');
  const q = parseCapture('Ask @bob about it @bob', PROJECTS);
  assert.equal(removeAssignees(q.title, '@', ['BOB'], q.mid), 'Ask bob about it', 'the same name at the end goes');
});

test('two words removed side by side keep their order, even when a date was cut from around the second', () =>
  assert.equal(added('Do on *a tomorrow *b morning stuff').title, 'Do a b stuff'));

test('the mark on a word in the middle of the title says what it leaves there', () => {
  const text = 'Ask @bob to fix the *"burst pipe" *now at +home first tomorrow *later',
    p = parseCapture(text, PROJECTS, { now: new Date(2026, 9, 19, 10) });
  assert.deepEqual(
    [p.title, p.marks.map(m => [text.slice(m.start, m.end), m.kept])],
    [
      'Ask @bob to fix the burst pipe now at home first',
      [
        ['@bob', undefined],
        ['*"burst pipe" *now', 'burst pipe now'],
        ['+home', 'home'],
        ['tomorrow', undefined],
        ['*later', undefined],
      ],
    ],
  );
});
