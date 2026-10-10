/* What Pocket sends out of a list, each with a job of its own (design rule 9). Share as text is what you see
   (shareText): a task's, a project's or a run's progress as plain text for a message, with the figures the screen
   shows, for a person to read. Copy as a Markdown list comes back (markdownText): a task or a project written in quick
   add's words, so pasted into Pocket's add box it makes the same tasks. Built from data only, never from HTML, so the
   unit tests check every rule here. Each item is
   {title, done, pct: its own progress (0–100), due, people: who's on it, by: who did it (a run's step), skipped,
   priority, labels: their names, repeat: {after, mode}, as Vikunja keeps them (repeat_after, repeat_mode),
   items: what's under it, subs: {done, total} when items leaves out the done ones (a project's list), ring: a parent's
   worked-out figure, {pct, done, total}, as its ring shows it (ringOf, app/cards.js; parent-tasks-plan, part 5)}. */
import {parseCapture, QUICK_ADD_PREFIXES, readList, removeAssignee} from './quickadd.js';

// A person as a text names them: the first word of their name, else their username.
export const firstName = u => String(u?.name || '').trim().split(/\s+/)[0] || u?.username || '';
const names = users => [...new Set((users || []).map(firstName).filter(Boolean))].join(', ');
const handles = users => [...new Set((users || []).map(u => u?.username).filter(Boolean))].map(n => '@' + n).join(' ');

/* Five segments for a task's own progress: one at least once it's begun, and the fifth only when it's all done. A
   parent's (`ring`: its worked-out figure) has one segment per subtask, filled for each done, as its ring counts them. */
export function bar(pct, ring = null){
  if (ring) return '▰'.repeat(ring.done) + '▱'.repeat(Math.max(0, ring.total - ring.done));
  const n = Math.min(pct >= 100 ? 5 : 4, Math.max(pct > 0 ? 1 : 0, Math.round(pct / 20)));
  return '▰'.repeat(n) + '▱'.repeat(5 - n);
}

/* How far along an item is: a parent's, the worked-out figure its ring shows (`ring`), with a run's skipped steps said
   apart; else its own progress; done, with nothing under it, all of it; else how many of what's under it are done ("2
   of 5 done", skipped ones counted apart, as a run's screen says). {pct, words, ring}, words '' for none. */
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

/* A due date in a few words, as a text would put it: "today", "tomorrow", "Fri", "Oct 12", and one that's passed,
   "overdue since Mon". `now` for the tests. */
export function dueWords(due, now = new Date()){
  if (!due || String(due).startsWith('0001')) return '';
  const d = new Date(due), day = x => { const y = new Date(x); y.setHours(0, 0, 0, 0); return y; };
  const diff = Math.round((day(d) - day(now)) / 864e5);
  const date = d.toLocaleDateString([], {month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined});
  const when = diff === 0 ? 'today' : diff === 1 ? 'tomorrow' : diff === -1 ? 'yesterday' : Math.abs(diff) < 7 ? d.toLocaleDateString([], {weekday: 'short'}) : date;
  return diff < 0 ? 'overdue since ' + when : 'due ' + when;
}

// A count as the screen writes it: "3,000" (lists.html).
const num = n => Number(n).toLocaleString();
// Every line under the title, depth first: how long the text would be.
const count = items => items.reduce((n, it) => n + 1 + count(it.items || []), 0);
/* On a long list (more than 10 lines), a list with more than 5 done collapses them into one line, "✓ 8 done", where
   the first of them was, saying who did them on a run: the rest stay in full. */
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

// One item, as a line of a text: ✓ done, ◐ under way with how far, ○ not begun, – skipped; who's on it, or who did it.
function textLine(it, depth, withBar, now){
  const p = progress(it), mark = it.skipped ? '–' : it.done ? '✓' : p.pct > 0 ? '◐' : '○';
  let line = '  '.repeat(depth) + mark + ' ' + it.title;
  if (!it.done && p.words) line += withBar ? `  ${bar(p.pct, p.ring)} ${p.words}` : /^\d+%/.test(p.words) ? ' ' + p.words : ` (${p.words})`;
  const due = !it.done && dueWords(it.due, now);
  if (due) line += ' · ' + due;
  const who = it.skipped ? 'skipped' + (it.by?.length ? ' by ' + names(it.by) : '') : names(it.done ? it.by : it.people);
  return who ? line + ' · ' + who : line;
}
// `long`: the text is long enough to collapse what's done; `bars`: a top-level item has a bar (a project's tasks).
function textLines(items, depth, {long, bars, now}){
  return collapsed(items, long).flatMap(it => it.fold ? ['  '.repeat(depth) + foldLine(it.fold)]
    : [textLine(it, depth, bars && !depth, now), ...textLines(it.items || [], depth + 1, {long, bars, now})]);
}

