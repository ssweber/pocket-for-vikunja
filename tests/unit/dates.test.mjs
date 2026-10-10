// Due dates as Pocket shows them (src/js/dates.js), with the clock set to Wednesday 7 October 2026, 14:20.
import './browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, dueInfo, fromLocalInput, isLate, isSet, movedDue, repeats, shortDue, shortTime, startOfDay, toLocalInput } from '../../src/js/dates.js';

const NOW = new Date(2026, 9, 7, 14, 20);
const at = (d, h = 0, m = 0) => new Date(2026, 9, d, h, m).toISOString();
const fmt = (h, m) => new Date(2026, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

test('Vikunja\'s "no date" isn\'t a date', () => {
  assert.equal(!!isSet('0001-01-01T00:00:00Z'), false);
  assert.equal(!!isSet(null), false);
  assert.equal(!!isSet(''), false);
  assert.equal(isSet(at(7)), true);
});

test('a row on one line says when, short: a time today, a weekday this week, a date beyond; red when late', () => {
  const day = (d, o) => new Date(2026, 9, d).toLocaleDateString([], o);
  assert.deepEqual(shortDue(at(7, 16, 30), NOW), { text: shortTime(fmt(16, 30)), cls: 'today' });
  assert.deepEqual(shortDue(at(7, 11, 55), NOW), { text: shortTime(fmt(11, 55)), cls: 'overdue' }, 'its time passed: late');
  assert.deepEqual(shortDue(at(7), NOW), { text: 'Today', cls: 'today' }, 'today, with no time of its own');
  assert.deepEqual(shortDue(at(9, 9), NOW), { text: day(9, { weekday: 'short' }), cls: '' }, 'this week: its weekday, no time');
  assert.deepEqual(shortDue(at(13), NOW), { text: day(13, { weekday: 'short' }), cls: '' });
  assert.deepEqual(shortDue(at(14), NOW), { text: day(14, { month: 'short', day: 'numeric' }), cls: '' }, 'a week on: its date');
  assert.deepEqual(shortDue(at(2), NOW), { text: day(2, { month: 'short', day: 'numeric' }), cls: 'overdue' }, 'days ago: its date, late');
  assert.equal(shortDue(new Date(2027, 0, 5).toISOString(), NOW).text, new Date(2027, 0, 5).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }), 'another year: with it');
  assert.equal(shortDue('0001-01-01T00:00:00Z', NOW), null);
  // Under Today's heading, "Today" says nothing new: today with no time says nothing there (one-concept-plan, part 4).
  assert.equal(shortDue(at(7), NOW, { underToday: true }), null, 'under Today: today with no time, nothing');
  assert.deepEqual(shortDue(at(7, 16, 30), NOW, { underToday: true }), { text: shortTime(fmt(16, 30)), cls: 'today' }, 'its time still');
  assert.deepEqual(shortDue(at(9), NOW, { underToday: true }), { text: day(9, { weekday: 'short' }), cls: '' }, 'another day still');
});

// rows-and-sheet-fixes-plan, part 4: a title on Today has little room, so its time has few letters.
test('a time on one line is written short where the phone writes AM and PM: “10:30a”, “3p”, noon “12p”; a 24-hour clock’s is kept', () => {
  const time = (h, m, locale) => new Date(2026, 0, 1, h, m).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  const short = (h, m, locale = 'en-US') => shortTime(time(h, m, locale));
  assert.deepEqual([short(10, 30), short(15, 30), short(9, 5), short(23, 59)], ['10:30a', '3:30p', '9:05a', '11:59p']);
  assert.deepEqual([short(15, 0), short(9, 0), short(10, 0)], ['3p', '9a', '10a'], 'a whole hour: without its “:00”');
  assert.deepEqual([short(12, 0), short(12, 30), short(0, 30), short(0, 0)], ['12p', '12:30p', '12:30a', '12a'], 'noon and after midnight: 12, with the half of the day it is');
  // A 24-hour clock, as the phone writes it: nothing to shorten.
  for (const locale of ['en-GB', 'de-DE', 'en-US-u-hc-h23']) for (const [h, m] of [[15, 30], [15, 0], [9, 5], [0, 30]]) assert.equal(short(h, m, locale), time(h, m, locale), `${locale} ${h}:${m}`);
  assert.deepEqual([short(15, 30, 'en-GB'), short(15, 0, 'de-DE')], ['15:30', '15:00']);
  // AM and PM as other phones write them: small, with dots, after a narrow space or none.
  assert.deepEqual(['3:00 pm', '3:30 p.m.', '3:30 p. m.', '10:30\u202fAM', '10:30\u00a0a.\u00a0m.', '3:30PM', '3.30 pm'].map(shortTime), ['3p', '3:30p', '3:30p', '10:30a', '10:30a', '3:30p', '3.30p']);
  // A day's halves in other words, or before the time: as the phone writes it.
  for (const text of ['午後3:00', 'PM 3:00', '15 h 00', '٣:٠٠ م', 'Today', '']) assert.equal(shortTime(text), text);
});

