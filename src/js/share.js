/* Text and Markdown copies of a task, a project or a checklist (a `run`). Share as text (shareText) copies what the
   screen shows, as plain text for a message. Copy as Markdown (markdownText) writes a list in quick add's syntax, so
   pasting it into Pocket's add box makes the same tasks again. A checklist has only the text copy, because pasting
   can't bring back the record of who did and who skipped each step. Both are built from data, never from HTML, so
   the unit tests check every rule here.

   An item is {title, done, pct, due, people, by, skipped, priority, labels, repeat, items, subs, ring}:
   - `pct` is its own progress, 0–100.
   - `people` are the users assigned, and `by` the users who did a step.
   - `labels` are label names, and `repeat` is {after, mode} as Vikunja keeps it.
   - `items` are the subtasks or steps under it.
   - `subs` is {done, total}, for when `items` leaves out the done ones.
   - `ring` is a parent's calculated progress, {pct, done, total}. */
import {parseCapture, QUICK_ADD_PREFIXES, readList, removeAssignee} from './quickadd.js';

// The text names a person by the first word of their name, or by their username if they have no name.
export const firstName = u => String(u?.name || '').trim().split(/\s+/)[0] || u?.username || '';
const names = users => [...new Set((users || []).map(firstName).filter(Boolean))].join(', ');

/* A five-segment bar for a task's own progress. It has at least one segment filled once the task is begun, and all
   five only when the task is done. A parent (`ring`) gets one segment per subtask, filled for each done subtask. */
export function bar(pct, ring = null){
  if (ring) return '▰'.repeat(ring.done) + '▱'.repeat(Math.max(0, ring.total - ring.done));
  const n = Math.min(pct >= 100 ? 5 : 4, Math.max(pct > 0 ? 1 : 0, Math.round(pct / 20)));
  return '▰'.repeat(n) + '▱'.repeat(5 - n);
}

/* How far along an item is, as {pct, words, ring}. A parent uses its ring, and skipped steps are counted separately.
   Any other item uses its own progress. Failing that it shows "2 of 5 done", counted from the items under it, or
   'done'. `words` is '' for a task that is not begun. */
export function progress(it){
  if (it.ring) {
    const skipped = (it.items || []).filter(k => k.skipped).length;
    return {pct: it.ring.pct, words: it.ring.pct + '%' + (skipped ? ` · ${skipped} skipped` : ''), ring: it.ring};
  }
  if (!it.done && it.pct > 0) return {pct: Math.round(it.pct), words: Math.round(it.pct) + '%'};
  const kids = it.items || [], c = it.subs || {done: kids.filter(k => k.done).length, total: kids.length};
  const skipped = it.subs ? 0 : kids.filter(k => k.skipped).length, did = c.done - skipped;
  if (c.total) return {pct: Math.round(100 * c.done / c.total), words: `${did} of ${c.total} done` + (skipped ? ` · ${skipped} skipped` : '')};
  return it.done ? {pct: 100, words: 'done'} : {pct: 0, words: ''};
}

// A due date in a few words: "due today", "due Fri", "due Oct 12", "overdue since Mon". The tests pass `now`.
export function dueWords(due, now = new Date()){
  if (!due || String(due).startsWith('0001')) return '';
  const d = new Date(due), day = x => { const y = new Date(x); y.setHours(0, 0, 0, 0); return y; };
  const diff = Math.round((day(d) - day(now)) / 864e5);
  const date = d.toLocaleDateString([], {month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined});
  const when = diff === 0 ? 'today' : diff === 1 ? 'tomorrow' : diff === -1 ? 'yesterday' : Math.abs(diff) < 7 ? d.toLocaleDateString([], {weekday: 'short'}) : date;
  return diff < 0 ? 'overdue since ' + when : 'due ' + when;
}

// A count with thousands separators, as the screen shows it: "3,000".
const num = n => Number(n).toLocaleString();
// How many lines the items make, at every depth.
const count = items => items.reduce((n, it) => n + 1 + count(it.items || []), 0);
/* A text longer than 10 lines collapses more than 5 done items into one line, "✓ 8 done". The line sits where the
   first of them was and names who did them. */
export const COLLAPSE = {lines: 10, done: 5};
function collapsed(items, long){
  const done = items.filter(it => it.done);
  if (!long || done.length <= COLLAPSE.done) return items;
  const at = items.indexOf(done[0]);
  return [...items.slice(0, at).filter(it => !it.done), {fold: done}, ...items.slice(at).filter(it => !it.done)];
}
function foldLine(done){
  const skipped = done.filter(it => it.skipped).length, who = names(done.flatMap(it => it.by || []));
  return `✓ ${done.length - skipped} done` + (skipped ? `, ${skipped} skipped` : '') + (who ? ' · ' + who : '');
}

