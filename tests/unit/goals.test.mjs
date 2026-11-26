// A template's goal (src/js/goals.js): its line in the description, the week's score, the streak, and their text.
import './browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notesOnly } from '../../src/js/checklists.js';
import { fmtTime } from '../../src/js/dates.js';
import {
  finishedRuns,
  finishTimes,
  GOAL_DAYS,
  goalMark,
  goalsText,
  readGoal,
  scoreLine,
  streakDays,
  streakText,
  weekScore,
  withGoal,
} from '../../src/js/goals.js';

const DAY = 86400000;
// A local time in November 2026. The 23rd is a Monday, and the tests' today is Thursday the 26th.
const at = (day, h = 9, m = 0) => new Date(2026, 10, day, h, m);
const clock = (t, now = at(26, 15)) => t.mock.timers.enable({ apis: ['Date'], now });
const MON_FRI = [0, 1, 2, 3, 4];
const goal = (count, days = MON_FRI, since = '2026-11-01') => ({ days, count, since });
// One finish at 9 AM on each of `days`.
const on = (...days) => days.map(d => at(d));
const times = (...ds) => ds.map(fmtTime).join(', ');

test('a goal is read from its line, and written with its days as runs of days in a row', () => {
  assert.deepEqual(readGoal('<p>Walk the floor</p><p>pocket:goal mon-fri 4 since 2026-11-23</p>'), {
    days: MON_FRI,
    count: 4,
    since: '2026-11-23',
  });
  assert.deepEqual(readGoal('<p>POCKET:GOAL Mon,Wed,FRI 1 Since 2026-11-23</p>'), goal(1, [0, 2, 4], '2026-11-23'));
  assert.deepEqual(readGoal('<p>pocket:goal mon-wed,tue-thu 2 since 2026-11-23</p>').days, [0, 1, 2, 3]);
  for (const [days, text] of [
    [MON_FRI, 'mon-fri'],
    [[0, 2, 4], 'mon,wed,fri'],
    [[5, 6], 'sat-sun'],
    [[0, 1, 2, 3, 4, 5, 6], 'mon-sun'],
    [[0, 1, 2, 4], 'mon-wed,fri'],
    [[0, 6], 'mon,sun'],
    [[3], 'thu'],
  ]) {
    const line = goalMark(goal(2, days, '2026-11-23'));
    assert.equal(line, `pocket:goal ${text} 2 since 2026-11-23`);
    assert.deepEqual(readGoal(`<p>${line}</p>`), goal(2, days, '2026-11-23'), 'it reads back the same');
  }
});

test('a goal line Pocket cannot read counts as no goal', () => {
  for (const line of [
    'pocket:goal',
    'pocket:goal mon-fri',
    'pocket:goal mon-fri 4',
    'pocket:goal mon-fri 4 since',
    'pocket:goal mon-fri 0 since 2026-11-23',
    'pocket:goal mon-fri 2.5 since 2026-11-23',
    'pocket:goal mon-fri four since 2026-11-23',
    'pocket:goal mon-fri 99999999999999999999 since 2026-11-23',
    'pocket:goal fri-mon 4 since 2026-11-23',
    'pocket:goal mon-fry 4 since 2026-11-23',
    'pocket:goal mon,,fri 4 since 2026-11-23',
    'pocket:goal mon-wed-fri 4 since 2026-11-23',
    'pocket:goal monday 4 since 2026-11-23',
    'pocket:goal mon-fri 4 since 2026-02-30',
    'pocket:goal mon-fri 4 since 23/11/2026',
    'pocket:goal mon-fri 4 since 2026-11-23 and more',
  ])
    assert.equal(readGoal(`<p>Notes</p><p>${line}</p>`), null, line);
  assert.equal(readGoal(''), null);
  assert.equal(readGoal(null), null);
  assert.equal(readGoal(undefined), null);
});

test('setting a goal writes its line with today as since, and the same goal again keeps its since', t => {
  clock(t);
  const html = withGoal('<p>Walk the floor</p><p>pocket:wait</p>', { days: MON_FRI, count: 4 });
  assert.equal(html, '<p>Walk the floor</p><p>pocket:wait</p><p>pocket:goal mon-fri 4 since 2026-11-26</p>');
  t.mock.timers.tick(2 * DAY);
  assert.equal(withGoal(html, { days: [4, 3, 2, 1, 0, 0], count: 4 }), html, 'saving it again keeps the streak');
  assert.equal(
    withGoal(html, { days: MON_FRI, count: 3 }),
    '<p>Walk the floor</p><p>pocket:wait</p><p>pocket:goal mon-fri 3 since 2026-11-28</p>',
    'a new count starts a new streak',
  );
  assert.equal(
    withGoal(html, { days: [0, 2, 4], count: 4 }),
    '<p>Walk the floor</p><p>pocket:wait</p><p>pocket:goal mon,wed,fri 4 since 2026-11-28</p>',
  );
  assert.equal(
    withGoal('<p>pocket:goal someday</p>', { days: [6], count: 1 }),
    '<p>pocket:goal sun 1 since 2026-11-28</p>',
    'a line Pocket could not read is replaced',
  );
});

