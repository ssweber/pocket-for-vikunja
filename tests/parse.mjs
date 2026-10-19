// Quick-add parsing tests. No server needed:
//
//   npm run test:parse
//
// Loads src/js/quickadd.js and src/js/checklists.js in a headless browser, with chrono from pocket/app/. It runs
// parseCapture() on each phrase with a fixed "now", captureLines() on a few pasted lists, and the checklist step
// parsing on steps. It tests src/ as it is, so there is no need to build first.
// The phrases and expectations are adapted from Vikunja's own Quick Add Magic tests
// (frontend/src/modules/quickAddMagic/quickAddMagic.test.ts), so Pocket parses text the way Vikunja does.
// Cases marked `pocket` are where Pocket deliberately differs from Vikunja or does more. `why` explains how.
// Optional: BROWSER_CHANNEL=msedge|chrome.
import { createServer } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
/* global endedOf, parseCapture, captureLines, readList, parseStep, readStepPhrase, draftSteps, stepProblems, isChecklistDesc, stepOrder, withOrder, stepsOf, isLate, placeBefore, addedText, notesOnly, withAdded, withStepLine, withLinesOf, roleOf, comesRound, templateName, templateTitle, repeatWords, vikunjaNext, nextAfter, stepAsks, textLines, copiedNotes, withAskLines, stepAnswers, OP_WORDS */

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript' };
// The page exposes the modules' functions as globals, so page.evaluate() can call them.
const CHRONO = (await readdir(resolve(ROOT, 'pocket/app'))).find(f => /^chrono-.*\.js$/.test(f));
const PAGE = `<!doctype html><script type="module">
import * as chrono from '/pocket/app/${CHRONO}'; window.chrono = chrono;
const quickadd = await import('/src/js/quickadd.js'), checklists = await import('/src/js/checklists.js'), dates = await import('/src/js/dates.js'), asks = await import('/src/js/asks.js'), messages = await import('/src/js/messages.js');
Object.assign(window, quickadd, checklists, dates, asks, {OP_WORDS: messages.OP_WORDS});
</script>`;
const http = createServer(async (req, res) => {
  let file = '';
  try {
    file = resolve(ROOT, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
  } catch {}
  if (file === ROOT) {
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE);
    return;
  }
  if (![resolve(ROOT, 'src'), resolve(ROOT, 'pocket/app')].some(dir => file.startsWith(dir + sep))) {
    res.writeHead(404).end();
    return;
  }
  let body;
  try {
    body = await readFile(file);
  } catch {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }).end(body);
}).listen(0, '127.0.0.1');
await new Promise(r => http.once('listening', r));

// ---------- helpers for writing expectations ----------
const REF = new Date(2021, 5, 24, 12, 0); // Thursday 24 June 2021, noon (Vikunja's tests use this date)
const ymd = d => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
const plus = (n, from = REF) => {
  const d = new Date(from);
  d.setDate(d.getDate() + n);
  return ymd(d);
};
const cases = [];
// c: {text, now?, dueTime?, ignore?, title?, date? ('Y-M-D' | null | 'any'), time? ('H:M'), repeat? ({after, mode} | null),
//     labels?, assignees?, project?, priority?, pct?, pocket?, why?}
const add = c => cases.push(c);

// ---------- general ----------
add({ text: 'Lorem Ipsum', title: 'Lorem Ipsum', date: null });
add({ text: 'Lorem Ipsum email@example.com', title: 'Lorem Ipsum email@example.com', date: null, assignees: [] });

// ---------- the user's Quick Add Magic mode ----------
add({
  text: 'Lorem Ipsum today *label +project !2 @user',
  mode: 'disabled',
  title: 'Lorem Ipsum today *label +project !2 @user',
  date: null,
  labels: [],
  project: null,
  priority: 0,
  assignees: [],
});
add({
  text: 'Lorem Ipsum today @label #project !2 +user',
  mode: 'todoist',
  title: 'Lorem Ipsum +user',
  date: ymd(REF),
  labels: ['label'],
  project: 'project',
  priority: 2,
  assignees: ['user'],
});
add({
  text: '"task today @label #project"',
  mode: 'todoist',
  title: 'task today @label #project',
  date: null,
  labels: [],
  project: null,
});
add({
  text: 'Mail bob@example.com tomorrow',
  mode: 'todoist',
  title: 'Mail bob@example.com',
  date: plus(1),
  labels: [],
  pocket: true,
  why: 'an email address is not a label',
});

// ---------- quote-escaped text ----------
add({
  text: '"delete mails up to january 30th"',
  title: 'delete mails up to january 30th',
  date: null,
  labels: [],
  project: null,
  priority: 0,
  assignees: [],
  repeat: null,
});
add({
  text: "'buy mass tomorrow *label !2 @user'",
  title: 'buy mass tomorrow *label !2 @user',
  date: null,
  labels: [],
  priority: 0,
  assignees: [],
  repeat: null,
});
add({ text: '"delete mails today', date: 'any' });
add({ text: '"delete mails today\'', date: 'any' });
add({ text: 'delete "mails" today', date: 'any' });
add({ text: '""', title: '', date: null });
// Pocket's own rule: quotes around the start of the text mark it as the title, and the text after them is parsed as
// usual. A copied Markdown list quotes a title this way when quick add would otherwise parse words in it (share.js).
const held = why => ({ pocket: true, why });
add({
  text: '"Lunch friday" @sam 2026-10-16',
  title: 'Lunch friday @sam',
  assignees: ['sam'],
  date: '2026-10-16',
  marked: ['assignees:@sam', 'due:2026-10-16'],
  ...held('the quoted text is the title, and the text after it is parsed as usual'),
});
add({
  text: '"Call Bob tomorrow" tomorrow !2 *calls',
  title: 'Call Bob tomorrow',
  date: '2021-6-25',
  priority: 2,
  labels: ['calls'],
  ...held('a date word inside the quotes stays in the title, and the same word after them is parsed'),
});
add({
  text: '\'Say "hi" friday\' every week',
  title: 'Say "hi" friday',
  repeat: { after: 604800, mode: 0 },
  ...held('single quotes let a title contain a double quote'),
});
add({
  text: '"Tables (50%)" (25%)',
  title: 'Tables (50%)',
  pct: 25,
  ...held('a percentage after the quotes is the progress'),
});
add({
  text: '"x-ray" the pipe friday',
  title: 'x-ray the pipe',
  date: '2021-6-25',
  ...held('the closing quote is followed by a space, and the text after it is parsed'),
});
add({
  text: '"Paint !2"coats !3',
  title: '"Paint !2"coats',
  priority: 3,
  ...held('quotes with no space after the closing quote do not make a title'),
});
add({
  text: '"task today" +user @label',
  mode: 'todoist',
  title: 'task today +user',
  date: null,
  assignees: ['user'],
  labels: ['label'],
  ...held("quoted titles also work with Todoist's prefixes"),
});
add({
  text: '"Lunch friday" @sam',
  mode: 'disabled',
  title: '"Lunch friday" @sam',
  date: null,
  assignees: [],
  ...held('with quick add turned off, the text stays as typed'),
});
add({
  text: '" Lunch  friday " !3',
  title: 'Lunch  friday',
  priority: 3,
  date: null,
  ...held('the title keeps the spaces inside the quotes and drops the ones at its ends'),
});

// ---------- default due time ----------
add({
  text: 'plan this tomorrow',
  now: new Date(2026, 7, 4, 9, 15),
  dueTime: '14:30',
  date: '2026-8-5',
  time: '14:30',
});
add({ text: 'plan this tomorrow', now: new Date(2026, 7, 4, 10, 15), date: '2026-8-5', time: '12:0' });

// ---------- day words ----------
add({ text: 'Lorem Ipsum ToDay', title: 'Lorem Ipsum', date: ymd(REF) });
add({ text: 'Lorem Ipsum today', title: 'Lorem Ipsum', date: ymd(REF) });
add({
  text: 'Lorem Ipsum tonight',
  title: 'Lorem Ipsum',
  date: ymd(REF),
  time: '20:0',
  pocket: true,
  why: 'tonight is 8 PM, the time "tomorrow night" gets. Vikunja reads it as 9 PM',
});
// A part of the day with its day sets the time. Vikunja reads none of them but "tonight", so the rest stay in its title.
add({
  text: 'Lorem Ipsum tomorrow morning at 6',
  title: 'Lorem Ipsum',
  date: plus(1),
  time: '6:0',
  pocket: true,
  why: 'a bare hour after a morning is read as written, 6 AM',
});
add({
  text: 'Lorem Ipsum this morning at 5',
  title: 'Lorem Ipsum',
  date: ymd(REF),
  time: '5:0',
  pocket: true,
  why: '"this morning" is today, even once its time has passed',
});
add({
  text: 'Lorem Ipsum tonight at 1',
  title: 'Lorem Ipsum',
  date: plus(1),
  time: '1:0',
  pocket: true,
  why: '1 to 4 after "tonight" are the small hours after it',
});
add({
  text: 'Lorem Ipsum tonight at 12',
  title: 'Lorem Ipsum',
  date: plus(1),
  time: '0:0',
  pocket: true,
  why: '12 after "tonight" is the midnight that ends the day',
});
add({
  text: 'Lorem Ipsum tonight at midnight',
  title: 'Lorem Ipsum',
  date: plus(1),
  time: '0:0',
  pocket: true,
  why: 'midnight after "tonight" ends the day, and the whole phrase leaves the title',
});
add({
  text: 'Lorem Ipsum tomorrow night at 2',
  title: 'Lorem Ipsum',
  date: plus(2),
  time: '2:0',
  pocket: true,
  why: '1 to 4 after "tomorrow night" are the small hours after it',
});
for (const [t, hm] of Object.entries({
  'at 15:00': '15:0',
  '@ 15:00': '15:0',
  'at 15:30': '15:30',
  '@ 3pm': '15:0',
  'at 3pm': '15:0',
  'at 3 pm': '15:0',
  'at 3am': '3:0',
  'at 3:12 am': '3:12',
  'at 3:12 pm': '15:12',
  'at 3:12 AM': '3:12',
  'at 3:12 PM': '15:12',
  'at 3:12 Am': '3:12',
  'at 3:12 Pm': '15:12',
  'at 12:00 pm': '12:0',
  'at 12:00 am': '0:0',
}))
  add({ text: `Lorem Ipsum today ${t}`, title: 'Lorem Ipsum', date: ymd(REF), time: hm });