// One item as a line. It starts with a mark: ✓ done, ◐ begun (then how far), ○ not begun, – skipped. The due
// date and the people assigned, or who did it, follow the title.
function textLine(it, depth, withBar, now){
  const p = progress(it), mark = it.skipped ? '–' : it.done ? '✓' : p.pct > 0 ? '◐' : '○';
  let line = '  '.repeat(depth) + mark + ' ' + it.title;
  if (!it.done && p.words) line += withBar ? `  ${bar(p.pct, p.ring)} ${p.words}` : /^\d+%/.test(p.words) ? ' ' + p.words : ` (${p.words})`;
  const due = !it.done && dueWords(it.due, now);
  if (due) line += ' · ' + due;
  const who = it.skipped ? 'skipped' + (it.by?.length ? ' by ' + names(it.by) : '') : names(it.done ? it.by : it.people);
  return who ? line + ' · ' + who : line;
}
// `long` collapses the done items. `bars` gives top-level items a bar (a project's tasks).
function textLines(items, depth, {long, bars, now}){
  return collapsed(items, long).flatMap(it => it.fold ? ['  '.repeat(depth) + foldLine(it.fold)]
    : [textLine(it, depth, bars && !depth, now), ...textLines(it.items || [], depth + 1, {long, bars, now})]);
}

/* The text to share. `doc` is {kind: 'task' | 'run' | 'project', ...the item}. A project also has {open, doneCount}.
   Its items are its open tasks in list order, each with its open subtasks. For example:
     Pack the van  ▰▱▱▱ 38%
     ✓ Load chairs
     ◐ Tables 50%
     ○ Sound system · @user
     ○ Lights */
export function shareText(doc, now = new Date()){
  const items = doc.items || [];
  if (doc.kind === 'project') {
    const head = doc.title + `  ${num(doc.open)} open` + (doc.doneCount ? ` · ${num(doc.doneCount)} done` : '');
    return [head, ...textLines(items, 0, {long: false, bars: true, now}), ...doc.doneCount ? [`✓ ${num(doc.doneCount)} done`] : []].join('\n');
  }
  const p = progress(doc), due = !doc.done && dueWords(doc.due, now), who = names(doc.people);
  const head = doc.title + (p.words ? `  ${bar(p.pct, p.ring)} ${p.words}` : '') + (due ? ' · ' + due : '') + (who ? ' · ' + who : '');
  return [head, ...textLines(items, 0, {long: count(items) > COLLAPSE.lines, bars: false, now})].join('\n');
}


/* ---------- Markdown in quick add's words ---------- */
const two = n => String(n).padStart(2, '0');
/* A due date as quick add reads it at the end of a line. It is numeric and includes the year, so it means the same day
   whenever it is pasted ("Oct 1" pasted after October 1 would mean next year). "at 15:30" follows when the time isn't
   the default due time (`dueTime`), which a date alone gets. The hour has two digits because quick add reads a bare
   "at 5:30" as the afternoon. */
