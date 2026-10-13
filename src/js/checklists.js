// Checklists: how templates, runs and timed steps are stored in Vikunja, and how steps are parsed as they are typed.
// Pocket marks its own data with lines in task descriptions, and these functions read and write those lines.
import {allPages, ApiError} from './api.js';
import {htmlToText, parseFragment} from './html.js';
import {isSet} from './dates.js';
import {NUMBER_WORDS} from './quickadd.js';

/* Checklists live in a project with the line "pocket:checklists" in its description. A template is a task in that
   project, labelled "template" and marked done. Its subtasks, also marked done, are its steps.

   A run is a copy of a template with a copy of each step under it. Pocket makes the copies with Vikunja's duplicate,
   so each copy keeps a "copied from" link. A reaction on a step shows who did it: ✅ for done, ⏭️ for skipped. */
export const CHECKLIST_MARK = 'pocket:checklists';
export const isChecklistDesc = html => htmlToText(html || '').split('\n').some(l => l.trim().toLowerCase() === CHECKLIST_MARK);
/* The order of the steps is stored as a line like "pocket:order 12 15 13" in the template's description. It is written
   when a step is moved, because Vikunja returns subtasks in no set order.

   Steps the line doesn't list follow in id order, and ids that are no longer steps are skipped. So adding or removing
   a step leaves the line alone.

   A run gets its own line when it starts, and writes it again when a step is inserted. A run never reads its
   template's line. */
export const ORDER_MARK = 'pocket:order';
const ORDER_LINE = /^pocket:order(\s+\d+)*$/i;
/* A run records what it was started from in lines in its own description, so changing or deleting the template
   affects only runs started later. The lines are:
   - "pocket:run" in the run's description marks it as a run even when its template is gone.
   - "pocket:step <the template step's title at the time>" in each step's description is where the step's time is
     read from.
   - "pocket:added" marks a step that was inserted or repeated during the run. A repeated step also keeps the
     "pocket:step" line of the step it repeats. */
const RUN_LINE = /^pocket:run$/i, STEP_LINE = /^pocket:step\s+\S/i, ADDED_LINE = /^pocket:added$/i;
// The text nodes in a description that match `re` and are outside lists. Such a node is a paragraph, or a line in a
// paragraph after Shift+Enter in Vikunja's editor. The first match is the one that is read. The others are
// leftovers, and they are removed when the line is next written.
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
// "Inserted" or "Repeated" for a step added during its run, and '' for a step copied from the template.
export const addedText = html => !isAddedDesc(html) ? '' : stepLine(html) !== null ? 'Repeated' : 'Inserted';
// A run step's title in the template when the run started. Null for a run started before Pocket recorded it.
export function stepLine(html){
  const line = markLines(parseFragment(html || ''), STEP_LINE)[0];
  return line ? line.nodeValue.trim().replace(/^pocket:step\s+/i, '') : null;
}
export function inOrder(steps, order){
  const at = new Map((order || []).map((id, k) => [id, k]));
  return [...steps].sort((a, b) => (at.get(a.id) ?? Infinity) - (at.get(b.id) ?? Infinity) || a.id - b.id);
}
// Insert `id` just before `before`. If `before` is no longer in `ids`, insert it just after `after`, the step it was
// inserted under. If that is gone too, insert it at the end. If `id` is already in `ids`, return `ids` unchanged.
export const placeBefore = (ids, id, before, after = null) => {
  if (ids.includes(id)) return ids;
  const out = [...ids], at = out.indexOf(before), prev = out.indexOf(after);
  out.splice(at >= 0 ? at : prev >= 0 ? prev + 1 : out.length, 0, id);
  return out;
};
// The description with its line matching `re` set to `text`, or removed when `text` is null. The rest of the
// description is untouched.
function withLine(html, re, text){
  const root = parseFragment(html || ''), [line, ...extra] = markLines(root, re);
  for (const n of text !== null ? extra : [line, ...extra].filter(Boolean)) {
    const p = n.parentNode, br = [n.nextSibling, n.previousSibling].find(x => x?.nodeName === 'BR');
    n.remove(); br?.remove();
    if (p !== root && !p.textContent.trim() && !p.querySelector('img, hr, table')) p.remove();   // the paragraph is now empty
  }
  if (text !== null && line) line.nodeValue = text;
  else if (text !== null) { const p = root.ownerDocument.createElement('p'); p.textContent = text; root.append(p); }
  return root.innerHTML;
}
// The description with its order line set to `ids`, or removed when `ids` is null.
export const withOrder = (html, ids) => withLine(html, ORDER_LINE, ids ? `${ORDER_MARK} ${ids.join(' ')}` : null);
export const withRunMark = html => withLine(html, RUN_LINE, 'pocket:run');
export const withStepLine = (html, title) => withLine(html, STEP_LINE, title === null ? null : 'pocket:step ' + title);
export const withAdded = html => withLine(html, ADDED_LINE, 'pocket:added');
// The notes alone, without Pocket's lines.
export const notesOnly = html => [ORDER_LINE, RUN_LINE, STEP_LINE, ADDED_LINE].reduce((h, re) => withLine(h, re, null), html || '');
// `html` with Pocket's lines copied over from the description `from`.
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
/* A template is labelled "template", is nobody's subtask, and is either done or open with a due date. An open
   template is a Vikunja repeating task that repeats at its due time, and starting a run ticks it.

   A copy that is still being set up as a run also has the label, and is open with the template's date. Its "copied
   from" link or run line shows that it is not a template. */