test('removing a goal removes its line, and a checklist never copies it', t => {
  clock(t);
  const html = withGoal('<p>Walk the floor</p>', { days: MON_FRI, count: 4 });
  for (const off of [null, { days: [], count: 4 }, { days: MON_FRI, count: 0 }])
    assert.equal(withGoal(html, off), '<p>Walk the floor</p>', JSON.stringify(off));
  assert.equal(notesOnly(html), '<p>Walk the floor</p>', 'starting a checklist copies the notes alone');
});

test("the week's score counts each goal day up to today, at most the goal's count", t => {
  clock(t);
  const finished = [
    ...[9, 11, 13, 15, 16].map(h => at(23, h)), // five on Monday, which counts as four
    at(24, 9),
    at(24, 10),
    at(25, 9),
    at(25, 10),
    at(25, 11),
    at(22, 9), // last Sunday
    at(21, 9), // a Saturday, not a goal day
  ];
  const score = weekScore(goal(4), finished);
  assert.deepEqual(
    score.days.map(x => [x.day.getDate(), x.n, x.times.length, x.today]),
    [
      [23, 4, 5, false],
      [24, 2, 2, false],
      [25, 3, 3, false],
      [26, 0, 0, true],
    ],
    'Friday is not scored yet',
  );
  assert.equal(score.done, 9);
  assert.equal(score.total, 16, 'four a day for Monday to today');
  assert.equal(scoreLine(score), '4 a day · Mon 4 · Tue 2 · Wed 3', 'today is listed once a checklist is finished');
  assert.equal(scoreLine(weekScore(goal(4), [...finished, at(26, 9)])), '4 a day · Mon 4 · Tue 2 · Wed 3 · Thu 1');
  const sometimes = weekScore(goal(4, [0, 2, 4]), finished);
  assert.deepEqual([sometimes.done, sometimes.total], [7, 8], 'only the goal days count');
  assert.equal(scoreLine(sometimes), '4 a day · Mon 4 · Wed 3');
  assert.equal(weekScore(goal(4), ['0001-01-01T00:00:00Z', 'not a date', null]).done, 0);
});

test('at 1 a day the line names only the days missed, and never today before it is over', t => {
  clock(t);
  const line = (...days) => scoreLine(weekScore(goal(1), on(...days)));
  assert.equal(line(23, 24, 25), '1 a day · none missed');
  assert.equal(line(23, 24, 25, 26), '1 a day · none missed');
  assert.equal(line(23, 24), '1 a day · none on Wed');
  assert.equal(line(23), '1 a day · none on Tue, Wed');
  assert.equal(line(), '1 a day · none on Mon, Tue, Wed');
  assert.equal(scoreLine(weekScore(goal(1), on(23, 24, 25)), 3), '1 a day · none missed · 3 days in a row');
});

test("a goal set during the week isn't scored before its since day", t => {
  clock(t);
  const score = weekScore(goal(1, MON_FRI, '2026-11-25'), on(25));
  assert.deepEqual([score.days.length, score.done, score.total], [2, 1, 2]);
  assert.equal(scoreLine(score), '1 a day · none missed');
});

test('on a Monday the score is for this week, so it starts empty', t => {
  clock(t, at(30, 8));
  const score = weekScore(goal(4), on(23, 24, 25, 26, 27));
  assert.deepEqual([score.days.length, score.done, score.total], [1, 0, 4]);
  assert.equal(scoreLine(score), '4 a day');
  assert.equal(scoreLine(weekScore(goal(1), on(23))), '1 a day · none missed');
});

test('a week with no goal day yet shows only the goal and its streak', t => {
  clock(t);
  const weekend = goal(1, [5, 6]),
    score = weekScore(weekend, on(21, 22));
  assert.deepEqual([score.days.length, score.total], [0, 0]);
  assert.equal(scoreLine(score), '1 a day');
  assert.equal(scoreLine(score, 3), '1 a day · 3 days in a row');
});

test('a streak runs back from yesterday over the goal days, and today adds to it once met', t => {
  clock(t);
  const days = on(16, 17, 18, 19, 20, 23, 24, 25);
  assert.equal(streakDays(goal(1), days, days), 8, 'the weekend between neither adds nor breaks it');
  assert.equal(streakDays(goal(1), [...days, at(26)], days), 9, "today's goal is met");
  assert.equal(streakDays(goal(1), [...days, at(21), at(22)], days), 8, 'a checklist on a Saturday adds nothing');
  assert.equal(streakDays(goal(1), on(16, 17, 18, 19, 20, 23, 25), days), 1, 'a missed Tuesday breaks it');
  assert.equal(streakDays(goal(1), [], []), 0);
});

