// Quick-add parsing tests. No server needed:
//
//   npm run test:parse
//
// Loads pocket/app/index.html in a headless browser and runs parseCapture() on each phrase with a fixed "now",
// and captureLines() on a few pasted lists.
// The phrases and expectations are adapted from Vikunja's own Quick Add Magic tests
// (frontend/src/modules/quickAddMagic/quickAddMagic.test.ts), so Pocket reads text the way Vikunja does.
// Cases marked `pocket` are where Pocket deliberately differs from Vikunja, or goes further; `why` says how.
// Optional: BROWSER_CHANNEL=msedge|chrome.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(fileURLToPath(new URL('../pocket/app', import.meta.url)));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const http = createServer(async (req, res) => {
  let file = '';
  try { file = resolve(ROOT, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname)); } catch {}
  if (file === ROOT) file = resolve(ROOT, 'index.html');
  if (!file.startsWith(ROOT + sep)) { res.writeHead(404).end(); return; }
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
//     labels?, assignees?, project?, priority?, pocket?, why?}
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
  ['Something at 10:00 sep 17th', '2021-9-17 10:0'], ['2nd March at 5', '2022-3-2 5:0', 1], ['2nd March at 5pm', '2022-3-2 17:0', 1], ['2nd March @ 14:00', '2022-3-2 14:0', 1],
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

// ---------- pasted lists: list markers removed, one task per line ----------
const lists = [];
const addList = (text, lines, why) => lists.push({ text, lines, why });
addList('Groceries\n- [] Cheese\n- [ ] Milk\n- [x] Eggs', ['Groceries', 'Cheese', 'Milk', 'Eggs'], 'iOS Notes checklist');
addList('• Bread\n◦ Jam\n☐ Butter\n✓ Tea', ['Bread', 'Jam', 'Butter', 'Tea'], 'bullets and checkbox symbols');
addList('1. One\n2) Two\n(3) Three', ['One', 'Two', 'Three'], 'numbering');
addList('> - Quoted item\n\n  - Indented item  ', ['Quoted item', 'Indented item'], 'quote marks, blank lines and indents');
addList('*calls Bob\n+Kitchen paint\n-[] Bread', ['*calls Bob', '+Kitchen paint', '-[] Bread'], 'a marker needs a space after it');

// ---------- workflow steps ----------
// A step's T#20m, T#40m:dryer and {#dryer} stay in its title, for parseStep, and nothing reads them as a date or a time.
add({ text: 'Check the guards at 3pm T#30m', ignore: { due: true, repeat: true }, title: 'Check the guards at 3pm T#30m', date: null, pocket: true, why: 'a workflow step keeps its words; T#30m is read by parseStep' });
add({ text: 'Warm up the press T#2h', title: 'Warm up the press T#2h', date: null, pocket: true, why: "T#2h isn't a time of day" });
add({ text: 'Pull batch B T#40m:dryer', title: 'Pull batch B T#40m:dryer', date: null, pocket: true, why: 'nor is T#40m:dryer' });
// The same text with a step's token after it reads the same: [text, token, mode].
const collisions = [['Call the lab 17:30', 'T#20m'], ['The 9/11 Report due 10/12', 'T#40m:dryer'], ['01.02 Lorem Ipsum', 'T#1h30m'],
  ['Lorem Ipsum 01.02', '{#dryer}'], ['Order resin 2026-10-12', 'T#3d'], ['Pull batch B at 5pm', 'T#40m:dryer'], ['Dryer in tomorrow', '{#dryer}'],
  ['Fold the towels #project', 'T#20m:dryer', 'todoist'], ['Fold the towels #project', '{#fold}', 'todoist'], ['Sort the socks *laundry', 'T#5m']];
// parseStep: [text, title, offset in ms, name, ref, problems]
const steps = [['Check the guards', 'Check the guards', null, null, null, 0], ['Warm up the press T#30m', 'Warm up the press', 30 * 6e4, null, null, 0],
  ['First article check T#2h', 'First article check', 120 * 6e4, null, null, 0], ['Cool down T#1h30m', 'Cool down', 90 * 6e4, null, null, 0],
  ['Settle T#1.5h', 'Settle', 90 * 6e4, null, null, 0], ['Rinse T#90s', 'Rinse', 90e3, null, null, 0], ['Blink T#250ms', 'Blink', 250, null, null, 0],
  ['Order resin T#3d', 'Order resin', 3 * 864e5, null, null, 0], ['Sign off T#0m', 'Sign off', 0, null, null, 0], ['Soak t#20M', 'Soak', 20 * 6e4, null, null, 0],
  ['Load the dryer {#dryer}', 'Load the dryer', null, 'dryer', null, 0], ['Pull batch B T#40m:dryer', 'Pull batch B', 40 * 6e4, null, 'dryer', 0],
  ['Dryer in {#dryer} T#5m', 'Dryer in', 5 * 6e4, 'dryer', null, 0], ['T#1d2h3m4s Long one', 'Long one', 864e5 + 2 * 36e5 + 3 * 6e4 + 4e3, null, null, 0],
  ['Email ops@T#team', 'Email ops@T#team', null, null, null, 0], ['Part AT#5', 'Part AT#5', null, null, null, 0],
  ['Read T#30 of the manual', 'Read of the manual', null, null, null, 1], ['Pre-heat T#-10m:dryer', 'Pre-heat', null, null, null, 1],
  ['Two times T#5m T#10m', 'Two times', 5 * 6e4, null, null, 1], ['Bad name {#1st}', 'Bad name', null, null, null, 1],
  ['Bad ref T#5m:2nd', 'Bad ref', null, null, null, 1], ['Two names {#a} {#b}', 'Two names', null, 'a', null, 1]];
