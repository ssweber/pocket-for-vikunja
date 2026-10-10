// What the end-to-end tests share: Playwright's assertions that try again, waiting until Pocket has sent everything,
// and signing in. Not a test file itself.
import { expect as base } from 'playwright/test';
import { swipeAt } from '../src/js/progress.js';

/* Playwright's own expect, without its test runner: `await expect(locator).toBeVisible()` tries again until it passes
   or 10 seconds go by, so a test needn't wait for the page and then check it. */
export const expect = base.configure({ timeout: 10000 });

/* Until everything Pocket has to send has reached Vikunja: <html data-sync> says "idle" (core.js), and still does a
   moment later, as a tap's handler may be about to send. Before a test reads Vikunja, or deletes what it made.
   Something kept that can't go now (a deletion whose Undo still shows, no connection, turned down) never gets there. */
export async function synced(page, { timeout = 20000, settle = 250 } = {}){
  let since = 0, state;
  for (const end = Date.now() + timeout; ; await new Promise(r => setTimeout(r, 50))) {
    state = await page.evaluate(() => document.documentElement.dataset.sync).catch(() => null);    // mid-reload: again
    if (state !== 'idle') since = 0; else if (!since) since = Date.now(); else if (Date.now() - since >= settle) return;
    if (Date.now() > end) throw new Error(`Pocket never finished sending: data-sync is "${state}"`);
  }
}

// Signed in with an API token, from Pocket's sign-in screen at `url`, until its first list has loaded.
export async function signIn(page, url, token){
  await page.goto(url);
  await expect(page.locator('#auth-step')).toBeVisible();                  // no address to enter: it's this Vikunja
  const tab = page.getByRole('button', { name: 'API token', exact: true });
  if (await tab.isVisible()) await tab.click();                            // not there when passwords are off
  await page.getByLabel('API token').fill(token);
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.locator('#app')).toBeVisible();
  await loaded(page);
}

/* Until the screen on show is loaded from Vikunja: no Loading, and not the copy kept of it, shown at once while it's
   loaded afresh behind (<main id="view" aria-busy>). */
export async function loaded(page, timeout = 15000){
  await expect(page.locator('#view .loading')).toHaveCount(0, { timeout });
  await expect(page.locator('#view[aria-busy="true"]')).toHaveCount(0, { timeout });
}

/* A message in its place (lines.js): under a heading ("overdue"), by the add box ("cap"), in a sheet ("sheet:notes"), on
   a run ("step", "run"), as Pocket asked for it (data-place). Its action is a button with its name: line.getByRole(…). */
export const placeLine = (page, where) => page.locator(`.place-line[data-place="${where}"]`);
export const placeSays = (page, where, text, timeout = 20000) => expect(placeLine(page, where)).toContainText(text, { timeout, ignoreCase: true });
// A line in a row's place: what it says, and its action.
export const rowLine = (page, text) => page.locator('.row-line', { hasText: text });
// No message at the bottom of the screen.
export const noToast = async page => { if (await page.locator('#toast.show').count()) throw new Error('the toast said: ' + await page.textContent('#toast-msg')); };
// A message showing in the toast (a hidden one keeps its words, only see-through: so only one showing counts).
export const toast = (page, text, timeout = 20000) => expect(page.locator('#toast.show #toast-msg')).toContainText(text, { timeout, ignoreCase: true });
// So the next one is new: the one showing goes now, as its own timer would make it. (Not by moving the page's clock on,
// which would also bring every other timer round sooner: the run screen's reload every 20 seconds, under a finger.)
export async function toastGone(page){
  await page.evaluate(() => { const t = window.Alpine?.$data(document.body)?.toast; if (t) t.show = false; });
  await expect(page.locator('#toast.show')).toHaveCount(0);
}

// Where an element is once it has stopped moving (a sheet sliding in, a list scrolling): to put a finger on it.
export async function steady(locator, timeout = 5000){
  let was = null;
  for (const end = Date.now() + timeout; Date.now() < end; await new Promise(r => setTimeout(r, 80))) {
    const box = await locator.boundingBox();
    if (box && was && Math.abs(box.x - was.x) < 0.5 && Math.abs(box.y - was.y) < 0.5) return box;
    was = box;
  }
  throw new Error('it never stopped moving');
}

/* A finger on `page`: Chrome's own touch input, so the page scrolls under it as on a phone, and the phone's rules for a
   touch hold (touch-action, a scroll taking the touch away from the page), which a mouse (swipeRow) never meets.
   `touch(type, x, y, at)` is one touchStart, touchMove or touchEnd. Each says when it happened (`at`, in ms), as a
   phone's do, since Chrome takes its own time to pass them on: how fast the finger went is then the test's to say.
   `touchDrag(sel, by, n, every, hold, {check})`: `sel` touched in its middle, moved `by` px down in `n` moves `every`
   ms apart, then lifted; held `hold` ms first (really waited). `check` runs before it's lifted, the finger still
   down, once the page has had its last move: Chrome hands a page its touch moves a frame at a time, later than it
   takes them from here, so a check that nothing moved would otherwise pass before the page had the chance. */
