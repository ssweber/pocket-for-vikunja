/* A template's goal: how many of its checklists should be finished a day, on which weekdays. It is a line in the
   template's description, "pocket:goal mon-fri 4 since 2026-11-23", `since` being the day the goal was last set. The
   times the template's checklists were finished give the week's score, which its row and Copy goals show, and its
   streak. Days are local, as in dates.js. */
import { markLines, templateName, withLine } from './checklists.js';
import { addDays, doneWeek, fmtTime, isSet, startOfDay } from './dates.js';
import { parseFragment } from './html.js';
import { GOAL } from './messages.js';

// The weekdays as the line writes them. A goal's `days` are indexes into this list, so Monday is 0.
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
// The most checklists a day the sheet's stepper sets, so its count fits in two digits.
export const GOAL_MAX = 14;
const weekday = d => (d.getDay() + 6) % 7;
const two = n => String(n).padStart(2, '0');
// A day as `since` writes it, "2026-11-23". Two of them compare as strings in the order of their days.
export const dayKey = d => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;

// Any goal line, readable or not, so that writing a goal replaces a line Pocket couldn't read.
const GOAL_LINE = /^pocket:goal(\s|$)/i,
  GOAL_PARTS = /^pocket:goal\s+(\S+)\s+(\d+)\s+since\s+(\d{4})-(\d\d)-(\d\d)$/i;
// "mon-wed,fri" as [0, 1, 2, 4], or null when a part isn't a day or a run of days from Monday towards Sunday.
function readDays(text) {
  const days = new Set();
  for (const part of text.toLowerCase().split(',')) {
    const [a, b = a, ...more] = part.split('-').map(w => WEEKDAYS.indexOf(w));
    if (more.length || a < 0 || b < a) return null;
    for (let i = a; i <= b; i++) days.add(i);
  }
  return [...days].sort((x, y) => x - y);
}
// Sorted days as runs of days in a row: [0, 1, 2, 4] is "mon-wed,fri", and [5, 6] is "sat-sun".
function writeDays(days) {
  const runs = [];
  for (const d of days) {
    const last = runs.at(-1);
    if (last?.[1] === d - 1) last[1] = d;
    else runs.push([d, d]);
  }
  return runs.map(([a, b]) => WEEKDAYS[a] + (b > a ? '-' + WEEKDAYS[b] : '')).join(',');
}
export const goalMark = g => `pocket:goal ${writeDays(g.days)} ${g.count} since ${g.since}`;
// The day a goal counts from: its `since`, or today when `since` is later, as when it was set by a phone whose clock
// or time zone is ahead.
const sinceOf = (goal, now) => (goal.since > dayKey(now) ? dayKey(now) : goal.since);

/* The goal in a description, {days, count, since}, or null for none. A line Pocket can't read counts as no goal: an
   unknown day, a count under 1, a date that doesn't exist, or a missing part. */
export function readGoal(html) {
  const line = markLines(parseFragment(html || ''), GOAL_LINE)[0],
    m = line && GOAL_PARTS.exec(line.nodeValue.trim());
  if (!m) return null;
  const days = readDays(m[1]),
    count = Number(m[2]),
    since = `${m[3]}-${m[4]}-${m[5]}`;
  if (!days || !Number.isSafeInteger(count) || count < 1) return null;
  return dayKey(new Date(+m[3], m[4] - 1, +m[5])) === since ? { days, count, since } : null;
}
/* The description with its goal line set to `goal` ({days, count}), or removed when `goal` is null, has no days, or
   has a count under 1. The line's `since` becomes today, which starts a new streak. A goal that is the same as the one
   already there keeps its `since`, so saving it again doesn't end the streak. */
export function withGoal(html, goal, now = new Date()) {
  const days = [...new Set(goal?.days || [])].filter(d => WEEKDAYS[d]).sort((x, y) => x - y),
    count = goal?.count;
  if (!days.length || !Number.isSafeInteger(count) || count < 1) return withLine(html, GOAL_LINE, null);
  const old = readGoal(html),
    same = old?.count === count && writeDays(old.days) === writeDays(days);
  return withLine(html, GOAL_LINE, goalMark({ days, count, since: same ? sinceOf(old, now) : dayKey(now) }));
}

