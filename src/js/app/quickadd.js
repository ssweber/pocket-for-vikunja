// Parse add boxes, suggest people and labels, check project access, and position the box under its target row.
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
  /* Use the same parsing, chips and suggestions for every add box. cap adds tasks, sub and under add subtasks, and
     ins inserts run steps. tname names a template, new: and add: write template steps, and edit changes one. */
  box(w){
    if (w === 'sub') return this.sheet.sub;
    if (w === 'under') return this.cap;
    if (w === 'ins') return this.runInsert;
    if (w === 'tname') return this.sheet.newTpl?.box || {text: ''};
    if (w === 'edit') return this.sheet.stepEdit || {text: ''};
    const [which, key] = w.split(':');
    if (key) return this.stepBox(which);                              // 'new:+', 'add:+': the box a template's steps are written in
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
  /* Keep project names literal in subtask titles because subtasks stay in their parent's project. Checklist steps
     use T# timing instead of parsed dates and have no starting progress, so date and percentage words stay in
     their titles. */
  boxBase(w){
    if (w === 'cap') return {};
    if (!this.isSubBox(w)) return STEP_IGNORE;
    return this.checklistIds.has(this.boxParent(w)?.project_id) ? {...STEP_IGNORE, progress: false} : {project: true};
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
  /* Read list nesting and done markers. Quick add and subtask boxes can create done tasks. Disabling Done keeps a
     single marker in the title or omits done lines from a list. Run and template boxes always omit done lines. */
  readsDone(w){ return w === 'cap' || this.isSubBox(w); },
  /* Cache parsing by text, disabled chips, nesting and quick add mode. Chips, highlights and submission request
     the same data many times during rendering, so compute each part only when first read. */
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
  /* Preserve written nesting by default for pasted lists. Turning Under first line off flattens the list, and
     turning it on again restores nesting. For an unstructured list, turning it on makes the first line its parent.
     Subtask boxes have no nesting chip and keep a trailing colon in the title. */
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
  // A box's first (or only) line; with `all`, ignoring none of the chips tapped off.
  boxParsed(w, all = false){
    const r = this.boxRead(w), k = all ? 'firstAll' : 'first';
    if (r[k]) return r[k];
    const base = this.boxBase(w);
    return r[k] = parseCapture(this.boxLines(w)[0] || '', this.projects, {...this.parseOpts, ignore: all ? base : {...base, ...this.box(w).ignore}});
  },
  get parsed(){ return this.boxParsed('cap'); },
  /* Parse every line, using one project for a pasted quick-add list. Keep each line's done state and parent index.
     Remove a parent's explicit progress because its subtasks determine the figure. */
  boxParsedLines(w){
    const r = this.boxRead(w);
    if (r.lines) return r.lines;
    const list = this.boxList(w).lines, lines = list.map(l => l.text), first = this.boxParsed(w);
    const parsed = w === 'cap' ? (lines.length > 1 ? this.parseList(lines, first).parsed : [first])
      : lines.map((l, i) => i ? parseCapture(l, this.projects, {...this.parseOpts, ignore: this.boxBase(w)}) : first);
    const parents = new Set(list.map(l => l.under));
    return r.lines = parsed.map((p, i) => ({...p, done: !!list[i]?.done, under: list[i]?.under ?? null, ...parents.has(i) && {pct: 0}}));
  },
  // Preserve each parsed line's original text, done marker and parent index so rejected entries can return to the
  // box.
  boxItems(w){
    const lines = this.boxLines(w), remind = this.remindOn(w, lines);
    return this.boxParsedLines(w).map((p, i) => ({raw: p.done ? 'x ' + lines[i] : lines[i], p: {...p, remind}, under: p.under}));
  },
  /* Use the first +project anywhere in a pasted list for every line. Keep other project names in their titles.
     Return {parsed, project, miss}, reusing first when it was already parsed. */
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
  /* Explain each box's syntax while empty. Template names assign the checklist, steps assign their own work and
     parse timing, and subtask boxes omit project selection and checklist dates. */
  boxHint(w){
    const p = this.prefixes;
    if (!p) return 'Quick add shortcuts are turned off in your Vikunja settings';
    const tags = `${p.label}label  !1–5`;
    if (w === 'tname') return `${p.assignee}user: who its checklists are for  ${tags} · a due date and Repeats are set after creating it`;
    if (w === 'ins') return `${p.assignee}user: who does it  ${tags} · a pasted list is a step a line`;
    if (this.isStepBox(w)) return `${p.assignee}user: who does it  ${tags} · “in 20 min”: due 20 minutes after the previous step`;
    const base = this.boxBase(w), dates = base.due ? 'dates stay as words in a checklist project' : 'tomorrow · fri at 2 · Oct 12 · every week';
    return `${base.project ? '' : p.project + 'project  '}${p.label}label  ${p.assignee}user  !1–5  ${dates} · tap a chip to undo it`;
  },
  /* Show unsupported dates and project names as muted chips so people can see that those words remain literal. Run
     step timing is parsed separately. */
  ignoredChips(w, line){
    const base = this.boxBase(w), out = [];
    if (!base.due && !base.project) return out;
    const ph = this.isStepBox(w) && readStepPhrase(line), rest = ph ? line.slice(0, ph.index) + line.slice(ph.index + ph.length) : line;
    const raw = parseCapture(rest, this.projects, {...this.parseOpts, ignore: {}});
    if (base.due && (raw.due || raw.repeat)) out.push({key: 'ign-d', cls: 'quiet', text: w === 'tname' ? 'Dates stay in its name: a due date and Repeats are set after creating it'
      : w === 'ins' ? 'Dates stay as words: a step added to a checklist has no time' : this.isSubBox(w) ? 'Dates stay as words here: a subtask in a checklist project may become a step'
      : 'Dates stay as words: a step is due a time after the one before, like “in 20 min”'});
    if (base.project && (raw.project || raw.projectMiss)) out.push({key: 'ign-p', cls: 'quiet', text: this.isSubBox(w) ? `${this.prefixes.project}project stays as words: a subtask goes in its task's project`
      : `${this.prefixes.project}project stays as words: a checklist's steps are in its project`});
    return out;
  },

  /* ---------- @username: who can see the task's project ---------- */
  /* Find the target project and mentioned users for a task or pasted list before checking access. */
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
  /* Return {auto, warn} from known access. Quick add can choose one project all mentioned users can see when no
     project was typed and the default is inaccessible. Warn about users who cannot access the target. */
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
  /* Suggest people with access to the target project first, then others who share your projects. Hide suggestions
     for an exact match so the parsed chips appear. */
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
    // Outline suggestions to distinguish them from parsed chips. Enter accepts the first suggestion.
    if (out.length) Object.assign(out[0], {text: out[0].text + '  ↵', hint: out[0].hint + ', or press Enter'});
    return out.length ? out.slice(0, 6) : null;
  },
  useSuggestion(w, tk, name){
    const b = this.box(w), word = tk.prefix + (/\s/.test(name) ? `"${name}"` : name) + ' ', el = this.boxEl(w);
    const text = b.text = el.value = b.text.slice(0, tk.start) + word + b.text.slice(tk.end).replace(/^ /, '');
    // Set text and cursor synchronously so fast typing does not insert letters before the completed suggestion.
    const at = b.caret = Math.min(tk.start + word.length, text.length);
    el.focus(); el.setSelectionRange(at, at);
  },
  /* Load project access in the background, including teams and inherited shares. Use it for assignee checks and
     private-project claim slots, and cache seenBy on the phone. force reloads access. Skip tokens without Projects
     → Users search. */
  async loadPeople(force = false){
    if ((this.people && !force) || this.accessBlocked) return;
    if (peopleLoading) return peopleLoading;
    peopleLoading = (async () => {
      // Do not request after Vikunja's web app signs out. A background request could renew the cookie session
      // before Pocket notices.
      const gone = () => this.mode === 'session' && !sharedToken.get();
      const projs = this.projects.filter(p => p.id > 0), get = p => gone() ? null : api(`/projects/${p.id}/users/search`).then(items).catch(e => {
        if (e instanceof ApiError && e.status === 403) this.accessBlocked = true;
        return null;
      });
      const first = projs.length ? await get(projs[0]) : [];                    // try one project first so a token without permission stops here
      if (this.accessBlocked) return;
      const lists = [first, ...await inBatches(projs.slice(1), 4, get)], byName = new Map();
      // Clear old access for this project so removed shares do not remain allowed.
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
  // Refresh project access after PEOPLE_AGE in the background with the other screens.
  refreshPeople(){ return !this.people || Date.now() - peopleAt > PEOPLE_AGE ? this.loadPeople(true).catch(() => {}) : null; },

  /* Enter accepts the first active suggestion, or submits the box. A template name advances to its steps box, and
     editing a step saves it. */
  boxEnter(w){
    const tk = this.boxToken(w), sg = tk?.q && this.suggestions(w);
    if (sg?.length) { sg[0].action(); return; }
    if (w === 'tname') document.getElementById('d-subin')?.focus();
    else if (w === 'edit') this.boxEl(w)?.blur();
    else this.boxSend(w);
  },
  // Send according to the box's role. Quick add creates tasks, subtask boxes attach to their parent, and run or
  // template boxes add steps.
  boxSend(w){ return w === 'cap' ? this.submitCapture() : w === 'ins' ? this.insertStep() : w.includes(':') ? this.sendSteps(w.split(':')[0]) : this.addSubtasks(w); },
  // Parse a template name or step while respecting disabled chips. Step timing is parsed separately.
  stepParsed(text, ignore){ return parseCapture(text || '', this.projects, {...this.parseOpts, ignore: {...STEP_IGNORE, ...ignore}}); },
  // Whether what's sent from a box gets a reminder at its due time: one line, with a time, and the 🔔 chip on.
  remindOn(w, lines){ const p = this.boxParsed(w); return this.box(w).remind && lines.length === 1 && !!p.due && p.due > new Date() && !!p.timeRead && this.remindersReach; },
  // Run a chip's action or toggle whether its words are parsed. Disabled words remain in the title.
  tapChip(w, c){
    const b = this.box(w);
    if (c.action) c.action(); else if (c.kind) b.ignore = {...b.ignore, [c.kind]: !b.ignore?.[c.kind]};
  },
  /* Build chips from parsed input. Subtask boxes omit the project, photos and list-nesting chip. */
  chips(w){
    const b = this.box(w), cap = w === 'cap';
    // Photos for the new task, each with a tap to take it off again. A pasted list puts them on its first task.
    const photos = !cap ? [] : this.capPhotos.map((f, i) => ({key: 'ph' + i, cls: 'photo', icon: 'clip', hint: 'Tap to remove this photo',
      text: f.name + (this.capLines.length > 1 ? ' · on the first task' : '') + '  ✕', action: () => this.capPhotos.splice(i, 1)}));
    if (!b.text.trim()) return photos;
    const sg = this.suggestions(w);
    if (sg) return sg;
    /* For one line, disabling Done keeps the marker in the title. For a list, the chip counts done lines and
       toggles whether they are included. Run and template boxes omit those lines without a toggle. */
    const list = this.boxList(w), ticked = list.ticked, left = !!b.ignore?.done;
    // A list's name, one #, as a project's copy starts with: left out, and said so.
    if (list.names.length) photos.push({key: 'nm', cls: 'quiet', text: list.names.length === 1 ? 'The # line is the list’s name: left out' : `${list.names.length} # lines are list names: left out`});
    if (ticked && !this.readsDone(w)) photos.push({key: 'tk', text: `${ticked} line${ticked === 1 ? '' : 's'} ticked off already: left out`});
    else if (ticked && list.one) photos.push({key: 'tk', kind: 'done', text: 'Done', off: left});
    else if (ticked) photos.push({key: 'tk', kind: 'done', text: left ? `${ticked} ticked off already: left out` : `${ticked} arrive${ticked === 1 ? 's' : ''} done`,
      hint: left ? `Tap to add ${ticked === 1 ? 'it' : 'them'}, done` : `Tap to leave ${ticked === 1 ? 'this line' : 'these lines'} out`});
    const parsed = this.boxParsed(w), p = cap && this.projById.get(parsed.project?.id || this.defaultProjectId()), out = [], n = list.lines.length;
    out.push(...photos);
    // A pasted list: how many, where they go, and anyone in it who can't see that project, before it's sent.
    const listWarn = () => this.accessHints(w).warn.map((text, i) => ({key: 'w' + i, cls: 'warn', text}));
    if (n > 1 && !cap) { out.push({key: 'n', text: `${n} ${this.isSubBox(w) ? 'subtasks' : 'steps'}`}, ...listWarn()); return out; }
    if (n > 1) {
      // What it makes: "1 task + 3 subtasks", the lines that are under another counted as subtasks.
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
    // Offer a reminder only for an explicit future time and when Vikunja can send reminder emails. The chip starts
    // off.
    if (all.due && all.timeRead && all.due > new Date() && !off('due') && this.remindersReach) out.push({key: 'rem', kind: 'remind', cls: 'toggle', pressed: b.remind,
      text: '🔔 Remind me', hint: b.remind ? 'Tap for no reminder' : 'Tap to have Vikunja email you a reminder at this time', action: () => { b.remind = !b.remind; }});
    if (all.repeatWarn) out.push({key: 'rw', cls: 'warn', text: `Vikunja can't repeat “${all.repeatWarn}”: it stays in the title`});
    if (all.repeat) out.push({key: 'rep', kind: 'repeat', text: '↻ ' + all.repeat.label + (all.dueFromRepeat ? ', from ' + all.dueLabel : ''), off: off('repeat')});
    if (all.priority) out.push({key: 'prio', kind: 'priority', text: 'Priority ' + all.priority, off: off('priority')});
    // Its own progress, from a figure at its end; 100% is done.
    if (all.pct) out.push({key: 'pct', kind: 'progress', cls: 'num', text: all.pct < 100 ? all.pct + '%' : '100%: done', off: off('progress')});
    all.labels.forEach((l, i) => out.push({key: 'l' + i, kind: 'labels', text: this.prefixes.label + l, off: off('labels')}));
    all.assignees.forEach((u, i) => out.push({key: 'a' + i, kind: 'assignees', text: this.prefixes.assignee + u, off: off('assignees')}));
    warn.forEach((text, i) => out.push({key: 'w' + i, cls: 'warn', text}));
    out.push(...this.ignoredChips(w, this.boxLines(w)[0] || ''));
    // A step being changed: the people and labels it has, to tap off it.
    if (w === 'edit') out.push(...this.stepHasChips());
    const to = this.boxPid(w);
    if (this.boxIn && (w === 'under' || w === 'cap') && !this.cursorListView) out.push({key: 'noplace', cls: 'quiet', text: 'This project has no List view in Vikunja: what you add goes last'});
    if (to && !this.canWrite(to)) out.push({key: 'ro', cls: 'warn', text: `${this.projById.get(to)?.title || 'This project'} is shared with you to read only: it can't be added to`});
    return out;
  },

  /* ---------- what quick add's box adds to, on a project's list ---------- */
  /* A nudge or Add a subtask here selects the highlighted row for quick add. New subtasks become the target so
     each follows the last. cursor records {id, under}, plus wait for a pending row. If the target leaves, select
     its parent or return to adding tasks. Tapping the bottom placeholder, scrolling the target away or leaving the
     screen returns the box to the bottom. Ordinary taps and progress gestures do not move the box. */
  // Allow writable open tasks on Today or a project list, including marked rows still waiting for the batch. Runs,
  // their steps and templates use their own add boxes.
  canAim(t){
    const on = this.route.name;
    return !!t && (on === 'project' || on === 'today') && !t.pending && (!t.done || !!this.leaving[t.id]) && this.canWrite(t.project_id) && !this.isRunTask(t) && !this.stepRun(t)
      && !(this.checklistIds.has(t.project_id) && hasTemplateLabel(t)) && !this.deleting.includes(t.id) && (this.onList(t) || (on === 'today' && !!this.listParent(t)));
  },
  // In the screen's list as a row or a card of its own: a project's open tasks, any of Today's groups.
  onList(t){ const today = this.route.name === 'today'; return this.view.groups.some(g => (today || g.key === 'open') && g.tasks.includes(t)); },
  /* Set the target and index its highlight by id. Moving the highlight redraws only the old and new rows. */
  light(c){
    const was = this.cursor;
    if (c && was && was.id === c.id && was.under === c.under && !was.wait === !c.wait && !was.out === !c.out) return;
    for (const id of Object.keys(this.lit)) if (!c || String(c.id) !== id) delete this.lit[id];
    if (c) this.lit[c.id] = true;
    this.cursor = c;
  },
  // Select a task as the target, or clear the target if the task is ineligible.
  aim(t){ this.light(this.canAim(t) ? {id: t.id, under: this.listParent(t)?.id ?? null} : null); },
  /* Follow the last new direct subtask on its pending row immediately so the next entry follows it. A subtask
     created done will leave with the batch, so keep the parent as the target. */
  aimAdded(entry, i, parent){
    const p = entry.items[i].p, id = `pending-${entry.id}-${i}`;
    if (p.done || p.pct >= 100) return this.aim(parent);
    this.light({id, under: parent.id, wait: {id, pending: true, entry: entry.id, index: i, parent: parent.id, title: p.title, position: p.position || 0}});
  },
  /* Transfer the target from a pending row to its saved task. If creation was rejected and the entry is gone,
     select its parent. */
  aimSent(tasks){
    const c = this.cursor, w = c?.wait;
    if (!w) return;
    const t = tasks.find(x => x.was === w.id);
    if (t) this.light({id: t.id, under: c.under, ...(c.out && {out: true})});
    else if (!sync.all(this.user?.id).some(e => e.id === w.entry)) this.aim(this.tasks[c.under]);
  },
  // Cancelling the target selects its parent. Cancelling an earlier line adjusts the pending target's index and
  // id.
  aimCancelled(entry, index){
    const c = this.cursor, w = c?.wait;
    if (w?.entry !== entry || w.index < index) return;
    if (w.index === index) return this.aim(this.tasks[c.under]);
    const id = `pending-${entry}-${w.index - 1}`;
    this.light({...c, id, wait: {...w, id, index: w.index - 1}});
  },
  /* Select the parent when the target leaves the list, or clear the target if no parent remains. Reordering keeps
     the target and makes the next entry follow its new position. Check after a sheet closes so temporary changes
     inside it do not move the box. */
  keepAim(){ const c = this.cursor; if (c && !this.cursorTask) this.aim(this.tasks[c.under]); },
  /* A nudge selects an eligible visible row and gives feedback when the target changes. Ignore marked rows,
     messages and pending rows. On a run screen, select the step on the card and move the add box under its row,
     keeping one current step. */
  nudged(id){
    const run = this.route.name === 'run', row = document.querySelector(`#view :is(.row, .day-card)[data-id="${id}"]`);
    const t = run ? this.runAim && this.runView.steps.find(s => String(s.id) === String(id)) : this.tasks[id];
    if (!row || (run ? !t : this.leaving[id] || this.lines[id] || !this.canAim(t))) return;
    const r = row.getBoundingClientRect(), top = Math.max(0, this.$refs.header?.getBoundingClientRect().bottom || 0);
    const home = document.getElementById('cap-home'), foot = home?.offsetHeight ? home : this.$refs.captureBar;   // the box's place at the bottom
    if (r.bottom <= top || r.top >= (run ? innerHeight : foot?.getBoundingClientRect().top ?? innerHeight)) return;   // (a run's screen has no bar there)
    if ((run ? this.runView.step?.id : this.cursor?.id) !== t.id && NUDGE_TICK) haptic('tick');
    if (run) { this.showStep(t.i); this.nudgedStep(t); } else this.aim(t);
  },
  // The task a row is under on this list, if it's there.
  listParent(t){
    const ids = t.parent ? [t.parent] : (t.related_tasks?.parenttask || []).map(x => x.id);
    return ids.map(id => this.tasks[id]).find(p => p && this.onList(p)) || null;
  },
  // The cursor's row, if it can still be one: a task's, or the waiting row of a subtask added under one that can.
  get cursorTask(){
    const c = this.cursor;
    if (!c) return null;
    // (A task added from the box out a level, waiting: under no task, on this project's list.)
    if (c.wait) return (c.under == null ? !!c.out && this.route.name === 'project' : this.canAim(this.tasks[c.under])) ? c.wait : null;
    const t = this.tasks[c.id];
    return this.canAim(t) ? t : null;
  },
  // The task the box's subtasks go under: the cursor's, or the cursor itself.
  get cursorParent(){ const t = this.cursorTask; return t && (this.listParent(t) || t); },
  // Which box quick add's is: adding a task, subtasks to the cursor, or on a run's screen, steps.
  // (Out a level, in the list still, it adds a task again: boxOut.)
  get capW(){ return this.route.name === 'run' ? 'ins' : this.cursorTask && !this.cursor.out ? 'under' : 'cap'; },
  // Keep the run's input separate from quick add so switching screens does not mix drafts.
  get capBox(){ return this.box(this.capW); },
  /* Name the parent and the subtask new entries follow. Without a List view, name only the parent because new
     subtasks go last. On a run, name the insertion point and the card's saved step that Repeat copies. */
  get capTarget(){
    if (this.capW === 'ins') return null;                              // a run's screen has its own box, under its steps (list-box.html)
    const t = this.cursorTask, p = this.cursorParent;
    return t && !this.cursor.out ? {to: p.title, after: t !== p && this.cursorListView ? t.title : ''} : null;
  },
  get capPlaceholder(){ return this.cursorTask ? (this.cursor.out ? 'Task' : 'Subtask') : this.capHomeSays; },   // in the list, its place says the rest
  // Use the same empty-box text in the bottom placeholder so its tap destination is clear and its height stays
  // stable.
  get capHomeSays(){
    if (this.capPhotos.length) return 'What\'s this photo for?';
    return this.route.name === 'project' && this.view.project ? 'Add a task to ' + this.view.project.title : 'Add a task';
  },
  // The same, to a screen reader, said as it changes.
  get capTargetText(){
    const c = this.capTarget;
    return !c ? '' : c.step ? `Add a step after “${c.after}”` : `Add a subtask to ${c.to}${c.after ? ', after ' + c.after : ''}`;
  },
  /* Use the project's List view for new positions. On Today, use the target project's view loaded with its card,
     so added subtasks appear in the same order in the project. */
  get cursorListView(){
    if (this.route.name === 'project') return this.view.listView;
    const p = this.cursorParent;
    return p ? listViewOf(this.projById.get(p.project_id))?.id || null : null;
  },
  /* Place n subtasks after the target subtask, or before the first subtask when targeting the parent. Include
     saved, newly sent and pending subtasks in the order. Return null without a List view. */
  cursorPlaces(n){
    const t = this.cursorTask, p = this.cursorParent;
    if (!this.cursorListView) return null;
    const at = x => (x.pending ? x.position : this.positions[x.id]) || 0;
    const listed = (this.view.groups.find(g => g.key === 'open')?.tasks || []).filter(x => parentIds(x).includes(p.id));
    const ids = new Set([...(p.related_tasks?.subtask || []), ...listed].map(x => x.id));
    const sibs = [...[...ids].map(id => this.positions[id] || 0), ...this.pendingTasks.filter(x => x.parent === p.id).map(at)];
    return this.clearPlaces(t !== p ? placeAfter(sibs, at(t), n) : placeFirst(sibs, n), sibs);
  },
  /* Return an unfocused box to the bottom when its target scrolls away. Until a newly added target has been
     visible once, watch the previous target instead, so typing can continue before the new row appears. */
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
  /* Position the existing add box under its target without removing the input from the page, preserving text and
     focus. Reserve its height under the row and keep a dashed placeholder at the bottom. seatUnder follows row
     movement, and clearing the target returns the box to the bottom. */
  seatBox(){
    const bar = this.$refs.captureBar, root = document.documentElement;
    if (!bar) return;
    let key = '', inset = '';
    seatUnder(seats.bar, {
      box: () => bar, cls: 'boxed', prop: () => [root, '--box-h'], patience: 0, scrollBack: h => scrollBy(0, -h),
      // The cursor's row, as boxSeat names it: the one it had, while that's still on the page and the same.
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
        b.classList.toggle('out', !!s?.out);                              // a task's box: its tick is the bigger (styles.css, --mark)
        if (changed || !inset) inset = s?.out ? '14px' : Math.round(parseFloat(getComputedStyle(el).paddingLeft) + (s?.deeper ? parseFloat(getComputedStyle(root).getPropertyValue('--sub-in')) || 30 : 0)) + 'px';
        const r = el.getBoundingClientRect(), list = (el.closest('.list') || el).getBoundingClientRect();
        return [Math.round(r.bottom + scrollY), Math.round(list.left + scrollX), Math.round(list.width), inset].join();
      },
      apply: (b, at) => { const [top, left, width, pad] = at.split(','); b.style.top = top + 'px'; b.style.left = left + 'px'; b.style.width = width + 'px'; b.style.paddingLeft = pad; },
      unplace: b => { b.classList.remove('out'); b.style.top = b.style.left = b.style.width = b.style.paddingLeft = ''; },
    });
  },
  /* Return {key, sel, out, deeper} for the box's target row or top-level item on Today and project lists. Run
     screens use their own box at the foot of the step list. */
  get boxSeat(){
    if (!this.boxIn) return null;
    const c = this.cursor, out = !!c.out, id = String(out ? c.under ?? c.id : c.id);
    return {key: id + (out ? ':out' : ':in'), out, deeper: !c.under,
      sel: out ? `#view .item[data-id="${id}"]` : `#view .day-card[data-id="${id}"] > .card-head, #view .row[data-id="${id}"]`};
  },
  // Whether the box is in the list, on any screen; and back at the bottom, by a tap on its place there.
  get boxInList(){ return !!this.boxSeat; },
  boxBack(){ this.light(null); },
  get boxBackLabel(){
    const on = this.route.name;
    return on === 'today' ? 'Add a task instead' : 'Add a task to ' + (this.view.project?.title || 'this project') + ' instead';
  },
  /* Moving the box out one level adds tasks after the target task and its subtasks. Each new task becomes the
     target, still at that level. Moving back in adds subtasks, once the target task has been sent. */
  get boxIn(){ return ['project', 'today'].includes(this.route.name) && !!this.cursorTask; },
  // Only a project's list has two levels: Today adds subtasks only (part 3).
  get canLevel(){ return this.boxIn && this.route.name === 'project'; },
  get boxOut(){ return this.boxIn && !!this.cursor.out; },
  get canIn(){ const c = this.cursor; return !!c && !(c.wait && c.under == null); },
  boxLevel(out){
    const c = this.cursor;
    if (!this.canLevel || out === !!c.out || (!out && !this.canIn)) return false;
    this.light({...c, out});
    return true;
  },
  // Use Tab and Shift+Tab to change nesting only when another level is available. At either limit, keep normal
  // keyboard focus navigation.
  boxTab(e){ if (this.boxLevel(e.shiftKey)) e.preventDefault(); },
  // A row's shortcut moves the add box and focuses its field so the next press acts on the box too.
  rowBox(t, g, dir, e){
    if (e.ctrlKey || e.metaKey || e.isComposing || inTextField(e.target) || g.own || g.top || g.locked) return;
    const w = g.sheet ? this.subBoxW : g.run ? (this.runAim ? 'ins' : '') : this.capW;
    if (!w || !this.boxMove(w, dir, t.id)) return;
    e.preventDefault();
    this.$nextTick(() => this.boxEl(w)?.focus({preventScroll: true}));
  },
  /* Walk the box through eligible rows in display order without changing task order. Keep the draft and focus.
     At a sheet's or checklist's foot, the last row is already the box's target. */
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
    } else if (!el || to === rows.length - 1) this.footHome(run ? 'run' : 'sheet');
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
  /* Place n top-level tasks after the target task and before its next sibling. Return null without a List view. */
  outPlaces(n){
    const c = this.cursor, t = this.cursorTask, top = t && (c.under != null ? this.tasks[c.under] : t);
    if (!top || !this.view.listView) return null;
    const at = x => (x.pending ? x.position : this.positions[x.id]) || 0, pid = this.view.project?.id;
    const open = (this.view.groups.find(g => g.key === 'open')?.tasks || []).filter(x => !this.listParent(x));
    const sibs = [...open, ...this.pendingTasks.filter(x => !x.child && x.project_id === pid)].map(at);
    return this.clearPlaces(placeAfter(sibs, at(top), n), sibs);
  },
  // Avoid positions already used by saved or pending tasks while keeping the new tasks before the next sibling.
  clearPlaces(places, sibs){
    const taken = new Set([...Object.values(this.positions), ...this.pendingTasks.map(x => x.position)].filter(p => p > 0));
    const end = Math.min(...sibs.filter(p => p > places.at(-1)));
    return clearOf(places, taken, end === Infinity ? null : end);
  },
  // Follow the last new top-level task on its pending row, keeping the box at the outer level.
  aimAddedOut(entry, i){
    if (i < 0) return;
    const p = entry.items[i].p, id = `pending-${entry.id}-${i}`;
    if (p.done || p.pct >= 100) return;                                  // it leaves with the batch: the box stays where it is
    this.light({id, under: null, out: true, wait: {id, pending: true, entry: entry.id, index: i, parent: null, title: p.title, position: p.position || 0}});
  },
  // Whether the box at the bottom, or in the list, is being typed in.
  get boxHasFocus(){ const el = this.$refs?.capture; return !!el && document.activeElement === el; },
  /* Add a subtask here is the tap alternative to a nudge. Focus the box during the tap so the phone opens its
     keyboard. */
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
  // Highlight parsed words across every line, including done markers and progress. Leave disabled chips and
  // inaccessible or unknown assignees unmarked because those words stay in the title.
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
    // A step's time, read on its own ("in 20 min"), marked like the rest, unless its chip was tapped off.
    const ph = this.isStepBox(w) && !this.box(w).keep && !this.box(w).text.includes('\n') && readStepPhrase(this.box(w).text);
    if (ph) out.push({kind: 'due', start: ph.index, end: ph.index + ph.length});
    return out.sort((a, b) => a.start - b.start);
  },
  // Draw the highlights behind the input so they align with the typed words.
  marksHtml(w){
    const text = this.box(w).text;
    let html = '', at = 0;
    for (const m of this.marks(w)) { html += esc(text.slice(at, m.start)) + `<mark data-kind="${m.kind}">${esc(text.slice(m.start, m.end))}</mark>`; at = m.end; }
    return html + esc(text.slice(at)) + '​';                   // the zero-width space keeps a last empty line's height
  },
};
