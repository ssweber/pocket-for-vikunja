// Checklists: how templates, runs and timed steps are kept in Vikunja, and steps as they are written.
import {allPages, ApiError} from './api.js';
import {htmlToText, parseFragment} from './html.js';
import {isSet} from './dates.js';
import {NUMBER_WORDS} from './quickadd.js';

/* Checklists live in a project with a line "pocket:checklists" in its description. In it,
   a template is a task labelled "template" and marked done, and its subtasks, also done, are its steps (in the order
   below). A run is a copy of a template with a copy of each step under it, made with Vikunja's duplicate, so every copy
   keeps a "copied from" link to what it was copied from. Who did a step is a reaction on it: ✅ when it was done, ⏭️
   when it was skipped. */
export const CHECKLIST_MARK = 'pocket:checklists';
export const isChecklistDesc = html => htmlToText(html || '').split('\n').some(l => l.trim().toLowerCase() === CHECKLIST_MARK);
/* A template's step order, a line "pocket:order 12 15 13" in its description, written when a step is moved: Vikunja
   can't order subtasks, and gives them in no set order. Steps it doesn't list follow in the order they were made (by
   id), and ids no longer steps are skipped, so adding or removing a step leaves the line alone. A run has a line of its
   own, written when it starts, so it never reads its template's again, and when a step is inserted in it. */
export const ORDER_MARK = 'pocket:order';
const ORDER_LINE = /^pocket:order(\s+\d+)*$/i;
/* A run keeps what it was started from, in lines of its own, so changing or deleting its template changes only runs
   started after: "pocket:run" in its description, so it's a run without its template, and "pocket:step <the template
   step's title then>" in each step's, which its time is read from. A step inserted during the run, or repeated, has
   "pocket:added": a repeated one also keeps the "pocket:step" line of the one it repeats. */
const RUN_LINE = /^pocket:run$/i, STEP_LINE = /^pocket:step\s+\S/i, ADDED_LINE = /^pocket:added$/i;
// The lines in a description matching `re`: a paragraph of their own, or a line of one (after Shift+Enter in Vikunja's
// editor), not in a list. The first is the one read; any other is left over, and taken out when the line is written.
function markLines(root, re){
  const out = [], walk = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n; (n = walk.nextNode());) if (re.test(n.nodeValue.trim()) && !n.parentElement.closest('li')) out.push(n);
  return out;
}
export function stepOrder(html){
  const line = markLines(parseFragment(html || ''), ORDER_LINE)[0];
  return line ? (line.nodeValue.match(/\d+/g) || []).map(Number) : null;
}
export const isRunDesc = html => !!markLines(parseFragment(html || ''), RUN_LINE).length;
export const isAddedDesc = html => !!markLines(parseFragment(html || ''), ADDED_LINE).length;
// "Inserted" or "Repeated", for a step added during its run; '' for one from its template.
export const addedText = html => !isAddedDesc(html) ? '' : stepLine(html) !== null ? 'Repeated' : 'Inserted';
// A run's step's title in its template when the run started, or null for a run started before runs kept it.
export function stepLine(html){
  const line = markLines(parseFragment(html || ''), STEP_LINE)[0];
  return line ? line.nodeValue.trim().replace(/^pocket:step\s+/i, '') : null;
}
export function inOrder(steps, order){
  const at = new Map((order || []).map((id, k) => [id, k]));
  return [...steps].sort((a, b) => (at.get(a.id) ?? Infinity) - (at.get(b.id) ?? Infinity) || a.id - b.id);
}
// The ids with `id` put just before `before`; if that's gone, just after `after` (the step it was inserted under), and if
// that's gone too, at the end. As they are if it's in them already.
export const placeBefore = (ids, id, before, after = null) => {
  if (ids.includes(id)) return ids;
  const out = [...ids], at = out.indexOf(before), prev = out.indexOf(after);
  out.splice(at >= 0 ? at : prev >= 0 ? prev + 1 : out.length, 0, id);
  return out;
};
// The description with its line matching `re` set to `text` (taken out, for null), the rest as it was.
function withLine(html, re, text){
  const root = parseFragment(html || ''), [line, ...extra] = markLines(root, re);
  for (const n of text !== null ? extra : [line, ...extra].filter(Boolean)) {
    const p = n.parentNode, br = [n.nextSibling, n.previousSibling].find(x => x?.nodeName === 'BR');
    n.remove(); br?.remove();
    if (p !== root && !p.textContent.trim() && !p.querySelector('img, hr, table')) p.remove();   // its paragraph, now empty
  }
  if (text !== null && line) line.nodeValue = text;
  else if (text !== null) { const p = root.ownerDocument.createElement('p'); p.textContent = text; root.append(p); }
  return root.innerHTML;
}
// The description with its order line set to these ids (taken out, for null), the rest as it was.
export const withOrder = (html, ids) => withLine(html, ORDER_LINE, ids ? `${ORDER_MARK} ${ids.join(' ')}` : null);
export const withRunMark = html => withLine(html, RUN_LINE, 'pocket:run');
export const withStepLine = (html, title) => withLine(html, STEP_LINE, title === null ? null : 'pocket:step ' + title);
export const withAdded = html => withLine(html, ADDED_LINE, 'pocket:added');
// The notes alone, without Pocket's lines.
export const notesOnly = html => [ORDER_LINE, RUN_LINE, STEP_LINE, ADDED_LINE].reduce((h, re) => withLine(h, re, null), html || '');
// The notes as written, with the lines `from` has put back.
export function withLinesOf(html, from){
  const order = stepOrder(from), step = stepLine(from);
  if (order) html = withOrder(html, order);
  if (isRunDesc(from)) html = withRunMark(html);
  if (step !== null) html = withStepLine(html, step);
  if (isAddedDesc(from)) html = withAdded(html);
  return html;
}
export const isTemplateLabel = l => (l?.title || '').trim().toLowerCase() === 'template';
export const hasTemplateLabel = t => (t?.labels || []).some(isTemplateLabel);
/* A template: labelled "template", not anyone's step, and done, or not done with a due date: then it's Vikunja's
   repeating task, which comes round at its time, and starting a run ticks it. A copy still being set up as a run has the
   label too, not done, with the template's date: its "copied from" link, or its run line, says it isn't one. */