add({ text: 'Lorem Ipsum tomorrow', title: 'Lorem Ipsum', date: plus(1) });
add({ text: 'Lorem Ipsum Tomorrow', title: 'Lorem Ipsum', date: plus(1) });
add({ text: 'Lorem Ipsum next monday', title: 'Lorem Ipsum', date: plus(4) });
add({ text: 'next monday Lorem Ipsum', title: 'Lorem Ipsum', date: plus(4) });
add({ text: 'Lorem Ipsum nExt Monday', title: 'Lorem Ipsum', date: plus(4) });
add({ text: 'Lorem Ipsum this weekend', title: 'Lorem Ipsum', date: plus(2) });
add({ text: 'Lorem Ipsum later this week', title: 'Lorem Ipsum', date: plus(2) });
add({ text: 'Lorem Ipsum later next week', title: 'Lorem Ipsum', date: plus(9) });
add({ text: 'Lorem Ipsum next week', title: 'Lorem Ipsum', date: plus(7) });
add({ text: 'Lorem Ipsum next month', title: 'Lorem Ipsum', date: '2021-7-1' });
add({ text: 'Lorem Ipsum 06/26/2021', title: 'Lorem Ipsum', date: '2021-6-26' });
add({ text: 'Lorem Ipsum end of month', title: 'Lorem Ipsum', date: '2021-6-30' });
add({ text: 'Lorem Ipsum thu at 14:00', title: 'Lorem Ipsum', date: ymd(REF), time: '14:0' });

// ---------- day of the month ----------
add({ text: 'Lorem Ipsum 14th', now: new Date(2022, 0, 15), title: 'Lorem Ipsum', date: '2022-2-14' });
add({ text: 'Lorem Ipsum 29th', now: new Date(2022, 0, 30), title: 'Lorem Ipsum', date: '2022-3-29' });
add({ text: 'Lorem Ipsum 31st', now: new Date(2022, 3, 1), title: 'Lorem Ipsum', date: '2022-5-31' });
add({ text: 'Lorem Ipsum 25th', title: 'Lorem Ipsum', date: '2021-6-25' });

// ---------- words that contain a day or month name, and ordinals that aren't dates ----------
for (const c of [
  'renewed',
  'github',
  'fix monitor stand',
  'order wedding cake',
  'investigate thumping noise',
  'iron frilly napkins',
  'take photo of saturn',
  'fix sunglasses',
  'monitor blood pressure',
  'Monitor blood pressure',
  'buy almonds',
  'Renovation',
  'Remark',
  'Renovation - 2nd Floor Bath',
  'Remark - 13th floor',
  '13th floor - remark',
])
  for (const t of [`${c} dolor sit amet`, `Lorem Ipsum ${c}`, `Lorem Ipsum ${c} dolor`, c])
    add({ text: t, title: t, date: null });

// ---------- numeric dates only at the start or end ----------
for (const t of [
  'The 9/11 Report',
  'The 01/02 Report',
  'a]7/8 debate',
  'The 1.2 formula',
  'Lorem Ispum v1.1.1',
  'https://some-url.org/blog/2019/1/233526-some-more-text',
])
  add({ text: t, title: t, date: null });
for (const [text, date, title] of [
  ['9/11 meeting', '2021-9-11', 'meeting'],
  ['meeting 9/11', '2021-9-11', 'meeting'],
  ['meeting 9/11 at 10:00', '2021-9-11', 'meeting'],
  ['meeting 9/11 @ 15:00', '2021-9-11', 'meeting'],
  ['2021-06-24 Lorem Ipsum', '2021-6-24', 'Lorem Ipsum'],
  ['Lorem Ipsum 06/26/2021', '2021-6-26', 'Lorem Ipsum'],
  ['01.02 Lorem Ipsum', '2022-2-1', 'Lorem Ipsum'],
  ['Lorem Ipsum 01.02', '2022-2-1', 'Lorem Ipsum'],
  ['The 9/11 Report due 10/12', '2021-10-12', 'The 9/11 Report due'],
])
  add({ text, date, title });

// ---------- weekdays ----------
const DAYS = {
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
  sunday: 0,
  sun: 0,
};
for (const [d, n] of Object.entries(DAYS))
  for (const w of [d, d[0].toUpperCase() + d.slice(1)]) {
    const date = plus((n - REF.getDay() + 7) % 7);
    for (const p of ['next ', '']) {
      add({ text: `Lorem Ipsum ${p}${w}`, title: 'Lorem Ipsum', date });
      add({ text: `${p}${w} Lorem Ipsum`, title: 'Lorem Ipsum', date });
    }
    for (const t of [`Lorem Ipsum ${w}ipsum`, `Lorem ipsum${w} dolor`, `Lorem Ipsum lorem${w}ipsum`])
      add({ text: t, title: t, date: null });
  }

// ---------- written dates ----------
// Vikunja leaves a date like "21st June" in the past if it has already passed this year. Pocket always picks the next one.
const NEXT_YEAR = { pocket: true, why: 'a date that has passed this year means the next year, not the past' };
const written = {
  '06/08/2021': '2021-6-8',
  '6/7/21': '2021-6-7',
  '27/07/2021,': null,
  '2021/07/06': '2021-7-6',
  '2021-07-06': '2021-7-6',
  '27 jan': '2022-1-27',
  '27/1': '2022-1-27',
  '27/01': '2022-1-27',
  '16/12': '2021-12-16',
  '01/27': '2022-1-27',
  '1/27': '2022-1-27',
  'jan 27': '2022-1-27',
  'Jan 27': '2022-1-27',
  'january 27': '2022-1-27',
  'January 27': '2022-1-27',
  'feb 21': '2022-2-21',
  'February 21': '2022-2-21',
  'mar 21': '2022-3-21',
  'March 21': '2022-3-21',
  'apr 21': '2022-4-21',
  'April 21': '2022-4-21',
  'may 21': '2022-5-21',
  'May 21': '2022-5-21',
  'jun 21': '2022-6-21',
  'June 21': '2022-6-21',
  '22nd December': '2021-12-22',
  '23rd October': '2021-10-23',
  '4th July': '2021-7-4',
  '15th August': '2021-8-15',
  '31st December': '2021-12-31',
  '12th Sep': '2021-9-12',
  'jul 21': '2021-7-21',
  'July 21': '2021-7-21',
  'aug 21': '2021-8-21',
  'August 21': '2021-8-21',
  'sep 21': '2021-9-21',
  'September 21': '2021-9-21',
  'oct 21': '2021-10-21',
  'October 21': '2021-10-21',
  'nov 21': '2021-11-21',
  'November 21': '2021-11-21',
  'dec 21': '2021-12-21',
  'december 21': '2021-12-21',
  '01.02.2021': '2021-2-1',
  '01.02': '2022-2-1',
  '01.10': '2021-10-1',
  '01.02.25': '2025-2-1',
};
const writtenPocket = {
  '21st June': '2022-6-21',
  '2nd March': '2022-3-2',
  '2nd march': '2022-3-2',
  '3rd April': '2022-4-3',
  '1st January': '2022-1-1',
  '5th Mar': '2022-3-5',
};
for (const [t, date] of Object.entries(written))
  for (const text of [`Lorem Ipsum ${t}`, `${t} Lorem Ipsum`])
    add(date === null ? { text, date: null } : { text, date, title: 'Lorem Ipsum' });
for (const [t, date] of Object.entries(writtenPocket))
  for (const text of [`Lorem Ipsum ${t}`, `${t} Lorem Ipsum`]) add({ text, date, title: 'Lorem Ipsum', ...NEXT_YEAR });

// ---------- "in ..." and dates with times ----------
for (const [text, dt, pocket] of [
  ['Lorem Ipsum in 1 hour', '2021-6-24 13:0'],
  ['in 2 hours', '2021-6-24 14:0'],
  ['in 1 day', '2021-6-25 12:0'],
  ['in 2 days', '2021-6-26 12:0'],
  ['in 1 week', '2021-7-1 12:0'],
  ['in 2 weeks', '2021-7-8 12:0'],
  ['in 4 weeks', '2021-7-22 12:0'],
  ['in 1 month', '2021-7-24 12:0'],
  ['in 3 months', '2021-9-24 12:0'],
  ['Something in 5 days at 10:00', '2021-6-29 10:0'],
  ['Something 17th at 10:00', '2021-7-17 10:0'],
  ['Something sep 17 at 10:00', '2021-9-17 10:0'],
  ['Something sep 17th at 10:00', '2021-9-17 10:0'],
  ['Something at 10:00 in 5 days', '2021-6-29 10:0'],
  ['Something at 10:00 17th', '2021-7-17 10:0'],
  ['Something at 10:00 sep 17th', '2021-9-17 10:0'],
  ['2nd March at 5', '2022-3-2 17:0', 1],
  ['2nd March at 5pm', '2022-3-2 17:0', 1],
  ['2nd March @ 14:00', '2022-3-2 14:0', 1],
  ['3rd April at 10:30', '2022-4-3 10:30', 1],
  ['15th August @ 9am', '2021-8-15 9:0'],
  ['21st June at 18:45', '2022-6-21 18:45', 1],
  ['5th Mar at 3pm', '2022-3-5 15:0', 1],
  ['Some task Mar 8th', '2022-3-8 12:0', 1],
  ['Some task mar 8th', '2022-3-8 12:0', 1],
]) {
  const [date, time] = dt.split(' ');
  const title = text.startsWith('Something')
    ? 'Something'
    : text.startsWith('Some task')
      ? 'Some task'
      : text.startsWith('Lorem')
        ? 'Lorem Ipsum'
        : '';
  add({ text, date, time, title, ...(pocket ? NEXT_YEAR : {}) });
}

// ---------- labels ----------
add({ text: 'Lorem Ipsum *label1 *label2', title: 'Lorem Ipsum', labels: ['label1', 'label2'] });
add({ text: '*label1 Lorem Ipsum *label2', title: 'Lorem Ipsum', labels: ['label1', 'label2'] });
add({ text: 'Lorem Ipsum *label1 *label1 *label2', title: 'Lorem Ipsum', labels: ['label1', 'label2'] });
// Vikunja removes a label wherever it is. Pocket leaves the word of one in the middle of the title.
const MIDDLE = { pocket: true, why: 'a @user, *label or +project in the middle of the title leaves its word there' };
add({
  text: "Lorem *'label with space' Ipsum",
  title: 'Lorem label with space Ipsum',
  labels: ['label with space'],
  ...MIDDLE,
});
add({
  text: 'Lorem *"label with space" Ipsum',
  title: 'Lorem label with space Ipsum',
  labels: ['label with space'],
  ...MIDDLE,
});
add({ text: 'Lorem Ipsum *today', title: 'Lorem Ipsum', labels: ['today'], date: null });
add({ text: 'a *"a (a)"', title: 'a', labels: ['a (a)'] });
add({ text: '*"a (a)" a', title: 'a', labels: ['a (a)'] });

