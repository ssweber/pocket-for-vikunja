// Asks: what a checklist step asks to be recorded, and the comments that record it. Both are plain text lines, so a
// person can type them in Vikunja's web app, whose editor turns some marks into formatting and keeps the text.
import {htmlToText, parseFragment} from './html.js';
import {esc} from './util.js';

/* An ask is a line in a step's notes: "pocket:ask [Label: ]<type> [args]".
     pocket:ask Notes: text
     pocket:ask Temp: number °C 0..5      a unit and a range, in either order. The range may be open: ..5, 0..
     pocket:ask Seal intact: yes-no
     pocket:ask Belt: choice Good | Worn | Replace
   The label is everything before the first ": ". A step with one ask may leave it out, and its title is the label. */
export const ASK_MARK = 'pocket:ask', ANSWER_MARK = 'pocket:answer';
const ASK_LINE = /^pocket:ask\s+(.*)$/i, ANSWER_LINE = /^pocket:answer$/i;
const NUM = '-?(?:\\d+(?:\\.\\d*)?|\\.\\d+)', RANGE = new RegExp(`^(${NUM})?\\.\\.(${NUM})?$`), NUMBER = new RegExp(`^${NUM}$`);
// Vikunja's editor and some keyboards write a minus sign or a dash where a hyphen-minus was meant.
const minus = s => s.replace(/[−–]/g, '-');
// The text lines of a description or a comment. Formatting is ignored, and a line in a list is "- …", so it is no ask.
export const textLines = html => htmlToText(html || '').split('\n').map(l => l.trim()).filter(Boolean);
// One ask from the text after "pocket:ask", or null when Pocket can't read it.
export function parseAsk(text){
  const at = text.indexOf(': '), label = at >= 0 ? text.slice(0, at).trim() : '', body = (at >= 0 ? text.slice(at + 2) : text).trim();
  const [type = '', ...args] = body.split(/\s+/), ask = {label, key: label.toLowerCase(), type: type.toLowerCase()};
  if (ask.type === 'text' || ask.type === 'yes-no') return ask;
  if (ask.type === 'choice') {
    const seen = new Set(), options = args.join(' ').split('|').map(o => o.trim()).filter(o => o && !seen.has(o.toLowerCase()) && seen.add(o.toLowerCase()));
    return options.length >= 2 ? {...ask, options} : null;
  }
  if (ask.type !== 'number') return null;
  const ranges = args.filter(a => a.includes('..'));
  if (ranges.length > 1) return null;
  let low = null, high = null;
  if (ranges.length) {
    const m = minus(ranges[0]).match(RANGE);
    if (!m || (m[1] === undefined && m[2] === undefined)) return null;
    low = m[1] === undefined ? null : +m[1]; high = m[2] === undefined ? null : +m[2];
    if (low !== null && high !== null && low > high) return null;
  }
  return {...ask, unit: args.filter(a => !a.includes('..')).join(' '), low, high};
}
/* A step's asks, in order, and the ask lines it can't use with the reason. If two asks share a label, the first one
   counts. A step with several asks needs a label on each, so an unlabelled one among them is not used. */
export function asksOf(lines){
  const found = [], bad = [];
  for (const line of lines) {
    const m = line.match(ASK_LINE), ask = m && parseAsk(m[1].trim());
    if (!m) continue;
    if (!ask) bad.push({line, why: 'it can\'t be read'});
    else if (found.some(f => f.ask.key === ask.key)) bad.push({line, why: ask.label ? `another ask is labelled “${ask.label}”` : 'only one ask may leave out its label'});
    else found.push({line, ask});
  }
  const several = found.length > 1;
  for (const f of found) if (several && !f.ask.label) bad.push({line: f.line, why: 'a step with several asks needs a label on each'});
  return {asks: found.filter(f => !several || f.ask.label).map(f => f.ask), bad};
}
export const stepAsks = html => asksOf(textLines(html));
// "0 to 5 °C", "5 °C or less", "0 °C or more", or '' when the ask has no range.
export function rangeText(ask){
  const u = ask.unit ? ' ' + ask.unit : '';
  return ask.low !== null && ask.high !== null ? `${ask.low} to ${ask.high}${u}` : ask.high !== null ? `${ask.high}${u} or less` : ask.low !== null ? `${ask.low}${u} or more` : '';
}
const isOff = (ask, n) => (ask.low !== null && n < ask.low) || (ask.high !== null && n > ask.high);
/* What a field holds, as it would be saved: {text, num, off}. Null when the field is empty, and {problem} when a
   number field holds something else. A comma marks the decimals too. Text is one line. */