// stepProblems over a template's steps: [titles, what each problem says]
const templates = [[['A {#a}', 'B T#5m:a', 'C T#1h'], []], [['A T#5m:a', 'B {#a}'], ['which has to be an earlier step']],
  [['A {#a} T#5m:a'], ['which has to be an earlier step']], [['A {#a}', 'B {#A}'], ['names an earlier step too']],
  [['A', 'B T#5m:nope'], ['no step is named']], [['A T#5', 'B'], ["isn't a time"]]];
// The line in a project's description that makes it a workflow: on its own, anywhere in it.
const marks = [['<p>pocket:workflow</p>', true], ['<p>Line 2 startups</p><p>Pocket:Workflow </p>', true], ['Notes<br>pocket:workflow', true],
  ['<p>Tracks our hiring workflow</p>', false], ['<p>see pocket:workflow in the docs</p>', false], ['', false]];

// ---------- run ----------
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${http.address().port}/`);
await page.waitForFunction(() => typeof parseCapture === 'function' && typeof chrono !== 'undefined');
const PROJECTS = ['project', 'project with long name', 'today', 'project1'].map((title, i) => ({ id: i + 1, title }));
const results = await page.evaluate(([cases, projects]) => cases.map(c => {
  const r = parseCapture(c.text, projects, { now: new Date(c.now), dueTime: c.dueTime, ignore: c.ignore, mode: c.mode });
  return { title: r.title, date: r.due && `${r.due.getFullYear()}-${r.due.getMonth() + 1}-${r.due.getDate()}`, time: r.due && `${r.due.getHours()}:${r.due.getMinutes()}`,
    repeat: r.repeat && { after: r.repeat.after, mode: r.repeat.mode }, labels: r.labels, assignees: r.assignees, project: r.project?.title ?? r.projectMiss, priority: r.priority,
    marks: r.marks };
}), [cases.map(c => ({ ...c, now: +(c.now || REF) })), PROJECTS]);
const listResults = await page.evaluate(lists => lists.map(l => captureLines(l.text)), lists);
const stepResults = await page.evaluate(steps => steps.map(([text]) => parseStep(text)), steps);
const templateResults = await page.evaluate(ts => ts.map(([titles]) => stepProblems(titles).map(p => p.text)), templates);
const collisionResults = await page.evaluate(([cs, projects]) => cs.map(([text, token, mode]) => {
  const read = t => { const r = parseCapture(t, projects, { now: new Date(2021, 5, 24, 12, 0), mode }); return { title: r.title, due: r.due && r.due.getTime(), project: r.project?.title ?? null, labels: r.labels }; };
  return [read(text), read(text + ' ' + token)];
}), [collisions, PROJECTS]);
const markResults = await page.evaluate(marks => marks.map(([html]) => isWorkflowDesc(html)), marks);
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
  for (const k of ['repeat', 'labels', 'assignees', 'project', 'priority']) if (k in c && !same(r[k], c[k])) bad.push(`${k} ${JSON.stringify(r[k])}`);
  const marked = r.marks.map(m => m.kind + ':' + c.text.slice(m.start, m.end));
  if ('marked' in c && !same(marked, c.marked)) bad.push(`marked ${JSON.stringify(marked)}`);
  // The marks are what was read: taking them out of the text leaves the title, give or take spaces. (@username stays.)
  if (c.mode !== 'disabled' && !/^\s*(["'])[\s\S]*\1\s*$/.test(c.text)) {
    let rest = c.text;
    for (const m of [...r.marks].reverse()) if (m.kind !== 'assignees') rest = rest.slice(0, m.start) + ' ' + rest.slice(m.end);
    if (rest.replace(/\s+/g, '') !== r.title.replace(/\s+/g, '')) bad.push(`marks leave "${rest.replace(/\s+/g, ' ').trim()}"`);
  }
  if (bad.length) { failed++; console.log(`FAIL ${JSON.stringify(c.text)}${c.pocket ? ` [Pocket: ${c.why}]` : ''}: ${bad.join(', ')}`); }
});
lists.forEach((l, i) => {
  if (!same(listResults[i], l.lines)) { failed++; console.log(`FAIL pasted list [${l.why}]: ${JSON.stringify(listResults[i])}`); }
});
steps.forEach(([text, title, offset, name, ref, problems], i) => {
  const r = stepResults[i];
  if (r.title !== title || r.offset !== offset || r.name !== name || r.ref !== ref || r.problems.length !== problems)
    { failed++; console.log(`FAIL step ${JSON.stringify(text)}: ${JSON.stringify(r)}`); }
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
  if (markResults[i] !== want) { failed++; console.log(`FAIL workflow marker ${JSON.stringify(html)}: ${markResults[i]}`); }
});
const wf = steps.length + templates.length + collisions.length + marks.length, total = cases.length + lists.length + wf;
console.log(`${total - failed} of ${total} passed (${cases.filter(c => c.pocket).length} are Pocket-specific, ${lists.length} are pasted lists, ${wf} are workflow steps and markers)`);
process.exitCode = failed ? 1 : 0;
