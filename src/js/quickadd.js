/* Quick add: reads a typed line the way Vikunja's Quick Add Magic does (default mode,
   https://vikunja.io/help/quick-add-magic/), so the same text makes the same task in both apps. It also reads a
   pasted list into lines. tests/parse.mjs holds the phrases, adapted from Vikunja's own tests. Where Pocket
   deliberately differs from Vikunja, the test says so. */
import { dueInfo, fmtTime } from './dates.js';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAY_RE = `${WEEKDAYS.join('|')}|${WEEKDAYS.map(w => w.slice(0, 3)).join('|')}`;
const weekdayIndex = w => WEEKDAYS.findIndex(d => d.startsWith(w.toLowerCase().slice(0, 3)));
export const NUMBER_WORDS = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};
const LEAD_IN = /\b(in|by|on|before|until)\s+$/i; // a word just before a date that goes with it
const DROP_LEAD = /(?:\b(?:in|by|on|before|until)\s+)?(?:\bthe\s+)?$/i; // the lead-in and a "the", removed along with the date
const END = '(?=\\s|$|[,.!?;:])'; // a phrase has to end at a word boundary
// Ambiguous numeric dates follow the phone's region. 10/12 is October 12 in the US and 10 December in most other
// places.
const DAY_FIRST = (() => {
  try {
    return (
      new Intl.DateTimeFormat().formatToParts(new Date(2000, 11, 31)).find(p => p.type !== 'literal')?.type === 'day'
    );
  } catch {
    return false;
  }
})();
export const projectName = typed => typed.replace(/[_-]/g, ' ').trim();
function tokenRe(prefix, flags = 'g') {
  return new RegExp(`(^|\\s)\\${prefix}(?:"([^"]+)"|'([^']+)'|(\\S+))`, flags);
}
/* Remove the @usernames of `names`, quoted or not, from a title once those users are assigned, as Vikunja does. One
   in the middle of the title, whose sign is at an index in `mid` (parseCapture), keeps its word without the sign. */
export function removeAssignees(title, prefix, names, mid = []) {
  const gone = new Set(names.map(n => n.toLowerCase()));
  return title
    .replace(tokenRe(prefix), (all, sp, a, b, c, at) =>
      !gone.has((a ?? b ?? c).toLowerCase()) ? all : mid.includes(at + sp.length) ? sp + (a ?? b ?? c) : sp,
    )
    .replace(/\s{2,}/g, ' ')
    .trim();
}
// The user's default due time setting, or noon when it isn't set. Vikunja's web app reads only "HH:MM", with hours to
// 23 and minutes to 59, and atTime would move "25:99" to the next day.
export const dueTimeOf = v => (/^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : '12:00');
// Set a date's time from "HH:MM". The default is Vikunja's default due time setting, which is noon unless the user
// changed it.
export function atTime(d, hhmm = '12:00') {
  const [h, m] = String(hhmm).split(':').map(Number);
  d.setHours(h || 0, m || 0, 0, 0);
  return d;
}
const dayFrom = (now, n) => {
  const d = new Date(now);
  d.setDate(d.getDate() + n);
  d.setHours(0, 0, 0, 0);
  return d;
};
const laterThisWeek = now => ([5, 6, 0].includes(now.getDay()) ? 0 : 2); // from Friday to Sunday it is today, otherwise in two days
// The time each part of the day sets. Only Pocket reads them, and only with a day or a repeat: "friday evening" is
// Friday at 6 PM.
const PARTS = { morning: '09:00', afternoon: '15:00', evening: '18:00', night: '20:00' },
  PART_RE = Object.keys(PARTS).join('|'),
  PART_AFTER = new RegExp(`^\\s+(${PART_RE})${END}`, 'i');
/* Day phrases, with Vikunja's meanings. Longer phrases come first ("later next week" before "next week"). "this" before
   a part of the day is today, even once that time has passed, and the part sets the time (dropDay). */
