// What's waiting to send: the header's button, which says so, and the sheet listing it.
import {cache, fmtSize} from '../util.js';
import {parseStep} from '../checklists.js';
import {isChild, itemDone, sync} from '../sync.js';

const byWhen = (a, b) => a.at.localeCompare(b.at) || (a.n || 0) - (b.n || 0);
const whenText = at => {
  const d = new Date(at), today = d.toDateString() === new Date().toDateString();
  return d.toLocaleString([], today ? {hour: 'numeric', minute: '2-digit'} : {weekday: 'short', hour: 'numeric', minute: '2-digit'});
};
const quoted = t => `“${parseStep(t).title}”`;

export default {
  /* One row for each thing waiting, oldest first, in plain words: {key, text, when, failed (why Vikunja turned it
     down), drop (a method's name and its arguments, to not send it), retry}. */
  get outboxRows(){
    const rows = [];
    for (const e of [...this.failed, ...this.pending].sort(byWhen)) {
      const when = whenText(e.at);
      if (e.kind === 'run') {
        const what = (e.cancelled ? 'Calling off the start of ' : 'Starting ') + e.template.title;
        rows.push({key: e.id, text: what, when, drop: e.cancelled ? null : ['cancelStart', e.id]});
      } else if (e.kind === 'act') {
        rows.push({key: e.id, text: this.actText(e), when, failed: e.failed?.message || '', retry: !!e.failed,
          drop: e.failed || (!e.stage && !e.tried) ? ['dropAct', e.id] : null});
      } else {
        e.items.forEach((x, i) => {
          if (itemDone(x, isChild(e, i))) return;
          const under = e.parent?.title || (isChild(e, i) ? e.items[0].p.title : null);
          const text = x.taskId ? `Finishing ${quoted(x.p.title)}` : under ? `Subtask of ${quoted(under)}: ${x.p.title}` : `New task: ${x.p.title}`;
          rows.push({key: `${e.id}-${i}`, text, when, drop: x.taskId ? null : ['cancelPending', e.id, i]});
        });
        const to = cache.get(e.taskId || e.items[0]?.taskId)?.title || e.items[0]?.p.title;
        for (const f of e.files || []) if (!f.sent && !this.dropping.includes(f.key))
          rows.push({key: f.key, text: `${/^image\//.test(f.type) ? 'Photo' : 'File'}${to ? ' for ' + quoted(to) : ''}, ${fmtSize(f.size)}`, when, drop: ['cancelFile', e.id, f.key]});
      }
    }
    return rows;
  },
  // The header's button: Refresh, or what's waiting, once something has waited a moment, or been turned down.
  get outboxShown(){ return !!this.failed.length || (this.waitShown && !!this.pending.length); },
  get outboxLabel(){
    const failed = this.outboxRows.filter(r => r.failed).length, waiting = this.outboxRows.length - failed;
    return [failed && `${failed} couldn't be sent`, waiting && `${waiting} waiting to send`].filter(Boolean).join(', ') || 'Nothing waiting to send';
  },
  get outboxStatus(){
    if (this.flushing) return 'Sending…';
    if (this.pending.length) return this.offline ? 'No connection: these are sent when Pocket reaches Vikunja.' : 'Waiting for Vikunja: Pocket tries again every 30 seconds.';
    if (this.failed.length) return 'Vikunja turned these down. Try again once what it said is put right, or don\'t send them.';
    return 'Everything has reached Vikunja.';
  },
  openOutbox(){ this.openSheet('outbox'); },
  tapRefresh(){ if (this.outboxShown) this.openOutbox(); else this.refresh(); },
  async tryNow(){ await this.flush(); this.refresh(); },
  // A run's act in words: "Done: Check the milk fridge".
  actText(a){
    const t = parseStep(a.label || this.actTitle(a.task) || 'a step').title;
    return {done: `Done: ${t}`, doneNote: `Done, with a note: ${t}`, skip: `Skipped: ${t}`, undone: `Not done: ${t}`, note: `A note on “${t}”`,
      finish: `Finishing “${t}”`, reopen: `Reopening “${t}”`, claim: `You'll do “${t}”`, unclaim: `Letting go of “${t}”`}[a.op] || t;
  },
  actTitle(id){
    const r = this.view.run;
    return cache.get(id)?.title || r?.steps.find(x => x.id === id)?.title || (r?.run.id === id ? r.run.title : '') || '';
  },
  // What not sending it leaves in Vikunja, for the confirm.
  dropText(a){
    const t = quoted(a.label || this.actTitle(a.task) || 'it'), part = a.stage > 0;
    return {done: part ? `${t} stays marked done in Vikunja, without the rest.` : `${t} stays not done in Vikunja.`,
      undone: part ? `${t} stays not done in Vikunja, without the rest.` : `${t} stays done in Vikunja.`,
      finish: 'The run stays open in Vikunja.', reopen: 'The run stays finished in Vikunja.',
      claim: `${t} stays without you on it.`, unclaim: `You stay on ${t}.`,
      note: 'The note isn\'t posted: its words go back where you wrote them.'}[{doneNote: 'done', skip: 'done'}[a.op] || a.op] || '';
  },
  // Send one Vikunja turned down again, and what waited behind it.
  async retryAct(id){
    await sync.lock(async () => {
      const e = await sync.fresh(id);
      if (!e?.failed) return;
      delete e.failed; e.fails = 0;
      await sync.save(e);
    });
    this.refreshPending();
    await this.flush();
  },
  // Don't send it: one turned down, or one not started yet. Its words go back where they were written.
  async dropAct(id){
    const a = [...this.failed, ...this.pending].find(e => e.id === id);
    if (!a || !confirm(`Don't send it? ${this.dropText(a)}`)) return;
    let gone = false, started = false;
    await sync.lock(async () => {
      const e = await sync.fresh(id);
      if (!e) { gone = true; return; }
      if (!e.failed && (e.stage || e.tried)) { started = true; return; }
      await sync.remove(id);
    });
    this.refreshPending();
    if (gone || started) { this.notify(gone ? 'It was sent before it could be stopped.' : 'It\'s being sent: it can\'t be stopped now.'); return; }
    const said = {};
    this.giveBack(a, said);
    if (a.stage > 0 && this.view.run?.run.id === a.run) this.refreshRunTask(a.task);
    this.notify('Not sent.' + (said.back ? ' Its words are back where you wrote them.' : ''));
    this.flush();                                                           // what waited behind it
  },
};