export async function finger(page){
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, x, y, at = Date.now()) => cdp.send('Input.dispatchTouchEvent', { type, timestamp: at / 1000, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  // Where the page last saw the finger: a listener that only looks, added once per page load.
  const watch = () => page.evaluate(() => {
    if (window.__finger) return;
    window.__finger = {};
    addEventListener('touchmove', e => { const p = e.touches[0]; window.__finger = { x: p.clientX, y: p.clientY }; }, { capture: true, passive: true });
  });
  const seenAt = (x, y) => page.waitForFunction(([x, y]) => Math.abs(window.__finger.x - x) < 1 && Math.abs(window.__finger.y - y) < 1, [x, y], { polling: 50, timeout: 5000 });
  const touchDrag = async (sel, by, n = 8, every = 40, hold = 0, { check = null } = {}) => {
    const b = await steady(page.locator(sel)), x = b.x + b.width / 2, y = b.y + b.height / 2;
    if (check) await watch();
    await touch('touchStart', x, y);
    if (hold) await page.waitForTimeout(hold);
    const t0 = Date.now();
    for (let i = 1; i <= n; i++) await touch('touchMove', x, y + by * i / n, t0 + i * every);
    // The finger lifts whatever the check found, so the next touch starts afresh.
    try { if (check) { await seenAt(x, y + by); await check(); } }
    finally { await touch('touchEnd', x, y + by, t0 + n * every + 8); }
  };
  return { touch, touchDrag };
}

/* The one-time hint to hold and slide put away, as on a phone that has slid a row: otherwise it adds a line to the
   first row of each screen, which a test measuring rows doesn't expect. Every page of `context`, from the start. */
export const hintSeen = context => context.addInitScript(() => { try { localStorage.setItem('pocket.hint.slide', 'done'); } catch {} });

/* A finger swiped across row `sel` (pressed, moved, lifted, as a phone's touch does with no hold), to where letting go
   does `to`: a quarter of progress, or 100, done (a full swipe right); 'open' or 'delete' (a row at 0% swiped left into
   its Delete, resting open on it, or past half the row, deleted); 'back' (a parent's header swiped right a little, which
   springs back). Where that is comes from the app's own sums (swipeAt), so a change to its numbers (SIDES) changes no
   test: the finger is let go in the middle of the stretch that does it, or a little past a full point. Right from near
   the row's left, left from near its right, so each side has its room. `start`: its progress as the swipe starts (a done
   row's 100); `one`: a parent's header or row, whose right side has only its full point; `check` runs while it's held.
   By the mouse, which the page takes as a finger, but the phone's own rules for a touch never meet it: `finger`
   (finger(page).touch) swipes it by a real touch instead. */
export async function swipeRow(page, sel, to, { start = 0, one = false, check = null, finger = null } = {}){
  const el = page.locator(sel);
  await el.evaluate(e => e.scrollIntoView({ block: 'center', behavior: 'instant' }));
  const box = await steady(el), width = await el.evaluate(e => e.clientWidth), screen = page.viewportSize().width;
  const right = to === 'back' || (typeof to === 'number' && to > start), x = right ? box.x + 60 : box.x + box.width - 40, y = box.y + Math.min(box.height / 2, 28);
  const wants = r => to === 'back' ? r.to === 'stop' && r.off > 20 : to === 'open' || to === 'delete' ? r.to === to
    : to >= 100 ? r.to === 'done' : r.to === 'stop' && r.pct === to;
  const band = [];
  for (let d = 1; d <= width; d++) {
    const r = swipeAt({ start, dx: right ? d : -d, x, width, screen, del: true, one, side: right ? 'right' : 'left' });
    if (wants(r)) band.push(d); else if (band.length) break;
  }
  if (!band.length) throw new Error(`no swipe of ${sel} from ${start}% does ${to}`);
  const full = to === 'delete' || to >= 100 || (to === 0 && start > 0), dx = full ? band[0] + 16 : band[Math.floor(band.length / 2)];
  if (finger) {
    const x1 = x + (right ? dx : -dx), t0 = Date.now();
    await finger('touchStart', x, y, t0);
    for (let i = 1; i <= 10; i++) await finger('touchMove', x + (x1 - x) * i / 10, y + 2, t0 + i * 16);
    try { await check?.(); }
    finally { await finger('touchEnd', x1, y + 2, t0 + 180); }
    return;
  }
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + (right ? dx : -dx), y + 2, { steps: 10 });
  await check?.();
  await page.mouse.up();
}