export const isTemplate = t => !!t && hasTemplateLabel(t) && !t.related_tasks?.parenttask?.length
  && (t.done || (isSet(t.due_date) && !t.related_tasks?.copiedfrom?.length && !isRunDesc(t.description)));
// A template that comes round: one with a due date, left not done.
export const comesRound = t => isTemplate(t) && !t.done;
/* A template's title starts with "TEMPLATE: ", so it says what it is wherever Vikunja shows it, and isn't deleted on
   the web by mistake. Pocket shows the name without it. A template without it still is one: the label says so. */
export const TEMPLATE_PREFIX = 'TEMPLATE: ';
export const templateName = title => String(title || '').replace(/^\s*template:\s*/i, '');
export const templateTitle = name => TEMPLATE_PREFIX + templateName(name).trim();
// How a template repeats, in words: "every day", "every 3 days", "every month", or '' for not at all. Vikunja's "from the
// day it's done" (mode 2) counts from when a run is started, which ticks the template.
export function repeatWords(t){
  if (t.repeat_mode === 1) return 'every month';
  const s = t.repeat_after || 0;
  if (!s) return '';
  const n = s % 86400 === 0 ? [s / 86400, 'day'] : s % 3600 === 0 ? [s / 3600, 'hour'] : [Math.round(s / 60), 'minute'];
  const every = n[0] === 1 ? 'every ' + n[1] : n[1] === 'day' && n[0] % 7 === 0 ? `every ${n[0] / 7 === 1 ? '' : n[0] / 7 + ' '}week${n[0] / 7 === 1 ? '' : 's'}` : `every ${n[0]} ${n[1]}s`;
  return t.repeat_mode === 2 ? every + ' after a run starts' : every;
}
/* Where Vikunja moves a template when it's ticked: by at least one beat, and every so often (mode 0) on to the first
   time after now; every month one month only (so one left for months is still late); from the day it's done, the
   interval after now. Null if it doesn't repeat. Checked on Vikunja 2.7 (the plan's "Check first"). */