const DAY_WORDS = [
  ['later\\s+next\\s+week', now => dayFrom(now, laterThisWeek(now) + 7)],
  ['later\\s+this\\s+week', now => dayFrom(now, laterThisWeek(now))],
  ['next\\s+week', now => dayFrom(now, 7)],
  ['this\\s+weekend', now => dayFrom(now, (6 - now.getDay()) % 6)],
  ['next\\s+month', now => new Date(now.getFullYear(), now.getMonth() + 1, 1)],
  ['(?:the\\s+)?end\\s+of\\s+(?:the\\s+)?month', now => new Date(now.getFullYear(), now.getMonth() + 1, 0)],
  [`this(?=\\s+(?:${PART_RE})${END})`, now => dayFrom(now, 0)],
  ['tonight', now => dayFrom(now, 0), PARTS.night],
  ['today', now => dayFrom(now, 0)],
  ['tomorrow', now => dayFrom(now, 1)],
].map(([src, day, time]) => ({ re: new RegExp(`(^|\\s)(?:${src})${END}`, 'i'), day, time }));
// A time or a part of the day after a date at the end of the text: "meeting 9/11 at 10:00". Numeric dates and a bare "17th" only count at
// the start or the end of the text, so "The 9/11 Report" and "13th floor" stay as they are. A checklist step's hidden
// T#20m after the date doesn't stop the date counting as the last word.
const TIME_TAIL = `(?:\\s+(?:at\\s+\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?|(?:${PART_RE})))?(?:\\s+[\\uE000-\\uF8FF]+)*\\s*$`;
// Read "2021-07-06", "6/7/21", "27/1" or "01.02" as a date, or null. Without a year, the date is the next time it
// occurs.
function numericDate(token, now) {
  let y, m, d, a, b, x;
  if ((x = token.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/))) [y, m, d] = [+x[1], +x[2], +x[3]];
  else if ((x = token.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/))) {
    [a, b, y] = [+x[1], +x[2], x[3] && +x[3]];
    [m, d] = a > 12 ? [b, a] : b > 12 ? [a, b] : DAY_FIRST ? [b, a] : [a, b];
  } else if ((x = token.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{2}|\d{4}))?$/))) [d, m, y] = [+x[1], +x[2], x[3] && +x[3]];
  else return null;
  if (y && y < 100) y += 2000;
  const make = yr => {
    const t = new Date(yr, m - 1, d);
    return t.getMonth() === m - 1 && t.getDate() === d ? t : null;
  };
  if (y) return make(y);
  const t = make(now.getFullYear());
  return t && t < dayFrom(now, 0) ? make(now.getFullYear() + 1) : t;
}
// Read "17th" as this month's 17th if it hasn't passed, otherwise the 17th of the next month that has that day.
function ordinalDate(day, now) {
  for (let i = 0; i < 13; i++) {
    const t = new Date(now.getFullYear(), now.getMonth() + i, day);
    if (t.getDate() === day && t >= dayFrom(now, 0)) return t;
  }
  return null;
}
// The prefixes of each Quick Add Magic mode, which is a user setting. "disabled" turns parsing off.
export const QUICK_ADD_PREFIXES = {
  vikunja: { project: '+', label: '*', assignee: '@' },
  todoist: { project: '#', label: '@', assignee: '+' },
};
/* A percentage at the end of a line, "(50%)" or "50%", is the task's own progress, from 1 to 100 (100 is done). Only
   Pocket reads it. Vikunja's quick add has no syntax for progress, so Pocket reads it in every mode.

   It is read after the other phrases are removed, so "Tables 50% tomorrow *hire" has a progress of 50. Only
   assignees may follow it (`tail`, a pattern for " @sam @jo"), because they stay in the title until assigned. "50%"
   alone is a title. Returns {start, end, pct} in `title`, or null. */
function endFigure(title, tail = '') {
  const m = title.match(new RegExp(`\\s(?:\\((\\d{1,3})%\\)|(\\d{1,3})%)(?=${tail}\\s*$)`)),
    pct = m ? +(m[1] ?? m[2]) : 0;
  return pct >= 1 && pct <= 100 && title.slice(0, m.index).trim()
    ? { start: m.index + 1, end: m.index + m[0].length, pct }
    : null;
}
/* Returns {title, project, projectMiss, labels, assignees, mid, priority, due, dueLabel, dueFromRepeat, repeat, pct,
   marks}. `mid` is the index in `title` of the sign of each @username in the middle of it (removeAssignees). `pct` is
   the task's own progress, read from a percentage at the end, and 0 for none. `marks` are the phrases that were read,
   as [{start, end, kind, name, kept}] positions in `text`, one per phrase. `kind` is one of the `ignore` keys, `name`
   is the user for @username, and `kept` is the text a label or project in the middle of the title leaves there.

   `opts`: mode ("vikunja", "todoist" or "disabled"), ignore (kinds the user tapped off, whose text stays in the
   title: project, labels, assignees, priority, repeat, due, progress), now, dueTime ("HH:MM"). */