export const isTemplate = t => !!t && hasTemplateLabel(t) && !t.related_tasks?.parenttask?.length
  && (t.done || (isSet(t.due_date) && !t.related_tasks?.copiedfrom?.length && !isRunDesc(t.description)));
// A repeating template: open, with a due date.
export const comesRound = t => isTemplate(t) && !t.done;
/* A template's title starts with "TEMPLATE: ". That shows what the task is wherever Vikunja shows it, and keeps it
   from being deleted in the web app by mistake. Pocket shows the name without the prefix. The label, not the prefix,
   makes a task a template. */
export const TEMPLATE_PREFIX = 'TEMPLATE: ';
export const templateName = title => String(title || '').replace(/^\s*template:\s*/i, '');
export const templateTitle = name => TEMPLATE_PREFIX + templateName(name).trim();
// How a template repeats, as text: "every day", "every 3 days", "every month", or '' when it doesn't repeat. Vikunja's
// repeat mode 2 counts from when the task is done, which for a template is when a run starts.
export function repeatWords(t){
  if (t.repeat_mode === 1) return 'every month';
  const s = t.repeat_after || 0;
  if (!s) return '';
  const n = s % 86400 === 0 ? [s / 86400, 'day'] : s % 3600 === 0 ? [s / 3600, 'hour'] : [Math.round(s / 60), 'minute'];
  const every = n[0] === 1 ? 'every ' + n[1] : n[1] === 'day' && n[0] % 7 === 0 ? `every ${n[0] / 7 === 1 ? '' : n[0] / 7 + ' '}week${n[0] / 7 === 1 ? '' : 's'}` : `every ${n[0]} ${n[1]}s`;
  return t.repeat_mode === 2 ? every + ' after a checklist starts' : every;
}
/* The due date Vikunja gives a template when it's ticked, or null if it doesn't repeat. Mode 0 moves the date forward
   by whole intervals, to the first time after now. Monthly moves it forward one month only, so a template left for
   months is still late. Mode 2 sets it one interval after now. Checked on Vikunja 2.7. */