export function vikunjaNext(t, now = Date.now()){
  const due = Date.parse(t.due_date);
  if (!isSet(t.due_date)) return null;
  if (t.repeat_mode === 1) return addMonths(due, 1);
  const s = (t.repeat_after || 0) * 1000;
  if (!s) return null;
  if (t.repeat_mode === 2) return now + s;
  return due + Math.max(1, Math.floor((now - due) / s) + 1) * s;
}
// The first time after `now` on the template's beat, moved on from `from`: where Pocket moves one that Vikunja's tick
// left in the past (every month).
export function nextAfter(t, from, now = Date.now()){
  let d = from;
  for (let i = 1; d <= now && i < 1200; i++) d = t.repeat_mode === 1 ? addMonths(from, i) : from + i * (t.repeat_after || 0) * 1000;
  return d;
}
// A month on, as Vikunja does it (Go's AddDate): the same day of the month, overflowing into the next (Jan 31 → Mar 3).
const addMonths = (ms, n) => { const d = new Date(ms); d.setUTCMonth(d.getUTCMonth() + n); return +d; };
// An open run: a copy of a template, at the top (not anyone's step), and not one still being set up (labelled "template").
export const isRun = t => !t.done && !t.related_tasks?.parenttask?.length && (!!t.related_tasks?.copiedfrom?.length || isRunDesc(t.description)) && !hasTemplateLabel(t);
// A step of a run: under a task, and copied from a template's step, or with its line, or inserted during the run.
export const isRunStepTask = t => !!t?.related_tasks?.parenttask?.length && (!!t.related_tasks.copiedfrom?.length || stepLine(t.description) !== null || isAddedDesc(t.description));
// Whether a task's subtasks are in its own order line: a template's or a run's steps. Any other task's are in its
// project's List view (order.js).
export const hasOwnOrder = t => { const r = t?.related_tasks || {}; return hasTemplateLabel(t) || (!!(r.copiedfrom?.length || isRunDesc(t?.description)) && !r.parenttask?.length); };
// A template's or a run's steps in order (its own order line); any other task's subtasks as Vikunja gives them.
export function stepsOf(t){
  const subs = t?.related_tasks?.subtask || [];
  return hasOwnOrder(t) ? inOrder(subs, stepOrder(t?.description)) : subs;
}
export const DONE_MARK = '✅', SKIP_MARK = '⏭️';
/* Who skipped a done step, or null: someone who left a ⏭️ and a "Skipped" note since it was last marked done. Vikunja
   lets each person take back only their own ⏭️, so one left before the step was unticked and done again doesn't count.
   (The note follows the tick, and both times are Vikunja's.) */
export function skippedBy(s){
  if (!s.done) return null;
  const since = Date.parse(s.done_at), marked = new Set((s.reactions?.[SKIP_MARK] || []).map(u => u.id));
  return (s.comments || []).filter(c => marked.has(c.author?.id) && Date.parse(c.created) >= since && /^skipped\b/i.test(htmlToText(c.comment))).pop()?.author || null;
}
// What quick add leaves alone in a checklist's steps: dates (a step's time is its T#), and the project, so every step
// stays in its template's project, as Pocket's plugin needs.
export const STEP_IGNORE = {due: true, repeat: true, project: true};
/* When a step is due, written in its title in the template, the way IEC 61131-3 writes times:
     Put the roast in {#roast}    names the step "roast"
     Peel the potatoes T#20m      due 20 minutes after the step before it is done (the first step: after the run starts)
     Baste the roast T#40m:roast  due 40 minutes after the step named "roast" is done
   Units are d, h, m, s and ms, and combine: T#1h30m. A step without a time has no due date: it's simply next. Copies
   of the steps in a run have their titles without these, and Pocket's plugin sets their due dates as steps are done. */