export function fieldValue(ask, typed){
  const t = String(typed ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (ask.type !== 'number') return {text: t};
  const n = minus(t).replace(',', '.');
  if (!NUMBER.test(n)) return {problem: 'Not a number, so it isn\'t saved'};
  const num = +n;
  return {text: String(num) + (ask.unit ? ' ' + ask.unit : ''), num, off: isOff(ask, num)};
}
// A saved value as Pocket shows it: {text, num, off}. A number that can't be read is shown as written, unjudged.
export function savedValue(ask, text){
  if (ask.type === 'yes-no') return {text: /^yes$/i.test(text) ? 'Yes' : /^no$/i.test(text) ? 'No' : text};
  if (ask.type !== 'number') return {text};
  const m = minus(text).match(new RegExp(`^(${NUM})(?:\\s|$)`)), num = m ? +m[1] : null;
  return {text, num, off: num !== null && isOff(ask, num)};
}
// The answer lines of a comment's text lines, or null when the comment doesn't end with "pocket:answer".
export const answerLines = lines => lines.length && ANSWER_LINE.test(lines.at(-1)) ? lines.slice(0, -1) : null;
/* The values in one answer comment, by ask key. A line is an ask's when it starts with that ask's label and ":". A
   step's only ask, unlabelled, takes the first line whole, so its value may itself hold ": ". */
export function readAnswers(asks, lines){
  const out = new Map();
  if (asks.length === 1 && !asks[0].label) { if (lines[0]) out.set('', lines[0]); return out; }
  for (const line of lines) {
    const ask = asks.find(a => line.toLowerCase().startsWith(a.key + ':'));
    const value = ask && line.slice(ask.key.length + 1).trim();
    if (value && !out.has(ask.key)) out.set(ask.key, value);
  }
  return out;
}
/* For each ask, the answer that counts: the newest answer comment's value. `notes` are {lines, created, id, …}.
   Returns a Map of ask key -> {text, num, off} with the note's other fields, such as who wrote it. */
export function answersOf(asks, notes){
  const out = new Map();
  for (const n of [...notes].sort((a, b) => Date.parse(a.created) - Date.parse(b.created) || a.id - b.id)) {
    const lines = answerLines(n.lines);
    const from = {...n}; delete from.lines;
    if (lines) for (const [key, text] of readAnswers(asks, lines)) out.set(key, {...savedValue(asks.find(a => a.key === key), text), ...from});
  }
  return out;
}
// The comment that records `values` (ask key -> saved text), one paragraph per line, in the asks' order.
export function answerHtml(asks, values){
  const lines = asks.filter(a => values.has(a.key)).map(a => (a.label ? a.label + ': ' : '') + values.get(a.key));
  return lines.length ? [...lines, ANSWER_MARK].map(l => '<p>' + esc(l) + '</p>').join('') : '';
}
/* A step's asks and the answers that count, for a checklist's screen. `waiting` are the html of its answer comments
   not yet sent, which count as the newest. Each answer is {text, num, off, author, mine, created, waiting}. */
export function stepAnswers(s, waiting, me){
  const asks = s.pending ? [] : stepAsks(s.description).asks;
  if (!asks.length) return {asks, answers: {}};
  const said = [...(s.comments || []).map(c => ({id: c.id, lines: textLines(c.comment), author: c.author?.name || c.author?.username || 'Someone', mine: c.author?.id === me?.id, created: c.created})),
    ...waiting.map(w => ({id: Infinity, lines: textLines(w.html), author: me?.name || me?.username || 'You', mine: true, created: w.at, waiting: true}))];
  return {asks, answers: Object.fromEntries(answersOf(asks, said))};
}
const TYPE_WORDS = {number: 'a number', 'yes-no': 'yes or no', choice: 'a choice', text: 'text'};
// A step's asks as its row shows them, after the notes icon: "Asks: Temp, Seal intact", or "Asks: a number" for one
// unlabelled ask. A template's row and a checklist's row say the same.
const asksWords = asks => asks.length === 1 && !asks[0].label ? TYPE_WORDS[asks[0].type] : asks.map(a => a.label).join(', ');
export const asksText = asks => 'Asks: ' + asksWords(asks);
export const asksMeta = asks => ({key: 'asks', cls: 'note-mark', icon: 'comment', text: asksText(asks)});
/* A checklist step's meta line: each answer that counts, amber outside its range, and "not recorded" for a done step's
   missing one. An open step with no answers says what it records. */
export function askMeta(t){
  const asks = t.asks || [];
  if (!asks.length) return [];
  if (!t.done && !asks.some(a => t.answers?.[a.key])) return [asksMeta(asks)];
  return asks.filter(a => t.done || t.answers?.[a.key]).map((a, i) => {
    const ans = t.answers?.[a.key], label = a.label ? a.label + ' ' : '';
    return ans ? {key: 'ans' + i, cls: 'ans' + (ans.off ? ' off' : ''), text: label + ans.text} : {key: 'ans' + i, cls: 'ans none', text: (label || 'Answer ') + 'not recorded'};
  });
}
/* The asks editor on a template step's sheet. Each row is {label, type, unit, low, high, options}, with the numbers
   as typed and the options one per line. */
export const askRows = asks => asks.map(a => ({label: a.label, type: a.type, unit: a.unit || '', low: a.low ?? '', high: a.high ?? '', options: (a.options || []).join('\n')}));
// The line each row saves as, or the problem that keeps it from being saved. Across rows, a step with several asks needs
// a label on each, and two asks can't share one.
export function askLines(rows){
  const keys = rows.map(r => r.label.trim().toLowerCase());
  return rows.map((r, i) => {
    const label = r.label.replace(/\s+/g, ' ').trim(), num = v => { const n = minus(String(v).trim()).replace(',', '.'); return n === '' ? null : NUMBER.test(n) ? +n : NaN; };
    if (/:\s/.test(label)) return {problem: 'A label can\'t contain “: ”'};
    if (!label && rows.length > 1) return {problem: 'Give each ask a label when a step has several'};
    if (label && keys.indexOf(keys[i]) !== i) return {problem: `Another ask is labelled “${label}”`};
    let args = '';
    if (r.type === 'number') {
      const low = num(r.low), high = num(r.high), unit = r.unit.replace(/\s+/g, ' ').trim();
      if (Number.isNaN(low) || Number.isNaN(high)) return {problem: 'The expected range must be numbers'};
      if (low !== null && high !== null && low > high) return {problem: 'The range starts above where it ends'};
      if (unit.includes('..')) return {problem: 'A unit can\'t contain “..”'};
      args = (unit ? ' ' + unit : '') + (low !== null || high !== null ? ` ${low ?? ''}..${high ?? ''}` : '');
    }
    if (r.type === 'choice') {
      const options = r.options.split('\n').map(o => o.trim()).filter(Boolean);
      if (options.some(o => o.includes('|'))) return {problem: 'An option can\'t contain “|”'};
      if (new Set(options.map(o => o.toLowerCase())).size < 2) return {problem: 'A choice needs at least two different options'};
      args = ' ' + options.join(' | ');
    }
    return {line: `${ASK_MARK} ${label ? label + ': ' : ''}${r.type}${args}`};
  });
}
/* A description with its ask lines replaced by `lines`, added at the end. Every other line stays. An ask line is a
   paragraph, or one line of a paragraph, whose text starts with "pocket:ask", formatting included. */
export function withAskLines(html, lines){
  const root = parseFragment(html || ''), isAsk = nodes => ASK_LINE.test(nodes.map(n => n.textContent).join('').trim());
  for (const box of [root, ...root.querySelectorAll('p')]) {
    if (box.closest('li') || [...box.children].some(c => /^(P|UL|OL|DIV|TABLE|BLOCKQUOTE|PRE|H\d)$/.test(c.tagName))) continue;
    let line = [];
    for (const n of [...box.childNodes, null]) {
      if (n && n.nodeName !== 'BR') { line.push(n); continue; }
      if (line.length && isAsk(line)) { line.forEach(x => x.remove()); n?.remove(); }
      line = [];
    }
    if (box !== root && !box.textContent.trim() && !box.querySelector('img, hr')) box.remove();
  }
  return root.innerHTML.replace(/(<br>)+(<\/p>)/g, '$2') + lines.map(l => '<p>' + esc(l) + '</p>').join('');
}