export function vikunjaNext(t, now = Date.now()){
  const due = Date.parse(t.due_date);
  if (!isSet(t.due_date)) return null;
  if (t.repeat_mode === 1) return addMonths(due, 1);
  const s = (t.repeat_after || 0) * 1000;
  if (!s) return null;
  if (t.repeat_mode === 2) return now + s;
  return due + Math.max(1, Math.floor((now - due) / s) + 1) * s;
}
// The first time after `now` that is a whole number of intervals (or months) after `from`. Pocket moves a monthly
// template to that time when Vikunja's tick left it in the past.
export function nextAfter(t, from, now = Date.now()){
  let d = from;
  for (let i = 1; d <= now && i < 1200; i++) d = t.repeat_mode === 1 ? addMonths(from, i) : from + i * (t.repeat_after || 0) * 1000;
  return d;
}
// Add `n` months the way Go's AddDate does in Vikunja. It keeps the same day of the month and overflows into the next
// month (Jan 31 → Mar 3).
const addMonths = (ms, n) => { const d = new Date(ms); d.setUTCMonth(d.getUTCMonth() + n); return +d; };
// An open run: a copy of a template that is nobody's subtask. A copy that still has the "template" label is still being
// set up, so it is not a run yet.
export const isRun = t => !t.done && !t.related_tasks?.parenttask?.length && (!!t.related_tasks?.copiedfrom?.length || isRunDesc(t.description)) && !hasTemplateLabel(t);
// A run's step: a subtask that was copied from a template step, has a "pocket:step" line, or was added during the run.
export const isRunStepTask = t => !!t?.related_tasks?.parenttask?.length && (!!t.related_tasks.copiedfrom?.length || stepLine(t.description) !== null || isAddedDesc(t.description));
// Whether a task orders its subtasks by its own order line, as templates and runs do. Other tasks order them by the
// project's List view (order.js).
export const hasOwnOrder = t => { const r = t?.related_tasks || {}; return hasTemplateLabel(t) || (!!(r.copiedfrom?.length || isRunDesc(t?.description)) && !r.parenttask?.length); };
// A task's subtasks. A template's or run's steps are in the order of its order line. Any other task's subtasks are in
// the order Vikunja gives them.
export function stepsOf(t){
  const subs = t?.related_tasks?.subtask || [];
  return hasOwnOrder(t) ? inOrder(subs, stepOrder(t?.description)) : subs;
}
export const DONE_MARK = '✅', SKIP_MARK = '⏭️';
/* The user who skipped a done step, or null. That user left a ⏭️ and a comment starting "Skipped" since the step
   was last marked done. A ⏭️ can linger from an earlier skip, because only its owner can remove it. So the
   comment's time decides. Both times come from Vikunja. */
export function skippedBy(s){
  if (!s.done) return null;
  const since = Date.parse(s.done_at), marked = new Set((s.reactions?.[SKIP_MARK] || []).map(u => u.id));
  return (s.comments || []).filter(c => marked.has(c.author?.id) && Date.parse(c.created) >= since && /^skipped\b/i.test(htmlToText(c.comment))).pop()?.author || null;
}
// What quick add doesn't parse in a step. Dates are ignored, because a step's time is its T#. The project is ignored,
// because every step must stay in its template's project for Pocket's plugin. A trailing percentage ("Fill to 50%")
// is ignored, because a step starts with no progress.
export const STEP_IGNORE = {due: true, repeat: true, project: true, progress: true};
/* A step's due time is written in its title in the template, the way IEC 61131-3 writes durations:
     Put the roast in {#roast}    names the step "roast"
     Peel the potatoes T#20m      due 20 minutes after the step before it is done (for the first step, after the run starts)
     Baste the roast T#40m:roast  due 40 minutes after the step named "roast" is done
   Units are d, h, m, s and ms, and they combine, as in T#1h30m. A step without a time has no due date, and it is simply
   the next step. A run's copies of the steps have these parts removed from their titles, and Pocket's plugin sets
   their due dates as steps are done. */