test('a day on which no checklist in the project was finished is a day off', t => {
  clock(t);
  const days = on(19, 20, 23, 24);
  assert.equal(streakDays(goal(1), days, days), 4, 'Wednesday is skipped');
  assert.equal(streakDays(goal(1), days, [...days, at(25)]), 0, 'another template finished one on Wednesday');
});

test("a streak starts at the goal's since day", t => {
  clock(t);
  const days = on(16, 17, 18, 19, 20, 23, 24, 25);
  assert.equal(streakDays(goal(1, MON_FRI, '2026-11-23'), days, days), 3);
  assert.equal(streakDays(goal(1, MON_FRI, '2026-11-24'), days, days), 2);
  assert.equal(streakDays(goal(1, MON_FRI, '2026-11-26'), [...days, at(26)], days), 1, 'a goal set today');
  assert.equal(
    streakDays(goal(1, MON_FRI, '2026-11-27'), [...days, at(26)], days),
    1,
    'a goal dated tomorrow counts from today',
  );
});

test("a day meets the goal only with the goal's count finished", t => {
  clock(t);
  const four = d => [9, 10, 11, 12].map(h => at(d, h));
  const done = [...four(23), at(23, 13), at(23, 14), ...four(24), ...four(25).slice(1)];
  assert.equal(streakDays(goal(4), done, done), 0, 'three on Wednesday');
  assert.equal(streakDays(goal(4), [...done, at(25, 15)], done), 3);
  assert.equal(streakDays(goal(3), done, done), 3);
});

test('a streak shows from 3 days, and in weeks from two weeks of goal days', t => {
  clock(t);
  for (const [n, days, text] of [
    [2, MON_FRI, ''],
    [3, MON_FRI, '3 days in a row'],
    [9, MON_FRI, '9 days in a row'],
    [10, MON_FRI, '2 weeks in a row'],
    [14, MON_FRI, '2 weeks in a row'],
    [15, MON_FRI, '3 weeks in a row'],
    [5, [0, 2, 4], '5 days in a row'],
    [6, [0, 2, 4], '2 weeks in a row'],
    [13, [0, 1, 2, 3, 4, 5, 6], '13 days in a row'],
    [14, [0, 1, 2, 3, 4, 5, 6], '2 weeks in a row'],
  ])
    assert.equal(streakText(n, goal(1, days)), text, `${n} of ${days}`);
  const days = on(12, 13, 16, 17, 18, 19, 20, 23, 24, 25);
  assert.equal(streakText(streakDays(goal(1), days, days), goal(1)), '2 weeks in a row');
});

test('Copy goals lists each goal with its score, its streak, and the times on each goal day', t => {
  clock(t);
  const walk = [
      ...[
        [9, 10],
        [11, 30],
        [13, 5],
        [15, 40],
        [16, 0],
      ].map(([h, m]) => at(23, h, m)),
      at(24, 9, 15),
      at(24, 9, 20),
      at(26, 10),
    ],
    open = [...on(16, 17, 18, 19, 20), ...[23, 24, 25].map(d => at(d, 6, 2))],
    templates = [
      { title: 'Walkabout', goal: goal(4), finished: walk },
      { title: 'Deep clean', goal: null, finished: on(25) },
      { title: 'Opening up', goal: goal(1), finished: open },
    ],
    all = [...walk, ...open, at(25)];
  assert.equal(
    goalsText(templates, all),
    [
      'Checklists this week · Mon, Nov 23 – Thu, Nov 26',
      '',
      'Walkabout · 7 of 16 finished · 4 a day',
      '  Mon ' + times(...walk.slice(0, 5)),
      '  Tue ' + times(at(24, 9, 15), at(24, 9, 20)),
      '  Wed none',
      '  Thu ' + times(at(26, 10)),
      '',
      'Opening up · 3 of 4 finished · 1 a day · 8 days in a row',
      '  Mon ' + times(at(23, 6, 2)),
      '  Tue ' + times(at(24, 6, 2)),
      '  Wed ' + times(at(25, 6, 2)),
    ].join('\n'),
  );
});

