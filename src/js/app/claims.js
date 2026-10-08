// Who's doing a subtask or a step: claiming one assigns it to you, and people's pictures.
import {cache} from '../util.js';
import {allPages, api, ApiError, NetError} from '../api.js';
import {hasTemplateLabel, parseStep} from '../checklists.js';
import {saved} from '../lists.js';
import {claimsOnSlide} from '../progress.js';

const loading = new Set();                       // usernames whose picture is being fetched
const tried = new Map();                         // username -> when fetching its picture last failed for want of a connection
const DAY = 864e5;

export default {
  /* A subtask's or a step's slot for who's doing it, on its row. Empty and open, "+ me": a tap claims it, which assigns
     it to you. Yours: a tap lets it go. Someone else's shows who has it and does nothing: handing it over is done with
     Assign in its sheet. Done, it shows who had it and can't be tapped. Claiming never ticks anything: Done and Skip
     work for anyone, whoever has the step. `people`: its assignees, with claims waiting to be sent (peopleOf). Up to two
     pictures show (`users`), yours first, then how many more. A tap on it (toggleClaim) is for its task (`id`), a step of
     the run `run` if it's one. */
  claimSlot(t, people, done, run = null){
    const me = this.user, mine = people.some(u => u.id === me?.id), title = parseStep(t.title).title, id = t.id;
    const all = mine ? [me, ...people.filter(u => u.id !== me.id)] : people, users = all.slice(0, 2), more = all.length - users.length;
    const names = all.map(u => u.id === me?.id ? 'you' : this.nameOf(u)).join(', ');
    if (done || !this.canWrite(t.project_id)) return all.length ? {id, run, users, more, can: false, label: `Assigned to ${names}: ${title}`} : null;
    const others = all.filter(u => u.id !== me?.id).map(u => this.nameOf(u)).join(', ');
    if (mine) return {id, run, users, more, can: true, mine: true, label: `You're doing ${title}${others ? ', with ' + others : ''}. Tap to let it go`};
    if (all.length) return {id, run, users, more, can: false, label: `${names} ${all.length > 1 ? 'are' : 'is'} doing ${title}`};
    return {id, run, users: [], more: 0, can: true, label: `Tap to say you'll do ${title}`};
  },
  /* A done step's pictures: whoever did it, with a ✓ (⏭ for a skip, grey while it waits to be sent), then the others
     it's assigned to, all one size. Null when there's no one to show. */
  doneSlot(by, people, badge){
    const all = [...by.map(u => ({...u, badge})), ...people.filter(u => !by.some(d => d.id === u.id))];
    return all.length ? {users: all.slice(0, 2), more: Math.max(0, all.length - 2), can: false} : null;
  },
  /* A task's assignees as shown: Vikunja's, with your claims and let-gos still waiting to be sent laid over them, and
     you on the one whose progress is being slid (claimOnSlide). */
  peopleOf(id, base){
    let list = base || [];
    for (const a of this.pending) if (a.kind === 'act' && a.task === id && (a.op === 'claim' || a.op === 'unclaim'))
      list = [...list.filter(u => u.id !== this.user?.id), ...a.op === 'claim' ? [this.user] : []];
    if (this.slideClaim === id && this.user && !list.some(u => u.id === this.user.id)) list = [...list, this.user];
    return list;
  },
  /* Progress slid on a task or a step no one is doing says you're doing it: your picture takes the place of "+ me" as
     the slide starts, and the claim is sent, through the outbox as a tap on "+ me" is, once it's let go having changed
     something; let go where it started, nothing is claimed. Someone else's is never replaced (claimsOnSlide), and
     sliding back to 0% later keeps it: letting go is a tap of its own. Resolves the slide's end: end(changed). */
  claimOnSlide(slot){
    if (!claimsOnSlide(slot)) return () => {};
    this.slideClaim = slot.id;
    return async changed => {
      try { if (changed) await this.act({op: 'claim', task: slot.id, run: slot.run}); }
      finally { if (this.slideClaim === slot.id) this.slideClaim = null; }     // from then on, the outbox or Vikunja says
    };
  },
  // Claim it, or let it go. Through the outbox, like a tick on a run: without a connection it waits, shown as done.
  async toggleClaim(slot){
    if (!slot?.can) return;
    navigator.vibrate?.(10);
    await this.act({op: slot.mine ? 'unclaim' : 'claim', task: slot.id, run: slot.run});
    if (this.sheet.open && this.sheet.kind === 'task') this.sheet.dirty = true;   // Today shows what's assigned to you
  },
  /* The open task's subtasks' assignees: Vikunja doesn't include them in a task's subtasks, so one request for all of
     them. Offline, as last loaded. */
  async loadSubPeople(t){
    const ids = (t.related_tasks?.subtask || []).map(s => s.id), mine = this.sheet;
    if (!ids.length) return;
    try {
      const list = await allPages('/tasks?' + new URLSearchParams({filter: `id in ${ids.join(', ')}`}));
      if (this.sheet !== mine) return;
      for (const s of list) { this.sheet.subPeople[s.id] = s.assignees || []; this.sheet.subLabels[s.id] = s.labels || []; if (cache.has(s.id)) cache.get(s.id).assignees = s.assignees; }
    } catch (e) {
      if (!(e instanceof NetError) || this.sheet !== mine) return;
      for (const id of ids) if (cache.get(id)?.assignees) this.sheet.subPeople[id] ??= cache.get(id).assignees;
    }
  },
  /* A row's slot for who's doing it: in a sheet (g.sheet), its subtask's; on a run's screen (g.run), its step's, until
     it's done (then its row shows who did it); in a list, the task's own, from its assignees. None on a row waiting to
     be sent, a run (its row says who it's for), or a template that comes round. A row ticked or opened again in a list,
     waiting for the batch (leaving.js), keeps the slot it had, so its title doesn't move; it can't be tapped meanwhile. */
  rowSlot(t, g){
    if (g.run) return t.done ? null : t.slot;
    if (g.sheet) return this.subSlots[t.id] || null;
    if (t.pending || this.isRunTask(t) || (this.checklistIds.has(t.project_id) && hasTemplateLabel(t))) return null;
    const mark = this.leaving[t.id], was = mark === 'done' ? false : mark === 'open' ? true : t.done;
    const slot = this.claimSlot(t, this.peopleOf(t.id, t.assignees), was, this.stepRun(t));
    return slot && was !== t.done ? {...slot, can: false, label: (t.done ? 'Done: ' : 'Not done: ') + t.title} : slot;
  },
  // The open task's subtasks' slots, by id.
  get subSlots(){
    const out = {};
    const run = this.checklistRole === 'run' ? this.sheet.task.id : null;
    for (const st of this.subtasks) out[st.id] = this.claimSlot(st, this.peopleOf(st.id, this.sheet.subPeople[st.id]), st.done, run);
    return out;
  },
  // A claim or a let-go that reached Vikunja, on the screen at once.
  claimSent(a){
    const was = this.sheet.subPeople?.[a.task] ?? null, step = this.view.run?.steps.find(s => s.id === a.task);
    const set = list => [...(list || []).filter(u => u.id !== this.user?.id), ...a.op === 'claim' ? [this.user] : []];
    if (was !== null) this.sheet.subPeople[a.task] = set(was);
    if (step) step.assignees = set(step.assignees);
    const c = cache.get(a.task); if (c) c.assignees = set(c.assignees);
    if (this.tasks[a.task]) this.syncTask({id: a.task, assignees: set(this.tasks[a.task].assignees)});
  },

  /* ---------- people's pictures ---------- */
  nameOf(u){ return u?.name || u?.username || 'Someone'; },
  initials(u){ return (this.nameOf(u).match(/[\p{L}\p{N}]+/gu) || ['?']).slice(0, 2).map(w => w[0].toUpperCase()).join(''); },
  /* A person's picture as a data: URL, or '' until it's loaded (or if they have none): Vikunja's avatar address needs
     the sign-in, so it can't go in an <img> as it is. Kept on the phone for a day, so they show offline too. */
  avatarUrl(u){
    const k = u?.username;
    if (!k) return '';
    const got = this.avatars[k];
    if ((!got || Date.now() - got.at > DAY) && !loading.has(k) && !(Date.now() - (tried.get(k) || 0) < 3e5)) this.loadAvatar(k);
    return got?.url || '';
  },
  async loadAvatar(k){
    loading.add(k);
    try {
      const blob = await api(`/avatar/${encodeURIComponent(k)}?size=64`, {raw: true}).then(res => res.blob(), e => { if (e instanceof ApiError) return null; throw e; });
      const url = blob && /^image\//.test(blob.type) && blob.size < 64e3 ? await new Promise(ok => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => ok(''); r.readAsDataURL(blob); }) : '';
      this.avatars[k] = {url, at: Date.now()};
      saved.set('avatars', this.avatars);
    } catch { tried.set(k, Date.now()); }      // no connection: initials for now, and another try in a few minutes
    finally { loading.delete(k); }
  },
};
