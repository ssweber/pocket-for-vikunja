// What the end-to-end tests share: retrying assertions, waiting until Pocket has sent everything, and signing in.
// This file contains no tests.
import { expect as base } from 'playwright/test';
import { swipeAt } from '../src/js/progress.js';

/* Playwright's `expect` with a 10 second timeout. `await expect(locator).toBeVisible()` retries until it passes or
   the timeout ends, so a test doesn't need a separate wait before checking the page. */
export const expect = base.configure({ timeout: 10000 });

/* Runs a file's steps, prints each one's result and time, and counts the failures. `shot(name)` saves a picture of a
   failed step. STEP=<regex> runs only the steps whose name it matches, plus the setup steps, which always run because
   later steps need what they make. A step that builds on the steps just before it needs them in the regex too.
   `end()` prints the totals and sets the exit code. A failure found after the steps adds to `failed`. */
export function stepper(shot = () => {}) {
  const only = process.env.STEP ? new RegExp(process.env.STEP) : null;
  const s = { failed: 0, ran: 0, skipped: 0 };
  const run = async (name, fn, setup) => {
    if (only && !setup && !only.test(name)) return void s.skipped++;
    if (!setup) s.ran++;
    const start = Date.now(),
      secs = () => ` (${((Date.now() - start) / 1000).toFixed(1)}s)`; // shows each step's time, so a slow one stands out
    try {
      await fn();
      console.log('PASS', name + (only && setup ? ' (setup)' : '') + secs());
    } catch (e) {
      s.failed++;
      console.log(
        'FAIL',
        name + secs(),
        '-',
        e.message
          .split('\n')
          .slice(0, process.env.VERBOSE ? 8 : 1)
          .join(' · '),
      );
      try {
        await shot(name);
      } catch {}
    }
  };
  s.step = (name, fn) => run(name, fn, false);
  s.setup = (name, fn) => run(name, fn, true);
  s.end = () => {
    const skipped = only ? `, ${s.skipped} skipped by STEP` : '';
    if (only && !s.ran) console.log(`STEP=${process.env.STEP} matches no step in this file`);
    console.log((s.failed ? `${s.failed} failed` : 'All passed') + skipped);
    if (only && s.failed) console.log('A step can fail because STEP skipped a step it needs. Add that step to STEP.');
    process.exitCode = s.failed ? 1 : 0;
  };
  return s;
}

/* Waits until everything Pocket has to send has reached Vikunja. Call it before a test reads Vikunja or deletes
   what the test made. It needs <html data-sync> (core.js) to be "idle" for `settle` ms, because a tap's handler may be
   about to send something. It never finishes while something can't be sent (a deletion whose Undo is still showing,
   no connection, a request Vikunja rejected). */
export async function synced(page, { timeout = 20000, settle = 250 } = {}) {
  let since = 0,
    state;
  for (const end = Date.now() + timeout; ; await new Promise(r => setTimeout(r, 50))) {
    state = await page.evaluate(() => document.documentElement.dataset.sync).catch(() => null); // the page is reloading, so try again
    if (state !== 'idle') since = 0;
    else if (!since) since = Date.now();
    else if (Date.now() - since >= settle) return;
    if (Date.now() > end) throw new Error(`Pocket never finished sending: data-sync is "${state}"`);
  }
}

/* What is waiting in the outbox, as IndexedDB holds it. A change shows on screen before Pocket has finished writing it
   to IndexedDB. A test that reloads the page, as if the phone closed Pocket, first waits until the change is here. */
export const outboxOf = p =>
  p.evaluate(
    () =>
      new Promise(ok => {
        const r = indexedDB.open('pocket');
        r.onsuccess = () => {
          const q = r.result.transaction('outbox').objectStore('outbox').getAll();
          q.onsuccess = () => {
            r.result.close();
            ok(q.result);
          };
        };
      }),
  );

// Signs in with a username and password on Pocket's sign-in screen at `url`, then waits for the first list to load.
export async function signIn(page, url, user, password) {
  await page.goto(url);
  await expect(page.locator('#auth-step')).toBeVisible(); // no server address to enter, Pocket uses this Vikunja
  await page.getByLabel('Username or email').fill(user);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('#app')).toBeVisible();
  await loaded(page);
}

/* Waits until the current screen is loaded from Vikunja. That means no grey rows or Loading text, and no saved copy
   of the screen that is shown while the real one loads behind it (<main id="view" aria-busy>). */
export async function loaded(page, timeout = 15000) {
  await expect(page.locator('#view :is(.skeleton, .loading)')).toHaveCount(0, { timeout });
  await expect(page.locator('#view[aria-busy="true"]')).toHaveCount(0, { timeout });
}

