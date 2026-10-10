// Quick add: what a typed line says, as Vikunja reads it, and pasted lists.
import {dueInfo, fmtTime} from './dates.js';

/* Follows Vikunja's Quick Add Magic (default mode, https://vikunja.io/help/quick-add-magic/) so the same text makes
   the same task in both apps. tests/parse.mjs holds the phrases, adapted from Vikunja's own tests; where Pocket
   deliberately differs, the test says so. */
const WEEKDAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
const WEEKDAY_RE = `${WEEKDAYS.join('|')}|${WEEKDAYS.map(w => w.slice(0,3)).join('|')}`;
const weekdayIndex = w => WEEKDAYS.findIndex(d => d.startsWith(w.toLowerCase().slice(0,3)));
export const NUMBER_WORDS = {one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10};
const LEAD_IN = /\b(in|by|on|before|until)\s+$/i;          // a word just before a date that goes with it
const DROP_LEAD = /(?:\b(?:in|by|on|before|until)\s+)?(?:\bthe\s+)?$/i;   // ...removed along with the date, with a "the"
const END = '(?=\\s|$|[,.!?;:])';                          // a phrase has to end at a word boundary
// Ambiguous numeric dates follow the phone's region: 10/12 is October 12 in the US and 10 December in most other places.
const DAY_FIRST = (() => { try { return new Intl.DateTimeFormat().formatToParts(new Date(2000, 11, 31)).find(p => p.type !== 'literal')?.type === 'day'; } catch { return false; } })();
export const projectName = typed => typed.replace(/[_-]/g, ' ').trim();
function tokenRe(prefix, flags = 'g'){ return new RegExp(`(^|\\s)\\${prefix}(?:"([^"]+)"|'([^']+)'|(\\S+))`, flags); }
/* Take one @username out of a title, quoted or not, once that person is assigned. Vikunja's quick add does the same. */
export function removeAssignee(title, prefix, name){
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return title.replace(new RegExp(`(^|\\s)\\${prefix}(?:"${n}"|'${n}'|${n})(?=\\s|$)`, 'gi'), '$1').replace(/\s{2,}/g, ' ').trim();
}
// Set a date's time from "HH:MM" (Vikunja's "default due time" setting; noon unless the user changed it).
export function atTime(d, hhmm = '12:00'){ const [h, m] = String(hhmm).split(':').map(Number); d.setHours(h || 0, m || 0, 0, 0); return d; }
const dayFrom = (now, n) => { const d = new Date(now); d.setDate(d.getDate() + n); d.setHours(0, 0, 0, 0); return d; };
const laterThisWeek = now => [5, 6, 0].includes(now.getDay()) ? 0 : 2;      // Friday to Sunday: today; otherwise in two days
// Day words, with Vikunja's meanings. Longer phrases first ("later next week" before "next week").
const DAY_WORDS = [
  ['later\\s+next\\s+week', now => dayFrom(now, laterThisWeek(now) + 7)],
  ['later\\s+this\\s+week', now => dayFrom(now, laterThisWeek(now))],
  ['next\\s+week', now => dayFrom(now, 7)],
  ['this\\s+weekend', now => dayFrom(now, (6 - now.getDay()) % 6)],
  ['next\\s+month', now => new Date(now.getFullYear(), now.getMonth() + 1, 1)],
  ['(?:the\\s+)?end\\s+of\\s+(?:the\\s+)?month', now => new Date(now.getFullYear(), now.getMonth() + 1, 0)],
  ['tonight', now => dayFrom(now, 0), '21:00'],
  ['today', now => dayFrom(now, 0)],
  ['tomorrow', now => dayFrom(now, 1)],
].map(([src, day, time]) => ({re: new RegExp(`(^|\\s)(?:${src})${END}`, 'i'), day, time}));
// A time after a date at the end of the text: "meeting 9/11 at 10:00". Numeric dates and bare "17th" only count
// at the start or end, so "The 9/11 Report" and "13th floor" stay as they are.
// A checklist step's T#20m after it, hidden by parseCapture, doesn't count.
const TIME_TAIL = '(?:\\s+at\\s+\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?)?(?:\\s+[\\uE000-\\uF8FF]+)*\\s*$';
// "2021-07-06", "6/7/21", "27/1", "01.02": a date, or null. No year means the next time that date comes round.
function numericDate(token, now){
  let y, m, d, a, b, x;
  if ((x = token.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/))) [y, m, d] = [+x[1], +x[2], +x[3]];
  else if ((x = token.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/))) {
    [a, b, y] = [+x[1], +x[2], x[3] && +x[3]];
    [m, d] = a > 12 ? [b, a] : b > 12 ? [a, b] : DAY_FIRST ? [b, a] : [a, b];
  } else if ((x = token.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{2}|\d{4}))?$/))) [d, m, y] = [+x[1], +x[2], x[3] && +x[3]];
  else return null;
  if (y && y < 100) y += 2000;
  const make = yr => { const t = new Date(yr, m - 1, d); return t.getMonth() === m - 1 && t.getDate() === d ? t : null; };
  if (y) return make(y);
  const t = make(now.getFullYear());
  return t && t < dayFrom(now, 0) ? make(now.getFullYear() + 1) : t;
}
// "17th": this month if it hasn't passed, else the next month that has that day.
function ordinalDate(day, now){
  for (let i = 0; i < 13; i++) {
    const t = new Date(now.getFullYear(), now.getMonth() + i, day);
    if (t.getDate() === day && t >= dayFrom(now, 0)) return t;
  }
  return null;
}
// Prefixes for each of Vikunja's Quick Add Magic modes (the user's setting); "disabled" turns parsing off.
export const QUICK_ADD_PREFIXES = {vikunja: {project: '+', label: '*', assignee: '@'}, todoist: {project: '#', label: '@', assignee: '+'}};
/* A figure at the end of a line, "(50%)" or "50%", is the task's own progress, 1 to 100, as a swipe would set it (100 is
   done). Pocket's own: Vikunja's quick add has no word for progress, so it's read whichever mode is set. The end of the
   line is the end of its title once the other words are read, so "Tables 50% tomorrow *hire" has one; only people
   (`tail`, a pattern for " @sam @jo") may follow it, as they stay in the title until they're assigned. Something has
   to come before it: "50%" alone is a title. {start, end, pct} in `title`, or null. */
