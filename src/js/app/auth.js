// Signing in and out, and following the sign-in Pocket shares with Vikunja's web app.
import {esc, store, taskDrafts, userCache} from '../util.js';
import {api, ApiError, errText, INSTALLED, NetError, netHelp, seenToken, setOpening, setSeenToken, sharedToken, tokenHash} from '../api.js';
import {sync} from '../sync.js';
import {saved} from '../lists.js';
import {dropCopies} from './tasks.js';

let confirming = null;                           // app.confirmAccount() while it runs

export default {
  get passwordAllowed(){ const a = this.info?.auth || {}; return !!(a.local?.enabled || a.ldap?.enabled); },
  // Single sign-on providers Vikunja offers (Cloudron's login shows up here), from /info.
  get providers(){ const o = this.info?.auth?.openid_connect; return o?.enabled ? o.providers || [] : []; },
  // Follow the shared session: adopt a token that appeared (a sign-in finished), and sign out when Vikunja did.
  sessionChanged(){
    const t = sharedToken.get();
    if (t && !this.signedIn) {
      try { this.ssoWindow?.close(); } catch {}
      this.ssoWindow = null; this.login.waiting = false;
      this.boot();
    } else if (!t && this.signedIn) {
      // Vikunja can clear the token for a moment while it renews it, so only a sign-out that lasts counts.
      clearTimeout(this.signOutCheck);
      this.signOutCheck = setTimeout(() => {
        if (!sharedToken.get() && this.signedIn) this.signOut('You signed out in Vikunja.', {tellServer: false});
      }, 2000);
    } else if (t && t !== seenToken && this.signedIn && this.user) {
      // A new token is usually Vikunja renewing the session. It can also be someone else signing in on Vikunja's web
      // app before Pocket saw the sign-out, and then Pocket starts over as that user. Until Pocket knows, api.js sends
      // no changes to Vikunja. If Vikunja can't be asked now, the next change or flush asks again.
      clearTimeout(this.whoCheck);
      this.whoCheck = setTimeout(() => this.confirmAccount().then(same => same && this.flush(), () => {}), 300);
    }
  },
  // Check whether the shared session still belongs to the same user. If the token changed since Pocket last checked,
  // this asks Vikunja. If the session belongs to someone else, Pocket starts over as that user. Throws if Vikunja
  // can't be asked.
  confirmAccount(){
    return confirming ||= (async () => {
      try {
        for (;;) {
          const t = sharedToken.get();
          if (t === seenToken) return true;
          const was = this.user?.id, u = await api('/user');
          if (sharedToken.get() !== t) continue;                              // the token changed again, so ask again
          setSeenToken(t);
          if (was && u.id !== was && this.user?.id === was) { this.switchAccount(); return false; }
          this.keepWho(t, u.id);
          return true;
        }
      } finally { confirming = null; }
    })();
  },
  /* Remember that token `t` belongs to user `id`. Pocket stores the token's hash beside the user's saved lists
     (saved.who), never the token itself. When Pocket opens later with the same token, boot shows the saved screen
     before asking Vikunja. The hash is cleared with the saved lists. */
  async keepWho(t, id){
    const hash = t && id && await tokenHash(t);
    if (hash && saved.get('user')?.id === id) saved.set('who', {id, hash});
  },
  // The saved user, if the token Pocket opens with is the one last confirmed as theirs. Else null.
  async keptUser(){
    const u = saved.get('user'), who = saved.get('who'), t = sharedToken.get();
    return u && t && who?.id === u.id && who.hash === await tokenHash(t) ? u : null;
  },
  // Forget the last user's lists, caches and open task, and load the new user's. The last user's outbox entries stay,
  // under their id, until they sign in again.
  switchAccount(){
    saved.clear(); this.forgetPeople(); this.dropSheet();
    this.user = null; this.pending = []; this.failed = []; this.keyWaiting(); this.cap.text = ''; this.capPhotos = [];
    this.boot();
  },
  // Close the sheet without saving. With `keep`, drafts written in it are kept on the phone for when the same user
  // returns.
  dropSheet(keep = false){
    const sh = this.sheet, t = this.sheetTask;
    if (keep && sh.open && sh.kind === 'task' && t) {
      if (sh.editingDesc) taskDrafts.set('desc:' + t.id, {text: sh.descDraft, base: sh.descBase});
      taskDrafts.set('comment:' + t.id, sh.commentDraft); taskDrafts.set('sub:' + t.id, sh.sub.text);
    }
    Object.assign(this.sheet, {editingDesc: false, commentDraft: '', id: null, newTpl: null}); this.closeSheet(true);
  },
  forgetPeople(drafts = true){
    if (drafts) { this.runDrafts = {}; taskDrafts.clear(); store.del('drafts.user'); }
    dropCopies(); this.tasks = {}; userCache.clear(); this.access = {}; this.userKnown = {}; this.people = null;
    this.labels = []; this.labelsLoaded = false;
  },
  /* Single sign-on goes through Vikunja. The provider only returns to Vikunja's /auth/openid/<key> page, which finishes
     signing in and saves the session where Pocket reads it. The request is the same one Vikunja's login page makes. */
  signInWith(p){
    const state = Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem('state', state); } catch {}
    const url = `${p.auth_url}?client_id=${encodeURIComponent(p.client_id)}&redirect_uri=${encodeURIComponent(`${location.origin}/auth/openid/${p.key}`)}`
      + `&response_type=code&scope=${encodeURIComponent(p.scope)}&state=${state}`;
    // In a browser tab, the sign-in opens in a new tab and this tab picks up the session. A home-screen app has one
    // window, so the app itself goes to the sign-in page and picks up the session on return.
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
    // A sign-out the user chose (no `msg`) drops the saved lists and what is waiting to be sent, after asking.
    if (!msg) {
      const mine = sync.all(me);
      const tasks = mine.filter(e => e.op === 'add' && !e.taskId), files = mine.flatMap(e => (e.files || []).filter(f => !f.sent));
      const count = (n, word) => n === 1 ? 'a ' + word : `${n} ${word}s`;
      const runs = mine.filter(e => e.kind === 'run' || (e.kind === 'act' && e.op !== 'add')).length, n = tasks.length + files.length + runs;
      const what = [tasks.length && count(tasks.length, 'task'), files.length && count(files.length, files.every(f => /^image\//.test(f.type)) ? 'photo' : 'file'),
        runs && (runs === 1 ? 'a change to a checklist' : runs + ' changes to checklists')].filter(Boolean).join(' and ');
      if (n && !confirm(`${what[0].toUpperCase() + what.slice(1)} ${n === 1 ? 'hasn\'t' : 'haven\'t'} reached Vikunja yet. Sign out anyway and discard ${n === 1 ? 'it' : 'them'}?`)) return;
      sync.drop(e => e.user === me);
      this.pending = []; this.failed = []; this.keyWaiting();
    }
    saved.clear();
    const t = sharedToken.get();
    // eslint-disable-next-line no-restricted-globals -- not through api(), which could renew the session or sign out again
    if (tellServer && t) fetch(this.server + '/api/v2/logout', {method:'POST', credentials:'include', headers: {Authorization: 'Bearer ' + t}}).catch(() => {});
    sharedToken.del();
    this.signedIn = false; this.user = null;
    // A sign-out the user chose drops drafts. A session that ended, or a sign-out in Vikunja's web app, keeps them for
    // the same user. boot clears them if someone else signs in.
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
      if (this.passwordAllowed) this.$nextTick(() => this.$refs.inUser?.focus());
    } catch (err) {
      this.login.err = err instanceof NetError ? netHelp() : `Vikunja didn't answer as expected (${errText(err)}).`;
    }
  }); },
  async submitPassword(){ await this.busy(async () => {
    try {
      const body = {username: this.login.user.trim(), password: this.login.pass, long_token: true};
      const totp = this.login.totp.trim(); if (totp) body.totp_passcode = totp;
      const j = await api('/login', {method:'POST', body, auth:false});           // also sets Vikunja's refresh cookie
      sharedToken.set(j.token);
      this.login.pass = ''; this.login.totp = '';
      await this.boot();
    } catch (err) {
      if (err.code === 1017) { this.login.showTotp = true; this.$nextTick(() => this.$refs.inTotp.focus()); }
      this.login.err = err.code === 1017 ? 'Enter your two-factor code.' : errText(err);
    }
  }); },

  async boot(){
    this.screen = 'app'; this.signedIn = true;
    Object.assign(this.view, {loading: true, error: '', bootFailed: false, route: null});
    // Wait for the outbox to load from the phone's database, but not for long. Another tab with an older Pocket can
    // hold it up.
    await Promise.race([sync.ready, new Promise(ok => setTimeout(ok, 3000))]);
    sync.ready.then(() => this.refreshPending());
    /* If the token is the one last confirmed for the saved user (keepWho), show that user's saved screen at once and
       ask Vikunja whose token it is. Until Vikunja answers, nothing is sent (setOpening, api.js). Any other token
       waits for Vikunja. */
    const kept = await this.keptUser();
    let opened = null;
    const confirmed = () => { if (opened) { setOpening(null); opened(); opened = null; } };
    if (kept) {
      setOpening(new Promise(ok => { opened = ok; }));
      this.user = kept; this.info = this.info || saved.get('info');
      this.setProjects(saved.get('projects') || []);
      this.refreshPending();
      await this.render({kept: true});
    }
    try {
      const [user, info] = await Promise.all([api('/user'), this.info ? Promise.resolve(this.info) : api('/info', {auth:false}).catch(() => null)]);
      // A different user behind the same token shouldn't happen. If it does, Pocket starts over as that user
      // (switchAccount). The saved user's lists are dropped, and their waiting changes stay under their own id, so
      // nothing of theirs is shown to, or sent as, the other user.
      if (kept && user.id !== kept.id) { this.switchAccount(); confirmed(); return; }
      this.user = user; this.info = info || this.info || saved.get('info');   // if /info could not be read this time, keep the old one
      // Drafts kept when a session ended are for the same user only.
      const owner = store.get('drafts.user');
      if (owner && owner !== String(user.id)) { taskDrafts.clear(); this.runDrafts = {}; }
      store.del('drafts.user');
      setSeenToken(sharedToken.get());                                         // this token is confirmed as this user's
      // Another user's saved lists must never be shown, for example after they signed out somewhere Pocket didn't see.
      // Screens open from the saved copies (savedView), so those must belong to this account.
      if (saved.get('user')?.id !== user.id) { saved.clear(); this.perms = {}; this.seenBy = {}; }
      saved.set('user', user); if (info) saved.set('info', info);
      this.keepWho(sharedToken.get(), user.id);
      confirmed();
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
    } finally { confirmed(); }
  },
};
