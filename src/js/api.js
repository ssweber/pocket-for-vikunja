// Talking to Vikunja's API, and staying signed in.
import {app, esc} from './util.js';

export class ApiError extends Error { constructor(status, msg, code){ super(msg); this.status=status; this.code=code; } }
export class NetError extends Error {}
// Worth trying again later: no connection, or Vikunja (or a proxy in front of it) busy or timing out. Any other
// answer is final, a 500 included, so a request Vikunja can't handle doesn't sit in the outbox for ever.
export const TRANSIENT = new Set([408, 429, 502, 503, 504]);
export const passing = e => e instanceof NetError || (e instanceof ApiError && TRANSIENT.has(e.status));
/* Two ways to be signed in:
   - 'session': Vikunja's own web sign-in (password or single sign-on), shared with Vikunja's web app on this device.
     The token lives where Vikunja keeps it (localStorage "token") and is renewed with Vikunja's refresh cookie.
   - 'token': an API token, kept by Pocket alone. */
export const sharedToken = {
  get(){ try { return localStorage.getItem('token') || ''; } catch { return ''; } },
  set(t){ try { localStorage.setItem('token', t); } catch {} },
  del(){ try { localStorage.removeItem('token'); } catch {} },
};
// Home-screen app, as opposed to a browser tab.
export const INSTALLED = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
// When this copy of Pocket was put on the server: the page's Last-Modified, which the browser gives in local time as
// "MM/DD/YYYY hh:mm:ss" (or the time now, if the server didn't say).
export const LOADED = (m => m && new Date(m[3], m[1] - 1, m[2], m[4], m[5], m[6]))(document.lastModified.match(/(\d+)\/(\d+)\/(\d+) (\d+):(\d+):(\d+)/));
// Renew the shared session the way Vikunja's own tabs do. The refresh cookie works once and is replaced on every
// renewal, so renewals take Vikunja's "vikunja-token-refresh" lock, and if someone else renewed while we waited,
// their new token is used instead of spending the cookie again.
let refreshing = null;
export let seenToken = '';                              // the shared session's token when Pocket last checked whose it is
export const setSeenToken = t => { seenToken = t; };
let serverOffset = null;                         // Vikunja's clock minus the phone's, from its replies' Date header
// A moment on the phone's clock, on Vikunja's.
export const serverTime = ms => ms + (serverOffset ?? 0);
/* The earliest a cut-off try can have created something, on Vikunja's clock: when it was sent, less 3 seconds for the
   Date header's whole seconds and the time the reply took to arrive. So something with the same name made before the
   try, on the web say, isn't taken for it. Without that time (an entry saved before it was kept), from 2 minutes
   before the capture. Vikunja has no way to tag a request, so a same-name task made elsewhere in those few seconds
   after the try could still be. */