// How far back Checklists reads finished checklists for the goals: 12 weeks, which is as long as a streak can reach.
export const GOAL_DAYS = 84;
/* The checklists finished from a project's templates in the GOAL_DAYS before `now`, read from each template's copies
   as Vikunja lists them (copiedto), so they need no request of their own. Returns {id: {from, at}}, `from` being the
   template's id and `at` the finish time as Vikunja gives it. A copy counts once it is done and no longer has a
   template's title: a checklist is renamed "Walkabout · Nov 26 · #3" as it starts. A template duplicated in Vikunja's
   web app, or a start that stopped before the rename, keeps "TEMPLATE: …". Vikunja lists copies without labels. */
export function finishedRuns(templates, now = new Date()) {
  const from = addDays(startOfDay(now), -GOAL_DAYS),
    out = {};
  for (const t of templates || [])
    for (const c of t.related_tasks?.copiedto || [])
      if (c.done && isSet(c.done_at) && new Date(c.done_at) >= from && templateName(c.title) === String(c.title || ''))
        out[c.id] = { from: t.id, at: c.done_at };
  return out;
}
/* The finish times in `runs` (finishedRuns) of the checklists from template `from`, or from any template when `from`
   is null, with the checklists in `shown` as this phone has them. So a checklist finished here and not yet in
   Vikunja's list counts, and one reopened here doesn't. */
export function finishTimes(runs, shown = [], from = null) {
  const at = new Map();
  for (const [id, r] of Object.entries(runs || {})) if (from == null || r.from === from) at.set(+id, r.at);
  for (const t of shown) {
    if (from != null && t.related_tasks?.copiedfrom?.[0]?.id !== from) continue;
    if (!t.done) at.delete(t.id);
    else if (isSet(t.done_at)) at.set(t.id, t.done_at);
  }
  return [...at.values()];
}

// Finish times by day (dayKey), each day's in order. A time may be a Date, an ISO string or milliseconds.
function byDay(finished) {
  const out = new Map();
  for (const x of finished || []) {
    const d = isSet(x) && new Date(x);
    if (d && !isNaN(d)) out.set(dayKey(d), [...(out.get(dayKey(d)) || []), d]);
  }
  for (const ds of out.values()) ds.sort((a, b) => a - b);
  return out;
}
// Monday to today. Unlike doneWeek, on a Monday this is just today.
function thisWeek(now) {
  const t0 = startOfDay(now);
  return { from: addDays(t0, -weekday(t0)), to: addDays(t0, 1) };
}

/* The score of a template with `goal`, from the times its checklists were finished (`finished`), for `week` ({from,
   to}, from the start of `from` to the start of `to`). By default the week is Monday to today, so on a Monday the
   score starts again. Only the goal's weekdays are scored, none after today, and none before the goal's `since` day,
   so a goal set on a Thursday doesn't count Monday to Wednesday as missed.

   Returns {goal, days, done, total}. Each of `days` is {day, n, times, today}. `n` counts the checklists finished
   that day, at most the goal's count, and `times` are all of their finish times. The ring shows `done` of `total`,
   the goal's count on each day scored, today included. */
export function weekScore(goal, finished, now = new Date(), week = thisWeek(now)) {
  const by = byDay(finished),
    today = dayKey(now),
    since = sinceOf(goal, now),
    days = [];
  // Days compare by their dayKey, because where clocks go forward at midnight a day starts at 1:00.
  for (let d = startOfDay(week.from); d < week.to && dayKey(d) <= today; d = startOfDay(addDays(d, 1)))
    if (goal.days.includes(weekday(d)) && dayKey(d) >= since) {
      const times = by.get(dayKey(d)) || [];
      days.push({ day: d, n: Math.min(times.length, goal.count), times, today: dayKey(d) === today });
    }
  return { goal, days, done: days.reduce((s, x) => s + x.n, 0), total: goal.count * days.length };
}
// The days a score lists. Today is listed only once a checklist was finished today, so it never reads as a miss.
const listed = score => score.days.filter(x => !x.today || x.times.length);