// ---------- project ----------
add({ text: 'Lorem Ipsum +project', title: 'Lorem Ipsum', project: 'project' });
add({ text: "Lorem Ipsum +'project with long name'", title: 'Lorem Ipsum', project: 'project with long name' });
add({ text: 'Lorem Ipsum +"project with long name"', title: 'Lorem Ipsum', project: 'project with long name' });
add({
  text: 'Lorem Ipsum +project1 +project2 +project3',
  title: 'Lorem Ipsum +project2 +project3',
  project: 'project1',
});
add({ text: 'Lorem Ipsum +today', title: 'Lorem Ipsum', project: 'today', date: null });
add({
  text: 'Lorem Ipsum +TOD',
  title: 'Lorem Ipsum',
  project: 'today',
  pocket: true,
  why: "the start of one project's name finds it, in any case",
});
add({
  text: 'Lorem Ipsum +proj',
  title: 'Lorem Ipsum',
  project: 'proj',
  pocket: true,
  why: "the start of several projects' names finds none, so the box offers to create it",
});

// ---------- priority ----------
for (const p of [1, 2, 3, 4, 5]) add({ text: `Lorem Ipsum !${p}`, title: 'Lorem Ipsum', priority: p });
add({ text: 'Lorem Ipsum !9999', title: 'Lorem Ipsum !9999', priority: 0 });
add({ text: 'Lorem Ipsum !9999 !1', title: 'Lorem Ipsum !9999', priority: 1 });

// ---------- assignees (they stay in the title, as in Vikunja) ----------
add({ text: 'Lorem Ipsum @user', title: 'Lorem Ipsum @user', assignees: ['user'] });
add({
  text: 'Lorem Ipsum @user1 @user2 @user3',
  title: 'Lorem Ipsum @user1 @user2 @user3',
  assignees: ['user1', 'user2', 'user3'],
});
add({
  text: 'Lorem Ipsum @user1 @user1 @user2',
  title: 'Lorem Ipsum @user1 @user1 @user2',
  assignees: ['user1', 'user2'],
});
add({
  text: "Lorem Ipsum @'user with long name'",
  title: "Lorem Ipsum @'user with long name'",
  assignees: ['user with long name'],
});
add({
  text: 'Lorem Ipsum @"user with long name"',
  title: 'Lorem Ipsum @"user with long name"',
  assignees: ['user with long name'],
});
add({ text: 'Lorem Ipsum @today', title: 'Lorem Ipsum @today', assignees: ['today'], date: null });
add({
  text: 'Lorem Ipsum @email@example.com',
  title: 'Lorem Ipsum @email@example.com',
  assignees: ['email@example.com'],
});

// ---------- a @user, *label or +project in the middle of the title ----------
// Vikunja removes a label or a project wherever it is, and an assigned @user too. Pocket leaves the word of one in the
// middle of the title, without its sign. A @user stays in the title as typed until the add op assigns it.
add({
  text: 'Ask @bob about the invoice',
  title: 'Ask @bob about the invoice',
  assignees: ['bob'],
  marked: ['assignees:@bob'],
});
add({
  text: 'Fix the *urgent leak in the sink',
  title: 'Fix the urgent leak in the sink',
  labels: ['urgent'],
  marked: ['labels:*urgent'],
  ...MIDDLE,
});
add({ text: 'Pack for the +project move', title: 'Pack for the project move', project: 'project', ...MIDDLE });
add({
  text: 'Pack for the +"project with long name" move',
  title: 'Pack for the project with long name move',
  project: 'project with long name',
  ...MIDDLE,
});
add({
  text: 'Ask @"user with long name" about it',
  title: 'Ask @"user with long name" about it',
  assignees: ['user with long name'],
});
add({ text: 'Fix *a *b leak', title: 'Fix a b leak', labels: ['a', 'b'], marked: ['labels:*a *b'], ...MIDDLE });
add({
  text: 'Call @bob tomorrow about it !2',
  title: 'Call @bob about it',
  assignees: ['bob'],
  date: plus(1),
  priority: 2,
});
add({
  text: 'Fix the #home leak @urgent +bob',
  mode: 'todoist',
  title: 'Fix the home leak +bob',
  project: 'home',
  labels: ['urgent'],
  assignees: ['bob'],
  ...MIDDLE,
});
// At the start or the end, with only other such words or dates between it and that end, it is removed as in Vikunja.
add({
  text: 'Call the plumber @bob *home',
  title: 'Call the plumber @bob',
  assignees: ['bob'],
  labels: ['home'],
});
add({ text: '@bob call the plumber', title: '@bob call the plumber', assignees: ['bob'] });
add({
  text: '*home +project Call the plumber @bob tomorrow',
  title: 'Call the plumber @bob',
  labels: ['home'],
  project: 'project',
  assignees: ['bob'],
  date: plus(1),
});
add({
  text: 'Call the plumber *home tomorrow',
  ignore: { due: true },
  title: 'Call the plumber tomorrow',
  labels: ['home'],
  date: null,
  pocket: true,
  why: 'a date whose chip is tapped off still counts at the end',
});
add({
  text: 'Fix the *urgent leak',
  ignore: { labels: true },
  title: 'Fix the *urgent leak',
  labels: [],
  pocket: true,
  why: 'a word whose chip is tapped off stays in the title as typed',
});

// ---------- repeating ----------
const H = 3600,
  D = 86400,
  W = 604800,
  M = 30 * D,
  Y = 365 * D;
const MONTHLY = { after: 0, mode: 1 }; // Pocket repeats "every month" on the same day of the month. Vikunja uses 30 days
const repeats = {
  'every 1 hour': H,
  'every hour': H,
  'every 5 hours': 5 * H,
  'every 12 hours': 12 * H,
  'every day': D,
  'every 1 day': D,
  'every 2 days': 2 * D,
  'every week': W,
  'every 1 week': W,
  'every 3 weeks': 3 * W,
  'every month': MONTHLY,
  'every 1 month': MONTHLY,
  'every 2 months': 2 * M,
  'every year': Y,
  'every 1 year': Y,
  'every 4 years': 4 * Y,
  'every one hour': H,
  'every two hours': 2 * H,
  'every three hours': 3 * H,
  'every four hours': 4 * H,
  'every five hours': 5 * H,
  'every six hours': 6 * H,
  'every seven hours': 7 * H,
  'every eight hours': 8 * H,
  'every nine hours': 9 * H,
  'every ten hours': 10 * H,
  annually: Y,
  biannually: 6 * M,
  semiannually: 6 * M,
  biennially: 2 * Y,
  daily: D,
  hourly: H,
  monthly: MONTHLY,
  weekly: W,
  yearly: Y,
};
const MORNING = new Date(2021, 5, 24, 10, 0);
for (const [t, r] of Object.entries(repeats)) {
  const repeat = typeof r === 'number' ? { after: r, mode: 0 } : r,
    extra =
      typeof r === 'number'
        ? {}
        : { pocket: true, why: 'monthly repeats on the same day of the month, not every 30 days' };
  add({ text: `Lorem Ipsum ${t}`, title: 'Lorem Ipsum', repeat, ...extra });
  add({
    text: `Lorem Ipsum ${t} at 11:42`,
    now: MORNING,
    title: 'Lorem Ipsum',
    repeat,
    date: ymd(MORNING),
    time: '11:42',
    ...extra,
  });
}
for (const w of [
  'annually',
  'biannually',
  'semiannually',
  'biennially',
  'daily',
  'hourly',
  'monthly',
  'weekly',
  'yearly',
])
  add({ text: `Lorem Ipsum word${w}notword`, title: `Lorem Ipsum word${w}notword`, repeat: null });

// ---------- Pocket's own additions ----------
const extra = why => ({ pocket: true, why });
add({
  text: 'Team sync every monday at 10',
  title: 'Team sync',
  repeat: { after: W, mode: 0 },
  date: plus(4),
  time: '10:0',
  ...extra('"every monday" is a weekly repeat starting on the next Monday'),
});
add({
  text: 'Team sync every monday evening',
  title: 'Team sync',
  repeat: { after: W, mode: 0 },
  date: plus(4),
  time: '18:0',
  marked: ['repeat:every monday evening'],
  ...extra('a part of the day after a repeat sets its time, and leaves the title with it'),
});
add({
  text: 'Water plants every day morning',
  title: 'Water plants',
  repeat: { after: D, mode: 0 },
  date: plus(1),
  time: '9:0',
  marked: ['repeat:every day morning'],
  ...extra('a repeat with a part of the day and no day starts at the next time of that part'),
});
add({
  text: 'Water plants every day evening',
  title: 'Water plants',
  repeat: { after: D, mode: 0 },
  date: ymd(REF),
  time: '18:0',
  ...extra('a repeat with a part of the day and no day starts at the next time of that part'),
});
add({
  text: 'Water plants every 3 days',
  title: 'Water plants',
  repeat: { after: 3 * D, mode: 0 },
  date: ymd(REF),
  ...extra('a repeat with no date sets the due date to today'),
});
add({
  text: 'Pay rent before the 17th',
  title: 'Pay rent',
  date: '2021-7-17',
  marked: ['due:before the 17th'],
  ...extra('"the 17th" is a date anywhere in the text, and the word before a date is part of it'),
});
add({
  text: 'Report due the 17th',
  title: 'Report due',
  date: '2021-7-17',
  ...extra('"the 17th" is a date anywhere in the text'),
});
add({
  text: 'Call Bob in May',
  title: 'Call Bob',
  date: '2022-5-1',
  marked: ['due:in May'],
  ...extra('a month name after "in" is a date'),
});
add({
  text: 'Finish slides by Friday',
  title: 'Finish slides',
  date: plus(1),
  ...extra('the word before a date is part of the date'),
});
add({
  text: 'Plan March madness pool',
  title: 'Plan March madness pool',
  date: null,
  ...extra('a month name is a date only after in, by, on, before or until'),
});
add({ text: 'Now what', title: 'Now what', date: null, ...extra('the word "now" is not a date') });
add({
  text: 'Team sync for 2 hours',
  title: 'Team sync for 2 hours',
  date: null,
  ...extra('"for 2 hours" is a duration, not a date'),
});
add({
  text: 'Order 3/4 inch screws',
  title: 'Order 3/4 inch screws',
  date: null,
  ...extra('a numeric date is read only at the start or end of the text'),
});
add({
  text: 'Pay rent tomorrow',
  ignore: { due: true },
  title: 'Pay rent tomorrow',
  date: null,
  marked: [],
  ...extra('turning off a chip keeps its text in the title'),
});
add({
  text: 'Lorem Ipsum dec 21 at 3pm @ann *calls +project !2',
  title: 'Lorem Ipsum @ann',
  date: '2021-12-21',
  time: '15:0',
  labels: ['calls'],
  assignees: ['ann'],
  project: 'project',
  priority: 2,
  marked: ['due:dec 21 at 3pm', 'assignees:@ann', 'labels:*calls', 'project:+project', 'priority:!2'],
  ...extra('a date, person, label, project and priority are all parsed in one line'),
});
add({
  text: 'Team sync every monday @ 10',
  title: 'Team sync',
  repeat: { after: W, mode: 0 },
  time: '10:0',
  marked: ['repeat:every monday', 'due:@ 10'],
  ...extra('each phrase is marked where it was typed, including "@ 10"'),
});
// A bare hour is read as daytime. 1 to 7 means afternoon or evening, where Vikunja reads "at 5" as 5 AM. Times written
// with am, pm or a full hour like 05:00 are read as written.
add({
  text: 'Call Ana at 5',
  title: 'Call Ana',
  date: '2021-6-24',
  time: '17:0',
  ...extra('a bare 5 means 5 PM, and the date is today because 5 PM has not passed'),
});
add({
  text: 'Call Ana at 9',
  title: 'Call Ana',
  date: '2021-6-25',
  time: '9:0',
  ...extra('a bare 9 means 9 AM, and the date is tomorrow because 9 AM has passed'),
});
add({
  text: 'Call Ana tomorrow at 5:30',
  title: 'Call Ana',
  date: '2021-6-25',
  time: '17:30',
  ...extra('a bare 5:30 also means the afternoon'),
});
add({
  text: 'Call Ana at 5am',
  title: 'Call Ana',
  date: '2021-6-25',
  time: '5:0',
  ...extra('an explicit "am" is kept'),
});
add({
  text: 'Call Ana at 05:00',
  title: 'Call Ana',
  date: '2021-6-25',
  time: '5:0',
  ...extra('a 24-hour time such as "05:00" is kept'),
});
// A repeat that Vikunja can't store stays in the title as text, and no part of it is parsed as anything else.
add({
  text: 'Water lawn every other day',
  title: 'Water lawn',
  repeat: { after: 2 * D, mode: 0 },
  ...extra('"every other day" means every 2 days'),
});
add({
  text: 'Standup every weekday at 9',
  title: 'Standup every weekday',
  repeat: null,
  date: '2021-6-25',
  time: '9:0',
  ...extra('Vikunja cannot repeat on weekdays only, so no repeat is set'),
});
add({
  text: 'Gym every monday and thursday',
  title: 'Gym every monday and thursday',
  repeat: null,
  date: null,
  ...extra('Vikunja cannot repeat on two days a week, so no repeat is set'),
});

