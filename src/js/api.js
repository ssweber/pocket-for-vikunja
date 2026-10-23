// Talking to Vikunja's API, and staying signed in.
import { app, esc, keep } from './util.js';

export class ApiError extends Error {
  constructor(status, msg, code) {
    super(msg);
    this.status = status;
    this.code = code;
  }
}
export class NetError extends Error {}
// Statuses worth retrying later: Vikunja, or a proxy in front of it, is busy or timed out. Any other answer is final,
// a 500 included, so a request Vikunja can't handle doesn't sit in the outbox for ever.
export const TRANSIENT = new Set([408, 429, 502, 503, 504]);
// A relay's 409 that lasts through every wait ('running') is passing too. The first request with that key still runs.
export const passing = e =>
  e instanceof NetError || (e instanceof ApiError && (TRANSIENT.has(e.status) || e.code === 'running'));
/* Pocket signs in with Vikunja's own session (password or single sign-on), shared with Vikunja's web app on this
   device. The token lives where Vikunja keeps it (localStorage "token") and is renewed with Vikunja's refresh cookie. */
export const sharedToken = {
  get() {
    try {
      return localStorage.getItem('token') || '';
    } catch {
      return '';
    }
  },
  set(t) {
    keep('token', t);
  },
  del() {
    try {
      localStorage.removeItem('token');
    } catch {}
  },
};
// Whether Pocket runs as a home-screen app rather than in a browser tab.
export const INSTALLED = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
let refreshing = null; // the session renewal under way, so concurrent 401s share it
export let seenToken = ''; // the shared token the last time Pocket checked who it belongs to
export const setSeenToken = t => {
  seenToken = t;
};
// A promise that settles once Vikunja reports who is signed in. It is set while Pocket opens on its saved screen.
// Until then no change is sent.
export let opening = null;
export const setOpening = p => {
  opening = p;
};
// A token's SHA-256 in hex. Pocket stores the hash to recognise a sign-in later, never the token itself. Returns ''
// when the browser can't hash: crypto.subtle exists only on an https page.
export async function tokenHash(t) {
  try {
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t))), b =>
      b.toString(16).padStart(2, '0'),
    ).join('');
  } catch {
    return '';
  }
}
let serverOffset = null; // Vikunja's clock minus the phone's, from the Date header of its replies
// Convert a time on the phone's clock to Vikunja's.
export const serverTime = ms => ms + (serverOffset ?? 0);
// The seconds a Retry-After header asks for, given as seconds or as an HTTP date on Vikunja's clock. Null when the
// header is missing or is neither.
export function retryAfter(v) {
  if (/^\s*\d+\s*$/.test(v || '')) return +v;
  const at = Date.parse(v || '');
  return at ? Math.max(0, (at - serverTime(Date.now())) / 1000) : null;
}
// The longest a 429's Retry-After holds back the outbox, so a wrong header can't stop sending for hours.
const MOST_RETRY = 300;
let calmTimer;
export const SEND_EVERY = 30000; // how often the outbox sends what waits (core.js)
/* When the outbox next sends: when a 429's Retry-After ends, or else at the next 30-second send. A send before the
   wait ends sends no keyed write, and the wait's own timer sends the outbox when it ends. */
export const nextTry = (now = Date.now()) =>
  now < (app?.calmUntil || 0) ? app.calmUntil : app?.nextFlush > now ? app.nextFlush : now + SEND_EVERY;
/* A file upload's body, as a browser builds one from FormData, with a boundary made from the upload's key. The relay
   answers a key sent again with another body with 422, and FormData picks a new boundary on every send. */
function fileBody(file, name, key) {
  const b = 'pocket-' + key,
    safe = name.replace(/"/g, '%22').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  return new Blob(
    [
      `--${b}\r\nContent-Disposition: form-data; name="files"; filename="${safe}"\r\n`,
      `Content-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`,
      file,
      `\r\n--${b}--\r\n`,
    ],
    { type: 'multipart/form-data; boundary=' + b },
  );
}
// Upload `file` to task `taskId` as `name`, with key `key`, so an upload sent again after a lost reply is made once.
export const upload = (taskId, file, name, key) =>
  api(`/tasks/${taskId}/attachments`, { method: 'POST', body: fileBody(file, name, key), key });
/* Renew the shared session the way Vikunja's own tabs do. The refresh cookie works once and is replaced on every
   renewal, so renewing takes Vikunja's "vikunja-token-refresh" lock. If another tab renewed while this one waited for
   the lock, its new token is used instead of spending the cookie again. */