/* A message line (lines.js), found by where Pocket put it (data-place). Examples are under a heading ("overdue"),
   by the add box ("cap"), in a sheet ("sheet:notes") and on a checklist ("step", "run"). The line's action is a
   button with a label: line.getByRole(…). */
export const placeLine = (page, where) => page.locator(`.place-line[data-place="${where}"]`);
export const placeSays = (page, where, text, timeout = 20000) =>
  expect(placeLine(page, where)).toContainText(text, { timeout, ignoreCase: true });
// A message line that replaces a row, found by its text.
export const rowLine = (page, text) => page.locator('.row-line', { hasText: text });
// Fails if a toast (the message at the bottom of the screen) is showing.
export const noToast = async page => {
  if (await page.locator('#toast.show').count())
    throw new Error('unexpected toast: ' + (await page.textContent('#toast-msg')));
};
// Waits for a toast with this text. A hidden toast keeps its text and is only transparent, so only a showing toast counts.
export const toast = (page, text, timeout = 20000) =>
  expect(page.locator('#toast.show #toast-msg')).toContainText(text, { timeout, ignoreCase: true });
// Hides the showing toast now, as its timer would, so the next toast is a new one. The test doesn't advance the page's
// clock instead, because that would also fire every other timer early, such as the checklist screen's reload every
// 20 seconds while the user is touching the screen.
export async function toastGone(page) {
  await page.evaluate(() => {
    const t = window.Alpine?.$data(document.body)?.toast;
    if (t) t.show = false;
  });
  await expect(page.locator('#toast.show')).toHaveCount(0);
}

// Returns an element's bounding box once it has stopped moving (a sheet sliding in, a list scrolling), so a touch can target it.
export async function steady(locator, timeout = 5000) {
  let was = null;
  for (const end = Date.now() + timeout; Date.now() < end; await new Promise(r => setTimeout(r, 80))) {
    const box = await locator.boundingBox();
    if (box && was && Math.abs(box.x - was.x) < 0.5 && Math.abs(box.y - was.y) < 0.5) return box;
    was = box;
  }
  throw new Error('the element never stopped moving');
}

/* Real touch input on `page`, sent through Chrome. The page scrolls as it does on a phone, and the phone's touch
   rules apply (touch-action, a scroll taking the touch away from the page). A mouse (swipeRow) never meets those rules.
   `touch(type, x, y, at)` sends one touchStart, touchMove, touchEnd or touchCancel. Each carries its time (`at`, in ms),
   as events from a phone do, because Chrome delays passing them on. The test therefore decides how fast the touch moves.
   `touchDrag(sel, by, n, every, hold, {check, cancel})` touches the middle of `sel`, moves `by` px down in `n` moves
   `every` ms apart, then releases, and returns once the release's time has passed. It really waits `hold` ms before moving. `check` runs before the release, while the
   touch is still down and after the page has received the last move. Chrome gives the page touch moves one frame at a
   time, later than the test sends them, so a check that nothing moved would otherwise pass before the page could react.
   `cancel` ends the touch with touchcancel instead of a release, as the phone does when its own gesture or a call
   interrupts a touch. */
export async function finger(page) {
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, x, y, at = Date.now()) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      timestamp: at / 1000,
      touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x, y }],
    });
  // Records where the page last saw the touch. The listener only reads, and is added once per page load.
  const watch = () =>
    page.evaluate(() => {
      if (window.__finger) return;
      window.__finger = {};
      addEventListener(
        'touchmove',
        e => {
          const p = e.touches[0];
          window.__finger = { x: p.clientX, y: p.clientY };
        },
        { capture: true, passive: true },
      );
    });
  const seenAt = (x, y) =>
    page.waitForFunction(
      ([x, y]) => Math.abs(window.__finger.x - x) < 1 && Math.abs(window.__finger.y - y) < 1,
      [x, y],
      { polling: 50, timeout: 5000 },
    );
  const touchDrag = async (sel, by, n = 8, every = 40, hold = 0, { check = null, cancel = false } = {}) => {
    const b = await steady(page.locator(sel)),
      x = b.x + b.width / 2,
      y = b.y + b.height / 2;
    if (check) await watch();
    await touch('touchStart', x, y);
    if (hold) await page.waitForTimeout(hold);
    const t0 = Date.now();
    for (let i = 1; i <= n; i++) await touch('touchMove', x, y + (by * i) / n, t0 + i * every);
    // The touch ends even if the check fails, so the next touch starts clean.
    try {
      if (check) {
        await seenAt(x, y + by);
        await check();
      }
    } finally {
      await touch(cancel ? 'touchCancel' : 'touchEnd', x, y + by, t0 + n * every + 8);
    }
    // The release is stamped ahead of the clock. Waiting until its time makes the next touch come after it, as a
    // finger's does. Chrome sometimes drops a tap sent before then, so the tap opens nothing.
    await page.waitForTimeout(Math.max(0, t0 + n * every + 8 - Date.now()));
  };
  /* Playwright's own Chromium (no BROWSER_CHANNEL) sometimes makes no click from a tap, about one tap in ten late in
     smoke.mjs. No mousedown or click reaches the page then, so Pocket never sees the tap. tap() sends the tap again
     when no click arrives within a second, up to three times. */
  const tap = async (x, y) => {
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => {
        window.__tapped = false;
        addEventListener('click', () => (window.__tapped = true), { capture: true, once: true });
      });
      await touch('touchStart', x, y);
      await touch('touchEnd', x, y);
      try {
        return void (await page.waitForFunction(() => window.__tapped, null, { polling: 50, timeout: 1000 }));
      } catch {}
    }
    throw new Error('three taps made no click');
  };
  return { touch, touchDrag, tap };
}