test('when it’s due, short, follows the phone’s clock: “4:30p” on a 12-hour one, “16:30” on a 24-hour one', t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const real = Date.prototype.toLocaleTimeString;
  let locale = 'en-US';
  t.mock.method(Date.prototype, 'toLocaleTimeString', function (l, o) { return real.call(this, locale, o); });
  assert.deepEqual([shortDue(at(7, 16, 30), NOW).text, shortDue(at(7, 16), NOW).text, shortDue(at(7, 12), NOW).text, shortDue(at(7, 0, 5), NOW).text], ['4:30p', '4p', '12p', '12:05a']);
  assert.equal(shortDue(at(7), NOW).text, 'Today', 'midnight is no time of its own: never “12a”');
  assert.match(dueInfo(at(7, 16, 30)).label, /^Today 4:30\sPM$/, 'in words, as a sheet and a screen reader have it: in full');
  locale = 'en-GB';
  assert.deepEqual([shortDue(at(7, 16, 30), NOW).text, shortDue(at(7, 16), NOW).text, shortDue(at(7, 21, 5), NOW).text], ['16:30', '16:00', '21:05']);
});

test('late once its time has passed; one due at midnight, once its day is over', () => {
  assert.equal(isLate(at(7, 14, 19), NOW), true);
  assert.equal(isLate(at(7, 14, 21), NOW), false);
  assert.equal(isLate(at(7), NOW), false, 'due today, with no time of its own');
  assert.equal(isLate(at(6), NOW), true);
  assert.equal(isLate('0001-01-01T00:00:00Z', NOW), false);
});

test('a due date in words, near ones with their time', t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  assert.deepEqual(dueInfo(at(7, 9, 30)), { label: 'Today ' + fmt(9, 30), cls: 'overdue', diff: 0 });
  assert.deepEqual(dueInfo(at(7, 17)), { label: 'Today ' + fmt(17, 0), cls: 'today', diff: 0 });
  assert.deepEqual(dueInfo(at(7)), { label: 'Today', cls: 'today', diff: 0 });
  assert.equal(dueInfo(at(8)).label, 'Tomorrow');
  assert.equal(dueInfo(at(6)).label, 'Yesterday');
  assert.equal(dueInfo(at(6)).cls, 'overdue');
  assert.equal(dueInfo(at(3)).label, '4 days ago');
  assert.equal(dueInfo(at(10)).label, new Date(2026, 9, 10).toLocaleDateString([], { weekday: 'long' }));
  assert.equal(dueInfo(at(20, 9)).label, new Date(2026, 9, 20).toLocaleDateString([], { day: 'numeric', month: 'short' }), 'a week or more away: the date, without its time');
  assert.match(dueInfo(new Date(2027, 0, 5).toISOString()).label, /2027/, 'another year says which');
  assert.equal(dueInfo('0001-01-01T00:00:00Z'), null);
});

test('the date box\'s value and back', () => {
  assert.equal(toLocalInput(at(7, 9, 5)), '2026-10-07T09:05');
  assert.equal(fromLocalInput('2026-10-07T09:05'), at(7, 9, 5));
  assert.equal(toLocalInput('0001-01-01T00:00:00Z'), '');
  assert.equal(fromLocalInput(''), '0001-01-01T00:00:00Z');
});

test('days, from midnight', () => {
  assert.equal(+startOfDay(NOW), +new Date(2026, 9, 7));
  assert.equal(+addDays(NOW, 30), +new Date(2026, 10, 6, 14, 20));
});

test('what repeats: every so often, or every month', () => {
  assert.equal(repeats({ repeat_after: 86400 }), true);
  assert.equal(repeats({ repeat_mode: 1 }), true);
  assert.equal(repeats({ repeat_after: 0, repeat_mode: 0 }), false);
});

test('a date moved to another day keeps its time of day, or none; today, a time gone is the next whole hour', () => {
  const now = new Date(2026, 9, 7, 14, 20), at = (d, h, m = 0) => new Date(2026, 9, d, h, m).toISOString(), fri = new Date(2026, 9, 9);
  assert.equal(movedDue(at(7, 16), fri, now), at(9, 16), 'Friday at 4 PM, as it was');
  assert.equal(movedDue(at(5, 0), fri, now), at(9, 0), 'no time of its own: none on Friday either');
  assert.equal(movedDue('0001-01-01T00:00:00Z', fri, now), at(9, 0), 'no date at all: Friday, with no time');
  assert.equal(movedDue(at(5, 9), now, now), at(7, 15), 'today, its time gone: the next whole hour');
  assert.equal(movedDue(at(5, 18, 30), now, now), at(7, 18, 30), 'today, its time still to come');
  assert.equal(movedDue(at(5, 0), now, now), at(7, 0), 'today, with no time: due today, not late');
  const late = new Date(2026, 9, 7, 23, 10);
  assert.equal(movedDue(at(5, 9), late, late), at(7, 23, 59), 'in the day\'s last hour: 11:59 PM');
});
