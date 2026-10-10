// Quick-add parsing tests. No server needed:
//
//   npm run test:parse
//
// Loads src/js/quickadd.js and src/js/checklists.js in a headless browser, with chrono from pocket/app/, and runs
// parseCapture() on each phrase with a fixed "now", captureLines() on a few pasted lists, and the checklist steps' own
// reading on steps. It tests src/ as it is, so there's no need to build first.
// The phrases and expectations are adapted from Vikunja's own Quick Add Magic tests
// (frontend/src/modules/quickAddMagic/quickAddMagic.test.ts), so Pocket reads text the way Vikunja does.
// Cases marked `pocket` are where Pocket deliberately differs from Vikunja, or goes further; `why` says how.
// Optional: BROWSER_CHANNEL=msedge|chrome.
import { createServer } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
/* global parseCapture, captureLines, readList, parseStep, readStepPhrase, draftSteps, stepProblems, isChecklistDesc, stepOrder, withOrder, stepsOf, isLate, placeBefore, addedText, notesOnly, withAdded, withStepLine, isTemplate, templateName, templateTitle, repeatWords, vikunjaNext, nextAfter */

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript' };
// The page: the modules' functions, as globals for page.evaluate().
const CHRONO = (await readdir(resolve(ROOT, 'pocket/app'))).find(f => /^chrono-.*\.js$/.test(f));
const PAGE = `<!doctype html><script type="module">
import * as chrono from '/pocket/app/${CHRONO}'; window.chrono = chrono;
const quickadd = await import('/src/js/quickadd.js'), checklists = await import('/src/js/checklists.js'), dates = await import('/src/js/dates.js');
Object.assign(window, quickadd, checklists, dates);
</script>`;
const http = createServer(async (req, res) => {
  let file = '';
  try { file = resolve(ROOT, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname)); } catch {}
  if (file === ROOT) { res.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE); return; }
  if (![resolve(ROOT, 'src'), resolve(ROOT, 'pocket/app')].some(dir => file.startsWith(dir + sep))) { res.writeHead(404).end(); return; }
  let body;
  try { body = await readFile(file); } catch { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }).end(body);
}).listen(0, '127.0.0.1');
await new Promise(r => http.once('listening', r));

// ---------- helpers for writing expectations ----------
const REF = new Date(2021, 5, 24, 12, 0);             // Thursday 24 June 2021, noon (Vikunja's tests use this date)
const ymd = d => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
const plus = (n, from = REF) => { const d = new Date(from); d.setDate(d.getDate() + n); return ymd(d); };
const cases = [];
// c: {text, now?, dueTime?, ignore?, title?, date? ('Y-M-D' | null | 'any'), time? ('H:M'), repeat? ({after, mode} | null),
//     labels?, assignees?, project?, priority?, pct?, pocket?, why?}
const add = c => cases.push(c);

// ---------- general ----------
add({ text: 'Lorem Ipsum', title: 'Lorem Ipsum', date: null });
add({ text: 'Lorem Ipsum email@example.com', title: 'Lorem Ipsum email@example.com', date: null, assignees: [] });

// ---------- the user's Quick Add Magic mode ----------
add({ text: 'Lorem Ipsum today *label +project !2 @user', mode: 'disabled', title: 'Lorem Ipsum today *label +project !2 @user', date: null, labels: [], project: null, priority: 0, assignees: [] });
add({ text: 'Lorem Ipsum today @label #project !2 +user', mode: 'todoist', title: 'Lorem Ipsum +user', date: ymd(REF), labels: ['label'], project: 'project', priority: 2, assignees: ['user'] });
add({ text: '"task today @label #project"', mode: 'todoist', title: 'task today @label #project', date: null, labels: [], project: null });
add({ text: 'Mail bob@example.com tomorrow', mode: 'todoist', title: 'Mail bob@example.com', date: plus(1), labels: [], pocket: true, why: 'an email address is not a label' });

// ---------- quote-escaped text ----------
add({ text: '"delete mails up to january 30th"', title: 'delete mails up to january 30th', date: null, labels: [], project: null, priority: 0, assignees: [], repeat: null });
add({ text: "'buy mass tomorrow *label !2 @user'", title: 'buy mass tomorrow *label !2 @user', date: null, labels: [], priority: 0, assignees: [], repeat: null });
add({ text: '"delete mails today', date: 'any' });
add({ text: '"delete mails today\'', date: 'any' });
add({ text: 'delete "mails" today', date: 'any' });
add({ text: '""', title: '', date: null });
// Pocket's own: quotes round the start of the text hold its title, and the words after them are read as usual. A copied
// Markdown list quotes a title this way when quick add would read words in it (share.js).
const held = why => ({ pocket: true, why });
add({ text: '"Lunch friday" @sam 2026-10-16', title: 'Lunch friday @sam', assignees: ['sam'], date: '2026-10-16', marked: ['assignees:@sam', 'due:2026-10-16'], ...held('the title read as typed, the words after it as usual') });
add({ text: '"Call Bob tomorrow" tomorrow !2 *calls', title: 'Call Bob tomorrow', date: '2021-6-25', priority: 2, labels: ['calls'], ...held('the same word inside and after') });
add({ text: '\'Say "hi" friday\' every week', title: 'Say "hi" friday', repeat: { after: 604800, mode: 0 }, ...held('single quotes, for a title with a " in it') });
add({ text: '"Tables (50%)" (25%)', title: 'Tables (50%)', pct: 25, ...held('a figure after the quotes is its progress') });
add({ text: '"x-ray" the pipe friday', title: 'x-ray the pipe', date: '2021-6-25', ...held('the quotes end where a space follows: the rest is read') });
add({ text: '"Paint !2"coats !3', title: '"Paint !2"coats', priority: 3, ...held('with no space after them they hold nothing') });
add({ text: '"task today" +user @label', mode: 'todoist', title: 'task today +user', date: null, assignees: ['user'], labels: ['label'], ...held('with Todoist\'s prefixes') });
add({ text: '"Lunch friday" @sam', mode: 'disabled', title: '"Lunch friday" @sam', date: null, assignees: [], ...held('quick add turned off: as typed') });
add({ text: '" Lunch  friday " !3', title: 'Lunch  friday', priority: 3, date: null, ...held('as typed inside, but for the spaces at its ends') });

// ---------- default due time ----------
add({ text: 'plan this tomorrow', now: new Date(2026, 7, 4, 9, 15), dueTime: '14:30', date: '2026-8-5', time: '14:30' });
add({ text: 'plan this tomorrow', now: new Date(2026, 7, 4, 10, 15), date: '2026-8-5', time: '12:0' });

// ---------- day words ----------
add({ text: 'Lorem Ipsum ToDay', title: 'Lorem Ipsum', date: ymd(REF) });
add({ text: 'Lorem Ipsum today', title: 'Lorem Ipsum', date: ymd(REF) });
add({ text: 'Lorem Ipsum tonight', title: 'Lorem Ipsum', date: ymd(REF), time: '21:0' });
for (const [t, hm] of Object.entries({ 'at 15:00': '15:0', '@ 15:00': '15:0', 'at 15:30': '15:30', '@ 3pm': '15:0', 'at 3pm': '15:0', 'at 3 pm': '15:0',
  'at 3am': '3:0', 'at 3:12 am': '3:12', 'at 3:12 pm': '15:12', 'at 3:12 AM': '3:12', 'at 3:12 PM': '15:12', 'at 3:12 Am': '3:12', 'at 3:12 Pm': '15:12',
  'at 12:00 pm': '12:0', 'at 12:00 am': '0:0' }))
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
for (const c of ['renewed', 'github', 'fix monitor stand', 'order wedding cake', 'investigate thumping noise', 'iron frilly napkins', 'take photo of saturn',
  'fix sunglasses', 'monitor blood pressure', 'Monitor blood pressure', 'buy almonds', 'Renovation', 'Remark', 'Renovation - 2nd Floor Bath',
  'Remark - 13th floor', '13th floor - remark'])
  for (const t of [`${c} dolor sit amet`, `Lorem Ipsum ${c}`, `Lorem Ipsum ${c} dolor`, c]) add({ text: t, title: t, date: null });

