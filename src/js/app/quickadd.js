// Parse add boxes, suggest people, labels and projects, check project access, and position the box under its target row.
import {app, colorOf, esc, userCache} from '../util.js';
import {api, ApiError, items, NetError, sharedToken} from '../api.js';
import {hasTemplateLabel, inBatches, readStepPhrase, STEP_IGNORE} from '../checklists.js';
import {parentIds, saved} from '../lists.js';
import {clearOf, listViewOf, placeAfter, placeFirst} from '../order.js';
import {inTextField, NUDGE_TICK} from '../progress.js';
import {haptic} from '../haptics.js';
import {parseCapture, projectName, QUICK_ADD_PREFIXES, readList} from '../quickadd.js';
import {sync} from '../sync.js';
import {seats, seatUnder} from './seat.js';

let peopleLoading = null;                      // loadPeople() while it runs
let peopleAt = 0;                              // when it last loaded, this session
const PEOPLE_AGE = 10 * 6e4;                   // reload project access after this interval
// Track the target row's visibility and a fallback row until a newly added target has appeared on screen.
let cursorIO = null, watched = null, stand = null;
const inSight = new WeakMap();
// Cache each box's parsed text and inputs so its chips, highlights and submission share the same parse.
const reads = new Map();

export default {
  /* Every add box shares the same parsing, chips and suggestions. `w` names the box: cap adds tasks, sub and under add
     subtasks, and ins inserts a checklist step. tname is a template's name, new: and add: write its steps, and edit
     changes one step. */
  box(w){
    if (w === 'sub') return this.sheet.sub;
    if (w === 'under') return this.cap;
    if (w === 'ins') return this.runInsert;
    if (w === 'tname') return this.sheet.newTpl?.box || {text: ''};
    if (w === 'edit') return this.sheet.stepEdit || {text: ''};
    const [which, key] = w.split(':');
    if (key) return this.stepBox(which);                              // 'new:+' and 'add:+' are the box that holds a template's steps
    return this.cap;
  },
  boxEl(w){
    if (w === 'sub') return document.getElementById('d-subin');
    if (w === 'under') return this.$refs.capture;
    if (w === 'ins') return document.getElementById('run-in');
    if (w === 'tname') return document.getElementById('nt-name');
    if (w === 'edit') return document.getElementById('step-edit-' + this.sheet.stepEdit?.id);
    if (w.includes(':')) return document.getElementById('d-subin');
    return this.$refs.capture;
  },
  /* Which kinds of words a box leaves in the title. A subtask stays in its parent's project, so a +project in its
     title is plain text. A checklist step takes its time from T# timing and starts with no progress, so date and
     percentage words stay in its title. A subtask in a checklist project keeps date words in the title too, but
     reads a percentage. */
  boxBase(w){
    if (w === 'cap') return {};
    if (!this.isSubBox(w)) return STEP_IGNORE;
    return this.checklistIds.has(this.boxParent(w)?.project_id) ? {...STEP_IGNORE, progress: false} : {project: true};
  },
  // These boxes add subtasks. 'under' adds them to the cursor's parent task, and 'sub' to the task in the open sheet.
  isSubBox(w){ return w === 'sub' || w === 'under'; },
  boxParent(w){ return w === 'under' ? this.cursorParent : this.sheet.task; },
  // The project a line goes to when it has no +project. It depends on the box, so a subtask goes to its parent's
  // project and a checklist step to the checklist's.
  boxHome(w){
    if (w === 'sub' || w === 'edit' || w.startsWith('add:')) return this.sheet.task?.project_id;
    if (w === 'under') return this.cursorParent?.project_id;
    if (w === 'ins') return this.view.run?.run.project_id;
    if (w === 'tname' || w.startsWith('new:')) return this.sheet.newTpl?.project.id;
    return this.defaultProjectId();
  },
  /* Only quick add and subtask boxes can create done tasks. Turning the Done chip off keeps a done marker in the
     title for one line, and leaves done lines out of a list. Checklist and template boxes always leave them out. */
  readsDone(w){ return w === 'cap' || this.isSubBox(w); },
  /* The cache for one box, keyed by its text, the chips tapped off, nesting, quick add mode and due time. Chips,
     highlights and sending ask for the same data many times while rendering, so each part is parsed once, when first
     read. */
  boxRead(w){
    const b = this.box(w), key = [b.text, JSON.stringify(b.ignore), !!b.nest, !!b.flat, this.quickAddMode, this.dueTime, JSON.stringify(this.boxBase(w))].join('\0');
    const had = reads.get(w);
    if (had && had.key === key && had.projects === this.projects) return had;
    const r = {key, projects: this.projects, list: null, first: null, firstAll: null, lines: null};
    reads.set(w, r);
    return r;
  },
  boxList(w){
    const r = this.boxRead(w);
    if (r.list) return r.list;
    const b = this.box(w), cap = w === 'cap';
    return r.list = readList(b.text, this.readsDone(w) ? {done: !b.ignore?.done, nest: cap && !!b.nest, flat: cap && !!b.flat, colon: cap} : {steps: true});
  },
  /* A pasted list keeps the nesting it was written with. Turning the Under first line chip off flattens the list, and
     turning it on again restores the nesting. A list with no written nesting gets the first line as the parent when
     the chip is on. Only quick add has this chip. A subtask box keeps a trailing colon in the title. */
  get nestOn(){ return this.cap.nest || (!this.cap.flat && this.boxList('cap').first); },
  tapNest(){
    const c = this.cap;
    if (this.nestOn) { if (c.nest) c.nest = false; else c.flat = true; }
    else if (c.flat) c.flat = false; else c.nest = true;
  },
  boxLines(w){ return this.boxList(w).lines.map(l => l.text); },
  get capLines(){ return this.boxLines('cap'); },
  // The user's Vikunja settings: "default due time" and Quick Add Magic mode (vikunja, todoist or disabled).
  get dueTime(){ return this.user?.settings?.frontend_settings?.default_due_time || '12:00'; },
  get quickAddMode(){ return this.user?.settings?.frontend_settings?.quick_add_magic_mode || 'vikunja'; },
  get prefixes(){ return QUICK_ADD_PREFIXES[this.quickAddMode] || null; },
  get parseOpts(){ return {mode: this.quickAddMode, dueTime: this.dueTime}; },
  // Parse a box's first line. With `all`, the chips the user tapped off are read anyway.
  boxParsed(w, all = false){
    const r = this.boxRead(w), k = all ? 'firstAll' : 'first';
    if (r[k]) return r[k];
    const base = this.boxBase(w);
    return r[k] = parseCapture(this.boxLines(w)[0] || '', this.projects, {...this.parseOpts, ignore: all ? base : {...base, ...this.box(w).ignore}});
  },
  get parsed(){ return this.boxParsed('cap'); },
  /* Parse every line of a box. A pasted quick add list uses one project for all its lines. Each line keeps its done
     state and its parent's index. A parent's own percentage is dropped, because its subtasks decide its progress. */
  boxParsedLines(w){
    const r = this.boxRead(w);
    if (r.lines) return r.lines;
    const list = this.boxList(w).lines, lines = list.map(l => l.text), first = this.boxParsed(w);
    const parsed = w === 'cap' ? (lines.length > 1 ? this.parseList(lines, first).parsed : [first])
      : lines.map((l, i) => i ? parseCapture(l, this.projects, {...this.parseOpts, ignore: this.boxBase(w)}) : first);
    const parents = new Set(list.map(l => l.under));
    return r.lines = parsed.map((p, i) => ({...p, done: !!list[i]?.done, under: list[i]?.under ?? null, ...parents.has(i) && {pct: 0}}));
  },
  // Each item keeps its original text (with the done marker) and parent index, so a rejected entry can go back into
  // the box.
  boxItems(w){
    const lines = this.boxLines(w), remind = this.remindOn(w, lines);
    return this.boxParsedLines(w).map((p, i) => ({raw: p.done ? 'x ' + lines[i] : lines[i], p: {...p, remind}, under: p.under}));
  },
  /* The first +project anywhere in a pasted list applies to every line, and other project names stay in their
     titles. Returns {parsed, project, miss}. `first` is the first line when it is already parsed. */
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
  // Whether a box writes a template's step ('new:', 'add:') or edits one ('edit').
  isStepBox(w){ return w === 'edit' || /^(new|add):/.test(w); },
  /* The hint shown in an empty box. It lists only what that box reads. A template name takes people and labels, a
     step also takes a time, and a subtask box has no +project and, in a checklist project, no dates. */
  boxHint(w){
    const p = this.prefixes;
    if (!p) return 'Quick add shortcuts are turned off in your Vikunja settings';
    const tags = `${p.label}label  !1–5`;
    if (w === 'tname') return `${p.assignee}user assigns its checklists  ${tags} · set a due date and Repeats after creating it`;
    if (w === 'ins') return `${p.assignee}user assigns the step  ${tags} · paste a list to add one step per line`;
    if (this.isStepBox(w)) return `${p.assignee}user assigns the step  ${tags} · “in 20 min” makes it due 20 minutes after the previous step`;
    const base = this.boxBase(w), dates = base.due ? 'dates stay in the title in a checklist project' : 'tomorrow · fri at 2 · Oct 12 · every week';
    return `${base.project ? '' : p.project + 'project  '}${p.label}label  ${p.assignee}user  !1–5  ${dates} · tap a chip to undo it`;
  },
  /* Show a muted chip when a box leaves a date or project name in the title, so the user sees the words were not
     read. A step's time is read separately (readStepPhrase). */
  ignoredChips(w, line){
    const base = this.boxBase(w), out = [];
    if (!base.due && !base.project) return out;
    const ph = this.isStepBox(w) && readStepPhrase(line), rest = ph ? line.slice(0, ph.index) + line.slice(ph.index + ph.length) : line;
    const raw = parseCapture(rest, this.projects, {...this.parseOpts, ignore: {}});
    if (base.due && (raw.due || raw.repeat)) out.push({key: 'ign-d', cls: 'quiet', text: w === 'tname' ? 'Dates stay in the name. Set a due date and Repeats after creating the template.'
      : w === 'ins' ? 'Dates stay in the title. A step added to a checklist has no due time.' : this.isSubBox(w) ? 'Dates stay in the title. A subtask in a checklist project may become a step.'
      : 'Dates stay in the title. Write a step\'s time as a delay, like “in 20 min”.'});
    if (base.project && (raw.project || raw.projectMiss)) out.push({key: 'ign-p', cls: 'quiet', text: this.isSubBox(w) ? `${this.prefixes.project}project stays in the title. A subtask goes in its parent's project.`
      : `${this.prefixes.project}project stays in the title. A checklist's steps are in its project.`});
    return out;
  },

  /* ---------- @username: who can see the task's project ---------- */
  /* The project a task or pasted list goes to, and the users it mentions. Access is checked against these. */
  boxPeople(w){
    const lines = this.boxLines(w);
    if (lines.length === 1) { const p = this.boxParsed(w); return {target: p.project?.id || this.boxHome(w), names: p.assignees, one: true}; }
    const ps = this.boxParsedLines(w);
    return {target: (w === 'cap' && ps[0]?.project?.id) || this.boxHome(w), names: [...new Set(ps.flatMap(p => p.assignees))], one: false};
  },
  // What checkAccess looks up: the project and the @usernames. Empty when there's nothing to check.
  accessQuery(w){
    // The 'under' box has nothing to check while there is no cursor task.
    if (!this.boxLines(w).length || this.accessBlocked || !this.prefixes || (w === 'under' && !this.cursorTask)) return '';
    const {target, names} = this.boxPeople(w);
    return names.length ? [target, ...names.map(n => n.toLowerCase())].join('|') : '';
  },
  /* Returns {auto, warn} from the access already loaded. When quick add has no typed +project and some mentioned
     user can't see the default project, `auto` is the one project all mentioned users can see, if there is exactly
     one. `warn` lists the users who can't see the target project. */
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
        if (v.includes(undefined)) return out;                                  // not looked up yet
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
      // If someone can't see the target project, look up the other projects too, so a project everyone can see can
      // be picked.
      if (blocked && one && !p.project && w === 'cap') {
        const known = names.filter(n => this.userKnown[n.toLowerCase()] !== false);
        await Promise.all(this.projects.filter(x => x.id > 0 && x.id !== target).flatMap(x => known.map(n => this.canSee(x.id, n))));
      }
    } catch {}                                                                  // offline: no hints, and sending still works
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
      if (e instanceof ApiError && e.status === 403) this.accessBlocked = true;  // the API token lacks permission for Projects → Users search
      return null;
    }
  },
  async userExists(name){
    const k = name.toLowerCase();
    if (!(k in this.userKnown)) this.userKnown[k] = !!(await this.findUser(name));
    return this.userKnown[k];
  },
  // The project a single task goes to. That is its +project, else the project picked because its @usernames can see
  // it, else the box's default.
  boxPid(w){
    const auto = this.accessHints(w).auto;
    return this.boxParsed(w).project?.id || (auto && !this.box(w).ignore?.autoProject ? auto.id : this.boxHome(w));
  },

  /* ---------- suggestions for the @username, *label or +project at the cursor ---------- */
  // {kind: 'assignee' | 'label' | 'project', prefix, q, start, end}: the word being typed, from its prefix to the end
  // of the word. A box that leaves +project in the title suggests no projects.
  boxToken(w){
    const P = this.prefixes, b = this.box(w);
    if (!P || !b.focus) return null;
    const text = b.text, at = Math.min(b.caret, text.length), tail = text.slice(at).match(/^\S*/)[0];
    for (const kind of this.boxBase(w).project ? ['assignee', 'label'] : ['assignee', 'label', 'project']) {
      const m = text.slice(0, at).match(new RegExp(`(^|\\s)\\${P[kind]}(?:"([^"]*)|([^\\s"]*))$`));
      if (m) return {kind, prefix: P[kind], q: m[2] ?? m[3] ?? '', start: m.index + m[1].length, end: at + tail.length};
    }
    return null;
  },
  /* People with access to the target project come first, then others who share your projects. Only projects you can
     add tasks to are suggested. A word that already matches a person, label or project exactly gets no suggestions,
     so its parsed chip shows instead. */
  suggestions(w){
    const tk = this.boxToken(w);
    if (!tk) return null;
    const q = (tk.kind === 'project' ? projectName(tk.q) : tk.q).toLowerCase();
    const names = tk.kind === 'label' ? this.labels.map(l => l.title) : tk.kind === 'project' ? this.projects.map(p => p.title) : (this.people || []).map(x => x.user.username);
    if (q && names.some(n => n.toLowerCase() === q)) return null;
    const score = (...names) => Math.min(...names.map(n => (n || '').toLowerCase()).map(n => n.startsWith(q) ? 0 : n.includes(q) ? 1 : 9));
    let out;
    if (tk.kind === 'label') {
      out = this.labels.map(l => ({l, s: score(l.title)})).filter(x => x.s < 9).sort((a, b) => a.s - b.s || a.l.title.localeCompare(b.l.title))
        .map(({l}) => ({key: 's' + l.id, kind: 'suggest', cls: 'suggest', color: colorOf(l.hex_color), text: tk.prefix + l.title, hint: 'Use this label', action: () => this.useSuggestion(w, tk, l.title)}));
    } else if (tk.kind === 'project') {
      out = this.projects.filter(p => this.canWrite(p.id)).map(p => ({p, s: score(p.title)})).filter(x => x.s < 9).sort((a, b) => a.s - b.s || a.p.title.localeCompare(b.p.title))
        .map(({p}) => ({key: 's' + p.id, kind: 'suggest', cls: 'suggest', color: colorOf(p.hex_color), text: tk.prefix + p.title, hint: 'Use this project', action: () => this.useSuggestion(w, tk, p.title)}));
    } else {
      const pid = this.boxParsed(w).project?.id || this.boxHome(w);
      out = (this.people || []).map(x => ({x, s: score(x.user.username, x.user.name), away: !x.pids.has(pid)})).filter(y => y.s < 9)
        .sort((a, b) => a.away - b.away || a.s - b.s || (a.x.user.name || a.x.user.username).localeCompare(b.x.user.name || b.x.user.username))
        .map(({x: {user: u}}) => ({key: 's' + u.id, kind: 'suggest', cls: 'suggest', text: (u.name ? u.name + ' ' : '') + tk.prefix + u.username, hint: 'Assign ' + (u.name || u.username), action: () => this.useSuggestion(w, tk, u.username)}));
    }
    // The first suggestion shows ↵ because Enter accepts it.
    if (out.length) Object.assign(out[0], {text: out[0].text + '  ↵', hint: out[0].hint + ', or press Enter'});
    return out.length ? out.slice(0, 6) : null;
  },
  useSuggestion(w, tk, name){
    const b = this.box(w), word = tk.prefix + (/\s/.test(name) ? `"${name}"` : name) + ' ', el = this.boxEl(w);
    const text = b.text = el.value = b.text.slice(0, tk.start) + word + b.text.slice(tk.end).replace(/^ /, '');
    // Set the text and caret at once, so letters typed quickly don't land before the completed suggestion.
    const at = b.caret = Math.min(tk.start + word.length, text.length);
    el.focus(); el.setSelectionRange(at, at);
  },
  /* Load each project's users in the background. Vikunja's search includes teams and inherited shares. The result
     checks assignees and decides which private projects show a claim slot. `seenBy` is saved on the phone. `force`
     loads again even when people are already loaded. Nothing loads when the API token lacks Projects → Users
     search. */
  async loadPeople(force = false){
    if ((this.people && !force) || this.accessBlocked) return;
    if (peopleLoading) return peopleLoading;
    peopleLoading = (async () => {
      // Don't request once Vikunja's web app has signed out. A background request could renew the cookie session
      // before Pocket notices.
      const gone = () => this.mode === 'session' && !sharedToken.get();
      const projs = this.projects.filter(p => p.id > 0), get = p => gone() ? null : api(`/projects/${p.id}/users/search`).then(items).catch(e => {
        if (e instanceof ApiError && e.status === 403) this.accessBlocked = true;
        return null;
      });
      const first = projs.length ? await get(projs[0]) : [];                    // load one project first, so a token without permission stops here
      if (this.accessBlocked) return;
      const lists = [first, ...await inBatches(projs.slice(1), 4, get)], byName = new Map();
      // Drop the old access entries of every project that loaded, so a removed share doesn't stay allowed.
      const loaded = new Set(projs.filter((p, i) => lists[i]).map(p => p.id));
      for (const key of Object.keys(this.access)) if (loaded.has(+key.split(':')[0])) delete this.access[key];
      projs.forEach((p, i) => { for (const u of lists[i] || []) {
        const k = u.username.toLowerCase();
        if (!byName.has(k)) byName.set(k, {user: u, pids: new Set()});
        byName.get(k).pids.add(p.id);
      } });
      for (const [k, x] of byName) {
        userCache.set(k, x.user); this.userKnown[k] = true;
        projs.forEach((p, i) => { if (lists[i]) this.access[p.id + ':' + k] = x.pids.has(p.id); });
      }
      projs.forEach((p, i) => { if (lists[i]) this.seenBy[p.id] = lists[i].filter(u => u.id !== this.user?.id).length; });
      if (loaded.size) { saved.set('seenBy', this.seenBy); peopleAt = Date.now(); }
      this.people = [...byName.values()];
    })().finally(() => { peopleLoading = null; });
    return peopleLoading;
  },
  // Reload project access in the background once it is older than PEOPLE_AGE.
  refreshPeople(){ return !this.people || Date.now() - peopleAt > PEOPLE_AGE ? this.loadPeople(true).catch(() => {}) : null; },

  /* Enter accepts the first suggestion, if there is one, and otherwise sends the box. In a template's name it moves
     to the steps box. In a step being edited it saves the step. */
  boxEnter(w){
    const tk = this.boxToken(w), sg = tk?.q && this.suggestions(w);
    if (sg?.length) { sg[0].action(); return; }
    if (w === 'tname') document.getElementById('d-subin')?.focus();
    else if (w === 'edit') this.boxEl(w)?.blur();
    else this.boxSend(w);
  },
  // What sending does depends on the box. Quick add creates tasks, a subtask box adds subtasks to its parent, the
  // checklist box inserts a step, and the template boxes add steps.
  boxSend(w){ return w === 'cap' ? this.submitCapture() : w === 'ins' ? this.insertStep() : w.includes(':') ? this.sendSteps(w.split(':')[0]) : this.addSubtasks(w); },
  // Parse a template name or a step, leaving out what the user tapped off. A step's time is read separately.
  stepParsed(text, ignore){ return parseCapture(text || '', this.projects, {...this.parseOpts, ignore: {...STEP_IGNORE, ...ignore}}); },
  // Whether the task gets a reminder at its due time. That needs one line with a future time, the 🔔 chip on, and a
  // Vikunja that can send reminders.
  remindOn(w, lines){ const p = this.boxParsed(w); return this.box(w).remind && lines.length === 1 && !!p.due && p.due > new Date() && !!p.timeRead && this.remindersReach; },
  // Run a chip's action, or switch off (or back on) the reading of its words. Words switched off stay in the title.
  tapChip(w, c){
    const b = this.box(w);
    if (c.action) c.action(); else if (c.kind) b.ignore = {...b.ignore, [c.kind]: !b.ignore?.[c.kind]};
  },
  /* Build the chips under a box from what it parsed. Only quick add shows photos and the list-nesting chip, and a
     subtask box shows no project chip. */
  chips(w){
    const b = this.box(w), cap = w === 'cap';
    // One chip per photo attached to the new task. Tapping a chip removes the photo. A pasted list puts the photos on
    // its first task.
    const photos = !cap ? [] : this.capPhotos.map((f, i) => ({key: 'ph' + i, cls: 'photo', icon: 'clip', hint: 'Tap to remove this photo',
      text: f.name + (this.capLines.length > 1 ? ' · on the first task' : '') + '  ✕', action: () => this.capPhotos.splice(i, 1)}));
    if (!b.text.trim()) return photos;
    const sg = this.suggestions(w);
    if (sg) return sg;
    /* For one line, turning Done off keeps the marker in the title. For a list, the chip counts the done lines and
       turns them on or off. Checklist and template boxes always leave them out and show no chip to change that. */
    const list = this.boxList(w), ticked = list.ticked, left = !!b.ignore?.done;
    // A # line is the list's name, as at the top of a copied project. It is left out, and a chip says so.
    if (list.names.length) photos.push({key: 'nm', cls: 'quiet', text: list.names.length === 1 ? 'The # line is the list’s name, so it is left out' : `${list.names.length} # lines are list names, so they are left out`});
    if (ticked && !this.readsDone(w)) photos.push({key: 'tk', text: `${ticked} line${ticked === 1 ? ' is' : 's are'} already ticked, so ${ticked === 1 ? 'it is' : 'they are'} left out`});
    else if (ticked && list.one) photos.push({key: 'tk', kind: 'done', text: 'Done', off: left});
    else if (ticked) photos.push({key: 'tk', kind: 'done', text: left ? `${ticked} already ticked, left out` : `${ticked} will be added as done`,
      hint: left ? `Tap to add ${ticked === 1 ? 'it' : 'them'} as done` : `Tap to leave ${ticked === 1 ? 'this line' : 'these lines'} out`});
    const parsed = this.boxParsed(w), p = cap && this.projById.get(parsed.project?.id || this.defaultProjectId()), out = [], n = list.lines.length;
    out.push(...photos);
    // For a pasted list, show how many tasks there are, which project they go to, and a warning for each user who
    // can't see that project.
    const listWarn = () => this.accessHints(w).warn.map((text, i) => ({key: 'w' + i, cls: 'warn', text}));
    if (n > 1 && !cap) { out.push({key: 'n', text: `${n} ${this.isSubBox(w) ? 'subtasks' : 'steps'}`}, ...listWarn()); return out; }
    if (n > 1) {
      // A line under another line counts as a subtask, as in "1 task + 3 subtasks".
      const subs = list.lines.filter(l => l.under !== null).length;
      out.push({key: 'n', text: subs ? `${n - subs} task${n - subs === 1 ? '' : 's'} + ${subs} subtask${subs === 1 ? '' : 's'}` : `${n} tasks`});
      const {project, miss} = this.parseList(this.capLines);
      const to = this.projById.get(project?.id || this.defaultProjectId());
      if (to) out.push({key: 'p', color: colorOf(to.hex_color), text: to.title});
      if (miss) out.push({key: 'miss', kind: 'new-project', cls: 'create', hint: 'Tap to create this project',
        text: this.creatingProject ? 'Creating…' : `+ Create project “${projectName(miss)}”`, action: () => this.createProject(miss)});
      out.push(...listWarn());
      return out;
    }
    // The chips come from the full parse. A chip the user tapped off stays visible, so it can be tapped on again.
    const all = this.boxParsed(w, true), off = k => !!b.ignore?.[k];
    const {auto, warn} = this.accessHints(w);
    if (all.project) out.push({key: 'p', kind: 'project', color: colorOf(all.project.hex_color), text: all.project.title, off: off('project')});
    // A project picked because the @usernames can see it. Tapping the chip sends the task to the default project.
    if (auto) out.push({key: 'ap', kind: 'autoProject', color: colorOf(auto.hex_color), text: auto.title, off: off('autoProject'),
      hint: off('autoProject') ? 'Tap to use this project' : `Picked because ${parsed.assignees.map(n => this.prefixes.assignee + n).join(', ')} can see it. Tap to undo`});
    if (p && !parsed.project && !(auto && !off('autoProject'))) out.push({key: 'dp', color: colorOf(p.hex_color), text: p.title});      // the default project, where the task goes otherwise
    // A +project that doesn't exist yet. Tapping the chip creates it, and the line then finds it by name.
    if (all.projectMiss) out.push({key: 'miss', kind: 'new-project', cls: 'create', hint: 'Tap to create this project',
      text: this.creatingProject ? 'Creating…' : `+ Create project “${projectName(all.projectMiss)}”`, action: () => this.createProject(all.projectMiss)});
    if (all.due && !all.dueFromRepeat) out.push({key: 'due', kind: 'due', cls: 'num', text: all.dueLabel, off: off('due')});
    // Offer a reminder only for a time the user typed, in the future, and when Vikunja can send reminder emails. The
    // chip starts off.
    if (all.due && all.timeRead && all.due > new Date() && !off('due') && this.remindersReach) out.push({key: 'rem', kind: 'remind', cls: 'toggle', pressed: b.remind,
      text: '🔔 Remind me', hint: b.remind ? 'Tap to turn the reminder off' : 'Tap to have Vikunja email you a reminder at this time', action: () => { b.remind = !b.remind; }});
    if (all.repeatWarn) out.push({key: 'rw', cls: 'warn', text: `Vikunja can't repeat “${all.repeatWarn}”, so it stays in the title`});
    if (all.repeat) out.push({key: 'rep', kind: 'repeat', text: '↻ ' + all.repeat.label + (all.dueFromRepeat ? ', from ' + all.dueLabel : ''), off: off('repeat')});
    if (all.priority) out.push({key: 'prio', kind: 'priority', text: 'Priority ' + all.priority, off: off('priority')});
    // A percentage at the end of the line sets the task's progress. 100% marks it done.
    if (all.pct) out.push({key: 'pct', kind: 'progress', cls: 'num', text: all.pct < 100 ? all.pct + '%' : '100%: done', off: off('progress')});
    // Sending creates a label Vikunja doesn't have yet. Its chip says so, so a mistyped name shows before sending.
    const isNew = l => this.labelsLoaded && !this.labels.some(x => x.title.toLowerCase() === l.toLowerCase());
    all.labels.forEach((l, i) => out.push({key: 'l' + i, kind: 'labels', text: this.prefixes.label + l + (isNew(l) ? ' · new label' : ''), off: off('labels')}));
    all.assignees.forEach((u, i) => out.push({key: 'a' + i, kind: 'assignees', text: this.prefixes.assignee + u, off: off('assignees')}));
    warn.forEach((text, i) => out.push({key: 'w' + i, cls: 'warn', text}));
    out.push(...this.ignoredChips(w, this.boxLines(w)[0] || ''));
    // When editing a step, show the people and labels it already has, so the user can tap them off.
    if (w === 'edit') out.push(...this.stepHasChips());
    const to = this.boxPid(w);
    if (this.boxIn && (w === 'under' || w === 'cap') && !this.cursorListView) out.push({key: 'noplace', cls: 'quiet', text: 'This project has no List view in Vikunja, so new tasks go last'});
    if (to && !this.canWrite(to)) out.push({key: 'ro', cls: 'warn', text: `${this.projById.get(to)?.title || 'This project'} is read only. You can't add tasks to it.`});
    return out;
  },

  /* ---------- what quick add's box adds to, on a project's list ---------- */
  /* A nudge, or Add a subtask here, makes a row the target that quick add's box adds to. It is highlighted. Each new
     subtask becomes the target, so the next one goes after it. `cursor` is {id, under}, plus `wait` while the target
     is a pending row. If the target leaves the list, its parent becomes the target, or the box goes back to adding
     tasks. Tapping the placeholder at the bottom, scrolling the target off screen or leaving the screen puts the box
     back at the bottom. Ordinary taps and progress gestures leave the box where it is. */
  // Whether a task can be the target: open and writable, on Today or a project list. A row marked done that waits
  // for the batch also counts. Checklists, their steps and templates have their own add boxes.
  canAim(t){
    const on = this.route.name;
    return !!t && (on === 'project' || on === 'today') && !t.pending && (!t.done || !!this.leaving[t.id]) && this.canWrite(t.project_id) && !this.isRunTask(t) && !this.stepRun(t)
      && !(this.checklistIds.has(t.project_id) && hasTemplateLabel(t)) && !this.deleting.includes(t.id) && (this.onList(t) || (on === 'today' && !!this.listParent(t)));
  },
  // Whether the screen's list shows the task as a row or a card. On a project that means its open tasks, and on
  // Today any group.
  onList(t){ const today = this.route.name === 'today'; return this.view.groups.some(g => (today || g.key === 'open') && g.tasks.includes(t)); },
  /* Set the target. `lit` is indexed by id, so moving the highlight redraws only the old and the new row. */
  light(c){
    const was = this.cursor;
    if (c && was && was.id === c.id && was.under === c.under && !was.wait === !c.wait && !was.out === !c.out) return;
    for (const id of Object.keys(this.lit)) if (!c || String(c.id) !== id) delete this.lit[id];
    if (c) this.lit[c.id] = true;
    this.cursor = c;
  },
  // Make a task the target, or clear the target if the task can't be one.
  aim(t){ this.light(this.canAim(t) ? {id: t.id, under: this.listParent(t)?.id ?? null} : null); },
  /* After subtasks are added, make the last new subtask's pending row the target at once, so the next entry goes
     after it. A subtask created done leaves with the batch, so the parent stays the target. */
  aimAdded(entry, i, parent){
    const p = entry.items[i].p, id = `pending-${entry.id}-${i}`;
    if (p.done || p.pct >= 100) return this.aim(parent);
    this.light({id, under: parent.id, wait: {id, pending: true, entry: entry.id, index: i, parent: parent.id, title: p.title, position: p.position || 0}});
  },
  /* Move the target from a pending row to the task that was saved for it. If Vikunja rejected the task and the entry
     is gone, the parent becomes the target. */
  aimSent(tasks){
    const c = this.cursor, w = c?.wait;
    if (!w) return;
    const t = tasks.find(x => x.was === w.id);
    if (t) this.light({id: t.id, under: c.under, ...(c.out && {out: true})});
    else if (!sync.all(this.user?.id).some(e => e.id === w.entry)) this.aim(this.tasks[c.under]);
  },
  // Cancelling the target's line makes its parent the target. Cancelling an earlier line of the same entry lowers the
  // pending target's index and id by one.
  aimCancelled(entry, index){
    const c = this.cursor, w = c?.wait;
    if (w?.entry !== entry || w.index < index) return;
    if (w.index === index) return this.aim(this.tasks[c.under]);
    const id = `pending-${entry}-${w.index - 1}`;
    this.light({...c, id, wait: {...w, id, index: w.index - 1}});
  },
  /* When the target leaves the list, its parent becomes the target, or the target is cleared if there is no parent.
     Reordering keeps the target, and the next entry goes after its new position. This runs after a sheet closes, so
     changes made temporarily inside the sheet don't move the box. */
  keepAim(){ const c = this.cursor; if (c && !this.cursorTask) this.aim(this.tasks[c.under]); },
  /* A nudge makes the row the target and vibrates when the target changes. It ignores marked rows, rows showing a
     message and pending rows. On a checklist screen it moves the add box under the step's row. The step on the card
     stays, because swapping the card would change the page's height under the finger. A tap on the row swaps it. */
  nudged(id){
    const run = this.route.name === 'run', row = document.querySelector(`#view :is(.row, .day-card)[data-id="${id}"]`);
    const t = run ? this.runAim && this.runView.steps.find(s => String(s.id) === String(id)) : this.tasks[id];
    if (!row || (run ? !t : this.leaving[id] || this.lines[id] || !this.canAim(t))) return;
    const r = row.getBoundingClientRect(), top = Math.max(0, this.$refs.header?.getBoundingClientRect().bottom || 0);
    const home = document.getElementById('cap-home'), foot = home?.offsetHeight ? home : this.$refs.captureBar;   // the add box's home at the bottom
    if (r.bottom <= top || r.top >= (run ? innerHeight : foot?.getBoundingClientRect().top ?? innerHeight)) return;   // a checklist screen has no bar there
    const was = run ? (this.runBoxAt == null ? null : this.actTask({task: this.runBoxAt})) : this.cursor?.id;
    if (String(was ?? '') !== String(t.id) && NUDGE_TICK) haptic('tick');
    if (run) this.nudgedStep(t); else this.aim(t);
  },
  // The task's parent, if the parent is also on this list.
  listParent(t){
    const ids = t.parent ? [t.parent] : (t.related_tasks?.parenttask || []).map(x => x.id);
    return ids.map(id => this.tasks[id]).find(p => p && this.onList(p)) || null;
  },
  // The cursor's task, if it can still be the target. For a pending row, that is the pending row, provided its
  // parent can still be the target.
  get cursorTask(){
    const c = this.cursor;
    if (!c) return null;
    // A pending task added with the box moved out a level has no parent and belongs to a project's list.
    if (c.wait) return (c.under == null ? !!c.out && this.route.name === 'project' : this.canAim(this.tasks[c.under])) ? c.wait : null;
    const t = this.tasks[c.id];
    return this.canAim(t) ? t : null;
  },
  // The task the box adds subtasks to. That is the cursor's parent, or the cursor itself when it has no parent.
  get cursorParent(){ const t = this.cursorTask; return t && (this.listParent(t) || t); },
  // Which box the main add box is right now. 'ins' adds a step on a checklist screen, 'under' adds subtasks to the
  // cursor, and 'cap' adds tasks. A box moved out a level (boxOut) is 'cap' again, though it stays in the list.
  get capW(){ return this.route.name === 'run' ? 'ins' : this.cursorTask && !this.cursor.out ? 'under' : 'cap'; },
  // Each of the three boxes keeps its own draft, so switching screens doesn't mix them.
  get capBox(){ return this.box(this.capW); },
  /* Names the parent, and the subtask the new ones go after. Without a List view only the parent is named, because
     new subtasks go last. */
  get capTarget(){
    if (this.capW === 'ins') return null;                              // a checklist screen has its own box under its steps (list-box.html)
    const t = this.cursorTask, p = this.cursorParent;
    return t && !this.cursor.out ? {to: p.title, after: t !== p && this.cursorListView ? t.title : ''} : null;
  },
  get capPlaceholder(){ return this.cursorTask ? (this.cursor.out ? 'Task' : 'Subtask') : this.capHomeSays; },   // in the list, the box's position already shows where it adds
  // The dashed placeholder at the bottom shows the same text as the empty box, so a tap on it plainly goes to the
  // box and its height doesn't change.
  get capHomeSays(){
    if (this.capPhotos.length) return 'What\'s this photo for?';
    return this.route.name === 'project' && this.view.project ? 'Add a task to ' + this.view.project.title : 'Add a task';
  },
  // The same text for a screen reader, which announces it when it changes.
  get capTargetText(){
    const c = this.capTarget;
    return c ? `Add a subtask to ${c.to}${c.after ? ', after ' + c.after : ''}` : '';
  },
  /* The List view whose positions new tasks use. On Today it is the List view of the target's project, so the
     subtasks added there appear in the same order in the project. */
  get cursorListView(){
    if (this.route.name === 'project') return this.view.listView;
    const p = this.cursorParent;
    return p ? listViewOf(this.projById.get(p.project_id))?.id || null : null;
  },
  /* Positions for n new subtasks: after the target subtask, or before the first subtask when the target is the
     parent. Saved, newly sent and pending subtasks all count. Returns null without a List view. */
  cursorPlaces(n){
    const t = this.cursorTask, p = this.cursorParent;
    if (!this.cursorListView) return null;
    const at = x => (x.pending ? x.position : this.positions[x.id]) || 0;
    const listed = (this.view.groups.find(g => g.key === 'open')?.tasks || []).filter(x => parentIds(x).includes(p.id));
    const ids = new Set([...(p.related_tasks?.subtask || []), ...listed].map(x => x.id));
    const sibs = [...[...ids].map(id => this.positions[id] || 0), ...this.pendingTasks.filter(x => x.parent === p.id).map(at)];
    return this.clearPlaces(t !== p ? placeAfter(sibs, at(t), n) : placeFirst(sibs, n), sibs);
  },
  /* Put the box back at the bottom when its target scrolls off screen and the box has no focus. A newly added
     target isn't on screen yet, so until it has been visible once the previous target is watched instead. That lets
     the user keep typing before the new row appears. */
  watchCursor(el){
    if (watched === el || !window.IntersectionObserver) return;
    const drop = x => { if (x && x !== watched) { cursorIO.unobserve(x); inSight.delete(x); } };
    cursorIO ||= new IntersectionObserver(es => {
      for (const e of es) inSight.set(e.target, e.isIntersecting);
      if (inSight.get(watched)) { const s = stand; stand = null; drop(s); }
      else if (inSight.has(watched) && !(stand && inSight.get(stand)) && watched.dataset.id === String(app.cursor?.id) && !app.boxHasFocus) app.light(null);
    });
    const was = watched;
    watched = el;
    if (was && inSight.get(was)) { const s = stand; stand = was; drop(s); } else drop(was);
    if (stand === el) stand = null;
    cursorIO.observe(el);
  },

  /* ---------- the add box in the list ---------- */
  /* Move the add box itself under its target row. The input is never recreated, so its text and focus stay. Space
     for the box is reserved under the row, and a dashed placeholder stays at the bottom. seatUnder follows the row
     when it moves, and clearing the target puts the box back at the bottom. */
  seatBox(){
    const bar = this.$refs.captureBar, root = document.documentElement;
    if (!bar) return;
    let key = '', inset = '';
    seatUnder(seats.bar, {
      box: () => bar, cls: 'boxed', prop: () => [root, '--box-h'], patience: 0, scrollBack: h => scrollBy(0, -h),
      // The cursor's row (boxSeat.sel). The previous element is reused while it is still on the page and has the same
      // key.
      row: () => {
        const s = this.boxSeat;
        if (!s) return null;
        const had = seats.bar.el, el = had?.isConnected && key === s.key ? had : document.querySelector(s.sel);
        key = el ? s.key : '';
        return el || undefined;
      },
      // Align the box with the list and indent it to the level of the tasks it adds.
      place: (b, el, changed) => {
        const s = this.boxSeat;
        b.classList.toggle('out', !!s?.out);                              // a box that adds a task has the bigger tick (styles.css, --mark)
        if (changed || !inset) inset = s?.out ? '14px' : Math.round(parseFloat(getComputedStyle(el).paddingLeft) + (s?.deeper ? parseFloat(getComputedStyle(root).getPropertyValue('--sub-in')) || 30 : 0)) + 'px';
        const r = el.getBoundingClientRect(), list = (el.closest('.list') || el).getBoundingClientRect();
        return [Math.round(r.bottom + scrollY), Math.round(list.left + scrollX), Math.round(list.width), inset].join();
      },
      apply: (b, at) => { const [top, left, width, pad] = at.split(','); b.style.top = top + 'px'; b.style.left = left + 'px'; b.style.width = width + 'px'; b.style.paddingLeft = pad; },
      unplace: b => { b.classList.remove('out'); b.style.top = b.style.left = b.style.width = b.style.paddingLeft = ''; },
    });
  },
  /* Returns {key, sel, out, deeper} for the row the box sits under, or the top-level item when the box is moved out,
     on Today and project lists. A checklist screen has its own box at the end of the step list. */
  get boxSeat(){
    if (!this.boxIn) return null;
    const c = this.cursor, out = !!c.out, id = String(out ? c.under ?? c.id : c.id);
    return {key: id + (out ? ':out' : ':in'), out, deeper: !c.under,
      sel: out ? `#view .item[data-id="${id}"]` : `#view .day-card[data-id="${id}"] > .card-head, #view .row[data-id="${id}"]`};
  },
  // Whether the box is in the list. Tapping the placeholder at the bottom puts it back there.
  get boxInList(){ return !!this.boxSeat; },
  boxBack(){ this.light(null); },
  get boxBackLabel(){
    const on = this.route.name;
    return on === 'today' ? 'Add a task instead' : 'Add a task to ' + (this.view.project?.title || 'this project') + ' instead';
  },
  /* Moving the box out a level makes it add tasks after the target task and its subtasks. Each new task becomes the
     target, at that same level. Moving back in adds subtasks, but only once the target task has been sent. */
  get boxIn(){ return ['project', 'today'].includes(this.route.name) && !!this.cursorTask; },
  // The box can change level only on a project's list. Today adds subtasks only.
  get canLevel(){ return this.boxIn && this.route.name === 'project'; },
  get boxOut(){ return this.boxIn && !!this.cursor.out; },
  get canIn(){ const c = this.cursor; return !!c && !(c.wait && c.under == null); },
  boxLevel(out){
    const c = this.cursor;
    if (!this.canLevel || out === !!c.out || (!out && !this.canIn)) return false;
    this.light({...c, out});
    return true;
  },
  // Tab and Shift+Tab change the level only when another level is available. Otherwise they move keyboard focus as
  // usual.
  boxTab(e){ if (this.boxLevel(e.shiftKey)) e.preventDefault(); },
  // A row's shortcut moves the add box and focuses its field so the next press acts on the box too.
  rowBox(t, g, dir, e){
    if (e.ctrlKey || e.metaKey || e.isComposing || inTextField(e.target) || g.own || g.top || g.locked) return;
    const w = g.sheet ? this.subBoxW : g.run ? (this.runAim ? 'ins' : '') : this.capW;
    if (!w || !this.boxMove(w, dir, t.id)) return;
    e.preventDefault();
    this.$nextTick(() => this.boxEl(w)?.focus({preventScroll: true}));
  },
  /* Move the box up or down the eligible rows in display order. Task order doesn't change, and the draft and focus
     stay. In a sheet or a checklist, the box at the end of the list is already under the last row. Moving onto that
     row highlights it, as a nudge does, and moving down from it changes nothing. */
  boxMove(w, dir, start = null){
    const run = w === 'ins', sheet = w === this.subBoxW, cap = ['cap', 'under'].includes(w) && ['today', 'project'].includes(this.route.name);
    if (!run && !sheet && !cap) return false;
    const sel = run ? '#run-steps > .row[data-id]' : sheet ? '#d-subtasks > .row[data-id]' : '#view .row[data-id], #view .card-head';
    const out = cap && this.boxOut, done = sheet && !this.isStepList ? new Set(this.subList.filter(t => t.done).map(t => String(t.id))) : new Set();
    const rows = [...document.querySelectorAll(sel)].filter(el => {
      if (!cap) return !done.has(el.dataset.id);
      const t = this.tasks[el.dataset.id || el.closest('.day-card')?.dataset.id];
      return this.canAim(t) && !this.leaving[t.id] && !this.lines[t.id] && (!out || !this.listParent(t));
    });
    const id = el => el.dataset.id || el.closest('.day-card')?.dataset.id;
    const at = (cap ? (out ? this.cursor.under ?? this.cursor.id : this.cursor?.id) : run ? this.runBoxAt : this.sheet.subAt) ?? start;
    const i = at == null ? rows.length : rows.findIndex(el => String(at) === id(el));
    const from = !cap && at == null ? rows.length - 1 : i < 0 ? rows.length : i;
    const to = Math.max(0, Math.min(rows.length, from + dir)), el = rows[to];
    if (cap) {
      if (el) { this.aim(this.tasks[id(el)]); if (out) this.boxLevel(true); }
      else this.boxBack();
    } else if (!el) { if (!(run ? this.runBoxEnd : this.sheet.subEnd)) this.footHome(run ? 'run' : 'sheet'); }
    else if (run) {
      const s = this.runView.steps.find(s => String(s.id) === id(el));
      if (s) this.nudgedStep(s);
    } else this.nudgedSub(id(el));
    this.$nextTick(() => {
      if (cap) this.seatBox(); else this.seatFoot(run ? 'run' : 'sheet');
      document.getElementById(cap ? 'capture' : run ? 'run-box' : 'd-subbox')?.scrollIntoView({block: 'nearest'});
    });
    return true;
  },
  /* Positions for n new top-level tasks: after the target task and before its next sibling. Returns null without a
     List view. */
  outPlaces(n){
    const c = this.cursor, t = this.cursorTask, top = t && (c.under != null ? this.tasks[c.under] : t);
    if (!top || !this.view.listView) return null;
    const at = x => (x.pending ? x.position : this.positions[x.id]) || 0, pid = this.view.project?.id;
    const open = (this.view.groups.find(g => g.key === 'open')?.tasks || []).filter(x => !this.listParent(x));
    const sibs = [...open, ...this.pendingTasks.filter(x => !x.child && x.project_id === pid)].map(at);
    return this.clearPlaces(placeAfter(sibs, at(top), n), sibs);
  },
  // Make sure no new task gets a position that a saved or pending task already has, and keep the new tasks before
  // the next sibling.
  clearPlaces(places, sibs){
    const taken = new Set([...Object.values(this.positions), ...this.pendingTasks.map(x => x.position)].filter(p => p > 0));
    const end = Math.min(...sibs.filter(p => p > places.at(-1)));
    return clearOf(places, taken, end === Infinity ? null : end);
  },
  // Make the last new top-level task's pending row the target, with the box staying at the outer level.
  aimAddedOut(entry, i){
    if (i < 0) return;
    const p = entry.items[i].p, id = `pending-${entry.id}-${i}`;
    if (p.done || p.pct >= 100) return;                                  // it leaves with the batch, so the box stays put
    this.light({id, under: null, out: true, wait: {id, pending: true, entry: entry.id, index: i, parent: null, title: p.title, position: p.position || 0}});
  },
  // Whether the add box has focus, at the bottom or in the list.
  get boxHasFocus(){ const el = this.$refs?.capture; return !!el && document.activeElement === el; },
  /* Add a subtask here does by tap what a nudge does by gesture. The box is focused during the tap so the phone
     opens its keyboard. */
  get canAddHere(){ return this.sheet.kind === 'task' && !!this.sheet.task && this.canAim(this.tasks[this.sheet.task.id]); },
  addSubtaskHere(){
    if (!this.canAddHere) return;
    const t = this.tasks[this.sheet.task.id];
    this.closeSheet();
    this.aim(t);
    this.$refs.capture.focus({preventScroll: true});
    this.$nextTick(() => { this.seatBox(); this.$refs.captureBar.scrollIntoView({block: 'center'}); });
  },

  /* ---------- the words quick add read, marked in the box ---------- */
  // Mark the words quick add read, in every line, including done markers and progress. Words of a chip the user
  // tapped off are not marked, nor are assignees who are unknown or can't see the project, because those words stay
  // in the title.
  marks(w){
    if (!this.boxLines(w).length) return [];
    const parsed = this.boxParsedLines(w), target = parsed.length === 1 ? this.boxPid(w) : this.boxPeople(w).target;
    const stays = n => this.userKnown[n.toLowerCase()] === false || (target && this.access[target + ':' + n.toLowerCase()] === false);
    const out = [];
    // Offset each line's highlights past its indent, list marker and spaces.
    this.boxList(w).lines.forEach((l, k) => {
      if (l.mark) out.push({kind: 'done', start: l.mark[0], end: l.mark[1]});
      for (const m of parsed[k]?.marks || []) if (!(m.kind === 'assignees' && stays(m.name))) out.push({...m, start: m.start + l.at, end: m.end + l.at});
    });
    // A step's time ("in 20 min") is read separately and marked like the rest, unless its chip was tapped off.
    const ph = this.isStepBox(w) && !this.box(w).keep && !this.box(w).text.includes('\n') && readStepPhrase(this.box(w).text);
    if (ph) out.push({kind: 'due', start: ph.index, end: ph.index + ph.length});
    return out.sort((a, b) => a.start - b.start);
  },
  // The HTML drawn behind the input, so the highlights line up with the typed words.
  marksHtml(w){
    const text = this.box(w).text;
    let html = '', at = 0;
    for (const m of this.marks(w)) { html += esc(text.slice(at, m.start)) + `<mark data-kind="${m.kind}">${esc(text.slice(m.start, m.end))}</mark>`; at = m.end; }
    return html + esc(text.slice(at)) + '​';                   // the zero-width space keeps a last empty line's height
  },
};