// A percentage at the end of a line is the task's progress in every mode. Vikunja's quick add has no syntax for it.
add({
  text: 'Tables (50%)',
  title: 'Tables',
  pct: 50,
  marked: ['progress:(50%)'],
  ...extra('a percentage at the end is the progress'),
});
add({
  text: 'Tables 50%',
  title: 'Tables',
  pct: 50,
  marked: ['progress:50%'],
  ...extra('a percentage without brackets is the progress too'),
});
add({
  text: 'Tables (50%) @sam',
  title: 'Tables @sam',
  pct: 50,
  assignees: ['sam'],
  ...extra('a person may follow the percentage, and stays in the title until assigned'),
});
add({
  text: 'Tables 50% tomorrow *hire !2',
  title: 'Tables',
  pct: 50,
  date: plus(1),
  labels: ['hire'],
  priority: 2,
  ...extra('the percentage counts as the end of the text once the other phrases are parsed'),
});
add({ text: 'Tables (100%)', title: 'Tables', pct: 100, ...extra('100% means the task is done') });
add({
  text: 'Discount 50% on mugs',
  title: 'Discount 50% on mugs',
  pct: 0,
  ...extra('a percentage in the middle of the text is part of the title'),
});
add({ text: 'Tables (150%)', title: 'Tables (150%)', pct: 0, ...extra('a percentage above 100% is not progress') });
add({ text: 'Growth 0%', title: 'Growth 0%', pct: 0, ...extra('0% is not progress') });
add({ text: '50%', title: '50%', pct: 0, ...extra('a percentage alone is the title') });
add({
  text: 'Tables (50%)',
  ignore: { progress: true },
  title: 'Tables (50%)',
  pct: 0,
  marked: [],
  ...extra('turning off the progress chip keeps its text in the title'),
});
add({
  text: 'Fill to 50%',
  ignore: { due: true, repeat: true, project: true, progress: true },
  title: 'Fill to 50%',
  pct: 0,
  ...extra('a step cannot start with a progress percentage'),
});
add({
  text: 'Tables (50%)',
  mode: 'disabled',
  title: 'Tables',
  pct: 50,
  ...extra('the percentage is parsed with quick add turned off too'),
});
add({
  text: 'Tables (50%) @sam',
  mode: 'disabled',
  title: 'Tables (50%) @sam',
  pct: 0,
  assignees: [],
  ...extra('with quick add off, @sam is plain text, so the percentage is not at the end'),
});
add({
  text: 'Tables (50%) +sam @hire',
  mode: 'todoist',
  title: 'Tables +sam',
  pct: 50,
  assignees: ['sam'],
  labels: ['hire'],
  ...extra('the percentage works with Todoist’s prefixes'),
});

// ---------- pasted lists: list markers removed, one task per line ----------
const lists = [];
const addList = (text, lines, why) => lists.push({ text, lines, why });
// captureLines reads a checklist's add box and a template's steps. A ticked line is left out there, because a step
// is completed by doing it.
addList(
  'Groceries\n- [] Cheese\n- [ ] Milk\n- [x] Eggs',
  ['Groceries', 'Cheese', 'Milk'],
  'an iOS Notes checklist leaves out lines that are already ticked',
);
addList(
  '• Bread\n◦ Jam\n☐ Butter\n✓ Tea',
  ['Bread', 'Jam', 'Butter', 'Tea'],
  'bullets and checkbox symbols are removed',
);
addList('1. One\n2) Two\n(3) Three', ['One', 'Two', 'Three'], 'numbers in front of lines are removed');
addList(
  '> - Quoted item\n\n  - Indented item  ',
  ['Quoted item', 'Indented item'],
  'quote marks, blank lines and indents are removed',
);
addList(
  '*calls Bob\n+Kitchen paint\n-[] Bread',
  ['*calls Bob', '+Kitchen paint', '-[] Bread'],
  'a marker is removed only when a space follows it',
);
addList(
  'x Call Sam\nX Call Priya\n[x] Eggs\nMilk',
  ['x Call Sam', 'X Call Priya', 'Milk'],
  'in the steps box, a leading x or X is plain text, and a ticked line is left out',
);

// ---------- quick add and the subtask boxes: a line marked as done is created as done ----------
// readList(text, opts) returns each line as [its text, whether it is done].
const reads = [];
const addRead = (text, lines, why, opts = {}) => reads.push({ text, lines, why, opts });
for (const m of [
  'x ',
  'x - ',
  'x- ',
  'X ',
  'X - ',
  'X- ',
  '[x] ',
  '- [x] ',
  '* [X] ',
  '☑ ',
  '☒ ',
  '> - [x] ',
  '1. [✓] ',
  '  - [x]',
])
  addRead(m + 'Call Sam', [['Call Sam', true]], `"${m}" at the start marks the task done`);
addRead('x-ray the pipe', [['x-ray the pipe', false]], 'an x with no space after it is part of the word');
addRead('X-ray the pipe', [['X-ray the pipe', false]], 'a capital X with no space after it is part of the word');
addRead(
  'X marks the spot',
  [['marks the spot', true]],
  'a capital X and a space mark the task done, because a phone capitalises the first letter of a line',
);
addRead('X marks the spot', [['X marks the spot', false]], 'turning off the done chip keeps the title as typed', {
  done: false,
});
addRead('- x marks the spot', [['x marks the spot', false]], 'an x after a bullet is plain text');
addRead('x', [['x', false]], 'an x alone is a title');
addRead('X', [['X', false]], 'a capital X alone is a title');
addRead(
  '[ ] Milk\n- [ ] Bread\n* [ ] Jam\n- [] Tea\n☐ Rice\n✓ Salt',
  ['Milk', 'Bread', 'Jam', 'Tea', 'Rice', 'Salt'].map(t => [t, false]),
  'an empty checkbox marks the task open and is removed from the title',
);
addRead(
  'Groceries\n- [x] Eggs\n\n- [ ] Milk\nx Bread',
  [
    ['Groceries', false],
    ['Eggs', true],
    ['Milk', false],
    ['Bread', true],
  ],
  'in a list, each line with a done marker is done',
);
addRead(
  'Groceries\n- [x] Eggs\n- [ ] Milk\nx Bread',
  [
    ['Groceries', false],
    ['Milk', false],
  ],
  "turning off the list's done chip leaves out the done lines",
  { done: false },
);
addRead('x Call Sam', [['x Call Sam', false]], 'with one line and its chip off, the marker stays in the title', {
  done: false,
});
addRead(
  '- [x] Call Sam',
  [['[x] Call Sam', false]],
  'with the chip off, a checkbox stays in the title but its bullet is removed',
  { done: false },
);

// ---------- parents in a pasted list ----------
// addNest(text, the text of each line, the index of each line's parent among the lines (or null), why, options,
// whether the first line is a parent as the list is written)
const addNest = (text, titles, under, why, opts = {}, first = under.includes(0)) =>
  reads.push({ text, lines: titles.map(t => (Array.isArray(t) ? t : [t, false])), under, first, why, opts });