/* How many of the goal's days in a row the template met its goal: back from yesterday, plus today once today's goal is
   met. Other weekdays neither add to it nor break it. A day on which no checklist from any template in the project was
   finished is a day off, and is skipped the same way. `all` is the finish times of every checklist in the project.
   The streak starts at the goal's `since` day, because Pocket keeps only the current goal. */
export function streakDays(goal, finished, all, now = new Date()) {
  const by = byDay(finished),
    worked = new Set([...byDay(all).keys(), ...by.keys()]),
    met = d => (by.get(dayKey(d))?.length || 0) >= goal.count,
    // Before the first day anything was finished, every day is a day off.
    first = [...worked].sort()[0] ?? '9',
    since = sinceOf(goal, now),
    stop = first > since ? first : since,
    t0 = startOfDay(now);
  let n = 0;
  for (let d = addDays(t0, -1); dayKey(d) >= stop; d = addDays(d, -1)) {
    if (!goal.days.includes(weekday(d)) || !worked.has(dayKey(d))) continue;
    if (!met(d)) break;
    n++;
  }
  return n + (goal.days.includes(weekday(t0)) && dayKey(t0) >= since && met(t0) ? 1 : 0);
}
/* A streak of `n` days as words: "3 days in a row", and from two weeks' worth of the goal's days (10 for Mon–Fri) "2
   weeks in a row". A streak under 3 days isn't shown, so this is ''. */
export function streakText(n, goal) {
  const week = goal.days.length;
  return n < 3 ? '' : n < 2 * week ? GOAL.days(n) : GOAL.weeks(Math.floor(n / week));
}

/* The line under a template's title: "4 a day · Mon 4 · Tue 2 · Wed 3". At 1 a day it names only the days missed,
   "1 a day · none on Tue, Wed", or "1 a day · none missed". A streak of `streak` days follows (streakText). A week
   with no goal day yet, as a Wednesday for a weekend goal, has only the goal and the streak. */
export function scoreLine(score, streak = 0) {
  const { goal, days } = score,
    missed = days.filter(x => !x.today && !x.n).map(x => GOAL.day(x.day));
  const parts = !days.length
    ? []
    : goal.count > 1
      ? listed(score).map(x => GOAL.day(x.day) + ' ' + x.n)
      : [missed.length ? GOAL.noneOn(missed) : GOAL.noneMissed];
  return [GOAL.perDay(goal.count), ...parts, streakText(streak, goal)].filter(Boolean).join(' · ');
}

/* Copy goals' text for a project. It covers the days Copy week does (doneWeek), so on a Monday it is last week.
   `templates` are {title, goal, finished}, and those without a goal are left out. `all` is the finish times of every
   checklist in the project (streakDays). Each goal day lists the times its checklists were finished, so checklists
   finished close together are plain to see. For example:
     Checklists this week · Mon, Nov 23 – Wed, Nov 25

     Walkabout · 9 of 12 finished · 4 a day · 3 days in a row
       Mon 9:10 AM, 11:30 AM, 1:05 PM, 3:40 PM
       Tue 9:15 AM, 9:20 AM, 2:00 PM, 4:10 PM
       Wed 10:00 AM */
export function goalsText(templates, all, now = new Date()) {
  const week = doneWeek(now);
  return [
    GOAL.head(week.last, week.from, addDays(week.to, -1)),
    ...templates
      .filter(t => t.goal)
      .flatMap(t => {
        const score = weekScore(t.goal, t.finished, now, week),
          streak = streakText(streakDays(t.goal, t.finished, all, now), t.goal);
        // A goal set after the week it covers has nothing to say for it.
        if (!score.days.length) return [];
        return [
          '',
          [t.title, GOAL.finished(score.done, score.total), GOAL.perDay(t.goal.count), streak]
            .filter(Boolean)
            .join(' · '),
          ...listed(score).map(
            x => '  ' + GOAL.day(x.day) + ' ' + (x.times.length ? x.times.map(fmtTime).join(', ') : GOAL.none),
          ),
        ];
      }),
  ].join('\n');
}
