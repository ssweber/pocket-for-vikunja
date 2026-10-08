// The add box: what it read, who can see the project, suggestions for @username and *label, and the marks behind the words.
import {colorOf, esc, userCache} from '../util.js';
import {api, ApiError, items, NetError} from '../api.js';
import {hasTemplateLabel, readStepPhrase, STEP_IGNORE} from '../checklists.js';
import {placeAfter} from '../order.js';
import {NUDGE_TICK} from '../progress.js';
import {haptic} from '../haptics.js';
import {captureLines, isTicked, LIST_MARKER, parseCapture, projectName, QUICK_ADD_PREFIXES, tickedLines} from '../quickadd.js';

let peopleLoading = null;                      // loadPeople() while it runs
let cursorIO = null, watched = null;           // what tells when the cursor's row is out of sight, and that row

export default {
  /* The add boxes read what's typed the same way, with the same marks, chips and suggestions: quick add at the bottom
     ('cap'), the subtask box in a task's sheet ('sub'), whose lines become subtasks of the open task, in its project,
     quick add's box again on a project's list while it adds subtasks to the task touched last ('under', the cursor),
     and on a run's screen ('ins'), whose lines are steps added after the step on its card (runAim), and the boxes a
     template is written in: its name in New template ('tname'), each step being written ('new:<row key>' there,
     'add:<row key>' under a template) and a step being changed ('edit'). The methods below take which box. */
  box(w){
    if (w === 'sub') return this.sheet.sub;
    if (w === 'under') return this.cap;
    if (w === 'ins') return this.runInsert;
    if (w === 'tname') return this.sheet.newTpl?.box || {text: ''};
    if (w === 'edit') return this.sheet.stepEdit || {text: ''};
    const [which, key] = w.split(':');
    if (key) return this.draftRows(which).find(r => r.key === key) || {text: ''};
    return this.cap;
  },
  boxEl(w){
    if (w === 'sub') return document.getElementById('d-subin');
    if (w === 'under') return this.$refs.capture;
    if (w === 'ins') return this.$refs.capture;
    if (w === 'tname') return document.getElementById('nt-name');
    if (w === 'edit') return document.getElementById('step-edit-' + this.sheet.stepEdit?.id);
    const [which, key] = w.split(':');
    if (key) return document.getElementById(`${which}-step-${this.draftRows(which).findIndex(r => r.key === key)}`);
    return this.$refs.capture;
  },
  /* What a box never reads: a subtask stays in its task's project, so "+Garden" stays in its title; and in a checklist
     project a step's time is its T#30m, so "Check at 3pm" stays as it is. */
  boxBase(w){
    if (w === 'cap') return {};
    return this.isSubBox(w) && !this.checklistIds.has(this.boxParent(w)?.project_id) ? {project: true} : STEP_IGNORE;
  },
  // The boxes whose lines are subtasks, and the task they go under: the open sheet's, or the cursor's.
  isSubBox(w){ return w === 'sub' || w === 'under'; },
  boxParent(w){ return w === 'under' ? this.cursorParent : this.sheet.task; },
  // Where a line without a +project goes: the default project, the open task's, the run's, or the template's.
  boxHome(w){
    if (w === 'sub' || w === 'edit' || w.startsWith('add:')) return this.sheet.task?.project_id;
    if (w === 'under') return this.cursorParent?.project_id;
    if (w === 'ins') return this.view.run?.run.project_id;
    if (w === 'tname' || w.startsWith('new:')) return this.sheet.newTpl?.project.id;
    return this.defaultProjectId();
  },
  boxLines(w){ return captureLines(this.box(w).text); },
  get capLines(){ return this.boxLines('cap'); },
  // The user's Vikunja settings: "default due time" and Quick Add Magic mode (vikunja, todoist or disabled).
  get dueTime(){ return this.user?.settings?.frontend_settings?.default_due_time || '12:00'; },
  get quickAddMode(){ return this.user?.settings?.frontend_settings?.quick_add_magic_mode || 'vikunja'; },
  get prefixes(){ return QUICK_ADD_PREFIXES[this.quickAddMode] || null; },
  get parseOpts(){ return {mode: this.quickAddMode, dueTime: this.dueTime}; },
  // A box's first (or only) line; with `all`, ignoring none of the chips tapped off.
  boxParsed(w, all = false){
    const base = this.boxBase(w);
    return parseCapture(this.boxLines(w)[0] || '', this.projects, {...this.parseOpts, ignore: all ? base : {...base, ...this.box(w).ignore}});
  },
  get parsed(){ return this.boxParsed('cap'); },
  // Each line of a box, parsed: a pasted list in quick add goes to one project (parseList); subtasks are read one by one.
  boxParsedLines(w){
    const lines = this.boxLines(w), first = this.boxParsed(w);
    if (w === 'cap') return lines.length > 1 ? this.parseList(lines, first).parsed : [first];
    return lines.map((l, i) => i ? parseCapture(l, this.projects, {...this.parseOpts, ignore: this.boxBase(w)}) : first);
  },
  /* A pasted list goes to one project: the first +project in it, on whichever line. A different +project on a later line
     stays in that line's text, as a second one does within a line. (Vikunja's own quick add reads each line on its own.)
     Returns {parsed: [each line], project, miss}; `first` is the first line already parsed, if there is one. */
  parseList(lines, first){
    let owner = -1;
    const parsed = lines.map((raw, i) => {
      const p = i === 0 && first ? first : parseCapture(raw, this.projects, owner >= 0 ? {...this.parseOpts, ignore: {project: true}} : this.parseOpts);
      if (owner < 0 && (p.project || p.projectMiss)) owner = i;
      return p;
    });
    const project = owner >= 0 ? parsed[owner].project : null, miss = owner >= 0 ? parsed[owner].projectMiss : null;
    return {parsed: lines.length > 1 ? parsed.map(p => ({...p, project})) : parsed, project, miss};
  },
  // Whether a box is one of a template's steps: being written ('new:', 'add:') or changed ('edit').
  isStepBox(w){ return w === 'edit' || /^(new|add):/.test(w); },
  /* What a box reads, under it while it's empty. In a template's name, @user is who its runs are for; in a step, who
     does it, and a time after the step before is when it's due. A subtask box doesn't read +project, nor dates in a
     checklist project, where a subtask may become a step. */
  boxHint(w){
    const p = this.prefixes;
    if (!p) return 'Quick add shortcuts are turned off in your Vikunja settings';
    const tags = `${p.label}label  !1–5`;
    if (w === 'tname') return `${p.assignee}user: who its runs are for  ${tags} · when it comes round is set in its sheet`;
    if (w === 'ins') return `${p.assignee}user: who does it  ${tags} · a pasted list is a step a line`;
    if (this.isStepBox(w)) return `${p.assignee}user: who does it  ${tags} · “in 20 min”: due that long after the step before`;
    const base = this.boxBase(w), dates = base.due ? 'dates stay as words in a checklist project' : 'tomorrow · fri at 2 · Oct 12 · every week';
    return `${base.project ? '' : p.project + 'project  '}${p.label}label  ${p.assignee}user  !1–5  ${dates} · tap a chip to undo it`;
  },
  /* Words a box doesn't read, said as a muted chip, so they're not taken for read: a date in a checklist's box (a step's
     time is the words before the step after it, like "in 20 min", read on their own), a +project in a subtask's or
     a checklist's box. */
  ignoredChips(w, line){
    const base = this.boxBase(w), out = [];
    if (!base.due && !base.project) return out;
    const ph = this.isStepBox(w) && readStepPhrase(line), rest = ph ? line.slice(0, ph.index) + line.slice(ph.index + ph.length) : line;
    const raw = parseCapture(rest, this.projects, {...this.parseOpts, ignore: {}});
    if (base.due && (raw.due || raw.repeat)) out.push({key: 'ign-d', cls: 'quiet', text: w === 'tname' ? 'Dates stay in its name: when it comes round is set in its sheet'
      : w === 'ins' ? 'Dates stay as words: a step added to a run has no time' : this.isSubBox(w) ? 'Dates stay as words here: a subtask in a checklist project may become a step'
      : 'Dates stay as words: a step is due a time after the one before, like “in 20 min”'});
    if (base.project && (raw.project || raw.projectMiss)) out.push({key: 'ign-p', cls: 'quiet', text: this.isSubBox(w) ? `${this.prefixes.project}project stays as words: a subtask goes in its task's project`
      : `${this.prefixes.project}project stays as words: a checklist's steps are in its project`});
    return out;
  },

  /* ---------- @username: who can see the task's project ---------- */
  /* The project a box's lines go to, and the @usernames in them: a single task's, or every line's of a pasted list, which
     goes to one project (quick add's, by parseList) or the box's own. */
  boxPeople(w){
    const lines = this.boxLines(w);
    if (lines.length === 1) { const p = this.boxParsed(w); return {target: p.project?.id || this.boxHome(w), names: p.assignees, one: true}; }
    const ps = this.boxParsedLines(w);
    return {target: (w === 'cap' && ps[0]?.project?.id) || this.boxHome(w), names: [...new Set(ps.flatMap(p => p.assignees))], one: false};
  },
  // What checkAccess looks up: the project and the @usernames. Empty when there's nothing to check.
  accessQuery(w){
    // ('under' is quick add's box too: only while it adds subtasks to a task.)
    if (!this.boxLines(w).length || this.accessBlocked || !this.prefixes || (w === 'under' && !this.cursorTask)) return '';
    const {target, names} = this.boxPeople(w);
    return names.length ? [target, ...names.map(n => n.toLowerCase())].join('|') : '';
  },
  /* From what checkAccess has found so far: {auto, warn}. auto is the one project everyone mentioned can see, when they
     can't all see the default project and no +project was typed (quick add only: a subtask stays with its task); warn
     lists the chips for people the task can't reach. */
  accessHints(w){
    const out = {auto: null, warn: []};
    if (!this.accessQuery(w)) return out;
    const {target, names, one} = this.boxPeople(w), p = one && this.boxParsed(w), at = this.prefixes.assignee;
    const sees = (pid, n) => this.access[pid + ':' + n.toLowerCase()];
    const known = names.filter(n => this.userKnown[n.toLowerCase()] !== false);
    names.filter(n => this.userKnown[n.toLowerCase()] === false).forEach(n => out.warn.push(`No user ${at}${n}`));
    const blocked = known.filter(n => sees(target, n) === false);
    if (!blocked.length) return out;
    if (one && !p.project && w === 'cap') {
      const fits = [];
      for (const proj of this.projects) if (proj.id > 0 && proj.id !== target) {
        const v = known.map(n => sees(proj.id, n));
        if (v.includes(undefined)) return out;                                  // still looking
        if (v.every(Boolean)) fits.push(proj);
      }
      if (fits.length === 1) out.auto = fits[0];
    }
    if (!out.auto || this.box(w).ignore?.autoProject) blocked.forEach(n => out.warn.push(`${at}${n} can't see ${this.projById.get(target)?.title || 'this project'}`));
    return out;
  },
  async checkAccess(w){
    if (!this.accessQuery(w)) return;
    const {target, names, one} = this.boxPeople(w), p = one && this.boxParsed(w);
    try {
      let blocked = false;
      for (const n of names) if (await this.canSee(target, n) === false && await this.userExists(n)) blocked = true;
      // Someone can't see it: look through the other projects, so one everyone can see can be picked.
      if (blocked && one && !p.project && w === 'cap') {
        const known = names.filter(n => this.userKnown[n.toLowerCase()] !== false);
        await Promise.all(this.projects.filter(x => x.id > 0 && x.id !== target).flatMap(x => known.map(n => this.canSee(x.id, n))));
      }
    } catch {}                                                                  // offline, say: no hints, and sending works as before
  },
  // Whether @name can see a project: true or false, or null when Pocket isn't allowed to look. Remembered until sign-out.
  async canSee(pid, name){
    const k = name.toLowerCase(), key = pid + ':' + k;
    if (key in this.access) return this.access[key];
    if (this.accessBlocked) return null;
    try {
      const u = items(await api(`/projects/${pid}/users/search?q=` + encodeURIComponent(name))).find(x => x.username.toLowerCase() === k);
      if (u) { userCache.set(k, u); this.userKnown[k] = true; }
      return this.access[key] = !!u;
    } catch (e) {
      if (e instanceof NetError) throw e;
      if (e instanceof ApiError && e.status === 403) this.accessBlocked = true;  // an API token without Projects → Users search
      return null;
    }
  },
  async userExists(name){
    const k = name.toLowerCase();
    if (!(k in this.userKnown)) this.userKnown[k] = !!(await this.findUser(name));
    return this.userKnown[k];
  },
  // The project a single task goes to: its +project, or the one picked for its @usernames, or the box's own.
  boxPid(w){
    const auto = this.accessHints(w).auto;
    return this.boxParsed(w).project?.id || (auto && !this.box(w).ignore?.autoProject ? auto.id : this.boxHome(w));
  },

  /* ---------- suggestions for the @username or *label at the cursor ---------- */
  // {kind: 'assignee' | 'label', prefix, q, start, end}: the word being typed, from its prefix to the end of the word.
  boxToken(w){
    const P = this.prefixes, b = this.box(w);
    if (!P || !b.focus) return null;
    const text = b.text, at = Math.min(b.caret, text.length), tail = text.slice(at).match(/^\S*/)[0];
    for (const kind of ['assignee', 'label']) {
      const m = text.slice(0, at).match(new RegExp(`(^|\\s)\\${P[kind]}(?:"([^"]*)|([^\\s"]*))$`));
      if (m) return {kind, prefix: P[kind], q: m[2] ?? m[3] ?? '', start: m.index + m[1].length, end: at + tail.length};
    }
    return null;
  },
  /* Chips to tap instead of typing the rest: people who can see the task's project first, then others you share with.
     None once the word already names one exactly, so the usual chips show what will be saved. */
  suggestions(w){
    const tk = this.boxToken(w);
    if (!tk) return null;
    const q = tk.q.toLowerCase();
    if (q && (tk.kind === 'label' ? this.labels.some(l => l.title.toLowerCase() === q) : (this.people || []).some(x => x.user.username.toLowerCase() === q))) return null;
    const score = (...names) => Math.min(...names.map(n => (n || '').toLowerCase()).map(n => n.startsWith(q) ? 0 : n.includes(q) ? 1 : 9));
    let out;
    if (tk.kind === 'label') {
      out = this.labels.map(l => ({l, s: score(l.title)})).filter(x => x.s < 9).sort((a, b) => a.s - b.s || a.l.title.localeCompare(b.l.title))
        .map(({l}) => ({key: 's' + l.id, kind: 'suggest', cls: 'suggest', color: colorOf(l.hex_color), text: tk.prefix + l.title, hint: 'Use this label', action: () => this.useSuggestion(w, tk, l.title)}));
    } else {
      const pid = this.boxParsed(w).project?.id || this.boxHome(w);
      out = (this.people || []).map(x => ({x, s: score(x.user.username, x.user.name), away: !x.pids.has(pid)})).filter(y => y.s < 9)
        .sort((a, b) => a.away - b.away || a.s - b.s || (a.x.user.name || a.x.user.username).localeCompare(b.x.user.name || b.x.user.username))
        .map(({x: {user: u}}) => ({key: 's' + u.id, kind: 'suggest', cls: 'suggest', text: (u.name ? u.name + ' ' : '') + tk.prefix + u.username, hint: 'Assign ' + (u.name || u.username), action: () => this.useSuggestion(w, tk, u.username)}));
    }
    // Suggestions are outlined, unlike what was read; the first says Enter takes it.
    if (out.length) Object.assign(out[0], {text: out[0].text + '  ↵', hint: out[0].hint + ', or press Enter'});
    return out.length ? out.slice(0, 6) : null;
  },
  useSuggestion(w, tk, name){
    const b = this.box(w), word = tk.prefix + (/\s/.test(name) ? `"${name}"` : name) + ' ', el = this.boxEl(w);
    const text = b.text = el.value = b.text.slice(0, tk.start) + word + b.text.slice(tk.end).replace(/^ /, '');
    // Set the text and cursor now, not on Alpine's next tick: a fast typist's next letters would otherwise land before the word.
    const at = b.caret = Math.min(tk.start + word.length, text.length);
    el.focus(); el.setSelectionRange(at, at);
  },
  /* Everyone with access to each of your projects, from Vikunja's list per project (which counts teams). Loaded once; it also
     tells checkAccess who can see what, without asking again. Skipped for an API token without Projects → Users search. */
  async loadPeople(){
    if (this.people || this.accessBlocked) return;
    if (peopleLoading) return peopleLoading;
    peopleLoading = (async () => {
      const projs = this.projects.filter(p => p.id > 0), get = p => api(`/projects/${p.id}/users/search`).then(items).catch(e => {
        if (e instanceof ApiError && e.status === 403) this.accessBlocked = true;
        return null;
      });
      const first = projs.length ? await get(projs[0]) : [];                    // one first, so a token that can't stops here
      if (this.accessBlocked) return;
      const lists = [first, ...await Promise.all(projs.slice(1).map(get))], byName = new Map();
      projs.forEach((p, i) => { for (const u of lists[i] || []) {
        const k = u.username.toLowerCase();
        if (!byName.has(k)) byName.set(k, {user: u, pids: new Set()});
        byName.get(k).pids.add(p.id);
      } });
      for (const [k, x] of byName) {
        userCache.set(k, x.user); this.userKnown[k] = true;
        projs.forEach((p, i) => { if (lists[i]) this.access[p.id + ':' + k] = x.pids.has(p.id); });
      }
      this.people = [...byName.values()];
    })().finally(() => { peopleLoading = null; });
    return peopleLoading;
  },

  /* Enter in an add box: while @ or * is being typed and something's suggested, the suggestion on top; else send. In a
     template's boxes: the name goes on to the first step, a step being written to the next row, a step changed is done. */
  boxEnter(w){
    const tk = this.boxToken(w), sg = tk?.q && this.suggestions(w);
    if (sg?.length) { sg[0].action(); return; }
    if (w === 'cap') this.submitCapture(); else if (w === 'ins') this.insertStep(); else if (this.isSubBox(w)) this.addSubtasks(w);
    else if (w === 'tname') document.getElementById('new-step-0')?.focus();
    else if (w === 'edit') this.boxEl(w)?.blur();
    else { const [which, key] = w.split(':'); this.addDraftRow(which, this.draftRows(which).findIndex(r => r.key === key) + 1); }
  },
  // A template's step, or its name, as quick add reads it, without the chips tapped off: its time is its own.
  stepParsed(text, ignore){ return parseCapture(text || '', this.projects, {...this.parseOpts, ignore: {...STEP_IGNORE, ...ignore}}); },
  // Whether what's sent from a box gets a reminder at its due time: one line, with a time, and the 🔔 chip on.
  remindOn(w, lines){ const p = this.boxParsed(w); return this.box(w).remind && lines.length === 1 && !!p.due && p.due > new Date() && !!p.timeRead && this.remindersReach; },
  // A chip tapped: its own action, or its words kept in the title (tapped off), or read again.
  tapChip(w, c){
    const b = this.box(w);
    if (c.action) c.action(); else if (c.kind) b.ignore = {...b.ignore, [c.kind]: !b.ignore?.[c.kind]};
  },
  /* What a box read, as chips under it. A subtask box doesn't name the project its lines go to (the task's), and has no
     photos or "Under first line". */
  chips(w){
    const b = this.box(w), cap = w === 'cap';
    // Photos for the new task, each with a tap to take it off again. A pasted list puts them on its first task.
    const photos = !cap ? [] : this.capPhotos.map((f, i) => ({key: 'ph' + i, cls: 'photo', icon: 'clip', hint: 'Tap to remove this photo',
      text: f.name + (this.capLines.length > 1 ? ' · on the first task' : '') + '  ✕', action: () => this.capPhotos.splice(i, 1)}));
    if (!b.text.trim()) return photos;
    const sg = this.suggestions(w);
    if (sg) return sg;
    const ticked = tickedLines(b.text);
    if (ticked) photos.push({key: 'tk', text: `${ticked} line${ticked === 1 ? '' : 's'} ticked off already: left out`});
    const parsed = this.boxParsed(w), p = cap && this.projById.get(parsed.project?.id || this.defaultProjectId()), out = [], n = this.boxLines(w).length;
    out.push(...photos);
    // A pasted list: how many, where they go, and anyone in it who can't see that project, before it's sent.
    const listWarn = () => this.accessHints(w).warn.map((text, i) => ({key: 'w' + i, cls: 'warn', text}));
    if (n > 1 && !cap) { out.push({key: 'n', text: `${n} ${this.isSubBox(w) ? 'subtasks' : 'steps'}`}, ...listWarn()); return out; }
    if (n > 1) {
      out.push({key: 'n', text: this.cap.nest ? `1 task + ${n - 1} subtask${n > 2 ? 's' : ''}` : `${n} tasks`});
      const {project, miss} = this.parseList(this.capLines);
      const to = this.projById.get(project?.id || this.defaultProjectId());
      if (to) out.push({key: 'p', color: colorOf(to.hex_color), text: to.title});
      if (miss) out.push({key: 'miss', kind: 'new-project', cls: 'create', hint: 'Tap to create this project',
        text: this.creatingProject ? 'Creating…' : `+ Create project “${projectName(miss)}”`, action: () => this.createProject(miss)});
      out.push(...listWarn());
      return out;
    }
    // Chips come from the full parse; tapped-off ones stay visible (struck through) so they can be turned back on.
    const all = this.boxParsed(w, true), off = k => !!b.ignore?.[k];
    const {auto, warn} = this.accessHints(w);
    if (all.project) out.push({key: 'p', kind: 'project', color: colorOf(all.project.hex_color), text: all.project.title, off: off('project')});
    // A project picked because the @usernames can see it; tap to send it to the default project after all.
    if (auto) out.push({key: 'ap', kind: 'autoProject', color: colorOf(auto.hex_color), text: auto.title, off: off('autoProject'),
      hint: off('autoProject') ? 'Tap to use this project' : `Picked because ${parsed.assignees.map(n => this.prefixes.assignee + n).join(', ')} can see it. Tap to undo`});
    if (p && !parsed.project && !(auto && !off('autoProject'))) out.push({key: 'dp', color: colorOf(p.hex_color), text: p.title});      // where it lands otherwise
    // A +project that doesn't exist yet: tap to create it; the line then finds it by name.
    if (all.projectMiss) out.push({key: 'miss', kind: 'new-project', cls: 'create', hint: 'Tap to create this project',
      text: this.creatingProject ? 'Creating…' : `+ Create project “${projectName(all.projectMiss)}”`, action: () => this.createProject(all.projectMiss)});
    if (all.due && !all.dueFromRepeat) out.push({key: 'due', kind: 'due', cls: 'num', text: all.dueLabel, off: off('due')});
    // A time typed ("at 4pm", "in 2 hours", not a bare "friday"): a reminder at it, only when tapped on. Vikunja sends it
    // by email, so only when that reaches you, and only for a time still to come.
    if (all.due && all.timeRead && all.due > new Date() && !off('due') && this.remindersReach) out.push({key: 'rem', kind: 'remind', cls: 'toggle', pressed: b.remind,
      text: '🔔 Remind me', hint: b.remind ? 'Tap for no reminder' : 'Tap to have Vikunja email you a reminder at this time', action: () => { b.remind = !b.remind; }});
    if (all.repeatWarn) out.push({key: 'rw', cls: 'warn', text: `Vikunja can't repeat “${all.repeatWarn}”: it stays in the title`});
    if (all.repeat) out.push({key: 'rep', kind: 'repeat', text: '↻ ' + all.repeat.label + (all.dueFromRepeat ? ', from ' + all.dueLabel : ''), off: off('repeat')});
    if (all.priority) out.push({key: 'prio', kind: 'priority', text: 'Priority ' + all.priority, off: off('priority')});
    all.labels.forEach((l, i) => out.push({key: 'l' + i, kind: 'labels', text: this.prefixes.label + l, off: off('labels')}));
    all.assignees.forEach((u, i) => out.push({key: 'a' + i, kind: 'assignees', text: this.prefixes.assignee + u, off: off('assignees')}));
    warn.forEach((text, i) => out.push({key: 'w' + i, cls: 'warn', text}));
    out.push(...this.ignoredChips(w, this.boxLines(w)[0] || ''));
    // A step being changed: the people and labels it has, to tap off it.
    if (w === 'edit') out.push(...this.stepHasChips());
    const to = this.boxPid(w);
    if (to && !this.canWrite(to)) out.push({key: 'ro', cls: 'warn', text: `${this.projById.get(to)?.title || 'This project'} is shared with you to read only: it can't be added to`});
    return out;
  },

  /* ---------- what quick add's box adds to, on a project's list ---------- */
  /* On a project's list, quick add's box adds a task to the project, until a task is touched: its sheet opened, ticked,
     its progress slid, or nudged (a short, slow scroll that starts on it: nudged). That task is then the cursor, lit
     up, and the box adds subtasks to it (the box 'under'); one on a subtask adds them after it, under its parent. A
     task ticked done can't be one: its parent is, if it's on the list. The box goes back to adding a task with its ×,
     when the cursor's row is out of sight (scrolling back doesn't bring it back), or when the screen is left. */
  // A task that can be the cursor: open, on this project's list, one you can change, and not a run, a step of one or a
  // template, which add steps their own way.
  canAim(t){
    return !!t && this.route.name === 'project' && !t.pending && !t.done && this.canWrite(t.project_id) && !this.isRunTask(t) && !this.stepRun(t)
      && !(this.checklistIds.has(t.project_id) && hasTemplateLabel(t)) && !this.deleting.includes(t.id) && this.onList(t);
  },
  onList(t){ return this.view.groups.some(g => g.key === 'open' && g.tasks.includes(t)); },
  // The task touched last, or none if it can't be the cursor. `after` is the last subtask added from the box, which the
  // next go after.
  aim(t){
    if (this.canAim(t)) { if (this.cursor?.id !== t.id) this.cursor = {id: t.id, after: null}; }
    else this.cursor = null;
  },
  /* A nudge on a row (watchNudges, app/progress.js): it's the target, as opening its sheet makes it, if it can be one,
     isn't marked or showing a line, and is still in sight between the header and the add box, so the lit row is seen.
     A row that can't be leaves the target as it was. A light tick is felt when the target changes, not when it stays.
     On a run's screen, a step's row nudged puts that step on the card, as a tap on it does (without scrolling up to
     it), so the box aims there: one current step, never two. Only while the box shows. */
  nudged(id){
    const run = this.route.name === 'run', row = document.querySelector(`#view .row[data-id="${id}"]`);
    const t = run ? this.runAim && this.runView.steps.find(s => String(s.id) === String(id)) : this.tasks[id];
    if (!row || (run ? !t : this.leaving[id] || this.lines[id] || !this.canAim(t))) return;
    const r = row.getBoundingClientRect(), top = Math.max(0, this.$refs.header?.getBoundingClientRect().bottom || 0);
    if (r.bottom <= top || r.top >= (this.$refs.captureBar?.getBoundingClientRect().top ?? innerHeight)) return;
    if ((run ? this.runView.step?.id : this.cursor?.id) !== t.id && NUDGE_TICK) haptic('tick');
    if (run) this.showStep(t.i); else this.aim(t);
  },
  // A tick or a slide: the task, still open; done, the task it's under, to add more beside it.
  aimAfterTick(t){ this.aim(t.done ? this.listParent(t) : t); },
  // The task a row is under on this list, if it's there.
  listParent(t){
    const ids = t.parent ? [t.parent] : (t.related_tasks?.parenttask || []).map(x => x.id);
    return ids.map(id => this.tasks[id]).find(p => p && this.onList(p)) || null;
  },
  get cursorTask(){ const t = this.cursor && this.tasks[this.cursor.id]; return this.canAim(t) ? t : null; },
  // The task the box's subtasks go under: the cursor's, or the cursor itself.
  get cursorParent(){ const t = this.cursorTask; return t && (this.listParent(t) || t); },
  // Which box quick add's is: adding a task, subtasks to the cursor, or on a run's screen, steps.
  get capW(){ return this.route.name === 'run' ? 'ins' : this.cursorTask ? 'under' : 'cap'; },
  // Its text and the rest, as the box `capW` keeps them: a run's apart from quick add's, so neither turns up in the other.
  get capBox(){ return this.box(this.capW); },
  /* What the box adds to, said above it: the task, and the subtask they go after, unless that's the last. On a run's
     screen, the step they go after, and the card's step, which Repeat copies there (not one still waiting to be sent). */
  get capTarget(){
    if (this.capW === 'ins') { const a = this.runAim; return a && {step: true, after: a.title, repeat: a.on.title, canRepeat: !a.on.pending}; }
    const t = this.cursorTask, p = this.cursorParent;
    return t && {to: p.title, after: this.cursor.after?.title || (t !== p ? t.title : '')};
  },
  get capPlaceholder(){
    if (this.capW === 'ins') return 'Add a step, or paste a list';
    if (this.cursorTask) return 'Add a subtask';                     // photos wait for a task: none show meanwhile
    if (this.capPhotos.length) return 'What\'s this photo for?';
    return this.route.name === 'project' && this.view.project ? 'Add a task to ' + this.view.project.title : 'Add a task';
  },
  // The same, to a screen reader, said as it changes.
  get capTargetText(){
    const c = this.capTarget;
    return !c ? '' : c.step ? `Add a step after “${c.after}”` : `Add a subtask to ${c.to}${c.after ? ', after ' + c.after : ''}`;
  },
  // Where the next `n` subtasks from the box go in the project's List view: after the cursor's subtask, or the last one
  // added from the box, else after the parent's last subtask; null if the project has no List view.
  cursorPlaces(n){
    const t = this.cursorTask, p = this.cursorParent;
    if (!this.view.listView) return null;
    const after = this.cursor.after ? this.cursor.after.pos : t !== p ? this.positions[t.id] || 0 : null;
    return placeAfter((p.related_tasks?.subtask || []).map(s => this.positions[s.id] || 0), after, n);
  },
  // The cursor's row, as it's drawn: watched, so the box goes back to adding a task once it's out of sight.
  watchCursor(el){
    if (watched === el || !window.IntersectionObserver) return;
    cursorIO ||= new IntersectionObserver(es => { for (const e of es) if (!e.isIntersecting && e.target === watched && +watched.dataset.id === this.cursor?.id) this.cursor = null; });
    cursorIO.disconnect(); watched = el; cursorIO.observe(el);
  },

  /* ---------- the words quick add read, marked in the box ---------- */
  // Marks in the text as typed, over every line of a pasted list. A tapped-off chip's words aren't marked, since they
  // stay in the title, nor is an @username that won't be assigned: no such user, or one who can't see the project.
  marks(w){
    if (!this.prefixes || !this.boxLines(w).length) return [];
    const parsed = this.boxParsedLines(w), target = parsed.length === 1 ? this.boxPid(w) : this.boxPeople(w).target;
    const stays = n => this.userKnown[n.toLowerCase()] === false || (target && this.access[target + ':' + n.toLowerCase()] === false);
    const out = [];
    let at = 0, k = 0;
    for (const l of this.box(w).text.split('\n')) {
      // Where the line's text starts, as captureLines finds it: after indent, list marker and spaces. A line ticked off
      // already is left out, as it is there.
      const t = l.trim(), u = t.replace(LIST_MARKER, '');
      if (u.trim() && !isTicked(l)) {
        const start = at + (l.length - l.trimStart().length) + (t.length - u.length) + (u.length - u.trimStart().length);
        for (const m of parsed[k++]?.marks || []) if (!(m.kind === 'assignees' && stays(m.name))) out.push({...m, start: m.start + start, end: m.end + start});
      }
      at += l.length + 1;
    }
    // A step's time, read on its own ("in 20 min"), marked like the rest, unless its chip was tapped off.
    const ph = this.isStepBox(w) && !this.box(w).keep && readStepPhrase(this.box(w).text);
    if (ph) out.push({kind: 'due', start: ph.index, end: ph.index + ph.length});
    return out.sort((a, b) => a.start - b.start);
  },
  // The box's text with those marks, drawn behind the box itself (.cap-marks), so the marks sit under the typed words.
  marksHtml(w){
    const text = this.box(w).text;
    let html = '', at = 0;
    for (const m of this.marks(w)) { html += esc(text.slice(at, m.start)) + `<mark data-kind="${m.kind}">${esc(text.slice(m.start, m.end))}</mark>`; at = m.end; }
    return html + esc(text.slice(at)) + '​';                   // the zero-width space keeps a last empty line's height
  },
};