function endFigure(title, tail = ''){
  const m = title.match(new RegExp(`\\s(?:\\((\\d{1,3})%\\)|(\\d{1,3})%)(?=${tail}\\s*$)`)), pct = m ? +(m[1] ?? m[2]) : 0;
  return pct >= 1 && pct <= 100 && title.slice(0, m.index).trim() ? {start: m.index + 1, end: m.index + m[0].length, pct} : null;
}
/* Returns {title, project, projectMiss, labels, assignees, priority, due, dueLabel, dueFromRepeat, repeat, pct, marks}.
   pct: its own progress, from a figure at its end (endFigure); 0 for none.
   marks: the words that were read, as [{start, end, kind, name}] positions in `text`, one per phrase; kind is one of the
   `ignore` keys below, and name the person, for @username.
   opts: mode ("vikunja", "todoist" or "disabled"), ignore (kinds the user tapped off; their words stay in the title:
   project, labels, assignees, priority, repeat, due, progress), now, dueTime ("HH:MM"). */
export function parseCapture(text, projects, {mode = 'vikunja', ignore = {}, now = new Date(), dueTime = '12:00'} = {}){
  const out = {title: text, project: null, projectMiss: null, labels: [], assignees: [], priority: 0, due: null, dueLabel: '', dueFromRepeat: false, repeat: null, repeatWarn: '', pct: 0, marks: []};
  const P = QUICK_ADD_PREFIXES[mode];
  if (!P) {
    const f = !ignore.progress && endFigure(text);
    if (f) Object.assign(out, {pct: f.pct, title: (text.slice(0, f.start) + text.slice(f.end)).trim(), marks: [{start: f.start, end: f.end, kind: 'progress'}]});
    return out;
  }
  // A checklist step's T#20m, T#40m:roast and {#roast} stay as they are, and nothing reads them as a date, a time or a
  // project: each is swapped for a run of one private-use character, the same length, and put back at the end.
  const stepTokens = [];
  const hide = tok => String.fromCharCode(0xE000 + stepTokens.push(tok) - 1).repeat(tok.length);
  const unhide = t => t.replace(/([\uE000-\uF8FF])\1*/g, (run, c) => stepTokens[c.charCodeAt(0) - 0xE000] ?? run);
  /* Quotes round the start of the text hold its title, read as typed, and the words after them are read as usual:
     "Lunch friday" @sam 2026-10-16 is "Lunch friday", Sam's, due the 16th. With nothing after them, everything is
     turned off, as in Vikunja: "delete mails up to january 30th". The words after are Pocket's own: Vikunja has no
     way to keep one word from being read, and a copied list needs one (share.js). The title ends at the first such
     quote with a space, or the end, after it. It's hidden as a step's words are, its quotes with it. */
  const held = text.match(/^(\s*)(["'])([\s\S]*?)\2(?=\s|$)/);
  if (held) text = held[1] + String.fromCharCode(0xE000 + stepTokens.push(held[3].trim()) - 1).repeat(held[3].length + 2) + text.slice(held[0].length);
  text = text.replace(/(^|\s)(T#(?:\d+(?:\.\d+)?(?:ms|d|h|m|s))+(?::[a-z][\w-]*)?)(?=\s|$|["'])/gi, (_, sp, tok) => sp + hide(tok))
    .replace(/\{#[a-z][\w-]*\}/gi, hide);
  // Repeats Vikunja can't do, on weekdays only or on two or more days of the week, stay in the title as they are, and
  // no part of them is read as anything else ("every monday and thursday" isn't every Monday); a chip says so.
  if (!ignore.repeat) text = text.replace(new RegExp(`(^|\\s)((?:every|each)\\s+(?:week\\s?days?|working\\s+days?|week\\s?ends?|(?:${WEEKDAY_RE})(?:\\s*(?:,|and|&|\\+)\\s*(?:${WEEKDAY_RE}))+))(?=\\s|$|[,.!?;:])`, 'i'),
    (_, sp, phrase) => { out.repeatWarn = phrase; return sp + hide(phrase); });
  out.title = text;
  // Every change to the title goes through edit(). `from` keeps where each character of the title was in `text`, and
  // `read` what each removed one was read as, so the words can be marked where they were typed.
  const from = Array.from({length: text.length}, (_, i) => i), read = new Map();
  const edit = (start, end, insert, kind) => {
    if (kind) for (let i = start; i < end; i++) if (from[i] >= 0) read.set(from[i], kind);
    from.splice(start, end - start, ...Array(insert.length).fill(kind ? -1 : from[start]));
    out.title = out.title.slice(0, start) + insert + out.title.slice(end);
  };
  const cut = (start, end, kind) => edit(start, end, ' ', kind);
  const drop = (m, kind) => edit(m.index + m[1].length, m.index + m[0].length, '', kind);      // a token, keeping the space before it
  let m;
  // "@ 3pm" is a time, as in Vikunja. The last one first, so the earlier positions stay valid.
  for (const x of [...out.title.matchAll(/(^|\s)@\s+(?=\d)/g)].reverse()) edit(x.index + x[1].length, x.index + x[0].length, 'at ');

  // project +name: only the first one counts
  if (!ignore.project && (m = out.title.match(tokenRe(P.project, '')))) {
    const typed = unhide(m[2] || m[3] || m[4]), name = projectName(typed).toLowerCase();
    const hit = projects.find(p => p.title.toLowerCase() === name) || projects.find(p => p.title.toLowerCase().startsWith(name));
    if (hit) out.project = hit; else out.projectMiss = typed;
    drop(m, 'project');
  }
  // labels *name
  if (!ignore.labels) {
    const found = [...out.title.matchAll(tokenRe(P.label))];
    for (const x of found) { const l = unhide(x[2] || x[3] || x[4]); if (!out.labels.includes(l)) out.labels.push(l); }
    for (const x of found.reverse()) drop(x, 'labels');
  }
  // assignees @username stay in the title for now: createTask takes out each one that gets assigned, as Vikunja does.
  // A space is needed before the @, so email addresses are left alone.
  const people = [];
  if (!ignore.assignees) for (const x of out.title.matchAll(tokenRe(P.assignee))) {
    const u = unhide(x[2] || x[3] || x[4]);
    if (!out.assignees.includes(u)) out.assignees.push(u);
    people.push({start: from[x.index + x[1].length], end: from[x.index + x[0].length - 1] + 1, kind: 'assignees', name: u});
  }
  // priority !1..!5: the first valid one
  if (!ignore.priority && (m = out.title.match(/(^|\s)!([1-5])(?=\s|$)/))) { out.priority = +m[2]; drop(m, 'priority'); }

  // repeat: "every day", "every 3 days", "each two weeks", "every monday", "daily", "biannually", ...
  let repeatDay = null;
  if (!ignore.repeat) {
    m = out.title.match(new RegExp(`(^|\\s)(?:every|each)\\s+(?:(\\d+|other|${Object.keys(NUMBER_WORDS).join('|')})\\s+)?(hour|day|week|month|year)s?${END}`, 'i'));
    let n, unit;
    if (m) { n = /^other$/i.test(m[2] || '') ? 2 : NUMBER_WORDS[(m[2] || '').toLowerCase()] || +(m[2] || 1); unit = m[3].toLowerCase(); }
    else if ((m = out.title.match(new RegExp(`(^|\\s)(hourly|daily|weekly|monthly|yearly|annually|biannually|semiannually|biennially)${END}`, 'i')))) {
      [n, unit] = {hourly: [1, 'hour'], daily: [1, 'day'], weekly: [1, 'week'], monthly: [1, 'month'], yearly: [1, 'year'], annually: [1, 'year'],
        biannually: [6, 'month'], semiannually: [6, 'month'], biennially: [2, 'year']}[m[2].toLowerCase()];
    }
    if (unit) {
      // "every month" repeats on the same day each month (Vikunja's monthly mode); Vikunja's own quick add uses 30 days.
      out.repeat = unit === 'month' && n === 1 ? {after: 0, mode: 1, label: 'Every month'}
        : {after: n * {hour: 3600, day: 86400, week: 604800, month: 30 * 86400, year: 365 * 86400}[unit], mode: 0, label: n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`};
      cut(m.index + m[1].length, m.index + m[0].length, 'repeat');
    } else if ((m = out.title.match(new RegExp(`(^|\\s)(?:every|each)\\s+(${WEEKDAY_RE})${END}`, 'i')))) {
      repeatDay = weekdayIndex(m[2]);                                           // Pocket extra: "every monday"
      out.repeat = {after: 604800, mode: 0, label: 'Every ' + WEEKDAYS[repeatDay][0].toUpperCase() + WEEKDAYS[repeatDay].slice(1)};
      cut(m.index + m[1].length, m.index + m[0].length, 'repeat');
    }
  }

  // due date. The date leaves the title along with a word that introduces it: "Call Bob in May" -> "Call Bob".
  if (!ignore.due) {
    const dropDate = (start, end) => cut(start - out.title.slice(0, start).match(DROP_LEAD)[0].length, end, 'due');
    let day = null, time = null, m;                     // day: a date at midnight; time: "HH:MM" or a full date from chrono
    for (const w of DAY_WORDS) if ((m = out.title.match(w.re))) { day = w.day(now); time = w.time || null; dropDate(m.index + m[1].length, m.index + m[0].length); break; }
    if (!day && (m = out.title.match(new RegExp(`(^|\\s)(?:(?:next|this|on)\\s+)?(${WEEKDAY_RE})${END}`, 'i')))) {
      day = dayFrom(now, (weekdayIndex(m[2]) - now.getDay() + 7) % 7);           // the coming one; today counts
      dropDate(m.index + m[1].length, m.index + m[0].length);
    }
    if (!day) {                                                                 // numeric date, first or last word
      for (const re of [/^(\S+)(?=\s|$)/, new RegExp(`(^|\\s)(\\S+)(?=${TIME_TAIL})`)]) {
        if ((m = out.title.match(re))) {
          const token = m[2] ?? m[1], start = m.index + (m[2] !== undefined ? m[1].length : 0);
          const t = numericDate(token, now);
          if (t) { day = t; dropDate(start, start + token.length); break; }
        }
      }
    }
    // "17th" at the end, or "the 17th" anywhere; not "sep 17th", which is chrono's.
    const afterMonth = m => /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+$/i.test(out.title.slice(0, m.index + m[1].length));
    if (!day && ((m = out.title.match(new RegExp(`(^|\\s)(\\d{1,2})(?:st|nd|rd|th)(?=${TIME_TAIL})`, 'i'))) && !afterMonth(m)
             || (m = out.title.match(new RegExp(`(^|\\s)(?:the|on the|on)\\s+(\\d{1,2})(?:st|nd|rd|th)${END}`, 'i'))) && !afterMonth(m))) {
      const t = ordinalDate(+m[2], now);
      if (t) { day = t; dropDate(m.index + m[1].length, m.index + m[0].length); }
    }
    if (!day && repeatDay !== null) day = dayFrom(now, (repeatDay - now.getDay() + 7) % 7);   // "every monday at 10"

    if (typeof chrono !== 'undefined') {
      // chrono-node reads the rest: "Oct 12", "21st June", "in 3 days", "in 2 hours", "at 3pm", ...
      const results = (DAY_FIRST ? chrono.GB : chrono.casual).parse(out.title, now, {forwardDate: true}).filter(r =>
        out.title[r.index - 1] !== P.assignee                                   // part of an @username
        && !/^for\b/i.test(r.text)                                              // "for 2 hours" is a duration, not a date
        && !/^now$/i.test(r.text)                                               // "Now what" isn't due this minute
        && !/^\d{1,4}[/.-]\d/.test(r.text)                                      // numeric dates are handled above, at the ends only
        // A month name on its own ("March madness") only counts after in/by/on/before/until: "call Bob in May".
        && !(/^[a-z]+\.?$/i.test(r.text) && r.start.isCertain('month') && !r.start.isCertain('day') && !LEAD_IN.test(out.title.slice(0, r.index))));
      const timeOnly = r => r.start.isCertain('hour') && !r.start.isCertain('day') && !r.start.isCertain('weekday') && !r.start.isCertain('month');
      /* A bare hour is daytime, as people mean it on the go: "at 5" is 5 PM, 1 to 7 being the afternoon or evening.
         (Vikunja's own quick add reads it as 5 AM.) "5am", "5pm", "17:00" and "05:00" are as written. */
      const daytime = r => {
        const d = r.start.date(), h = d.getHours();
        if (r.start.isCertain('hour') && !r.start.isCertain('meridiem') && h >= 1 && h <= 7 && !/(^|\D)0\d/.test(r.text)) d.setHours(h + 12);
        return d;
      };
      const dated = !day && results.find(r => !timeOnly(r));
      if (dated) {
        day = daytime(dated);
        // Without a year, chrono takes a date earlier than now as next year's, by the time it assumes for it (noon): so
        // today's date typed in the afternoon would be next year. Today's is today.
        const thisYear = new Date(day); thisYear.setFullYear(now.getFullYear());
        if (!dated.start.isCertain('year') && day.getFullYear() > now.getFullYear() && thisYear.toDateString() === now.toDateString()) day = thisYear;
        if (dated.start.isCertain('hour')) time = day;
        else day.setHours(0, 0, 0, 0);
      }
      const clock = !(time instanceof Date) && results.find(r => r !== dated && timeOnly(r));
      if (clock) {
        if (day) time = daytime(clock);
        else {                                                                  // a time on its own: the next one
          const t = daytime(clock);
          day = new Date(now); day.setHours(t.getHours(), t.getMinutes(), 0, 0);
          if (day <= now) day = new Date(day.getTime() + 864e5);
          time = day;
        }
      }
      // Remove what was used, the later one first so the earlier position stays valid.
      for (const r of [dated, clock].filter(Boolean).sort((a, b) => b.index - a.index)) dropDate(r.index, r.index + r.text.length);
    }
    if (day) {
      const d = new Date(day);
      if (time instanceof Date) d.setHours(time.getHours(), time.getMinutes(), 0, 0);
      else atTime(d, time || dueTime);
      out.due = d; out.timeRead = !!time;
    }
  }
  // A repeating task needs a date to repeat from: the next default due time.
  if (out.repeat && !out.due && !ignore.due) {
    const d = atTime(dayFrom(now, 0), dueTime);
    out.due = d < now ? atTime(dayFrom(now, 1), dueTime) : d; out.dueFromRepeat = true;
  }
  if (out.due) out.dueLabel = dueInfo(out.due.toISOString()).label;
  if (out.due && out.timeRead && !/\d:\d\d/.test(out.dueLabel)) out.dueLabel += ' ' + fmtTime(out.due);   // as "Oct 12 3:30 PM"
  // Its own progress: a figure at the end of what's left, before the people in it.
  const figure = !ignore.progress && endFigure(out.title, ignore.assignees ? '' : `(?:\\s+\\${P.assignee}(?:"[^"]+"|'[^']+'|\\S+))*`);
  if (figure) { out.pct = figure.pct; cut(figure.start, figure.end, 'progress'); }

  out.title = unhide(out.title.replace(/\s{2,}/g, ' ').trim());
  // One mark per phrase: neighbouring characters read as the same thing join up, across the spaces between them.
  for (const i of [...read.keys()].sort((a, b) => a - b)) {
    const kind = read.get(i), last = out.marks[out.marks.length - 1];
    if (last && last.kind === kind && !text.slice(last.end, i).trim()) last.end = i + 1;
    else out.marks.push({start: i, end: i + 1, kind});
  }
  out.marks = [...out.marks, ...people].sort((a, b) => a.start - b.start);
  return out;
}
/* Pasted lists: one task per line. What email and notes apps put in front of an item is taken off: "> " quote marks,
   bullets, "1." / "1)" numbering and checkboxes. A marker needs a space after it, so "*label" and "+project" at the
   start of a line still work. An empty checkbox, or a ✓ (often just a bullet), is an open item's. */
const QUOTE_MARKS = /^(?:>\s*)+/, BULLET = /^(?:[-*•◦▪‣–—+]\s+|\d{1,3}[.)]\s+|\(\d{1,3}\)\s+)/, OPEN_BOX = /^(?:\[ ?\]|[☐✓✔])\s*/;
/* A line that says it's done: a ticked checkbox after its bullet, "- [x] eggs", "☑ eggs"; or, Pocket's own, an x at
   its very start with a space after it: "x eggs", "x - eggs", "x- eggs". With no space it's a word, "x-ray the pipe",
   and a capital X is one too, "X marks the spot". */
const DONE_BOX = /^(?:\[[xX✓]\]|[☑☒])\s*/, DONE_X = /^x(?:\s+-|-)?\s+/;
/* A heading, as Markdown notes write one and a task's copy starts with (share.js): "## Pack the van" is a task, and
   the lines under it, up to the next heading, are its subtasks. A heading with more #s is under the one before it
   with fewer. */
const HEADING = /^(#{2,6})\s+/;
/* A box's text, read as a list: {lines, ticked, one, first}. `lines`, one for each line that becomes a task, in order:
   {text: its words, without what was in front of them; at: where they start in the box's text; done: whether it says
   it's done; mark: [start, end] of what said so, in the box's text; under: the line it's under, by its place in
   `lines`, or null}. `ticked`: how many lines say they're done, kept or not; `one`: whether the box holds a single
   line, not a list; `first`: whether the first line is a parent as the list is written, with lines under it.
   A line that says it's done arrives done, in quick add and the subtask boxes. With `done` off (its chip tapped): a
   single line keeps the marker's words in its title, as any chip tapped off does, and a list leaves those lines out,
   the lines under one going under what it was under.
   Which line is under which is read from the list: its headings, and its indenting, as in Vikunja's web app: a line
   indented more than the line above it is under it, to any depth, in spaces or tabs of any width (a tab counts as
   four spaces). And, in quick add (`colon`), from a first line ending with a colon, "Groceries:", as a list starts in
   a message: it's the parent of every line with none, its colon taken off. Quick add's ↳ Under first line changes
   that: `nest`, the first line is the parent of every line with none; `flat`, they're all tasks of their own, a
   first line's colon staying in its title.
   `steps`: a run's box and a template's steps, where a step is done by doing it: a ticked checkbox's line is left
   out, an x is a word, and so is a heading's #. */
export function readList(text, {steps = false, done = true, nest = false, flat = false, colon = false} = {}){
  const rows = [];
  let at = 0, ticked = 0;
  for (const raw of String(text || '').split('\n')) {
    let i = raw.length - raw.trimStart().length;
    const indent = [...raw.slice(0, i)].reduce((n, c) => n + (c === '\t' ? 4 : 1), 0);
    const take = re => { const m = raw.slice(i).match(re); if (m) i += m[0].length; return m; };
    take(QUOTE_MARKS);
    const level = steps ? 0 : take(HEADING)?.[1].length || 0;
    let from = i, said = !steps && take(DONE_X);
    if (!said) { take(BULLET); from = i; said = take(DONE_BOX); }
    if (!said) take(OPEN_BOX);
    if (said) ticked++;
    const start = p => p + raw.slice(p).length - raw.slice(p).trimStart().length;
    rows.push({text: raw.slice(i).trim(), at: at + start(i), done: !!said, mark: said ? [at + from, at + from + said[0].trimEnd().length] : null,
      kept: raw.slice(from).trim(), keptAt: at + start(from), level, indent});
    at += raw.length + 1;
  }
  const full = rows.filter(r => r.text), one = full.length === 1, lines = [];
  // What the next line may be under, the nearest last: the headings over it ({level, k: its place in lines}), and,
  // since the last heading, the lines above it that are indented less ({indent, k}).
  const heads = [], above = [];
  for (const r of full) {
    if (r.level) { while (heads.length && heads.at(-1).level >= r.level) heads.pop(); above.length = 0; }
    else while (above.length && above.at(-1).indent >= r.indent) above.pop();
    const under = steps ? null : above.at(-1)?.k ?? heads.at(-1)?.k ?? null;
    // A done line left out isn't over anything: what's under it goes under what it was under.
    if (r.done && (steps || (!done && !one))) continue;
    lines.push(r.done && !done ? {text: r.kept, at: r.keptAt, done: false, mark: null, under} : {text: r.text, at: r.at, done: r.done, mark: r.mark, under});
    (r.level ? heads : above).push({level: r.level, indent: r.indent, k: lines.length - 1});
  }
  const led = colon && lines.length > 1 && /\S:$/.test(lines[0].text), first = led || lines.some(l => l.under === 0);
  if (led && !flat) lines[0].text = lines[0].text.slice(0, -1).trimEnd();
  for (const [i, l] of lines.entries()) if (flat) l.under = null; else if ((nest || led) && i && l.under === null) l.under = 0;
  return {lines, ticked, one, first};
}
// The lines of a run's box, a template's steps and its name: their words, a ticked one left out.
export const captureLines = text => readList(text, {steps: true}).lines.map(l => l.text);