// ---------- numeric dates only at the start or end ----------
for (const t of ['The 9/11 Report', 'The 01/02 Report', 'a]7/8 debate', 'The 1.2 formula', 'Lorem Ispum v1.1.1', 'https://some-url.org/blog/2019/1/233526-some-more-text'])
  add({ text: t, title: t, date: null });
for (const [text, date, title] of [['9/11 meeting', '2021-9-11', 'meeting'], ['meeting 9/11', '2021-9-11', 'meeting'], ['meeting 9/11 at 10:00', '2021-9-11', 'meeting'],
  ['meeting 9/11 @ 15:00', '2021-9-11', 'meeting'], ['2021-06-24 Lorem Ipsum', '2021-6-24', 'Lorem Ipsum'], ['Lorem Ipsum 06/26/2021', '2021-6-26', 'Lorem Ipsum'],
  ['01.02 Lorem Ipsum', '2022-2-1', 'Lorem Ipsum'], ['Lorem Ipsum 01.02', '2022-2-1', 'Lorem Ipsum'], ['The 9/11 Report due 10/12', '2021-10-12', 'The 9/11 Report due']])
  add({ text, date, title });

// ---------- weekdays ----------
const DAYS = { monday: 1, mon: 1, tuesday: 2, tue: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, friday: 5, fri: 5, saturday: 6, sat: 6, sunday: 0, sun: 0 };
for (const [d, n] of Object.entries(DAYS)) for (const w of [d, d[0].toUpperCase() + d.slice(1)]) {
  const date = plus((n - REF.getDay() + 7) % 7);
  for (const p of ['next ', '']) {
    add({ text: `Lorem Ipsum ${p}${w}`, title: 'Lorem Ipsum', date });
    add({ text: `${p}${w} Lorem Ipsum`, title: 'Lorem Ipsum', date });
  }
  for (const t of [`Lorem Ipsum ${w}ipsum`, `Lorem ipsum${w} dolor`, `Lorem Ipsum lorem${w}ipsum`]) add({ text: t, title: t, date: null });
}

// ---------- written dates ----------
// Vikunja keeps "21st June" style dates in the past when they've passed this year; Pocket always takes the next one.
const NEXT_YEAR = { pocket: true, why: 'the next one, not a date that has passed' };
const written = {
  '06/08/2021': '2021-6-8', '6/7/21': '2021-6-7', '27/07/2021,': null, '2021/07/06': '2021-7-6', '2021-07-06': '2021-7-6',
  '27 jan': '2022-1-27', '27/1': '2022-1-27', '27/01': '2022-1-27', '16/12': '2021-12-16', '01/27': '2022-1-27', '1/27': '2022-1-27',
  'jan 27': '2022-1-27', 'Jan 27': '2022-1-27', 'january 27': '2022-1-27', 'January 27': '2022-1-27', 'feb 21': '2022-2-21', 'February 21': '2022-2-21',
  'mar 21': '2022-3-21', 'March 21': '2022-3-21', 'apr 21': '2022-4-21', 'April 21': '2022-4-21', 'may 21': '2022-5-21', 'May 21': '2022-5-21',
  'jun 21': '2022-6-21', 'June 21': '2022-6-21', '22nd December': '2021-12-22', '23rd October': '2021-10-23', '4th July': '2021-7-4',
  '15th August': '2021-8-15', '31st December': '2021-12-31', '12th Sep': '2021-9-12', 'jul 21': '2021-7-21', 'July 21': '2021-7-21',
  'aug 21': '2021-8-21', 'August 21': '2021-8-21', 'sep 21': '2021-9-21', 'September 21': '2021-9-21', 'oct 21': '2021-10-21', 'October 21': '2021-10-21',
  'nov 21': '2021-11-21', 'November 21': '2021-11-21', 'dec 21': '2021-12-21', 'december 21': '2021-12-21',
  '01.02.2021': '2021-2-1', '01.02': '2022-2-1', '01.10': '2021-10-1', '01.02.25': '2025-2-1',
};
const writtenPocket = { '21st June': '2022-6-21', '2nd March': '2022-3-2', '2nd march': '2022-3-2', '3rd April': '2022-4-3', '1st January': '2022-1-1', '5th Mar': '2022-3-5' };
for (const [t, date] of Object.entries(written)) for (const text of [`Lorem Ipsum ${t}`, `${t} Lorem Ipsum`])
  add(date === null ? { text, date: null } : { text, date, title: 'Lorem Ipsum' });
for (const [t, date] of Object.entries(writtenPocket)) for (const text of [`Lorem Ipsum ${t}`, `${t} Lorem Ipsum`]) add({ text, date, title: 'Lorem Ipsum', ...NEXT_YEAR });

// ---------- "in ..." and dates with times ----------
for (const [text, dt, pocket] of [['Lorem Ipsum in 1 hour', '2021-6-24 13:0'], ['in 2 hours', '2021-6-24 14:0'], ['in 1 day', '2021-6-25 12:0'], ['in 2 days', '2021-6-26 12:0'],
  ['in 1 week', '2021-7-1 12:0'], ['in 2 weeks', '2021-7-8 12:0'], ['in 4 weeks', '2021-7-22 12:0'], ['in 1 month', '2021-7-24 12:0'], ['in 3 months', '2021-9-24 12:0'],
  ['Something in 5 days at 10:00', '2021-6-29 10:0'], ['Something 17th at 10:00', '2021-7-17 10:0'], ['Something sep 17 at 10:00', '2021-9-17 10:0'],
  ['Something sep 17th at 10:00', '2021-9-17 10:0'], ['Something at 10:00 in 5 days', '2021-6-29 10:0'], ['Something at 10:00 17th', '2021-7-17 10:0'],
  ['Something at 10:00 sep 17th', '2021-9-17 10:0'], ['2nd March at 5', '2022-3-2 17:0', 1], ['2nd March at 5pm', '2022-3-2 17:0', 1], ['2nd March @ 14:00', '2022-3-2 14:0', 1],
  ['3rd April at 10:30', '2022-4-3 10:30', 1], ['15th August @ 9am', '2021-8-15 9:0'], ['21st June at 18:45', '2022-6-21 18:45', 1], ['5th Mar at 3pm', '2022-3-5 15:0', 1],
  ['Some task Mar 8th', '2022-3-8 12:0', 1], ['Some task mar 8th', '2022-3-8 12:0', 1]]) {
  const [date, time] = dt.split(' ');
  const title = text.startsWith('Something') ? 'Something' : text.startsWith('Some task') ? 'Some task' : text.startsWith('Lorem') ? 'Lorem Ipsum' : '';
  add({ text, date, time, title, ...(pocket ? NEXT_YEAR : {}) });
}

// ---------- labels ----------
add({ text: 'Lorem Ipsum *label1 *label2', title: 'Lorem Ipsum', labels: ['label1', 'label2'] });
add({ text: '*label1 Lorem Ipsum *label2', title: 'Lorem Ipsum', labels: ['label1', 'label2'] });
add({ text: 'Lorem Ipsum *label1 *label1 *label2', title: 'Lorem Ipsum', labels: ['label1', 'label2'] });
add({ text: "Lorem *'label with space' Ipsum", title: 'Lorem Ipsum', labels: ['label with space'] });
add({ text: 'Lorem *"label with space" Ipsum', title: 'Lorem Ipsum', labels: ['label with space'] });
add({ text: 'Lorem Ipsum *today', title: 'Lorem Ipsum', labels: ['today'], date: null });
add({ text: 'a *"a (a)"', title: 'a', labels: ['a (a)'] });
add({ text: '*"a (a)" a', title: 'a', labels: ['a (a)'] });