const STEP_UNITS = {d: 864e5, h: 36e5, m: 6e4, s: 1e3, ms: 1}, STEP_MAX = 365 * 864e5;   // a year, the same limit as main.go
const STEP_TIME = /(^|\s)(T#\S*)/gi, STEP_NAME = /\{#([^}\s]*)\}/g, NAME_OK = /^[a-z][\w-]*$/i;
const sameName = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
export function parseStep(title){
  const out = {title: '', offset: null, name: null, ref: null, problems: []};
  const t = String(title || '').replace(STEP_TIME, (_, sp, tok) => {
    const m = tok.match(/^T#(-?)((?:\d+(?:\.\d+)?(?:ms|d|h|m|s))+)(?::(.*))?$/i);
    if (!m) out.problems.push(`“${tok}” isn't a time (write it like T#20m or T#1h30m)`);
    else if (m[1]) out.problems.push(`“${tok}”: a step's time can't be negative`);
    else if (m[3] !== undefined && !NAME_OK.test(m[3])) out.problems.push(`“${tok}”: a step's name must start with a letter`);
    else if (out.offset !== null) out.problems.push('a step can have only one T# time');
    else {
      const ms = Math.round([...m[2].matchAll(/(\d+(?:\.\d+)?)(ms|d|h|m|s)/gi)].reduce((n, u) => n + u[1] * STEP_UNITS[u[2].toLowerCase()], 0));
      if (!(ms <= STEP_MAX)) out.problems.push(`“${tok}” is longer than a year`);
      else { out.offset = ms; out.ref = m[3] ?? null; }
    }
    return sp;
  }).replace(STEP_NAME, (tok, name) => {
    if (!NAME_OK.test(name)) out.problems.push(`“${tok}”: a step's name must start with a letter`);
    else if (out.name) out.problems.push('a step can have only one {#name}');
    else out.name = name;
    return ' ';
  });
  out.title = t.replace(/\s{2,}/g, ' ').trim();
  return out;
}
// Everything wrong with a template's steps, in order. It lists each step's own problems, a name used twice, and a time
// counted from a name that isn't an earlier step's. That last check means no step waits on itself or on a later step.
export function stepProblems(titles){
  const steps = titles.map(parseStep), out = [];
  steps.forEach((s, i) => {
    const say = text => out.push({i, title: s.title, text});
    s.problems.forEach(say);
    if (s.ref && !steps.slice(0, i).some(x => sameName(x.name, s.ref)))
      say(steps.slice(i).some(x => sameName(x.name, s.ref)) ? `its time counts from “${s.ref}”, which has to be an earlier step` : `no step is named “${s.ref}”`);
    if (s.name && steps.slice(0, i).some(x => sameName(x.name, s.name))) say(`an earlier step is also named “${s.name}”`);
  });
  return out;
}
export const problemText = ps => `step ${ps[0].i + 1}, “${ps[0].title}”: ${ps[0].text}` + (ps.length > 1 ? ` (and ${ps.length - 1} more)` : '');
// 5400000 -> "1h 30m". It shows only the two largest parts, so a countdown stays short.
export function durText(ms){
  const parts = [];
  let left = Math.round(ms / 1000);
  for (const [u, n] of [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]]) if (left >= n) { parts.push(Math.floor(left / n) + u); left %= n; }
  return parts.slice(0, 2).join(' ') || '0s';
}
/* A countdown as text, with `left` ms before the time: "in 18m", then "12m late". Within a minute of the time, before
   or after, it counts to the second. */
export const countText = left => left >= 0 ? 'in ' + durText(left < 6e4 ? Math.ceil(left / 1e3) * 1e3 : Math.ceil(left / 6e4) * 6e4) : durText(-left < 6e4 ? -left : Math.floor(-left / 6e4) * 6e4) + ' late';
/* One string for everything on a run's screen that changes only because time passes. It holds today's date, which
   "Due tomorrow" depends on. For each open step with a time (`dueAt`, ms), it holds whether the time has come,
   whether it is within a day, and the countdown text. tickRun (app/alerts.js) redraws the run only when the string
   changes, so an idle run does no work as the seconds pass. */
export const runShows = (steps, now) => new Date(now).toDateString() + steps.filter(s => !s.done && Number.isFinite(s.dueAt))
  .map(s => { const left = s.dueAt - now; return `|${s.id}:${left < 0 ? 'l' : ''}${left <= 0 ? 'c' : ''}${Math.abs(left) < 864e5 ? countText(left) : ''}`; }).join('');
/* The index of the step a run goes to next. The run's screen and its card on Today both use this rule. `steps` are
   {id, done, counting: a countdown is running, dueAt: when it ends}. `from` is the step just done, or null.

   A timed step whose time has come wins, and the first such step in order is chosen. Otherwise the choice is the
   next open step after `from`, even if it is still counting down. If there is none, it wraps around to the first
   open step. Returns -1 when no step is open except `from`. */
export function whereNext(steps, now, from = null){
  const k = from ? steps.findIndex(x => x.id === from.id) : -1;
  const open = steps.map((x, i) => ({x, i})).filter(({x}) => !x.done && x.id !== from?.id);
  return (open.find(({x}) => x.counting && x.dueAt <= now) || open.find(o => o.i > k) || open[0])?.i ?? -1;
}
// The index of the step a timed step counts from. It is -1 for the start of the run, and null when the step has no
// time or names a step that isn't earlier.
export function stepFrom(steps, i){
  const s = steps[i];
  if (s.offset === null) return null;
  if (!s.ref) return i - 1;
  const j = steps.findIndex(x => sameName(x.name, s.ref));
  return j >= 0 && j < i ? j : null;
}
/* A step's time typed as a phrase: "in 20 min", "after an hour", "20 minutes later", "1h 30m after". It is saved as
   T#20m. Instructions like "for 2 minutes" or "rest 10 minutes" aren't read as times. */
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
/* A template step's title as Pocket shows it for editing: "Baste T#40m:roast" -> "Baste 40m after Put the roast in".
   The {#name} stays, because other steps may count from it. */
export function stepWords(title, titles){
  const s = parseStep(title);
  if (s.offset === null) return title;
  const ref = s.ref && titles.map(parseStep).find(x => sameName(x.name, s.ref));
  const when = s.ref ? (ref ? `${durText(s.offset)} after ${ref.title}` : null) : `in ${durText(s.offset)}`;
  return when ? `${s.title} ${when}` + (s.name ? ` {#${s.name}}` : '') : title;
}
/* The earlier step named right after a "<time> after" phrase, by its title as typed. "the", "starting" or "start of"
   may come first. Returns {key, length: how many characters name it}, or null. If several steps have that title, the
   latest wins. */
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
// 5400000 -> "T#1h30m". With a name, "T#1h30m:roast".
function stepToken(ms, ref){
  let t = '', left = Math.round(ms);
  for (const [u, n] of [['d', 864e5], ['h', 36e5], ['m', 6e4], ['s', 1e3], ['ms', 1]]) if (left >= n) { t += Math.floor(left / n) + u; left %= n; }
  return `T#${t || '0m'}${ref ? ':' + ref : ''}`;
}
// A name for a step, made from its first three words without trailing filler words: "Put the roast in" ->
// "put-the-roast", "Warm up the press" -> "warm-up". A number is added if the name is already taken.
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
/* Work out what each step being typed is saved as, and how it reads. `rows` are the steps being typed,
   {key, text, keep, from}. `before` are the template's existing steps, {key, text}.

   A time typed as a phrase becomes T#…, unless `keep` is set to keep the phrase. `from` is the step the time counts
   from: null as typed, '' for the step before, or another row's key. A step that another step counts from by key
   gets a name made from its title if it has none, so moving rows doesn't change what a step counts from. `clean`
   removes what quick add reads out of a title (@people, *labels), so the name is made from the title text alone. */
export function draftSteps(rows, before = [], clean = t => t){
  const all = [...before.map(b => ({...b, fixed: true})), ...rows.filter(r => r.text.trim())];
  const parsed = all.map(r => parseStep(r.text)), at = new Map(all.map((r, i) => [r.key, i]));
  const phrase = all.map((r, i) => r.fixed || /(^|\s)T#/i.test(r.text) ? null : readStepPhrase(r.text));
  // In "30 minutes after the first article check", the words that name an earlier step belong to the time phrase. The
  // step counts from that earlier step unless the chip picked another.
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
      problem: infos[i].problem || (lost ? 'the step it counts from was removed, so pick another' : ''),
      phrase: phrase[i]?.text || '', kept: !!(phrase[i] && r.keep), from: j === null || j < 0 ? '' : steps[i].ref ? all[j].key : '',
      choices: all.slice(0, i).map(x => ({key: x.key, title: clean(parseStep(x.text).title)}))});
  });
  return {info, added: saved.filter((_, i) => !all[i].fixed), problem: [...info.values()].some(x => x.problem),
    renames: all.map((r, i) => r.fixed && saved[i] !== r.text.trim() ? {key: r.key, title: saved[i]} : null).filter(Boolean)};
}
// A template's steps as shown. For each step it gives the title, when the step is due in a run, its name, and any
// problem with it.
export function stepInfos(titles){
  const steps = titles.map(parseStep), problems = stepProblems(titles);
  return steps.map((s, i) => {
    const j = stepFrom(steps, i), from = j === -1 ? 'the start' : j !== null && `“${steps[j].title}”`;
    const when = !from ? '' : s.offset === 0 ? (j === -1 ? 'due at the start' : `due when ${from} is done`) : `due ${durText(s.offset)} after ${from}`;
    const text = [when, s.name && `named “${s.name}”`].filter(Boolean).join(' · ');
    return {title: s.title, text: text && text[0].toUpperCase() + text.slice(1), problem: problems.filter(p => p.i === i).map(p => p.text).join('; ')};
  });
}
// Try a request up to three times, retrying on a 500. A busy Vikunja on SQLite answers 500 with "database is locked".
export async function patiently(fn){
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) { if (!(e instanceof ApiError && e.status >= 500) || i >= 2) throw e; await new Promise(r => setTimeout(r, 400 * (i + 1))); }
  }
}
// A task with all its comments. Vikunja's expand=comments returns only the first 50.
export async function allComments(t){
  if ((t.comments || []).length >= 50) t.comments = await allPages(`/tasks/${t.id}/comments`);
  return t;
}
// Map `fn` over `list`, `n` items at a time, and return the results in the list's order.
export async function inBatches(list, n, fn){
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(...await Promise.all(list.slice(i, i + n).map(fn)));
  return out;
}
const fmtWhen = d => new Date(d).toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'});
export const noteOf = c => ({id: c.id, comment: c.comment, author: c.author?.name || c.author?.username || 'Someone', when: fmtWhen(c.created)});
/* Split a run's title into {template, day, name, old}. Returns null for a title not in that shape. runTitle writes
   "Opening up · Oct 8 · #2", which is the template's name, the day, and then a number or the name typed.

   Older runs had the name in the middle, as in "Opening up · run 2 · Oct 8". These are returned with `old` true.

   The day must be the day Vikunja made the run or one of the seven days before, because a run started offline can be
   made later than it was started. With `guess`, a title with no such day is split by its shape. If a number is last,
   the day comes before it. Otherwise the day is last. */