const STEP_UNITS = {d: 864e5, h: 36e5, m: 6e4, s: 1e3, ms: 1}, STEP_MAX = 365 * 864e5;   // a year, as main.go
const STEP_TIME = /(^|\s)(T#\S*)/gi, STEP_NAME = /\{#([^}\s]*)\}/g, NAME_OK = /^[a-z][\w-]*$/i;
const sameName = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
export function parseStep(title){
  const out = {title: '', offset: null, name: null, ref: null, problems: []};
  const t = String(title || '').replace(STEP_TIME, (_, sp, tok) => {
    const m = tok.match(/^T#(-?)((?:\d+(?:\.\d+)?(?:ms|d|h|m|s))+)(?::(.*))?$/i);
    if (!m) out.problems.push(`“${tok}” isn't a time: write it like T#20m or T#1h30m`);
    else if (m[1]) out.problems.push(`“${tok}”: a step can't be due before another`);
    else if (m[3] !== undefined && !NAME_OK.test(m[3])) out.problems.push(`“${tok}”: a name starts with a letter`);
    else if (out.offset !== null) out.problems.push('a step can have only one T# time');
    else {
      const ms = Math.round([...m[2].matchAll(/(\d+(?:\.\d+)?)(ms|d|h|m|s)/gi)].reduce((n, u) => n + u[1] * STEP_UNITS[u[2].toLowerCase()], 0));
      if (!(ms <= STEP_MAX)) out.problems.push(`“${tok}” is longer than a year`);
      else { out.offset = ms; out.ref = m[3] ?? null; }
    }
    return sp;
  }).replace(STEP_NAME, (tok, name) => {
    if (!NAME_OK.test(name)) out.problems.push(`“${tok}”: a name starts with a letter`);
    else if (out.name) out.problems.push('a step can have only one {#name}');
    else out.name = name;
    return ' ';
  });
  out.title = t.replace(/\s{2,}/g, ' ').trim();
  return out;
}
// What's wrong with a template's steps, in order: each step's own problems, a name used twice, and a time counted
// from a name that isn't an earlier step's (so none can wait on itself, or on one after it).
export function stepProblems(titles){
  const steps = titles.map(parseStep), out = [];
  steps.forEach((s, i) => {
    const say = text => out.push({i, title: s.title, text});
    s.problems.forEach(say);
    if (s.ref && !steps.slice(0, i).some(x => sameName(x.name, s.ref)))
      say(steps.slice(i).some(x => sameName(x.name, s.ref)) ? `its time counts from “${s.ref}”, which has to be an earlier step` : `no step is named “${s.ref}”`);
    if (s.name && steps.slice(0, i).some(x => sameName(x.name, s.name))) say(`“${s.name}” names an earlier step too`);
  });
  return out;
}
export const problemText = ps => `step ${ps[0].i + 1}, “${ps[0].title}”: ${ps[0].text}` + (ps.length > 1 ? ` (and ${ps.length - 1} more)` : '');
// 5400000 -> "1h 30m". The two largest parts, so a countdown stays short.
export function durText(ms){
  const parts = [];
  let left = Math.round(ms / 1000);
  for (const [u, n] of [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]]) if (left >= n) { parts.push(Math.floor(left / n) + u); left %= n; }
  return parts.slice(0, 2).join(' ') || '0s';
}
/* Where a run goes next, the one rule for it (parent-tasks-plan, part 2): the run's screen after a tick and as it opens,
   and a run's card on Today, as it opens and once the step it showed has gone. Steps go in order: of its `steps`
   ({id, done, counting: a countdown running, dueAt: when it ends}), the next open one after `from` (the step just done,
   or null), even one still counting down, which shows its countdown; round to the first open one. A timed step whose
   time has come (its countdown at zero, or late) comes before it, the first of those in order. Its index, or -1 with
   none open but `from`. */
export function whereNext(steps, now, from = null){
  const k = from ? steps.findIndex(x => x.id === from.id) : -1;
  const open = steps.map((x, i) => ({x, i})).filter(({x}) => !x.done && x.id !== from?.id);
  return (open.find(({x}) => x.counting && x.dueAt <= now) || open.find(o => o.i > k) || open[0])?.i ?? -1;
}
// The step a timed step counts from, by index, in a list of parsed steps: -1 for the start of the run, null for none.
export function stepFrom(steps, i){
  const s = steps[i];
  if (s.offset === null) return null;
  if (!s.ref) return i - 1;
  const j = steps.findIndex(x => sameName(x.name, s.ref));
  return j >= 0 && j < i ? j : null;
}
/* A step's time in words, read while steps are written in Pocket: "in 20 min", "after an hour", "20 minutes later",
   "1h 30m after". Saved as T#20m. Words that say what to do, like "for 2 minutes" or "rest 10 minutes", aren't read. */
const STEP_UNIT = '(?:seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|wks?|w)(?![a-z])';
const STEP_UNIT_MS = [[/^s/, 1e3], [/^m/, 6e4], [/^h/, 36e5], [/^d/, 864e5], [/^w/, 6048e5]];
let stepPhraseRe = null;
export function readStepPhrase(text){
  const words = `(?:an?|${Object.keys(NUMBER_WORDS).join('|')})`;
  const part = `(?:\\d+(?:\\.\\d+)?\\s*|${words}\\s+)${STEP_UNIT}`, dur = `(?:half an hour|${part}(?:\\s*(?:and\\s+)?${part})*)`;
  stepPhraseRe ||= new RegExp(`(^|\\s)(?:(?:in|after)\\s+(${dur})|(${dur})\\s+(?:later|after))(?=\\s|$|[,.!?;:])`, 'i');
  const m = String(text || '').match(stepPhraseRe);
  if (!m) return null;
  const said = m[2] || m[3];
  const half = /^half an hour$/i.test(said);
  let offset = half ? 18e5 : 0;
  if (!half) for (const p of said.matchAll(new RegExp(`(?:(\\d+(?:\\.\\d+)?)\\s*|(${words})\\s+)(${STEP_UNIT})`, 'gi'))) {
    const n = p[1] ? +p[1] : NUMBER_WORDS[p[2].toLowerCase()] ?? 1;
    offset += n * STEP_UNIT_MS.find(([re]) => re.test(p[3].toLowerCase()))[1];
  }
  if (!(offset <= STEP_MAX)) return null;
  return {index: m.index + m[1].length, length: m[0].length - m[1].length, offset: Math.round(offset), text: m[0].slice(m[1].length)};
}
/* A template step's title as it's written in Pocket: "Baste T#40m:roast" -> "Baste 40m after Put the roast in". Its
   {#name} stays, as other steps may count from it. */
export function stepWords(title, titles){
  const s = parseStep(title);
  if (s.offset === null) return title;
  const ref = s.ref && titles.map(parseStep).find(x => sameName(x.name, s.ref));
  const when = s.ref ? (ref ? `${durText(s.offset)} after ${ref.title}` : null) : `in ${durText(s.offset)}`;
  return when ? `${s.title} ${when}` + (s.name ? ` {#${s.name}}` : '') : title;
}
/* After "<time> after", the name of an earlier step, as written ("the" and "starting" in front are fine): {key, length}
   of what names it, or null. The latest step with that name. */
function afterStep(text, phrase, before){
  if (!/\safter$/i.test(phrase.text.trim()) || !before.length) return null;
  const rest = text.slice(phrase.index + phrase.length), lead = rest.match(/^\s+(?:(?:the|starting|start of)\s+)?/i);
  if (!lead) return null;
  const body = rest.slice(lead[0].length).toLowerCase();
  for (let k = before.length - 1; k >= 0; k--) {
    const title = parseStep(before[k].text).title.toLowerCase().replace(/[.!?]+$/, '');
    for (const name of new Set([title, title.replace(/^the\s+/, '')])) {
      if (name && body.startsWith(name) && !/[a-z0-9]/i.test(body[name.length] || '')) return {key: before[k].key, length: lead[0].length + name.length};
    }
  }
  return null;
}
// 5400000 -> "T#1h30m"; with a name, "T#1h30m:roast".
function stepToken(ms, ref){
  let t = '', left = Math.round(ms);
  for (const [u, n] of [['d', 864e5], ['h', 36e5], ['m', 6e4], ['s', 1e3], ['ms', 1]]) if (left >= n) { t += Math.floor(left / n) + u; left %= n; }
  return `T#${t || '0m'}${ref ? ':' + ref : ''}`;
}
// A name for a step from its first words, "Put the roast in" -> "put-the-roast", "Warm up the press" -> "warm-up",
// and not one already taken.
const NAME_FILLER = /^(?:a|an|the|and|or|of|to|in|on|at|for|with|by)$/;
function stepName(title, taken){
  const words = (title.toLowerCase().match(/[a-z0-9]+/g) || []).slice(0, 3);
  while (words.length > 1 && NAME_FILLER.test(words[words.length - 1])) words.pop();
  let base = words.join('-') || 'step';
  if (!/^[a-z]/.test(base)) base = 'step-' + base;
  let name = base;
  for (let n = 2; taken.some(t => sameName(t, name)); n++) name = `${base}-${n}`;
  return name;
}
/* Steps being written in Pocket, a row each ({key, text, keep, from}), after `before` ({key, text}: a template's steps
   already there): what each is saved as, and how it reads. A time in words becomes T#…, unless `keep` keeps the
   words. `from`: null as written, '' the step before, or another row's key: that step, which gets a name made from its
   words if it has none. So a step keeps counting from the same one when rows are moved. */
// `clean` takes what quick add reads out of a title (@people, *labels), so a step is named by its words alone.
export function draftSteps(rows, before = [], clean = t => t){
  const all = [...before.map(b => ({...b, fixed: true})), ...rows.filter(r => r.text.trim())];
  const parsed = all.map(r => parseStep(r.text)), at = new Map(all.map((r, i) => [r.key, i]));
  const phrase = all.map((r, i) => r.fixed || /(^|\s)T#/i.test(r.text) ? null : readStepPhrase(r.text));
  // "30 minutes after the first article check": the words naming an earlier step go with the time, and the step counts
  // from that one, as if it were picked in the chip (which still wins).
  const named = all.map((r, i) => phrase[i] && afterStep(r.text, phrase[i], all.slice(0, i)));
  named.forEach((n, i) => { if (n) phrase[i] = {...phrase[i], length: phrase[i].length + n.length, text: phrase[i].text + all[i].text.slice(phrase[i].index + phrase[i].length, phrase[i].index + phrase[i].length + n.length)}; });
  const fromOf = (r, i) => r.from ?? (r.keep ? null : named[i]?.key ?? null);
  const names = parsed.map(p => p.name), taken = names.filter(Boolean);
  for (const [i, r] of all.entries()) {
    const j = at.get(fromOf(r, i));
    if (j !== undefined && !names[j]) { names[j] = stepName(clean(parsed[j].title), taken); taken.push(names[j]); }
  }
  const saved = all.map((r, i) => {
    let t = r.text.trim();
    const read = phrase[i] && !r.keep ? phrase[i] : null, offset = read ? read.offset : parsed[i].offset;
    if (read) t = (t.slice(0, read.index) + t.slice(read.index + read.length)).replace(/\s+([,.!?;:])(?=\s|$)/g, '$1').trim() + ' ' + stepToken(offset);
    const from = fromOf(r, i);
    if (offset !== null && (from === '' || at.has(from))) t = t.replace(/(^|\s)T#\S*/i, (_, sp) => sp + stepToken(offset, from ? names[at.get(from)] : null));
    if (names[i] && !parsed[i].name) t += ` {#${names[i]}}`;
    return t.replace(/\s{2,}/g, ' ').trim();
  });
  const steps = saved.map(parseStep), infos = stepInfos(saved), info = new Map();
  all.forEach((r, i) => {
    if (r.fixed) return;
    const j = stepFrom(steps, i), from = fromOf(r, i), lost = !!from && !at.has(from) && steps[i].offset !== null;
    info.set(r.key, {i, saved: saved[i], offset: steps[i].offset, name: steps[i].name, text: infos[i].text, lost,
      problem: infos[i].problem || (lost ? 'the step it counts from isn\'t in this template any more: pick one' : ''),
      phrase: phrase[i]?.text || '', kept: !!(phrase[i] && r.keep), from: j === null || j < 0 ? '' : steps[i].ref ? all[j].key : '',
      choices: all.slice(0, i).map(x => ({key: x.key, title: clean(parseStep(x.text).title)}))});
  });
  return {info, added: saved.filter((_, i) => !all[i].fixed), problem: [...info.values()].some(x => x.problem),
    renames: all.map((r, i) => r.fixed && saved[i] !== r.text.trim() ? {key: r.key, title: saved[i]} : null).filter(Boolean)};
}
// A template's steps as shown: each one's title, when it's due in a run, its name, and what's wrong with it.
export function stepInfos(titles){
  const steps = titles.map(parseStep), problems = stepProblems(titles);
  return steps.map((s, i) => {
    const j = stepFrom(steps, i), from = j === -1 ? 'the start' : j !== null && `“${steps[j].title}”`;
    const when = !from ? '' : s.offset === 0 ? (j === -1 ? 'due at the start' : `due when ${from} is done`) : `due ${durText(s.offset)} after ${from}`;
    const text = [when, s.name && `named “${s.name}”`].filter(Boolean).join(' · ');
    return {title: s.title, text: text && text[0].toUpperCase() + text.slice(1), problem: problems.filter(p => p.i === i).map(p => p.text).join('; ')};
  });
}
// Vikunja busy can answer 500 (on SQLite, "database is locked"): a few quick tries before taking it as an answer.
export async function patiently(fn){
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) { if (!(e instanceof ApiError && e.status >= 500) || i >= 2) throw e; await new Promise(r => setTimeout(r, 400 * (i + 1))); }
  }
}
// A task with all its comments: expand=comments gives the first 50.
export async function allComments(t){
  if ((t.comments || []).length >= 50) t.comments = await allPages(`/tasks/${t.id}/comments`);
  return t;
}
// fn over each of a list, n at a time, in the list's order.
export async function inBatches(list, n, fn){
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(...await Promise.all(list.slice(i, i + n).map(fn)));
  return out;
}
const fmtWhen = d => new Date(d).toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'});
export const noteOf = c => ({id: c.id, comment: c.comment, author: c.author?.name || c.author?.username || 'Someone', when: fmtWhen(c.created)});
/* A run's name without the day it was started, its last part ("Opening up · run 2 · Oct 8": "Opening up · run 2"), for
   its card on Today, whose heading has when it's due at the right, as a task's has. Only the day as a start writes it
   (runTitle), the day Vikunja made it or up to a week before (a start made offline): any other name stays whole. */
export function runWithoutDay(title, created){
  const parts = (title || '').split(' · '), at = Date.parse(created);
  if (parts.length < 3 || !(at > 0)) return title;
  for (let i = 0; i < 8; i++) if (new Date(at - i * 864e5).toLocaleDateString([], {month: 'short', day: 'numeric'}) === parts.at(-1)) return parts.slice(0, -1).join(' · ');
  return title;
}
// What a run's screen keeps of a run and its steps, also saved for opening it offline.
export const plainRun = t => ({id: t.id, title: t.title, done: t.done, project_id: t.project_id, assignees: t.assignees || [], created_by: t.created_by || null,
  created: t.created || null, comments: t.comments || [], from: t.related_tasks?.copiedfrom?.[0]?.id || null, steps: stepsOf(t).map(s => s.id)});
export const plainStep = t => ({id: t.id, title: t.title, done: t.done, done_at: t.done_at, due_date: t.due_date, updated: t.updated, percent_done: t.percent_done || 0, description: t.description || '', assignees: t.assignees || [],
  attachments: t.attachments || [], reactions: t.reactions || {}, comments: t.comments || [], tpl: stepLine(t.description) ?? t.related_tasks?.copiedfrom?.[0]?.title ?? null,
  added: addedText(t.description), from: t.related_tasks?.copiedfrom?.[0]?.id ?? null});