// ---------- project ----------
add({ text: 'Lorem Ipsum +project', title: 'Lorem Ipsum', project: 'project' });
add({ text: "Lorem Ipsum +'project with long name'", title: 'Lorem Ipsum', project: 'project with long name' });
add({ text: 'Lorem Ipsum +"project with long name"', title: 'Lorem Ipsum', project: 'project with long name' });
add({ text: 'Lorem Ipsum +project1 +project2 +project3', title: 'Lorem Ipsum +project2 +project3', project: 'project1' });
add({ text: 'Lorem Ipsum +today', title: 'Lorem Ipsum', project: 'today', date: null });

// ---------- priority ----------
for (const p of [1, 2, 3, 4, 5]) add({ text: `Lorem Ipsum !${p}`, title: 'Lorem Ipsum', priority: p });
add({ text: 'Lorem Ipsum !9999', title: 'Lorem Ipsum !9999', priority: 0 });
add({ text: 'Lorem Ipsum !9999 !1', title: 'Lorem Ipsum !9999', priority: 1 });

// ---------- assignees (they stay in the title, as in Vikunja) ----------
add({ text: 'Lorem Ipsum @user', title: 'Lorem Ipsum @user', assignees: ['user'] });
add({ text: 'Lorem Ipsum @user1 @user2 @user3', title: 'Lorem Ipsum @user1 @user2 @user3', assignees: ['user1', 'user2', 'user3'] });
add({ text: 'Lorem Ipsum @user1 @user1 @user2', title: 'Lorem Ipsum @user1 @user1 @user2', assignees: ['user1', 'user2'] });
add({ text: "Lorem Ipsum @'user with long name'", title: "Lorem Ipsum @'user with long name'", assignees: ['user with long name'] });
add({ text: 'Lorem Ipsum @"user with long name"', title: 'Lorem Ipsum @"user with long name"', assignees: ['user with long name'] });
add({ text: 'Lorem Ipsum @today', title: 'Lorem Ipsum @today', assignees: ['today'], date: null });
add({ text: 'Lorem Ipsum @email@example.com', title: 'Lorem Ipsum @email@example.com', assignees: ['email@example.com'] });

// ---------- repeating ----------
const H = 3600, D = 86400, W = 604800, M = 30 * D, Y = 365 * D;
const MONTHLY = { after: 0, mode: 1 };                // Pocket: "every month" keeps the day of month; Vikunja uses 30 days
const repeats = {
  'every 1 hour': H, 'every hour': H, 'every 5 hours': 5 * H, 'every 12 hours': 12 * H, 'every day': D, 'every 1 day': D, 'every 2 days': 2 * D,
  'every week': W, 'every 1 week': W, 'every 3 weeks': 3 * W, 'every month': MONTHLY, 'every 1 month': MONTHLY, 'every 2 months': 2 * M,
  'every year': Y, 'every 1 year': Y, 'every 4 years': 4 * Y, 'every one hour': H, 'every two hours': 2 * H, 'every three hours': 3 * H,
  'every four hours': 4 * H, 'every five hours': 5 * H, 'every six hours': 6 * H, 'every seven hours': 7 * H, 'every eight hours': 8 * H,
  'every nine hours': 9 * H, 'every ten hours': 10 * H, 'annually': Y, 'biannually': 6 * M, 'semiannually': 6 * M, 'biennially': 2 * Y,
  'daily': D, 'hourly': H, 'monthly': MONTHLY, 'weekly': W, 'yearly': Y,
};
const MORNING = new Date(2021, 5, 24, 10, 0);
for (const [t, r] of Object.entries(repeats)) {
  const repeat = typeof r === 'number' ? { after: r, mode: 0 } : r, extra = typeof r === 'number' ? {} : { pocket: true, why: 'monthly on the same day, not every 30 days' };
  add({ text: `Lorem Ipsum ${t}`, title: 'Lorem Ipsum', repeat, ...extra });
  add({ text: `Lorem Ipsum ${t} at 11:42`, now: MORNING, title: 'Lorem Ipsum', repeat, date: ymd(MORNING), time: '11:42', ...extra });
}
for (const w of ['annually', 'biannually', 'semiannually', 'biennially', 'daily', 'hourly', 'monthly', 'weekly', 'yearly'])
  add({ text: `Lorem Ipsum word${w}notword`, title: `Lorem Ipsum word${w}notword`, repeat: null });

// ---------- Pocket's own additions ----------
const extra = why => ({ pocket: true, why });
add({ text: 'Team sync every monday at 10', title: 'Team sync', repeat: { after: W, mode: 0 }, date: plus(4), time: '10:0', ...extra('"every monday"') });
add({ text: 'Water plants every 3 days', title: 'Water plants', repeat: { after: 3 * D, mode: 0 }, date: ymd(REF), ...extra('a repeat without a date starts at the next due time') });
add({ text: 'Pay rent before the 17th', title: 'Pay rent', date: '2021-7-17', marked: ['due:before the 17th'], ...extra('"the 17th" anywhere; the word before a date goes with it') });
add({ text: 'Report due the 17th', title: 'Report due', date: '2021-7-17', ...extra('"the 17th" anywhere') });
add({ text: 'Call Bob in May', title: 'Call Bob', date: '2022-5-1', marked: ['due:in May'], ...extra('a bare month after "in"') });
add({ text: 'Finish slides by Friday', title: 'Finish slides', date: plus(1), ...extra('the word before a date goes with it') });
add({ text: 'Plan March madness pool', title: 'Plan March madness pool', date: null, ...extra('a bare month needs in/by/on/before/until') });
add({ text: 'Now what', title: 'Now what', date: null, ...extra('"now" alone is not a date') });
add({ text: 'Team sync for 2 hours', title: 'Team sync for 2 hours', date: null, ...extra('"for ..." is a duration') });
add({ text: 'Order 3/4 inch screws', title: 'Order 3/4 inch screws', date: null, ...extra('numeric dates only at the ends') });
add({ text: 'Pay rent tomorrow', ignore: { due: true }, title: 'Pay rent tomorrow', date: null, marked: [], ...extra('a tapped-off chip keeps its words') });
add({ text: 'Lorem Ipsum dec 21 at 3pm @ann *calls +project !2', title: 'Lorem Ipsum @ann', date: '2021-12-21', time: '15:0', labels: ['calls'], assignees: ['ann'], project: 'project', priority: 2,
  marked: ['due:dec 21 at 3pm', 'assignees:@ann', 'labels:*calls', 'project:+project', 'priority:!2'], ...extra('everything at once') });
add({ text: 'Team sync every monday @ 10', title: 'Team sync', repeat: { after: W, mode: 0 }, time: '10:0', marked: ['repeat:every monday', 'due:@ 10'],
  ...extra('each phrase is marked where it was typed, even "@ 10"') });
// A bare hour is daytime: 1 to 7 is the afternoon or evening (Vikunja reads "at 5" as 5 AM). Written-out times stay.
add({ text: 'Call Ana at 5', title: 'Call Ana', date: '2021-6-24', time: '17:0', ...extra('a bare 5 is 5 PM: today, as it’s still to come') });
add({ text: 'Call Ana at 9', title: 'Call Ana', date: '2021-6-25', time: '9:0', ...extra('a bare 9 is the morning: the next one') });
add({ text: 'Call Ana tomorrow at 5:30', title: 'Call Ana', date: '2021-6-25', time: '17:30', ...extra('5:30 is the afternoon too') });
add({ text: 'Call Ana at 5am', title: 'Call Ana', date: '2021-6-25', time: '5:0', ...extra('"am" is as written') });
add({ text: 'Call Ana at 05:00', title: 'Call Ana', date: '2021-6-25', time: '5:0', ...extra('"05:00" is as written') });
// Repeats Vikunja can't do stay as words, and nothing in them is read as something else.
add({ text: 'Water lawn every other day', title: 'Water lawn', repeat: { after: 2 * D, mode: 0 }, ...extra('"every other day" is every 2 days') });
add({ text: 'Standup every weekday at 9', title: 'Standup every weekday', repeat: null, date: '2021-6-25', time: '9:0', ...extra('weekdays only can’t repeat in Vikunja') });
add({ text: 'Gym every monday and thursday', title: 'Gym every monday and thursday', repeat: null, date: null, ...extra('two days a week can’t repeat in Vikunja') });