/* The layer a swiped row uncovers (lay, app/progress.js). The layer stays still under the row. It is placed in the
   box that positions the row, not inside the row. Only one row is swiped at a time, so the layer is found by its
   kind: the progress stops on green ('.row-prog'), or the red Delete layer with its button ('.row-red'). */
export const uncovered = (page, kind = '.row-prog') => page.locator(`${kind}.row-under`);
/* Measures how row `sel`, swiped and still held, sits over the layer it uncovers. `x` is how far the row has moved
   sideways. `inside` is whether the layer is inside the row, which it must not be. `off` is how far the layer's box is
   from the row's resting position, and 0 means the layer is exactly under the row whatever the row's indent. `ring` is
   the distance from the ring to the edge of the layer where the ring is uncovered. */
export const laidUnder = (page, sel, kind = '.row-prog') =>
  page.locator(sel).evaluate((row, kind) => {
    const u = document.querySelector(`${kind}.row-under`);
    if (!u) return null;
    const x = new DOMMatrix(getComputedStyle(row).transform).m41,
      a = row.getBoundingClientRect(),
      b = u.getBoundingClientRect(),
      ring = u.querySelector('.ring')?.getBoundingClientRect();
    return {
      x,
      inside: row.contains(u),
      ring: ring ? (u.dataset.side === 'right' ? b.right - ring.right : ring.left - b.left) : null,
      off: Math.max(
        Math.abs(b.left - (a.left - x)),
        Math.abs(b.width - a.width),
        Math.abs(b.top - a.top - row.clientTop),
        Math.abs(b.height - row.clientHeight),
      ),
    };
  }, kind);
/* Records row `sel` frame by frame for `ms` from now, starting when the user releases it. Each frame has:
   `x` (how far the row has moved sideways) and `w` (its width). While a layer is under the row: `ring` (the left edge
   of the ring or of the Delete text, on the screen), `under` (the layer's width) and `right` (the layer's right edge).
   `moving` lists everything on the page that is moving or changing size: 'row:transform' for the row's own transform,
   otherwise the element's class and the properties that change. Also whether the row is still in its list:
   `there` (still on the page), `at` (its index among the list's rows, the first is 0), `rows` (how many rows the
   list has) and `gap` (whether its "Deleted" gap is drawn, which never happens for a done row). A card's top row that
   is released must stay the top row, with no other row moving up meanwhile. Only the row should move, in one
   animation of its transform, over a layer that stays still. slideSeen() waits for the frames. still(frames) returns a
   sentence describing what else moved, or '' if nothing did. */
export const watchSlide = (page, sel, ms = 700) =>
  page.locator(sel).evaluate((row, ms) => {
    const seen = (window.__slide = []),
      t0 = performance.now(),
      moves =
        /^(transform|translate|scale|rotate|width|height|left|right|top|bottom|inset|margin|padding|flex|justify|align)/i;
    const own = k => !['offset', 'computedOffset', 'easing', 'composite'].includes(k),
      list = row.parentElement;
    window.__slid = false;
    (function look() {
      const u = document.querySelector('.row-under'),
        mark = u?.querySelector('.ring, .row-del'),
        box = u?.getBoundingClientRect();
      const rows = [...list.querySelectorAll(':scope > .row')],
        gap = row.querySelector(':scope > .del-gap');
      seen.push({
        x: new DOMMatrix(getComputedStyle(row).transform).m41,
        w: row.clientWidth,
        ring: mark ? mark.getBoundingClientRect().left : null,
        under: u ? box.width : null,
        right: u ? box.right : null,
        there: row.isConnected,
        at: rows.indexOf(row),
        rows: rows.length,
        gap: !!gap && getComputedStyle(gap).display !== 'none',
        moving: document
          .getAnimations()
          .filter(a => a.playState === 'running')
          .map(a => [a.effect?.target, Object.keys(a.effect?.getKeyframes()[0] || {}).filter(own)])
          .filter(([, keys]) => keys.some(k => moves.test(k)))
          .map(([el, keys]) => (el === row ? 'row' : String(el?.className)) + ':' + keys.join('+')),
      });
      if (performance.now() - t0 < ms) requestAnimationFrame(look);
      else window.__slid = true;
    })();
  }, ms);
