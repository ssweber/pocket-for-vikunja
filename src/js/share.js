/* A task's, a project's or a run's progress as text, to send: plain text for a text message (shareText), or a Markdown
   list (markdownText). Built from data only, never from HTML, so the unit tests check every rule here. Each item is
   {title, done, pct: its own progress (0–100), due, people: who's on it, by: who did it (a run's step), skipped,
   items: what's under it, subs: {done, total} when items leaves out the done ones (a project's list), ring: a parent's
   worked-out figure, {pct, done, total}, as its ring shows it (ringOf, app/cards.js; parent-tasks-plan, part 5)}. */

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
    const head = doc.title + `  ${doc.open} open` + (doc.doneCount ? ` · ${doc.doneCount} done` : '');
    return [head, ...textLines(items, 0, {long: false, bars: true, now}), ...doc.doneCount ? [`✓ ${doc.doneCount} done`] : []].join('\n');
  }
  const p = progress(doc), due = !doc.done && dueWords(doc.due, now), who = names(doc.people);
  const head = doc.title + (p.words ? `  ${bar(p.pct, p.ring)} ${p.words}` : '') + (due ? ' · ' + due : '') + (who ? ' · ' + who : '');
  return [head, ...textLines(items, 0, {long: count(items) > COLLAPSE.lines, bars: false, now})].join('\n');
}

// One item as a Markdown task: "- [ ] Tables (50%, due Fri) @sam", what's under it indented two spaces.
function mdLines(items, depth, now){
  return items.flatMap(it => {
    const p = progress(it), due = !it.done && dueWords(it.due, now), extra = [!it.done && p.words, due].filter(Boolean).join(', ');
    let line = '  '.repeat(depth) + `- [${it.done ? 'x' : ' '}] ` + (it.skipped ? `~~${it.title}~~` : it.title) + (extra ? ` (${extra})` : '');
    const who = handles(it.done ? it.by : it.people);
    if (it.skipped) line += ' (skipped' + (who ? ' by ' + who : '') + ')'; else if (who) line += ' ' + who;
    return [line, ...mdLines(it.items || [], depth + 1, now)];
  });
}
/* The same as a Markdown list, to paste into notes: "## Pack the van (38%)", then a task list. Nothing collapsed: it's
   a copy to keep. A project: "# Café", its counts, then its open tasks. */
export function markdownText(doc, now = new Date()){
  const items = doc.items || [];
  if (doc.kind === 'project')
    return [`# ${doc.title}`, '', `${doc.open} open` + (doc.doneCount ? ` · ${doc.doneCount} done` : ''), '', ...mdLines(items, 0, now)].join('\n').trimEnd();
  const p = progress(doc), due = !doc.done && dueWords(doc.due, now), who = handles(doc.people);
  const under = [due && due[0].toUpperCase() + due.slice(1), who].filter(Boolean).join(' · ');
  return [`## ${doc.title}` + (p.words ? ` (${p.words})` : ''), ...under ? [under] : [], '', ...mdLines(items, 0, now)].join('\n').trimEnd();
}