// A figure at the end of a line is the task's own progress, whichever mode is set: Vikunja's quick add has no word for it.
add({ text: 'Tables (50%)', title: 'Tables', pct: 50, marked: ['progress:(50%)'], ...extra('a figure at the end is its progress') });
add({ text: 'Tables 50%', title: 'Tables', pct: 50, marked: ['progress:50%'], ...extra('without brackets too') });
add({ text: 'Tables (50%) @sam', title: 'Tables @sam', pct: 50, assignees: ['sam'], ...extra('people may follow it: they stay in the title until they’re assigned') });
add({ text: 'Tables 50% tomorrow *hire !2', title: 'Tables', pct: 50, date: plus(1), labels: ['hire'], priority: 2, ...extra('the end of the line, once its other words are read') });
add({ text: 'Tables (100%)', title: 'Tables', pct: 100, ...extra('100% is done') });
add({ text: 'Discount 50% on mugs', title: 'Discount 50% on mugs', pct: 0, ...extra('a figure in the middle is a word') });
add({ text: 'Tables (150%)', title: 'Tables (150%)', pct: 0, ...extra('past 100% it isn’t progress') });
add({ text: 'Growth 0%', title: 'Growth 0%', pct: 0, ...extra('nor is 0%') });
add({ text: '50%', title: '50%', pct: 0, ...extra('a figure alone is a title') });
add({ text: 'Tables (50%)', ignore: { progress: true }, title: 'Tables (50%)', pct: 0, marked: [], ...extra('its chip tapped off keeps its words') });
add({ text: 'Fill to 50%', ignore: { due: true, repeat: true, project: true, progress: true }, title: 'Fill to 50%', pct: 0, ...extra('a step has no progress to arrive with') });
add({ text: 'Tables (50%)', mode: 'disabled', title: 'Tables', pct: 50, ...extra('read with quick add turned off too') });
add({ text: 'Tables (50%) @sam', mode: 'disabled', title: 'Tables (50%) @sam', pct: 0, assignees: [], ...extra('where @sam is a word, so the figure isn’t at the end') });
add({ text: 'Tables (50%) +sam @hire', mode: 'todoist', title: 'Tables +sam', pct: 50, assignees: ['sam'], labels: ['hire'], ...extra('with Todoist’s prefixes') });

// ---------- pasted lists: list markers removed, one task per line ----------
const lists = [];
const addList = (text, lines, why) => lists.push({ text, lines, why });
// (captureLines reads a run's box and a template's steps, where a ticked line is left out: a step is done by doing it.)
addList('Groceries\n- [] Cheese\n- [ ] Milk\n- [x] Eggs', ['Groceries', 'Cheese', 'Milk'], 'iOS Notes checklist: a line ticked off already is left out');
addList('• Bread\n◦ Jam\n☐ Butter\n✓ Tea', ['Bread', 'Jam', 'Butter', 'Tea'], 'bullets and checkbox symbols');
addList('1. One\n2) Two\n(3) Three', ['One', 'Two', 'Three'], 'numbering');
addList('> - Quoted item\n\n  - Indented item  ', ['Quoted item', 'Indented item'], 'quote marks, blank lines and indents');
addList('*calls Bob\n+Kitchen paint\n-[] Bread', ['*calls Bob', '+Kitchen paint', '-[] Bread'], 'a marker needs a space after it');
addList('x Call Sam\n[x] Eggs\nMilk', ['x Call Sam', 'Milk'], 'in a step\'s box an x is a word, and a ticked line is left out');

// ---------- quick add and the subtask boxes: a line that says it's done arrives done ----------
// readList(text, opts): each line as [its words, whether it's done].
const reads = [];
const addRead = (text, lines, why, opts = {}) => reads.push({ text, lines, why, opts });
for (const m of ['x ', 'x - ', 'x- ', '[x] ', '- [x] ', '* [X] ', '☑ ', '☒ ', '> - [x] ', '1. [✓] ', '  - [x]'])
  addRead(m + 'Call Sam', [['Call Sam', true]], `"${m}" at its start: it arrives done`);
addRead('x-ray the pipe', [['x-ray the pipe', false]], 'no space after the x: it\'s a word');
addRead('X marks the spot', [['X marks the spot', false]], 'a capital X is a word');
addRead('- x marks the spot', [['x marks the spot', false]], 'an x after a bullet is a word');
addRead('x', [['x', false]], 'an x alone is a title');
addRead('[ ] Milk\n- [ ] Bread\n* [ ] Jam\n- [] Tea\n☐ Rice\n✓ Salt', ['Milk', 'Bread', 'Jam', 'Tea', 'Rice', 'Salt'].map(t => [t, false]), 'an empty checkbox means open, and is taken off');
addRead('Groceries\n- [x] Eggs\n\n- [ ] Milk\nx Bread', [['Groceries', false], ['Eggs', true], ['Milk', false], ['Bread', true]], 'in a list, each line that says so');
addRead('Groceries\n- [x] Eggs\n- [ ] Milk\nx Bread', [['Groceries', false], ['Milk', false]], 'the list\'s chip tapped: those lines are left out', { done: false });
addRead('x Call Sam', [['x Call Sam', false]], 'one line, its chip tapped: the marker\'s words stay in the title', { done: false });
addRead('- [x] Call Sam', [['[x] Call Sam', false]], 'and a checkbox\'s, without its bullet', { done: false });