export function runParts(title, created, guess = false){
  const parts = (title || '').split(' · '), at = Date.parse(created), days = new Set(), last = parts.length - 1;
  if (last < 2) return null;
  if (at > 0) for (let i = 0; i < 8; i++) days.add(new Date(at - i * 864e5).toLocaleDateString([], {month: 'short', day: 'numeric'}));
  let i = parts.findIndex((p, k) => k > 0 && k < last && days.has(p));
  if (i < 0 && !days.has(parts[last])) {
    if (!guess) return null;
    if (/^#\d+$/.test(parts[last])) i = last - 1;
  }
  return i > 0 ? {template: parts.slice(0, i).join(' · '), day: parts[i], name: parts.slice(i + 1).join(' · '), old: false}
    : {template: parts[0], day: parts[last], name: parts.slice(1, -1).join(' · '), old: true};
}
/* A run's title without its day ("Opening up · Oct 8 · #2" -> "Opening up · #2"), for its card on Today, where the
   heading already shows the date. A title in any other shape is returned whole. */
export function runWithoutDay(title, created){
  const p = runParts(title, created);
  return p ? p.template + ' · ' + p.name : title;
}
// The fields a run's screen keeps of a run and of its steps. They are also saved so the run can be opened offline.
export const plainRun = t => ({id: t.id, title: t.title, done: t.done, project_id: t.project_id, assignees: t.assignees || [], created_by: t.created_by || null,
  created: t.created || null, comments: t.comments || [], from: t.related_tasks?.copiedfrom?.[0]?.id || null, steps: stepsOf(t).map(s => s.id)});
export const plainStep = t => ({id: t.id, title: t.title, done: t.done, done_at: t.done_at, due_date: t.due_date, updated: t.updated, percent_done: t.percent_done || 0, description: t.description || '', assignees: t.assignees || [],
  attachments: t.attachments || [], reactions: t.reactions || {}, comments: t.comments || [], tpl: stepLine(t.description) ?? t.related_tasks?.copiedfrom?.[0]?.title ?? null,
  added: addedText(t.description), from: t.related_tasks?.copiedfrom?.[0]?.id ?? null});