/* The text to share. `doc`: {kind: 'task' | 'run' | 'project', ...the item}; a project's also has {open, doneCount}, its
   counts, and its items are its open tasks, in its list's order, each with its open subtasks under it.
     Pack the van  ▰▱▱▱ 38%
     ✓ Load chairs
     ◐ Tables 50%
     ○ Sound system · Priya
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

// A run's steps as a Markdown list, who did each and who skipped one: words for people, as it was written before.
function runLines(items, depth, now){
  return items.flatMap(it => {
    const p = progress(it), due = !it.done && dueWords(it.due, now), extra = [!it.done && p.words, due].filter(Boolean).join(', ');
    let line = '  '.repeat(depth) + `- [${it.done ? 'x' : ' '}] ` + (it.skipped ? `~~${it.title}~~` : it.title) + (extra ? ` (${extra})` : '');
    const who = handles(it.done ? it.by : it.people);
    if (it.skipped) line += ' (skipped' + (who ? ' by ' + who : '') + ')'; else if (who) line += ' ' + who;
    return [line, ...runLines(it.items || [], depth + 1, now)];
  });
}

/* ---------- a copy that comes back: quick add's words ---------- */
const two = n => String(n).padStart(2, '0');
/* A due date as quick add reads it at the end of a line: in numbers, with its year, so it means the same day pasted
   next week or next year, overdue or not ("Oct 1" pasted after October 1 would be next year's); then "at 15:30" when
   its time isn't the default due time (`dueTime`, "HH:MM"), which a date alone gets. The hour has two digits: quick
   add reads a bare "at 5:30" as the afternoon's. */
export function dueStamp(due, dueTime = '12:00'){
  if (!due || String(due).startsWith('0001')) return '';
  const d = new Date(due), [h, m] = String(dueTime).split(':').map(Number);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}` + (d.getHours() === (h || 0) && d.getMinutes() === (m || 0) ? '' : ` at ${two(d.getHours())}:${two(d.getMinutes())}`);
}
/* A repeat in quick add's words: "every month" for the same day each month (Vikunja's monthly mode), else "every week",
   "every 3 days", in the largest unit that fits, as quick add counts them back (a year 365 days). '' for none, or for
   one that isn't whole hours. */
export function repeatPhrase(r){
  if (r?.mode === 1) return 'every month';
  const after = r?.after || 0;
  for (const [unit, s] of [['year', 365 * 86400], ['week', 604800], ['day', 86400], ['hour', 3600]])
    if (after > 0 && after % s === 0) return after === s ? 'every ' + unit : `every ${after / s} ${unit}s`;
  return '';
}
// A name after a prefix, quoted when it has a space in it: *"call back".
const named = w => /\s/.test(w) ? (w.includes('"') ? `'${w}'` : `"${w}"`) : w;
// Whether an item has subtasks, shown or not: then it has no progress of its own.
const isParent = it => !!(it.ring || (it.items || []).length || it.subs?.total);
/* An item as a line in quick add's words, after `lead` (its heading's #s, or its bullet and checkbox): its title, its
   own progress "(50%)" if it has some and no subtasks (a parent's is worked out from what's under it), then who's on
   it, its priority, its labels and its repeat, with the user's own prefixes (+user and @label in Todoist mode), then
   its due date, last. With quick add turned off, only its title and progress, which are read all the same.
   A title that quick add would read words in is quoted, so it isn't: - [ ] "Lunch friday" @sam 2026-10-16 (quotes
   round the start of a line hold its title: parseCapture). Only when it needs it, so most lines have none: the line is
   read back as the add box would read it (`head`: as a list's first line, whose colon at the end would make it a
   parent), and if that isn't this item, it's quoted, with ' when the title has a " in it. A title neither holds (it has
   both, each before a space) is written as it is. */
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
// Each item as a Markdown task, "- [x]" done or "- [ ]" open, what's under it two spaces further in.
const mdLines = (items, depth, opts) => items.flatMap(it => [quickLine(it, '  '.repeat(depth) + `- [${it.done ? 'x' : ' '}] `, opts), ...mdLines(it.items || [], depth + 1, opts)]);
/* A task or a project as a Markdown list that comes back: pasted into Pocket's add box, it makes the same tasks, with
   the same done state, nesting, people, labels, priority, dates, repeats and progress (design rule 9; quickadd.js reads
   it, and share.test.mjs reads each one back). A task is a heading, "## Pack the van @priya !3 2026-10-16" ("## [x]"
   when it's done), then its subtasks, each a line. Nothing collapsed. A project: "# Café", its counts, then its open
   tasks, each with its open subtasks. What it never carries, so a paste never makes: notes, comments, photos, and a
   project's done tasks. `opts`: {mode: the user's Quick Add Magic mode, whose prefixes it's written with ("disabled":
   with none of those words); dueTime: their default due time}. A run's is still its record, for people (runLines). */
export function markdownText(doc, {mode = 'vikunja', dueTime = '12:00', now = new Date()} = {}){
  const items = doc.items || [], opts = {mode, dueTime};
  if (doc.kind === 'run') return [`## ${doc.title}` + (progress(doc).words ? ` (${progress(doc).words})` : ''), '', ...runLines(items, 0, now)].join('\n').trimEnd();
  if (doc.kind === 'project')
    return [`# ${doc.title}`, '', `${num(doc.open)} open` + (doc.doneCount ? ` · ${num(doc.doneCount)} done` : ''), '', ...mdLines(items, 0, opts)].join('\n').trimEnd();
  return [quickLine(doc, `## ${doc.done ? '[x] ' : ''}`, opts, true), ...mdLines(items, 0, opts)].join('\n');
}