// ---------- parents in a pasted list ----------
// addNest(text, each line's words, the line each is under (its place among them, or null), why, options, whether the
// first line is a parent as the list is written)
const addNest = (text, titles, under, why, opts = {}, first = under.includes(0)) => reads.push({ text, lines: titles.map(t => Array.isArray(t) ? t : [t, false]), under, first, why, opts });
// A heading is a task, and the lines under it, up to the next heading, are its subtasks.
addNest('## Pack the van\n- Load chairs\n- Tables\n\n## Set the hall\nLights', ['Pack the van', 'Load chairs', 'Tables', 'Set the hall', 'Lights'], [null, 0, 0, null, 3], 'two headings, each over its lines');
addNest('### Pack the van\n- Load chairs', ['Pack the van', 'Load chairs'], [null, 0], 'a heading with more #s is one too');
addNest('## A\n### B\nb1\n## C\nc1', ['A', 'B', 'b1', 'C', 'c1'], [null, 0, 1, null, 3], 'a heading with more #s is under the one before it with fewer');
addNest('## Pack the van', ['Pack the van'], [null], 'a heading alone is a task, without its #s');
addNest('## [x] Pack the van\n- [x] Load chairs', [['Pack the van', true], ['Load chairs', true]], [null, 0], 'a heading can say it\'s done');
addNest('To do first\n## Pack the van\n- Load chairs', ['To do first', 'Pack the van', 'Load chairs'], [null, null, 1], 'a line before the first heading is a task of its own');
addNest('## Pack the van\n- Load chairs\n## Set the hall\n- Lights', ['Pack the van', 'Load chairs', 'Set the hall', 'Lights'], [null, null, null, null], '↳ Under first line tapped off: all tasks of their own', { flat: true }, true);
addNest('## Pack the van\n- Load chairs\n## Set the hall\n- Lights', ['Pack the van', 'Load chairs', 'Set the hall', 'Lights'], [null, 0, 0, 2], '↳ Under first line tapped on: the first line over every line with no parent', { nest: true });
addNest('Pack the van\n- Load chairs\n- Tables', ['Pack the van', 'Load chairs', 'Tables'], [null, 0, 0], 'a list with no markers, ↳ Under first line on', { nest: true }, false);
addNest('## A\n## [x] B\nb1\n### C\nc1', ['A', 'b1', 'C', 'c1'], [null, null, null, 2], 'a done heading left out: its lines are no longer under one', { done: false });
addNest('#project task\n#5 on the list', ['#project task', '#5 on the list'], [null, null], 'a # with no space after it is a word (Todoist\'s #project)');
// Indenting, as in Vikunja's web app: a line indented more than the line above it is under it, to any depth.
addNest('Pack the van\n  Load chairs\n    Stack them\n  Tables\nSet the hall\n\tLights', ['Pack the van', 'Load chairs', 'Stack them', 'Tables', 'Set the hall', 'Lights'], [null, 0, 1, 0, null, 4], 'spaces or a tab, to any depth');
addNest('- Pack the van\n   - [x] Load chairs\n      * Stack them\n - Tables', ['Pack the van', ['Load chairs', true], 'Stack them', 'Tables'], [null, 0, 1, 0], 'any width: only more than the line above counts');
addNest('    Pack the van\n    Tables\n  Lights\n      Cables', ['Pack the van', 'Tables', 'Lights', 'Cables'], [null, null, null, 2], 'a list indented as a whole, and a line indented less, start again at the top');
addNest('## Pack the van\n  - Load chairs\n    - Stack them\n  - Tables\n## Set the hall\n- Lights', ['Pack the van', 'Load chairs', 'Stack them', 'Tables', 'Set the hall', 'Lights'], [null, 0, 1, 0, null, 4], 'under a heading, an indented line is under the line above it');
addNest('Pack the van\n  - [x] Load chairs\n      Stack them\n  Tables', ['Pack the van', 'Stack them', 'Tables'], [null, 0, 0], 'a done line left out: the line under it goes under what it was under', { done: false });
addNest('Pack the van\n  Load chairs\nSet the hall\n  Lights', ['Pack the van', 'Load chairs', 'Set the hall', 'Lights'], [null, null, null, null], '↳ Under first line tapped off: all tasks of their own', { flat: true }, true);
addNest('Order cups\nPack the van\n  Load chairs', ['Order cups', 'Pack the van', 'Load chairs'], [null, 0, 1], '↳ Under first line tapped on, the first line not a parent as written: over the lines with no parent', { nest: true }, false);
addList('Wipe down\n  Counter\n    Under it', ['Wipe down', 'Counter', 'Under it'], 'in a step\'s box indenting isn\'t read');
// One # is the name of the whole list, as a project's copy starts with: left out.
addNest('# Café · 12 open · 5 done\n- [ ] Order milk\n- [ ] Pack the van\n  - [ ] Tables', ['Order milk', 'Pack the van', 'Tables'], [null, null, 1], 'a list\'s name, with one #, is left out', { names: ['Café · 12 open · 5 done'] });
addNest('# Friday\n## Pack the van\n- Tables\n# [x] Saturday\n- Lights', ['Pack the van', 'Tables', 'Lights'], [null, 0, null], 'each of them, and nothing is under one', { names: ['Friday', '[x] Saturday'] });
addNest('# of chairs we need', ['# of chairs we need'], [null], 'alone in the box, it names no list: a title as typed', { names: [] });
addList('# Opening\n- Unlock', ['# Opening', 'Unlock'], 'in a step\'s box a # is words');
// For typing: a first line ending with a colon is the parent of the rest, its colon taken off (quick add's box only).
addNest('Groceries:\n- milk\n- eggs', ['Groceries', 'milk', 'eggs'], [null, 0, 0], 'a first line ending with a colon', { colon: true });
addNest('Groceries tomorrow: \nDairy\n  milk\nBread', ['Groceries tomorrow', 'Dairy', 'milk', 'Bread'], [null, 0, 1, 0], 'over the lines with no parent of their own', { colon: true });
addNest('Groceries:\n- milk', ['Groceries:', 'milk'], [null, null], '↳ Under first line tapped off: tasks of their own, the colon staying in its title', { colon: true, flat: true }, true);
addNest('Groceries:', ['Groceries:'], [null], 'one line: as typed', { colon: true });
addNest('Note: buy milk\neggs:', ['Note: buy milk', 'eggs:'], [null, null], 'only the first line, and only at its end', { colon: true });
addNest('Groceries:\n- [x] milk', ['Groceries:'], [null], 'with its only line left out, it\'s one task, as typed', { colon: true, done: false });
addNest('Groceries:\n- milk', ['Groceries:', 'milk'], [null, null], 'a subtask box doesn\'t read it');
addList('## Wipe down\n- Counter', ['## Wipe down', 'Counter'], 'in a step\'s box a heading is words');

// ---------- checklist steps ----------
// A step's T#20m, T#40m:roast and {#roast} stay in its title, for parseStep, and nothing reads them as a date or a time.
add({ text: 'Check the guards at 3pm T#30m', ignore: { due: true, repeat: true }, title: 'Check the guards at 3pm T#30m', date: null, pocket: true, why: 'a checklist step keeps its words; T#30m is read by parseStep' });
add({ text: 'Warm up the press T#2h', title: 'Warm up the press T#2h', date: null, pocket: true, why: "T#2h isn't a time of day" });
add({ text: 'Baste the roast T#40m:roast', title: 'Baste the roast T#40m:roast', date: null, pocket: true, why: 'nor is T#40m:roast' });
add({ text: 'pay rent Oct 5', now: new Date(2026, 9, 5, 20, 50), title: 'pay rent', date: '2026-10-5', pocket: true, why: 'today\'s date is today, typed after noon too' });
add({ text: 'pay rent oct 7 at 10am', now: new Date(2026, 9, 7, 11, 0), title: 'pay rent', date: '2026-10-7', time: '10:0', pocket: true, why: 'today\'s date with a time gone is today' });
add({ text: 'pay rent Oct 4', now: new Date(2026, 9, 5, 20, 50), title: 'pay rent', date: '2027-10-4', pocket: true, why: 'yesterday\'s date is next year\'s' });
add({ text: 'Task *"batch {#roast}"', title: 'Task', labels: ['batch {#roast}'], pocket: true, why: 'a step\'s words inside a quoted label stay in the label' });
add({ text: 'Task *"batch T#20m"', title: 'Task', labels: ['batch T#20m'], pocket: true, why: 'and a T# time ends before the quote' });
// The same text with a step's token after it reads the same: [text, token, mode].
const collisions = [['Call the lab 17:30', 'T#20m'], ['The 9/11 Report due 10/12', 'T#40m:roast'], ['01.02 Lorem Ipsum', 'T#1h30m'],
  ['Lorem Ipsum 01.02', '{#roast}'], ['Order resin 2026-10-12', 'T#3d'], ['Baste the roast at 5pm', 'T#40m:roast'], ['Roast in tomorrow', '{#roast}'],
  ['Set the table #project', 'T#20m:roast', 'todoist'], ['Set the table #project', '{#table}', 'todoist'], ['Make the gravy *kitchen', 'T#5m']];