// A heading is a task, and the lines under it, up to the next heading, are its subtasks.
addNest(
  '## Pack the van\n- Load chairs\n- Tables\n\n## Set the hall\nLights',
  ['Pack the van', 'Load chairs', 'Tables', 'Set the hall', 'Lights'],
  [null, 0, 0, null, 3],
  'each heading is a task, with the lines under it as its subtasks',
);
addNest(
  '### Pack the van\n- Load chairs',
  ['Pack the van', 'Load chairs'],
  [null, 0],
  'a heading with more # characters is also a heading',
);
addNest(
  '## A\n### B\nb1\n## C\nc1',
  ['A', 'B', 'b1', 'C', 'c1'],
  [null, 0, 1, null, 3],
  'a heading with more # characters is under the previous heading with fewer',
);
addNest('## Pack the van', ['Pack the van'], [null], 'a single heading is a task, without the # characters');
addNest(
  '## [x] Pack the van\n- [x] Load chairs',
  [
    ['Pack the van', true],
    ['Load chairs', true],
  ],
  [null, 0],
  'a heading can be marked done',
);
addNest(
  'To do first\n## Pack the van\n- Load chairs',
  ['To do first', 'Pack the van', 'Load chairs'],
  [null, null, 1],
  'a line before the first heading is a separate task',
);
addNest(
  '## Pack the van\n- Load chairs\n## Set the hall\n- Lights',
  ['Pack the van', 'Load chairs', 'Set the hall', 'Lights'],
  [null, null, null, null],
  'with ↳ Under first line off, every line is a separate task',
  { flat: true },
  true,
);
addNest(
  '## Pack the van\n- Load chairs\n## Set the hall\n- Lights',
  ['Pack the van', 'Load chairs', 'Set the hall', 'Lights'],
  [null, 0, 0, 2],
  'with ↳ Under first line on, the first line is the parent of every line with no parent',
  { nest: true },
);
addNest(
  'Pack the van\n- Load chairs\n- Tables',
  ['Pack the van', 'Load chairs', 'Tables'],
  [null, 0, 0],
  'with ↳ Under first line on, a list with no markers goes under its first line',
  { nest: true },
  false,
);
addNest(
  '## A\n## [x] B\nb1\n### C\nc1',
  ['A', 'b1', 'C', 'c1'],
  [null, null, null, 2],
  'when done lines are left out, the lines of a done heading have no parent',
  { done: false },
);
addNest(
  '#project task\n#5 on the list',
  ['#project task', '#5 on the list'],
  [null, null],
  "a # with no space after it is plain text, such as Todoist's #project",
);
// Indentation works as in Vikunja's web app. A line indented more than the line above it is a subtask of that line, to any depth.
addNest(
  'Pack the van\n  Load chairs\n    Stack them\n  Tables\nSet the hall\n\tLights',
  ['Pack the van', 'Load chairs', 'Stack them', 'Tables', 'Set the hall', 'Lights'],
  [null, 0, 1, 0, null, 4],
  'indenting with spaces or a tab nests lines to any depth',
);
addNest(
  '- Pack the van\n   - [x] Load chairs\n      * Stack them\n - Tables',
  ['Pack the van', ['Load chairs', true], 'Stack them', 'Tables'],
  [null, 0, 1, 0],
  'any indent width works, and a line nests when it is indented more than the line above',
);
addNest(
  '    Pack the van\n    Tables\n  Lights\n      Cables',
  ['Pack the van', 'Tables', 'Lights', 'Cables'],
  [null, null, null, 2],
  'a list indented as a whole starts at the top level, and so does a line indented less than the first',
);
addNest(
  '## Pack the van\n  - Load chairs\n    - Stack them\n  - Tables\n## Set the hall\n- Lights',
  ['Pack the van', 'Load chairs', 'Stack them', 'Tables', 'Set the hall', 'Lights'],
  [null, 0, 1, 0, null, 4],
  'under a heading, an indented line is a subtask of the line above it',
);
addNest(
  'Pack the van\n  - [x] Load chairs\n      Stack them\n  Tables',
  ['Pack the van', 'Stack them', 'Tables'],
  [null, 0, 0],
  "when a done line is left out, its subtask moves up to the done line's parent",
  { done: false },
);
addNest(
  'Pack the van\n  Load chairs\nSet the hall\n  Lights',
  ['Pack the van', 'Load chairs', 'Set the hall', 'Lights'],
  [null, null, null, null],
  'with ↳ Under first line off, every line is a separate task',
  { flat: true },
  true,
);
addNest(
  'Order cups\nPack the van\n  Load chairs',
  ['Order cups', 'Pack the van', 'Load chairs'],
  [null, 0, 1],
  'with ↳ Under first line on and no parent in the text, the first line is the parent of the lines with no parent',
  { nest: true },
  false,
);
addList(
  'Wipe down\n  Counter\n    Under it',
  ['Wipe down', 'Counter', 'Under it'],
  'in the steps box, indenting does not nest lines',
);
// A line with one # is the name of the whole list, as at the start of a project's copy. It is left out.
addNest(
  '# Café · 12 open · 5 done\n- [ ] Order milk\n- [ ] Pack the van\n  - [ ] Tables',
  ['Order milk', 'Pack the van', 'Tables'],
  [null, null, 1],
  'a line starting with one # is a list name and is left out of the tasks',
  { names: ['Café · 12 open · 5 done'] },
);
addNest(
  '# Friday\n## Pack the van\n- Tables\n# [x] Saturday\n- Lights',
  ['Pack the van', 'Tables', 'Lights'],
  [null, 0, null],
  'every line starting with one # is a list name, and no task goes under it',
  { names: ['Friday', '[x] Saturday'] },
);
addNest(
  '# of chairs we need',
  ['# of chairs we need'],
  [null],
  'a line starting with # alone in the box is a title, not a list name',
  { names: [] },
);
addList('# Opening\n- Unlock', ['# Opening', 'Unlock'], 'in the steps box, a leading # is plain text');
// In quick add's box only, a first line ending with a colon is the parent of the other lines, and the colon is removed.
addNest(
  'Groceries:\n- milk\n- eggs',
  ['Groceries', 'milk', 'eggs'],
  [null, 0, 0],
  'a first line ending with a colon is the parent of the lines under it',
  { colon: true },
);
addNest(
  'Groceries tomorrow: \nDairy\n  milk\nBread',
  ['Groceries tomorrow', 'Dairy', 'milk', 'Bread'],
  [null, 0, 1, 0],
  'a first line ending with a colon is the parent of every line with no parent',
  { colon: true },
);
addNest(
  'Groceries:\n- milk',
  ['Groceries:', 'milk'],
  [null, null],
  'with ↳ Under first line off, the lines are separate tasks and the colon stays in the title',
  { colon: true, flat: true },
  true,
);
addNest('Groceries:', ['Groceries:'], [null], 'a single line ending with a colon stays as typed', { colon: true });
addNest(
  'Note: buy milk\neggs:',
  ['Note: buy milk', 'eggs:'],
  [null, null],
  'only a colon at the end of the first line makes a parent',
  { colon: true },
);
addNest(
  'Groceries:\n- [x] milk',
  ['Groceries:'],
  [null],
  'when its only line is left out, the first line stays as typed, as a single task',
  { colon: true, done: false },
);
addNest(
  'Groceries:\n- milk',
  ['Groceries:', 'milk'],
  [null, null],
  'the subtask box does not treat a colon line as a parent',
);
addList('## Wipe down\n- Counter', ['## Wipe down', 'Counter'], 'in the steps box, a heading is plain text');