export function dueStamp(due, dueTime = '12:00'){
  if (!due || String(due).startsWith('0001')) return '';
  const d = new Date(due), [h, m] = String(dueTime).split(':').map(Number);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}` + (d.getHours() === (h || 0) && d.getMinutes() === (m || 0) ? '' : ` at ${two(d.getHours())}:${two(d.getMinutes())}`);
}
/* A repeat in quick add's syntax. Vikunja's monthly mode gives "every month". Otherwise the phrase uses the largest
   unit that divides the interval evenly ("every week", "every 3 days"), with a year counted as 365 days. It returns
   '' for no repeat, and for an interval that isn't a whole number of hours. */
export function repeatPhrase(r){
  if (r?.mode === 1) return 'every month';
  const after = r?.after || 0;
  for (const [unit, s] of [['year', 365 * 86400], ['week', 604800], ['day', 86400], ['hour', 3600]])
    if (after > 0 && after % s === 0) return after === s ? 'every ' + unit : `every ${after / s} ${unit}s`;
  return '';
}
// A name after a prefix, in quotes when it contains a space: *"call back".
const named = w => /\s/.test(w) ? (w.includes('"') ? `'${w}'` : `"${w}"`) : w;
// Whether an item has subtasks, whether or not they are shown. A parent has no progress of its own.
const isParent = it => !!(it.ring || (it.items || []).length || it.subs?.total);
/* An item as one line in quick add's syntax, after `lead` (its heading's #s, or its bullet and checkbox). The line
   holds the title, then "(50%)" when the item has progress of its own, then people, priority, labels and repeat with
   the user's own prefixes, then the due date last. With quick add turned off, the line has only the title and the
   progress.

   A title that quick add would read dates, people or labels out of is put in quotes, so quick add leaves it alone:
   - [ ] "Lunch friday" @user 2026-10-16. Quotes are added only when needed, so most lines have none. To decide, the
   function reads the line back the way the add box would. `head` reads it as a list's first line, where a colon at
   the end would make the item a parent. If that doesn't give this item back, the title is quoted, with ' when it
   contains a ". A title that contains both quote marks is written as it is. */
function quickLine(it, lead, {mode, dueTime}, head = false){
  const P = QUICK_ADD_PREFIXES[mode] || null, pct = Math.round(it.pct || 0), own = !it.done && !isParent(it) && pct >= 1 && pct <= 99 ? pct : 0;
  const people = [...new Set((it.people || []).map(u => u?.username).filter(Boolean))], labels = [...new Set(it.labels || [])], prio = it.priority >= 1 && it.priority <= 5 ? it.priority : 0;
  const words = !P ? [] : [...people.map(n => P.assignee + named(n)), prio ? '!' + prio : '', ...labels.map(l => P.label + named(l)), repeatPhrase(it.repeat), dueStamp(it.due, dueTime)];
  const line = title => lead + [title, own ? `(${own}%)` : '', ...words].filter(Boolean).join(' ');
  if (!P) return line(it.title);
  const said = (title, done, figure, who, priority, tags, repeat, due) => JSON.stringify([title, !!done, figure, who, priority, tags, repeatPhrase(repeat), repeat && !due ? '' : dueStamp(due, dueTime)]);
  const want = said(it.title, it.done, own, people, prio, labels, it.repeat, it.due);
  const comesBack = title => {
    const l = readList(line(title) + (head ? '\n- x' : ''), {colon: head}).lines[0], p = l && parseCapture(l.text, [], {mode, dueTime});
    return !!p && want === said(people.reduce((t, n) => removeAssignee(t, P.assignee, n), p.title), l.done, p.pct, p.assignees, p.priority, p.labels,
      p.repeat && {after: p.repeat.after, mode: p.repeat.mode}, p.dueFromRepeat ? null : p.due?.toISOString());
  };
  const quotes = it.title.includes('"') ? ["'", '"'] : ['"', "'"];
  return line([it.title, ...quotes.map(q => q + it.title + q)].find(comesBack) ?? it.title);
}
// Each item as a Markdown task line, "- [x]" done or "- [ ]" open, with its subtasks indented two spaces.
const mdLines = (items, depth, opts) => items.flatMap(it => [quickLine(it, '  '.repeat(depth) + `- [${it.done ? 'x' : ' '}] `, opts), ...mdLines(it.items || [], depth + 1, opts)]);
/* A task or a project as a Markdown list that can be pasted back. Pasted into Pocket's add box, it makes the same
   tasks, with the same done state, nesting, people, labels, priority, dates, repeats and progress (share.test.mjs
   reads each one back).

   A task is a heading, "## Pack the van @user !3 2026-10-16" ("## [x]" when done), then its subtasks one per line,
   with nothing collapsed. A project is "# Café · 12 open · 5 done", then its open tasks with their open subtasks.
   When pasted back, the heading is not made into a task. It is read as the list's name. Notes, comments, photos and a project's done
   tasks are not copied, so pasting never makes them.

   `opts` is {mode, dueTime}. `mode` is the user's Quick Add Magic mode ("disabled" for no prefixes), and `dueTime` is
   their default due time.

   A checklist has no Markdown copy. Pasting "- [x] Load chairs @user" would assign a new task, and quick add has no
   syntax for skipped. Share as text keeps that record. */
export function markdownText(doc, {mode = 'vikunja', dueTime = '12:00'} = {}){
  const items = doc.items || [], opts = {mode, dueTime};
  if (doc.kind === 'project') return [`# ${doc.title} · ${num(doc.open)} open` + (doc.doneCount ? ` · ${num(doc.doneCount)} done` : ''), ...mdLines(items, 0, opts)].join('\n');
  return [quickLine(doc, `## ${doc.done ? '[x] ' : ''}`, opts, true), ...mdLines(items, 0, opts)].join('\n');
}