// parseStep: [text, title, offset in ms, name, ref, problems]
const steps = [['Check the guards', 'Check the guards', null, null, null, 0], ['Warm up the press T#30m', 'Warm up the press', 30 * 6e4, null, null, 0],
  ['First article check T#2h', 'First article check', 120 * 6e4, null, null, 0], ['Cool down T#1h30m', 'Cool down', 90 * 6e4, null, null, 0],
  ['Settle T#1.5h', 'Settle', 90 * 6e4, null, null, 0], ['Rinse T#90s', 'Rinse', 90e3, null, null, 0], ['Blink T#250ms', 'Blink', 250, null, null, 0],
  ['Order resin T#3d', 'Order resin', 3 * 864e5, null, null, 0], ['Sign off T#0m', 'Sign off', 0, null, null, 0], ['Soak t#20M', 'Soak', 20 * 6e4, null, null, 0],
  ['Put the roast in {#roast}', 'Put the roast in', null, 'roast', null, 0], ['Baste the roast T#40m:roast', 'Baste the roast', 40 * 6e4, null, 'roast', 0],
  ['Roast in {#roast} T#5m', 'Roast in', 5 * 6e4, 'roast', null, 0], ['T#1d2h3m4s Long one', 'Long one', 864e5 + 2 * 36e5 + 3 * 6e4 + 4e3, null, null, 0],
  ['Email ops@T#team', 'Email ops@T#team', null, null, null, 0], ['Part AT#5', 'Part AT#5', null, null, null, 0],
  ['Read T#30 of the manual', 'Read of the manual', null, null, null, 1], ['Preheat T#-10m:roast', 'Preheat', null, null, null, 1],
  ['Two times T#5m T#10m', 'Two times', 5 * 6e4, null, null, 1], ['Bad name {#1st}', 'Bad name', null, null, null, 1],
  ['Bad ref T#5m:2nd', 'Bad ref', null, null, null, 1], ['Way off T#400d', 'Way off', null, null, null, 1],
  ['Overflow T#999999999999999999999d', 'Overflow', null, null, null, 1], ['Nbsp\u00a0T#20m', 'Nbsp', 20 * 6e4, null, null, 0], ['Two names {#a} {#b}', 'Two names', null, 'a', null, 1]];
// stepProblems over a template's steps: [titles, what each problem says]
const templates = [[['A {#a}', 'B T#5m:a', 'C T#1h'], []], [['A T#5m:a', 'B {#a}'], ['which has to be an earlier step']],
  [['A {#a} T#5m:a'], ['which has to be an earlier step']], [['A {#a}', 'B {#A}'], ['names an earlier step too']],
  [['A', 'B T#5m:nope'], ['no step is named']], [['A T#5', 'B'], ["isn't a time"]]];
// A step's time in words, read while steps are written in Pocket: [text, offset in ms or null]
const phrases = [['Check the oil in 10 min', 6e5], ['Baste after an hour', 36e5], ['Pull the jeans 20 minutes later', 12e5], ['Carve 1h 30m after', 54e5],
  ['Rest in half an hour', 18e5], ['Call back in 2 days', 1728e5], ['Check in two hours', 72e5], ['Check in 1 hour and 30 minutes', 54e5], ['Sand in 90s', 9e4],
  ['Stir for 2 minutes', null], ['Let it rest 10 minutes', null], ['Meet in am', null], ['Sign in and out', null], ['Log in 5', null], ['Wait in a while', null], ['Ship in 400 days', null]];
// Rows of steps written in Pocket, saved: [rows, steps already there, what's added, the steps renamed, a problem]
const drafts = [
  [[{ key: 'a', text: 'Put the roast in' }, { key: 'b', text: 'Peel the potatoes in 20 min' }, { key: 'c', text: 'Baste 40 minutes later', from: 'a' }, { key: 'd', text: 'Stir for 2 minutes' }], [],
    ['Put the roast in {#put-the-roast}', 'Peel the potatoes T#20m', 'Baste T#40m:put-the-roast', 'Stir for 2 minutes'], [], false],
  // Moved above the step it counts from.
  [[{ key: 'c', text: 'Baste 40 minutes later', from: 'a' }, { key: 'a', text: 'Put the roast in' }], [], ['Baste T#40m:put-the-roast', 'Put the roast in {#put-the-roast}'], [], true],
  // Words kept as words; an empty row left out.
  [[{ key: 'b', text: 'Peel the potatoes in 20 min', keep: true }, { key: 'e', text: '  ' }], [], ['Peel the potatoes in 20 min'], [], false],
  // Counting from a step already in the template names it.
  [[{ key: 'x', text: 'Baste in 40 min', from: 'task:1' }], [{ key: 'task:1', text: 'Put the roast in' }], ['Baste T#40m:put-the-roast'], [{ key: 'task:1', title: 'Put the roast in {#put-the-roast}' }], false],
  // Back to the step before; a name taken already gets a number.
  [[{ key: 'a', text: 'Put {#roast}' }, { key: 'b', text: 'Baste T#40m:roast', from: '' }], [], ['Put {#roast}', 'Baste T#40m'], [], false],
  [[{ key: 'a', text: 'Check it {#check-it}' }, { key: 'b', text: 'Check it' }, { key: 'c', text: 'Again in 5 min', from: 'b' }], [], ['Check it {#check-it}', 'Check it {#check-it-2}', 'Again T#5m:check-it-2'], [], false],
  // A time in words before punctuation: the words go, and its T# goes at the end.
  [[{ key: 'a', text: 'Baste in 20 min.' }, { key: 'b', text: 'Flip it after 5 minutes, then season' }], [], ['Baste. T#20m', 'Flip it, then season T#5m'], [], false],
  // A priority stays one: only punctuation that ends a word is pulled back to it.
  [[{ key: 'a', text: 'Baste !2 in 20 min' }], [], ['Baste !2 T#20m'], [], false],
  // Counting from a step that isn't there: a problem, not the step before.
  [[{ key: 'a', text: 'Baste in 20 min', from: 'task:99' }], [{ key: 'task:1', text: 'Put the roast in' }], ['Baste T#20m'], [], true],
  // A name doesn't end on a small word.
  [[{ key: 'a', text: 'Warm up the press' }, { key: 'b', text: 'Check in 5 min', from: 'a' }], [], ['Warm up the press {#warm-up}', 'Check T#5m:warm-up'], [], false]];

// The line in a project's description that makes it a checklist project: on its own, anywhere in it.
const marks = [['<p>pocket:checklists</p>', true], ['<p>Line 2 startups</p><p>Pocket:Checklists </p>', true], ['Notes<br>pocket:checklists', true],
  ['<p>Our safety checklists</p>', false], ['<p>see pocket:checklists in the docs</p>', false], ['', false]];
// A template's step order, a line in its description: [description, the order read, the step ids as shown].
const S = [{id: 9}, {id: 3}, {id: 12}, {id: 5}];                             // as Vikunja gives them: in no set order
const orders = [['<p>Notes</p><p>pocket:order 9 3 5 12</p>', [9, 3, 5, 12], [9, 3, 5, 12]],
  ['<p>pocket:order 12 5</p>', [12, 5], [12, 5, 3, 9]],                     // steps it doesn't list follow, in the order made
  ['<p>pocket:order 40 9 41</p>', [40, 9, 41], [9, 3, 5, 12]],               // ids no longer steps are skipped
  ['<p>Notes</p>', null, [3, 5, 9, 12]], ['<p>pocket:order</p>', [], [3, 5, 9, 12]], ['', null, [3, 5, 9, 12]],
  ['<p>see pocket:order 9 3 in the docs</p>', null, [3, 5, 9, 12]],
  ['<p>pocket:order 12 5<br>Bring cash for the float</p>', [12, 5], [12, 5, 3, 9]],   // a line of a paragraph (Shift+Enter)
  ['<p>pocket:order 12</p><p>pocket:order 5</p>', [12], [12, 3, 5, 9]], ['<ul><li>pocket:order 12</li></ul>', null, [3, 5, 9, 12]]];