// ---------- checklist steps ----------
// A step's T#20m, T#40m:roast and {#roast} stay in the title for parseStep. Quick add never parses them as a date or time.
add({
  text: 'Check the guards at 3pm T#30m',
  ignore: { due: true, repeat: true },
  title: 'Check the guards at 3pm T#30m',
  date: null,
  pocket: true,
  why: 'a checklist step keeps its text, and parseStep reads T#30m',
});
add({
  text: 'Warm up the press T#2h',
  title: 'Warm up the press T#2h',
  date: null,
  pocket: true,
  why: "T#2h isn't a time of day",
});
add({
  text: 'Baste the roast T#40m:roast',
  title: 'Baste the roast T#40m:roast',
  date: null,
  pocket: true,
  why: 'T#40m:roast is not a time of day either',
});
add({
  text: 'pay rent Oct 5',
  now: new Date(2026, 9, 5, 20, 50),
  title: 'pay rent',
  date: '2026-10-5',
  pocket: true,
  why: 'a date that is today stays today, also when typed after noon',
});
add({
  text: 'pay rent oct 7 at 10am',
  now: new Date(2026, 9, 7, 11, 0),
  title: 'pay rent',
  date: '2026-10-7',
  time: '10:0',
  pocket: true,
  why: 'a date that is today stays today when its time has passed',
});
add({
  text: 'pay rent Oct 4',
  now: new Date(2026, 9, 5, 20, 50),
  title: 'pay rent',
  date: '2027-10-4',
  pocket: true,
  why: "yesterday's date means the same date next year",
});
add({
  text: 'Task *"batch {#roast}"',
  title: 'Task',
  labels: ['batch {#roast}'],
  pocket: true,
  why: 'step text inside a quoted label stays in the label',
});
add({
  text: 'Task *"batch T#20m"',
  title: 'Task',
  labels: ['batch T#20m'],
  pocket: true,
  why: 'a T# time before the closing quote stays in the label',
});
// Adding a step's token after the text must not change how the text is parsed: [text, token, mode].
const collisions = [
  ['Call the lab 17:30', 'T#20m'],
  ['The 9/11 Report due 10/12', 'T#40m:roast'],
  ['01.02 Lorem Ipsum', 'T#1h30m'],
  ['Lorem Ipsum 01.02', '{#roast}'],
  ['Order resin 2026-10-12', 'T#3d'],
  ['Baste the roast at 5pm', 'T#40m:roast'],
  ['Roast in tomorrow', '{#roast}'],
  ['Set the table #project', 'T#20m:roast', 'todoist'],
  ['Set the table #project', '{#table}', 'todoist'],
  ['Make the gravy *kitchen', 'T#5m'],
];
// parseStep: [text, title, offset in ms, name, ref, number of problems]
const steps = [
  ['Check the guards', 'Check the guards', null, null, null, 0],
  ['Warm up the press T#30m', 'Warm up the press', 30 * 6e4, null, null, 0],
  ['First article check T#2h', 'First article check', 120 * 6e4, null, null, 0],
  ['Cool down T#1h30m', 'Cool down', 90 * 6e4, null, null, 0],
  ['Settle T#1.5h', 'Settle', 90 * 6e4, null, null, 0],
  ['Rinse T#90s', 'Rinse', 90e3, null, null, 0],
  ['Blink T#250ms', 'Blink', 250, null, null, 0],
  ['Order resin T#3d', 'Order resin', 3 * 864e5, null, null, 0],
  ['Sign off T#0m', 'Sign off', 0, null, null, 0],
  ['Soak t#20M', 'Soak', 20 * 6e4, null, null, 0],
  ['Put the roast in {#roast}', 'Put the roast in', null, 'roast', null, 0],
  ['Baste the roast T#40m:roast', 'Baste the roast', 40 * 6e4, null, 'roast', 0],
  ['Roast in {#roast} T#5m', 'Roast in', 5 * 6e4, 'roast', null, 0],
  ['T#1d2h3m4s Long one', 'Long one', 864e5 + 2 * 36e5 + 3 * 6e4 + 4e3, null, null, 0],
  ['Email ops@T#team', 'Email ops@T#team', null, null, null, 0],
  ['Part AT#5', 'Part AT#5', null, null, null, 0],
  ['Read T#30 of the manual', 'Read of the manual', null, null, null, 1],
  ['Preheat T#-10m:roast', 'Preheat', null, null, null, 1],
  ['Two times T#5m T#10m', 'Two times', 5 * 6e4, null, null, 1],
  ['Bad name {#1st}', 'Bad name', null, null, null, 1],
  ['Bad ref T#5m:2nd', 'Bad ref', null, null, null, 1],
  ['Way off T#400d', 'Way off', null, null, null, 1],
  ['Overflow T#999999999999999999999d', 'Overflow', null, null, null, 1],
  ['Nbsp\u00a0T#20m', 'Nbsp', 20 * 6e4, null, null, 0],
  ['Two names {#a} {#b}', 'Two names', null, 'a', null, 1],
];
// stepProblems on a template's steps: [titles, the text each problem message contains]
const templates = [
  [['A {#a}', 'B T#5m:a', 'C T#1h'], []],
  [['A T#5m:a', 'B {#a}'], ['which has to be an earlier step']],
  [['A {#a} T#5m:a'], ['which has to be an earlier step']],
  [['A {#a}', 'B {#A}'], ['an earlier step is also named']],
  [['A', 'B T#5m:nope'], ['no step is named']],
  [['A T#5', 'B'], ["isn't a time"]],
];
// A step's time written in words, parsed while the user writes steps in Pocket: [text, offset in ms or null]
const phrases = [
  ['Check the oil in 10 min', 6e5],
  ['Baste after an hour', 36e5],
  ['Pull the jeans 20 minutes later', 12e5],
  ['Carve 1h 30m after', 54e5],
  ['Rest in half an hour', 18e5],
  ['Call back in 2 days', 1728e5],
  ['Check in two hours', 72e5],
  ['Check in 1 hour and 30 minutes', 54e5],
  ['Sand in 90s', 9e4],
  ['Stir for 2 minutes', null],
  ['Let it rest 10 minutes', null],
  ['Meet in am', null],
  ['Sign in and out', null],
  ['Log in 5', null],
  ['Wait in a while', null],
  ['Ship in 400 days', null],
];
// Rows of steps written in Pocket and saved: [rows, steps already in the template, titles to add, steps to rename, whether there is a problem]
const drafts = [
  [
    [
      { key: 'a', text: 'Put the roast in' },
      { key: 'b', text: 'Peel the potatoes in 20 min' },
      { key: 'c', text: 'Baste 40 minutes later', from: 'a' },
      { key: 'd', text: 'Stir for 2 minutes' },
    ],
    [],
    ['Put the roast in {#put-the-roast}', 'Peel the potatoes T#20m', 'Baste T#40m:put-the-roast', 'Stir for 2 minutes'],
    [],
    false,
  ],
  // A step moved above the step it counts from.
  [
    [
      { key: 'c', text: 'Baste 40 minutes later', from: 'a' },
      { key: 'a', text: 'Put the roast in' },
    ],
    [],
    ['Baste T#40m:put-the-roast', 'Put the roast in {#put-the-roast}'],
    [],
    true,
  ],
  // Text marked `keep` stays as typed. An empty row is left out.
  [
    [
      { key: 'b', text: 'Peel the potatoes in 20 min', keep: true },
      { key: 'e', text: '  ' },
    ],
    [],
    ['Peel the potatoes in 20 min'],
    [],
    false,
  ],
  // Counting from a step that is already in the template gives that step a name.
  [
    [{ key: 'x', text: 'Baste in 40 min', from: 'task:1' }],
    [{ key: 'task:1', text: 'Put the roast in' }],
    ['Baste T#40m:put-the-roast'],
    [{ key: 'task:1', title: 'Put the roast in {#put-the-roast}' }],
    false,
  ],
  // Counting from the previous step again. A name that is already used gets a number.
  [
    [
      { key: 'a', text: 'Put {#roast}' },
      { key: 'b', text: 'Baste T#40m:roast', from: '' },
    ],
    [],
    ['Put {#roast}', 'Baste T#40m'],
    [],
    false,
  ],
  [
    [
      { key: 'a', text: 'Check it {#check-it}' },
      { key: 'b', text: 'Check it' },
      { key: 'c', text: 'Again in 5 min', from: 'b' },
    ],
    [],
    ['Check it {#check-it}', 'Check it {#check-it-2}', 'Again T#5m:check-it-2'],
    [],
    false,
  ],
  // A time in words before punctuation. The time words are removed and the T# token is added at the end.
  [
    [
      { key: 'a', text: 'Baste in 20 min.' },
      { key: 'b', text: 'Flip it after 5 minutes, then season' },
    ],
    [],
    ['Baste. T#20m', 'Flip it, then season T#5m'],
    [],
    false,
  ],
  // A priority like !2 stays a priority. Only punctuation that ends a word is moved back to that word.
  [[{ key: 'a', text: 'Baste !2 in 20 min' }], [], ['Baste !2 T#20m'], [], false],
  // Counting from a step that doesn't exist is a problem. It does not fall back to the previous step.
  [
    [{ key: 'a', text: 'Baste in 20 min', from: 'task:99' }],
    [{ key: 'task:1', text: 'Put the roast in' }],
    ['Baste T#20m'],
    [],
    true,
  ],
  // A generated name doesn't end on a small word.
  [
    [
      { key: 'a', text: 'Warm up the press' },
      { key: 'b', text: 'Check in 5 min', from: 'a' },
    ],
    [],
    ['Warm up the press {#warm-up}', 'Check T#5m:warm-up'],
    [],
    false,
  ],
];

// The line in a project's description that makes it a checklist project. It must be a line of its own, anywhere in the description.
const marks = [
  ['<p>pocket:checklists</p>', true],
  ['<p>Line 2 startups</p><p>Pocket:Checklists </p>', true],
  ['Notes<br>pocket:checklists', true],
  ['<p>Our safety checklists</p>', false],
  ['<p>see pocket:checklists in the docs</p>', false],
  ['', false],
];
// A template's step order is a line in its description: [description, the order parsed, the step ids as displayed].
const S = [{ id: 9 }, { id: 3 }, { id: 12 }, { id: 5 }]; // as Vikunja returns them, in no set order
const orders = [
  ['<p>Notes</p><p>pocket:order 9 3 5 12</p>', [9, 3, 5, 12], [9, 3, 5, 12]],
  ['<p>pocket:order 12 5</p>', [12, 5], [12, 5, 3, 9]], // steps the line doesn't list follow, in the order they were made
  ['<p>pocket:order 40 9 41</p>', [40, 9, 41], [9, 3, 5, 12]], // ids that are no longer steps are skipped
  ['<p>Notes</p>', null, [3, 5, 9, 12]],
  ['<p>pocket:order</p>', [], [3, 5, 9, 12]],
  ['', null, [3, 5, 9, 12]],
  ['<p>see pocket:order 9 3 in the docs</p>', null, [3, 5, 9, 12]],
  ['<p>pocket:order 12 5<br>Bring cash for the float</p>', [12, 5], [12, 5, 3, 9]], // one line of a paragraph (Shift+Enter)
  ['<p>pocket:order 12</p><p>pocket:order 5</p>', [12], [12, 3, 5, 9]],
  ['<ul><li>pocket:order 12</li></ul>', null, [3, 5, 9, 12]],
];
// Writing the order: [description, ids, the resulting description].
const orderWrites = [
  ['<p>Notes</p>', [5, 3], '<p>Notes</p><p>pocket:order 5 3</p>'],
  ['', [5], '<p>pocket:order 5</p>'],
  ['<p>pocket:order 3 5</p><p>Notes</p>', [5, 3], '<p>pocket:order 5 3</p><p>Notes</p>'],
  ['<p>Notes</p><p>pocket:order 3 5</p>', null, '<p>Notes</p>'],
  ['<p>pocket:order 3 5<br>Bring cash</p>', [5, 3], '<p>pocket:order 5 3<br>Bring cash</p>'],
  ['<p>pocket:order 3 5<br>Bring cash</p>', null, '<p>Bring cash</p>'],
  ['<p>Bring cash<br>pocket:order 3 5</p>', null, '<p>Bring cash</p>'],
  ['<p>pocket:order 3</p><p>pocket:order 5</p>', [9], '<p>pocket:order 9</p>'],
  ['<ul><li>pocket:order 3</li></ul>', [9], '<ul><li>pocket:order 3</li></ul><p>pocket:order 9</p>'],
];

