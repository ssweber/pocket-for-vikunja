/* What a checklist step asks to record (asks.js): the fields on its card, and sending what is typed in them. What is
   typed or picked is kept on the phone with the step's comment draft, under "<step id>:<ask key>", until it is sent.
   A field with no draft shows the answer that counts. */
import { answerHtml, askLines, askRows, fieldValue, rangeText, stepAsks } from '../asks.js';
import { fmtTime } from '../dates.js';

let rowKey = 0; // keys the editor's rows, so a removed row takes its fields with it

export default {
  // A finished checklist, or one shared to read only, shows its answers in fields that can't be changed.
  get askLocked() {
    return !!this.runView?.finished || !this.canWrite(this.runTask?.project_id);
  },
  // A field with no draft shows the answer that counts: a number without its unit, or the text as saved.
  askDraft(s, a) {
    const k = s.id + ':' + a.key,
      ans = s.answers?.[a.key];
    if (k in this.runDrafts) return this.runDrafts[k];
    return !ans ? '' : a.type === 'number' && ans.num !== null && ans.num !== undefined ? String(ans.num) : ans.text;
  },
  setAsk(s, a, v) {
    this.runDrafts[s.id + ':' + a.key] = v;
  },
  // Tapping the option already picked clears it.
  pickAsk(s, a, o) {
    this.setAsk(s, a, this.askDraft(s, a) === o ? '' : o);
  },
  // ± puts a minus in front of the number or takes it away, because the iPhone's decimal keypad has no minus key.
  flipAsk(s, a) {
    const v = this.askDraft(s, a).trim();
    this.setAsk(s, a, /^[-−]/.test(v) ? v.slice(1) : '-' + v);
  },
  // A number field's ± shows when the field may hold a number below zero.
  askSigned(a) {
    return a.type === 'number' && (a.low === null || a.low < 0);
  },
  // The line under a number field: its range, amber when the number is outside it, or why the field isn't saved.
  askNote(s, a) {
    const v = fieldValue(a, this.askDraft(s, a)),
      range = rangeText(a);
    if (v?.problem) return { text: v.problem, cls: 'bad' };
    if (v?.off) return { text: 'Outside the expected ' + range, cls: 'off' };
    return range ? { text: 'Expected ' + range, cls: '' } : null;
  },
  // Beside an ask's label: who recorded the answer that counts and when, or that a done step has none. An answer still
  // in the outbox shows its time until it has waited a while (waitText).
  askBy(s, a) {
    const ans = s.answers?.[a.key];
    if (!ans) return s.done ? 'Not recorded' : '';
    const wait = ans.waiting && this.waitText(ans.waiting);
    if (wait) return wait;
    const at = new Date(ans.created),
      today = new Date().toDateString() === at.toDateString();
    return `${ans.mine ? 'You' : ans.author} · ${today ? fmtTime(at) : at.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
  },
  // The answers typed or picked and not yet sent, by ask key. A field that holds the answer that counts isn't sent again.
  unsentAnswers(s) {
    const out = new Map();
    for (const a of s.asks || []) {
      const k = s.id + ':' + a.key;
      if (!(k in this.runDrafts)) continue;
      const v = fieldValue(a, this.runDrafts[k]);
      if (v && !v.problem && v.text !== s.answers?.[a.key]?.text) out.set(a.key, v.text);
    }
    return out;
  },
  saveLabel(s) {
    const n = this.unsentAnswers(s).size;
    return n === 1 ? 'Save answer' : `Save ${n} answers`;
  },
  // The answer comment for what is unsent, with the step's drafts for its asks cleared, or '' when nothing is unsent.
  takeAnswers(s) {
    const html = answerHtml(s.asks || [], this.unsentAnswers(s));
    for (const a of s.asks || []) delete this.runDrafts[s.id + ':' + a.key];
    return html;
  },
  async saveAnswers(s) {
    const html = this.takeAnswers(s);
    if (html) await this.act({ op: 'answer', task: s.id, html });
  },

  /* ---------- the asks editor on a template step's sheet ---------- */
  // The editor's rows start as the step's asks, and start again once they are saved or the sheet shows another step.
  initAskRows() {
    const t = this.sheetTask;
    if (!t || this.sheet.asksEdit?.task === t.id) return;
    const rows = askRows(stepAsks(t.description).asks).map(r => ({ ...r, key: ++rowKey }));
    this.sheet.asksEdit = { task: t.id, rows, was: JSON.stringify(rows) };
  },
  get askRowsMade() {
    return askLines(this.sheet.asksEdit?.rows || []);
  },
  get asksChanged() {
    const e = this.sheet.asksEdit;
    return !!e && JSON.stringify(e.rows) !== e.was;
  },
  // The step's ask lines Pocket can't read. Saving the editor's rows replaces them.
  get askBad() {
    return stepAsks(this.sheetTask?.description).bad;
  },
  addAskRow() {
    this.sheet.asksEdit.rows.push({
      key: ++rowKey,
      label: '',
      type: 'number',
      unit: '',
      low: '',
      high: '',
      options: '',
    });
  },
  dropAskRow(i) {
    this.sheet.asksEdit.rows.splice(i, 1);
  },
  resetAskRows() {
    this.sheet.asksEdit = null;
    this.initAskRows();
  },
  /* Write the rows into the step's notes as ask lines, in place of the ones there, as an `edit` op made on the notes
     Vikunja has when it is sent, so the rest of the notes stay as they are there. The sheet shows the asks at once.
     Offline they wait in the Outbox. A refusal waits there too, and the sender says why beside the asks. */
  async saveAskRows() {
    const t = this.sheetTask,
      made = this.askRowsMade;
    if (!t || made.some(m => m.problem)) return;
    const r = await this.act({ op: 'edit', task: t.id, run: null, rebase: 'asks', lines: made.map(m => m.line) });
    if (this.sheet.id !== t.id || r.status === 'error') return;
    this.sheet.asksEdit = null;
    this.initAskRows();
    if (r.status === 'sent') this.say('Asks saved. Checklists started from now on ask them.', { place: 'sheet:asks' });
  },
};
