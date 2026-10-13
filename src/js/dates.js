// Due dates, as Vikunja keeps them and as Pocket shows them.
import {ZERO} from './util.js';

export const isSet = d => d && !String(d).startsWith('0001');
export const startOfDay = (d=new Date()) => { const x = new Date(d); x.setHours(0,0,0,0); return x; };
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate()+n); return x; };
export const fmtTime = d => d.toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});
// A due date at midnight has no time of its own, which is how Vikunja's web app sets a date alone.
const noTime = d => !d.getHours() && !d.getMinutes();
/* Whether a task is late: its due time has passed, as in Vikunja, whether the time was typed or filled in (noon for
   "friday", say). A task due at midnight is due all that day, and late once the day is over. */
export function isLate(due, now = new Date()){
  if (!isSet(due)) return false;
  const d = new Date(due);
  return noTime(d) ? startOfDay(d) < startOfDay(now) : d < now;
}
export function dueInfo(due){
  if (!isSet(due)) return null;
  const d = new Date(due), today = startOfDay(), dd = startOfDay(d);
  const diff = Math.round((dd - today) / 864e5);
  const hasTime = !noTime(d);
  let label;
  if (diff === 0) label = 'Today';
  else if (diff === 1) label = 'Tomorrow';
  else if (diff === -1) label = 'Yesterday';
  else if (diff < -1 && diff > -7) label = diff * -1 + ' days ago';
  else if (diff > 1 && diff < 7) label = d.toLocaleDateString([], {weekday:'long'});
  else label = d.toLocaleDateString([], {day:'numeric', month:'short', year: d.getFullYear() !== today.getFullYear() ? 'numeric' : undefined});
  if (hasTime && Math.abs(diff) < 7) label += ' ' + fmtTime(d);
  return {label, cls: diff < 0 || isLate(due) ? 'overdue' : diff === 0 ? 'today' : '', diff};
}
/* Shorten a time from fmtTime for a one-line row, where a title has little room. "10:30 AM" becomes "10:30a", "3:00 pm"
   or "3:00 p.m." becomes "3p", noon "12p". Anything else stays as it is: a 24-hour "15:30", or AM and PM written in
   other words or before the time. Screen readers, sheets and a row's second line get fmtTime's text. */
export const shortTime = text => { const m = /^(\d{1,2})([:.])(\d\d)\s*([ap])\.?\s?m\.?$/i.exec(text); return m ? m[1] + (m[3] === '00' ? '' : m[2] + m[3]) + m[4].toLowerCase() : text; };
/* When a task is due, short, for a one-line row: its time if due today ("11:55a", or "Today" with no time), its weekday
   if due in the coming week ("Fri"), else its date ("Oct 2", with the year when not this year's). `cls` is as in
   dueInfo. Null with no date, and under Today's heading (`underToday`) for a task due today with no time, where
   "Today" says nothing new. */
export function shortDue(due, now = new Date(), {underToday = false} = {}){
  if (!isSet(due)) return null;
  const d = new Date(due), diff = Math.round((startOfDay(d) - startOfDay(now)) / 864e5);
  if (underToday && diff === 0 && noTime(d)) return null;
  const text = diff === 0 ? (noTime(d) ? 'Today' : shortTime(fmtTime(d))) : diff > 0 && diff < 7 ? d.toLocaleDateString([], {weekday: 'short'})
    : d.toLocaleDateString([], {month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined});
  return {text, cls: diff < 0 || isLate(due, now) ? 'overdue' : diff === 0 ? 'today' : ''};
}
export const toLocalInput = iso => { if (!isSet(iso)) return ''; const d = new Date(iso); const p = n => String(n).padStart(2,'0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
export const fromLocalInput = v => v ? new Date(v).toISOString() : ZERO;
export const repeats = t => !!(t.repeat_after || t.repeat_mode === 1);
/* The due date for a task moved to `day`, keeping its time of day, or with no time if it had none. If that time on
   `day` has already passed, the next whole hour instead, or 11:59 PM in the day's last hour, so the task isn't late
   again at once. */
export function movedDue(due, day, now = new Date()){
  const d = isSet(due) ? new Date(due) : startOfDay(day);
  d.setFullYear(day.getFullYear(), day.getMonth(), day.getDate());
  if (!isLate(d.toISOString(), now)) return d.toISOString();
  const next = new Date(now); next.setHours(now.getHours() + 1, 0, 0, 0);
  if (next.getDate() !== now.getDate()) next.setTime(new Date(now).setHours(23, 59, 0, 0));
  return next.toISOString();
}
