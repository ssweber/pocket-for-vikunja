// Due dates, as Vikunja keeps them and as Pocket shows them.
import {ZERO} from './util.js';

export const isSet = d => d && !String(d).startsWith('0001');
export const startOfDay = (d=new Date()) => { const x = new Date(d); x.setHours(0,0,0,0); return x; };
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate()+n); return x; };
export const fmtTime = d => d.toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});
export function dueInfo(due){
  if (!isSet(due)) return null;
  const d = new Date(due), today = startOfDay(), dd = startOfDay(d);
  const diff = Math.round((dd - today) / 864e5);
  const hasTime = !(d.getHours() === 0 && d.getMinutes() === 0) && !(d.getHours() === 12 && d.getMinutes() === 0);
  let label;
  if (diff === 0) label = 'Today';
  else if (diff === 1) label = 'Tomorrow';
  else if (diff === -1) label = 'Yesterday';
  else if (diff < -1 && diff > -7) label = diff * -1 + ' days ago';
  else if (diff > 1 && diff < 7) label = d.toLocaleDateString([], {weekday:'long'});
  else label = d.toLocaleDateString([], {day:'numeric', month:'short', year: d.getFullYear() !== today.getFullYear() ? 'numeric' : undefined});
  if (hasTime && Math.abs(diff) < 7) label += ' ' + fmtTime(d);
  return {label, cls: diff < 0 ? 'overdue' : diff === 0 ? 'today' : '', diff};
}
export const toLocalInput = iso => { if (!isSet(iso)) return ''; const d = new Date(iso); const p = n => String(n).padStart(2,'0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
export const fromLocalInput = v => v ? new Date(v).toISOString() : ZERO;
export const repeats = t => !!(t.repeat_after || t.repeat_mode === 1);
