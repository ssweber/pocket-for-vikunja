/* What a checklist step asks to record (asks.js): the fields on its card, and sending what is typed in them. What is
   typed or picked is kept on the phone with the step's comment draft, under "<step id>:<ask key>", until it is sent.
   A field with no draft shows the answer that counts. */
import {answerHtml, askLines, askRows, fieldValue, rangeText, stepAsks, withAskLines} from '../asks.js';
import {fmtTime} from '../dates.js';
import {NetError} from '../api.js';

let rowKey = 0;                                  // keys the editor's rows, so a removed row takes its fields with it

export default {
  // A finished checklist, or one shared to read only, shows its answers in fields that can't be changed.
  get askLocked(){ return !!this.runView?.finished || !this.canWrite(this.view.run?.run.project_id); },
  // A field with no draft shows the answer that counts: a number without its unit, or the text as saved.
  askDraft(s, a){
    const k = s.id + ':' + a.key, ans = s.answers?.[a.key];
    if (k in this.runDrafts) return this.runDrafts[k];
    return !ans ? '' : a.type === 'number' && ans.num !== null && ans.num !== undefined ? String(ans.num) : ans.text;
  },
  setAsk(s, a, v){ this.runDrafts[s.id + ':' + a.key] = v; },
  // Tapping the option already picked clears it.
  pickAsk(s, a, o){ this.setAsk(s, a, this.askDraft(s, a) === o ? '' : o); },
  // ± puts a minus in front of the number or takes it away, because the iPhone's decimal keypad has no minus key.
  flipAsk(s, a){ const v = this.askDraft(s, a).trim(); this.setAsk(s, a, /^[-−]/.test(v) ? v.slice(1) : '-' + v); },
  // A number field's ± shows when the field may hold a number below zero.
  askSigned(a){ return a.type === 'number' && (a.low === null || a.low < 0); },
  // The line under a number field: its range, amber when the number is outside it, or why the field isn't saved.
  askNote(s, a){
    const v = fieldValue(a, this.askDraft(s, a)), range = rangeText(a);
    if (v?.problem) return {text: v.problem, cls: 'bad'};
    if (v?.off) return {text: 'Outside the expected ' + range, cls: 'off'};
    return range ? {text: 'Expected ' + range, cls: ''} : null;
  },
  // Beside an ask's label: who recorded the answer that counts and when, or that a done step has none.
  askBy(s, a){
    const ans = s.answers?.[a.key];
    if (!ans) return s.done ? 'Not recorded' : '';
    if (ans.waiting) return 'Waiting to send';
    const at = new Date(ans.created), today = new Date().toDateString() === at.toDateString();
    return `${ans.mine ? 'You' : ans.author} · ${today ? fmtTime(at) : at.toLocaleString([], {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'})}`;
  },
  // The answers typed or picked and not yet sent, by ask key. A field that holds the answer that counts isn't sent again.
  unsentAnswers(s){
    const out = new Map();
    for (const a of s.asks || []) {
      const k = s.id + ':' + a.key;
      if (!(k in this.runDrafts)) continue;
      const v = fieldValue(a, this.runDrafts[k]);
      if (v && !v.problem && v.text !== s.answers?.[a.key]?.text) out.set(a.key, v.text);
    }
    return out;
  },
  saveLabel(s){ const n = this.unsentAnswers(s).size; return n === 1 ? 'Save answer' : `Save ${n} answers`; },
  // The answer comment for what is unsent, with the step's drafts for its asks cleared, or '' when nothing is unsent.
  takeAnswers(s){
    const html = answerHtml(s.asks || [], this.unsentAnswers(s));
    for (const a of s.asks || []) delete this.runDrafts[s.id + ':' + a.key];
    return html;
  },
  async saveAnswers(s){
    const html = this.takeAnswers(s);
    if (html) await this.act({op: 'answer', task: s.id, html});
  },

  /* ---------- the asks editor on a template step's sheet ---------- */
  // The editor's rows start as the step's asks, and start again once they are saved or the sheet shows another step.
  initAskRows(){
    const t = this.sheet.task;
    if (!t || this.sheet.asksEdit?.task === t.id) return;
    const rows = askRows(stepAsks(t.description).asks).map(r => ({...r, key: ++rowKey}));
    this.sheet.asksEdit = {task: t.id, rows, was: JSON.stringify(rows)};
  },
  get askRowsMade(){ return askLines(this.sheet.asksEdit?.rows || []); },
  get asksChanged(){ const e = this.sheet.asksEdit; return !!e && JSON.stringify(e.rows) !== e.was; },
  // The step's ask lines Pocket can't read. Saving the editor's rows replaces them.
  get askBad(){ return stepAsks(this.sheet.task?.description).bad; },
  addAskRow(){ this.sheet.asksEdit.rows.push({key: ++rowKey, label: '', type: 'number', unit: '', low: '', high: '', options: ''}); },
  dropAskRow(i){ this.sheet.asksEdit.rows.splice(i, 1); },
  resetAskRows(){ this.sheet.asksEdit = null; this.initAskRows(); },
  // Write the rows into the step's notes as ask lines, in place of the ones there, leaving the rest of the notes.
  async saveAskRows(){
    const t = this.sheet.task, made = this.askRowsMade;
    if (!t || made.some(m => m.problem)) return;
    try {
      const got = await this.saveTask(t.id, null, now => ({description: withAskLines(now.description, made.map(m => m.line))}));
      if (this.sheet.task?.id !== t.id) return;
      this.showTask(got);
      this.sheet.asksEdit = null; this.initAskRows();
      this.say('Asks saved. Checklists started from now on ask them.', {place: 'sheet:asks'});
    } catch (e) { this.say(e instanceof NetError ? 'Asks not saved: no connection.' : 'Asks not saved: ' + e.message, {place: 'sheet:asks', cls: 'failed'}); }
  },
};