export function parseCapture(
  text,
  projects,
  { mode = 'vikunja', ignore = {}, now = new Date(), dueTime = '12:00' } = {},
) {
  const out = {
    title: text,
    project: null,
    projectMiss: null,
    labels: [],
    assignees: [],
    mid: [],
    priority: 0,
    due: null,
    dueLabel: '',
    dueFromRepeat: false,
    repeat: null,
    repeatWarn: '',
    pct: 0,
    marks: [],
  };
  const P = QUICK_ADD_PREFIXES[mode],
    typed = text;
  if (!P) {
    const f = !ignore.progress && endFigure(text);
    if (f)
      Object.assign(out, {
        pct: f.pct,
        title: (text.slice(0, f.start) + text.slice(f.end)).trim(),
        marks: [{ start: f.start, end: f.end, kind: 'progress' }],
      });
    return out;
  }
  // A checklist step's T#20m, T#40m:roast and {#roast} must not be read as a date, a time or a project. Each is
  // replaced by a run of one private-use character of the same length, and restored at the end.
  const stepTokens = [];
  const hide = tok => String.fromCharCode(0xe000 + stepTokens.push(tok) - 1).repeat(tok.length);
  const unhide = t => t.replace(/([\uE000-\uF8FF])\1*/g, (run, c) => stepTokens[c.charCodeAt(0) - 0xe000] ?? run);
  /* Quotes around the start of the text hold the title as typed, and the text after the quotes is read as usual.
     "Lunch friday" @user 2026-10-16 gives the title "Lunch friday", assigned to @user, due on the 16th. With nothing
     after the quotes, nothing is read, as in Vikunja.

     Reading the text after the quotes is Pocket's own behaviour. Vikunja has no way to stop a word being read, and a
     Markdown copy needs one (share.js). The title ends at the first closing quote that is followed by a space or the
     end. The quoted title is hidden like a step's token, quotes included. */
  const held = text.match(/^(\s*)(["'])([\s\S]*?)\2(?=\s|$)/);
  if (held)
    text =
      held[1] +
      String.fromCharCode(0xe000 + stepTokens.push(held[3].trim()) - 1).repeat(held[3].length + 2) +
      text.slice(held[0].length);
  text = text
    .replace(
      /(^|\s)(T#(?:\d+(?:\.\d+)?(?:ms|d|h|m|s))+(?::[a-z][\w-]*)?)(?=\s|$|["'])/gi,
      (_, sp, tok) => sp + hide(tok),
    )
    .replace(/\{#[a-z][\w-]*\}/gi, hide);
  // Vikunja can't repeat on weekdays only, or on two or more days of the week. Those phrases stay whole in the title,
  // so no part of them is read as anything else ("every monday and thursday" isn't every Monday). A chip shows a
  // warning.
  if (!ignore.repeat)
    text = text.replace(
      new RegExp(
        `(^|\\s)((?:every|each)\\s+(?:week\\s?days?|working\\s+days?|week\\s?ends?|(?:${WEEKDAY_RE})(?:\\s*(?:,|and|&|\\+)\\s*(?:${WEEKDAY_RE}))+))(?=\\s|$|[,.!?;:])`,
        'i',
      ),
      (_, sp, phrase) => {
        out.repeatWarn = phrase;
        return sp + hide(phrase);
      },
    );
  out.title = text;
  // Every change to the title goes through edit(). `from` maps each character of the title to its index in `text`.
  // `read` records what each removed character was read as, so the phrases can be marked where they were typed.
  const from = Array.from({ length: text.length }, (_, i) => i),
    read = new Map();
  const edit = (start, end, insert, kind) => {
    if (kind) for (let i = start; i < end; i++) if (from[i] >= 0) read.set(from[i], kind);
    from.splice(start, end - start, ...Array(insert.length).fill(kind ? -1 : from[start]));
    out.title = out.title.slice(0, start) + insert + out.title.slice(end);
  };
  const cut = (start, end, kind) => edit(start, end, ' ', kind);
  const drop = (m, kind) => edit(m.index + m[1].length, m.index + m[0].length, '', kind); // remove a token and keep the space before it
  const signs = []; // each +project and *label read: {at (its index in `text`), word, kind}
  let m;
  // "@ 3pm" is a time, as in Vikunja. The last match is edited first, so earlier positions stay valid.
  for (const x of [...out.title.matchAll(/(^|\s)@\s+(?=\d)/g)].reverse())
    edit(x.index + x[1].length, x.index + x[0].length, 'at ');

  // project +name: only the first one is read. The start of a name finds a project only when no other project's name
  // starts the same way, so a task never goes to a project by chance.
  if (!ignore.project && (m = out.title.match(tokenRe(P.project, '')))) {
    const typed = unhide(m[2] || m[3] || m[4]),
      name = projectName(typed).toLowerCase(),
      starts = projects.filter(p => p.title.toLowerCase().startsWith(name));
    const hit = projects.find(p => p.title.toLowerCase() === name) || (starts.length === 1 ? starts[0] : null);
    if (hit) out.project = hit;
    else out.projectMiss = typed;
    signs.push({ at: from[m.index + m[1].length], word: m[2] || m[3] || m[4], kind: 'project' });
    drop(m, 'project');
  }
  // labels *name
  if (!ignore.labels) {
    const found = [...out.title.matchAll(tokenRe(P.label))];
    for (const x of found) {
      const l = unhide(x[2] || x[3] || x[4]);
      if (!out.labels.includes(l)) out.labels.push(l);
      signs.push({ at: from[x.index + x[1].length], word: x[2] || x[3] || x[4], kind: 'labels' });
    }
    for (const x of found.reverse()) drop(x, 'labels');
  }
  // @username stays in the title for now. An add op removes each @username that gets assigned (prepare, ops/add.js),
  // as Vikunja does, and takes only the @ off one in the middle of the title (`mid`). A space is needed before the @,
  // so email addresses are left alone.
  const people = [];
  if (!ignore.assignees)
    for (const x of out.title.matchAll(tokenRe(P.assignee))) {
      const u = unhide(x[2] || x[3] || x[4]);
      if (!out.assignees.includes(u)) out.assignees.push(u);
      people.push({
        start: from[x.index + x[1].length],
        end: from[x.index + x[0].length - 1] + 1,
        kind: 'assignees',
        name: u,
      });
    }
  // priority !1..!5: only the first valid one is read
  if (!ignore.priority && (m = out.title.match(/(^|\s)!([1-5])(?=\s|$)/))) {
    out.priority = +m[2];
    drop(m, 'priority');
  }

  // repeat: "every day", "every 3 days", "each two weeks", "every monday", "daily", "biannually", ...
  let repeatDay = null,
    repeatTime = null;
  if (!ignore.repeat) {
    m = out.title.match(
      new RegExp(
        `(^|\\s)(?:every|each)\\s+(?:(\\d+|other|${Object.keys(NUMBER_WORDS).join('|')})\\s+)?(hour|day|week|month|year)s?${END}`,
        'i',
      ),
    );
    let n, unit;
    if (m) {
      n = /^other$/i.test(m[2] || '') ? 2 : NUMBER_WORDS[(m[2] || '').toLowerCase()] || +(m[2] || 1);
      unit = m[3].toLowerCase();
    } else if (
      (m = out.title.match(
        new RegExp(
          `(^|\\s)(hourly|daily|weekly|monthly|yearly|annually|biannually|semiannually|biennially)${END}`,
          'i',
        ),
      ))
    ) {
      [n, unit] = {
        hourly: [1, 'hour'],
        daily: [1, 'day'],
        weekly: [1, 'week'],
        monthly: [1, 'month'],
        yearly: [1, 'year'],
        annually: [1, 'year'],
        biannually: [6, 'month'],
        semiannually: [6, 'month'],
        biennially: [2, 'year'],
      }[m[2].toLowerCase()];
    }
    if (unit) {
      // "every month" uses Vikunja's monthly mode, which repeats on the same day each month. Vikunja's own quick add
      // uses 30 days.
      out.repeat =
        unit === 'month' && n === 1
          ? { after: 0, mode: 1, label: 'Every month' }
          : {
              after: n * { hour: 3600, day: 86400, week: 604800, month: 30 * 86400, year: 365 * 86400 }[unit],
              mode: 0,
              label: n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`,
            };
    } else if ((m = out.title.match(new RegExp(`(^|\\s)(?:every|each)\\s+(${WEEKDAY_RE})${END}`, 'i')))) {
      repeatDay = weekdayIndex(m[2]); // only Pocket reads "every monday"
      out.repeat = {
        after: 604800,
        mode: 0,
        label: 'Every ' + WEEKDAYS[repeatDay][0].toUpperCase() + WEEKDAYS[repeatDay].slice(1),
      };
    }
    if (out.repeat) {
      // A part of the day after a repeat sets its time, as after a day: "every monday evening" is Mondays at 6 PM.
      // It is a due time, so with dates tapped off it stays in the title.
      const p = !ignore.due && out.title.slice(m.index + m[0].length).match(PART_AFTER);
      if (p) repeatTime = PARTS[p[1].toLowerCase()];
      cut(m.index + m[1].length, m.index + m[0].length + (p ? p[0].length : 0), 'repeat');
    }
  }

  // due date. The date is removed from the title along with a word that introduces it: "Call Bob in May" -> "Call Bob".
  if (!ignore.due) {
    const dropDate = (start, end) => cut(start - out.title.slice(0, start).match(DROP_LEAD)[0].length, end, 'due');
    let day = null,
      time = repeatTime,
      m; // day is a date at midnight. time is "HH:MM", or a full date from chrono
    // A part of the day right after a day sets the time, and is removed with the day: "tomorrow morning".
    const dropDay = (start, end) => {
      const p = out.title.slice(end).match(PART_AFTER);
      if (p) time = PARTS[p[1].toLowerCase()];
      dropDate(start, end + (p ? p[0].length : 0));
    };
    for (const w of DAY_WORDS)
      if ((m = out.title.match(w.re))) {
        day = w.day(now);
        time = w.time || time;
        dropDay(m.index + m[1].length, m.index + m[0].length);
        break;
      }
    if (!day && (m = out.title.match(new RegExp(`(^|\\s)(?:(?:next|this|on)\\s+)?(${WEEKDAY_RE})${END}`, 'i')))) {
      day = dayFrom(now, (weekdayIndex(m[2]) - now.getDay() + 7) % 7); // the next one, including today
      dropDay(m.index + m[1].length, m.index + m[0].length);
    }
    if (!day) {
      // numeric date as the first or last word
      for (const re of [/^(\S+)(?=\s|$)/, new RegExp(`(^|\\s)(\\S+)(?=${TIME_TAIL})`)]) {
        if ((m = out.title.match(re))) {
          const token = m[2] ?? m[1],
            start = m.index + (m[2] !== undefined ? m[1].length : 0);
          const t = numericDate(token, now);
          if (t) {
            day = t;
            dropDay(start, start + token.length);
            break;
          }
        }
      }
    }
    // "17th" at the end, or "the 17th" anywhere. Not "sep 17th", which chrono reads.
    const afterMonth = m =>
      /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+$/i.test(
        out.title.slice(0, m.index + m[1].length),
      );
    if (
      !day &&
      (((m = out.title.match(new RegExp(`(^|\\s)(\\d{1,2})(?:st|nd|rd|th)(?=${TIME_TAIL})`, 'i'))) && !afterMonth(m)) ||
        ((m = out.title.match(new RegExp(`(^|\\s)(?:the|on the|on)\\s+(\\d{1,2})(?:st|nd|rd|th)${END}`, 'i'))) &&
          !afterMonth(m)))
    ) {
      const t = ordinalDate(+m[2], now);
      if (t) {
        day = t;
        dropDay(m.index + m[1].length, m.index + m[0].length);
      }
    }
    const weekly = !day && repeatDay !== null;
    if (weekly) day = dayFrom(now, (repeatDay - now.getDay() + 7) % 7); // "every monday at 10"

    if (typeof chrono !== 'undefined') {
      /* chrono-node reads the other dates and times: "Oct 12", "21st June", "in 3 days", "in 2 hours", "at 3pm", ...
         Its English parser serves every region. Numeric dates, the only ones a region changes, are read above, and its
         GB parser reads "Oct 24" as October 2024. */
      const results = chrono.casual.parse(out.title, now, { forwardDate: true }).filter(
        r =>
          out.title[r.index - 1] !== P.assignee && // inside an @username
          !/^for\b/i.test(r.text) && // "for 2 hours" is a duration, not a date
          !/^now$/i.test(r.text) && // "Now what" isn't due this minute
          !new RegExp(`^\\s*(?:${PART_RE})$`, 'i').test(r.text) && // a part of the day sets a time only with a day or a repeat
          !/^\d{1,4}[/.-]\d/.test(r.text) && // numeric dates are read above, at the start or end only
          // A month name on its own ("March madness") is read as a date only after in/by/on/before/until, as in "call Bob
          // in May".
          !(
            /^[a-z]+\.?$/i.test(r.text) &&
            r.start.isCertain('month') &&
            !r.start.isCertain('day') &&
            !LEAD_IN.test(out.title.slice(0, r.index))
          ),
      );
      const timeOnly = r =>
        r.start.isCertain('hour') &&
        !r.start.isCertain('day') &&
        !r.start.isCertain('weekday') &&
        !r.start.isCertain('month');
      /* A bare hour from 1 to 7 is read as afternoon or evening, as people mean it: "at 5" is 5 PM. Vikunja's own quick
         add reads it as 5 AM. After an evening or a night, any bare hour up to 11 is PM: "tonight at 10" is 10 PM.
         After a morning, a bare hour is read as written: "tomorrow morning at 6" is 6 AM. After a night, 12 is
         midnight and 1 to 4 are the small hours after it. "5am", "5pm", "17:00" and "05:00" are read as written. */
      const late = time === PARTS.evening || time === PARTS.night,
        night = time === PARTS.night;
      const daytime = r => {
        const d = r.start.date(),
          h = d.getHours(),
          bare = r.start.isCertain('hour') && !r.start.isCertain('meridiem') && !/(^|\D)0\d/.test(r.text);
        if (bare && night && (h === 12 || h <= 4)) d.setHours(h % 12);
        else if (bare && time !== PARTS.morning && h >= 1 && h <= (late ? 11 : 7)) d.setHours(h + 12);
        return d;
      };
      const dated = !day && results.find(r => !timeOnly(r));
      if (dated) {
        day = daytime(dated);
        // Without a year, chrono assumes noon and reads a date earlier than that as next year's. So today's date typed
        // in the afternoon would become next year's. Pocket keeps today's date as today.
        const thisYear = new Date(day);
        thisYear.setFullYear(now.getFullYear());
        if (
          !dated.start.isCertain('year') &&
          day.getFullYear() > now.getFullYear() &&
          thisYear.toDateString() === now.toDateString()
        )
          day = thisYear;
        if (dated.start.isCertain('hour')) time = day;
        else day.setHours(0, 0, 0, 0);
        // chrono reads "Oct 24 morning" as one phrase, with its own uncertain time for the part.
        const part = !dated.start.isCertain('hour') && dated.text.match(new RegExp(`\\s(${PART_RE})$`, 'i'));
        if (part) time = PARTS[part[1].toLowerCase()];
      }
      const clock = !(time instanceof Date) && results.find(r => r !== dated && timeOnly(r));
      if (clock) {
        if (day) {
          time = daytime(clock);
          // The hours after midnight belong to the night before: "tonight at 1" is 1 AM tomorrow.
          if (night && time.getHours() < 5) day = dayFrom(day, 1);
        } else {
          // a time with no date means its next occurrence
          const t = daytime(clock);
          day = new Date(now);
          day.setHours(t.getHours(), t.getMinutes(), 0, 0);
          if (day <= now) day = new Date(day.getTime() + 864e5);
          time = day;
        }
      }
      // Remove the phrases that were read, the later one first so the earlier position stays valid. chrono leaves the
      // "at" out of "at midnight" and "at noon", though it takes it into "at 5".
      for (const r of [dated, clock].filter(Boolean).sort((a, b) => b.index - a.index)) {
        const at = r === clock ? out.title.slice(0, r.index).match(/(?:^|\s)at\s+$/i) : null;
        dropDate(r.index - (at ? at[0].trimStart().length : 0), r.index + r.text.length);
      }
    }
    if (day) {
      const d = new Date(day);
      if (time instanceof Date) d.setHours(time.getHours(), time.getMinutes(), 0, 0);
      else atTime(d, time || dueTime);
      // "every monday morning" typed on a Monday after 9 AM starts next Monday, as "every day morning" starts tomorrow.
      if (weekly && d < now) d.setDate(d.getDate() + 7);
      out.due = d;
      out.timeRead = !!time;
    }
  }
  // A repeating task needs a date to repeat from. It gets the next default due time, or the next time of its part of
  // the day: "every day morning" typed at 10 AM starts tomorrow at 9 AM.
  if (out.repeat && !out.due && !ignore.due) {
    const at = repeatTime || dueTime,
      d = atTime(dayFrom(now, 0), at);
    out.due = d < now ? atTime(dayFrom(now, 1), at) : d;
    out.dueFromRepeat = true;
    out.timeRead = !!repeatTime;
  }
  if (out.due) out.dueLabel = dueInfo(out.due.toISOString()).label;
  if (out.due && out.timeRead && !/\d:\d\d/.test(out.dueLabel)) out.dueLabel += ' ' + fmtTime(out.due); // for example "Oct 12 3:30 PM"
  // The task's own progress is a percentage at the end of the remaining title, before any @usernames.
  const figure =
    !ignore.progress &&
    endFigure(out.title, ignore.assignees ? '' : `(?:\\s+\\${P.assignee}(?:"[^"]+"|'[^']+'|\\S+))*`);
  if (figure) {
    out.pct = figure.pct;
    cut(figure.start, figure.end, 'progress');
  }
  /* A @user, *label or +project in the middle of the title leaves its word there, without its sign: "Fix the *urgent
     leak" becomes "Fix the urgent leak". One at the start or the end, with only other such words or phrases between it
     and that end, is removed as usual. A @user keeps its sign until it is assigned (`mid`). */
  const bare = s =>
    !Object.values(P)
      .reduce((t, c) => t.replace(tokenRe(c), ' '), s)
      .trim();
  // A phrase counts whether or not it was read, so tapping a chip off, or a box that doesn't read dates, doesn't move
  // the edges: "Call the plumber @user tomorrow" keeps @user at the end with dates tapped off.
  let unread = null;
  const phrases = () =>
    new Set(
      ['due', 'repeat', 'priority', 'progress'].some(k => ignore[k])
        ? parseCapture(typed, projects, { mode, now, dueTime })
            .marks.filter(m => m.kind !== 'project' && m.kind !== 'labels' && m.kind !== 'assignees')
            .flatMap(m => Array.from({ length: m.end - m.start }, (_, i) => m.start + i))
        : [],
    );
  const plain = (s, e) =>
    out.title
      .slice(s, e)
      .split('')
      .map((c, i) => ((unread ??= phrases()).has(from[s + i]) ? ' ' : c))
      .join('');
  // A step's hidden T#20m after a word doesn't stop the word being at the end, as with a date.
  const inside = (s, e) => !bare(plain(0, s)) && !bare(plain(e).replace(/[\uE000-\uF8FF]+/g, ' '));
  const keep = [];
  for (const g of signs) {
    const i = from.findIndex(f => f > g.at),
      at = i < 0 ? out.title.length : i;
    if (inside(at, at)) keep.push({ start: at, word: ` ${g.word} `, g });
  }
  // The @ of a @user in the middle becomes a placeholder until the title is final, to find where it ends up.
  const SIGN = '\uFFFF',
    mid = ignore.assignees
      ? []
      : [...out.title.matchAll(tokenRe(P.assignee))]
          .map(x => [x.index + x[1].length, x.index + x[0].length])
          .filter(([s, e]) => inside(s, e));
  for (const [s] of mid) out.title = out.title.slice(0, s) + SIGN + out.title.slice(s + 1);
  // The later word first, so the earlier positions stay valid. Two words removed side by side can share a position,
  // when a date and its part of the day were cut from around the second one.
  for (const k of keep.sort((a, b) => b.start - a.start || b.g.at - a.g.at))
    out.title = out.title.slice(0, k.start) + k.word + out.title.slice(k.start);

  out.title = unhide(out.title.replace(/\s{2,}/g, ' ').trim());
  for (let i = out.title.indexOf(SIGN); i >= 0; i = out.title.indexOf(SIGN, i + 1)) out.mid.push(i);
  out.title = out.title.replaceAll(SIGN, P.assignee);
  // One mark per phrase. Neighbouring characters read as the same kind are joined, across the spaces between them.
  for (const i of [...read.keys()].sort((a, b) => a - b)) {
    const kind = read.get(i),
      last = out.marks[out.marks.length - 1];
    if (last && last.kind === kind && !text.slice(last.end, i).trim()) last.end = i + 1;
    else out.marks.push({ start: i, end: i + 1, kind });
  }
  out.marks = [...out.marks, ...people].sort((a, b) => a.start - b.start);
  const prefix = { project: P.project, labels: P.label };
  for (const { g } of keep) {
    const k = out.marks.find(x => x.kind === g.kind && x.start <= g.at && g.at < x.end);
    if (k)
      k.kept = unhide(text.slice(k.start, k.end)).replace(
        tokenRe(prefix[g.kind]),
        (_, sp, a, b, c) => sp + (a ?? b ?? c),
      );
  }
  return out;
}
/* Pasted lists: one task per line. Pocket removes what email and notes apps put in front of an item: "> " quote
   marks, bullets, "1." / "1)" numbering and checkboxes. A marker needs a space after it, so "*label" and "+project"
   at the start of a line still work. An empty checkbox, or a ✓ (often just a bullet), marks an open item. */
const QUOTE_MARKS = /^(?:>\s*)+/,
  BULLET = /^(?:[-*•◦▪‣–—+]\s+|\d{1,3}[.)]\s+|\(\d{1,3}\)\s+)/,
  OPEN_BOX = /^(?:\[ ?\]|[☐✓✔])\s*/;
/* A line is marked done by a ticked checkbox after its bullet, "- [x] eggs" or "☑ eggs". Only Pocket also reads an x
   at the very start followed by a space: "x eggs", "x - eggs", "x- eggs". A capital X counts too, because a phone's
   keyboard capitalises the first letter. To keep a title that really starts with an x, such as "X marks the spot",
   the user taps the chip off. Without a space the x is a word: "x-ray the pipe". */
const DONE_BOX = /^(?:\[[xX✓]\]|[☑☒])\s*/,
  DONE_X = /^[xX](?:\s+-|-)?\s+/;
/* A heading, as Markdown notes and a task's Markdown copy write one (share.js). "## Pack the van" is a task, and the
   lines under it, up to the next heading, are its subtasks. A heading with more #s goes under the previous heading
   with fewer #s. A single #, as in "# Café · 12 open · 5 done", names the whole list, as a project's copy starts. It
   is left out of the tasks. */
const HEADING = /^(#{1,6})\s+/;
/* Read a box's text as a list. Returns {lines, ticked, one, first, names}.
   - `lines` has one entry per line that becomes a task, in order: {text (the line without its markers), at (where the
     text starts in the box's text), done, mark ([start, end] of the text that marked the line done), under (the
     index in `lines` of the line it goes under, or null)}.
   - `ticked` counts the lines that are marked done, whether they are kept or not.
   - `one` is true when the box holds a single line.
   - `first` is true when the first line is a parent as written, with lines under it.
   - `names` holds the text of the lines left out as the list's name. A single # line alone in the box is a title as
     typed.

   A line marked done arrives done, in quick add and the subtask boxes. With `done` off (its chip tapped), a single
   line keeps the marker in its title. A list leaves those lines out, and the lines under them go under their parent.

   Nesting is read from the headings and from the indenting, as in Vikunja's web app. A line indented more than the
   line above it goes under that line, to any depth, in spaces or tabs of any width (a tab counts as four spaces).

   In quick add (`colon`), a first line ending with a colon, such as "Groceries:", is the parent of every line with no
   parent, and its colon is removed. This is how a list in a message starts. Quick add's "Under first line" option
   changes that. `nest` makes the first line the parent of every line with no parent. `flat` makes every line its own
   task and keeps the first line's colon.

   `steps` is for a checklist's steps, where a step is done by doing it. A ticked line is left out, an x is part of the
   text, and so is a heading's #. */
export function readList(text, { steps = false, done = true, nest = false, flat = false, colon = false } = {}) {
  const rows = [];
  let at = 0,
    ticked = 0;
  for (const raw of String(text || '').split('\n')) {
    let i = raw.length - raw.trimStart().length;
    const indent = [...raw.slice(0, i)].reduce((n, c) => n + (c === '\t' ? 4 : 1), 0);
    const take = re => {
      const m = raw.slice(i).match(re);
      if (m) i += m[0].length;
      return m;
    };
    take(QUOTE_MARKS);
    const hash = i,
      level = steps ? 0 : take(HEADING)?.[1].length || 0;
    // A list's name is never marked done. The text after its # is the name.
    let from = i,
      said = !steps && level !== 1 && take(DONE_X);
    if (!said && level !== 1) {
      take(BULLET);
      from = i;
      said = take(DONE_BOX);
    }
    if (!said && level !== 1) take(OPEN_BOX);
    if (said) ticked++;
    const start = p => p + raw.slice(p).length - raw.slice(p).trimStart().length;
    rows.push({
      text: raw.slice(i).trim(),
      at: at + start(i),
      done: !!said,
      mark: said ? [at + from, at + from + said[0].trimEnd().length] : null,
      kept: raw.slice(from).trim(),
      keptAt: at + start(from),
      level,
      indent,
      typed: raw.slice(hash).trim(),
      typedAt: at + hash,
    });
    at += raw.length + 1;
  }
  const full = rows.filter(r => r.text),
    one = full.length === 1,
    lines = [],
    names = [];
  // What the next line may go under, nearest last. `heads` holds the headings above it ({level, k: index in lines}).
  // `above` holds the lines above it, since the last heading, that are indented less ({indent, k}).
  const heads = [],
    above = [];
  for (const r of full) {
    // The list's name is left out, and no line goes under it. Alone in the box, it is a title as typed, # included.
    if (r.level === 1 && one) {
      lines.push({ text: r.typed, at: r.typedAt, done: false, mark: null, under: null });
      continue;
    }
    if (r.level === 1) {
      names.push(r.text);
      heads.length = 0;
      above.length = 0;
      continue;
    }
    if (r.level) {
      while (heads.length && heads.at(-1).level >= r.level) heads.pop();
      above.length = 0;
    } else while (above.length && above.at(-1).indent >= r.indent) above.pop();
    const under = steps ? null : (above.at(-1)?.k ?? heads.at(-1)?.k ?? null);
    // A done line that is left out has no lines under it. The lines that were under it go under its parent.
    if (r.done && (steps || (!done && !one))) continue;
    lines.push(
      r.done && !done
        ? { text: r.kept, at: r.keptAt, done: false, mark: null, under }
        : { text: r.text, at: r.at, done: r.done, mark: r.mark, under },
    );
    (r.level ? heads : above).push({ level: r.level, indent: r.indent, k: lines.length - 1 });
  }
  const led = colon && lines.length > 1 && /\S:$/.test(lines[0].text),
    first = led || lines.some(l => l.under === 0);
  if (led && !flat) lines[0].text = lines[0].text.slice(0, -1).trimEnd();
  for (const [i, l] of lines.entries())
    if (flat) l.under = null;
    else if ((nest || led) && i && l.under === null) l.under = 0;
  return { lines, ticked, one, first, names };
}
// The text of each line in a checklist's steps box. A ticked line is left out.
export const captureLines = text => readList(text, { steps: true }).lines.map(l => l.text);