// ---------- run the cases in the browser ----------
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${http.address().port}/`);
await page.waitForFunction(() => typeof parseCapture === 'function' && typeof chrono !== 'undefined');
const PROJECTS = ['project', 'project with long name', 'today', 'project1'].map((title, i) => ({ id: i + 1, title }));
const results = await page.evaluate(
  ([cases, projects]) =>
    cases.map(c => {
      const r = parseCapture(c.text, projects, {
        now: new Date(c.now),
        dueTime: c.dueTime,
        ignore: c.ignore,
        mode: c.mode,
      });
      return {
        title: r.title,
        date: r.due && `${r.due.getFullYear()}-${r.due.getMonth() + 1}-${r.due.getDate()}`,
        time: r.due && `${r.due.getHours()}:${r.due.getMinutes()}`,
        repeat: r.repeat && { after: r.repeat.after, mode: r.repeat.mode },
        labels: r.labels,
        assignees: r.assignees,
        project: r.project?.title ?? r.projectMiss,
        priority: r.priority,
        pct: r.pct,
        marks: r.marks,
      };
    }),
  [cases.map(c => ({ ...c, now: +(c.now || REF) })), PROJECTS],
);
const listResults = await page.evaluate(lists => lists.map(l => captureLines(l.text)), lists);
// Each line's text, whether it is done, and whether the line's text starts at the position the parser reports in the original text.
const readResults = await page.evaluate(
  reads =>
    reads.map(r => {
      const { names, ...opts } = r.opts,
        list = readList(r.text, opts);
      return {
        names: list.names,
        lines: list.lines.map(l => [l.text, l.done]),
        placed: list.lines.every(l => r.text.slice(l.at, l.at + l.text.length) === l.text),
        marked: list.lines.map(l => (l.mark ? r.text.slice(...l.mark) : '')),
        under: list.lines.map(l => l.under),
        first: list.first,
      };
    }),
  reads,
);
const stepResults = await page.evaluate(steps => steps.map(([text]) => parseStep(text)), steps);
const phraseResults = await page.evaluate(ps => ps.map(([text]) => readStepPhrase(text)?.offset ?? null), phrases);
const draftResults = await page.evaluate(
  ds =>
    ds.map(([rows, before]) => {
      const d = draftSteps(
        rows.map(r => ({ keep: false, from: null, ...r })),
        before,
      );
      return { added: d.added, renames: d.renames, problem: d.problem };
    }),
  drafts,
);
const templateResults = await page.evaluate(
  ts => ts.map(([titles]) => stepProblems(titles).map(p => p.text)),
  templates,
);
const collisionResults = await page.evaluate(
  ([cs, projects]) =>
    cs.map(([text, token, mode]) => {
      const read = t => {
        const r = parseCapture(t, projects, { now: new Date(2021, 5, 24, 12, 0), mode });
        return { title: r.title, due: r.due && r.due.getTime(), project: r.project?.title ?? null, labels: r.labels };
      };
      return [read(text), read(text + ' ' + token)];
    }),
  [collisions, PROJECTS],
);
const markResults = await page.evaluate(marks => marks.map(([html]) => isChecklistDesc(html)), marks);
const orderResults = await page.evaluate(
  ([os, steps]) =>
    os.map(([html]) => [
      stepOrder(html),
      stepsOf({ labels: [{ title: 'template' }], description: html, related_tasks: { subtask: steps } }).map(s => s.id),
    ]),
  [orders, S],
);
const orderWriteResults = await page.evaluate(ws => ws.map(([html, ids]) => withOrder(html, ids)), orderWrites);
// Late: [due, now, late?]. A time of day is late once it has passed, noon included. Midnight means a day with no
// time, and it is late only once that day is over.
const lates = [
  ['2021-06-24T09:30', '2021-06-24T10:00', true],
  ['2021-06-24T10:30', '2021-06-24T10:00', false],
  ['2021-06-24T12:00', '2021-06-24T15:00', true],
  ['2021-06-24T00:00', '2021-06-24T15:00', false],
  ['2021-06-24T09:00', '2021-06-24T15:00', true],
  ['2021-06-23T00:00', '2021-06-24T08:00', true],
];
const lateResults = await page.evaluate(
  ls => ls.map(([due, now]) => isLate(new Date(due).toISOString(), new Date(now))),
  lates,
);
// A started checklist's steps are ordered by the order line in its description, then by id, whatever order Vikunja
// returns them in.
const runOrder = await page.evaluate(() => [
  stepsOf({ related_tasks: { copiedfrom: [{ id: 1 }], subtask: [{ id: 9 }, { id: 3 }] } }).map(s => s.id),
  stepsOf({
    description: '<p>pocket:run</p><p>pocket:order 9 12 3</p>',
    related_tasks: { subtask: [{ id: 3 }, { id: 12 }, { id: 9 }, { id: 20 }] },
  }).map(s => s.id),
]);
// An inserted step goes before the step given. If that step is gone, it goes after the step it was inserted under.
// If that step is gone too, it goes at the end. A step already in the list is not added twice.
const placed = await page.evaluate(() => [
  placeBefore([3, 9, 12], 20, 9),
  placeBefore([3, 9, 12], 20, 99),
  placeBefore([3, 20, 9], 20, 12),
  placeBefore([3, 9, 12], 20, 99, 3),
  placeBefore([3, 9, 12], 20, 99, 98),
]);
// A step added while a checklist is running is labelled "Inserted", or "Repeated" if it keeps the step line of the
// step it repeats. Pocket's own lines are not part of the notes.
const addeds = await page.evaluate(() => [
  addedText(withAdded('<p>Mind the hot plate</p>')),
  addedText(withAdded(withStepLine('', 'Taste T#5m'))),
  addedText('<p>pocket:step Taste T#5m</p>'),
  notesOnly(withAdded(withStepLine('<p>Mind the hot plate</p>', 'Taste T#5m'))),
]);
// A line from a newer Pocket, "pocket:later", is not a note either, and editing the notes keeps it. A note that merely
// starts with "pocket: " is a note.
const unknownLines = await page.evaluate(() => {
  const from = '<p>pocket:later 7</p><p>Mind the hot plate</p><p>pocket: keys</p><p>pocket:step Taste T#5m</p>';
  return [notesOnly(from), withLinesOf('<p>New note</p>', from)];
});
// Asks are read from a description's lines with their formatting ignored, because Vikunja's editor turns typed marks
// and links into tags. A line in a list is not an ask. An answer comment's lines are read the same way.
const asksRead = await page.evaluate(() => {
  const read = stepAsks(
    '<p>Read the probe.</p><p>pocket:ask Where: choice see <a href="https://example.com">https://example.com</a> | <em>draft</em> | <code>code</code></p>' +
      '<ul><li>pocket:ask Belt: choice A | B</li></ul><p>Notes<br>pocket:ask Temp: number °C 0..5</p>',
  );
  // A checklist's copy of a step drops the lines that place the step, and keeps its asks and any other line in place.
  const tpl =
    '<p>Read the probe.</p><p>pocket:ask Temp: number °C 0..5</p><p>pocket:step Old title</p><p>pocket:added</p><p>pocket:ask Seal: yes-no</p><p>pocket:later 7</p>';
  return [
    read.asks.map(a => [a.label, a.options || a.unit]),
    read.bad,
    textLines('<p>Temp: 7 °C</p><p>Notes: Door open — again…</p><p>pocket:answer</p>'),
    withStepLine(copiedNotes(tpl), 'Check the cooler'),
    // The asks editor replaces the ask lines, also one with formatting or on a line of its own in a paragraph, and
    // leaves the rest. A line in a list is not an ask.
    withAskLines(
      '<p>Notes</p><p>pocket:ask Where: choice see <a href="https://example.com">it</a> | <em>draft</em></p><p>Tail<br>pocket:ask Old: text</p>' +
        '<ul><li>pocket:ask Kept: text</li></ul>',
      ['pocket:ask Temp: number °C 0..5'],
    ),
    // An answer waiting to be sent counts over an older one from Vikunja.
    // A line of Pocket's that the editor split with formatting is left out of the notes whole, and editing the notes in
    // Pocket keeps it whole.
    notesOnly(
      '<p>Read.</p><p>pocket:ask Where: choice see <a href="https://example.com">it</a> | <em>draft</em></p><p>pocket:order 3<br>Bring cash</p>',
    ),
    withLinesOf(
      '<p>New</p>',
      '<p>Read.</p><p>pocket:ask Where: choice see <a href="https://example.com">it</a> | <em>draft</em></p>',
    ),
    (({ answers }) => [
      answers.temp.text,
      answers.temp.off,
      answers.temp.waiting,
      answers.seal.text,
      answers.seal.author,
      answers.seal.mine,
    ])(
      stepAnswers(
        {
          description: '<p>pocket:ask Temp: number °C 0..5</p><p>pocket:ask Seal: yes-no</p>',
          comments: [
            {
              id: 1,
              comment: '<p>Temp: 7 °C</p><p>Seal: yes</p><p>pocket:answer</p>',
              author: { id: 2, name: 'Jamie' },
              created: '2026-10-14T09:00:00Z',
            },
            {
              id: 'e1',
              comment: '<p>Temp: 3 °C</p><p>pocket:answer</p>',
              author: { id: 1, name: 'Me' },
              created: '2026-10-14T09:05:00Z',
              waiting: true,
            },
          ],
        },
        { id: 1, name: 'Me' },
      ),
    ),
  ];
});
// After Cancel, an answer is named by its ask's label, or by its step when it holds several answers or its ask has no
// label.
const answerWords = await page.evaluate(() =>
  ['<p>Oil level: 5 mm</p>', '<p>Oil level: 5 mm</p><p>Colour: Amber</p>', '<p>5 mm</p>'].map(html =>
    OP_WORDS.answer.dropped({ op: 'answer', html: html + '<p>pocket:answer</p>' }, 'Check the oil'),
  ),
);
// How a finished checklist went: its skipped steps, and its comments without the answers to asks. A step's comments
// are read as HTML. An open step has only its count of comments.
const ended = await page.evaluate(() => {
  const under = { parenttask: [{ id: 1 }] },
    at = '2026-10-13T10:00:00Z';
  const skipped = {
    id: 2,
    done: true,
    done_at: at,
    related_tasks: under,
    reactions: { '⏭️': [{ id: 9 }] },
    comments: [{ comment: '<p>Skipped: no milk</p>', author: { id: 9 }, created: '2026-10-13T10:00:01Z' }],
  };
  const answered = {
    id: 3,
    done: true,
    done_at: at,
    related_tasks: under,
    comments: [{ comment: '<p>Temp: 4 °C</p><p>pocket:answer</p>' }],
  };
  const open = { id: 4, done: false, related_tasks: under, comment_count: 2 },
    other = { id: 5, done: true, related_tasks: { parenttask: [{ id: 99 }] }, comments: [{ comment: '<p>x</p>' }] };
  return endedOf([{ id: 1, comments: [{ comment: '<p>Line 2 ran slow</p>' }] }], [skipped, answered, open, other]);
});
// Templates. A task labelled "template" in a Checklists project is a template. One that is open with no date, or a copy
// being set up as a checklist, never comes round. A run line makes a checklist, and a step or added
// line makes a checklist's step (the rest of the roles are in tests/unit/checklists.test.mjs). Also covered are the
// template's name without "TEMPLATE: ", its repeat in words, and the date Vikunja moves it to when it is ticked, as
// checked on Vikunja 2.7.
const rounds = await page.evaluate(() => {
  const L = [{ title: 'template' }],
    due = '2026-09-15T19:09:31Z',
    now = Date.parse('2026-10-06T18:09:31Z'),
    at = ms => (ms === null ? null : new Date(ms).toISOString());
  const role = t => roleOf({ project_id: 7, ...t }, { checklistIds: new Set([7]) }),
    under = { parenttask: [{ id: 1 }] };
  return [
    role({ labels: L, done: true }),
    role({ labels: L, done: false, due_date: due }),
    role({ labels: L, done: false, due_date: '0001-01-01T00:00:00Z' }),
    comesRound({ labels: L, done: false, due_date: due, related_tasks: { copiedfrom: [{ id: 1 }] } }),
    comesRound({ labels: L, done: false, due_date: due, description: '<p>pocket:run</p>' }),
    role({ labels: L, done: true, related_tasks: under }),
    role({ labels: [], done: true }),
    role({ description: '<p>pocket:run</p>' }),
    role({ labels: L, description: '<p>pocket:run</p>' }),
    role({ related_tasks: under, description: '<p>pocket:step Roast T#40m</p>' }),
    role({ related_tasks: under, description: '<p>pocket:added</p>' }),
    role({ project_id: 5, description: '<p>pocket:run</p>' }),
    templateName('TEMPLATE: Opening up'),
    templateName('Opening up'),
    templateTitle('template: Opening up'),
    ...[
      { repeat_after: 86400 },
      { repeat_after: 3 * 86400 },
      { repeat_after: 604800 },
      { repeat_after: 1209600 },
      { repeat_mode: 1 },
      { repeat_after: 6 * 3600 },
      { repeat_mode: 2, repeat_after: 86400 },
      {},
    ].map(repeatWords),
    at(vikunjaNext({ due_date: due, repeat_after: 86400 }, now)), // every day, 3 weeks late: the next 19:09 after now
    at(vikunjaNext({ due_date: '2026-10-07T18:09:31Z', repeat_after: 86400 }, now)), // ticked early: still one day later
    at(vikunjaNext({ due_date: due, repeat_mode: 1 }, now)), // every month: one month later
    at(vikunjaNext({ due_date: '2026-07-06T18:09:31Z', repeat_mode: 1 }, now)), // every month, still late after one month
    at(nextAfter({ repeat_mode: 1 }, Date.parse('2026-08-06T18:09:31Z'), now)), // Pocket moves it past now
    at(vikunjaNext({ due_date: due, repeat_after: 86400, repeat_mode: 2 }, now)),
    at(vikunjaNext({ due_date: due }, now)),
  ];
});
await browser.close();
http.close();

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let failed = 0;
cases.forEach((c, i) => {
  const r = results[i],
    bad = [];
  if ('title' in c && r.title !== c.title) bad.push(`title "${r.title}"`);
  if (c.date === 'any') {
    if (!r.date) bad.push('no date');
  } else if ('date' in c && r.date !== c.date) bad.push(`date ${r.date}`);
  if ('time' in c && r.time !== c.time) bad.push(`time ${r.time}`);
  for (const k of ['repeat', 'labels', 'assignees', 'project', 'priority', 'pct'])
    if (k in c && !same(r[k], c[k])) bad.push(`${k} ${JSON.stringify(r[k])}`);
  const marked = r.marks.map(m => m.kind + ':' + c.text.slice(m.start, m.end));
  if ('marked' in c && !same(marked, c.marked)) bad.push(`marked ${JSON.stringify(marked)}`);
  // The marks cover what was parsed. Replacing each with the text it leaves in the title (`kept`, or nothing) leaves
  // the title, apart from spaces. @username stays. Quotes around a title at the start of the
  // text are removed too.
  if (c.mode !== 'disabled') {
    let rest = c.text;
    for (const m of [...r.marks].reverse())
      if (m.kind !== 'assignees') rest = rest.slice(0, m.start) + ` ${m.kept ?? ''} ` + rest.slice(m.end);
    const hold = rest.match(/^(\s*)(["'])([\s\S]*?)\2(?=\s|$)/);
    if (hold) rest = hold[1] + hold[3] + rest.slice(hold[0].length);
    if (rest.replace(/\s+/g, '') !== r.title.replace(/\s+/g, ''))
      bad.push(`marks leave "${rest.replace(/\s+/g, ' ').trim()}"`);
  }
  if (bad.length) {
    failed++;
    console.log(`FAIL ${JSON.stringify(c.text)}${c.pocket ? ` [Pocket: ${c.why}]` : ''}: ${bad.join(', ')}`);
  }
});
lists.forEach((l, i) => {
  if (!same(listResults[i], l.lines)) {
    failed++;
    console.log(`FAIL pasted list [${l.why}]: ${JSON.stringify(listResults[i])}`);
  }
});
reads.forEach((r, i) => {
  const got = readResults[i];
  if (!same(got.lines, r.lines) || !got.placed) {
    failed++;
    console.log(`FAIL read ${JSON.stringify(r.text)} [${r.why}]: ${JSON.stringify(got)}`);
  }
  if ('marked' in r && !same(got.marked, r.marked)) {
    failed++;
    console.log(`FAIL marked in ${JSON.stringify(r.text)} [${r.why}]: ${JSON.stringify(got.marked)}`);
  }
  if ('under' in r && (!same(got.under, r.under) || got.first !== r.first)) {
    failed++;
    console.log(
      `FAIL which line each is under in ${JSON.stringify(r.text)} [${r.why}]: ${JSON.stringify(got.under)}, first ${got.first}`,
    );
  }
  if (r.opts.names && !same(got.names, r.opts.names)) {
    failed++;
    console.log(`FAIL the list's name in ${JSON.stringify(r.text)} [${r.why}]: ${JSON.stringify(got.names)}`);
  }
});
steps.forEach(([text, title, offset, name, ref, problems], i) => {
  const r = stepResults[i];
  if (r.title !== title || r.offset !== offset || r.name !== name || r.ref !== ref || r.problems.length !== problems) {
    failed++;
    console.log(`FAIL step ${JSON.stringify(text)}: ${JSON.stringify(r)}`);
  }
});
phrases.forEach(([text, want], i) => {
  if (phraseResults[i] !== want) {
    failed++;
    console.log(`FAIL step time in words ${JSON.stringify(text)}: ${phraseResults[i]}`);
  }
});
drafts.forEach(([rows, , added, renames, problem], i) => {
  const r = draftResults[i];
  if (!same(r.added, added) || !same(r.renames, renames) || r.problem !== problem) {
    failed++;
    console.log(`FAIL steps written ${JSON.stringify(rows.map(x => x.text))}: ${JSON.stringify(r)}`);
  }
});
templates.forEach(([titles, want], i) => {
  const got = templateResults[i];
  if (got.length !== want.length || want.some((w, j) => !got[j].includes(w))) {
    failed++;
    console.log(`FAIL template ${JSON.stringify(titles)}: ${JSON.stringify(got)}`);
  }
});
collisions.forEach(([text, token], i) => {
  const [plain, withToken] = collisionResults[i];
  if (!same({ ...plain, title: plain.title + ' ' + token }, withToken)) {
    failed++;
    console.log(
      `FAIL ${JSON.stringify(text + ' ' + token)}: ${JSON.stringify(withToken)}, without it ${JSON.stringify(plain)}`,
    );
  }
  if (!plain.due && !plain.project && !plain.labels.length) {
    failed++;
    console.log(`FAIL ${JSON.stringify(text)} reads nothing, so it shows no collision`);
  }
});
marks.forEach(([html, want], i) => {
  if (markResults[i] !== want) {
    failed++;
    console.log(`FAIL checklist marker ${JSON.stringify(html)}: ${markResults[i]}`);
  }
});
orders.forEach(([html, order, shown], i) => {
  if (!same(orderResults[i], [order, shown])) {
    failed++;
    console.log(`FAIL step order ${JSON.stringify(html)}: ${JSON.stringify(orderResults[i])}`);
  }
});
orderWrites.forEach(([html, ids, want], i) => {
  if (orderWriteResults[i] !== want) {
    failed++;
    console.log(`FAIL step order written ${JSON.stringify([html, ids])}: ${orderWriteResults[i]}`);
  }
});
lates.forEach(([due, now, want], i) => {
  if (lateResults[i] !== want) {
    failed++;
    console.log(`FAIL late ${JSON.stringify([due, now])}: ${lateResults[i]}`);
  }
});
if (
  !same(runOrder, [
    [3, 9],
    [9, 12, 3, 20],
  ])
) {
  failed++;
  console.log(`FAIL a run's steps by its order line then id: ${JSON.stringify(runOrder)}`);
}
if (
  !same(placed, [
    [3, 20, 9, 12],
    [3, 9, 12, 20],
    [3, 20, 9],
    [3, 20, 9, 12],
    [3, 9, 12, 20],
  ])
) {
  failed++;
  console.log(`FAIL placing an inserted step: ${JSON.stringify(placed)}`);
}
if (!same(addeds, ['Inserted', 'Repeated', '', '<p>Mind the hot plate</p>'])) {
  failed++;
  console.log(`FAIL steps added during a run: ${JSON.stringify(addeds)}`);
}
if (
  !same(unknownLines, [
    '<p>Mind the hot plate</p><p>pocket: keys</p>',
    '<p>New note</p><p>pocket:step Taste T#5m</p><p>pocket:later 7</p>',
  ])
) {
  failed++;
  console.log(`FAIL a line from a newer Pocket: ${JSON.stringify(unknownLines)}`);
}
if (
  !same(asksRead, [
    [
      ['Where', ['see https://example.com', 'draft', 'code']],
      ['Temp', '°C'],
    ],
    [],
    ['Temp: 7 °C', 'Notes: Door open — again…', 'pocket:answer'],
    '<p>Read the probe.</p><p>pocket:ask Temp: number °C 0..5</p><p>pocket:ask Seal: yes-no</p><p>pocket:later 7</p><p>pocket:step Check the cooler</p>',
    '<p>Notes</p><p>Tail</p><ul><li>pocket:ask Kept: text</li></ul><p>pocket:ask Temp: number °C 0..5</p>',
    '<p>Read.</p><p>Bring cash</p>',
    '<p>New</p><p>pocket:ask Where: choice see it | draft</p>',
    ['3 °C', false, 'e1', 'Yes', 'Jamie', false],
  ])
) {
  failed++;
  console.log(`FAIL asks and answers read from HTML: ${JSON.stringify(asksRead)}`);
}
const roundsWant = [
  'template',
  'template',
  'template',
  false,
  false,
  null,
  'candidate',
  'run',
  'template',
  'step',
  'step',
  null,
  'Opening up',
  'Opening up',
  'TEMPLATE: Opening up',
  'every day',
  'every 3 days',
  'every week',
  'every 2 weeks',
  'every month',
  'every 6 hours',
  'every day after a checklist starts',
  '',
  '2026-10-06T19:09:31.000Z',
  '2026-10-08T18:09:31.000Z',
  '2026-10-15T19:09:31.000Z',
  '2026-08-06T18:09:31.000Z',
  '2026-11-06T18:09:31.000Z',
  '2026-10-07T18:09:31.000Z',
  null,
];
if (
  !same(answerWords, [
    "Your answer to “Oil level” isn't saved.",
    "Your answers to “Check the oil” aren't saved.",
    "Your answer to “Check the oil” isn't saved.",
  ])
) {
  failed++;
  console.log(`FAIL an answer's words after Cancel: ${JSON.stringify(answerWords)}`);
}
if (!same(ended, { 1: { skipped: 1, comments: 4 } })) {
  failed++;
  console.log(`FAIL how a finished checklist went: ${JSON.stringify(ended)}`);
}
if (!same(rounds, roundsWant)) {
  failed++;
  console.log(`FAIL templates that come round: ${JSON.stringify(rounds)}`);
}
const wf =
    steps.length +
    templates.length +
    collisions.length +
    phrases.length +
    drafts.length +
    marks.length +
    orders.length +
    orderWrites.length +
    lates.length +
    7,
  total = cases.length + lists.length + reads.length + wf;
console.log(
  `${total - failed} of ${total} passed (${cases.filter(c => c.pocket).length} are Pocket-specific, ${lists.length + reads.length} are pasted lists, ${wf} are checklist steps and markers)`,
);
process.exitCode = failed ? 1 : 0;