function refreshSession() {
  if (refreshing) return refreshing;
  const before = sharedToken.get();
  const renew = async () => {
    const now = sharedToken.get();
    if (now && now !== before) return true;
    let r, j;
    try {
      r = await fetch(app.server + '/api/v2/user/token/refresh', { method: 'POST', credentials: 'include' });
    } catch (e) {
      throw new NetError(e.message);
    }
    // Only Vikunja refusing the renewal ends the session. A busy server or a dropped connection doesn't.
    if (TRANSIENT.has(r.status)) throw new NetError('HTTP ' + r.status);
    if (!r.ok) return false;
    try {
      j = await r.json();
    } catch (e) {
      throw new NetError(e.message);
    }
    if (!j.token) return false;
    sharedToken.set(j.token);
    if (seenToken === before) {
      seenToken = j.token;
      app.keepWho?.(j.token, app.user?.id);
    } // renewed here, so still the same person
    return true;
  };
  refreshing = (async () => {
    try {
      return navigator.locks ? await navigator.locks.request('vikunja-token-refresh', renew) : await renew();
    } catch (e) {
      if (e instanceof NetError) throw e;
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}
const timeoutSignal = ms => {
  if (AbortSignal.timeout) return AbortSignal.timeout(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
};
// Counts writes in flight in app.writing, so <html data-sync> can show when they have all finished.
export async function api(path, opts = {}) {
  const write = (opts.method || 'GET') !== 'GET';
  if (write) app.writing = (app.writing || 0) + 1;
  try {
    return await request(path, opts);
  } finally {
    if (write) app.writing--;
  }
}
/* With `key`, a write goes through the plugin's relay with that Idempotency-Key, so sending it again never makes the
   change twice. Once Vikunja reads the header itself, only the address changes. `replayed(yes)` is told whether the
   relay gave the answer it kept from an earlier send, which is as old as that send. */
async function request(
  path,
  { method = 'GET', body, raw = false, auth = true, retry = true, key, replayed, busy = 0 } = {},
) {
  // While Pocket opens on its saved screen, a write waits until Vikunja reports who is signed in. It is sent only if
  // that is still the person the screen belonged to.
  if (auth && method !== 'GET' && opening) {
    const who = app.user?.id;
    await opening;
    if (!app.signedIn || app.user?.id !== who)
      throw new ApiError(401, app.signedIn ? 'Someone else is signed in now' : 'Signed out');
  }
  // A write goes only once Pocket knows the shared session still belongs to this person, since another tab may have
  // signed someone else in. Reads are fine. The token is read after the check, so it is the token that was checked.
  if (
    auth &&
    method !== 'GET' &&
    app?.signedIn &&
    app.user &&
    sharedToken.get() !== seenToken &&
    !(await app.confirmAccount())
  )
    throw new ApiError(401, 'Someone else is signed in now');
  // Until a 429's Retry-After has passed, a keyed write fails at once as another 429, without reaching Vikunja. The
  // outbox keeps it, and sends it when the wait is over.
  if (key && Date.now() < (app?.calmUntil || 0)) throw new ApiError(429, 'Too Many Requests');
  const headers = {};
  const token = sharedToken.get();
  if (auth && token) headers.Authorization = 'Bearer ' + token;
  const form = body instanceof Blob; // a file upload, whose content type is the body's own (fileBody)
  if (body !== undefined && !form) headers['Content-Type'] = 'application/json';
  if (key) headers['Idempotency-Key'] = '"' + key + '"'; // a structured-field string, so quoted
  let res;
  try {
    // No answer in 20 seconds (2 minutes for a file) counts as no connection, so nothing waits for ever.
    res = await fetch(app.server + (key ? '/api/v1/plugins/pocket/v2' : '/api/v2') + path, {
      method,
      headers,
      body: body === undefined || form ? body : JSON.stringify(body),
      credentials: 'include',
      signal: timeoutSignal(form ? 120e3 : 20e3),
    });
  } catch (e) {
    if (app) app.offline = true;
    throw new NetError(e.message);
  }
  // Reaching Vikunja again sends what is waiting in the outbox. A brief drop never fires the browser's "online" event.
  if (app?.offline) {
    app.offline = false;
    setTimeout(() => app.flush());
  }
  const date = Date.parse(res.headers.get('date') || '');
  if (date) serverOffset = date - Date.now();
  if (res.status === 401 && auth && retry) {
    let renewed;
    try {
      renewed = await refreshSession();
    } catch (e) {
      app.offline = true;
      throw e;
    }
    if (renewed) return api(path, { method, body, raw, auth, retry: false, key, replayed });
  }
  if (res.status === 401 && auth) {
    app.sessionEnded();
    throw new ApiError(401, 'Signed out');
  }
  if (!res.ok && res.status !== 304) {
    // Vikunja's refusals give their reason in `detail`, the relay's own in `message`.
    let j = {};
    try {
      j = await res.json();
    } catch {}
    const reason = j.detail || j.message || res.statusText || 'HTTP ' + res.status;
    // Vikunja's rate limit says how long to wait. The outbox waits that long, at most MOST_RETRY seconds, then sends.
    const calm = res.status === 429 && Math.min(retryAfter(res.headers.get('retry-after')) ?? 0, MOST_RETRY);
    if (calm > 0 && app && Date.now() + calm * 1000 > (app.calmUntil || 0)) {
      app.calmUntil = Date.now() + calm * 1000;
      clearTimeout(calmTimer);
      calmTimer = setTimeout(() => app.flush(), calm * 1000);
    }
    /* The relay answers 409 while the first request with this key still runs, so Pocket waits and asks again. A wait
       is at most 10 seconds, whatever Retry-After says. With Idempotency-Unknown, the relay doesn't know whether
       that request made the change, and only the user can tell. Vikunja's own 409, such as a link it has already, gives
       its error code, and is a refusal. */
    if (res.status === 409 && key && j.code === undefined) {
      if (res.headers.get('idempotency-unknown') === 'true') throw new ApiError(409, reason, 'unknown');
      if (busy >= 3) throw new ApiError(409, reason, 'running');
      const s = retryAfter(res.headers.get('retry-after')) ?? 2;
      await new Promise(ok => setTimeout(ok, Math.min(s, 10) * 1000));
      return request(path, { method, body, raw, auth, retry, key, replayed, busy: busy + 1 });
    }
    throw new ApiError(res.status, reason, j.code);
  }
  replayed?.(res.headers.get('idempotent-replayed') === 'true');
  if (raw) return res;
  if (res.status === 204 || res.status === 304) return null; // 304: the change made no difference
  // A reply cut off half way is a lost connection too, not an error from Vikunja.
  let t;
  try {
    t = await res.text();
  } catch (e) {
    app.offline = true;
    throw new NetError(e.message);
  }
  // A reply that isn't JSON came from something in front of Vikunja, such as a sign-in proxy's page. Vikunja hasn't
  // refused the change, so it waits, as with no connection.
  try {
    return t ? JSON.parse(t) : null;
  } catch {
    app.offline = true;
    throw new NetError("the reply wasn't from Vikunja");
  }
}
/* Every item of a paged list. Reads page 1, then the rest at once, asking for Vikunja's max_items_per_page per page
   (from /info, or Vikunja's default of 50 when it doesn't say). If any page fails, the whole read fails. */
export async function allPages(path) {
  const per = app?.info?.max_items_per_page || 50,
    at = page => path + (path.includes('?') ? '&' : '?') + 'page=' + page + '&per_page=' + per;
  const first = await api(at(1)),
    pages = first?.total_pages || 1;
  const rest = await Promise.all(Array.from({ length: Math.max(0, pages - 1) }, (_, k) => api(at(k + 2))));
  return [first, ...rest].flatMap(items);
}
/* Items `from` to `from + n` of a paged list, fewer at its end, read in as few pages as Vikunja allows. Returns
   {items, total}, `total` being the list's whole length, or null when Vikunja doesn't say. For lists shown a part at a
   time, such as a project's Done. */
export async function partOf(path, from, n) {
  const per = Math.min(n, app?.info?.max_items_per_page || 50),
    first = Math.floor(from / per),
    last = Math.ceil((from + n) / per);
  const pages = await Promise.all(
    Array.from({ length: last - first }, (_, k) =>
      api(path + (path.includes('?') ? '&' : '?') + 'page=' + (first + k + 1) + '&per_page=' + per),
    ),
  );
  return {
    items: pages.flatMap(items).slice(from - first * per, from - first * per + n),
    total: pages[0]?.total ?? null,
  };
}
export const items = data => data?.items || [];
export function netHelp() {
  return `Can't reach Vikunja at ${esc(location.origin)}. Check your connection, then try again.`;
}
// A failure's reason for a message: Vikunja's answer, or that it couldn't be reached.
export const why = e => (e instanceof NetError ? 'no connection to Vikunja' : e.message);
export function errText(e) {
  if (e instanceof NetError) return netHelp();
  if (e instanceof ApiError && e.status === 429) return 'Too many attempts from here. Wait a minute, then try again.';
  return esc(e.message || String(e));
}
