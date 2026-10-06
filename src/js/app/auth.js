// Signing in and out, and following the sign-in Pocket shares with Vikunja's web app.
import {cache, esc, store, taskDrafts, userCache} from '../util.js';
import {api, ApiError, errText, INSTALLED, NetError, netHelp, seenToken, setSeenToken, sharedToken} from '../api.js';
import {sync} from '../sync.js';
import {saved} from '../lists.js';

let confirming = null;                           // app.confirmAccount() while it runs

export default {
  get passwordAllowed(){ const a = this.info?.auth || {}; return !!(a.local?.enabled || a.ldap?.enabled); },
  // Single sign-on providers Vikunja offers (Cloudron's login shows up here), from /info.
  get providers(){ const o = this.info?.auth?.openid_connect; return o?.enabled ? o.providers || [] : []; },
  // Follow the shared session: adopt one that appeared (a sign-in finished) and sign out when Vikunja did.
  sessionChanged(){
    if (this.mode === 'token' && this.signedIn) return;                     // an API token doesn't follow Vikunja's sign-in
    const t = sharedToken.get();
    if (t && !this.signedIn) {
      this.mode = 'session'; store.set('mode', 'session');
      try { this.ssoWindow?.close(); } catch {}
      this.ssoWindow = null; this.login.waiting = false;
      this.boot();
    } else if (!t && this.signedIn && this.mode === 'session') {
      // Vikunja can clear the token for a moment while it renews it, so only a sign-out that lasts counts.
      clearTimeout(this.signOutCheck);
      this.signOutCheck = setTimeout(() => {
        if (!sharedToken.get() && this.signedIn && this.mode === 'session') this.signOut('You signed out in Vikunja.', {tellServer: false});
      }, 2000);
    } else if (t && t !== seenToken && this.signedIn && this.mode === 'session' && this.user) {
      // A new token is usually Vikunja renewing the session, but it can be someone else signing in on Vikunja's web
      // app before Pocket saw the sign-out. Then Pocket starts over as them. Until it knows, no change is sent (see
      // api), and if it can't find out now, the next change, or try to send what's waiting, asks again.
      clearTimeout(this.whoCheck);
      this.whoCheck = setTimeout(() => this.confirmAccount().then(same => same && this.flush(), () => {}), 300);
    }
  },
  // Whether the shared session is still this person's, asking Vikunja if the token changed since Pocket last checked.
  // If it's someone else's, Pocket starts over as them. Throws if Vikunja can't be asked.
  confirmAccount(){
    return confirming ||= (async () => {
      try {
        for (;;) {
          const t = sharedToken.get();
          if (t === seenToken) return true;
          const was = this.user?.id, u = await api('/user');
          if (sharedToken.get() !== t) continue;                              // changed again meanwhile: ask again
          setSeenToken(t);
          if (was && u.id !== was && this.user?.id === was) { this.switchAccount(); return false; }
          return true;
        }
      } finally { confirming = null; }
    })();
  },
  // Forget the last person's lists, caches and open task, and load the new person's. What they left waiting stays in
  // the outbox, under their name, to be sent when they're back.
  switchAccount(){
    saved.clear(); this.forgetPeople(); this.dropSheet();
    this.user = null; this.pending = []; this.cap.text = ''; this.capPhotos = [];
    this.boot();
  },
  // Close the sheet without saving anything written in it: dropped, for the next person on this device, or with keep,
  // kept on the phone for when the same person is back.
  dropSheet(keep = false){
    const sh = this.sheet, t = sh.task;
    if (keep && sh.open && sh.kind === 'task' && t) {
      if (sh.editingDesc) taskDrafts.set('desc:' + t.id, sh.descDraft);
      taskDrafts.set('comment:' + t.id, sh.commentDraft); taskDrafts.set('sub:' + t.id, sh.sub.text);
    }
    Object.assign(this.sheet, {editingDesc: false, commentDraft: '', task: null, newTpl: null}); this.closeSheet(true);
  },
  forgetPeople(drafts = true){
    if (drafts) { this.runDrafts = {}; taskDrafts.clear(); store.del('drafts.user'); }
    cache.clear(); userCache.clear(); this.access = {}; this.userKnown = {}; this.accessBlocked = false; this.people = null;
    this.labels = []; this.labelsLoaded = false;
  },
  /* Single sign-on goes through Vikunja: the provider only returns to Vikunja's /auth/openid/<key> page, which finishes
     signing in and saves the session where Pocket reads it. This is the same request Vikunja's login page makes. */
  signInWith(p){
    const state = Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem('state', state); } catch {}
    const url = `${p.auth_url}?client_id=${encodeURIComponent(p.client_id)}&redirect_uri=${encodeURIComponent(`${location.origin}/auth/openid/${p.key}`)}`
      + `&response_type=code&scope=${encodeURIComponent(p.scope)}&state=${state}`;
    // A browser tab signs in in a new tab and picks the session up by itself; a home-screen app stays in one window
    // and picks it up when you come back to it.
    const w = !INSTALLED && window.open(url, '_blank');
    if (w) { this.ssoWindow = w; this.login.waiting = true; this.login.err = ''; }
    else location.href = url;
  },
  showLogin(err){
    this.screen = 'login';
    this.login.err = err || '';
  },
  // Signing out of a shared session signs this device out of Vikunja's web app too.
  signOut(msg, {tellServer = true} = {}){
    const me = this.user?.id;
    // Signing out yourself drops the saved lists and anything still waiting to be sent (after asking).
    if (!msg) {
      const mine = sync.all(me);
      const tasks = mine.flatMap(e => e.items.filter(x => !x.taskId)), files = mine.flatMap(e => (e.files || []).filter(f => !f.sent));
      const count = (n, word) => n === 1 ? 'a ' + word : `${n} ${word}s`;
      const runs =mine.filter(e => e.kind === 'run' || e.kind === 'act').length, n = tasks.length + files.length + runs;
      const what = [tasks.length && count(tasks.length, 'task'), files.length && count(files.length, files.every(f => /^image\//.test(f.type)) ? 'photo' : 'file'),
        runs && (runs === 1 ? 'a change to a run' : runs + ' changes to runs')].filter(Boolean).join(' and ');
      if (n && !confirm(`${what[0].toUpperCase() + what.slice(1)} ${n === 1 ? 'hasn\'t' : 'haven\'t'} reached Vikunja yet. Sign out anyway and drop ${n === 1 ? 'it' : 'them'}?`)) return;
      sync.drop(e => e.user === me);
      this.pending = [];
    }
    saved.clear();
    if (this.mode === 'session') {
      const t = sharedToken.get();
      if (tellServer && t) fetch(this.server + '/api/v2/logout', {method:'POST', credentials:'include', headers: {Authorization: 'Bearer ' + t}}).catch(() => {});
      sharedToken.del();
    }
    this.token = ''; this.signedIn = false; this.user = null; this.mode = 'session';
    store.del('token'); store.del('mode');
    // A sign-out you chose drops what was being written. A session that ended, or a sign-out in Vikunja's web app, keeps
    // it on the phone for when you're back (boot): someone else signing in starts without it.
    const keep = !!msg && !!me;
    this.dropSheet(keep); this.forgetPeople(!keep);
    if (keep) store.set('drafts.user', String(me));
    this.showLogin(msg ? esc(msg) : '');
    if (!this.info) this.probe();
  },
  async busy(fn){ this.login.busy = true; try { return await fn(); } finally { this.login.busy = false; } },
  // Ask Vikunja which sign-in methods it offers.
  async probe(){ await this.busy(async () => {
    this.login.err = '';
    try {
      this.info = await api('/info', {auth:false});
      this.login.showTotp = !!this.info.totp_enabled;
      this.login.method = this.passwordAllowed ? 'session' : 'token';
      this.$nextTick(() => (this.passwordAllowed ? this.$refs.inUser : this.$refs.inToken)?.focus());
    } catch (err) {
      this.login.err = err instanceof NetError ? netHelp() : `Vikunja didn't answer as expected (${errText(err)}).`;
    }
  }); },
  async submitPassword(){ await this.busy(async () => {
    this.mode = 'session';
    try {
      const body = {username: this.login.user.trim(), password: this.login.pass, long_token: true};
      const totp = this.login.totp.trim(); if (totp) body.totp_passcode = totp;
      const j = await api('/login', {method:'POST', body, auth:false});           // also sets Vikunja's refresh cookie
      sharedToken.set(j.token); store.set('mode', 'session'); store.del('token');
      this.login.pass = ''; this.login.totp = '';
      await this.boot();
    } catch (err) {
      if (err.code === 1017) { this.login.showTotp = true; this.$nextTick(() => this.$refs.inTotp.focus()); }
      this.login.err = err.code === 1017 ? 'Enter your two-factor code.' : errText(err);
    }
  }); },
  async submitToken(){ await this.busy(async () => {
    this.mode = 'token'; this.token = this.login.token.trim();
    try {
      await api('/user', {retry:false});
      store.set('token', this.token); store.set('mode', 'token'); this.login.token = '';
      await this.boot();
    } catch (err) {
      this.token = ''; this.mode = 'session';
      this.login.err = err instanceof NetError ? netHelp() : 'That token didn\'t work. Check it hasn\'t expired and has “User” (under Other) ticked.';
    }
  }); },

  async boot(){
    this.screen = 'app'; this.signedIn = true;
    Object.assign(this.view, {loading: true, error: '', bootFailed: false, route: null});
    // What's waiting, from the phone's database. Not for long, though: another tab with an older Pocket can hold it up.
    await Promise.race([sync.ready, new Promise(ok => setTimeout(ok, 3000))]);
    sync.ready.then(() => this.refreshPending());
    try {
      const [user, info] = await Promise.all([api('/user'), this.info ? Promise.resolve(this.info) : api('/info', {auth:false}).catch(() => null)]);
      this.user = user; this.info = info;
      // What was being written when a session ended is kept for the same person only.
      const owner = store.get('drafts.user');
      if (owner && owner !== String(user.id)) { taskDrafts.clear(); this.runDrafts = {}; }
      store.del('drafts.user');
      if (this.mode === 'session') setSeenToken(sharedToken.get());             // whose session this is, checked
      saved.set('user', user); if (info) saved.set('info', info);
      await this.loadProjects();
      this.refreshPending();
      await this.render();
      this.flush();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      // Offline: carry on with what was loaded last time, if anything was.
      if (e instanceof NetError && saved.get('user')) {
        this.user = saved.get('user'); this.info = this.info || saved.get('info');
        this.setProjects(saved.get('projects') || []);
        this.refreshPending();
        await this.render();
        return;
      }
      Object.assign(this.view, {loading: false, error: errText(e), bootFailed: true});
    }
  },
};