// Nothing was finished on Wednesday, so the streak skips it as a day off, while the list still shows it.
test('Copy goals copies last week on a Monday, without a goal set since', t => {
  clock(t, at(30, 8));
  const done = on(23, 24, 26, 27);
  assert.equal(
    goalsText(
      [
        { title: 'Opening up', goal: goal(1), finished: done },
        { title: 'Walkabout', goal: goal(4, MON_FRI, '2026-11-30'), finished: [] },
      ],
      done,
    ),
    [
      'Checklists last week · Mon, Nov 23 – Sun, Nov 29',
      '',
      'Opening up · 4 of 5 finished · 1 a day · 4 days in a row',
      '  Mon ' + times(at(23)),
      '  Tue ' + times(at(24)),
      '  Wed none',
      '  Thu ' + times(at(26)),
      '  Fri ' + times(at(27)),
    ].join('\n'),
  );
});

// A copy of a template as Vikunja lists it in the template's copiedto.
// Vikunja lists copies without their labels.
const copy = (id, done_at, more = {}) => ({
  id,
  title: 'Walkabout · Nov 23 · #1',
  done: true,
  done_at: done_at.toISOString(),
  labels: null,
  ...more,
});

test("the goals are scored from each template's copies: finished checklists only, not a duplicate made in the web app", t => {
  clock(t);
  const runs = finishedRuns([
    {
      id: 1,
      related_tasks: {
        copiedto: [
          copy(10, at(23)),
          copy(11, at(24), { title: 'Walkabout · Saturday' }),
          copy(12, at(25), { done: false }),
          copy(13, at(25), { done_at: '0001-01-01T00:00:00Z' }),
          copy(14, at(25), { title: 'TEMPLATE: Walkabout' }), // duplicated in Vikunja's web app, or a start that stopped
        ],
      },
    },
    { id: 2, related_tasks: { copiedto: [copy(20, at(26, 8))] } },
    { id: 3, related_tasks: {} },
  ]);
  assert.deepEqual(runs, {
    10: { from: 1, at: at(23).toISOString() },
    11: { from: 1, at: at(24).toISOString() },
    20: { from: 2, at: at(26, 8).toISOString() },
  });
  assert.deepEqual(finishTimes(runs, [], 1), [at(23).toISOString(), at(24).toISOString()]);
  assert.deepEqual(finishTimes(runs).length, 3, "`all` holds every template's checklists");
});

test('the goals read back 12 weeks, from the start of the day', t => {
  clock(t);
  const from = new Date(2026, 10, 26 - GOAL_DAYS);
  const runs = finishedRuns([
    { id: 1, related_tasks: { copiedto: [copy(10, from), copy(11, new Date(+from - 1)), copy(12, at(26, 8))] } },
  ]);
  assert.deepEqual(Object.keys(runs), ['10', '12']);
  assert.equal(GOAL_DAYS, 84);
});

test("a checklist finished on this phone counts before Vikunja's list has it, and one reopened here doesn't", t => {
  clock(t);
  const runs = finishedRuns([{ id: 1, related_tasks: { copiedto: [copy(10, at(23)), copy(11, at(24))] } }]),
    from = id => ({ copiedfrom: [{ id }] });
  const shown = [
    { id: 11, done: false, related_tasks: from(1) }, // reopened here
    { id: 12, done: true, done_at: at(26, 8).toISOString(), related_tasks: from(1) }, // finished here, not sent yet
    { id: 13, done: true, done_at: at(26, 9).toISOString(), related_tasks: from(2) }, // from another template
    { id: 14, done: false, related_tasks: from(1) }, // still in progress
  ];
  assert.deepEqual(finishTimes(runs, shown, 1), [at(23).toISOString(), at(26, 8).toISOString()]);
  assert.deepEqual(finishTimes(runs, shown), [at(23).toISOString(), at(26, 8).toISOString(), at(26, 9).toISOString()]);
});

test('a day whose midnight is skipped by daylight saving still counts, and so does every day after it', t => {
  const was = process.env.TZ;
  process.env.TZ = 'Africa/Cairo'; // Egypt's clocks went forward at midnight on Fri, Apr 24, 2026
  t.after(() => (process.env.TZ = was === undefined ? '' : was));
  const now = new Date(2026, 3, 25, 15); // Saturday
  t.mock.timers.enable({ apis: ['Date'], now });
  const score = weekScore(goal(1, [0, 1, 2, 3, 4, 5, 6], '2026-04-01'), [new Date(2026, 3, 25, 9)]);
  assert.deepEqual([score.days.length, score.done, score.days.at(-1).today], [6, 1, true]);
});

test('saving the same goal again moves a since dated tomorrow back to today', t => {
  clock(t);
  const html = withGoal('<p>pocket:goal mon-fri 4 since 2026-11-27</p>', { days: MON_FRI, count: 4 });
  assert.equal(readGoal(html).since, '2026-11-26');
  assert.equal(weekScore(readGoal('<p>pocket:goal mon-fri 4 since 2026-11-27</p>')).total, 4, 'scored from today');
});