// Written: [description, ids, what it becomes].
const orderWrites = [['<p>Notes</p>', [5, 3], '<p>Notes</p><p>pocket:order 5 3</p>'], ['', [5], '<p>pocket:order 5</p>'],
  ['<p>pocket:order 3 5</p><p>Notes</p>', [5, 3], '<p>pocket:order 5 3</p><p>Notes</p>'],
  ['<p>Notes</p><p>pocket:order 3 5</p>', null, '<p>Notes</p>'],
  ['<p>pocket:order 3 5<br>Bring cash</p>', [5, 3], '<p>pocket:order 5 3<br>Bring cash</p>'], ['<p>pocket:order 3 5<br>Bring cash</p>', null, '<p>Bring cash</p>'],
  ['<p>Bring cash<br>pocket:order 3 5</p>', null, '<p>Bring cash</p>'], ['<p>pocket:order 3</p><p>pocket:order 5</p>', [9], '<p>pocket:order 9</p>'],
  ['<ul><li>pocket:order 3</li></ul>', [9], '<ul><li>pocket:order 3</li></ul><p>pocket:order 9</p>']];

// ---------- run ----------
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${http.address().port}/`);
await page.waitForFunction(() => typeof parseCapture === 'function' && typeof chrono !== 'undefined');
const PROJECTS = ['project', 'project with long name', 'today', 'project1'].map((title, i) => ({ id: i + 1, title }));
const results = await page.evaluate(([cases, projects]) => cases.map(c => {
  const r = parseCapture(c.text, projects, { now: new Date(c.now), dueTime: c.dueTime, ignore: c.ignore, mode: c.mode });
  return { title: r.title, date: r.due && `${r.due.getFullYear()}-${r.due.getMonth() + 1}-${r.due.getDate()}`, time: r.due && `${r.due.getHours()}:${r.due.getMinutes()}`,
    repeat: r.repeat && { after: r.repeat.after, mode: r.repeat.mode }, labels: r.labels, assignees: r.assignees, project: r.project?.title ?? r.projectMiss, priority: r.priority, pct: r.pct,
    marks: r.marks };
}), [cases.map(c => ({ ...c, now: +(c.now || REF) })), PROJECTS]);
const listResults = await page.evaluate(lists => lists.map(l => captureLines(l.text)), lists);
// Each line's words, whether it's done, and whether its words are where it says they start in the text.
const readResults = await page.evaluate(reads => reads.map(r => { const { names, ...opts } = r.opts, list = readList(r.text, opts); return { names: list.names, lines: list.lines.map(l => [l.text, l.done]),
  placed: list.lines.every(l => r.text.slice(l.at, l.at + l.text.length) === l.text), marked: list.lines.map(l => l.mark ? r.text.slice(...l.mark) : ''),
  under: list.lines.map(l => l.under), first: list.first }; }), reads);
const stepResults = await page.evaluate(steps => steps.map(([text]) => parseStep(text)), steps);
const phraseResults = await page.evaluate(ps => ps.map(([text]) => readStepPhrase(text)?.offset ?? null), phrases);
const draftResults = await page.evaluate(ds => ds.map(([rows, before]) => {
  const d = draftSteps(rows.map(r => ({ keep: false, from: null, ...r })), before);
  return { added: d.added, renames: d.renames, problem: d.problem };
}), drafts);
const templateResults = await page.evaluate(ts => ts.map(([titles]) => stepProblems(titles).map(p => p.text)), templates);
const collisionResults = await page.evaluate(([cs, projects]) => cs.map(([text, token, mode]) => {
  const read = t => { const r = parseCapture(t, projects, { now: new Date(2021, 5, 24, 12, 0), mode }); return { title: r.title, due: r.due && r.due.getTime(), project: r.project?.title ?? null, labels: r.labels }; };
  return [read(text), read(text + ' ' + token)];
}), [collisions, PROJECTS]);
const markResults = await page.evaluate(marks => marks.map(([html]) => isChecklistDesc(html)), marks);
const orderResults = await page.evaluate(([os, steps]) => os.map(([html]) => [stepOrder(html),
  stepsOf({labels: [{title: 'template'}], description: html, related_tasks: {subtask: steps}}).map(s => s.id)]), [orders, S]);
const orderWriteResults = await page.evaluate(ws => ws.map(([html, ids]) => withOrder(html, ids)), orderWrites);
// A run's steps by id, whatever order Vikunja gives them in; any other task's subtasks as they are.
// Late: [due, now, late?]. Any time is late once it's passed, noon too; midnight, a day without a time, once it's over.
const lates = [['2021-06-24T09:30', '2021-06-24T10:00', true], ['2021-06-24T10:30', '2021-06-24T10:00', false],
  ['2021-06-24T12:00', '2021-06-24T15:00', true], ['2021-06-24T00:00', '2021-06-24T15:00', false],
  ['2021-06-24T09:00', '2021-06-24T15:00', true], ['2021-06-23T00:00', '2021-06-24T08:00', true]];
const lateResults = await page.evaluate(ls => ls.map(([due, now]) => isLate(new Date(due).toISOString(), new Date(now))), lates);
const runOrder = await page.evaluate(() => [stepsOf({related_tasks: {copiedfrom: [{id: 1}], subtask: [{id: 9}, {id: 3}]}}).map(s => s.id),
  stepsOf({related_tasks: {subtask: [{id: 9}, {id: 3}]}}).map(s => s.id),
  stepsOf({description: '<p>pocket:run</p><p>pocket:order 9 12 3</p>', related_tasks: {subtask: [{id: 3}, {id: 12}, {id: 9}, {id: 20}]}}).map(s => s.id)]);
// Inserting a step: before the one given; if that's gone, after the one it was inserted under, and if that's gone too, at
// the end; and not twice.
const placed = await page.evaluate(() => [placeBefore([3, 9, 12], 20, 9), placeBefore([3, 9, 12], 20, 99), placeBefore([3, 20, 9], 20, 12),
  placeBefore([3, 9, 12], 20, 99, 3), placeBefore([3, 9, 12], 20, 99, 98)]);
// A step added during its run: "Inserted", or "Repeated" when it keeps the line of the one it repeats; Pocket's lines
// aren't its notes.
const addeds = await page.evaluate(() => [addedText(withAdded('<p>Mind the hot plate</p>')), addedText(withAdded(withStepLine('', 'Taste T#5m'))),
  addedText('<p>pocket:step Taste T#5m</p>'), notesOnly(withAdded(withStepLine('<p>Mind the hot plate</p>', 'Taste T#5m')))]);
// A template: done, or not done with a due date, but not a copy being set up as a run; its name without "TEMPLATE: ";
// its repeat in words; and where Vikunja moves it when it's ticked, as checked on Vikunja 2.7 (the round-out plan).
const rounds = await page.evaluate(() => {
  const L = [{title: 'template'}], due = '2026-09-15T19:09:31Z', now = Date.parse('2026-10-06T18:09:31Z'), at = ms => ms === null ? null : new Date(ms).toISOString();
  return [isTemplate({labels: L, done: true}), isTemplate({labels: L, done: false, due_date: due}),
    isTemplate({labels: L, done: false, due_date: '0001-01-01T00:00:00Z'}), isTemplate({labels: L, done: false, due_date: due, related_tasks: {copiedfrom: [{id: 1}]}}),
    isTemplate({labels: L, done: false, due_date: due, description: '<p>pocket:run</p>'}), isTemplate({labels: L, done: true, related_tasks: {parenttask: [{id: 1}]}}),
    isTemplate({labels: [], done: true}),
    templateName('TEMPLATE: Opening up'), templateName('Opening up'), templateTitle('template: Opening up'),
    ...[{repeat_after: 86400}, {repeat_after: 3 * 86400}, {repeat_after: 604800}, {repeat_after: 1209600}, {repeat_mode: 1}, {repeat_after: 6 * 3600},
      {repeat_mode: 2, repeat_after: 86400}, {}].map(repeatWords),
    at(vikunjaNext({due_date: due, repeat_after: 86400}, now)),                          // every day, 3 weeks late: the next 19:09 after now
    at(vikunjaNext({due_date: '2026-10-07T18:09:31Z', repeat_after: 86400}, now)),       // ticked early: a day on all the same
    at(vikunjaNext({due_date: due, repeat_mode: 1}, now)),                               // every month: one month
    at(vikunjaNext({due_date: '2026-07-06T18:09:31Z', repeat_mode: 1}, now)),            // ...still late
    at(nextAfter({repeat_mode: 1}, Date.parse('2026-08-06T18:09:31Z'), now)),            // which Pocket moves past now
    at(vikunjaNext({due_date: due, repeat_after: 86400, repeat_mode: 2}, now)), at(vikunjaNext({due_date: due}, now))];
});
await browser.close();
http.close();

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let failed = 0;
cases.forEach((c, i) => {
  const r = results[i], bad = [];
  if ('title' in c && r.title !== c.title) bad.push(`title "${r.title}"`);
  if (c.date === 'any') { if (!r.date) bad.push('no date'); }
  else if ('date' in c && r.date !== c.date) bad.push(`date ${r.date}`);
  if ('time' in c && r.time !== c.time) bad.push(`time ${r.time}`);
  for (const k of ['repeat', 'labels', 'assignees', 'project', 'priority', 'pct']) if (k in c && !same(r[k], c[k])) bad.push(`${k} ${JSON.stringify(r[k])}`);
  const marked = r.marks.map(m => m.kind + ':' + c.text.slice(m.start, m.end));
  if ('marked' in c && !same(marked, c.marked)) bad.push(`marked ${JSON.stringify(marked)}`);
  // The marks are what was read: taking them out of the text leaves the title, give or take spaces. (@username stays.)
  // So do the quotes round a title held at its start.
  if (c.mode !== 'disabled') {
    let rest = c.text;
    for (const m of [...r.marks].reverse()) if (m.kind !== 'assignees') rest = rest.slice(0, m.start) + ' ' + rest.slice(m.end);
    const hold = rest.match(/^(\s*)(["'])([\s\S]*?)\2(?=\s|$)/);
    if (hold) rest = hold[1] + hold[3] + rest.slice(hold[0].length);
    if (rest.replace(/\s+/g, '') !== r.title.replace(/\s+/g, '')) bad.push(`marks leave "${rest.replace(/\s+/g, ' ').trim()}"`);
  }
  if (bad.length) { failed++; console.log(`FAIL ${JSON.stringify(c.text)}${c.pocket ? ` [Pocket: ${c.why}]` : ''}: ${bad.join(', ')}`); }
});
lists.forEach((l, i) => {
  if (!same(listResults[i], l.lines)) { failed++; console.log(`FAIL pasted list [${l.why}]: ${JSON.stringify(listResults[i])}`); }
});
reads.forEach((r, i) => {
  const got = readResults[i];
  if (!same(got.lines, r.lines) || !got.placed) { failed++; console.log(`FAIL read ${JSON.stringify(r.text)} [${r.why}]: ${JSON.stringify(got)}`); }
  if ('marked' in r && !same(got.marked, r.marked)) { failed++; console.log(`FAIL marked in ${JSON.stringify(r.text)} [${r.why}]: ${JSON.stringify(got.marked)}`); }
  if ('under' in r && (!same(got.under, r.under) || got.first !== r.first)) { failed++; console.log(`FAIL which line each is under in ${JSON.stringify(r.text)} [${r.why}]: ${JSON.stringify(got.under)}, first ${got.first}`); }
  if (r.opts.names && !same(got.names, r.opts.names)) { failed++; console.log(`FAIL the list's name in ${JSON.stringify(r.text)} [${r.why}]: ${JSON.stringify(got.names)}`); }
});
steps.forEach(([text, title, offset, name, ref, problems], i) => {
  const r = stepResults[i];
  if (r.title !== title || r.offset !== offset || r.name !== name || r.ref !== ref || r.problems.length !== problems)
    { failed++; console.log(`FAIL step ${JSON.stringify(text)}: ${JSON.stringify(r)}`); }
});
phrases.forEach(([text, want], i) => {
  if (phraseResults[i] !== want) { failed++; console.log(`FAIL step time in words ${JSON.stringify(text)}: ${phraseResults[i]}`); }
});
drafts.forEach(([rows, , added, renames, problem], i) => {
  const r = draftResults[i];
  if (!same(r.added, added) || !same(r.renames, renames) || r.problem !== problem) { failed++; console.log(`FAIL steps written ${JSON.stringify(rows.map(x => x.text))}: ${JSON.stringify(r)}`); }
});
templates.forEach(([titles, want], i) => {
  const got = templateResults[i];
  if (got.length !== want.length || want.some((w, j) => !got[j].includes(w))) { failed++; console.log(`FAIL template ${JSON.stringify(titles)}: ${JSON.stringify(got)}`); }
});
collisions.forEach(([text, token], i) => {
  const [plain, withToken] = collisionResults[i];
  if (!same({...plain, title: plain.title + ' ' + token}, withToken)) { failed++; console.log(`FAIL ${JSON.stringify(text + ' ' + token)}: ${JSON.stringify(withToken)}, without it ${JSON.stringify(plain)}`); }
  if (!plain.due && !plain.project && !plain.labels.length) { failed++; console.log(`FAIL ${JSON.stringify(text)} reads nothing, so it shows no collision`); }
});
marks.forEach(([html, want], i) => {
  if (markResults[i] !== want) { failed++; console.log(`FAIL checklist marker ${JSON.stringify(html)}: ${markResults[i]}`); }
});
orders.forEach(([html, order, shown], i) => {
  if (!same(orderResults[i], [order, shown])) { failed++; console.log(`FAIL step order ${JSON.stringify(html)}: ${JSON.stringify(orderResults[i])}`); }
});
orderWrites.forEach(([html, ids, want], i) => {
  if (orderWriteResults[i] !== want) { failed++; console.log(`FAIL step order written ${JSON.stringify([html, ids])}: ${orderWriteResults[i]}`); }
});
lates.forEach(([due, now, want], i) => {
  if (lateResults[i] !== want) { failed++; console.log(`FAIL late ${JSON.stringify([due, now])}: ${lateResults[i]}`); }
});
if (!same(runOrder, [[3, 9], [9, 3], [9, 12, 3, 20]])) { failed++; console.log(`FAIL a run's steps by its order line then id, a task's as they are: ${JSON.stringify(runOrder)}`); }
if (!same(placed, [[3, 20, 9, 12], [3, 9, 12, 20], [3, 20, 9], [3, 20, 9, 12], [3, 9, 12, 20]])) { failed++; console.log(`FAIL placing an inserted step: ${JSON.stringify(placed)}`); }
if (!same(addeds, ['Inserted', 'Repeated', '', '<p>Mind the hot plate</p>'])) { failed++; console.log(`FAIL steps added during a run: ${JSON.stringify(addeds)}`); }
const roundsWant = [true, true, false, false, false, false, false, 'Opening up', 'Opening up', 'TEMPLATE: Opening up',
  'every day', 'every 3 days', 'every week', 'every 2 weeks', 'every month', 'every 6 hours', 'every day after a run starts', '',
  '2026-10-06T19:09:31.000Z', '2026-10-08T18:09:31.000Z', '2026-10-15T19:09:31.000Z', '2026-08-06T18:09:31.000Z', '2026-11-06T18:09:31.000Z',
  '2026-10-07T18:09:31.000Z', null];
if (!same(rounds, roundsWant)) { failed++; console.log(`FAIL templates that come round: ${JSON.stringify(rounds)}`); }
const wf = steps.length + templates.length + collisions.length + phrases.length + drafts.length + marks.length + orders.length + orderWrites.length + lates.length + 2, total = cases.length + lists.length + reads.length + wf;
console.log(`${total - failed} of ${total} passed (${cases.filter(c => c.pocket).length} are Pocket-specific, ${lists.length + reads.length} are pasted lists, ${wf} are checklist steps and markers)`);
process.exitCode = failed ? 1 : 0;