export const slideSeen = async page => {
  await page.waitForFunction(() => window.__slid, null, { polling: 100 });
  return page.evaluate(() => window.__slide);
};
export function still(frames) {
  const laid = frames.filter(s => s.under !== null),
    spread = k => Math.max(...laid.map(s => s[k])) - Math.min(...laid.map(s => s[k]));
  const others = [...new Set(frames.flatMap(s => s.moving))].filter(m => m !== 'row:transform');
  if (others.length) return "more than the row's transform moved: " + others.join(', ');
  if (!laid.length) return 'nothing was laid under the row';
  for (const [k, what] of [
    ['ring', "what's on the layer under the row moved"],
    ['under', 'the layer under the row changed size'],
    ['right', "the layer's right edge moved"],
  ])
    if (spread(k) > 0.01) return `${what}: ${[...new Set(laid.map(s => s[k]))].join(', ')}`;
  return '';
}

/* Dismisses the one-time hold-and-slide hint, as if the user had already slid a row. Otherwise the hint adds a line to
   the first row of each screen, which tests that measure rows don't expect. It applies to every page of `context`
   from the start. */
export const hintSeen = context =>
  context.addInitScript(() => {
    try {
      localStorage.setItem('pocket.hint.slide', 'done');
    } catch {}
  });

/* Swipes across row `sel` (press, move, release, with no hold, as a touch on a phone does) so that releasing does
   `to`. `to` is a progress such as 25, or 100 for done (a full swipe right). It can also be 'open' (a row at 0%
   swiped left until it rests open on its Delete), 'delete' (swiped left past half the row, which deletes it) or
   'back' (a parent's header swiped a little to the right, which springs back). The distance comes from the app's own
   calculation (swipeAt), so a change to its numbers (SIDES) doesn't break any test. The swipe is released in the middle
   of the range of distances that does `to`, or a little past the full point. A swipe right starts near the row's left
   edge and a swipe left near its right edge, so each direction has space to move. `start` is the row's progress when
   the swipe starts (100 for a done row). `one` is for a parent's header or row, whose right side only has its full
   point. `check` runs while the swipe is held. By default the mouse is used, which the page treats as a touch but
   which never meets the phone's touch rules. Pass `finger` (finger(page).touch) to swipe with real touch events. `from`
   is a selector inside the row to start the swipe on, at its centre. */
export async function swipeRow(
  page,
  sel,
  to,
  { start = 0, one = false, check = null, finger = null, from = null } = {},
) {
  const el = page.locator(sel);
  await el.evaluate(e => e.scrollIntoView({ block: 'center', behavior: 'instant' }));
  const box = await steady(el),
    width = await el.evaluate(e => e.clientWidth),
    screen = page.viewportSize().width,
    on = from && (await el.locator(from).first().boundingBox());
  const right = to === 'back' || (typeof to === 'number' && to > start),
    x = on ? on.x + on.width / 2 : right ? box.x + 60 : box.x + box.width - 40,
    y = on ? on.y + on.height / 2 : box.y + Math.min(box.height / 2, 28);
  const wants = r =>
    to === 'back'
      ? r.to === 'stop' && r.off > 20
      : to === 'open' || to === 'delete'
        ? r.to === to
        : to >= 100
          ? r.to === 'done'
          : r.to === 'stop' && r.pct === to;
  const band = [];
  for (let d = 1; d <= width; d++) {
    const r = swipeAt({ start, dx: right ? d : -d, x, width, screen, del: true, one, side: right ? 'right' : 'left' });
    if (wants(r)) band.push(d);
    else if (band.length) break;
  }
  if (!band.length) throw new Error(`no swipe distance on ${sel} from ${start}% ends at ${to}`);
  const full = to === 'delete' || to >= 100 || (to === 0 && start > 0),
    dx = full ? band[0] + 16 : band[Math.floor(band.length / 2)];
  if (finger) {
    const x1 = x + (right ? dx : -dx),
      t0 = Date.now();
    await finger('touchStart', x, y, t0);
    for (let i = 1; i <= 10; i++) await finger('touchMove', x + ((x1 - x) * i) / 10, y + 2, t0 + i * 16);
    try {
      await check?.();
    } finally {
      await finger('touchEnd', x1, y + 2, t0 + 180);
    }
    return;
  }
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + (right ? dx : -dx), y + 2, { steps: 10 });
  await check?.();
  await page.mouse.up();
}