export const triedSince = (triedAt, at) => triedAt ? serverTime(triedAt) - 3000 : new Date(at).getTime() - 2 * 60000;
function refreshSession(){
  if (refreshing) return refreshing;
  const before = sharedToken.get();
  const renew = async () => {
    const now = sharedToken.get();
    if (now && now !== before) return true;
    let r, j;
    try { r = await fetch(app.server + '/api/v2/user/token/refresh', {method:'POST', credentials:'include'}); }
    catch (e) { throw new NetError(e.message); }
    // Only Vikunja turning the renewal down ends the session; a busy server or a dropped connection doesn't.
    if (TRANSIENT.has(r.status)) throw new NetError('HTTP ' + r.status);
    if (!r.ok) return false;
    try { j = await r.json(); } catch (e) { throw new NetError(e.message); }
    if (!j.token) return false;
    sharedToken.set(j.token);
    if (seenToken === before) seenToken = j.token;                           // renewed by us: still the same person
    return true;
  };
  refreshing = (async () => {
    try { return navigator.locks ? await navigator.locks.request('vikunja-token-refresh', renew) : await renew(); }
    catch (e) { if (e instanceof NetError) throw e; return false; }
    finally { refreshing = null; }
  })();
  return refreshing;
}
const timeoutSignal = ms => { if (AbortSignal.timeout) return AbortSignal.timeout(ms); const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; };
// Changes on their way to Vikunja are counted (app.writing), so <html data-sync> says when they're all there.
export async function api(path, opts = {}){
  const write = (opts.method || 'GET') !== 'GET';
  if (write) app.writing = (app.writing || 0) + 1;
  try { return await request(path, opts); } finally { if (write) app.writing--; }
}
async function request(path, {method='GET', body, raw=false, auth=true, retry=true} = {}){
  // A change is only sent once Pocket knows the shared session is still this person's: another tab may have signed
  // someone else in. (Reading is fine.) The token is read after that, so it's the one that was checked.
  if (auth && method !== 'GET' && app?.mode === 'session' && app.signedIn && app.user && sharedToken.get() !== seenToken
    && !await app.confirmAccount()) throw new ApiError(401, 'Someone else is signed in now');
  const headers = {};
  const token = app.mode === 'session' ? sharedToken.get() : app.token;
  if (auth && token) headers.Authorization = 'Bearer ' + token;
  const form = body instanceof FormData;                                       // files: the browser sets the type
  if (body !== undefined && !form) headers['Content-Type'] = 'application/json';
  let res;
  try {
    // No answer in 20 seconds (2 minutes for a file) counts as no connection, so nothing waits on it for ever.
    res = await fetch(app.server + '/api/v2' + path, {
      method, headers, body: body === undefined || form ? body : JSON.stringify(body),
      credentials: app.mode === 'session' ? 'include' : 'omit', signal: timeoutSignal(form ? 120e3 : 20e3),
    });
  } catch (e) { if (app) app.offline = true; throw new NetError(e.message) }
  // Reaching Vikunja again sends what's waiting. A brief drop never fires the browser's "online" event.
  if (app?.offline) { app.offline = false; setTimeout(() => app.flush()); }
  const date = Date.parse(res.headers.get('date') || '');
  if (date) serverOffset = date - Date.now();
  if (res.status === 401 && auth && retry && app.mode === 'session') {
    let renewed;
    try { renewed = await refreshSession(); } catch (e) { app.offline = true; throw e; }
    if (renewed) return api(path, {method, body, raw, auth, retry:false});
  }
  if (res.status === 401 && auth) {
    // Vikunja also answers 401 when an API token lacks a permission, so check the token before signing out.
    if (app.mode === 'token' && path !== '/user' && await tokenWorks()) throw new ApiError(403, 'Your API token doesn\'t allow this. Create one with the permissions listed on the sign-in screen.', 'token');
    app.signOut('Your session ended. Sign in again.', {tellServer: false}); throw new ApiError(401, 'Signed out');
  }
  if (!res.ok && res.status !== 304) {
    let j = {}; try { j = await res.json() } catch {}
    throw new ApiError(res.status, j.detail || res.statusText || ('HTTP ' + res.status), j.code);
  }
  if (raw) return res;
  if (res.status === 204 || res.status === 304) return null;              // 304: a change to what's there already
  // A reply cut off half way is a lost connection too, not an error from Vikunja.
  let t; try { t = await res.text(); } catch (e) { app.offline = true; throw new NetError(e.message); }
  return t ? JSON.parse(t) : null;
}
// Changes some of a task's fields; resolves to Vikunja's copy. When they're set that way already, Vikunja sends nothing
// back, so its copy is read instead.
export async function patchTask(id, fields){
  return await api('/tasks/' + id, {method:'PATCH', body: fields}) || await api('/tasks/' + id);
}
async function tokenWorks(){
  try { return (await fetch(app.server + '/api/v2/user', {headers: {Authorization: 'Bearer ' + app.token}})).ok; }
  catch { return false; }
}
export async function allPages(path){
  const out = [];
  for (let page = 1; page <= 40; page++) {
    const data = await api(path + (path.includes('?') ? '&' : '?') + 'page=' + page + '&per_page=50');
    const items = data?.items || [];
    out.push(...items);
    if (!items.length || page >= (data.total_pages || 1)) break;
  }
  return out;
}
// The items of one page of a list.
export const items = data => data?.items || [];
export function netHelp(){
  return `Can't reach Vikunja at ${esc(location.origin)}. Check your connection, then try again.`;
}
// Why something wasn't done, in a message: Vikunja's answer, or that it couldn't be reached.
export const why = e => e instanceof NetError ? 'no connection to Vikunja' : e.message;
export function errText(e){
  if (e instanceof NetError) return netHelp();
  if (e instanceof ApiError && e.status === 429) return 'Too many attempts from here. Wait a minute, then try again.';
  return esc(e.message || String(e));
}
