// End-to-end test of Pocket as served by the Vikunja plugin, against that Vikunja.
//
//   VIKUNJA_URL=https://tasks.example.com VIKUNJA_USER=... VIKUNJA_PASSWORD=... VIKUNJA_TOKEN=tk_... npm run test:smoke
//   npm run test:local        (starts a local Vikunja with the plugin and runs everything against it)
//
// Opens <VIKUNJA_URL>/api/v1/plugins/pocket/, signs in as VIKUNJA_USER, then creates, edits, completes and deletes
// throwaway tasks (including a pasted list with subtasks). It tags one with a "pocket-smoke" label, which it
// creates on the first run and reuses after that. The test's own requests to Vikunja use VIKUNJA_TOKEN, an API token
// of the same user with every permission.
// Optional settings:
// POCKET_URL if Pocket is served from somewhere else.
// ASSIGNEE=<username> to test @assignee.
// ASSIGNEE_PROJECT=<name> of a project shared with that user.
// BROWSER_CHANNEL=msedge|chrome (default: Playwright's Chromium).
// OUT=<dir> for screenshots.
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { shortTime } from '../src/js/dates.js';
import {
  expect,
  finger,
  hintSeen,
  laidUnder,
  loaded,
  noToast,
  placeLine,
  placeSays,
  rowLine,
  signIn,
  slideSeen,
  steady,
  stepper,
  still,
  swipeRow,
  synced,
  toast,
  toastGone as toastGoneOn,
  uncovered,
  watchSlide,
} from './helpers.mjs';

const SERVER = (process.env.VIKUNJA_URL || '').replace(/\/+$/, '');
const ASSIGNEE = process.env.ASSIGNEE; // optional username to assign
const ASSIGNEE_PROJECT = process.env.ASSIGNEE_PROJECT; // a project shared with ASSIGNEE (default: the default project)
const TOKEN = process.env.VIKUNJA_TOKEN,
  USER = process.env.VIKUNJA_USER,
  PASSWORD = process.env.VIKUNJA_PASSWORD;
const OUT = process.env.OUT || 'test-results';
if (!SERVER || !TOKEN || !USER || !PASSWORD) {
  console.error('Set VIKUNJA_URL, VIKUNJA_TOKEN, VIKUNJA_USER and VIKUNJA_PASSWORD');
  process.exit(2);
}
const APP = process.env.POCKET_URL || SERVER + '/api/v1/plugins/pocket/';

// Vikunja on SQLite sometimes answers 500 "database is locked" when a request arrives while the previous one is still
// being written. The test retries its own requests, as Pocket does.
const api = async (path, init = {}) => {
  for (let i = 0; ; i++) {
    const r = await fetch(SERVER + '/api/v2' + path, {
      ...init,
      headers: { Authorization: 'Bearer ' + TOKEN, ...init.headers },
    });
    if (init.method === 'DELETE' && /^\/tasks\/\d+$/.test(path)) goneOnPurpose.push(+path.split('/').pop());
    if (r.status !== 500 || i >= 4) return r;
    await new Promise(res => setTimeout(res, 300 * (i + 1)));
  }
};

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await hintSeen(context); // the one-time hint gets its own test and its own phone
// The page uses Playwright's clock. It follows real time, and later() moves it forward instead of waiting.
await context.clock.install();
const page = await context.newPage();
const errors = [];
/* Moves the page's clock forward by `ms` at once. Timers that fall due run (a toast disappearing, Today's minute tick).
   Then the clock is reset to real time, which is what Vikunja's dates use. */
const later = async ms => {
  await page.clock.fastForward(Math.max(0, Math.round(ms)));
  await page.clock.setSystemTime(Date.now());
};
/* The browser logs the refusals and connection resets the tests cause on purpose, so they are ignored here: an error
   the test answers itself (its URL in `refused`), and a 404 for a task in `goneOnPurpose`, which a test has Pocket read
   or delete after it is gone. A task the test deleted is in it, because the catch-up reads such a task alone to learn
   that it is gone. */
const goneOnPurpose = [],
  refused = new Set();
const meant = m =>
  /ERR_CONNECTION_RESET/.test(m.text()) ||
  refused.has(m.location()?.url) ||
  (/status of 404/.test(m.text()) && goneOnPurpose.some(id => (m.location()?.url || '').endsWith('/tasks/' + id)));
page.on(
  'console',
  m =>
    m.type() === 'error' && !meant(m) && errors.push(m.text() + (m.location()?.url ? ' at ' + m.location().url : '')),
);
page.on('pageerror', e => errors.push(String(e)));
page.on('dialog', d => d.accept());

const steps = stepper(name => page.screenshot({ path: `${OUT}/fail-${name}.png` })),
  { step, setup } = steps;

const stamp = Date.now();
const title = 'Pocket smoke test ' + stamp;
const label = 'pocket-smoke';
const createdProjects = [];
// The card on Today for a task that has open subtasks, found by title. `opener` is what opens a task on Today: the
// row's title, or the card's header.
const cardOf = t => `.day-card:has(> .card-head .card-title:has-text("${t}"))`;
const opener = t => `:is(.row > .body:has(.title:has-text("${t}")), ${cardOf(t)} > .card-head)`;
// The body of a row whose task Vikunja has made. A waiting row's id starts with "pending-".
const sentRow = t => `.row:not([data-id^="pending-"]) > .body:has(.title:has-text("${t}"))`;

try {
  await step('a-server-with-no-sign-in-method-says-so', async () => {
    const none = r =>
      r.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          version: 'v2.7.1',
          auth: { local: { enabled: false }, ldap: { enabled: false }, openid_connect: { enabled: false } },
        }),
      });
    await page.route('**/api/v2/info', none);
    await page.goto(APP);
    await expect(page.locator('#auth-step')).toContainText(
      'This server has password sign-in and single sign-on turned off. Ask its admin to turn one on.',
    );
    await expect(page.locator('#f-pass')).toBeHidden();
    await page.unroute('**/api/v2/info', none);
  });
  await step('sign-in-is-disabled-until-a-username-and-password-are-entered', async () => {
    await page.goto(APP);
    await expect(page.locator('#auth-step')).toBeVisible();
    const go = page.getByRole('button', { name: 'Sign in', exact: true });
    await expect(go).toBeDisabled();
    await page.getByLabel('Username or email').fill('   ');
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await expect(go).toBeDisabled();
    await page.getByLabel('Username or email').fill(USER);
    await expect(go).toBeEnabled();
  });
  await setup('sign-in-with-a-password', () => signIn(page, APP, USER, PASSWORD));
  await page.screenshot({ path: `${OUT}/today.png` });

  await setup('quick-add', async () => {
    await page.fill('#in-capture', `${title} tomorrow at 5pm !3 *${label}`);
    const chips = await page.textContent('#cap-chips');
    if (!/Tomorrow/.test(chips) || !/Priority 3/.test(chips)) throw new Error('chips: ' + chips);
    await page.click('#f-capture .go');
    // The row appears in the list at once, before it is sent. It is highlighted once Vikunja has it.
    await expect(
      page.locator(`.row.fresh:has(.title:has-text("${title}"))`),
      "the new row isn't highlighted",
    ).toBeVisible({ timeout: 15000 });
  });
  const row = `.row:has(.title:has-text("${title}"))`;
  await step('refresh-keeps-rows', async () => {
    const before = await page.$(row);
    // While Vikunja is slow to answer, the rows stay on screen and no grey rows replace them.
    let answer;
    const late = new Promise(ok => (answer = ok)),
      slow = async r => {
        await late;
        await r.fallback();
      };
    await page.route(/\/api\/v2\/tasks\?/, slow);
    try {
      await page.click('#btn-refresh');
      await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'true');
      await expect(page.locator(row)).toBeVisible();
      await expect(page.locator('#view .skel-row')).toHaveCount(0);
    } finally {
      answer();
      await page.unroute(/\/api\/v2\/tasks\?/, slow);
    }
    await page.waitForSelector('#btn-refresh:not([disabled])');
    if (!(await before.evaluate(el => el.isConnected))) throw new Error('refresh rebuilt the list');
  });
  await step('refresh-loads-a-new-version', async () => {
    // A second tab whose copy of Pocket has another build id than the server's copy.
    const old = await page.context().newPage();
    await old.goto(APP);
    await old.waitForSelector(row, { timeout: 15000 });
    await old.evaluate(() => {
      window.marker = 1;
      document.querySelector('meta[name="pocket-build"]').content = 'old';
    });
    // Typed text blocks the reload, so the list refreshes in place instead.
    await old.fill('#in-capture', 'half-typed');
    await old.click('#btn-refresh');
    await old.waitForSelector('#btn-refresh:not([disabled])');
    await old.waitForTimeout(500);
    if (!(await old.evaluate(() => window.marker)) || (await old.inputValue('#in-capture')) !== 'half-typed')
      throw new Error('reloaded over typed text');
    await old.fill('#in-capture', '');
    await old.click('#btn-refresh');
    await old.waitForFunction(() => !window.marker, null, { timeout: 10000 });
    await old.waitForSelector(row, { timeout: 15000 });
    await old.close();
  });
  /* The plugin sends the build's compressed copy of the page to browsers that accept it: brotli, else gzip. Each copy
     must decode to the same page, the response must carry Vary: Accept-Encoding, and the compressed files must not
     be reachable by their own file names. */
  await step('the-plugin-sends-the-page-compressed', async () => {
    const get = (url, enc) =>
      new Promise((ok, fail) =>
        (url.startsWith('https:') ? https : http)
          .get(url, { headers: { 'Accept-Encoding': enc } }, res => {
            const parts = [];
            res.on('data', b => parts.push(b));
            res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
          })
          .on('error', fail),
      );
    const plain = await get(APP, 'identity');
    if (plain.status !== 200 || plain.headers['content-encoding'] || !plain.body.includes('<html'))
      throw new Error(
        `the uncompressed page has status and encoding: ${plain.status} ${plain.headers['content-encoding']}`,
      );
    for (const [enc, decode] of [
      ['br', brotliDecompressSync],
      ['gzip', gunzipSync],
    ]) {
      const r = await get(APP, enc);
      if (r.headers['content-encoding'] !== enc)
        throw new Error(`asked for ${enc}, sent ${r.headers['content-encoding']}`);
      if (!/accept-encoding/i.test(r.headers.vary || '')) throw new Error('Vary: ' + r.headers.vary);
      if (!decode(r.body).equals(plain.body)) throw new Error(`the ${enc} page decodes to a different page`);
      if (r.body.length >= plain.body.length / 2)
        throw new Error(`the ${enc} page is ${r.body.length} bytes of ${plain.body.length}`);
    }
    for (const name of ['index.html.br', 'index.html.gz'])
      if ((await get(APP + name, 'br')).status !== 404) throw new Error(name + ' is reachable by its file name');
  });

  await step('right-click-and-Shift-F10-open-the-task-menu', async () => {
    const body = page.locator(row + ' > .body');
    await body.click({ button: 'right' });
    await expect(page.getByRole('menu')).toBeVisible();
    await expect(page.locator('#d-share-text')).toBeFocused();
    await expect(page.locator('#d-delete')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('#sheet')).toBeHidden();
    await body.focus();
    await body.press('Shift+F10');
    await expect(page.getByRole('menu')).toBeVisible();
    await expect(page.locator('#d-copy-md')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(page.locator('#sheet')).toBeHidden();
  });
  await step('tick-in-list-and-tick-again', async () => {
    // A ticked row stays in place, marked done, until all the ticked rows leave together. Tapping its tick again
    // reopens it. Each tap makes the phone vibrate: a firmer pattern for done, a light one for reopening.
    await page.evaluate(() => {
      window.__felt = [];
      navigator.vibrate = p => {
        window.__felt.push(p);
        return true;
      };
    });
    const felt = () => page.evaluate(() => JSON.stringify(window.__felt));
    await page.click(`${row} .check`);
    await expect(page.locator(row)).toHaveClass(/\bleaving\b/);
    await expect(page.locator(row)).toHaveClass(/\bdone\b/);
    if ((await felt()) !== '[[14,60,24]]') throw new Error('tapping a tick to mark done vibrated ' + (await felt()));
    // The row is marked ticked from the tap. A screen reader announces it once it is saved.
    await expect(page.locator('#said')).toHaveText(new RegExp('^Done: ' + title));
    if (await page.$('#toast.show #toast-msg:has-text("Done")'))
      throw new Error('a tick in a list showed a toast: ' + (await page.textContent('#toast-msg')));
    await page.click(`${row} .check`);
    await expect(page.locator(row)).not.toHaveClass(/\bleaving\b/);
    if (await page.$eval(row, el => el.classList.contains('done')))
      throw new Error('the row is still marked done after tapping its tick again');
    if ((await felt()) !== '[[14,60,24],6]') throw new Error('tapping the tick again vibrated ' + (await felt()));
    await page.evaluate(() => {
      delete navigator.vibrate;
    });
  });
  // Swipes a row from `from`% to `to`% (100 is a full swipe, which marks it done), with no hold, as a touch would (swipeRow).
  const slideProgress = (sel, to, check, from = 0) => swipeRow(page, sel, to, { start: from, check });
  // The progress shown by a row's tick (its pie, the --pct property) as a percentage.
  const tickPct = sel =>
    page.locator(sel).evaluate(el => Math.round(parseFloat(getComputedStyle(el).getPropertyValue('--pct')) * 100));
  // Counts the animations on `sel` and inside it, running or set by the stylesheet. A bounce or a pulse would count.
  const moving = sel =>
    page
      .locator(sel)
      .evaluate(
        el =>
          el.getAnimations({ subtree: true }).length +
          [el, ...el.querySelectorAll('*')].filter(x => getComputedStyle(x).animationName !== 'none').length,
      );
  const apiTask = async () =>
    (await (await api('/tasks?q=' + encodeURIComponent(title))).json()).items.find(t => t.title === title);
  /* A plain swipe right with no hold. The row follows the touch, and the space it uncovers shows the progress that
     releasing would set, with the ring filling a quarter at a time. Nothing on the row changes until release. Only the
     row moves. The uncovered space is a separate layer that stays still under the row, with the ring at the list's
     edge. Releasing before the first stop changes nothing, and neither does dragging back to the start. */
  await step('progress-by-a-plain-swipe-right', async () => {
    await slideProgress(row, 50, async () => {
      await expect(page.locator(`${row}.revealing`)).toHaveCount(1);
      await expect(uncovered(page)).toHaveAttribute('data-pct', '50');
      await expect(uncovered(page)).not.toHaveClass(/\bfull\b/);
      const lies = await laidUnder(page, row);
      if (lies.inside || lies.off > 0.5 || lies.x < 20 || lies.ring !== 10)
        throw new Error('the space under the row does not stay still beneath it: ' + JSON.stringify(lies));
      // The ring's pie only steps from stop to stop. Nothing bounces.
      if (await moving('.row-prog.row-under')) throw new Error('the ring moved at a stop');
      if ((await tickPct(row)) !== 0)
        throw new Error("the row's tick changed while it was swiped: " + (await tickPct(row)));
      if ((await page.locator('#said').textContent()) === `Progress of ${title} set to 50%`)
        throw new Error('the progress was announced before the row was released');
    });
    await expect(page.locator('#said')).toHaveText(`Progress of ${title} set to 50%`);
    await noToast(page);
    if (await page.isVisible('#sheet')) throw new Error('releasing the row opened the task');
    await expect(uncovered(page)).toHaveCount(0); // the row covers the space again, and the space is removed
    await expect(page.locator(row)).not.toHaveClass(/\brevealing\b/);
    if (await page.locator(row).evaluate(el => el.style.transform))
      throw new Error('the row is still moved aside after release');
    await expect.poll(() => tickPct(row)).toBe(50); // the tick shows a half pie
    const pie = await page.locator(`${row} > .check`).evaluate(el => getComputedStyle(el).backgroundImage);
    if (!/^conic-gradient\(/.test(pie)) throw new Error('the tick has no pie: ' + pie);
    await synced(page);
    if (Math.round((await apiTask()).percent_done * 100) !== 50)
      throw new Error('saved percent_done ' + (await apiTask()).percent_done);
    // Starting from the right of the row, a full swipe still fits before the screen's edge. Dragging back to the start
    // and releasing changes nothing, and does not turn the swipe into a delete.
    const box = await page.locator(row).boundingBox(),
      x = box.x + box.width * 0.9,
      y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(page.viewportSize().width - 4, y + 3, { steps: 8 });
    await expect(uncovered(page)).toHaveClass(/\bfull\b/);
    await page.mouse.move(x - 60, y, { steps: 8 });
    if (await page.$(`${row}.swiping, ${row}.swipe-full`))
      throw new Error('dragging back past the start turned the swipe into a delete');
    await page.mouse.up();
    // Releasing before the first stop changes nothing.
    await page.mouse.move(box.x + 60, y);
    await page.mouse.down();
    await page.mouse.move(box.x + 75, y + 1, { steps: 4 });
    await page.mouse.up();
    if (await page.isVisible('#sheet')) throw new Error('releasing the row opened the task');
    await synced(page);
    if (Math.round((await apiTask()).percent_done * 100) !== 50)
      throw new Error('releasing at the start saved the progress ' + (await apiTask()).percent_done);
    await expect.poll(() => tickPct(row)).toBe(50);
    // On Today, holding a row does not pick it up for reordering. The row lifts in place, date chips appear around
    // the touch, and nothing follows the touch. Releasing where the hold started changes nothing.
    const due = (await apiTask()).due_date;
    await page.mouse.move(box.x + 100, y);
    await page.mouse.down();
    await later(700);
    await expect(page.locator(row)).not.toHaveClass(/\bheld\b/);
    await expect(page.locator(row)).toHaveClass(/\bthrow-from\b/);
    await page.mouse.move(box.x + 100, y + 60, { steps: 5 });
    await expect(page.locator('#view .dragged')).toHaveCount(0);
    await page.mouse.move(box.x + 101, y + 2, { steps: 5 });
    await page.mouse.up();
    await expect(page.locator('.throw')).toHaveCount(0);
    if (await page.isVisible('#sheet')) throw new Error('releasing the row opened the task');
    await synced(page);
    if ((await apiTask()).due_date !== due)
      throw new Error('holding and releasing in the same place changed the due date to ' + (await apiTask()).due_date);
  });
  /* A full swipe right marks the task done. The row glides off the screen, then shows in place as done, with no gap,
     until the batch clears. Only `done` is sent, so tapping the tick restores the old progress. Only the row moves,
     in one transform animation, over the green and the ✓, which stay where they are. Tapping the tick of a
     partly done task marks it done whatever its progress. Tapping it again reopens it with its old progress. */
  await step('a-full-swipe-is-done-as-a-tick-is-and-a-partly-done-tick-ticks', async () => {
    const sent = page.waitForRequest(
      r => r.method() === 'PATCH' && /\/tasks\/\d+$/.test(r.url()) && JSON.parse(r.postData() || '{}').done === true,
    );
    const h = await page.locator(row).evaluate(el => el.offsetHeight);
    await slideProgress(
      row,
      100,
      async () => {
        await expect(uncovered(page)).toHaveClass(/\bfull\b/);
        // Past half, the green is solid and the ring becomes a ✓, with no pop.
        if (await moving('.row-prog.row-under')) throw new Error('the ring popped past half');
        await watchSlide(page, row);
      },
      50,
    );
    const body = JSON.parse((await sent).postData());
    if ('percent_done' in body) throw new Error('the done request also sent the progress: ' + JSON.stringify(body));
    // After release, frame by frame, the row moves right and off the screen. The ✓ under it never moves, the green
    // does not change size, and nothing else on the page moves.
    const slid = await slideSeen(page);
    if (Math.max(...slid.map(s => s.x)) < 0.9 * slid[0].w)
      throw new Error(`the row went only to ${Math.max(...slid.map(s => s.x))}px of ${slid[0].w}`);
    if (!slid.some(s => s.moving.includes('row:transform'))) throw new Error('the row never glided: it only jumped');
    if (still(slid)) throw new Error('as the row left, ' + still(slid));
    await expect(uncovered(page)).toHaveCount(0); // the green fades out over the row, which is done
    await expect(page.locator(row)).toHaveClass(/\bdone\b/);
    await expect(page.locator(`${row} > .del-gap`)).toHaveCount(0);
    await expect(page.locator(`${row} .title`)).toBeVisible(); // the title stays visible, struck through like a ticked row
    const undo = page.locator(row).getByRole('button', { name: 'Mark not done: ' + title, exact: true });
    await expect(undo).toBeVisible();
    if ((await page.locator(row).evaluate(el => el.offsetHeight)) !== h) throw new Error('the row height changed');
    await undo.click();
    await expect(page.locator(row)).not.toHaveClass(/\bdone\b/);
    await synced(page);
    let t = await apiTask();
    if (t.done || Math.round(t.percent_done * 100) !== 50)
      throw new Error(`after tapping the tick: done ${t.done}, percent_done ${t.percent_done}`);
    await expect.poll(() => tickPct(row)).toBe(50);
    // A half-filled tick marks the task done when tapped (only `done` is sent). Tapping again reopens it at 50%.
    const ticked = page.waitForRequest(
      r => r.method() === 'PATCH' && /\/tasks\/\d+$/.test(r.url()) && JSON.parse(r.postData() || '{}').done === true,
    );
    await page.getByRole('button', { name: 'Mark done: ' + title, exact: true }).click();
    await expect(page.locator(row)).toHaveClass(/\bdone\b/);
    if ('percent_done' in JSON.parse((await ticked).postData()))
      throw new Error('tapping the tick also sent the progress');
    await page.getByRole('button', { name: 'Mark not done: ' + title, exact: true }).click();
    await expect(page.locator(row)).not.toHaveClass(/\bleaving\b/);
    await synced(page);
    t = await apiTask();
    if (t.done || Math.round(t.percent_done * 100) !== 50)
      throw new Error(`after ticking again: done ${t.done}, percent_done ${t.percent_done}`);
    await expect.poll(() => tickPct(row)).toBe(50);
  });
  // This moves every overdue task of the test account to today, then puts them back with Undo.
  await step('move-overdue-to-today-and-undo', async () => {
    const me = await (await api('/user')).json();
    const due = new Date();
    due.setDate(due.getDate() - 2);
    due.setHours(9, 0, 0, 0);
    const late = 'Pocket smoke overdue ' + stamp;
    const made = await (
      await api(`/projects/${me.settings.default_project_id}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: late, due_date: due.toISOString() }),
      })
    ).json();
    // A repeating task is not moved, because its next due dates would follow the new date.
    const daily = await (
      await api(`/projects/${me.settings.default_project_id}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Pocket smoke repeats ' + stamp,
          due_date: due.toISOString(),
          repeat_after: 86400,
        }),
      })
    ).json();
    const lateRow = `.row:has(.title:has-text("${late}"))`;
    await page.click('#btn-refresh');
    await page.waitForSelector(`.sec.overdue ~ .list ${lateRow}`, { timeout: 15000 });
    // The button's 44px target fits inside the Overdue heading, which is as tall as a heading without a button.
    const [head, act] = [
      await page.locator('.sec.overdue').boundingBox(),
      await page.locator('#btn-overdue-today').boundingBox(),
    ];
    if (Math.round(head.height) !== 21 || Math.round(act.height) !== 44)
      throw new Error(`the Overdue heading is ${head.height}px tall and its button ${act.height}px`);
    await page.click('#btn-overdue-today');
    await page.waitForSelector(`.sec.today ~ .list ${lateRow}`, { timeout: 15000 });
    // A message with an Undo button appears under the Overdue heading, which stays in place meanwhile.
    await expect(placeLine(page, 'overdue')).toContainText(/^Moved \d+ to today\. \d+ repeating tasks? stays?\. Tick/);
    await expect(placeLine(page, 'overdue').getByRole('button', { name: 'Undo' })).toBeVisible();
    await noToast(page);
    await synced(page); // the moves are sent after the rows move
    if (new Date((await (await api('/tasks/' + daily.id)).json()).due_date).getTime() !== due.getTime())
      throw new Error('the repeating task was moved');
    await api('/tasks/' + daily.id, { method: 'DELETE' });
    // The task keeps its 9:00 time. If 9:00 has already passed today, it is due today with no time.
    const want = new Date();
    want.setHours(9, 0, 0, 0);
    if (want < new Date()) want.setHours(0, 0, 0, 0);
    const moved = new Date((await (await api('/tasks/' + made.id)).json()).due_date);
    if (moved.getTime() !== want.getTime()) throw new Error('moved to ' + moved);
    await placeLine(page, 'overdue').getByRole('button', { name: 'Undo' }).click();
    await page.waitForSelector(`.sec.overdue ~ .list ${lateRow}`, { timeout: 15000 });
    await synced(page);
    const back = new Date((await (await api('/tasks/' + made.id)).json()).due_date);
    if (back.getTime() !== due.getTime()) throw new Error('Undo moved the task to ' + back);
  });
  await step('search', async () => {
    await page.click('#btn-search');
    if (!(await page.evaluate(() => document.activeElement?.id === 'in-search')))
      throw new Error("the search box isn't focused");
    await page.waitForSelector('#capture', { state: 'hidden', timeout: 5000 }).catch(() => {
      throw new Error('the add box still shows');
    });
    await page.fill('#in-search', String(stamp));
    await page.waitForSelector(`#view .sec:has-text("Open") ~ .list ${row}`, { timeout: 10000 });
    await page.click('#btn-search-cancel');
    await page.waitForSelector('#capture:not([hidden])');
    if ((await page.getAttribute('nav.tabs a[data-tab=today]', 'aria-current')) !== 'page')
      throw new Error("Cancel didn't go back to Today");
  });
  await step('upload-html-attachment', async () => {
    const found = (await (await api('/tasks?q=' + encodeURIComponent(title))).json()).items;
    const id = found.find(t => t.title === title)?.id;
    if (!id) throw new Error('task not found');
    const form = new FormData();
    form.append('files', new Blob(['<script>document.title="pwned"</script>'], { type: 'text/html' }), 'evil.html');
    const r = await api(`/tasks/${id}/attachments`, { method: 'POST', body: form });
    if (!r.ok) throw new Error('upload HTTP ' + r.status);
  });
  await step('open-task', async () => {
    await page.click(`.row .body:has-text("${title}")`);
    await page.waitForSelector('#d-comments .comment-form', { timeout: 10000 });
    const labels = await page.textContent('.prop:has(.k:text("Labels"))');
    if (!labels.includes(label)) throw new Error('label missing: ' + labels);
  });
  await step('comment', async () => {
    await expect(page.locator('#d-cform button')).toBeDisabled();
    await page.fill('#d-cin', '   ');
    await expect(page.locator('#d-cform button')).toBeDisabled();
    await page.fill('#d-cin', 'smoke comment');
    await expect(page.locator('#d-cform button')).toBeEnabled();
    await page.click('#d-cform button');
    await page.waitForSelector('.comment:has-text("smoke comment")', { timeout: 10000 });
    await expect(page.locator('#d-cform button')).toBeDisabled();
  });
  await step('html-attachment-downloads', async () => {
    const popups = [];
    page.context().on('page', p => popups.push(p));
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 10000 }),
      page.click('.att:has-text("evil.html")'),
    ]);
    if (download.suggestedFilename() !== 'evil.html') throw new Error('downloaded ' + download.suggestedFilename());
    if (popups.length) throw new Error('attachment opened in a new tab');
  });
  await step('row-details', async () => {
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    await page.click('#btn-refresh');
    await page.waitForSelector('#btn-refresh:not([disabled])');
    // On Today a row is one line: small priority bars, then a short due time, and the project's dot at the right of
    // the title. The tick's ring does not show the priority. Counts are not shown. A screen reader still announces the
    // priority, the due time in words and the project. The task's label is on a line of its own, 20px under it.
    const R = page.locator(row);
    await expect(R).toHaveClass(/\bone-line\b/);
    await expect(R.locator('.when > .bars.p3 ~ .due')).toHaveText(/\S/);
    const ring = await R.locator('> .check').evaluate(el => getComputedStyle(el).borderTopColor);
    const plain = await page.evaluate(() => {
      const b = document.createElement('button');
      b.className = 'check';
      document.body.append(b);
      const c = getComputedStyle(b).borderTopColor;
      b.remove();
      return c;
    });
    if (ring !== plain) throw new Error(`the tick's ring colour is ${ring}, not ${plain}`);
    await expect(R.locator('.when .dot')).toHaveCount(1);
    await expect(R.locator('.meta')).toHaveCount(0);
    const said = await R.locator('.title .sr').allTextContents();
    if (!said.some(s => /Priority: High/.test(s) && /Due |Late: /.test(s)))
      throw new Error('a screen reader hears ' + JSON.stringify(said));
    await expect(R.locator('> .labs > .lab')).toHaveText([label]);
    if ((await R.evaluate(el => el.offsetHeight)) > 77)
      throw new Error(
        'a row on Today is more than a line and its labels: ' + (await R.evaluate(el => el.offsetHeight)),
      );
    // On the project's list the row has a second line with the priority bars, the comment count and the attachment count.
    await page.evaluate(
      id => {
        location.hash = '#/project/' + id;
      },
      (await apiTask()).project_id,
    );
    await expect(page.locator(`#view ${row} .meta [aria-label="Comments"]`)).toHaveText('1', { timeout: 15000 });
    const meta = await page.$$eval(`#view ${row} .meta > span[aria-label]`, els =>
      els.map(e => e.getAttribute('aria-label') + '=' + e.textContent.trim()),
    );
    for (const want of ['Priority: High=', 'Comments=1', 'Attachments=1'])
      if (!meta.includes(want)) throw new Error('row shows ' + JSON.stringify(meta));
    await page.click('nav.tabs a[data-tab=today]');
    await page.click(`.row .body:has-text("${title}")`, { timeout: 15000 }); // reopen the task for the tests below
    await page.waitForSelector('#d-comments .comment-form', { timeout: 10000 });
  });
  await step('sanitizer', async () => {
    const r = await page.evaluate(() => {
      const t0 = performance.now();
      sanitize('<x><p>a</p></x>'.repeat(4000));
      return {
        ms: performance.now() - t0,
        frameset: sanitize('<frameset><frame></frameset>hi'),
        links: sanitize(
          '<a href="javascript:alert(1)">a</a><a href="https:javascript:alert(1)">b</a><a href="https://ok.example/">c</a>',
        ),
        alpine: sanitize('<div x-data x-init="alert(1)" @click="alert(1)" :class="x">t</div>'),
        foreign: sanitize('<svg><a href="https://x.example/"><text>s</text></a></svg><math><mi>m</mi></math>'),
        color: colorOf('fff url(https://beacon.example/)'),
      };
    });
    if (r.ms > 1000) throw new Error(`sanitize took ${Math.round(r.ms)} ms`);
    if (/javascript/i.test(r.links) || !r.links.includes('href="https://ok.example/"'))
      throw new Error('links: ' + r.links);
    if (/x-|@click|:class/.test(r.alpine)) throw new Error('attributes kept: ' + r.alpine);
    if (/<(svg|math|text|mi)\b/i.test(r.foreign)) throw new Error('SVG/MathML kept: ' + r.foreign);
    if (r.color !== 'var(--muted)') throw new Error('color not rejected: ' + r.color);
  });
  /* Priority is a row in Details, showing the bars and the word, with the select laid over the whole row (Safari can't
     open a select from code). The top bar shows the task's number at the left, then ⋯ and ×. */
  await step('set-priority', async () => {
    const card = await page.$('#d-card'),
      prio = page.locator('#sheet .prop.prio');
    await page.selectOption('#d-prio', '1');
    await page.waitForSelector('#d-saved:text("Saved")', { timeout: 10000 });
    if (!(await card.evaluate(el => el.isConnected))) throw new Error('saving rebuilt the sheet');
    await expect(prio.locator('.k')).toHaveText('Priority');
    await expect(prio.locator('.v')).toContainText('Low');
    await expect(prio.locator('.bars.p1')).toBeVisible();
    if ((await page.inputValue('#d-prio')) !== '1')
      throw new Error('the select shows ' + (await page.inputValue('#d-prio')));
    await prio.scrollIntoViewIfNeeded();
    const at = await prio.boundingBox();
    for (const x of [at.x + 20, at.x + at.width / 2, at.x + at.width - 20]) {
      const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id, [x, at.y + at.height / 2]);
      if (hit !== 'd-prio') throw new Error(`a tap on Priority lands on ${hit || 'nothing'}, not on the select`);
    }
    // Priority sits directly above Progress.
    const keys = await page.locator('#sheet .prop > .k').allTextContents();
    if (keys[keys.indexOf('Priority') + 1] !== 'Progress') throw new Error('Details: ' + keys.join(', '));
    // The top bar shows the task's number at the left and has no priority picker.
    await expect(page.locator('#sheet .bar .bar-meta #d-id')).toHaveText(/^#\d+$/);
    await expect(page.locator('#sheet .bar select')).toHaveCount(0);
    // The priority bars show the priority. The tick does not.
    const tick = await page.locator('#sheet .row.own > .check').getAttribute('class');
    if (/\bp\d\b/.test(tick)) throw new Error("the sheet's tick shows the priority: " + tick);
  });
  await page.screenshot({ path: `${OUT}/sheet.png` });
  await step('save-keeps-changes-made-elsewhere', async () => {
    // Edit the notes in the web app while the sheet is open, then change the priority in Pocket. Both changes must be kept.
    const t = await apiTask();
    const r = await api('/tasks/' + t.id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...t, description: '<p>edited on the web</p>' }),
    });
    if (!r.ok) throw new Error('could not edit the notes: HTTP ' + r.status);
    await expect(page.locator('#d-saved')).not.toHaveText('Saved', { timeout: 5000 }); // when empty it is hidden
    await page.selectOption('#d-prio', '2');
    await page.waitForSelector('#d-saved:text("Saved")', { timeout: 10000 });
    const after = await apiTask();
    if (!after.description.includes('edited on the web') || after.priority !== 2)
      throw new Error(`notes ${JSON.stringify(after.description)}, priority ${after.priority}`);
  });
  /* The sheet starts with the task's own row. Swiping it sets progress, as in a list. Tapping also works, through the
     Progress line in Details, which has a button for each quarter and shows the current one as pressed. */
  await step('progress-in-sheet', async () => {
    const savedPct = async want => {
      await synced(page);
      const got = Math.round((await apiTask()).percent_done * 100);
      if (got !== want) throw new Error(`saved ${got}%, not ${want}%`);
    };
    const own = '#sheet .row.own',
      chip = n => page.locator('#d-progress').getByRole('button', { name: n + '% done' });
    await expect(page.locator('#d-progress').getByRole('button')).toHaveText(['0%', '25%', '50%', '75%']);
    await expect(chip(50)).toHaveAttribute('aria-pressed', 'true');
    await page.waitForFunction(() => getComputedStyle(document.getElementById('sheet')).transform === 'none', null, {
      timeout: 5000,
    }); // the sheet has finished sliding in
    await slideProgress(own, 75, null, 50);
    await savedPct(75);
    await expect(chip(75)).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => tickPct(own)).toBe(75);
    await chip(50).click();
    await savedPct(50);
    await expect(chip(50)).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => tickPct(`#view ${row}`)).toBe(50); // the row in the list behind the sheet changes too
  });
  await step('attach-from-sheet', async () => {
    const before = (await apiTask()).attachments?.length || 0;
    await page.setInputFiles('#d-file', {
      name: 'smoke-note.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('hello'),
    });
    await page.waitForSelector('#d-attachments button.att:has-text("smoke-note.txt")', { timeout: 10000 }); // the upload has finished, so it no longer shows "Uploading…"
    const after = (await apiTask()).attachments?.length || 0;
    if (after !== before + 1) throw new Error(`Vikunja has ${after} attachments, not ${before + 1}`);
  });
  await step('mark-done', async () => {
    await page.click('#sheet .row.own > .check');
    await expect(page.locator('#sheet .row.own')).toHaveClass(/\bdone\b/);
    await synced(page);
    if (!(await apiTask()).done) throw new Error('not done in Vikunja');
  });
  await step('delete', async () => {
    await page.click('#d-more'); // the ⋯ button in the top bar
    await page.click('#d-delete');
    await page.waitForSelector('#sheet', { state: 'hidden', timeout: 10000 });
  });
  await step('tap-chip-to-ignore', async () => {
    await page.fill('#in-capture', 'Pay rent tomorrow');
    await page.waitForSelector('#cap-chips .chip[data-kind=due]');
    await page.click('#cap-chips .chip[data-kind=due]');
    await page.waitForSelector('#cap-chips .chip[data-kind=due].off');
    await page.click('#cap-chips .chip[data-kind=due]');
    await page.waitForSelector('#cap-chips .chip[data-kind=due]:not(.off)');
    await page.fill('#in-capture', '');
  });
  await step('mark-read-words', async () => {
    const marks = async n => {
      await page.waitForFunction(n => document.querySelectorAll('#cap-marks mark').length === n, n);
      return JSON.stringify(
        await page.$$eval('#cap-marks mark', els => els.map(e => e.dataset.kind + ':' + e.textContent)),
      );
    };
    await page.fill('#in-capture', 'Pay rent tomorrow at 5pm *bills');
    let got = await marks(2);
    if (got !== '["due:tomorrow at 5pm","labels:*bills"]') throw new Error('marked ' + got);
    await page.click('#cap-chips .chip[data-kind=due]'); // turning the chip off leaves its text in the title, unmarked
    if ((got = await marks(1)) !== '["labels:*bills"]') throw new Error('after tapping the chip: ' + got);
    await page.fill('#in-capture', 'Groceries\n  - [ ] milk tomorrow\n\n- eggs !2');
    if ((got = await marks(2)) !== '["due:tomorrow","priority:!2"]') throw new Error('in a list: ' + got);
    await page.fill('#in-capture', '');
  });
  await step('photo-with-new-task', async () => {
    const t = 'Pocket smoke photo ' + stamp;
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    await page.setInputFiles('#in-photo', { name: 'receipt.png', mimeType: 'image/png', buffer: png });
    await page.waitForSelector('#cap-chips .chip.photo:has-text("receipt.png")');
    if ((await page.getAttribute('#in-capture', 'placeholder')) !== "What's this photo for?")
      throw new Error('placeholder: ' + (await page.getAttribute('#in-capture', 'placeholder')));
    await page.fill('#in-capture', t);
    await page.click('#f-capture .go');
    await expect(page.locator(`.row.fresh:has(.title:has-text("${t}"))`)).toBeVisible({ timeout: 15000 }); // the new row appears in the list
    await synced(page);
    await noToast(page);
    const made = (await (await api('/tasks?q=' + encodeURIComponent(t))).json()).items[0];
    if (made?.attachments?.[0]?.file?.name !== 'receipt.png')
      throw new Error('attachments: ' + JSON.stringify(made?.attachments));
  });
  const chipTask = `Pocket smoke new project task ${stamp}`;
  let chipProject;
  await step('create-project-from-chip', async () => {
    const name = `PocketSmoke${stamp}`,
      t = chipTask;
    await page.fill('#in-capture', `${t} tomorrow +${name}`);
    await page.click('#cap-chips .chip[data-kind=new-project]');
    await page.waitForSelector(`#cap-chips .chip[data-kind=project]:has-text("${name}")`, { timeout: 15000 });
    const project = (await (await api('/projects')).json()).items.find(p => p.title === name);
    if (!project) throw new Error('project not found in Vikunja');
    createdProjects.push(project.id);
    chipProject = project.id;
    await page.click('#f-capture .go');
    await page.waitForSelector(`.row .title:has-text("${t}")`, { timeout: 15000 });
    await synced(page);
    const task = ((await (await api('/tasks?q=' + encodeURIComponent(t))).json()).items || []).find(x => x.title === t);
    if (task?.project_id !== project.id) throw new Error('task landed in project ' + task?.project_id);
  });
  // A screen with nothing saved on the phone shows grey rows until Vikunja answers, and no Loading text.
  await step('a-first-open-shows-grey-rows', async () => {
    let answer;
    const late = new Promise(ok => (answer = ok)),
      slow = async r => {
        if (r.request().method() === 'GET') await late;
        await r.fallback();
      };
    await page.route(/\/api\/v2\/(projects|tasks)/, slow);
    try {
      await page.evaluate(id => (location.hash = '#/project/' + id), chipProject);
      await expect(page.locator('#view .skeleton[role=status] .skel-row')).toHaveCount(8);
      await expect(page.locator('#view')).not.toContainText('Loading');
    } finally {
      answer();
      await page.unroute(/\/api\/v2\/(projects|tasks)/, slow);
    }
    await expect(page.locator(`.row .title:has-text("${chipTask}")`)).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#view .skel-row')).toHaveCount(0);
    await page.click('nav.tabs a[data-tab=today]');
    await loaded(page);
  });
  await step('pasted-list-says-who-cant-get-it', async () => {
    // A pasted list that names someone who isn't a user shows a warning before sending, as a single task does. A line
    // that is already ticked off arrives done, and a chip says so. Each line's marks apply to that line's own text.
    await page.fill(
      '#in-capture',
      `- [x] Pocket smoke napkins\n- Pocket smoke list tomorrow @nobody${stamp}\n- Pocket smoke cups`,
    );
    await page.waitForSelector(`#cap-chips .chip.warn:has-text("No user @nobody${stamp}")`, { timeout: 10000 });
    await expect(page.locator('#cap-chips .chip', { hasText: '1 will be added as done' })).toBeVisible();
    await expect(page.locator('#cap-chips .chip', { hasText: '3 tasks' })).toBeVisible();
    const marked = await page.$$eval('#cap-marks mark', els => els.map(e => e.dataset.kind + ':' + e.textContent));
    if (!marked.includes('due:tomorrow')) throw new Error('marks: ' + JSON.stringify(marked));
    await page.fill('#in-capture', '');
  });
  await step('pasted-list-goes-to-one-project', async () => {
    // The first +project anywhere in a list applies to every line. A later, different +project stays as text in its line.
    const name = `PocketList${stamp}`,
      line = x => `Pocket smoke list line ${x} ${stamp}`;
    await page.fill(
      '#in-capture',
      `${line('A')} tomorrow\n${line('B')} tomorrow +${name}\nPocket smoke list line C +Other ${stamp}`,
    );
    await page.click('#cap-chips .chip[data-kind=new-project]');
    await page.waitForSelector(`#cap-chips .chip:not([data-kind]):has-text("${name}")`, { timeout: 15000 });
    const project = (await (await api('/projects')).json()).items.find(p => p.title === name);
    createdProjects.push(project.id);
    await page.click('#f-capture .go');
    await page.waitForSelector(`.row .title:has-text("${line('B')}")`, { timeout: 20000 });
    await synced(page);
    const find = async t =>
      ((await (await api('/tasks?q=' + encodeURIComponent(t))).json()).items || []).find(x => x.title === t);
    for (const t of [line('A'), line('B'), `Pocket smoke list line C +Other ${stamp}`]) {
      const task = await find(t);
      if (task?.project_id !== project.id) throw new Error(`"${t}" is in project ${task?.project_id}`);
    }
  });
  await step('repeat-from-quick-add-and-sheet', async () => {
    const t = `Pocket smoke repeat ${stamp}`;
    await page.fill('#in-capture', `${t} every week`);
    if (!(await page.textContent('#cap-chips')).includes('Every week'))
      throw new Error('chips: ' + (await page.textContent('#cap-chips')));
    await page.click('#f-capture .go');
    // A tap on a waiting row does nothing, so the test waits for the row of the task Vikunja made.
    await page.click(sentRow(t), { timeout: 15000 });
    await page.waitForSelector('#d-comments .comment-form', { timeout: 10000 }); // wait for the sheet to finish loading
    await page.waitForFunction(() => document.querySelector('#d-repeat')?.value === 'week', null, { timeout: 10000 });
    await page.selectOption('#d-repeat', 'month');
    let saved; // "Saved" shows only briefly, so poll Vikunja instead
    for (let i = 0; i < 40; i++) {
      saved = (await (await api('/tasks?q=' + encodeURIComponent(t))).json()).items[0];
      if (saved?.repeat_mode === 1) break;
      await page.waitForTimeout(250);
    }
    if (saved?.repeat_mode !== 1) throw new Error('server repeat_mode ' + saved?.repeat_mode);
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
  });
  await step('added-today-no-date', async () => {
    // A task added today without a date stays on Today until it gets one. The first line of a pasted list, with the
    // other lines as its subtasks, shows there as a card. The subtask never gets a separate row.
    const t = `Pocket smoke undated ${stamp}`,
      sub = `Pocket smoke undated sub ${stamp}`;
    const noDate = 'div:has(> .sec:has-text("Added today, no date"))';
    await page.fill('#in-capture', `${t}\n- ${sub}`);
    await page.click('#cap-nest');
    await page.click('#f-capture .go');
    await page.waitForSelector(`${noDate} :is(.row .title, .card-title):has-text("${t}")`, { timeout: 15000 });
    if (await page.isVisible(`.item > .row .title:has-text("${sub}")`))
      throw new Error('the subtask is a separate row on Today');
    await expect(page.locator(`${noDate} ${cardOf(t)} .step-line .title > span:not(.sr)`)).toHaveText(sub, {
      timeout: 15000,
    });
    await expect(page.locator(`${cardOf(t)} .card-more`)).toHaveCount(0); // with one open subtask there is no More button
    await expect(page.locator(`.item > .row .title:has-text("${sub}")`)).toHaveCount(0);
    await page.click(`${cardOf(t)} > .card-head`);
    await page.waitForSelector('#d-comments .comment-form', { timeout: 10000 });
    const d = new Date(Date.now() + 86400000),
      p = n => String(n).padStart(2, '0');
    await page.fill('#d-due', `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T10:00`);
    await synced(page);
    await page.click('#btn-sheet-close');
    await page.waitForSelector(`div:has(> .sec:has-text("Next 7 days")) ${cardOf(t)}`, { timeout: 15000 });
    if (await page.isVisible(`${noDate} ${cardOf(t)}`)) throw new Error('still under Added today, no date');
  });
  const parentTitle = `Pocket smoke list ${stamp}`;
  await step('paste-list-with-parent', async () => {
    // Text pasted from an email or note: bullets and checkboxes are removed and the first line becomes the parent.
    await page.fill(
      '#in-capture',
      `${parentTitle} tomorrow\n- Pocket smoke sub A ${stamp}\n• [ ] Pocket smoke sub B ${stamp}`,
    );
    if (!(await page.textContent('#cap-chips')).includes('3 tasks'))
      throw new Error('chips: ' + (await page.textContent('#cap-chips')));
    await page.click('#cap-nest');
    if (!(await page.textContent('#cap-chips')).includes('1 task + 2 subtasks'))
      throw new Error('chips: ' + (await page.textContent('#cap-chips')));
    await page.click('#f-capture .go');
    // The new task is highlighted. It shows as a row, or as a card once it is loaded with its subtasks.
    await page.waitForSelector(`:is(.row.fresh .title, .day-card.fresh .card-title):has-text("${parentTitle}")`, {
      timeout: 15000,
    });
    await noToast(page);
  });
  await step('subtasks-in-sheet', async () => {
    await page.click(opener(parentTitle));
    await page.waitForFunction(() => document.querySelectorAll('#d-subtasks .row:not(.pending)').length === 2, null, {
      timeout: 10000,
    });
    const names = await page.$$eval('#d-subtasks .row .title', els => els.map(e => e.textContent));
    if (!names.some(n => n === `Pocket smoke sub B ${stamp}`))
      throw new Error('markers not stripped: ' + names.join(' | '));
    if (!(await page.isVisible('#d-subbox form .go use[href="#i-up"]')))
      throw new Error('the add button is not ↑ like every other add box');
    await page.fill('#d-subin', `Pocket smoke sub C ${stamp}`);
    await page.press('#d-subin', 'Enter');
    await page.waitForFunction(() => document.querySelectorAll('#d-subtasks .row:not(.pending)').length === 3, null, {
      timeout: 15000,
    });
    if ((await page.evaluate(() => document.activeElement?.id)) !== 'd-subin')
      throw new Error('the box lost the focus');
    await page.click('#d-subtasks .row:first-of-type .check');
    await page.waitForSelector('#d-subcount:text("1/3")', { timeout: 10000 });
  });
  await step('subtask-box-reads-like-quick-add', async () => {
    // The subtask box shows the same marks and chips as quick add. Turning a chip off keeps its text in the title.
    await page.fill('#d-subin', `Pocket smoke sub D tomorrow !2 ${stamp}`);
    await page.waitForSelector('#d-subbox-chips .chip[data-kind=due]');
    await page.waitForSelector('#d-subbox-chips .chip[data-kind=priority]:has-text("Priority 2")');
    const marks = await page.$$eval('#d-subbox .cap-marks mark', els =>
      els.map(e => e.dataset.kind + ':' + e.textContent),
    );
    if (JSON.stringify(marks) !== JSON.stringify(['due:tomorrow', 'priority:!2']))
      throw new Error('marks: ' + JSON.stringify(marks));
    await page.click('#d-subbox-chips .chip[data-kind=due]');
    await page.waitForSelector('#d-subbox-chips .chip.off[data-kind=due]');
    await page.click('#d-subbox form .go');
    await page.waitForFunction(() => document.querySelectorAll('#d-subtasks .row:not(.pending)').length === 4, null, {
      timeout: 15000,
    });
    if ((await page.evaluate(() => document.activeElement?.id)) !== 'd-subin')
      throw new Error('the box lost the focus after ↑ was tapped');
    // A subtask stays in its parent's project. +project is not read as a project and the hint does not offer it. It stays in the title.
    await page.waitForSelector('#d-subbox-chips .hint');
    if ((await page.textContent('#d-subbox-chips .hint')).includes('project'))
      throw new Error('hint: ' + (await page.textContent('#d-subbox-chips .hint')));
    await page.fill('#d-subin', `Pocket smoke sub E +Elsewhere ${stamp}`);
    await page.waitForTimeout(300);
    if (await page.$('#d-subbox-chips .chip[data-kind=project], #d-subbox-chips .chip[data-kind=new-project]'))
      throw new Error('+project was read in a subtask');
    await page.waitForSelector('#d-subbox-chips .chip.quiet:has-text("stays in the title")'); // and a chip says so
    await page.fill('#d-subin', '');
    const t = ((await (await api('/tasks?q=' + encodeURIComponent('sub D'))).json()).items || []).find(
      x => x.title.includes('sub D tomorrow') && x.title.endsWith(String(stamp)),
    );
    if (!t || t.priority !== 2 || (t.due_date && !t.due_date.startsWith('0001')))
      throw new Error('saved as ' + JSON.stringify(t && { title: t.title, priority: t.priority, due: t.due_date }));
  });
  await step('claim-a-subtask', async () => {
    // "+ me" on an open subtask assigns it to you, and tapping your picture there unassigns it. A done subtask has no slot.
    // The subtask is found by id, because Vikunja can return a task's subtasks in a different order each time.
    const me = await (await api('/user')).json(),
      id = +(await page.getAttribute('#d-subtasks .row:not(.done) >> nth=0', 'data-id'));
    const row = `#d-subtasks .row[data-id="${id}"]`,
      people = async () => ((await (await api('/tasks/' + id)).json()).assignees || []).map(u => u.id);
    if (await page.$('#d-subtasks .row.done .claim')) throw new Error('a done subtask with no one on it has a slot');
    const radius = await page.$eval(`${row} > .check`, el => getComputedStyle(el).borderRadius);
    if (radius !== '50%') throw new Error("a subtask's box isn't round: " + radius);
    await page.click(`${row} .claim:has(.me)`);
    await page.waitForSelector(`${row} .claim.mine .av`);
    for (let i = 0; JSON.stringify(await people()) !== JSON.stringify([me.id]); i++) {
      if (i > 40) throw new Error('never assigned');
      await new Promise(r => setTimeout(r, 250));
    }
    // The assignee shows again when the sheet is reopened. Vikunja leaves out the assignees of a task's subtasks, so Pocket asks for them.
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    await page.click(opener(parentTitle));
    await page.waitForSelector(`${row} .claim.mine .av`, { timeout: 10000 });
    if (!(await page.getAttribute(`${row} .claim`, 'aria-label')).includes('is assigned to you'))
      throw new Error('the label is ' + (await page.getAttribute(`${row} .claim`, 'aria-label')));
    await page.click(`${row} .claim`);
    await page.waitForSelector(`${row} .claim .me`);
    for (let i = 0; (await people()).length; i++) {
      if (i > 40) throw new Error('never unassigned');
      await new Promise(r => setTimeout(r, 250));
    }
  });
  // The title of the sheet's own row as shown on screen, without the extra text for screen readers.
  const ownTitle = () => page.locator('#sheet .row.own .title > span:not(.sr)').first();
  await step('subtask-links-to-parent', async () => {
    await page.click('#d-subtasks .row:first-of-type .body');
    await page.waitForSelector(`#d-parent:has-text("${parentTitle}")`, { timeout: 10000 });
    await page.click('#d-parent');
    await expect(ownTitle()).toHaveText(parentTitle);
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
  });
  /* On the project's list, a task with open subtasks is a stacked card that starts open. It has a header, a ring
     instead of a tick with the count inside, and a row for every open subtask instead of indented rows under the
     task. On Today it is also a card, and its subtasks never get separate rows. */
  const parentCard = () => page.locator(`#view ${cardOf(parentTitle)}`);
  await step('subtasks-under-parent-in-list', async () => {
    const parent = ((await (await api('/tasks?q=' + encodeURIComponent(parentTitle))).json()).items || []).find(
      x => x.title === parentTitle,
    );
    await page.evaluate(id => {
      location.hash = '#/project/' + id;
    }, parent.project_id);
    await expect(parentCard()).toBeVisible({ timeout: 15000 });
    await expect(parentCard()).toHaveClass(/\bopen\b/);
    await expect(parentCard().locator('.card-head > .ring .n')).toHaveText('1/4');
    await expect(parentCard().locator('.card-head > .check')).toHaveCount(0);
    const rows = parentCard().locator('.card-rows > .row');
    await expect(rows).toHaveCount(3);
    for (const t of await rows.locator('.title > span:not(.sr)').allTextContents())
      if (!t.includes('sub') || !t.endsWith(String(stamp))) throw new Error('unexpected row on the card: ' + t);
    await expect(parentCard().locator('.card-more')).toHaveCount(0); // the card is always open there, so no More button
    await expect(page.locator(`#view .list > .item > .row:has(.title:has-text("Pocket smoke sub"))`)).toHaveCount(0);
    // On Today the task is a card too, and its subtasks are not separate rows.
    await page.evaluate(() => {
      location.hash = '#/today';
    });
    await page.waitForSelector(`div:has(> .sec:has-text("Next 7 days")) ${cardOf(parentTitle)}`, { timeout: 15000 });
    await expect(page.locator('.item > .row .title:has-text("Pocket smoke sub")')).toHaveCount(0);
  });
  /* A parent's ring shows its progress, worked out from its subtasks, where a done subtask counts as 100%. The
     progress is written to the parent's percent_done once, in the same request as the change that caused it.
     Tapping the ring, or swiping the header all the way right, asks before completing the parent together with its
     open subtasks, and the question names them in a sentence. A partial swipe springs back. After completing, the
     card stays, marked done, and tapping the ring reopens exactly those subtasks. With one open subtask there is no
     question and both are completed the same way. When every subtask is done the card waits for Close. Adding a
     subtask removes Close and drops the ring back. Ticking a parent no longer completes its subtasks by itself,
     because the ring is its tick. */
  await step('a-parents-ring-its-figure-and-the-question-it-asks', async () => {
    const parent = ((await (await api('/tasks?q=' + encodeURIComponent(parentTitle))).json()).items || []).find(
      x => x.title === parentTitle,
    );
    const read = async () => await (await api('/tasks/' + parent.id)).json();
    const subs = async () => (await read()).related_tasks?.subtask || [];
    const open = (await subs()).filter(s => !s.done),
      names = open.map(s => s.title);
    if (open.length !== 3) throw new Error('open subtasks before: ' + open.length);
    await page.evaluate(id => {
      location.hash = '#/project/' + id;
    }, parent.project_id);
    await loaded(page);
    const card = parentCard(),
      ring = card.locator('.card-head > .ring'),
      head = `#view ${cardOf(parentTitle)} > .card-head`;
    const arc = () =>
      ring.evaluate(el => Math.round(parseFloat(getComputedStyle(el).getPropertyValue('--ring')) * 100));
    // 1 of 4 subtasks is done, so the parent shows 25%. It was written when that subtask was ticked in its sheet.
    await expect(ring.locator('.n')).toHaveText('1/4');
    await expect.poll(arc).toBe(25);
    if (Math.round((await read()).percent_done * 100) !== 25)
      throw new Error("the parent's progress in Vikunja: " + (await read()).percent_done);
    // Swiping a subtask on the card to 50% makes the parent (100 + 50) / 4 = 38%, on the ring and in Vikunja, written once.
    const writes = [],
      see = r => r.method() !== 'GET' && new RegExp(`/tasks/${parent.id}$`).test(r.url()) && writes.push(r.postData());
    page.on('request', see);
    const first = card.locator('.card-rows > .row').first(),
      firstId = +(await first.getAttribute('data-id'));
    try {
      await slideProgress(`#view .card-rows > .row[data-id="${firstId}"]`, 50);
      await expect.poll(arc).toBe(38);
      await synced(page);
      await expect.poll(async () => Math.round((await read()).percent_done * 100)).toBe(38);
      if (writes.length !== 1 || JSON.parse(writes[0]).percent_done !== 0.38)
        throw new Error('written to the parent: ' + JSON.stringify(writes));
    } finally {
      page.off('request', see);
    }
    if ((await read()).done) throw new Error('the parent was done');
    // Tapping the ring asks a question that names the open subtasks in a sentence. Cancel changes nothing.
    const question = page.locator('#complete');
    const asks = async () => {
      await expect(question.locator('h2')).toHaveText(`Complete “${parentTitle}”?`);
      await expect(question.locator('#complete-note')).toContainText('Its 3 open subtasks will be marked done too: ');
      for (const n of names) await expect(question.locator('#complete-note')).toContainText(n);
      await expect(question.locator('#complete-yes')).toHaveText('Complete all 4');
      await expect(question.locator('input, .check, .complete-item')).toHaveCount(0); // the question is a sentence, with no boxes to pick
    };
    await ring.click();
    await asks();
    await page.click('#complete-no');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    // Swiping the header a little to the right springs back and asks nothing. Swiping all the way asks the same question.
    await swipeRow(page, head, 'back', { one: true });
    await page.waitForTimeout(300);
    if (await page.isVisible('#sheet')) throw new Error('a partial swipe on a header opened something');
    await expect(page.locator(`${head}.revealing`)).toHaveCount(0);
    await expect(uncovered(page)).toHaveCount(0);
    await swipeRow(page, head, 100, { one: true });
    await asks();
    await page.click('#complete-no');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    await synced(page);
    if ((await subs()).filter(s => !s.done).length !== 3 || (await read()).done)
      throw new Error('Cancel changed something');
    // Complete all: the card stays in place, marked done, with the title struck through and no gap, and Vikunja has
    // everything done. Tapping the ring again reopens exactly those subtasks.
    await ring.click();
    await page.click('#complete-yes');
    await expect(card).toHaveClass(/\bdone\b/);
    await expect(card.locator('.del-gap')).toHaveCount(0);
    await expect(card.locator('.card-title')).toBeVisible();
    await synced(page);
    if (!(await read()).done || (await subs()).some(s => !s.done)) throw new Error('not all completed in Vikunja');
    await expect(ring).toHaveAccessibleName('Mark not done: ' + parentTitle);
    await ring.click();
    await expect(card).not.toHaveClass(/\bdone\b/);
    await synced(page);
    if ((await read()).done) throw new Error('the parent is still done');
    if (
      JSON.stringify(
        (await subs())
          .filter(s => !s.done)
          .map(s => s.id)
          .sort(),
      ) !== JSON.stringify(open.map(s => s.id).sort())
    )
      throw new Error(
        'after tapping the ring again, the subtasks are: ' + JSON.stringify((await subs()).map(s => [s.title, s.done])),
      );
    // Tick two of the open subtasks. With one subtask left open, tapping the ring asks nothing. It completes the subtask
    // and the parent, and tapping the ring again undoes both.
    for (const s of open.slice(1))
      await page.getByRole('button', { name: 'Mark done: ' + s.title, exact: true }).click();
    await synced(page); // saved, so the rows are marked and the batch is counting down
    await later(3000);
    await expect(card.locator('.card-rows > .row')).toHaveCount(1);
    await expect(ring.locator('.n')).toHaveText('3/4');
    await ring.click();
    await expect(card).toHaveClass(/\bdone\b/);
    if (await page.isVisible('#sheet')) throw new Error('the question was asked with only one open subtask');
    await synced(page);
    if (!(await read()).done || (await subs()).some(s => !s.done))
      throw new Error('the parent and the subtask are not both done');
    await ring.click();
    await expect(card).not.toHaveClass(/\bdone\b/);
    await synced(page);
    if ((await read()).done || (await subs()).filter(s => !s.done).length !== 1)
      throw new Error('after tapping the ring again: ' + JSON.stringify((await subs()).map(s => [s.title, s.done])));
    // Ticking the last subtask does not close the parent. The card shows "All subtasks done" and a Close button.
    await page.getByRole('button', { name: 'Mark done: ' + open[0].title, exact: true }).click();
    await synced(page);
    await later(3000);
    await expect(card.locator('.card-close')).toContainText('All subtasks done');
    await expect(ring.locator('.n')).toHaveText('4/4');
    await synced(page);
    if ((await read()).done) throw new Error('the last subtask done closed the parent');
    // Add a subtask (the add box moves under the parent through "Add a subtask here" in its ⋯ menu). Close disappears and the ring drops back.
    await page.click(`${head} > .card-open`);
    await expect(ownTitle()).toHaveText(parentTitle);
    await page.click('#d-more');
    await page.click('#d-add-here');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    await expect(page.locator('#in-capture')).toHaveAttribute('aria-label', `New subtask of ${parentTitle}`);
    const late = `Pocket smoke sub late ${stamp}`;
    await page.fill('#in-capture', late);
    await page.press('#in-capture', 'Enter');
    await expect(card.locator('.card-rows > .row')).toHaveCount(1);
    await expect(card.locator('.card-close')).toHaveCount(0);
    await expect(ring.locator('.n')).toHaveText('4/5');
    await synced(page);
    await expect.poll(async () => Math.round((await read()).percent_done * 100)).toBe(80);
    // Tick the subtask, then press Close. The parent is done and its card stays, struck through, with Close removed and
    // the same height. The card leaves with the batch.
    await page.getByRole('button', { name: 'Mark done: ' + late, exact: true }).click();
    await synced(page);
    await later(3000);
    await expect(card.locator('.card-close')).toBeVisible(); // the last row has collapsed
    await expect(card.locator('.card-rows > .row')).toHaveCount(0);
    const closing = await card.evaluate(el => el.offsetHeight);
    await card.locator('.close-btn').click(); // the ring is labelled Close too and does the same
    await expect(card).toHaveClass(/\bdone\b/);
    await expect(card.locator('.close-btn')).toBeHidden();
    if ((await card.evaluate(el => el.offsetHeight)) !== closing)
      throw new Error('the card changed height when closed');
    await synced(page);
    if (!(await read()).done) throw new Error("Close didn't complete the parent");
    await later(3000);
    await expect(card).toHaveCount(0);
    const instead = page.getByRole('button', { name: /^Add a task to .* instead$/ });
    if (await instead.isVisible()) await instead.click();
    await page.evaluate(() => {
      location.hash = '#/today';
    });
    await loaded(page);
  });
  await step('a-pasted-list-on-screen-says-nothing', async () => {
    // The new rows are highlighted where they were added, and no message appears. A task added by mistake can be deleted from its row, which has an Undo.
    const a = `Pocket smoke paste 1 ${stamp}`,
      b = `Pocket smoke paste 2 ${stamp}`;
    await page.fill('#in-capture', `1. ${a} tomorrow\n2. ${b} tomorrow`);
    await page.click('#f-capture .go');
    await page.waitForSelector(`.row.fresh .title:has-text("${b}")`, { timeout: 15000 });
    await page.waitForSelector(`.row.fresh .title:has-text("${a}")`, { timeout: 15000 });
    await synced(page);
    await noToast(page);
    if (await placeLine(page, 'cap').count())
      throw new Error('the add box showed: ' + (await placeLine(page, 'cap').textContent()));
  });
  if (ASSIGNEE)
    await step('assign-from-quick-add', async () => {
      const t = `Pocket smoke assign ${stamp}`;
      await page.fill(
        '#in-capture',
        `${t} tomorrow @${ASSIGNEE} @nobody-${stamp}` + (ASSIGNEE_PROJECT ? ` +"${ASSIGNEE_PROJECT}"` : ''),
      );
      const chips = await page.textContent('#cap-chips');
      if (!chips.includes('@' + ASSIGNEE)) throw new Error('chips: ' + chips);
      await page.waitForSelector(`#cap-chips .chip.warn:has-text("No user @nobody-${stamp}")`, { timeout: 15000 }); // the warning appears before sending
      await page.click('#f-capture .go');
      await placeSays(page, 'cap', `no user @nobody-${stamp}`); // the add box reports what could not be done as asked
      // The assigned person is removed from the title, as in Vikunja. The unknown name stays.
      const saved = ((await (await api('/tasks?q=' + encodeURIComponent(t))).json()).items || []).find(x =>
        x.title.startsWith(t),
      );
      if (saved?.title !== `${t} @nobody-${stamp}`) throw new Error('title: ' + saved?.title);
      await page.click(sentRow(t));
      await page.waitForSelector(`#d-assignees .label-chip:has-text("${ASSIGNEE}")`, { timeout: 10000 });
      await page.click(`#d-assignees .label-chip:has-text("${ASSIGNEE}") .x`);
      await page.waitForSelector(`#d-assignees .label-chip:has-text("${ASSIGNEE}")`, {
        state: 'detached',
        timeout: 10000,
      });
      await page.click('#d-add-assignee');
      await page.fill('#d-assign-in', ASSIGNEE);
      await page.press('#d-assign-in', 'Enter');
      await page.waitForSelector(`#d-assignees .label-chip:has-text("${ASSIGNEE}")`, { timeout: 10000 });
      await page.click('#btn-sheet-close');
      await page.waitForSelector('#sheet', { state: 'hidden' });
    });
  if (ASSIGNEE)
    await step('assign-picks-the-shared-project', async () => {
      // Runs only when the default project isn't shared with ASSIGNEE and exactly one other project is, as in the local setup.
      const me = await (await api('/user')).json(),
        projects = (await (await api('/projects')).json()).items.filter(p => p.id > 0);
      const home = me.settings?.default_project_id || projects[0]?.id;
      const sees = async id => {
        const r = await api(`/projects/${id}/users/search?q=${encodeURIComponent(ASSIGNEE)}`);
        return r.ok ? ((await r.json()).items || []).some(u => u.username === ASSIGNEE) : null;
      };
      const shared = [];
      for (const p of projects) {
        const v = await sees(p.id);
        if (v === null) {
          console.log('  (this token may not use Projects → Users search: step skipped)');
          return;
        }
        if (v) shared.push(p);
      }
      if (shared.some(p => p.id === home) || shared.length !== 1) {
        console.log('  (needs exactly one project shared with ' + ASSIGNEE + ', not the default: step skipped)');
        return;
      }
      const to = shared[0],
        homeTitle = projects.find(p => p.id === home)?.title,
        t = `Pocket smoke auto project ${stamp}`;
      await page.fill('#in-capture', `${t} tomorrow @${ASSIGNEE}`);
      const auto = `#cap-chips .chip[data-kind=autoProject]:has-text("${to.title}")`;
      await page.waitForSelector(auto, { timeout: 15000 });
      await page.click(auto); // undo the automatic project: the default project returns, with a warning
      await page.waitForSelector(`#cap-chips .chip.warn:has-text("@${ASSIGNEE} can't see ${homeTitle}")`);
      await page.click(auto);
      await page.waitForSelector(`#cap-chips .chip.warn`, { state: 'detached' });
      await page.click('#f-capture .go');
      await page.waitForSelector(`.row .title:has-text("${t}")`, { timeout: 20000 }); // due tomorrow, so it shows on Today and no message appears
      await synced(page);
      const task = ((await (await api('/tasks?q=' + encodeURIComponent(t))).json()).items || []).find(
        x => x.title === t,
      );
      if (task?.project_id !== to.id) throw new Error('the task is in project ' + task?.project_id);
      if (!task.assignees?.some(u => u.username === ASSIGNEE)) throw new Error('not assigned');
    });
  await step('suggest-label-and-person', async () => {
    // Typing *pocket-sm offers the existing label, and tapping it completes the word. The same works for @ and a person who shares a project with you.
    await page.fill('#in-capture', `Pocket smoke suggest ${stamp} *${label.slice(0, 9)}`);
    await page.click(`#cap-chips .chip[data-kind=suggest]:has-text("*${label}")`, { timeout: 15000 });
    if ((await page.inputValue('#in-capture')) !== `Pocket smoke suggest ${stamp} *${label} `)
      throw new Error('text: ' + (await page.inputValue('#in-capture')));
    if (ASSIGNEE && (await api('/projects/1/users/search?q=x')).status !== 401) {
      await page.type('#in-capture', '@' + ASSIGNEE.slice(0, 2));
      await page.click(`#cap-chips .chip[data-kind=suggest]:has-text("@${ASSIGNEE}")`, { timeout: 15000 });
      if (!(await page.inputValue('#in-capture')).endsWith(`*${label} @${ASSIGNEE} `))
        throw new Error('text: ' + (await page.inputValue('#in-capture')));
    }
    await page.fill('#in-capture', '');
  });
  // ---- Behaviour that is the same on every screen: Undo, focus, the sheet's pickers, subtasks moving with their task ----
  const me2 = await (await api('/user')).json(),
    projects2 = (await (await api('/projects')).json()).items.filter(p => p.id > 0);
  const home2 = me2.settings?.default_project_id || projects2[0]?.id;
  const json = { 'Content-Type': 'application/json' };
  const make = async (t, extra = {}, pid = home2) =>
    (
      await api(`/projects/${pid}/tasks`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ title: t, ...extra }),
      })
    ).json();
  const get = async id => {
    const r = await api('/tasks/' + id);
    return r.ok ? r.json() : null;
  };
  const todayAt = (h, m = 0) => {
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  };
  const refreshToday = async () => {
    await page.evaluate(() => {
      location.hash = '#/today';
    });
    await page.click('#btn-refresh');
    await page.waitForSelector('#btn-refresh:not([disabled])');
  };
  const rowOf = t => `.row:has(> .body .title:has-text("${t}"))`;
  // Clicks a row's tick, found by the name a screen reader announces.
  const tick = title =>
    page.getByRole('button', { name: 'Mark done: ' + title, exact: true }).click({ timeout: 15000 });
  const toastGone = () => toastGoneOn(page).catch(() => {});

  /* Quick add and the sheet's subtask box both accept a list. In each, Shift+Enter starts a new line and sends nothing.
     The box grows with its lines, so nothing scrolls inside it, and the chips count the lines. Enter then sends all the
     lines. The comment box grows with its lines in the same way. */
  await step('shift-enter-breaks-the-line-in-a-box-that-takes-a-list', async () => {
    const a = `Pocket smoke line one ${stamp}`,
      b = `Pocket smoke line two ${stamp}`,
      p = await make(`Pocket smoke lines ${stamp}`, { due_date: todayAt(23) });
    const size = id =>
      page.$eval('#' + id, ta => ({ tall: ta.clientHeight, inside: ta.scrollHeight - ta.clientHeight }));
    const made = [];
    try {
      await toastGone();
      await refreshToday();
      for (const [id, chips, counts] of [
        ['in-capture', '#cap-chips', '2 tasks'],
        ['d-subin', '#d-subbox-chips', '2 subtasks'],
      ]) {
        if (id === 'd-subin') await page.click(`${rowOf(p.title)} > .body`, { timeout: 15000 });
        await page.focus('#' + id);
        await page.keyboard.type(a);
        const one = await size(id);
        await page.keyboard.press('Shift+Enter');
        await page.keyboard.type(b);
        expect(await page.inputValue('#' + id), `Shift+Enter in ${id}`).toBe(a + '\n' + b);
        await expect(page.locator(chips)).toContainText(counts);
        // The box is resized on the tick after each keystroke, so poll until it is as tall as all its lines.
        await expect
          .poll(async () => (await size(id)).tall, { message: `${id} didn't grow with its second line` })
          .toBeGreaterThan(one.tall);
        await expect
          .poll(async () => (await size(id)).inside, { message: `${id} scrolls instead of growing` })
          .toBeLessThanOrEqual(0);
        if (await page.locator('.row.pending').count()) throw new Error(`Shift+Enter in ${id} sent what was typed`);
      }
      // Enter sends both lines. The box is then empty and still focused.
      await page.keyboard.press('Enter');
      await expect(page.locator('#d-subtasks .row .title', { hasText: a })).toBeVisible();
      await expect(page.locator('#d-subtasks .row .title', { hasText: b })).toBeVisible();
      await expect(page.locator('#d-subin')).toHaveValue('');
      await expect(page.locator('#d-subin')).toBeFocused();
      await synced(page);
      made.push(...((await (await api('/tasks/' + p.id)).json()).related_tasks?.subtask || []).map(s => s.id));
      if (made.length !== 2) throw new Error(`${made.length} subtasks were made of two lines`);
      // The comment box is as tall as its lines, and goes back to one line when emptied.
      const empty = await size('d-cin');
      await page.fill('#d-cin', 'One\nTwo\nThree\nFour');
      await expect
        .poll(async () => (await size('d-cin')).tall, { message: "the comment box didn't grow" })
        .toBeGreaterThan(empty.tall * 2);
      await expect.poll(async () => (await size('d-cin')).inside).toBeLessThanOrEqual(0);
      await page.fill('#d-cin', '');
      await expect.poll(async () => (await size('d-cin')).tall).toBe(empty.tall);
    } finally {
      await page.fill('#d-subin', '').catch(() => {});
      await page.fill('#d-cin', '').catch(() => {});
      if (await page.isVisible('#sheet')) {
        await page.click('#btn-sheet-close');
        await page.waitForSelector('#sheet', { state: 'hidden' });
      }
      await page.fill('#in-capture', '').catch(() => {});
      await page.evaluate(() => document.activeElement?.blur());
      await synced(page);
      for (const id of [...made, p.id]) await api('/tasks/' + id, { method: 'DELETE' });
    }
  });
  /* The phone's keyboard covers the page without making it shorter. core.js reads the visual viewport into --vv-h (the
     visible height) and --kb-h (the keyboard's height). A box being typed in is at most a third of the visible height,
     then scrolls inside itself. The page and the sheet's scroller get bottom padding equal to the keyboard's height, so a
     box at the bottom of a list can be scrolled above the keyboard. Chrome here has no keyboard, so the test sets the
     values by hand after checking that core.js writes them. */
  await step('a-box-is-at-most-a-third-of-whats-visible-and-the-page-leaves-the-keyboard-room', async () => {
    const p = await make(`Pocket smoke keyboard ${stamp}`, { due_date: todayAt(23) });
    const prop = n => page.evaluate(n => document.documentElement.style.getPropertyValue(n), n);
    const set = (n, v) => page.evaluate(([n, v]) => document.documentElement.style.setProperty(n, v), [n, v]);
    const size = id =>
      page.$eval('#' + id, ta => ({ tall: ta.clientHeight, inside: ta.scrollHeight - ta.clientHeight }));
    const room = sel => page.$eval(sel, el => parseFloat(getComputedStyle(el).paddingBottom));
    try {
      await toastGone();
      await refreshToday();
      // With no keyboard, the visible height is the window height and the keyboard height is 0.
      await page.evaluate(() => visualViewport.dispatchEvent(new Event('resize')));
      expect(await prop('--vv-h'), '--vv-h with no keyboard').toBe(await page.evaluate(() => innerHeight + 'px'));
      expect(await prop('--kb-h'), '--kb-h with no keyboard').toBe('0px');
      // With 300px visible above the keyboard, twenty lines in the box are capped at a third of that and scroll inside it.
      await set('--vv-h', '300px');
      await page.focus('#in-capture');
      await page.fill('#in-capture', Array.from({ length: 20 }, (_, i) => 'Line ' + (i + 1)).join('\n'));
      await expect
        .poll(async () => (await size('in-capture')).tall, { message: "the box grew past a third of what's visible" })
        .toBeLessThanOrEqual(105);
      await expect
        .poll(async () => (await size('in-capture')).inside, { message: "the box doesn't scroll inside itself" })
        .toBeGreaterThan(0);
      await page.fill('#in-capture', '');
      // With a 300px keyboard, the page and the sheet's scroller get 300px more bottom padding.
      await page.click(`${rowOf(p.title)} > .body`, { timeout: 15000 });
      await expect(page.locator('#sheet')).toBeVisible();
      const was = [await room('main'), await room('#sheet .scroll')];
      await set('--kb-h', '300px');
      expect((await room('main')) - was[0], "the page's bottom padding for the keyboard").toBe(300);
      expect((await room('#sheet .scroll')) - was[1], "the sheet's bottom padding for the keyboard").toBe(300);
    } finally {
      await page
        .evaluate(() => {
          for (const n of ['--vv-h', '--kb-h']) document.documentElement.style.removeProperty(n);
          visualViewport.dispatchEvent(new Event('resize'));
        })
        .catch(() => {});
      await page.fill('#in-capture', '').catch(() => {});
      if (await page.isVisible('#sheet')) {
        await page.click('#btn-sheet-close');
        await page.waitForSelector('#sheet', { state: 'hidden' });
      }
      await page.evaluate(() => document.activeElement?.blur());
      await api('/tasks/' + p.id, { method: 'DELETE' });
    }
  });
  await step('quick-add-keeps-focus-and-says-where-a-task-went', async () => {
    // If the task appears on the current screen, its row is highlighted and no message is shown. If it does not (due next
    // month, while on Today), the add box shows where it went, with an Open button. The box keeps the focus either way.
    const t = `Pocket smoke focus ${stamp}`,
      far = `Pocket smoke far ${stamp}`,
      home = projects2.find(p => p.id === home2)?.title;
    await toastGone();
    await page.focus('#in-capture');
    await page.fill('#in-capture', t);
    await page.click('#f-capture .go');
    await expect(page.locator(`.row.fresh:has(.title:has-text("${t}"))`)).toBeVisible({ timeout: 20000 });
    if ((await page.evaluate(() => document.activeElement?.id)) !== 'in-capture')
      throw new Error('the box lost the focus');
    await synced(page);
    await noToast(page);
    await page.fill('#in-capture', `${far} in 5 weeks`);
    await page.click('#f-capture .go');
    await placeSays(page, 'cap', `Added to ${home}, due `);
    await noToast(page);
    if ((await page.evaluate(() => document.activeElement?.id)) !== 'in-capture')
      throw new Error('the box lost the focus');
    if (!(await page.textContent('#said')).startsWith(`Added to ${home}`))
      throw new Error('a screen reader hears: ' + (await page.textContent('#said')));
    await placeLine(page, 'cap').getByRole('button', { name: 'Open' }).click();
    await expect(ownTitle()).toHaveText(far);
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    await page.evaluate(() => document.activeElement?.blur());
  });

  /* A line that starts with "x " or a ticked checkbox is added as done. A Done chip shows this before sending, and the
     marker is highlighted in the box. Turning the chip off keeps the marker in the title, as with any chip. The row is
     ticked from the start, wherever the task is added, and leaves with the batch, like any row ticked there.
     Vikunja has the task as done. */
  const taskTitled = async t =>
    ((await (await api('/tasks?q=' + encodeURIComponent(t))).json()).items || []).find(x => x.title === t);
  const capMarks = () =>
    page.$$eval('#cap-marks mark', els => els.map(e => e.dataset.kind + ':' + e.textContent).join());
  const chipsSay = async text => {
    if (!(await page.textContent('#cap-chips')).includes(text))
      throw new Error(`the chips don't include "${text}": ` + (await page.textContent('#cap-chips')));
  };
  // A task's subtasks in Vikunja as [title, done] pairs, sorted by title.
  const subsDone = async id => ((await get(id)).related_tasks?.subtask || []).map(s => [s.title, s.done]).sort();
  await step('a-line-that-says-its-done-arrives-done', async () => {
    const t = `Pocket smoke arrived ${stamp}`,
      R = rowOf(t),
      chip = page.locator('#cap-chips .chip[data-kind=done]');
    await toastGone();
    await refreshToday();
    await page.fill('#in-capture', `x ${t}`);
    await expect(chip).toHaveText('Done');
    await expect.poll(capMarks).toBe('done:x');
    await chip.click();
    await expect(chip).toHaveClass(/\boff\b/);
    await expect.poll(capMarks).toBe('');
    await chip.click();
    await expect(chip).not.toHaveClass(/\boff\b/);
    await page.click('#f-capture .go');
    await expect(page.locator(R)).toHaveClass(/\bdone\b/, { timeout: 15000 }); // the row stays ticked while it is being sent
    await expect(page.locator(`${R}:not(.pending)`)).toHaveClass(/\bleaving\b/, { timeout: 15000 });
    await synced(page);
    await noToast(page);
    const made = await taskTitled(t);
    try {
      if (!made?.done)
        throw new Error('the task in Vikunja is ' + JSON.stringify(made && { title: made.title, done: made.done }));
      await later(3100);
      await expect(page.locator(R)).toHaveCount(0); // the row leaves with the batch
    } finally {
      if (made) await api('/tasks/' + made.id, { method: 'DELETE' });
    }
  });
  /* A percentage in brackets at the end of a line sets the task's progress, as a swipe would. It is highlighted in the
     box, and a chip lets the user turn it off to keep the text in the title. The row's tick shows the progress, and
     Vikunja has it. */
  await step('a-figure-at-the-end-of-a-line-is-its-progress', async () => {
    const t = `Pocket smoke figure ${stamp}`,
      R = rowOf(t),
      chip = page.locator('#cap-chips .chip[data-kind=progress]');
    await page.fill('#in-capture', `${t} (50%)`);
    await expect(chip).toHaveText('50%');
    await expect.poll(capMarks).toBe('progress:(50%)');
    await chip.click();
    await expect(chip).toHaveClass(/\boff\b/);
    await expect.poll(capMarks).toBe('');
    await chip.click();
    await expect(chip).not.toHaveClass(/\boff\b/);
    await page.click('#f-capture .go');
    await expect(page.locator(`${R}:not(.pending)`)).toBeVisible({ timeout: 15000 });
    await synced(page);
    await expect.poll(() => tickPct(R)).toBe(50);
    const made = await taskTitled(t);
    try {
      if (!made || made.done || Math.round(made.percent_done * 100) !== 50)
        throw new Error(
          'the task in Vikunja is ' +
            JSON.stringify(made && { title: made.title, progress: made.percent_done, done: made.done }),
        );
    } finally {
      if (made) await api('/tasks/' + made.id, { method: 'DELETE' });
    }
  });
  /* The text after " // " is the task's notes. It is highlighted in the box and shown in a chip, and a date in it is not
     read. The task is made with the notes as its description, and its sheet shows them under the title. */
  await step('the-text-after-two-slashes-is-the-notes-and-the-sheet-shows-them', async () => {
    const t = `Pocket smoke notes ${stamp}`,
      R = `#view ${rowOf(t)}`,
      chip = page.locator('#cap-chips .chip[data-kind=notes]');
    await toastGone();
    await refreshToday();
    await page.fill('#in-capture', `${t} // the brown ones, tomorrow`);
    await expect(chip).toHaveText('Notes: the brown ones, tomorrow');
    await expect.poll(capMarks).toBe('notes:// the brown ones, tomorrow');
    await page.click('#f-capture .go');
    await expect(page.locator(`${R}:not(.pending)`)).toBeVisible({ timeout: 15000 });
    await synced(page);
    const made = await taskTitled(t);
    try {
      if (made?.description !== '<p>the brown ones, tomorrow</p>' || made.due_date !== '0001-01-01T00:00:00Z')
        throw new Error(
          'the task in Vikunja is ' + JSON.stringify(made && { description: made.description, due: made.due_date }),
        );
      await page.click(`${R} > .body`);
      await expect(page.locator('#d-card #d-desc')).toContainText('the brown ones, tomorrow');
      await page.click('#btn-sheet-close');
      await page.waitForSelector('#sheet', { state: 'hidden' });
    } finally {
      if (made) await api('/tasks/' + made.id, { method: 'DELETE' });
    }
  });
  /* A pasted list can contain lines that are already ticked off. One chip counts them ("2 will be added as done"). Tapping the
     chip leaves those lines out and says so, as Pocket did before. Tapping again brings them back. When added, they are
     done subtasks under the first line. Its ring counts them from the start and the parent's progress is written with
     them: (100 + 50 + 100 + 0) / 4 = 63%. */
  await step('a-pasted-list-with-lines-done-and-the-chip-that-leaves-them-out', async () => {
    const p = `Pocket smoke packed ${stamp}`,
      sub = n => `Pocket smoke pack ${n} ${stamp}`,
      chip = page.locator('#cap-chips .chip[data-kind=done]');
    await page.fill(
      '#in-capture',
      `${p} tomorrow\n- [x] ${sub('A')}\n- [ ] ${sub('B')} (50%)\nx ${sub('C')}\n- ${sub('D')}`,
    );
    await page.click('#cap-nest');
    await expect(chip).toHaveText('2 will be added as done');
    await chipsSay('1 task + 4 subtasks');
    await chip.click();
    await expect(chip).toHaveText('2 already ticked, left out');
    await chipsSay('1 task + 2 subtasks');
    await chip.click();
    await expect(chip).toHaveText('2 will be added as done');
    await page.click('#f-capture .go');
    const ring = page.locator(`#view ${cardOf(p)} > .card-head > .ring`);
    await expect(ring.locator('.n')).toHaveText('2/4', { timeout: 20000 });
    await synced(page);
    await noToast(page);
    const made = await taskTitled(p),
      subs = made ? (await get(made.id)).related_tasks?.subtask || [] : [];
    try {
      const got = JSON.stringify(subs.map(s => [s.title, s.done, Math.round(s.percent_done * 100)]).sort());
      if (
        got !==
        JSON.stringify([
          [sub('A'), true, 0],
          [sub('B'), false, 50],
          [sub('C'), true, 0],
          [sub('D'), false, 0],
        ])
      )
        throw new Error('the subtasks in Vikunja are: ' + got);
      await expect.poll(async () => Math.round((await get(made.id)).percent_done * 100)).toBe(63);
      await expect
        .poll(() => ring.evaluate(el => Math.round(parseFloat(getComputedStyle(el).getPropertyValue('--ring')) * 100)))
        .toBe(63);
    } finally {
      for (const t of [...subs, made]) if (t) await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });
  /* Parents in a pasted list. A heading such as "## Pack the van" is a task, and the lines under it, up to the next
     heading, are its subtasks. A chip says what the list will create. The ↳ Under first line chip is switched on
     automatically because the first line is a parent. Turning it off makes every line a separate task. */
  const nestChip = page.locator('#cap-nest');
  const madeFrom = []; // the tasks these tests added, deleted afterwards
  await step('a-pasted-list-with-headings-makes-parents', async () => {
    const A = `Pocket smoke head A ${stamp}`,
      B = `Pocket smoke head B ${stamp}`,
      sub = n => `Pocket smoke under ${n} ${stamp}`;
    await page.fill(
      '#in-capture',
      `## ${A} tomorrow\n- ${sub('a1')}\n- [x] ${sub('a2')}\n\n## ${B} tomorrow\n${sub('b1')}`,
    );
    await expect(nestChip).toHaveAttribute('aria-pressed', 'true');
    await chipsSay('2 tasks + 3 subtasks');
    await nestChip.click();
    await expect(nestChip).toHaveAttribute('aria-pressed', 'false');
    await chipsSay('5 tasks');
    await nestChip.click();
    await expect(nestChip).toHaveAttribute('aria-pressed', 'true');
    await chipsSay('2 tasks + 3 subtasks');
    await page.click('#f-capture .go');
    await expect(page.locator(`#view ${cardOf(A)} > .card-head > .ring .n`)).toHaveText('1/2', { timeout: 20000 });
    await expect(page.locator(`#view ${cardOf(B)}`)).toBeVisible();
    await synced(page);
    await noToast(page);
    const a = await taskTitled(A),
      b = await taskTitled(B);
    madeFrom.push(
      ...(a ? [...((await get(a.id)).related_tasks?.subtask || []), a] : []),
      ...(b ? [...((await get(b.id)).related_tasks?.subtask || []), b] : []),
    );
    if (
      JSON.stringify(await subsDone(a.id)) !==
      JSON.stringify([
        [sub('a1'), false],
        [sub('a2'), true],
      ])
    )
      throw new Error('subtasks under the first heading: ' + JSON.stringify(await subsDone(a.id)));
    if (JSON.stringify(await subsDone(b.id)) !== JSON.stringify([[sub('b1'), false]]))
      throw new Error('subtasks under the second heading: ' + JSON.stringify(await subsDone(b.id)));
    await expect.poll(async () => Math.round((await get(a.id)).percent_done * 100)).toBe(50); // one of two subtasks is done, and the progress is written with them
  });
  /* Indenting works as in Vikunja's web app: a line indented more than the line above it becomes its subtask, to any
     depth. In a task's subtask box, each line goes under the line above it, and the top-level lines go under the open
     task. A subtask that is already done sets the progress of the lines above it, up to the open task. Here the open
     task's two subtasks are at 100% and 0%, so it is at 50%. */
  await step('indented-lines-in-a-subtask-box-go-under-the-line-above', async () => {
    const t = await make(`Pocket smoke indent ${stamp}`, { due_date: todayAt(23) }),
      sub = n => `Pocket smoke dent ${n} ${stamp}`;
    madeFrom.push(t);
    await refreshToday();
    await page.click(opener(t.title));
    await page.waitForSelector('#d-comments .comment-form', { timeout: 10000 });
    await page.fill('#d-subin', `${sub('A')}\n  ${sub('A1')}\n    x ${sub('A2')}\n${sub('B')}`);
    await expect(page.locator('#d-subbox-chips .chip', { hasText: '4 subtasks' })).toBeVisible();
    await expect(page.locator('#d-subbox-chips .chip[data-kind=done]')).toHaveText('1 will be added as done');
    await page.click('#d-subbox form .go');
    // The task has two direct subtasks. The other lines are nested under the first.
    const rows = page.locator('#d-subtasks .row:not(.pending) .title');
    await expect(rows).toHaveCount(2, { timeout: 15000 });
    if (JSON.stringify((await rows.allTextContents()).sort()) !== JSON.stringify([sub('A'), sub('B')]))
      throw new Error('the subtasks in the sheet are: ' + (await rows.allTextContents()));
    await synced(page);
    const a = await taskTitled(sub('A')),
      a1 = await taskTitled(sub('A1')),
      a2 = await taskTitled(sub('A2')),
      b = await taskTitled(sub('B'));
    madeFrom.unshift(...[a2, a1, a, b].filter(Boolean));
    if (
      JSON.stringify(await subsDone(t.id)) !==
      JSON.stringify([
        [sub('A'), false],
        [sub('B'), false],
      ])
    )
      throw new Error('subtasks of the task: ' + JSON.stringify(await subsDone(t.id)));
    if (JSON.stringify(await subsDone(a.id)) !== JSON.stringify([[sub('A1'), false]]))
      throw new Error('subtasks of the first subtask: ' + JSON.stringify(await subsDone(a.id)));
    if (JSON.stringify(await subsDone(a1.id)) !== JSON.stringify([[sub('A2'), true]]))
      throw new Error('subtasks of the nested subtask: ' + JSON.stringify(await subsDone(a1.id)));
    const pct = async id => Math.round((await get(id)).percent_done * 100);
    await expect.poll(async () => [await pct(a1.id), await pct(a.id), await pct(t.id)]).toEqual([100, 100, 50]);
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
  });
  /* When typing, a first line that ends with a colon is the parent of the other lines, and the colon is removed from
     its title. The ↳ Under first line chip is switched on. Turning it off makes every line a separate task. */
  await step('a-first-line-ending-with-a-colon-is-the-parent-of-the-rest', async () => {
    const p = `Pocket smoke colon ${stamp}`,
      sub = n => `Pocket smoke after ${n} ${stamp}`;
    await page.fill('#in-capture', `${p} tomorrow:\n${sub('a')}\n${sub('b')}`);
    await expect(nestChip).toHaveAttribute('aria-pressed', 'true');
    await chipsSay('1 task + 2 subtasks');
    await nestChip.click();
    await expect(nestChip).toHaveAttribute('aria-pressed', 'false');
    await chipsSay('3 tasks');
    await nestChip.click();
    await chipsSay('1 task + 2 subtasks');
    await page.click('#f-capture .go');
    await expect(page.locator(`#view ${cardOf(p)} > .card-head > .ring .n`)).toHaveText('0/2', { timeout: 20000 });
    await synced(page);
    const made = await taskTitled(p); // the title has no colon
    if (!made) throw new Error('no task titled ' + p);
    madeFrom.push(...((await get(made.id)).related_tasks?.subtask || []), made);
    if (
      JSON.stringify(await subsDone(made.id)) !==
      JSON.stringify([
        [sub('a'), false],
        [sub('b'), false],
      ])
    )
      throw new Error('subtasks of the parent: ' + JSON.stringify(await subsDone(made.id)));
  });
  /* A repeating task that is added as done moves to its next due date, as ticking it does. Until the batch clears, its
     row stays where it was added, ticked and showing the due date it was given. That holds through the reload after
     an add and through another reload. Then the row is open, at its next date. A repeating task that is ticked
     behaves the same way through a reload. Touching the screen holds the batch meanwhile. */
  await step('a-repeating-task-added-done-shows-ticked-then-its-next-date', async () => {
    const t = `Pocket smoke repeat arrived ${stamp}`,
      ticked = await make(`Pocket smoke repeat ticked ${stamp}`, { due_date: todayAt(23), repeat_after: 86400 });
    madeFrom.push(ticked);
    const week = title => page.locator(`div:has(> .sec:has-text("Next 7 days")) ${rowOf(title)}`),
      due = title => page.locator(`${rowOf(title)} .when .due`).textContent();
    const shownDone = async (title, was) => {
      await expect(page.locator(rowOf(title))).toHaveClass(/\bdone\b/);
      await expect(page.locator(rowOf(title))).toHaveClass(/\bleaving\b/);
      await expect(week(title)).toHaveCount(0);
      if ((await due(title)) !== was)
        throw new Error(`"${title}" shows ${await due(title)} while it's ticked, not ${was}`);
    };
    await toastGone();
    await refreshToday();
    await expect(page.locator(rowOf(ticked.title))).toBeVisible();
    const was = await due(ticked.title);
    await page.fill('#in-capture', `x ${t} every day today at 23:00`);
    await page.click('#f-capture .go');
    await expect(page.locator(`${rowOf(t)}:not(.pending)`)).toHaveClass(/\bleaving\b/, { timeout: 15000 });
    await tick(ticked.title);
    await expect(page.locator(rowOf(ticked.title))).toHaveClass(/\bleaving\b/);
    // While the user touches a heading, nothing leaves the list, and a reload waits for the finger to lift.
    await page
      .locator('#view .sec')
      .first()
      .evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    const sec = await page.locator('#view .sec').first().boundingBox();
    await page.mouse.move(sec.x + 4, sec.y + sec.height / 2);
    await page.mouse.down();
    try {
      await synced(page);
      const made = await taskTitled(t);
      if (made) madeFrom.push(made);
      const next = new Date(todayAt(23)).getTime() + 864e5;
      if (!made || made.done || new Date(made.due_date).getTime() !== next)
        throw new Error('the task in Vikunja is ' + JSON.stringify(made && { done: made.done, due: made.due_date }));
      for (const title of [t, ticked.title]) await shownDone(title, was);
      await page.evaluate(() => document.getElementById('btn-refresh').click());
      await expect(page.locator('#btn-refresh')).toBeDisabled();
      for (const title of [t, ticked.title]) await shownDone(title, was);
    } finally {
      await page.mouse.up();
    }
    await page.waitForSelector('#btn-refresh:not([disabled])');
    await loaded(page);
    for (const title of [t, ticked.title]) await shownDone(title, was);
    await later(3100);
    for (const title of [t, ticked.title]) {
      await expect(page.locator(rowOf(title))).not.toHaveClass(/\bleaving\b/);
      await expect(page.locator(rowOf(title))).not.toHaveClass(/\bdone\b/);
      await expect(week(title)).toHaveCount(1); // the task is open, at its next date
    }
  });
  await step('parents-in-a-pasted-list-clean-up', async () => {
    for (const t of madeFrom) await api('/tasks/' + t.id, { method: 'DELETE' });
  });

  /* Ticked rows stay in place at their height until 3 seconds after the last tick, counted from when the touch ends.
     Then they leave together and the rows below close up once. Touching the screen holds them. */
  // Watches rows `ids` as they leave. It records the heights each row is drawn at (to see it fold) and which DOM change
  // removed it, so rows that left together can be shown to leave in the same change. Read the result with gone().
  const watchGoing = ids =>
    page.evaluate(ids => {
      const w = (window.__going = { heights: {}, gone: {}, n: 0 });
      const ro = new ResizeObserver(es => {
        for (const e of es)
          (w.heights[e.target.dataset.id] ||= []).push(Math.round(e.target.getBoundingClientRect().height));
      });
      for (const id of ids) for (const el of document.querySelectorAll(`#view .row[data-id="${id}"]`)) ro.observe(el);
      new MutationObserver(rs => {
        w.n++;
        for (const r of rs) for (const el of r.removedNodes) if (el.dataset?.id) w.gone[el.dataset.id] ??= w.n;
      }).observe(document.getElementById('view'), { childList: true, subtree: true });
    }, ids.map(String));
  const gone = () => page.evaluate(() => window.__going);
  await step('ticks-stay-in-place-then-leave-together', async () => {
    const [a, b, c] = await Promise.all(
      ['A', 'B', 'C'].map(n => make(`Pocket smoke tick ${n} ${stamp}`, { due_date: todayAt(23) })),
    );
    const A = rowOf(a.title),
      B = rowOf(b.title),
      C = rowOf(c.title),
      heights = () => Promise.all([A, B, C].map(r => page.locator(r).evaluate(el => el.offsetHeight)));
    try {
      await toastGone();
      await refreshToday();
      await expect(page.locator(C)).toBeVisible();
      const before = await heights();
      await tick(a.title);
      await tick(b.title);
      await tick(c.title);
      for (const r of [A, B, C]) await expect(page.locator(r)).toHaveClass(/\bleaving\b/);
      await watchGoing([a.id, b.id]);
      if (JSON.stringify(await heights()) !== JSON.stringify(before))
        throw new Error(`heights ${before} became ${await heights()}`);
      // Tapping a tick before the rows leave reopens that task, and it stays.
      await page.getByRole('button', { name: 'Mark not done: ' + c.title, exact: true }).click();
      await expect(page.locator(C)).not.toHaveClass(/\bleaving\b/);
      // Touching the screen anywhere holds the rows. They leave 3 seconds after the touch ends.
      // The touch is on a heading in the middle of the screen. A heading scrolled off the screen would get no touch.
      // One under the header would land on a tab, and tapping Today clears the rows at once.
      await page
        .locator('#view .sec')
        .first()
        .evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      const sec = await page.locator('#view .sec').first().boundingBox();
      await page.mouse.move(sec.x + 4, sec.y + sec.height / 2);
      await page.mouse.down();
      await later(6000);
      await expect(page.locator(A)).toHaveCount(1);
      await page.mouse.up();
      await later(2800);
      for (const r of [A, B]) await expect(page.locator(r)).toHaveClass(/\bleaving\b/);
      if (JSON.stringify(await heights()) !== JSON.stringify(before))
        throw new Error(`while waiting, heights ${before} became ${await heights()}`);
      await later(300);
      await expect(page.locator(A)).toHaveCount(0);
      await expect(page.locator(B)).toHaveCount(0);
      const w = await gone();
      if (!w.gone[a.id] || w.gone[a.id] !== w.gone[b.id])
        throw new Error('the rows did not leave together: ' + JSON.stringify(w.gone));
      if (!w.heights[a.id]?.some(h => h > 0 && h < before[0]))
        throw new Error('row A never folded: ' + JSON.stringify(w.heights));
      await expect(page.locator(C)).toBeVisible();
      await synced(page);
      if (!(await get(a.id)).done || !(await get(b.id)).done || (await get(c.id)).done)
        throw new Error(
          'done flags in Vikunja: ' + [(await get(a.id)).done, (await get(b.id)).done, (await get(c.id)).done],
        );
      // Reopen the task, which the search test below needs.
      await api('/tasks/' + a.id, { method: 'PATCH', headers: json, body: JSON.stringify({ done: false }) });
    } finally {
      for (const t of [b, c]) await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });

  await step('a-task-ticked-on-today-joins-done-today-which-copies-as-text', async () => {
    const me = await (await api('/user')).json(),
      t = await make(`Pocket smoke done today ${stamp}`, { due_date: todayAt(23) }),
      home = await (await api('/projects/' + home2)).json();
    const fold = page.locator('#sec-donetoday'),
      R = `#view .done-sec ~ .list ${rowOf(t.title)}`;
    try {
      await toastGone();
      await refreshToday();
      await tick(t.title);
      await later(3100);
      await expect(page.locator(rowOf(t.title))).toHaveCount(0);
      // Pocket puts the user's ✅ on the task, since Vikunja doesn't record who ticked it.
      await synced(page);
      // Vikunja leaves a task's reactions out unless they are asked for.
      const reactions = async () =>
        (await (await api(`/tasks/${t.id}?expand=reactions`)).json()).reactions?.['✅'] || [];
      await expect.poll(async () => (await reactions()).map(u => u.id)).toEqual([me.id]);
      // Done today is folded at the bottom of Today, with its count, and its rows are drawn once it is opened.
      await expect(fold).toHaveAttribute('aria-expanded', 'false');
      await expect(fold).toContainText(/Done today \(\d+\)/);
      await fold.click();
      await expect(page.locator(R)).toBeVisible();
      // Copy gives the day, then each done task with its project.
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(APP).origin });
      await page.click('#btn-copy-done');
      await placeSays(page, 'donetoday', 'Copied. Paste it into a message');
      const text = await page.evaluate(() => navigator.clipboard.readText()).then(x => x.replace(/\r\n/g, '\n'));
      if (!text.startsWith('Done today · ') || !text.split('\n').includes(`✓ ${t.title} · ${home.title}`))
        throw new Error('the copied text: ' + text);
      // Unticking it there leaves it in place, open, and takes the ✅ off. The copy leaves it out.
      await page.getByRole('button', { name: 'Mark not done: ' + t.title, exact: true }).click();
      await expect(page.locator(`${R} .check`)).toHaveAttribute('aria-label', 'Mark done: ' + t.title);
      await synced(page);
      await expect.poll(reactions).toEqual([]);
      await page.click('#btn-copy-done');
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).not.toContain(t.title);
      // As the batch clears, the task moves back under its date, and stays there once Today is loaded again.
      await later(3100);
      await expect(page.locator(R)).toHaveCount(0);
      await expect(page.locator(rowOf(t.title))).toHaveCount(1);
      await refreshToday();
      await expect(page.locator(R)).toHaveCount(0);
      await expect(page.locator(rowOf(t.title))).toHaveCount(1);
    } finally {
      if ((await fold.getAttribute('aria-expanded').catch(() => null)) === 'true') await fold.click();
      await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });
  // Only a Checklists project has templates, so a task labelled "template" anywhere else is an ordinary task.
  await step('a-task-labelled-template-outside-checklists-is-an-ordinary-task', async () => {
    const me = await (await api('/user')).json(),
      due = new Date();
    due.setDate(due.getDate() - 2);
    due.setHours(9, 0, 0, 0);
    const t = await make(`TEMPLATE: Pocket smoke labelled ${stamp}`, { due_date: due.toISOString() }),
      R = rowOf(t.title);
    const found = (await (await api('/labels?s=template')).json()).items?.find(l => l.title === 'template');
    const l =
      found ||
      (await (
        await api('/labels', { method: 'POST', headers: json, body: JSON.stringify({ title: 'template' }) })
      ).json());
    try {
      await api(`/tasks/${t.id}/labels`, { method: 'POST', headers: json, body: JSON.stringify({ label_id: l.id }) });
      await toastGone();
      await refreshToday();
      // The row shows the whole title, "TEMPLATE: " included, and Move all to today moves it. Undo puts it back.
      await expect(page.locator(`.sec.overdue ~ .list ${R}`)).toBeVisible();
      await page.click('#btn-overdue-today');
      await expect(page.locator(`.sec.today ~ .list ${R}`)).toBeVisible();
      await synced(page);
      if (new Date((await get(t.id)).due_date).getTime() === due.getTime())
        throw new Error('Move all left the task where it was');
      await placeLine(page, 'overdue').getByRole('button', { name: 'Undo' }).click();
      await expect(page.locator(`.sec.overdue ~ .list ${R}`)).toBeVisible();
      await synced(page);
      // A tick puts the user's ✅ on it, as on any task.
      await tick(t.title);
      await later(3100);
      await synced(page);
      await expect
        .poll(async () =>
          ((await (await api(`/tasks/${t.id}?expand=reactions`)).json()).reactions?.['✅'] || []).map(u => u.id),
        )
        .toEqual([me.id]);
    } finally {
      await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });
  await step('with-less-motion-rows-ticked-go-without-folding', async () => {
    const d = await make(`Pocket smoke tick D ${stamp}`, { due_date: todayAt(23) }),
      D = rowOf(d.title);
    try {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await refreshToday();
      await tick(d.title);
      await expect(page.locator(D)).toHaveClass(/\bleaving\b/);
      await synced(page);
      const full = await page.locator(D).evaluate(el => el.offsetHeight);
      await watchGoing([d.id]);
      await later(3000);
      await expect(page.locator(D)).toHaveCount(0);
      const w = await gone();
      if (w.heights[d.id]?.some(h => h > 0 && h < full - 1))
        throw new Error('the row folded: ' + JSON.stringify(w.heights[d.id]));
    } finally {
      await page.emulateMedia({ reducedMotion: null });
      await api('/tasks/' + d.id, { method: 'DELETE' });
    }
  });

  /* Every row shows who is doing the task at its end, as a subtask in a sheet does. Ticking a subtask marks its row, which
     stays until the batch clears. Swiping a row left shows its Delete button. Deleting leaves a gap with a Restore
     button, and the task is deleted only once the batch clears. */
  const swipe = async (sel, from = 200, by = -100) => {
    await page.locator(sel).scrollIntoViewIfNeeded(); // wait until a sheet has slid in
    await page.$eval(sel, el => el.scrollIntoView({ block: 'center', behavior: 'instant' })); // and keep the row clear of the header
    await page.waitForTimeout(100);
    const box = await page.locator(sel).boundingBox(),
      y = box.y + box.height / 2;
    await page.mouse.move(from, y);
    await page.mouse.down();
    await page.mouse.move(from + by, y + 4, { steps: 8 });
    await page.mouse.up();
  };
  /* Records row `sel` on every frame for the next second: its height and width, how far its content is moved aside (x),
     whether it is deleted, whether its gap is showing, and whether its title is visible. framesSeen() waits for the
     recording to finish and returns it. */
  const watchFrames = sel =>
    page.$eval(sel, el => {
      const seen = (window.__frames = []),
        t0 = performance.now();
      window.__framed = false;
      (function look() {
        const x = new DOMMatrix(getComputedStyle(el).transform).m41,
          body = el.querySelector(':scope > .body'),
          gap = el.querySelector(':scope > .del-gap');
        seen.push({
          h: el.offsetHeight,
          w: el.clientWidth,
          x,
          deleted: el.classList.contains('deleted'),
          gap: !!gap,
          shown: getComputedStyle(body).visibility === 'visible' && x > -el.clientWidth / 2,
        });
        if (performance.now() - t0 < 1000) requestAnimationFrame(look);
        else window.__framed = true;
      })();
    });
  const framesSeen = async () => {
    await page.waitForFunction(() => window.__framed, null, { polling: 100 });
    return page.evaluate(() => window.__frames);
  };
  // Taps the Delete button once the row has come to rest open on it, at the button's position, as a touch would. The
  // button is under the row, not inside it, and the row has uncovered it.
  const redButton = () => page.locator('.row-red.row-under:not(.going) > .row-del'); // skip a button that is fading out over the gap
  const tapDelete = async sel => {
    await page.waitForSelector(`${sel}.swiped`);
    await expect(redButton()).toBeVisible();
    await page.waitForTimeout(300);
    const b = await redButton().boundingBox();
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  };
  await step('a-rows-slot-tick-and-swipe-to-delete', async () => {
    const me = await (await api('/user')).json();
    const p = await make(`Pocket smoke row parent ${stamp}`, { due_date: todayAt(23) }),
      k = await make(`Pocket smoke row kid ${stamp}`, { due_date: todayAt(23) }),
      o = await make(`Pocket smoke row own ${stamp}`, { due_date: todayAt(23) });
    await api(`/tasks/${p.id}/relations`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ other_task_id: k.id, relation_kind: 'subtask' }),
    });
    const people = async id => ((await get(id)).assignees || []).map(u => u.id),
      P = rowOf(o.title),
      K = rowOf(k.title);
    try {
      await toastGone();
      // On the project's list, a task is a row, and a subtask is a row on its parent's card.
      await page.evaluate(id => {
        location.hash = '#/project/' + id;
      }, home2);
      await loaded(page);
      await page.waitForSelector(`${cardOf(p.title)} > .card-rows > ${K}`, { timeout: 15000 });
      // Claim the task from its row, then unclaim it.
      const claim = page.getByRole('button', { name: `Tap to assign ${o.title} to yourself` }),
        mine = page.getByRole('button', { name: `${o.title} is assigned to you. Tap to unassign yourself.` });
      await claim.click();
      await expect(mine.locator('.av')).toBeVisible();
      await synced(page);
      if (JSON.stringify(await people(o.id)) !== JSON.stringify([me.id])) throw new Error('never assigned');
      await mine.click();
      await expect(claim).toBeVisible();
      await synced(page);
      if ((await people(o.id)).length) throw new Error('never unassigned');
      // Ticking a subtask shows no message. Its row stays, marked done, so it can be ticked back.
      await toastGone();
      await tick(k.title);
      await expect(page.locator(K)).toHaveClass(/\bdone\b/);
      await synced(page);
      if (!(await get(k.id)).done) throw new Error('the task was never marked done');
      if (await page.$('#toast.show'))
        throw new Error("a subtask's tick showed a toast: " + (await page.textContent('#toast-msg')));
      await page.getByRole('button', { name: 'Mark not done: ' + k.title, exact: true }).click();
      await expect(page.locator(K)).not.toHaveClass(/\bdone\b/);
      // A row has three touch targets, each the row's full height and at least 48px wide. The tick covers the whole left
      // gutter (on a subtask, from the row's edge). The title opens the task. The assignee slot is at the end.
      for (const R of [P, K]) {
        await page.$eval(R, el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
        const zones = await page.$eval(R, el => {
          const r = el.getBoundingClientRect(),
            at = (x, y) => document.elementFromPoint(r.left + x, r.top + y)?.closest('button');
          const name = b =>
            b?.matches('.check')
              ? 'tick'
              : b?.matches('.body')
                ? 'title'
                : b?.matches('.claim')
                  ? 'slot'
                  : String(b?.className);
          const body = el.querySelector(':scope > .body').getBoundingClientRect(),
            slot = el.querySelector(':scope > .claim').getBoundingClientRect();
          // Test points are 8px in from the row's corners, because the list's rounded corners clip the corners
          const xs = {
            tick: [8, body.left - r.left - 1],
            title: [body.left - r.left + 1, slot.left - r.left - 1],
            slot: [slot.left - r.left + 1, r.width - 8],
          };
          const out = { widths: { tick: body.left - r.left, slot: slot.width }, wrong: [] };
          for (const [want, [x0, x1]] of Object.entries(xs))
            for (const x of [x0, (x0 + x1) / 2, x1])
              for (const y of [8, r.height / 2, r.height - 8])
                if (name(at(x, y)) !== want)
                  out.wrong.push(`${want} at ${Math.round(x)},${Math.round(y)}: ${name(at(x, y))}`);
          return out;
        });
        if (zones.wrong.length) throw new Error('taps land elsewhere: ' + zones.wrong.join('; '));
        if (zones.widths.tick < 48 || zones.widths.slot < 48)
          throw new Error('a touch target is under 48px: ' + JSON.stringify(zones.widths));
      }
      // Swiping left at 0% shows the Delete button, on Today too. The earlier ticks pointed the add box at the ticked task,
      // so switch it back to adding a task first. That way the deletion is the last thing a screen reader announces.
      const instead = page.getByRole('button', { name: /^Add a task to .* instead$/ });
      if (await instead.isVisible()) await instead.click();
      // A swipe that starts at the screen's edge does nothing, because the phone's Back gesture starts there.
      // Tapping elsewhere closes an open row.
      await swipe(K, 370);
      if (await page.$(`${K}.swiped`)) throw new Error('a swipe from the edge opened the row');
      /* After a short swipe left, releasing leaves the row open on its Delete button. Only the row moves. The red area is
         laid under the whole row from the start, with a real button named after the task at its end. It must never
         move, disappear or change size while the row gets there, which the test checks frame by frame. */
      await swipeRow(page, P, 'open', {
        check: async () => {
          const lies = await laidUnder(page, P, '.row-red');
          if (lies.inside || lies.off > 0.5 || lies.x > -20)
            throw new Error("the Delete button doesn't stay still under the row: " + JSON.stringify(lies));
          await watchSlide(page, P);
        },
      });
      await page.waitForSelector(`${P}.swiped`);
      let rest = await slideSeen(page);
      if (still(rest)) throw new Error('as the row came to rest open, ' + still(rest));
      if (rest.some(s => s.under === null)) throw new Error('the Delete button vanished on the way');
      if (Math.abs(rest.at(-1).x + 88) > 0.5)
        throw new Error('the row rests ' + rest.at(-1).x + 'px aside, not at the 88px Delete button');
      const del = page.getByRole('button', { name: 'Delete ' + o.title, exact: true }),
        pb = await page.locator(P).boundingBox(),
        db = await del.boundingBox();
      if (
        Math.abs(db.width - 88) > 0.5 ||
        Math.abs(db.x + db.width - (pb.x + 88 + pb.width)) > 0.5 ||
        Math.abs(db.height - pb.height) > 1.5
      )
        throw new Error("the Delete button isn't the 88px the row uncovers: " + JSON.stringify([db, pb]));
      if (
        await page
          .locator(P)
          .evaluate((row, b) => row.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)), db)
      )
        throw new Error('the row covers the Delete button');
      // Tapping anywhere else closes the row. The row glides back over the red area, which is removed only once the row covers it again.
      await watchSlide(page, P);
      await page.click('#view .sec .n >> nth=0');
      await page.waitForSelector(`${P}.swiped`, { state: 'detached' });
      rest = await slideSeen(page);
      if (still(rest)) throw new Error('as the row shut, ' + still(rest));
      if (rest.some(s => s.x < -1 && s.under === null))
        throw new Error('the Delete button left before the row was back over it');
      if (rest.at(-1).x || rest.at(-1).under !== null)
        throw new Error('after closing, the row is not back as it was: ' + JSON.stringify(rest.at(-1)));
      await expect(del).toHaveCount(0);
      if (await page.isVisible('#sheet')) throw new Error('shutting the row opened a task');
      // Releasing earlier, before a third of the Delete button is uncovered, closes the row the same way. The red area stays until the row covers it.
      const sb = await page.locator(P).boundingBox();
      await page.mouse.move(sb.x + sb.width - 40, sb.y + sb.height / 2);
      await page.mouse.down();
      await page.mouse.move(sb.x + sb.width - 62, sb.y + sb.height / 2 + 1, { steps: 4 });
      await expect(uncovered(page, '.row-red')).toHaveCount(1);
      await watchSlide(page, P);
      await page.mouse.up();
      rest = await slideSeen(page);
      if (still(rest)) throw new Error('as the row went back, ' + still(rest));
      if (rest.some(s => s.x < -1 && s.under === null) || rest.at(-1).x || rest.at(-1).under !== null)
        throw new Error(
          'after a release short of the Delete button, the red area left before the row was back: ' +
            JSON.stringify(rest.map(s => [Math.round(s.x), s.under])),
        );
      if (await page.$(`${P}.swiped, ${P}.swiping`))
        throw new Error('after a release short of the Delete button, the row stayed open');
      // Deleting removes the row and leaves a gap of the same height. The gap shows only "Deleted" and Restore, where
      // "+ me" was, and nothing is sent. Tapping anywhere on the gap brings the row back, sliding in from the left.
      const kh = await page.locator(K).evaluate(el => el.offsetHeight);
      await swipe(K);
      await tapDelete(K);
      await expect(page.locator(K)).toHaveClass(/\bdeleted\b/);
      await expect(page.locator(`${K} > .del-gap`)).toContainText('Deleted');
      await expect(page.locator(K).getByRole('button', { name: 'Restore ' + k.title })).toBeVisible();
      await expect(page.locator(`${K} > .body`)).toBeHidden();
      await expect(page.locator('#said')).toHaveText(`Deleted ${k.title}. Restore is where the row was.`);
      if (await page.$('#toast.show'))
        throw new Error('deleting showed a toast: ' + (await page.textContent('#toast-msg')));
      if ((await page.locator(K).evaluate(el => el.offsetHeight)) !== kh) throw new Error('the row height changed');
      if (!(await get(k.id))) throw new Error('the delete was sent while the row could still be restored');
      await watchFrames(K);
      await page.locator(`${K} > .del-gap`).click({ position: { x: 40, y: 10 } });
      await expect(page.locator(K)).not.toHaveClass(/\bdeleted\b/);
      await expect(page.locator(`${K} > .body`)).toBeVisible();
      const slid = await framesSeen();
      if (slid.some(s => s.h !== kh))
        throw new Error('the row height changed as it came back: ' + [...new Set(slid.map(s => s.h))]);
      if (!slid.some(s => !s.deleted && s.x < -s.w / 2)) throw new Error("the row didn't slide back in from the left");
      if (await page.isVisible('#sheet')) throw new Error('restoring the row opened the task');
      await synced(page);
      if (!(await get(k.id))) throw new Error("Restore didn't keep the task");
      // A full swipe: past half the row, the Delete fills it. If the swipe goes back under half before release, the row only opens.
      await page.locator(K).scrollIntoViewIfNeeded();
      await page.$eval(K, el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await page.waitForTimeout(100);
      const kb = await page.locator(K).boundingBox(),
        ky = kb.y + kb.height / 2;
      await page.mouse.move(330, ky);
      await page.mouse.down();
      await page.mouse.move(80, ky + 3, { steps: 10 });
      if (!(await page.$(`${K}.swipe-full`))) throw new Error("past half, the Delete didn't fill the row");
      await page.mouse.move(260, ky + 3, { steps: 6 });
      if (await page.$(`${K}.swipe-full`)) throw new Error('back under half, the Delete still filled the row');
      await page.mouse.up();
      await page.waitForSelector(`${K}.swiped`);
      if (await page.$(`${K}.deleted`)) throw new Error('the task was deleted after dragging back under half');
      // Continuing past half and releasing carries the row off the screen to the left, and it does not come back. A
      // gap of the same height stays in its place throughout, which the test checks frame by frame. The task is
      // deleted for good once the batch clears.
      await page.mouse.move(250, ky);
      await page.mouse.down();
      await page.mouse.move(90, ky + 3, { steps: 10 });
      await watchFrames(K);
      await watchSlide(page, K);
      await page.mouse.up();
      await page.waitForSelector(`${K}.deleted`);
      // Only the row moves, by its transform, as when it is marked done. The red area, its text and its right edge stay put.
      const left = await slideSeen(page);
      if (!left.some(s => s.moving.includes('row:transform')))
        throw new Error('the row never glided off: it only jumped');
      if (still(left)) throw new Error('as the row left, ' + still(left));
      await expect(uncovered(page, '.row-red')).toHaveCount(0); // the red area fades out over the gap
      const seen = await framesSeen(),
        far = seen.reduce((m, s, i) => (s.x < seen[m].x ? i : m), 0);
      if (seen.some(s => s.h !== kh))
        throw new Error('the row height changed as it went: ' + [...new Set(seen.map(s => s.h))]);
      if (seen[far].x > -0.9 * seen[far].w) throw new Error(`the row went only to ${seen[far].x}px of ${seen[far].w}`);
      if (seen.slice(far).some(s => s.shown)) throw new Error('the row came back into sight');
      if (!seen.at(-1).deleted || !seen.at(-1).gap)
        throw new Error('no gap where the row was: ' + JSON.stringify(seen.at(-1)));
      await expect(page.locator(`${K} > .body`)).toBeHidden();
      if (!(await get(k.id))) throw new Error('the task was deleted while it could still be restored');
      await expect(page.locator('#said')).toHaveText(`Deleted ${k.title}. Restore is where the row was.`); // the row is kept until it is sent, so it is marked
      await later(3000);
      await expect(page.locator(K)).toHaveCount(0);
      await synced(page);
      if (await get(k.id)) throw new Error('the task was never deleted');
      if (await page.$(K)) throw new Error('the row came back');
    } finally {
      for (const t of [k, p, o]) await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });
  await step('a-subtask-swiped-in-its-sheet-is-restored-from-its-row', async () => {
    const p = await make(`Pocket smoke sheet parent ${stamp}`, { due_date: todayAt(23) }),
      k = await make(`Pocket smoke sheet kid ${stamp}`);
    await api(`/tasks/${p.id}/relations`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ other_task_id: k.id, relation_kind: 'subtask' }),
    });
    const K = `#d-subtasks > .row:has(.title:text-is("${k.title}"))`;
    try {
      await toastGone();
      await refreshToday();
      await page.click(`${cardOf(p.title)} > .card-head`, { timeout: 15000 });
      await page.waitForSelector(K, { timeout: 10000 });
      await page.waitForFunction(() => getComputedStyle(document.getElementById('sheet')).transform === 'none', null, {
        timeout: 5000,
      }); // the sheet has finished sliding in
      await swipe(K);
      // With the row open on its Delete, which lies under it in the subtasks' card, the card clips to its rounded
      // corners in both directions, because the row over it is solid.
      await page.waitForSelector(`${K}.swiped`);
      const clips = await page.locator('#d-subtasks').evaluate(el => {
        const s = getComputedStyle(el);
        return [s.overflowX, s.overflowY, s.position, parseFloat(s.borderTopLeftRadius) > 0];
      });
      if (JSON.stringify(clips) !== '["clip","clip","relative",true]')
        throw new Error("a swiped subtask's card doesn't clip to its corners: " + clips);
      const lies = await laidUnder(page, K, '.row-red');
      if (lies.inside || lies.off > 0.5)
        throw new Error("a subtask's Delete isn't laid under it: " + JSON.stringify(lies));
      await tapDelete(K);
      await page.waitForSelector(`${K}.deleted`);
      if (!(await page.isVisible('#sheet'))) throw new Error('the sheet closed');
      // The subtask's line on the card behind the sheet shows it as deleted too.
      await page
        .locator('#sheet')
        .getByRole('button', { name: 'Restore ' + k.title })
        .click();
      await page.waitForSelector(`${K}:not(.deleted)`);
      if (!(await get(k.id))) throw new Error("Restore didn't keep the task");
      // The ⋯ menu deletes the task and its subtask after asking, which is the way for a keyboard or screen reader. The
      // task's card on Today becomes a gap with Restore.
      await page.click('#d-more');
      await page.click('#d-delete');
      await page.waitForSelector('#sheet', { state: 'hidden' });
      await page.waitForSelector(`${cardOf(p.title)}.deleted`);
      await expect(page.locator(cardOf(p.title)).getByRole('button', { name: 'Restore ' + p.title })).toBeVisible();
      await expect(page.locator('#said')).toHaveText(`Deleted ${p.title}. Restore is where the row was.`);
      await later(3000);
      await expect(page.locator(cardOf(p.title))).toHaveCount(0);
      await synced(page);
      if ((await get(k.id)) || (await get(p.id))) throw new Error('the task was never deleted');
    } finally {
      if (await page.isVisible('#sheet')) await page.click('#btn-sheet-close');
      for (const t of [k, p]) await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });

  /* A task with subtasks asks for confirmation before its row slides away, not after. After the card's header is
     swiped all the way left and released, the question appears with the header still where it was released, over its
     Delete. Cancel moves the header back and changes nothing. OK moves it off the screen and the card becomes a gap
     with Restore. The test answers the question in the page, and records where the header was when it was asked. */
  await step('a-task-with-subtasks-asks-before-its-row-slides-away', async () => {
    const p = await make(`Pocket smoke asks ${stamp}`, { due_date: todayAt(23) }),
      k = await make(`Pocket smoke asks kid ${stamp}`);
    await api(`/tasks/${p.id}/relations`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ other_task_id: k.id, relation_kind: 'subtask' }),
    });
    const card = cardOf(p.title),
      head = `${card} > .card-head`;
    const asked = () => page.evaluate(() => window.__asked);
    try {
      await toastGone();
      await refreshToday();
      await page.waitForSelector(head, { timeout: 15000 });
      await page.locator(head).evaluate(h => {
        window.__asked = [];
        window.__answer = false;
        window.__confirm = window.confirm;
        window.confirm = q => {
          window.__asked.push({
            q,
            x: new DOMMatrix(getComputedStyle(h).transform).m41,
            w: h.clientWidth,
            moving: h.getAnimations().length,
            deleted: h.parentElement.classList.contains('deleted'),
            red: !!document.querySelector('.row-red.row-under'),
          });
          return window.__answer;
        };
      });
      await swipeRow(page, head, 'delete');
      await expect.poll(async () => (await asked()).length).toBe(1);
      let a = (await asked())[0];
      if (a.q !== `Delete “${p.title}” and its 1 subtask?`) throw new Error('the question was: ' + a.q);
      if (a.x > -a.w / 2 || a.moving || a.deleted || !a.red)
        throw new Error('the question was asked after the header had moved on: ' + JSON.stringify(a));
      // Cancel: the header goes back where it was, with nothing under it, and nothing changes.
      await expect(page.locator(head)).not.toHaveClass(/\bswip/);
      await expect(uncovered(page, '.row-red')).toHaveCount(0);
      if (await page.locator(head).evaluate(h => h.style.transform))
        throw new Error('after Cancel, the header is still moved aside');
      await expect(page.locator(card)).not.toHaveClass(/\bdeleted\b/);
      await expect(page.locator(`${card} > .del-gap`)).toHaveCount(0);
      await synced(page);
      if (!(await get(p.id)) || !(await get(k.id))) throw new Error('Cancel deleted the task');
      // OK: the question is asked the same way, then the card becomes a gap with Restore. The task and its subtask are deleted once the batch clears.
      await page.evaluate(() => {
        window.__answer = true;
      });
      await swipeRow(page, head, 'delete');
      await expect(page.locator(card)).toHaveClass(/\bdeleted\b/);
      a = (await asked())[1];
      if (!a || a.x > -a.w / 2 || a.moving || a.deleted)
        throw new Error('the question was asked after the header had moved on: ' + JSON.stringify(a));
      if ((await asked()).length !== 2) throw new Error('the question was asked ' + (await asked()).length + ' times');
      await expect(page.locator(card).getByRole('button', { name: 'Restore ' + p.title })).toBeVisible();
      await expect(uncovered(page, '.row-red')).toHaveCount(0);
      await expect(page.locator('#said')).toHaveText(`Deleted ${p.title}. Restore is where the row was.`);
      await later(3000);
      await expect(page.locator(card)).toHaveCount(0);
      await synced(page);
      if ((await get(k.id)) || (await get(p.id))) throw new Error('the task was never deleted');
    } finally {
      await page.evaluate(() => {
        if (window.__confirm) window.confirm = window.__confirm;
      });
      for (const t of [k, p]) await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });

  /* Deleting a subtask on Today and then its parent, both while Restore shows, deletes both. The subtask's deletion is
     already waiting, so the parent's deletion neither counts the subtask nor asks about it. Both are sent when the
     batch clears, and nothing is left in the Outbox. The subtask's deletion leaves its parent's progress alone,
     because the parent is being deleted. */
  await step('a-subtask-and-then-its-parent-deleted-on-today-are-both-deleted', async () => {
    const p = await make(`Pocket smoke gone parent ${stamp}`, { due_date: todayAt(23) }),
      k = await make(`Pocket smoke gone kid ${stamp}`, { due_date: todayAt(23) });
    await api(`/tasks/${p.id}/relations`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ other_task_id: k.id, relation_kind: 'subtask' }),
    });
    const card = cardOf(p.title),
      K = `${card} > .card-rows > ${rowOf(k.title)}`,
      missing = [],
      asked = [];
    const see = r => r.status() === 404 && missing.push(r.request().method() + ' ' + new URL(r.url()).pathname);
    const ask = d => asked.push(d.message()); // the handler at the top answers it
    const failed = () =>
      page.evaluate(() =>
        Alpine.$data(document.body).failed.map(f => ({
          task: f.task,
          op: f.op,
          stage: f.stage,
          message: f.failed.message,
        })),
      );
    goneOnPurpose.push(k.id, p.id);
    page.on('response', see);
    page.on('dialog', ask);
    try {
      await toastGone();
      await refreshToday();
      await page.waitForSelector(K, { timeout: 15000 });
      await swipeRow(page, K, 'delete');
      await expect(page.locator(K)).toHaveClass(/\bdeleted\b/);
      await swipeRow(page, `${card} > .card-head`, 'delete');
      await expect(page.locator(card)).toHaveClass(/\bdeleted\b/);
      if (asked.length) throw new Error('asked: ' + asked.join(' | '));
      await later(3000);
      await expect(page.locator(card)).toHaveCount(0);
      await synced(page).catch(async e => {
        throw new Error(
          `${e.message}. Refused: ${JSON.stringify(await failed())}. Answered 404: ${missing.join(', ')}`,
        );
      });
      await expect.poll(async () => !!((await get(k.id)) || (await get(p.id)))).toBe(false);
      const unsent = await page.evaluate(() => Alpine.$data(document.body).unsent);
      if (unsent) throw new Error(`${unsent} left in the Outbox. Refused: ${JSON.stringify(await failed())}`);
    } finally {
      page.off('response', see);
      page.off('dialog', ask);
      for (const t of [k, p]) await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });

  /* A card's header is a 44px strip. The ring and the title's line are centred in it, the title's touch target is the
     strip's full height, and the ring that a swipe uncovers is centred in it too, clear of its edges. (It used to sit
     on the strip's bottom edge and was cut off.) The project's dot comes last, level with the middle of the time's
     letters as in a row, clear of the strip's end, and it does not make the strip taller. */
  await step('a-cards-header-has-its-line-and-its-swipes-ring-centred-in-its-strip', async () => {
    const p = await make('Strip', { due_date: todayAt(23), priority: 3 }),
      k = await make(`Pocket smoke strip kid ${stamp}`);
    await api(`/tasks/${p.id}/relations`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ other_task_id: k.id, relation_kind: 'subtask' }),
    });
    const head = `${cardOf(p.title)} > .card-head`;
    try {
      await toastGone();
      await refreshToday();
      await page.waitForSelector(head, { timeout: 15000 });
      const lies = await page.locator(head).evaluate(h => {
        const mid = el => {
            const r = el.getBoundingClientRect();
            return (r.top + r.bottom) / 2;
          },
          r = h.getBoundingClientRect();
        // The line is centred in the 44px strip that the title's touch target covers. The header itself is 38px, so the
        // first row sits closer under it.
        const strip = mid(h.querySelector('.card-open'));
        return {
          h: r.height,
          ring: mid(h.querySelector(':scope > .ring')) - strip,
          title: mid(h.querySelector('.card-title')) - strip,
          bars: !!h.querySelector('.bars'),
          tap: h.querySelector('.card-open').getBoundingClientRect().height,
          dot: [h.querySelector('.card-open > .dot')].filter(Boolean).map(d => ({
            off: mid(d) - mid(h.querySelector('.due')),
            after: d.getBoundingClientRect().left - h.querySelector('.due').getBoundingClientRect().right,
            end: r.right - d.getBoundingClientRect().right,
          }))[0],
        };
      });
      if (lies.h !== 38 || Math.abs(lies.ring) > 0.5 || Math.abs(lies.title) > 0.5 || lies.tap !== 44 || !lies.bars)
        throw new Error("the header's line isn't centred in the strip: " + JSON.stringify(lies));
      if (!lies.dot || Math.abs(lies.dot.off) > 1.5 || lies.dot.after < 4 || lies.dot.end < 12)
        throw new Error(
          "the project's dot isn't level with the time, after it and clear of the strip's end: " + JSON.stringify(lies),
        );
      await swipeRow(page, head, 'back', {
        one: true,
        check: async () => {
          await expect(uncovered(page)).toHaveClass(/\bhead\b/);
          const under = await laidUnder(page, head),
            ring = await uncovered(page).evaluate(u => {
              const a = u.getBoundingClientRect(),
                b = u.querySelector('.ring').getBoundingClientRect();
              return { over: b.top - a.top, under: a.bottom - b.bottom, h: a.height };
            });
          if (under.inside || under.off > 0.5)
            throw new Error("the space the header uncovers isn't laid under it: " + JSON.stringify(under));
          // The ring is centred in the 44px strip, which starts at the top of the 38px header.
          if (ring.h !== 38 || ring.over < 4 || Math.abs((ring.over + ring.h - ring.under) / 2 - 22) > 0.5)
            throw new Error(
              "the ring a swipe uncovers isn't centred in the strip, clear of its edges: " + JSON.stringify(ring),
            );
        },
      });
      await expect(uncovered(page)).toHaveCount(0);
    } finally {
      for (const t of [k, p]) await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });

  /* A task's sheet starts with one card containing the task's own row, with its notes, photos and files under it. Tapping
     the title edits it in place. A full swipe right ticks the task in place, with no gap, because the sheet is about
     this one task. Swiping left at 0% deletes the task. The sheet closes on the list, where the gap has Restore. */
  await step('a-tasks-sheet-leads-with-its-row', async () => {
    const t = await make(`Pocket smoke sheet card ${stamp}`, {
      due_date: todayAt(23),
      description: '<p>Bring the <b>ladder</b></p>',
    });
    const R = `#view ${rowOf(t.title)}`,
      own = '#sheet .row.own',
      renamed = `${t.title} renamed`;
    try {
      await toastGone();
      await refreshToday();
      await page.click(`${R} > .body`, { timeout: 15000 });
      await expect(page.locator(`#d-card > ${own.slice(7)}`)).toBeVisible();
      await expect(ownTitle()).toHaveText(t.title);
      await expect(page.locator('#d-card #d-desc')).toContainText('Bring the ladder');
      await expect(page.locator('#d-card #d-file')).toBeAttached();
      await expect(page.locator('#sheet .h3', { hasText: /^(Notes|Attachments)/ })).toHaveCount(0);
      await page.waitForFunction(() => getComputedStyle(document.getElementById('sheet')).transform === 'none', null, {
        timeout: 5000,
      }); // the sheet has finished sliding in
      // Tapping the title replaces it with a text box. Enter saves it.
      await ownTitle().click();
      await expect(page.locator(`${own} #d-title`)).toBeFocused();
      await page.fill('#d-title', renamed);
      await page.press('#d-title', 'Enter');
      await expect(ownTitle()).toHaveText(renamed);
      await synced(page);
      if ((await get(t.id)).title !== renamed) throw new Error('saved as ' + (await get(t.id)).title);
      // A full swipe right ticks the task in place with no gap, and the sheet stays open.
      await slideProgress(own, 100);
      await expect(page.locator(own)).toHaveClass(/\bdone\b/);
      await expect(page.locator(`${own} > .del-gap`)).toHaveCount(0);
      await expect(page.locator('#sheet')).toBeVisible();
      await synced(page);
      if (!(await get(t.id)).done) throw new Error('not done in Vikunja');
      await page.click(`${own} > .check`);
      await expect(page.locator(own)).not.toHaveClass(/\bdone\b/);
      await synced(page);
      if ((await get(t.id)).done) throw new Error('tapping the tick again left the task done');
      // Swiping left at 0% deletes the task. The sheet closes on the list, where the gap has Restore.
      await swipeRow(page, own, 'delete');
      await page.waitForSelector('#sheet', { state: 'hidden', timeout: 10000 });
      await expect(page.locator(R)).toHaveClass(/\bdeleted\b/);
      await page
        .locator(R)
        .getByRole('button', { name: 'Restore ' + renamed })
        .click();
      await expect(page.locator(R)).not.toHaveClass(/\bdeleted\b/);
      await synced(page);
      if (!(await get(t.id))) throw new Error("Restore didn't keep the task");
    } finally {
      await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });
  /* A parent's sheet shows the ring in the task's row and has no Progress line in Details, because the parent's
     progress comes from its subtasks. If the ring's question is closed in any way other than its own buttons (×, the
     shade, the phone's Back), the user returns to the task's sheet, as with Cancel. A full swipe right on the row
     asks the same question. */
  await step('the-question-a-parents-ring-asks-from-its-sheet-goes-back-to-it', async () => {
    const P = await make(`Pocket smoke asked from its sheet ${stamp}`, { due_date: todayAt(23) }),
      kids = [await make(`Pocket smoke asked 1 ${stamp}`), await make(`Pocket smoke asked 2 ${stamp}`)];
    for (const k of kids)
      await api(`/tasks/${P.id}/relations`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ other_task_id: k.id, relation_kind: 'subtask' }),
      });
    const ring = page.locator('#sheet .row.own > .ring'),
      question = page.locator('#complete h2');
    const backInIt = async () => {
      await expect(question).toHaveCount(0);
      await expect(ownTitle()).toHaveText(P.title);
      await expect(ring).toBeVisible();
    };
    try {
      await toastGone();
      await refreshToday();
      await page.click(`${cardOf(P.title)} > .card-head .card-open`, { timeout: 15000 });
      await expect(ring.locator('.n')).toHaveText('0/2');
      await expect(page.locator('#d-progress')).toHaveCount(0);
      await page.waitForFunction(() => getComputedStyle(document.getElementById('sheet')).transform === 'none', null, {
        timeout: 5000,
      });
      await ring.click();
      await expect(question).toHaveText(`Complete “${P.title}”?`);
      await page.click('#btn-sheet-close');
      await backInIt();
      await ring.click();
      await expect(question).toBeVisible();
      await page.waitForSelector('#sheet.show');
      await page.mouse.click(195, 20); // the dimmed area above the sheet
      await backInIt();
      await page.waitForSelector('#sheet.show');
      await swipeRow(page, '#sheet .row.own', 100, { one: true });
      await expect(question).toBeVisible();
      await page.waitForSelector('#sheet.show');
      await page.goBack(); // the phone's Back
      await backInIt();
      // Pressing Back once more closes the task's sheet and stays on Today.
      await page.waitForSelector('#sheet.show');
      await page.goBack();
      await page.waitForSelector('#sheet', { state: 'hidden', timeout: 10000 });
      if (!(await page.evaluate(() => location.hash)).startsWith('#/today')) throw new Error('Back left Today');
      await synced(page);
      if ((await get(P.id)).done || (await Promise.all(kids.map(k => get(k.id)))).some(k => k.done))
        throw new Error('something was completed');
    } finally {
      if (await page.isVisible('#sheet')) await page.click('#btn-sheet-close');
      for (const t of [...kids, P]) await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });

  /* Dragging the sheet down with a touch (`finger` in helpers.mjs uses Chrome's own touch input). A drag down that
     starts in a text field moves nothing. Neither does a drag that starts beside a field being typed in, which only
     hides the phone's keyboard. A drag from the sheet's bar follows the touch and closes the sheet, whether or not a
     field has focus. When nothing is being typed in, a drag from anywhere at the sheet's top does the same. A date
     field that kept the focus does not block it. If the phone cancels the touch mid-drag, the sheet goes back up. */
  const { touch, touchDrag } = await finger(page);
  await step('a-touch-in-a-text-field-never-slides-the-sheet-and-its-bar-always-does', async () => {
    const t = await make(`Pocket smoke sheet slide ${stamp}`, {
      due_date: todayAt(23),
      description: '<p>Bring the ladder</p>',
    });
    const R = `#view ${rowOf(t.title)}`,
      sheet = page.locator('#sheet');
    const open = async () => {
      await page.click(`${R} > .body`, { timeout: 15000 });
      await expect(page.locator('#sheet .row.own')).toBeVisible();
      await page.waitForFunction(() => getComputedStyle(document.getElementById('sheet')).transform === 'none', null, {
        timeout: 5000,
      }); // the sheet has finished sliding in
    };
    // How far the sheet is pulled down while the user is touching it (its inline transform, empty after release), and whether it is scrolled to the top.
    const pulled = () => sheet.evaluate(el => el.style.transform);
    const still = what => async () => {
      if (await pulled()) throw new Error(`a pull down ${what} moved the sheet: ${await pulled()}`);
    };
    const follows = what => () =>
      expect.poll(pulled, { message: `a pull down ${what} moves the sheet with the touch` }).toBe('translateY(160px)');
    const atTop = async () => {
      if (await page.$eval('#sheet .scroll', el => el.scrollTop))
        throw new Error("the sheet isn't scrolled to its top");
    };
    const pull = (sel, check) => touchDrag(sel, 160, 8, 40, 0, { check });
    const closed = () => page.waitForSelector('#sheet', { state: 'hidden', timeout: 5000 });
    try {
      await toastGone();
      await refreshToday();
      await open();
      // While the notes are being edited, a drag down that starts in them moves nothing, and neither does one beside them.
      await page.click('#d-desc');
      await expect(page.locator('#d-desc-in')).toBeFocused();
      await atTop();
      await pull('#d-desc-in', still('that starts in the notes'));
      await pull('#sheet #d-path', still('beside the notes, which have the focus,'));
      await expect(sheet).toBeVisible();
      await expect(page.locator('#d-desc-in')).toBeFocused();
      // A drag from the bar follows the touch and closes the sheet, even with the notes focused.
      await pull('#sheet .bar', follows('from the bar, with the notes focused,'));
      await closed();
      // While the title is being edited the same holds, and a drag that starts in the title box does not move the row either.
      await open();
      await ownTitle().click();
      await expect(page.locator('#d-title')).toBeFocused();
      await pull('#d-title', still("that starts in the title's box"));
      await pull('#sheet #d-path', still('beside the title, which has the focus,'));
      await expect(page.locator('#d-title')).toBeFocused();
      await page.press('#d-title', 'Escape');
      // With nothing focused, a drag works from the bar and from anywhere at the sheet's top.
      await expect(page.locator('#sheet #d-title')).toHaveCount(0);
      // The phone cancels the touch mid-drag, well past the point where releasing would close the sheet. The sheet goes back up and stays open.
      await touchDrag('#sheet .bar', 160, 8, 40, 0, { check: follows('from the bar'), cancel: true });
      await expect.poll(pulled, { message: 'the sheet is released when the touch is cancelled' }).toBe('');
      await page.waitForFunction(() => getComputedStyle(document.getElementById('sheet')).transform === 'none', null, {
        timeout: 5000,
      }); // the sheet is back up
      if (!(await page.evaluate(() => Alpine.$data(document.body).sheet.show)))
        throw new Error('cancelling the touch mid-drag closed the sheet');
      await pull('#sheet .bar', follows('from the bar'));
      await closed();
      await open();
      await atTop();
      await pull('#sheet #d-path', follows("at the sheet's top, with nothing focused,"));
      await closed();
      // A date field, like a select, keeps the focus after its picker closes, with no keyboard showing. It does not
      // block the sheet's drag. A drag that starts on the field still belongs to the field.
      await open();
      await page.focus('#d-due');
      await atTop();
      await pull('#d-due', still('that starts on the due date'));
      await expect(page.locator('#d-due')).toBeFocused();
      await pull('#sheet #d-path', follows('beside a date that kept the focus'));
      await closed();
      await synced(page);
      const now = await get(t.id);
      if (now.title !== t.title || !now.description.includes('Bring the ladder'))
        throw new Error('something was changed: ' + JSON.stringify([now.title, now.description]));
    } finally {
      if (await page.isVisible('#sheet')) await page.click('#btn-sheet-close', { timeout: 2000 }).catch(() => {}); // the sheet may still be sliding down
      await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });

  /* The notes box is as tall as its text, like every other box. Long notes scroll with the sheet, never inside their
     box, because scrolling back up inside the box would pull the sheet down. Short notes keep the box's minimum
     height. Typing at the end of the notes leaves the sheet at the same scroll position. */
  await step('the-notes-box-grows-with-its-text', async () => {
    const t = await make(`Pocket smoke long notes ${stamp}`, {
      due_date: todayAt(23),
      description: '<p>Short notes</p>',
    });
    const lines = n => Array.from({ length: n }, (_, i) => `Line ${i + 1} of the notes`).join('\n');
    // The box's height, how far its text can scroll inside it, and the sheet's scroll position.
    const box = () =>
      page.$eval('#d-desc-in', ta => ({
        height: ta.offsetHeight,
        inside: ta.scrollHeight - ta.clientHeight,
        line: parseFloat(getComputedStyle(ta).lineHeight),
        sheet: ta.closest('.scroll').scrollTop,
      }));
    try {
      await toastGone();
      await refreshToday();
      await page.click(`#view ${rowOf(t.title)} > .body`, { timeout: 15000 });
      await page.click('#d-desc');
      await expect(page.locator('#d-desc-in')).toBeFocused();
      const short = await box();
      if (short.height !== 140 || short.inside > 0) throw new Error('short notes: ' + JSON.stringify(short));
      await page.fill('#d-desc-in', lines(120));
      await expect.poll(async () => (await box()).height).toBeGreaterThanOrEqual(120 * short.line);
      const long = await box();
      if (long.inside > 0) throw new Error(`long notes can scroll ${long.inside}px inside their box`);
      // Type in the middle of the notes, with the sheet scrolled so that line is visible and the end of the notes is
      // not. The sheet must stay where it was. (Measuring the box at its minimum height first would pull the sheet's end up.)
      await page.$eval('#d-desc-in', ta => ta.scrollIntoView({ block: 'end', behavior: 'instant' }));
      await page.$eval('#sheet .scroll', el => {
        el.scrollTop -= 300;
      });
      const was = await box();
      if (was.sheet < 100) throw new Error("the sheet didn't scroll with the notes: " + JSON.stringify(was));
      await page.$eval('#d-desc-in', (ta, at) => ta.setSelectionRange(at, at), lines(100).length);
      await page.keyboard.press('Enter');
      await page.keyboard.type('and more');
      await expect.poll(async () => (await box()).height).toBeGreaterThanOrEqual(was.height + short.line - 1); // one line taller
      if ((await page.inputValue('#d-desc-in')) !== lines(100) + '\nand more' + lines(120).slice(lines(100).length))
        throw new Error('the text was typed in the wrong place');
      const more = await box();
      if (Math.abs(more.sheet - was.sheet) > 1 || more.inside > 0)
        throw new Error(
          `typing a line moved the sheet from ${was.sheet} to ${more.sheet}, or scrolls inside the box (${more.inside}px)`,
        );
      // Rotating the phone rewraps the lines, and the box resizes to fit them again, both ways.
      await page.fill('#d-desc-in', 'some words to fill a line of the notes up, and on to the next. '.repeat(12));
      await expect.poll(async () => (await box()).height).toBeGreaterThan(300);
      const upright = await box();
      await page.setViewportSize({ width: 844, height: 390 });
      await expect.poll(async () => (await box()).height).toBeLessThan(upright.height - 100);
      if ((await box()).inside > 0) throw new Error('after rotating, the notes scroll inside their box');
      await page.setViewportSize({ width: 390, height: 844 });
      await expect.poll(async () => (await box()).height).toBe(upright.height);
      if ((await box()).inside > 0) throw new Error('after rotating back, the notes scroll inside their box');
      // After most of the text is removed, the box goes back to its minimum height.
      await page.fill('#d-desc-in', lines(2));
      await expect.poll(async () => (await box()).height).toBe(140);
      await page.click('#d-desc-cancel');
    } finally {
      await page.setViewportSize({ width: 390, height: 844 });
      if (await page.isVisible('#sheet')) await page.click('#btn-sheet-close', { timeout: 2000 }).catch(() => {});
      await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });

  /* A title that is being edited is saved when the sheet closes, however it closes. The title box saves when it loses
     focus, which happens when the user presses × or taps the dimmed area. Dragging the sheet down by its bar or pressing
     the phone's Back does not take the focus away, so leaving the sheet saves the title too. An emptied title keeps its old text. */
  await step('a-title-being-changed-is-saved-however-the-sheet-closes', async () => {
    const name = how => `Pocket smoke title ${how} ${stamp}`,
      t = await make(name('as made'), { due_date: todayAt(23) });
    const R = `#view .row[data-id="${t.id}"]`;
    // Opens the sheet as on an iPhone, where tapping a button does not focus it. Nothing takes the focus back when the
    // sheet closes. (A mouse click would leave the focus on the row, and the title box would lose it at that point.)
    const change = async to => {
      await expect(page.locator(`${R} > .body`)).toBeVisible({ timeout: 15000 });
      await page.$eval(`${R} > .body`, el => {
        document.activeElement?.blur();
        el.click();
      });
      await expect(page.locator('#sheet .row.own')).toBeVisible();
      await page.waitForFunction(() => getComputedStyle(document.getElementById('sheet')).transform === 'none', null, {
        timeout: 5000,
      }); // the sheet has finished sliding in
      await ownTitle().click();
      await expect(page.locator('#d-title')).toBeFocused();
      await page.fill('#d-title', to);
    };
    const saved = async (to, how) => {
      await page.waitForSelector('#sheet', { state: 'hidden', timeout: 5000 });
      await expect(
        page.locator(`${R} > .body .title > span:not(.sr)`).first(),
        `the row after the sheet was ${how}`,
      ).toHaveText(to);
      await synced(page);
      if ((await get(t.id)).title !== to) throw new Error(`the sheet ${how}: Vikunja has "${(await get(t.id)).title}"`);
    };
    try {
      await toastGone();
      await refreshToday();
      await change(name('slid down'));
      await touchDrag('#sheet .bar', 160);
      await saved(name('slid down'), 'slid down by its bar');
      await change(name('gone back from'));
      await page.goBack();
      await saved(name('gone back from'), "closed by the phone's Back");
      await change(name('closed'));
      await page.click('#btn-sheet-close');
      await saved(name('closed'), 'closed by its ×');
      await change(name('shaded'));
      await page.mouse.click(195, 20); // the dimmed area above the sheet
      await saved(name('shaded'), 'closed by a tap on the shade');
      // Emptying the title and then dragging the sheet down keeps the old title.
      await change('   ');
      await touchDrag('#sheet .bar', 160);
      await saved(name('shaded'), 'slid down with its title emptied');
    } finally {
      if (await page.isVisible('#sheet')) await page.click('#btn-sheet-close', { timeout: 2000 }).catch(() => {});
      await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });

  /* Every element that can be swiped sets touch-action to tell the phone that a sideways drag is a swipe, not a scroll.
     That way the phone never cancels the touch as a swipe starts. This applies to a list's row, a card, a sheet's
     subtasks and the sheet's own row. (A checklist's own row and its steps are covered in checklists.mjs.) The mouse
     that the other swipe tests use never meets this rule, so the sheet's own row is swiped here with a touch. */
  await step('whatever-is-swiped-tells-the-phone-sideways-is-a-swipe', async () => {
    const P = await make(`Pocket smoke sideways ${stamp}`, { due_date: todayAt(23) }),
      kid = await make(`Pocket smoke sideways kid ${stamp}`);
    const plain = await make(`Pocket smoke sideways plain ${stamp}`, { due_date: todayAt(23) });
    await api(`/tasks/${P.id}/relations`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ other_task_id: kid.id, relation_kind: 'subtask' }),
    });
    const sideways = (what, sel) =>
      expect(page.locator(sel).first(), what).toHaveCSS('touch-action', 'pan-y pinch-zoom');
    const own = '#d-card > .row.own',
      shut = async () => {
        await page.click('#btn-sheet-close');
        await page.waitForSelector('#sheet', { state: 'hidden' });
      };
    try {
      await toastGone();
      await refreshToday();
      await sideways("a list's row", `#view ${rowOf(plain.title)}`);
      await sideways('a card, for its header and its rows', cardOf(P.title));
      // A parent's sheet has rows for its subtasks and its own row, which a full swipe right completes.
      await page.click(`${cardOf(P.title)} > .card-head .card-open`, { timeout: 15000 });
      await expect(page.locator(own)).toBeVisible();
      await sideways('a subtask in a sheet', '#d-subtasks > .row');
      await sideways("a parent's own row in its sheet", own);
      await shut();
      // A plain task's sheet: swipe its own row to 25% with a touch, and the touch is never cancelled on the way.
      await page.click(`#view ${rowOf(plain.title)} > .body`);
      await expect(page.locator(own)).toBeVisible();
      await page.waitForFunction(() => getComputedStyle(document.getElementById('sheet')).transform === 'none', null, {
        timeout: 5000,
      }); // the sheet has finished sliding in
      await sideways("the sheet's own row", own);
      await swipeRow(page, own, 25, { finger: touch });
      await expect
        .poll(() => page.$eval(own, el => getComputedStyle(el).getPropertyValue('--pct').trim()))
        .toBe('0.25');
      await expect(page.locator('#sheet')).toBeVisible();
      await synced(page);
      if (Math.round((await get(plain.id)).percent_done * 100) !== 25)
        throw new Error('after a touch swipe, Vikunja has ' + (await get(plain.id)).percent_done);
      await shut();
    } finally {
      if (await page.isVisible('#sheet')) await page.click('#btn-sheet-close', { timeout: 2000 }).catch(() => {});
      for (const t of [kid, P, plain]) await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });

  await step('leaving-the-screen-sends-a-deletion-at-once', async () => {
    // Delete a task on its project's list, then tap another tab before the batch clears. The deletion is sent then, not left waiting.
    const x = await make(`Pocket smoke leave ${stamp}`, { due_date: todayAt(23) }),
      X = rowOf(x.title);
    try {
      await toastGone();
      await refreshToday();
      await page.evaluate(id => {
        location.hash = '#/project/' + id;
      }, home2);
      await loaded(page);
      await swipe(X, 330, -260);
      await page.waitForSelector(`${X}.deleted`);
      await page.click('nav.tabs a[data-tab=today]');
      await page.waitForFunction(() => location.hash.startsWith('#/today'));
      await synced(page);
      if (await get(x.id)) throw new Error('the deletion was not sent on leaving the screen');
      await loaded(page);
      await expect(page.locator(X)).toHaveCount(0);
    } finally {
      await api('/tasks/' + x.id, { method: 'DELETE' });
    }
  });

  const positionsSent = () => {
    const sent = [],
      see = r => /\/position$/.test(r.url()) && sent.push(r.url());
    page.on('request', see);
    return { sent, off: () => page.off('request', see) };
  };
  const idsIn = (...ids) =>
    page
      .locator(ids.map(id => `#view .row[data-id="${id}"]`).join(', '))
      .evaluateAll(els => els.map(el => +el.dataset.id));
  /* Holds a row where holding does nothing (search results have no order of their own). The row must not lift. The
     touch then moves up or down onto the row `to` and is released, and nothing may follow the touch. */
  async function holdAndMove(sel, to) {
    await page.locator(sel).evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    const box = await steady(page.locator(sel)),
      x = box.x + box.width / 2,
      y0 = box.y + box.height / 2,
      y = (await page.locator(to).boundingBox()).y + 4;
    await page.mouse.move(x, y0);
    await page.mouse.down();
    await later(700);
    await expect(page.locator(sel)).not.toHaveClass(/\bheld\b/);
    await page.mouse.move(x, y0 + Math.sign(y - y0) * 14, { steps: 3 });
    await page.mouse.move(x, y, { steps: 12 });
    const moving = await page.$('#view .list.reordering, #view .dragged');
    await page.mouse.up();
    if (moving) throw new Error('the row followed the touch');
  }
  /* Today behaves like any list. Swiping a row left at 0% shows its Delete, and a full swipe leaves a gap with
     Restore. A row with progress takes two swipes to delete. The first only lowers the progress to 0%, however far it
     is dragged. The second shows the Delete. No position is written on Today, because Today is ordered by due date.
     Holding a row there shows date chips around the touch instead (see the tests after this one). */
  await step('today-deletes-by-a-swipe', async () => {
    const a = await make(`Pocket smoke doing A ${stamp}`, { due_date: todayAt(21) }),
      b = await make(`Pocket smoke doing B ${stamp}`, { due_date: todayAt(22), percent_done: 0.5 });
    const A = rowOf(a.title),
      B = rowOf(b.title),
      moves = positionsSent();
    try {
      await toastGone();
      await refreshToday();
      await expect(page.locator(B)).toBeVisible({ timeout: 15000 });
      if (JSON.stringify(await idsIn(a.id, b.id)) !== JSON.stringify([a.id, b.id]))
        throw new Error('the rows did not start in due order');
      // B is at 50%. Swiping it all the way left only lowers it to 0%, with no red area on the way.
      await slideProgress(
        B,
        0,
        async () => {
          await expect(uncovered(page)).toHaveAttribute('data-pct', '0');
          if (await page.$(`${B}.swiping, ${B}.swipe-full`))
            throw new Error('a row with progress swiped left showed its Delete');
        },
        50,
      );
      await expect(page.locator('#said')).toHaveText(`Progress of ${b.title} set to 0%`);
      await synced(page);
      if (!(await get(b.id)) || Math.round((await get(b.id)).percent_done * 100) !== 0)
        throw new Error('after the first swipe: ' + JSON.stringify(await get(b.id)));
      // Swiping again, now at 0%, shows the Delete. A full swipe deletes the task and leaves a gap with Restore.
      await swipeRow(page, B, 'delete');
      await expect(page.locator(B)).toHaveClass(/\bdeleted\b/);
      await expect(page.locator(B).getByRole('button', { name: 'Restore ' + b.title })).toBeVisible();
      // A is at 0%. A short swipe opens it on its Delete, and then the Delete is tapped.
      await swipeRow(page, A, 'open');
      await tapDelete(A);
      await expect(page.locator(A)).toHaveClass(/\bdeleted\b/);
      await expect(page.locator('#said')).toHaveText(`Deleted ${a.title}. Restore is where the row was.`);
      await later(3000);
      await expect(page.locator(`${A}, ${B}`)).toHaveCount(0);
      await synced(page);
      if ((await get(a.id)) || (await get(b.id))) throw new Error('the tasks were not deleted');
      if (moves.sent.length) throw new Error('a position was written: ' + moves.sent.join(', '));
    } finally {
      moves.off();
      for (const t of [a, b]) await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });
  /* Holding a task on Today lifts its row in place and shows four date chips around the touch: Today at the left,
     Tomorrow at the right, Next week above and No date below. `holdOnToday(sel)` presses `sel` (`fx` of the way along
     it) until the hold registers and the chips are drawn. It returns where the touch is, still down. `datesSeen()`
     returns what is drawn once the chips have finished animating in. `movedGap(text, t)` finds the gap a moved task
     leaves where its row was, with its Undo. */
  const DATES = '.throw .throw-t[data-id]',
    dateChip = id => page.locator(`.throw .throw-t[data-id="${id}"]`);
  const dayAt = (days, h, m = 0) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  };
  const mondayAt = (h, m) => dayAt((8 - new Date().getDay()) % 7 || 7, h, m); // next Monday, or a week later if today is Monday
  const sameTime = (a, b) => Date.parse(a) === Date.parse(b);
  const asPicked = iso => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }; // a day in the format a date picker uses
  const movedGap = (text, t) => page.locator('#view .moved-gap').filter({ hasText: text }).filter({ hasText: t.title });
  async function holdOnToday(sel, { fx = 0.5, scroll = true } = {}) {
    if (scroll) await page.locator(sel).evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    const box = await steady(page.locator(sel)),
      x = box.x + box.width * fx,
      y = box.y + Math.min(box.height / 2, 28);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await later(700);
    await expect(page.locator(DATES)).toHaveCount(4);
    return { x, y };
  }
  const datesSeen = () =>
    page.evaluate(async () => {
      const set = document.querySelector('.throw');
      await Promise.all(set.getAnimations({ subtree: true }).map(a => a.finished));
      const box = el => {
        const r = el.getBoundingClientRect();
        return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height };
      };
      return {
        veil: !!document.querySelector('.throw-veil, .throw-box'),
        shade: getComputedStyle(set).backgroundColor,
        hidden: set.getAttribute('aria-hidden'),
        top: document.querySelector('header.top').getBoundingClientRect().bottom,
        foot: document.getElementById('capture').getBoundingClientRect().top,
        width: innerWidth,
        chips: Object.fromEntries(
          [...set.querySelectorAll('.throw-t[data-id]')].map(c => [
            c.dataset.id,
            {
              ...box(c),
              dim: c.classList.contains('dim'),
              on: c.classList.contains('on'),
              dashed: getComputedStyle(c).borderTopStyle === 'dashed',
              text: c.innerText.replace(/\s+/g, ' ').trim(),
            },
          ]),
        ),
      };
    });
  // Holds a row, moves the touch by (dx, dy) from where it was held, and releases. `lit` is the chip expected to be highlighted.
  const flickOnToday = async (sel, dx, dy, lit) => {
    const at = await holdOnToday(sel);
    await page.mouse.move(at.x + dx, at.y + dy, { steps: 4 });
    if (lit) await expect(dateChip(lit)).toHaveClass(/\bon\b/);
    await page.mouse.up();
    await expect(page.locator('.throw')).toHaveCount(0);
  };
  await step('a-hold-on-today-moves-a-task-to-the-date-its-flicked-at-with-an-undo', async () => {
    const late = await make(`Pocket smoke hold late ${stamp}`, { due_date: dayAt(-1, 9) });
    // Due in the last minutes of today, so they are still due later today whenever the test runs, and Today is dimmed.
    const a = await make(`Pocket smoke hold A ${stamp}`, { due_date: todayAt(23, 57) }),
      b = await make(`Pocket smoke hold B ${stamp}`, { due_date: todayAt(23, 58) }),
      c = await make(`Pocket smoke hold C ${stamp}`, { due_date: todayAt(23, 59) });
    const A = rowOf(a.title),
      B = rowOf(b.title),
      C = rowOf(c.title),
      L = rowOf(late.title),
      due = async t => (await get(t.id)).due_date;
    try {
      await toastGone();
      await refreshToday();
      await expect(page.locator(C)).toBeVisible({ timeout: 15000 });
      await loaded(page);
      // While held, the row lifts in place, and nothing covers the screen or follows the touch. The four date chips are
      // around the touch, each in its place and at least 56px in both directions. Today is dimmed because the task is already due then.
      const at = await holdOnToday(A),
        rowAt = await page.locator(A).boundingBox();
      await expect(page.locator(A)).toHaveClass(/\bthrow-from\b/);
      const seen = await datesSeen(),
        { today, tomorrow, week, none } = seen.chips;
      if (seen.veil || seen.shade !== 'rgba(0, 0, 0, 0)')
        throw new Error('something covers the screen: ' + JSON.stringify([seen.veil, seen.shade]));
      if (await page.locator('.throw .pick, .throw .throw-date').first().isVisible())
        throw new Error('Pick a date… shows while the touch is still down');
      if (!(today.r <= week.l + 1 && week.r <= tomorrow.l + 1 && week.b <= today.t + 1 && today.b <= none.t + 1))
        throw new Error(
          'the chips are not Today left, Tomorrow right, Next week above, No date below: ' + JSON.stringify(seen.chips),
        );
      if (Object.values(seen.chips).some(k => k.w < 56 || k.h < 56))
        throw new Error('a date chip is under 56px: ' + JSON.stringify(seen.chips));
      if (!today.dim || tomorrow.dim || week.dim || none.dim || !none.dashed || today.dashed)
        throw new Error('the wrong chips are dimmed or dashed: ' + JSON.stringify(seen.chips));
      if (
        !/^Today \w{3} \d+$/.test(today.text) ||
        !/^Tomorrow \w{3} \d+$/.test(tomorrow.text) ||
        !/^Next week Mon \d+$/.test(week.text) ||
        none.text !== 'No date'
      )
        throw new Error('the date chips show ' + JSON.stringify(Object.values(seen.chips).map(k => k.text)));
      // Moving right past 24px highlights Tomorrow. Moving further leaves the row where it is. Moving back near the
      // start highlights no chip, and releasing there changes nothing.
      await page.mouse.move(at.x + 40, at.y + 4, { steps: 4 });
      await expect(dateChip('tomorrow')).toHaveClass(/\bon\b/);
      await page.mouse.move(at.x + 90, at.y - 6, { steps: 3 });
      if (JSON.stringify(await page.locator(A).boundingBox()) !== JSON.stringify(rowAt))
        throw new Error('the row followed the touch');
      await page.mouse.move(at.x + 20, at.y - 60, { steps: 4 });
      await expect(dateChip('week')).toHaveClass(/\bon\b/);
      await page.mouse.move(at.x + 4, at.y + 2, { steps: 4 });
      await expect(page.locator(DATES + '.on')).toHaveCount(0);
      await page.mouse.up();
      await expect(page.locator('.throw')).toHaveCount(0);
      await expect(page.locator(A)).not.toHaveClass(/\bthrow-from\b/);
      if (await page.isVisible('#sheet')) throw new Error('releasing the row opened the task');
      await synced(page);
      if (!sameTime(await due(a), a.due_date))
        throw new Error('releasing near the hold point moved the task to ' + (await due(a)));
      // Moving towards the dimmed Today chip highlights nothing, and releasing there changes nothing.
      await flickOnToday(A, -50, 0, null);
      await synced(page);
      if (!sameTime(await due(a), a.due_date)) throw new Error('the dimmed date moved the task to ' + (await due(a)));
      // Right moves the task to tomorrow at the same time. Its row shows there plainly, and the gap it leaves where it
      // was has an Undo, which moves it back.
      await flickOnToday(A, 50, 4, 'tomorrow');
      await expect(movedGap('Moved to Tomorrow', a)).toBeVisible();
      await expect(page.locator('#said')).toContainText('Moved to Tomorrow: ' + a.title);
      await expect(page.locator(A)).toBeVisible();
      await expect(page.locator(A)).not.toHaveClass(/\blined\b/);
      await synced(page);
      if (!sameTime(await due(a), dayAt(1, 23, 57))) throw new Error('after moving right: ' + (await due(a)));
      await movedGap('Moved to Tomorrow', a).getByRole('button', { name: 'Undo' }).click();
      await expect(movedGap('Moved to Tomorrow', a)).toHaveCount(0);
      await synced(page);
      if (!sameTime(await due(a), a.due_date)) throw new Error('Undo left the task due ' + (await due(a)));
      await expect(page.locator(`.sec.today ~ .list ${A}`)).toBeVisible();
      // Up moves the task to next Monday at the same time.
      await flickOnToday(B, 6, -50, 'week');
      await expect(movedGap(/^\s*Moved to Mon \d+/, b)).toBeVisible();
      await synced(page);
      if (!sameTime(await due(b), mondayAt(23, 58))) throw new Error('after moving up: ' + (await due(b)));
      // Down, with the same short move, removes the due date. Its gap's Undo restores the date and time.
      await flickOnToday(C, -4, 50, 'none');
      await expect(movedGap('Moved to No date', c)).toBeVisible();
      await synced(page);
      if (!(await due(c)).startsWith('0001')) throw new Error('after moving down: ' + (await due(c)));
      await movedGap('Moved to No date', c).getByRole('button', { name: 'Undo' }).click();
      await synced(page);
      if (!sameTime(await due(c), c.due_date)) throw new Error('Undo of No date left the task due ' + (await due(c)));
      // Left, on an overdue task, moves it to today at 9:00. If 9:00 has already passed today, it is due today with no time.
      await flickOnToday(L, -50, 2, 'today');
      await expect(movedGap('Moved to Today', late)).toBeVisible();
      await synced(page);
      const moved = new Date(await due(late)),
        want = new Date(dayAt(0, 9));
      if (want < new Date()) want.setHours(0, 0, 0, 0);
      if (moved.getTime() !== want.getTime()) throw new Error('after moving left: ' + moved.toISOString());
      // A flick is released before 24px with no chip highlighted, but while moving fast. It counts by its direction.
      const from = await holdOnToday(C);
      await page.mouse.move(from.x + 18, from.y);
      if (await page.locator(DATES + '.on').count()) throw new Error('a date chip was highlighted under 24px');
      await page.mouse.up();
      await expect(movedGap('Moved to Tomorrow', c)).toBeVisible();
      await synced(page);
      if (!sameTime(await due(c), dayAt(1, 23, 59))) throw new Error('after a flick: ' + (await due(c)));
      // With a real touch, the page must not scroll once the row is held. Drag down to No date.
      await page.locator(A).evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      const box = await steady(page.locator(A)),
        fx = box.x + box.width / 2,
        fy = box.y + box.height / 2,
        scrolled = await page.evaluate(() => scrollY);
      await touch('touchStart', fx, fy);
      await later(700);
      await expect(page.locator(DATES)).toHaveCount(4);
      for (let i = 1; i <= 5; i++) await touch('touchMove', fx, fy + i * 10);
      await expect(dateChip('none')).toHaveClass(/\bon\b/);
      if ((await page.evaluate(() => scrollY)) !== scrolled)
        throw new Error('the page scrolled while the user was touching the row');
      await touch('touchEnd', fx, fy + 50);
      await expect(movedGap('Moved to No date', a)).toBeVisible();
      await synced(page);
      if (!(await due(a)).startsWith('0001')) throw new Error('after a touch drag down: ' + (await due(a)));
      await noToast(page);
      // The gaps leave with the batch, 3 seconds after the last move.
      await later(5000);
      await expect(page.locator('#view .moved-gap')).toHaveCount(0);
    } finally {
      await page.mouse.up();
      for (const t of [late, a, b, c]) await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });
  await step('a-hold-on-today-without-a-move-leaves-its-dates-open-to-tap', async () => {
    const late = await make(`Pocket smoke tap late ${stamp}`, { due_date: dayAt(-1, 9) });
    // Due in the last minutes of today, so Today is dimmed whenever the test runs.
    const a = await make(`Pocket smoke tap A ${stamp}`, { due_date: todayAt(23, 57) }),
      b = await make(`Pocket smoke tap B ${stamp}`, { due_date: todayAt(23, 58) }),
      c = await make(`Pocket smoke tap C ${stamp}`, { due_date: todayAt(23, 59) });
    const A = rowOf(a.title),
      B = rowOf(b.title),
      C = rowOf(c.title),
      L = rowOf(late.title),
      due = async t => (await get(t.id)).due_date;
    const menu = t => page.getByRole('dialog', { name: `Move “${t.title}” to another day` });
    // Holding a row and releasing without moving leaves the date chips open.
    const openDates = async (sel, t) => {
      const at = await holdOnToday(sel);
      await page.mouse.up();
      await expect(menu(t)).toBeVisible();
      return at;
    };
    const tapAt = async locator => {
      const k = await locator.boundingBox();
      await page.mouse.click(k.x + k.width / 2, k.y + k.height / 2);
    };
    try {
      await toastGone();
      await refreshToday();
      await expect(page.locator(C)).toBeVisible({ timeout: 15000 });
      await loaded(page);
      // After releasing where the hold started, the four chips stay where they were and become a menu named after the
      // task. Each date is a button with an accessible name, and the first is focused. The row stays lifted, the screen
      // behind is dimmed very lightly, and the task is not opened.
      const finger = await holdOnToday(A),
        held = await datesSeen();
      await page.mouse.up();
      await expect(menu(a)).toBeVisible();
      if (await page.isVisible('#sheet')) throw new Error('releasing the row opened the task');
      const open = await datesSeen();
      // Pick a date… is now in the middle, where the touch was. This row is clear of the screen's edges.
      const mid = await menu(a).getByRole('button', { name: 'Pick a date…' }).boundingBox();
      if (!(mid.x <= finger.x && finger.x <= mid.x + mid.width && mid.y <= finger.y && finger.y <= mid.y + mid.height))
        throw new Error("Pick a date… isn't where the touch was: " + JSON.stringify([mid, finger]));
      for (const id of Object.keys(held.chips))
        if (Math.abs(held.chips[id].l - open.chips[id].l) > 0.5 || Math.abs(held.chips[id].t - open.chips[id].t) > 0.5)
          throw new Error(id + ' chip moved when the menu opened');
      if (open.hidden !== null) throw new Error('still hidden from a screen reader');
      const shade = +(open.shade.match(/[,/] ?([\d.]+)\)$/) || [])[1]; // the opacity, from 0 to 1, is the last number in the colour
      if (!(shade > 0.04 && shade < 0.12))
        throw new Error("the screen behind isn't dimmed very lightly: " + open.shade);
      await expect(menu(a).getByRole('button')).toHaveCount(5);
      for (const name of [
        /^Today, \w{3} \d+$/,
        /^Tomorrow, \w{3} \d+$/,
        /^Next week, Mon \d+$/,
        /^No date$/,
        /^Pick a date…$/,
      ])
        await expect(menu(a).getByRole('button', { name })).toBeVisible();
      await expect(menu(a).getByRole('button', { name: /^Today, / })).toBeFocused();
      await expect(menu(a).getByRole('button', { name: /^Today, / })).toHaveAttribute('aria-disabled', 'true');
      await expect(page.locator(A)).toHaveClass(/\bthrow-from\b/);
      // Tapping the dimmed date does nothing, and the menu stays open. Escape closes it and returns the focus to the row.
      await tapAt(dateChip('today'));
      await expect(menu(a)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('.throw')).toHaveCount(0);
      await expect(page.locator(`${A} > .body`)).toBeFocused();
      await expect(page.locator(A)).not.toHaveClass(/\bthrow-from\b/);
      // A tap anywhere else closes the menu too and does nothing more. Tapping another row's tick (at the screen's left,
      // clear of every chip) closes the menu without ticking that row.
      await openDates(A, a);
      const tick = await page.locator(L).boundingBox();
      await page.mouse.click(tick.x + 28, tick.y + tick.height / 2);
      await expect(page.locator('.throw')).toHaveCount(0);
      if ((await page.isVisible('#sheet')) || (await page.locator(`${L}.leaving`).count()))
        throw new Error('the tap that closed the dates did something to the row under it');
      await synced(page);
      if (!sameTime(await due(a), a.due_date))
        throw new Error('closing without a date moved the task to ' + (await due(a)));
      // Tapping a date moves the task as the matching direction does, with the same Undo. First Tomorrow,
      await openDates(A, a);
      await dateChip('tomorrow').click();
      await expect(page.locator('.throw')).toHaveCount(0);
      await expect(movedGap('Moved to Tomorrow', a)).toBeVisible();
      await synced(page);
      if (!sameTime(await due(a), dayAt(1, 23, 57))) throw new Error('after tapping Tomorrow: ' + (await due(a)));
      await movedGap('Moved to Tomorrow', a).getByRole('button', { name: 'Undo' }).click();
      await synced(page);
      if (!sameTime(await due(a), a.due_date)) throw new Error('Undo left the task due ' + (await due(a)));
      // then Next week,
      await openDates(B, b);
      await dateChip('week').click();
      await expect(movedGap(/^\s*Moved to Mon \d+/, b)).toBeVisible();
      await synced(page);
      if (!sameTime(await due(b), mondayAt(23, 58))) throw new Error('after tapping Next week: ' + (await due(b)));
      // then No date,
      await openDates(C, c);
      await dateChip('none').click();
      await expect(movedGap('Moved to No date', c)).toBeVisible();
      await synced(page);
      if (!(await due(c)).startsWith('0001')) throw new Error('after tapping No date: ' + (await due(c)));
      // and last Today, on an overdue task.
      await openDates(L, late);
      await dateChip('today').click();
      await expect(movedGap('Moved to Today', late)).toBeVisible();
      await synced(page);
      if (new Date(await due(late)).toDateString() !== new Date().toDateString())
        throw new Error('after tapping Today: ' + (await due(late)));
      // A moved row shows no message where it went. Its gap leaves with the batch.
      await expect(page.locator(B)).not.toHaveClass(/\blined\b/);
      await later(5000);
      await expect(page.locator('#view .moved-gap')).toHaveCount(0);
      // Pick a date… sits in the middle of the four chips wherever the set is, and is at least 56px in both directions.
      // (This row may be near the bottom of the screen, so the set may be moved up from the touch.) Tapping it opens the
      // phone's own date picker straight from the tap. The test only records the call and restores it afterwards,
      // because a headless browser shows no picker. The day picked there moves the task as a date chip does, at the same
      // time, with a message naming the day in the phone's format, and the same Undo.
      await page.evaluate(() => {
        window.pickedFrom = [];
        window.pickerWas = HTMLInputElement.prototype.showPicker;
        HTMLInputElement.prototype.showPicker = function () {
          window.pickedFrom.push(this.className + (navigator.userActivation?.isActive ? '' : ', but not from a tap'));
        };
      });
      await openDates(B, b);
      const pick = menu(b).getByRole('button', { name: 'Pick a date…' }),
        box = await pick.boundingBox(),
        four = (await datesSeen()).chips;
      if (
        box.width < 56 ||
        box.height < 56 ||
        !(
          four.today.r <= box.x + 1 &&
          box.x + box.width <= four.tomorrow.l + 1 &&
          four.week.b <= box.y + 1 &&
          box.y + box.height <= four.none.t + 1
        )
      )
        throw new Error(
          "Pick a date… isn't in the middle of the four chips and 56px each way: " + JSON.stringify([box, four]),
        );
      await pick.click();
      await expect.poll(() => page.evaluate(() => window.pickedFrom)).toEqual(['throw-date']);
      await expect(menu(b)).toBeVisible();
      if ((await page.locator('.throw-date').getAttribute('min')) !== asPicked(new Date()))
        throw new Error("the picker's first day isn't today");
      await page.locator('.throw-date').fill(asPicked(dayAt(9, 23, 58)));
      await expect(page.locator('.throw')).toHaveCount(0);
      const picked =
        'Moved to ' +
        (await page.evaluate(
          iso => {
            const d = new Date(iso);
            return d.toLocaleDateString([], {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
            });
          },
          dayAt(9, 23, 58),
        ));
      await expect(movedGap(picked, b)).toBeVisible();
      await synced(page);
      if (!sameTime(await due(b), dayAt(9, 23, 58))) throw new Error('after picking a day: ' + (await due(b)));
      await movedGap(picked, b).getByRole('button', { name: 'Undo' }).click();
      await synced(page);
      if (!sameTime(await due(b), mondayAt(23, 58)))
        throw new Error('Undo of a picked day left the task due ' + (await due(b)));
      // With the keyboard, an arrow key moves to the date in that direction, and Enter picks it.
      await openDates(A, a);
      await page.keyboard.press('ArrowDown');
      await expect(menu(a).getByRole('button', { name: 'No date' })).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await expect(menu(a).getByRole('button', { name: /^Tomorrow, / })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.locator('.throw')).toHaveCount(0);
      await synced(page);
      if (!sameTime(await due(a), dayAt(1, 23, 57)))
        throw new Error('after choosing Tomorrow with the keys: ' + (await due(a)));
      await noToast(page);
    } finally {
      await page.mouse.up();
      await page.keyboard.press('Escape');
      await page.evaluate(() => {
        if (window.pickerWas) {
          HTMLInputElement.prototype.showPicker = window.pickerWas;
          delete window.pickerWas;
        }
      });
      for (const t of [late, a, b, c]) await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });
  /* Open date chips hold the batch, as a finger does. Removing a moved row's gap shortens the page, and at the bottom
     of a long Today the scroll that causes would close the chips. */
  /* A row's labels are buttons on a line of their own under its title. A swipe or a hold that starts on a label still
     moves the row, and a tap beside the labels opens the task. */
  await step('a-rows-labels-are-buttons-and-the-row-still-swipes-and-holds-from-them', async () => {
    const l = await (
        await api('/labels', { method: 'POST', headers: json, body: JSON.stringify({ title: `errands${stamp}` }) })
      ).json(),
      a = await make(`Pocket smoke labelled A ${stamp}`, { due_date: dayAt(1, 12) }),
      b = await make(`Pocket smoke labelled B ${stamp}`, { due_date: dayAt(20, 12) }),
      R = rowOf(a.title),
      LAB = `${R} > .labs > .lab`;
    try {
      for (const t of [a, b])
        await api(`/tasks/${t.id}/labels`, { method: 'POST', headers: json, body: JSON.stringify({ label_id: l.id }) });
      await toastGone();
      await refreshToday();
      await expect(page.locator(LAB)).toHaveText([l.title], { timeout: 15000 });
      await loaded(page);
      const h = await page.locator(R).evaluate(el => el.offsetHeight);
      if (h < 74 || h > 77) throw new Error('a row with labels is ' + h + 'px tall, not 76');
      // A tap on the label line, beside the label, opens the task
      await page.locator(R).evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      const k = await steady(page.locator(LAB));
      await page.mouse.click(k.x + k.width + 60, k.y + k.height / 2);
      await expect(page.locator('#sheet')).toBeVisible();
      await page.click('#btn-sheet-close');
      await page.waitForSelector('#sheet', { state: 'hidden' });
      await swipeRow(page, R, 50, { from: '> .labs > .lab' });
      await synced(page);
      if (Math.round((await get(a.id)).percent_done * 100) !== 50)
        throw new Error('a swipe from the label saved ' + (await get(a.id)).percent_done);
      await holdOnToday(LAB);
      await page.mouse.up();
      await expect(page.getByRole('dialog', { name: `Move “${a.title}” to another day` })).toBeVisible();
      await page.keyboard.press('Escape');
      // Tapping the label narrows Today to it. The bar says so, the one group left counts only its task, and Move all
      // to today is hidden. Show all, or leaving Today, shows every task again.
      const narrow = async () => {
        await page.locator(LAB).click();
        await expect(page.locator('.only-bar')).toHaveText(new RegExp(`^Only\\s*\\*${l.title}\\s*Show all$`));
      };
      await narrow();
      await expect(page.locator('#view .list > .row, #view .item > .row')).toHaveCount(1);
      await expect(page.locator('#view .sec .n')).toHaveText(['1']);
      await expect(page.locator('#btn-overdue-today')).toHaveCount(0);
      await page.click('#btn-show-all');
      await expect(page.locator('.only-bar')).toHaveCount(0);
      await expect(page.locator('#view .sec').first()).toBeVisible();
      if ((await page.locator('#view .list > .row, #view .item > .row').count()) < 2)
        throw new Error('Show all left one row');
      await narrow();
      await page.click('nav.tabs a[data-tab=projects]');
      await page.click('nav.tabs a[data-tab=today]');
      await expect(page.locator(R)).toBeVisible();
      await expect(page.locator('.only-bar')).toHaveCount(0);
      // With nothing this week left with the label, Today says so and offers a search for it
      await narrow();
      await api(`/tasks/${a.id}/labels/${l.id}`, { method: 'DELETE' });
      await page.click('#btn-refresh');
      await expect(page.locator('#view .empty > b')).toHaveText(`Nothing due this week has *${l.title}.`);
      await expect(page.locator('#view .empty > span')).toHaveText('Search finds the tasks due later or with no date.');
      // The search lists the open tasks with the label, under their project's name, which the rows leave out
      await page.getByRole('button', { name: `Search *${l.title}` }).click();
      await expect(page.locator('#in-search')).toHaveValue('*' + l.title);
      const home = await (await api('/projects/' + b.project_id)).json(),
        found = async () => {
          await expect(page.locator('#view .sec > .n')).toHaveText(['1'], { timeout: 15000 });
          await expect(page.locator('#view .sec > span').first()).toHaveText(home.title);
          await expect(page.locator('#view .sec > .sec-dot')).toHaveCount(1);
          await expect(page.locator(`#view ${rowOf(b.title)}`)).toBeVisible();
          await expect(page.locator(`#view ${rowOf(b.title)} .meta .dot`)).toHaveCount(0);
        };
      await found();
      // Typing * offers the labels that match what follows. Tapping one searches for it.
      await page.fill('#in-search', '*' + l.title.slice(0, 8));
      await page.locator('.search-chips .chip', { hasText: '*' + l.title }).click();
      await expect(page.locator('#in-search')).toHaveValue('*' + l.title);
      await found();
      await page.fill('#in-search', `*nolabel${stamp}`);
      await expect(page.locator('#view .empty > b')).toHaveText(`No label is called “nolabel${stamp}”.`);
      await page.click('#btn-search-cancel');
      await expect(page.locator('.only-bar')).toHaveCount(0);
    } finally {
      for (const t of [a, b]) await api('/tasks/' + t.id, { method: 'DELETE' });
      await api('/labels/' + l.id, { method: 'DELETE' });
    }
  });
  await step('a-hold-on-today-keeps-the-batch-waiting-while-its-dates-are-open', async () => {
    const ts = [];
    for (let i = 0; i < 14; i++)
      ts.push(
        await make(`Pocket smoke wait ${String(i).padStart(2, '0')} ${stamp}`, { due_date: dayAt(6, 23, 40 + i) }),
      );
    const menu = t => page.getByRole('dialog', { name: `Move “${t.title}” to another day` });
    try {
      await toastGone();
      await refreshToday();
      await expect(page.locator(rowOf(ts.at(-1).title))).toBeVisible({ timeout: 15000 });
      await loaded(page);
      await flickOnToday(rowOf(ts[0].title), 50, 4, 'tomorrow');
      await expect(movedGap('Moved to Tomorrow', ts[0])).toBeVisible();
      await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
      if (!(await page.evaluate(() => scrollY > 0))) throw new Error('Today is too short to scroll');
      // The row nearest the middle of the screen, so neither the header nor the add box is under the touch.
      const mid = await page.evaluate(
        titles =>
          titles
            .map(t => [...document.querySelectorAll('#view .row')].find(r => r.innerText.includes(t)))
            .map((r, i) => [i, Math.abs(r.getBoundingClientRect().top - innerHeight / 2)])
            .sort((x, y) => x[1] - y[1])[0][0],
        ts.map(t => t.title),
      );
      await holdOnToday(rowOf(ts[mid].title), { scroll: false });
      await page.mouse.up();
      await expect(menu(ts[mid]), 'the chips open').toBeVisible();
      await later(5000);
      await expect(menu(ts[mid]), 'the chips are still open after 5 seconds').toBeVisible();
      await expect(movedGap('Moved to Tomorrow', ts[0])).toBeVisible();
      // Closing the chips lets the batch clear 3 seconds later.
      await page.keyboard.press('Escape');
      await expect(page.locator('.throw')).toHaveCount(0);
      await later(4000);
      await expect(movedGap('Moved to Tomorrow', ts[0])).toHaveCount(0);
      await synced(page);
    } finally {
      await page.mouse.up();
      await page.keyboard.press('Escape');
      for (const t of ts) await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });
  await step('a-hold-on-today-leaves-a-repeating-task-where-it-is-and-says-why', async () => {
    const r = await make(`Pocket smoke hold repeats ${stamp}`, { due_date: todayAt(21), repeat_after: 86400 }),
      R = rowOf(r.title);
    try {
      await toastGone();
      await refreshToday();
      await expect(page.locator(R)).toBeVisible({ timeout: 15000 });
      await loaded(page);
      // The previous test ends with a move whose gap may still be on the screen. It leaves with the batch, so the
      // check below sees only what this hold shows, which is nothing.
      await later(5000);
      await expect(page.locator('#view .moved-gap, .row-line, .place-line[data-place="cap"]')).toHaveCount(0);
      const at = await holdOnToday(R),
        seen = await datesSeen();
      if (!Object.values(seen.chips).every(k => k.dim))
        throw new Error("a repeating task's dates aren't all dimmed: " + JSON.stringify(seen.chips));
      await expect(page.locator('.throw .throw-why')).toHaveText(
        'This task repeats. Tick it to move it to its next date.',
      );
      const why = await page.locator('.throw .throw-why').boundingBox();
      if (why.x < 0 || why.x + why.width > seen.width || why.y < seen.top)
        throw new Error('the message giving the reason is off the screen: ' + JSON.stringify(why));
      await page.mouse.move(at.x + 50, at.y, { steps: 4 });
      if (await page.locator(DATES + '.on').count())
        throw new Error("a date chip was highlighted for a task that can't move");
      await page.mouse.up();
      await expect(page.locator('.throw')).toHaveCount(0);
      await synced(page);
      if (!sameTime((await get(r.id)).due_date, r.due_date)) throw new Error('a repeating task moved');
      if (await page.locator('#view .moved-gap, .row-line, .place-line[data-place="cap"]').count())
        throw new Error('a message was shown');
      // Releasing without a move leaves the date chips open, as for any task, so the user can read why. They are still
      // dimmed, Pick a date… too, and tapping one does nothing.
      await holdOnToday(R);
      await page.mouse.up();
      const menu = page.getByRole('dialog', { name: `Move “${r.title}” to another day` });
      await expect(menu).toBeVisible();
      await expect(menu).toHaveAttribute('aria-describedby', 'throw-why');
      await expect(page.locator('#throw-why')).toHaveText('This task repeats. Tick it to move it to its next date.');
      for (const b of await menu.getByRole('button').all()) await expect(b).toHaveAttribute('aria-disabled', 'true');
      const k = await dateChip('tomorrow').boundingBox();
      await page.mouse.click(k.x + k.width / 2, k.y + k.height / 2);
      await expect(menu).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('.throw')).toHaveCount(0);
      await synced(page);
      if (!sameTime((await get(r.id)).due_date, r.due_date)) throw new Error('a repeating task moved by a tap');
    } finally {
      await page.mouse.up();
      await page.keyboard.press('Escape');
      await api('/tasks/' + r.id, { method: 'DELETE' });
    }
  });
  await step('a-held-rows-dates-stay-on-the-screen-for-the-first-row-and-the-last', async () => {
    // Hold the first row on Today (the longest overdue) near its right end, and the last row (due latest within 7 days)
    // near its left end. The whole set of chips moves onto the screen, between the header and the add box, and each chip
    // keeps its place relative to the others. Directions still count from the touch, wherever the set went. On a short
    // screen the test makes the screen even shorter if Today has so few tasks that the last row isn't next to the add box.
    const first = await make(`Pocket smoke hold first ${stamp}`, { due_date: new Date(2001, 0, 1, 9).toISOString() }),
      last = await make(`Pocket smoke hold last ${stamp}`, { due_date: dayAt(7, 23) });
    // The touch near the first row's right end is on its claim slot. With someone else on the task, holding there is
    // the row's own hold, not the people menu that holding "+ me" opens.
    const seers = await (await api(`/projects/${home2}/users/search`)).json(),
      other = (seers?.items || seers || []).find(u => u.id !== me2.id);
    if (other)
      await api(`/tasks/${first.id}/assignees`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ user_id: other.id }),
      });
    // Done today's heading, under the last row once earlier tests have ticked tasks, would leave room below that row.
    // It is hidden here, so the last row sits by the add box.
    const noDone = await page.addStyleTag({ content: '#view .done-sec{display:none}' });
    try {
      await toastGone();
      await page.setViewportSize({ width: 390, height: 420 });
      await refreshToday();
      await expect(page.locator(rowOf(last.title))).toBeVisible({ timeout: 15000 });
      await loaded(page);
      for (const [t, top, fx] of [
        [first, true, 0.9],
        [last, false, 0.1],
      ]) {
        await page.evaluate(top => scrollTo(0, top ? 0 : document.documentElement.scrollHeight), top);
        if (!top) {
          const row = await page.locator(rowOf(t.title)).boundingBox(),
            foot = await page.locator('#capture').boundingBox(),
            gap = foot.y - (row.y + row.height);
          if (gap > 30) {
            await page.setViewportSize({ width: 390, height: Math.round(420 - gap + 30) });
            await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
          }
        }
        const at = await holdOnToday(rowOf(t.title), { fx, scroll: false }),
          seen = await datesSeen(),
          { today, tomorrow, week, none } = seen.chips,
          where = top ? 'the first row: ' : 'the last row: ';
        for (const [id, k] of Object.entries(seen.chips))
          if (k.l < 0 || k.r > seen.width || k.t < seen.top || k.b > seen.foot)
            throw new Error(
              `${where}${id} is off the screen, or under the header or the add box: ${JSON.stringify([k, seen.top, seen.foot])}`,
            );
        if (
          !(today.r <= week.l + 1 && week.r <= tomorrow.l + 1 && week.b <= today.t + 1 && today.b <= none.t + 1) ||
          Math.abs(week.l - none.l) > 1 ||
          Math.abs(today.t - tomorrow.t) > 1
        )
          throw new Error(
            where + "the date chips aren't placed correctly around each other: " + JSON.stringify(seen.chips),
          );
        const midX = (week.l + week.r) / 2,
          midY = (today.t + today.b) / 2;
        if (top ? !(midX < at.x - 20 && midY >= at.y - 1) : !(midX > at.x + 20 && midY < at.y - 4))
          throw new Error(
            `${where}the chips didn't move onto the screen: their middle is ${midX},${midY}, the touch is ${at.x},${at.y}`,
          );
        await page.mouse.move(at.x + 2, at.y + (top ? -40 : 40), { steps: 4 });
        await expect(dateChip(top ? 'week' : 'none')).toHaveClass(/\bon\b/);
        await page.mouse.move(at.x + 2, at.y + 2, { steps: 4 });
        await expect(page.locator(DATES + '.on')).toHaveCount(0);
        await page.mouse.up();
        await expect(page.locator('.throw')).toHaveCount(0);
      }
    } finally {
      await page.mouse.up();
      await noDone.evaluate(el => el.remove());
      await page.setViewportSize({ width: 390, height: 844 });
      for (const t of [first, last]) await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });
  /* Swiping progress on a task that no one is doing claims it for the user. Their picture appears, and the claim is
     sent once the swipe is released with a change. Nothing changes while the row is held. Releasing where the swipe
     started claims nothing. Sliding back to 0% later leaves the task assigned to the user. A task assigned to
     someone else stays theirs. */
  await step('sliding-progress-claims-a-task-no-one-is-doing', async () => {
    const me = await (await api('/user')).json(),
      mine = (me.name || me.username)
        .match(/[\p{L}\p{N}]+/gu)
        .slice(0, 2)
        .map(w => w[0].toUpperCase())
        .join('');
    const a = await make(`Pocket smoke slide claim ${stamp}`, { due_date: todayAt(21) }),
      A = rowOf(a.title);
    // A task assigned to someone else, in a project shared with them (ASSIGNEE), when there is one.
    const team = ASSIGNEE && projects2.find(p => p.title === ASSIGNEE_PROJECT);
    const found = team && (await api(`/projects/${team.id}/users/search?q=${encodeURIComponent(ASSIGNEE)}`));
    const other = found?.ok ? ((await found.json()).items || []).find(u => u.username === ASSIGNEE) : null;
    const b = other && (await make(`Pocket smoke slide theirs ${stamp}`, { due_date: todayAt(21) }, team.id)),
      B = b && rowOf(b.title);
    if (b)
      await api(`/tasks/${b.id}/assignees`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ user_id: other.id }),
      });
    const people = async id => ((await get(id)).assignees || []).map(u => u.id),
      pct = async id => Math.round((await get(id)).percent_done * 100);
    try {
      await toastGone();
      await refreshToday();
      await expect(page.locator(A)).toBeVisible({ timeout: 15000 });
      await page.locator(A).evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      // Swipe a little, short of 25%, then release. Nothing changes while the row is held, and no one is assigned afterwards.
      const box = await page.locator(A).boundingBox(),
        x = box.x + 60,
        y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 20, y, { steps: 4 });
      await expect(page.locator(`${A} .claim .me`)).toBeVisible();
      await page.mouse.up();
      await expect(page.locator(`${A} .claim .me`)).toBeVisible();
      await expect(page.locator(`${A} .claim .me`)).toBeVisible();
      await synced(page);
      if ((await people(a.id)).length) throw new Error('a swipe that changed nothing claimed the task');
      // Swipe to 25%. Nobody is assigned while the row is held. After release the task is assigned to the user in Vikunja, and its slot shows the user's initials.
      await slideProgress(A, 25, async () => {
        await expect(page.locator(`${A} .claim .me`)).toBeVisible();
      });
      await expect(page.locator(`${A} .claim.mine .av`)).toHaveText(mine);
      await synced(page);
      if (JSON.stringify(await people(a.id)) !== JSON.stringify([me.id]))
        throw new Error('after the swipe, assigned to ' + JSON.stringify(await people(a.id)));
      if ((await pct(a.id)) !== 25) throw new Error('the saved progress is ' + (await pct(a.id)));
      // Sliding back to 0% leaves the task assigned to the user. Unassigning takes a separate tap.
      await slideProgress(A, 0, null, 25);
      await expect(page.locator('#said')).toHaveText(`Progress of ${a.title} set to 0%`);
      await synced(page);
      if ((await pct(a.id)) !== 0) throw new Error('after sliding back, the saved progress is ' + (await pct(a.id)));
      if (JSON.stringify(await people(a.id)) !== JSON.stringify([me.id]))
        throw new Error('sliding back to 0% unassigned the task');
      await expect(page.locator(`${A} .claim.mine .av`)).toBeVisible();
      if (!b) {
        console.log("  (no ASSIGNEE and ASSIGNEE_PROJECT: someone else's claim not checked)");
        return;
      }
      // A task assigned to someone else: sliding sets its progress, and it stays assigned to them.
      await expect(page.locator(B)).toBeVisible({ timeout: 15000 });
      await page.locator(B).evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await slideProgress(B, 25);
      await expect(page.locator('#said')).toHaveText(`Progress of ${b.title} set to 25%`);
      await synced(page);
      if (JSON.stringify(await people(b.id)) !== JSON.stringify([other.id]))
        throw new Error("someone else's task was claimed: " + JSON.stringify(await people(b.id)));
      if (await page.$(`${B} .claim.mine`)) throw new Error("someone else's task shows as yours");
    } finally {
      for (const t of [a, b].filter(Boolean)) await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });
  /* Holding "+ me" opens a menu of the people who can see the task's project, and the date chips never appear. Lifting
     the finger leaves it open. A tap outside closes it with no change, and tapping a person assigns them. Someone
     else's picture keeps the row's own hold. A short tap on "+ me" still assigns you, and a swipe that starts on it
     still swipes the row. */
  await step('holding-plus-me-offers-the-people-who-can-see-the-project', async () => {
    const a = await make(`Pocket smoke people ${stamp}`, { due_date: todayAt(21) }),
      A = rowOf(a.title),
      menu = page.locator('.people-menu'),
      people = async () => ((await get(a.id)).assignees || []).map(u => u.username);
    const holdSlot = async () => {
      await page.locator(A).evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      const box = await steady(page.locator(`${A} > .claim`)),
        x = box.x + box.width / 2,
        y = box.y + Math.min(box.height / 2, 28);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await later(700);
    };
    try {
      await toastGone();
      await refreshToday();
      await expect(page.locator(`${A} > .claim .me`)).toBeVisible({ timeout: 15000 });
      await loaded(page);
      await holdSlot();
      await expect(menu).toBeVisible();
      await expect(page.locator('.throw')).toHaveCount(0);
      await page.mouse.up();
      await expect(menu).toBeVisible();
      const home = projects2.find(p => p.id === home2)?.title;
      await expect(menu.locator('.people-head')).toHaveText(`People who can see ${home}`);
      const items = menu.getByRole('menuitemcheckbox');
      await expect(items.first().locator('.people-name')).toHaveText(new RegExp(`^Me\\s*@${me2.username}$`));
      await expect(items.filter({ hasText: '@carol' })).toHaveAttribute('aria-checked', 'false');
      const box = await menu.boundingBox(),
        row = await page.locator(A).boundingBox();
      if (Math.abs(box.x + box.width - (row.x + row.width)) > 1 || Math.abs(box.y - (row.y + row.height + 6)) > 1)
        throw new Error('the menu is not under the row, right-aligned: ' + JSON.stringify([box, row]));
      await page.mouse.click(20, row.y - 40);
      await expect(menu).toHaveCount(0);
      await expect(page.locator(`${A} > .claim .me`)).toBeVisible();
      // Tapping carol assigns her, and her picture replaces "+ me". Holding her picture is the row's own hold.
      await holdSlot();
      await page.mouse.up();
      await items.filter({ hasText: '@carol' }).click();
      await expect(menu).toHaveCount(0);
      await expect(page.locator(`${A} > .claim .av`)).toHaveText('C');
      await synced(page);
      if (JSON.stringify(await people()) !== '["carol"]') throw new Error('assigned to ' + (await people()));
      await holdSlot();
      await expect(page.locator(DATES)).toHaveCount(4);
      await expect(menu).toHaveCount(0);
      await page.mouse.up();
      await page.keyboard.press('Escape');
      await expect(page.locator('.throw')).toHaveCount(0);
      await api(`/tasks/${a.id}/assignees/${(await get(a.id)).assignees[0].id}`, { method: 'DELETE' });
      await refreshToday();
      // A swipe from "+ me" opens the row on its Delete, and a tap on the row closes it. Then a tap on "+ me" assigns you.
      await expect(page.locator(`${A} > .claim .me`)).toBeVisible({ timeout: 15000 });
      await swipeRow(page, A, 'open', { from: '> .claim' });
      await page.waitForSelector(`${A}.swiped`);
      await expect(menu).toHaveCount(0);
      const open = await page.locator(A).boundingBox();
      await page.mouse.click(open.x + open.width / 2, open.y + open.height / 2);
      await expect(page.locator(`${A}.swiped`)).toHaveCount(0);
      await expect(page.locator('#sheet')).toBeHidden();
      await page.locator(`${A} > .claim`).click();
      await expect(page.locator(`${A} > .claim.mine .av`)).toBeVisible();
      await expect(menu).toHaveCount(0);
      await synced(page);
      if (JSON.stringify(await people()) !== JSON.stringify([me2.username]))
        throw new Error('after a tap, assigned to ' + (await people()));
    } finally {
      await api('/tasks/' + a.id, { method: 'DELETE' });
    }
  });
  /* The sheet's own row claims a task when swiped, as a list row does, because the same rule applies everywhere. So
     does tapping a quarter in the Progress line in Details. On a task that no one is doing, the task is assigned to the
     user after release, in the Assigned row and in Vikunja. A task assigned to someone else stays theirs. */
  await step('the-sheets-row-claims-a-task-no-one-is-doing', async () => {
    const me = await (await api('/user')).json(),
      chip = `#d-assignees .label-chip:has-text("${me.name || me.username}")`;
    const a = await make(`Pocket smoke bar claim ${stamp}`, { due_date: todayAt(21) }),
      c = await make(`Pocket smoke chip claim ${stamp}`, { due_date: todayAt(21) });
    const team = ASSIGNEE && projects2.find(p => p.title === ASSIGNEE_PROJECT);
    const found = team && (await api(`/projects/${team.id}/users/search?q=${encodeURIComponent(ASSIGNEE)}`));
    const other = found?.ok ? ((await found.json()).items || []).find(u => u.username === ASSIGNEE) : null;
    const b = other && (await make(`Pocket smoke bar theirs ${stamp}`, { due_date: todayAt(21) }, team.id));
    if (b)
      await api(`/tasks/${b.id}/assignees`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ user_id: other.id }),
      });
    const people = async id => ((await get(id)).assignees || []).map(u => u.id),
      pct = async id => Math.round((await get(id)).percent_done * 100);
    const open = async t => {
      await page.click(`#view ${rowOf(t.title)} > .body`, { timeout: 15000 });
      await expect(ownTitle()).toHaveText(t.title);
      await page.waitForFunction(() => getComputedStyle(document.getElementById('sheet')).transform === 'none', null, {
        timeout: 5000,
      });
    };
    const quarter = async n => {
      await page.locator('#d-progress').scrollIntoViewIfNeeded();
      await page
        .locator('#d-progress')
        .getByRole('button', { name: n + '% done' })
        .click();
      await synced(page);
    };
    const close = async () => {
      await page.click('#btn-sheet-close');
      await page.waitForSelector('#sheet', { state: 'hidden' });
    };
    try {
      await toastGone();
      await refreshToday();
      await open(a);
      await slideProgress('#sheet .row.own', 25, async () => {
        await expect(page.locator(chip), 'the user is in Assigned while the row is held').toHaveCount(0);
      });
      await synced(page);
      if (JSON.stringify(await people(a.id)) !== JSON.stringify([me.id]))
        throw new Error('after the swipe, assigned to ' + JSON.stringify(await people(a.id)));
      if ((await pct(a.id)) !== 25) throw new Error('the saved progress is ' + (await pct(a.id)));
      await expect(page.locator(chip), 'the user is not in Assigned once the change is sent').toBeVisible();
      await close();
      await open(c);
      await quarter(50);
      if (JSON.stringify(await people(c.id)) !== JSON.stringify([me.id]))
        throw new Error('after tapping a quarter, assigned to ' + JSON.stringify(await people(c.id)));
      if ((await pct(c.id)) !== 50) throw new Error('the saved progress is ' + (await pct(c.id)));
      await close();
      if (!b) {
        console.log("  (no ASSIGNEE and ASSIGNEE_PROJECT: someone else's claim not checked)");
        return;
      }
      await open(b);
      await quarter(25);
      if ((await pct(b.id)) !== 25) throw new Error("their task's saved progress is " + (await pct(b.id)));
      if (JSON.stringify(await people(b.id)) !== JSON.stringify([other.id]))
        throw new Error("someone else's task was claimed: " + JSON.stringify(await people(b.id)));
      if (await page.locator(chip).count()) throw new Error("someone else's task shows you in Assigned");
      await close();
    } finally {
      for (const t of [a, b, c].filter(Boolean)) await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });
  /* "+ me" appears only where someone else could take the task. In a project that no one else can see, there is no
     slot and no picture of the user. Someone who was assigned in a shared project and then moved to this one still
     shows. Sliding progress claims nothing. Pocket loads who can see each project in the background after signing in,
     and keeps it. Under Today's heading, a row due today with no time shows no time, because "Today" would add nothing
     there. The project's own list still says Today. */
  await step('a-project-only-you-can-see-has-no-me', async () => {
    const proj = await (
      await api('/projects', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ title: `PocketSmokeAlone${stamp}` }),
      })
    ).json();
    createdProjects.push(proj.id);
    const me = await (await api('/user')).json();
    const free = await make(`Pocket smoke alone free ${stamp}`, { due_date: todayAt(21) }, proj.id),
      mine = await make(`Pocket smoke alone mine ${stamp}`, { due_date: todayAt(21) }, proj.id);
    const day = await make(`Pocket smoke alone day ${stamp}`, { due_date: todayAt(0) }, proj.id);
    await api(`/tasks/${mine.id}/assignees`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ user_id: me.id }),
    });
    // A task assigned to someone else in a project shared with them, then moved here. Vikunja keeps them assigned.
    // (Unsharing a project removes its people from its tasks instead.)
    let theirs = null,
      other = null;
    const team = ASSIGNEE && projects2.find(p => p.title === ASSIGNEE_PROJECT);
    if (team) {
      other = ((await (await api(`/projects/${team.id}/users/search`)).json()).items || []).find(
        u => u.username === ASSIGNEE,
      );
      theirs = await make(`Pocket smoke alone theirs ${stamp}`, { due_date: todayAt(21) }, team.id);
      await api(`/tasks/${theirs.id}/assignees`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ user_id: other.id }),
      });
      await api(`/tasks/${theirs.id}`, {
        method: 'PATCH',
        headers: json,
        body: JSON.stringify({ project_id: proj.id }),
      });
    }
    const people = async id => ((await get(id)).assignees || []).map(u => u.id),
      pct = async id => Math.round((await get(id)).percent_done * 100);
    const F = rowOf(free.title),
      M = rowOf(mine.title),
      D = rowOf(day.title);
    await toastGone();
    await page.evaluate(() => {
      location.hash = '#/today';
    });
    await page.reload(); // reload so Pocket signs in again and loads who can see each project
    await expect(page.locator(F)).toBeVisible({ timeout: 15000 });
    await expect(page.locator(`${F} .claim`), 'a project only you can see has "+ me"').toHaveCount(0, {
      timeout: 20000,
    });
    await expect(page.locator(`${M} .claim`), 'your own picture shows on a project only you can see').toHaveCount(0);
    if (theirs)
      await expect(
        page.locator(`${rowOf(theirs.title)} .claim[aria-disabled=true] .av`),
        "the other assignee's picture isn't shown",
      ).toBeVisible();
    // Under Today the row shows no time, and only the project's dot at its right. The project's list says Today.
    await expect(page.locator(`.sec.today ~ .list ${D} .when .dot`)).toHaveCount(1);
    await expect(page.locator(`${D} .when .due`)).toHaveCount(0);
    // Sliding sets the progress, and no one is assigned.
    await page.locator(F).evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await slideProgress(F, 25, async () => {
      if (await page.$(`${F} .claim`)) throw new Error('a swipe assigned someone to the task');
    });
    await expect(page.locator('#said')).toHaveText(`Progress of ${free.title} set to 25%`);
    await synced(page);
    if ((await pct(free.id)) !== 25) throw new Error('the saved progress is ' + (await pct(free.id)));
    if ((await people(free.id)).length)
      throw new Error('a swipe claimed the task: ' + JSON.stringify(await people(free.id)));
    if (theirs && JSON.stringify(await people(theirs.id)) !== JSON.stringify([other.id]))
      throw new Error('moving the task removed its assignee');
    await page.evaluate(id => {
      location.hash = '#/project/' + id;
    }, proj.id);
    await expect(page.locator(`#view ${D} .meta .due`)).toHaveText('Today', { timeout: 15000 });
    await page.evaluate(() => {
      location.hash = '#/today';
    });
  });
  /* The one-time hint appears on a phone that has never swiped a row. It sits on the first row that takes a swipe for
     its progress and is drawn with that row, so no row moves when it appears. It also leaves without moving any row,
     because it fades and keeps its space. Tapping it dismisses it, and so does the first swipe that sets progress. It
     stays dismissed after a reload. */
  await step('a-hint-to-swipe-right-once', async () => {
    const proj = await (
      await api('/projects', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ title: `PocketSmokeHint${stamp}` }),
      })
    ).json();
    createdProjects.push(proj.id);
    for (const n of [1, 2, 3]) await make(`Pocket smoke hint ${n} ${stamp}`, {}, proj.id);
    const fresh = await browser.newContext({ viewport: { width: 390, height: 844 } }),
      p = await fresh.newPage();
    p.on('pageerror', e => errors.push(String(e)));
    const first = '#view .list > .item:first-of-type > .row',
      hint = p.locator(`${first} .slide-hint`),
      shown = p.locator('.slide-hint:not(.gone)');
    // The top position of each row in the list.
    const rows = () =>
      p.$$eval('#view .list > .item > .row', els => els.map(el => Math.round(el.getBoundingClientRect().top)));
    // Once the hint's space has closed, all three rows have the same height. The first row is back to its normal
    // height, apart from the line above the others.
    const sameHeights = () =>
      p.$$eval('#view .list > .item > .row', els =>
        els.every(el => Math.abs(el.offsetHeight - els[1].offsetHeight) <= 1),
      );
    const open = async () => {
      await p.evaluate(id => {
        location.hash = '#/project/' + id;
      }, proj.id);
      await expect(p.locator('#view .list > .item > .row')).toHaveCount(3, { timeout: 15000 });
      await loaded(p);
    };
    try {
      await signIn(p, APP, USER, PASSWORD);
      await open();
      await expect(hint).toHaveText('Swipe right to start working on it');
      if ((await p.locator('.slide-hint').count()) !== 1) throw new Error('more than one hint');
      if ((await p.evaluate(() => localStorage.getItem('pocket.hint.slide'))) !== 'said')
        throw new Error('the hint was not announced to a screen reader');
      const at = await rows();
      // Tapping the hint dismisses it. It fades, keeps its space, and the task does not open.
      await hint.click();
      await expect(hint).toHaveClass(/\bgone\b/);
      if (await p.isVisible('#sheet')) throw new Error('a tap on the hint opened the task');
      if (JSON.stringify(await rows()) !== JSON.stringify(at))
        throw new Error(`rows moved when the hint went: ${at} then ${await rows()}`);
      // The hint's space stays while the user is touching the screen (on the empty space below the rows). This is a real
      // wait, longer than the second after which the space closes, because this page does not use the fake clock.
      const below = await p.locator('#view .list > .item:last-of-type > .row').boundingBox(),
        bx = below.x + below.width / 2,
        by = below.y + below.height + 60;
      if (
        await p.evaluate(
          ([x, y]) => !!document.elementFromPoint(x, y)?.closest('button, a, input, textarea, .row'),
          [bx, by],
        )
      )
        throw new Error('no empty space below the rows to hold');
      await p.mouse.move(bx, by);
      await p.mouse.down();
      await p.waitForTimeout(1500);
      if (JSON.stringify(await rows()) !== JSON.stringify(at))
        throw new Error(`rows moved while the user was touching the screen:${at} then ${await rows()}`);
      // After the touch ends, the space closes a second later. The first row returns to its normal height and the rows below move up with it.
      await p.mouse.up();
      await expect(p.locator('.slide-hint')).toHaveCount(0, { timeout: 5000 });
      await expect.poll(sameHeights).toBe(true);
      if (!((await rows())[1] < at[1])) throw new Error("the rows below didn't close up");
      await p.reload();
      await open();
      if (await p.locator('.slide-hint').count()) throw new Error('the hint came back after a reload');
      // Reset to a phone that has never swiped a row. The first swipe that sets progress dismisses the hint.
      await p.evaluate(() => localStorage.removeItem('pocket.hint.slide'));
      await p.reload();
      await open();
      await expect(shown).toHaveCount(1);
      const was = await rows();
      await swipeRow(p, first, 25);
      await expect(shown).toHaveCount(0);
      if (JSON.stringify(await rows()) !== JSON.stringify(was))
        throw new Error(`rows moved when the hint went: ${was} then ${await rows()}`);
      await expect(p.locator('.slide-hint')).toHaveCount(0, { timeout: 5000 }); // the space closes a second later
      await expect.poll(sameHeights).toBe(true);
      await synced(p);
      await p.reload();
      await open();
      if (await p.locator('.slide-hint').count()) throw new Error('the hint came back after a reload');
    } finally {
      await fresh.close();
    }
  });
  /* A label-and-value row in a task's sheet responds to a tap anywhere on it. Due opens the date picker. Priority,
     Repeats and Project have a select laid over the whole row. Reminders opens its list. Labels and Assigned open their
     Add. The × that clears a date keeps its own tap target. */
  await step('the-sheets-rows-take-a-tap-anywhere', async () => {
    const t = await make(`Pocket smoke rows ${stamp}`, { due_date: todayAt(22) });
    try {
      await toastGone();
      await refreshToday();
      await page.click(`${rowOf(t.title)} > .body`, { timeout: 15000 });
      await page.waitForSelector('#d-due-card');
      // Due: the date and the × are on one line, at 375px too, with the date shrinking. (An iPhone's date input has its own fixed width.)
      for (const width of [390, 375]) {
        await page.setViewportSize({ width, height: 844 });
        const one = await page.evaluate(() => {
          const i = document.getElementById('d-due').getBoundingClientRect(),
            x = document.getElementById('d-due-clear').getBoundingClientRect();
          return (
            i.right <= x.left + 1 &&
            Math.abs((i.top + i.bottom) / 2 - (x.top + x.bottom) / 2) < 4 &&
            x.right <= innerWidth
          );
        });
        if (!one) throw new Error(`at ${width}px, Due's date and its × aren't on one line`);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      // Replace showPicker so the test only records the call, because a headless browser shows no picker.
      await page.evaluate(() => {
        window.picked = [];
        for (const C of [HTMLInputElement, HTMLSelectElement])
          C.prototype.showPicker = function () {
            window.picked.push(this.id);
          };
      });
      const picked = () => page.evaluate(() => window.picked.slice());
      const key = what => page.locator('#sheet .prop > .k', { hasText: new RegExp(`^${what}$`) });
      await key('Due').click();
      await expect.poll(picked).toEqual(['d-due']);
      await key('Reminders').click();
      await expect.poll(picked).toEqual(['d-due', 'd-remind-add']);
      // Priority, Repeats and Project: the select itself receives the tap, wherever on the row it lands.
      for (const [what, id] of [
        ['Priority', 'd-prio'],
        ['Repeats', 'd-repeat'],
        ['Project', 'd-proj'],
      ]) {
        await key(what).scrollIntoViewIfNeeded();
        const at = await key(what).boundingBox(),
          hit = await page.evaluate(
            ([x, y]) => document.elementFromPoint(x, y)?.id,
            [at.x + at.width / 2, at.y + at.height / 2],
          );
        if (hit !== id) throw new Error(`a tap on ${what} lands on ${hit || 'nothing'}, not on its select`);
      }
      await key('Labels').click();
      await expect(page.locator('#lp-q')).toBeFocused();
      await page.press('#lp-q', 'Escape');
      await key('Assigned').click();
      await expect(page.locator('#d-assign-in')).toBeFocused();
      await page.click('#d-assign-done');
      // The × clears the date and opens no picker.
      await page.click('#d-due-clear');
      await synced(page);
      const due = (await get(t.id)).due_date;
      if (due && !due.startsWith('0001')) throw new Error('the × left the date: ' + (await get(t.id)).due_date);
      if ((await picked()).length !== 2) throw new Error('the × opened a picker: ' + (await picked()).join());
      await page.click('#btn-sheet-close');
      await page.waitForSelector('#sheet', { state: 'hidden' });
    } finally {
      await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });
  /* Search works like Projects. A result can be swiped to Delete but cannot be reordered, because search results have
     no order of their own. A found task with open subtasks is a stacked card, collapsed. It shows the top subtask and a
     More button, which expands the card in place to show all the subtasks. Less collapses it again. The subtasks are
     on the card, not separate rows. */
  await step('search-swipes-to-delete-and-doesnt-move-a-row', async () => {
    const w = `srch${stamp}`,
      p = await make(`Pocket smoke ${w} parent`),
      k = await make(`Pocket smoke ${w} kid`),
      k2 = await make(`Pocket smoke ${w} kid two`),
      c = await make(`Pocket smoke ${w} other`);
    for (const x of [k, k2])
      await api(`/tasks/${p.id}/relations`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ other_task_id: x.id, relation_kind: 'subtask' }),
      });
    const P = `#view ${cardOf(p.title)}`,
      C = rowOf(c.title),
      moves = positionsSent();
    try {
      await toastGone();
      await page.click('#btn-search');
      await page.fill('#in-search', w);
      await expect(page.locator(P)).toBeVisible({ timeout: 10000 });
      const rows = page.locator(`${P} > .card-rows > .row`),
        more = page.locator(`${P} > .card-more`);
      await expect(rows).toHaveCount(1);
      await expect(page.locator(`#view .list > .item > .row:has(.title:has-text("${w} kid"))`)).toHaveCount(0);
      await expect(more).toHaveAccessibleName('More');
      await expect(more).toHaveAttribute('aria-expanded', 'false');
      await more.click();
      await expect(rows).toHaveCount(2);
      await expect(more).toHaveAccessibleName('Show less');
      await expect(more).toHaveAttribute('aria-expanded', 'true');
      if (await page.isVisible('#sheet')) throw new Error('More opened the task');
      await more.click();
      await expect(rows).toHaveCount(1);
      await expect(more).toHaveAccessibleName('More');
      // Hold a result, move it over the card and release. The results stay in the same order.
      const order = () => page.locator('#view .list > .item').evaluateAll(els => els.map(el => +el.dataset.id));
      const was = await order();
      await holdAndMove(C, P);
      if (JSON.stringify(await order()) !== JSON.stringify(was)) throw new Error('the results changed order in search');
      if (await page.isVisible('#sheet')) throw new Error('releasing the row opened the task');
      // Swiping to Delete dims the row and shows Restore. The task is deleted once the batch clears.
      await swipe(C);
      await tapDelete(C);
      await expect(page.locator(C)).toHaveClass(/\bdeleted\b/);
      await expect(page.locator(C).getByRole('button', { name: 'Restore ' + c.title })).toBeVisible();
      await expect(page.locator('#said')).toHaveText(`Deleted ${c.title}. Restore is where the row was.`);
      await later(3000);
      await expect(page.locator(C)).toHaveCount(0);
      await synced(page);
      if (await get(c.id)) throw new Error('the task was never deleted');
      if (moves.sent.length) throw new Error('a position was written: ' + moves.sent.join(', '));
    } finally {
      moves.off();
      await page.click('#btn-search-cancel').catch(() => {});
      for (const t of [k, k2, p, c]) await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });

  // A phone's keyboard covers the bottom of the page without making the page shorter. This fakes a keyboard of height `h` by changing visualViewport's height.
  const keyboard = h =>
    page.evaluate(h => {
      if (h) Object.defineProperty(visualViewport, 'height', { configurable: true, get: () => innerHeight - h });
      else delete visualViewport.height;
      visualViewport.dispatchEvent(new Event('resize'));
    }, h);
  const subsOf = async id => (await get(id))?.related_tasks?.subtask || [];
  await step('a-subtask-added-keeps-the-keyboard-and-a-toast-shows-above-it', async () => {
    // The subtask box keeps the focus after an add, so the keyboard stays open. An added subtask shows in the sheet
    // with no message. Any message shown meanwhile appears above the keyboard.
    const p = await make(`Pocket smoke toasts ${stamp}`, { due_date: todayAt(23) }),
      vh = page.viewportSize().height;
    const toastBottom = async () => {
      await page.waitForTimeout(300);
      return page.$eval('#toast', el => el.getBoundingClientRect().bottom);
    };
    try {
      await toastGone();
      await refreshToday();
      await page.click(`${rowOf(p.title)} > .body`, { timeout: 15000 });
      await page.focus('#d-subin');
      await keyboard(300);
      for (const n of [1, 2]) {
        await page.fill('#d-subin', `Pocket smoke toast sub ${n} ${stamp}`);
        await page.press('#d-subin', 'Enter');
        await page.waitForFunction(n => document.querySelectorAll('#d-subtasks .row:not(.pending)').length === n, n, {
          timeout: 15000,
        });
        if (await page.$('#toast.show'))
          throw new Error(`adding subtask ${n} showed:${await page.textContent('#toast-msg')}`);
        if ((await page.evaluate(() => document.activeElement?.id)) !== 'd-subin')
          throw new Error(`the box lost the focus after add ${n}`);
      }
      await page.evaluate(() => Alpine.$data(document.body).notify('Saved'));
      const bottom = await toastBottom();
      if (bottom > vh - 300) throw new Error(`the toast is under the keyboard: its bottom is at ${bottom} of ${vh}`);
      await keyboard(0);
      if ((await toastBottom()) < vh - 100) throw new Error('the toast stayed up after the keyboard closed');
    } finally {
      await keyboard(0);
      await page.fill('#d-subin', '').catch(() => {});
      if (await page.isVisible('#sheet')) {
        await page.click('#btn-sheet-close');
        await page.waitForSelector('#sheet', { state: 'hidden' });
      }
      for (const s of await subsOf(p.id)) await api('/tasks/' + s.id, { method: 'DELETE' });
      await api('/tasks/' + p.id, { method: 'DELETE' });
    }
  });

  await step('turning-the-phone-keeps-the-boxes-working', async () => {
    // Rotating from portrait to landscape and back while typing must keep the focus and the typed text in the box. Quick
    // add's marks must stay over the text they mark. The layer behind the box has the same size, the same scroll
    // position and the same text, plus a zero-width space at its end.
    const p = await make(`Pocket smoke turn ${stamp}`, { due_date: todayAt(23) });
    const check = async (id, when) => {
      const s = await page.$eval('#' + id, ta => {
        const m = ta.previousElementSibling,
          a = ta.getBoundingClientRect(),
          b = m.getBoundingClientRect();
        return {
          focus: document.activeElement === ta,
          value: ta.value,
          text: m.textContent.slice(0, -1),
          marks: m.querySelectorAll('mark').length,
          box: [a.x, a.y, a.width, a.height, ta.clientWidth, ta.scrollTop].map(Math.round),
          layer: [b.x, b.y, b.width, b.height, m.clientWidth, m.scrollTop].map(Math.round),
        };
      });
      if (!s.focus) throw new Error(`${id} lost the focus ${when}`);
      if (s.text !== s.value || s.marks < 2)
        throw new Error(`${id}'s marks don't match its text ${when}: ${s.marks} marks`);
      if (JSON.stringify(s.box) !== JSON.stringify(s.layer))
        throw new Error(`${id}'s marks moved off its text ${when}: box ${s.box}, marks ${s.layer}`);
      return s.value;
    };
    const turn = async id => {
      // Type enough text to scroll once the phone is rotated, with marks at the end
      await page.focus('#' + id);
      await page.fill('#' + id, 'Pocket smoke turn ' + 'some words to fill the box up '.repeat(14));
      await page.keyboard.type('tomorrow !2', { delay: 5 });
      for (const [width, height, name] of [
        [844, 390, 'in landscape'],
        [390, 844, 'back in portrait'],
      ]) {
        await page.setViewportSize({ width, height });
        await page.waitForTimeout(400);
        const was = await check(id, name);
        await page.keyboard.type(' *x', { delay: 5 });
        if ((await check(id, name + ', typing')) !== was + ' *x') throw new Error(`typing ${name} didn't reach ${id}`);
      }
      await page.fill('#' + id, '');
    };
    try {
      await toastGone();
      await refreshToday();
      await turn('in-capture');
      await page.click(`${rowOf(p.title)} > .body`, { timeout: 15000 });
      await turn('d-subin');
    } finally {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.fill('#d-subin', '').catch(() => {});
      await page.fill('#in-capture', '').catch(() => {});
      if (await page.isVisible('#sheet')) {
        await page.click('#btn-sheet-close');
        await page.waitForSelector('#sheet', { state: 'hidden' });
      }
      await api('/tasks/' + p.id, { method: 'DELETE' });
    }
  });

  await step('today-moves-a-task-to-overdue-as-its-time-passes', async () => {
    // With Today left open, Pocket regroups the list once a minute without asking Vikunja. A task whose time passes is
    // highlighted as it moves to Overdue. No message appears at the bottom, but a screen reader announces it.
    const t = `Pocket smoke due soon ${stamp}`,
      due = new Date(Date.now() + 6000);
    if (due.getDate() !== new Date().getDate() || (!due.getHours() && !due.getMinutes())) return; // skip at midnight, where the task would have a day but no time
    const made = await make(t, { due_date: due.toISOString() });
    try {
      await toastGone();
      await refreshToday();
      await page.waitForSelector(`.sec.today ~ .list ${rowOf(t)}`, { timeout: 15000 });
      // Move the page's clock past the due time instead of waiting for it. Vikunja stores the time in whole seconds, so
      // the task can be due up to a second before `due`.
      await page.clock.fastForward(
        Math.max(0, Math.floor(due / 1000) * 1000 - (await page.evaluate(() => Date.now())) + 1000),
      );
      await page.evaluate(() => Alpine.$data(document.body).tickToday()); // does what the once-a-minute timer does
      await expect(page.locator(`.sec.overdue ~ .list ${rowOf(t)}`)).toHaveClass(/came-due/, { timeout: 5000 });
      await expect(page.locator('#said')).toHaveText(`“${t}” is due now`);
      await noToast(page);
    } finally {
      await page.clock.setSystemTime(Date.now());
      await api('/tasks/' + made.id, { method: 'DELETE' });
    }
  });

  await step('reminders-in-the-sheet', async () => {
    const t = `Pocket smoke remind ${stamp}`,
      made = await make(t, { due_date: todayAt(23) });
    const rems = async () =>
      ((await get(made.id)).reminders || []).map(r => (r.relative_to ? `${r.relative_to}${r.relative_period}` : 'at'));
    try {
      await toastGone();
      await refreshToday();
      await page.click(`${rowOf(t)} > .body`, { timeout: 15000 });
      await page.selectOption('#d-remind-add', { label: 'At due' });
      await page.waitForSelector('#d-reminders .chip.rem:has-text("At due")');
      await page.selectOption('#d-remind-add', { label: '1 hour before due' });
      await synced(page);
      if (JSON.stringify((await rems()).sort()) !== JSON.stringify(['due_date-3600', 'due_date0']))
        throw new Error('reminders: ' + JSON.stringify(await rems()));
      // A preset is no longer offered once it has been added. A reminder at a set date and time can also be added.
      if (await page.$('#d-remind-add option:text-is("At due")')) throw new Error('At due offered twice');
      await page.selectOption('#d-remind-add', { label: 'At a set date and time…' });
      const at = new Date(Date.now() + 2 * 864e5),
        p = n => String(n).padStart(2, '0');
      await page.fill('#d-remind-at', `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}T09:30`);
      await synced(page);
      if (!(await rems()).includes('at')) throw new Error('no reminder at a set time: ' + JSON.stringify(await rems()));
      await page.waitForSelector('#d-reminders .chip.rem:has-text("9:30")'); // the chip shows the time, not only the day
      // The × on the chip removes the reminder.
      await page.click('#d-reminders .chip.rem:has-text("At due") .chip-x');
      await synced(page);
      if ((await rems()).includes('due_date0'))
        throw new Error('the reminder was not removed: ' + JSON.stringify(await rems()));
      // A reminder that was added or removed elsewhere (in the web app, say) after the sheet showed the reminders stays added or removed.
      const elsewhere = async fn => {
        const list = (await get(made.id)).reminders.map(r =>
          r.relative_to ? { relative_to: r.relative_to, relative_period: r.relative_period } : { reminder: r.reminder },
        );
        await api('/tasks/' + made.id, {
          method: 'PATCH',
          headers: json,
          body: JSON.stringify({ reminders: fn(list) }),
        });
      };
      const remindersAre = async (want, what) => {
        await synced(page);
        if (JSON.stringify((await rems()).sort()) !== JSON.stringify(want))
          throw new Error(what + ': ' + JSON.stringify(await rems()));
      };
      await elsewhere(list => [...list, { relative_to: 'due_date', relative_period: -86400 }]);
      await page.click('#d-reminders .chip.rem:has-text("1 hour before due") .chip-x');
      await remindersAre(['at', 'due_date-86400'], 'removing one reminder removed others too');
      await page.waitForSelector('#d-reminders .chip.rem:has-text("1 day before due")');
      await elsewhere(list => list.filter(r => r.relative_to));
      await page.selectOption('#d-remind-add', { label: '15 min before due' });
      await remindersAre(
        ['due_date-86400', 'due_date-900'],
        'adding a reminder brought back one that was removed elsewhere',
      );
      await page.click('#btn-sheet-close');
      await page.waitForSelector('#sheet', { state: 'hidden' });
    } finally {
      await api('/tasks/' + made.id, { method: 'DELETE' });
    }
  });

  await step('remind-chip-in-quick-add', async () => {
    // Runs only when reminders can reach the user: the server sends reminder emails and the user has them turned on.
    const info = await (await fetch(SERVER + '/api/v2/info')).json(),
      me = await (await api('/user')).json();
    if (!info.email_reminders_enabled) return;
    // An API token can't change the user's settings, so this step signs in for them.
    const session = (
      await (
        await fetch(SERVER + '/api/v2/login', {
          method: 'POST',
          headers: json,
          body: JSON.stringify({ username: USER, password: PASSWORD }),
        })
      ).json()
    ).token;
    const settings = async body => {
      const r = await fetch(SERVER + '/api/v2/user/settings/general', {
        method: 'PATCH',
        headers: { ...json, Authorization: 'Bearer ' + session },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`the settings weren't saved: HTTP ${r.status}`);
    };
    const setReminders = on => settings({ ...me.settings, email_reminders_enabled: on });
    const t = `Pocket smoke call the plumber ${stamp}`;
    try {
      await setReminders(false);
      await page.reload();
      await loaded(page);
      await page.fill('#in-capture', `${t} at 4pm`);
      await page.waitForSelector('#cap-chips .chip[data-kind=due]');
      if (await page.$('#cap-chips .chip[data-kind=remind]'))
        throw new Error('a 🔔 chip with your reminder emails off');
      await setReminders(true);
      await page.fill('#in-capture', '');
      await page.reload();
      await loaded(page);
      // A date without a time gets no 🔔 chip. A date with a time gets one, switched off until tapped.
      await page.fill('#in-capture', `${t} friday`);
      await page.waitForSelector('#cap-chips .chip[data-kind=due]');
      if (await page.$('#cap-chips .chip[data-kind=remind]')) throw new Error('a 🔔 chip for a day without a time');
      // A time that has already passed gets no 🔔 chip, because Vikunja would never send that reminder.
      await page.fill('#in-capture', `${t} yesterday at 4pm`);
      await page.waitForSelector('#cap-chips .chip[data-kind=due]');
      if (await page.$('#cap-chips .chip[data-kind=remind]')) throw new Error('a 🔔 chip for a time that has passed');
      await page.fill('#in-capture', `${t} at 4pm`);
      await page.waitForSelector('#cap-chips .chip[data-kind=remind][aria-pressed=false]:has-text("🔔 Remind me")');
      // The time already has its own chip, so the 🔔 chip does not repeat it.
      if ((await page.textContent('#cap-chips .chip[data-kind=remind]')).trim() !== '🔔 Remind me')
        throw new Error('the 🔔 chip shows ' + (await page.textContent('#cap-chips .chip[data-kind=remind]')));
      await page.click('#cap-chips .chip[data-kind=remind]');
      await page.waitForSelector('#cap-chips .chip[data-kind=remind][aria-pressed=true]');
      await page.press('#in-capture', 'Enter');
      await page.waitForSelector(`.row .title:has-text("${t}")`, { timeout: 20000 }); // due today at 4pm, so it shows on Today
      await synced(page);
      const made = ((await (await api('/tasks?q=' + encodeURIComponent(t))).json()).items || []).find(
        x => x.title === t,
      );
      try {
        if (
          JSON.stringify((made?.reminders || []).map(r => [r.relative_to, r.relative_period])) !==
          JSON.stringify([['due_date', 0]])
        )
          throw new Error('reminders: ' + JSON.stringify(made?.reminders));
      } finally {
        if (made) await api('/tasks/' + made.id, { method: 'DELETE' });
      }
    } finally {
      await settings(me.settings);
      await page.evaluate(() => document.activeElement?.blur());
    }
  });

  await step('search-moves-a-ticked-task-to-done', async () => {
    const t = `Pocket smoke tick A ${stamp}`;
    await page.click('#btn-search');
    await page.fill('#in-search', t);
    const open = `#view div:has(> .sec:has-text("Open")) ${rowOf(t)}`,
      done = `#view div:has(> .sec:has-text("Done")) ${rowOf(t)}`;
    await page.waitForSelector(open, { timeout: 10000 });
    // The task is marked done in place, as in a list. When the batch clears, it moves under Done.
    await page.click(`${open} > .check`);
    await expect(page.locator(`${open}.leaving`)).toHaveClass(/\bdone\b/);
    await noToast(page);
    await synced(page);
    await later(3000);
    await page.waitForSelector(done, { timeout: 10000 });
    await page.click(`${done} > .check`); // tap again to reopen it
    await expect(page.locator(`${done}.leaving`)).not.toHaveClass(/\bdone\b/);
    await expect(page.locator('#said')).toHaveText('Not done: ' + t);
    await later(3000);
    await page.waitForSelector(open, { timeout: 10000 });
    await page.click('#btn-search-cancel');
  });

  await step('sheet-keeps-what-was-written', async () => {
    const t = `Pocket smoke tick A ${stamp}`,
      task = ((await (await api('/tasks?q=' + encodeURIComponent(t))).json()).items || []).find(x => x.title === t);
    await refreshToday();
    await page.click(`${rowOf(t)} > .body`, { timeout: 15000 });
    await page.click('#d-desc');
    await page.fill('#d-desc-in', 'Notes saved on close');
    await page.fill('#d-cin', 'half a comment');
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    await synced(page);
    if (!(await get(task.id)).description?.includes('Notes saved on close')) throw new Error('notes not saved');
    await page.click(`${rowOf(t)} > .body`);
    await page.waitForSelector('#d-cin');
    if ((await page.inputValue('#d-cin')) !== 'half a comment')
      throw new Error('comment: ' + (await page.inputValue('#d-cin')));
    await page.fill('#d-cin', '');
    // Notes changed elsewhere while these were being written are not overwritten. Both versions are shown, and saving again replaces the other version.
    const notes = async () => (await get(task.id)).description || '';
    const elsewhere = text =>
      api('/tasks/' + task.id, {
        method: 'PATCH',
        headers: json,
        body: JSON.stringify({ description: `<p>${text}</p>` }),
      });
    await page.click('#d-desc');
    await page.fill('#d-desc-in', 'Mine, from Pocket');
    await elsewhere('Theirs, from the web');
    await page.click('#d-desc-save');
    await page.waitForSelector('#d-desc-conflict:has-text("Theirs, from the web")', { timeout: 15000 });
    if (!(await notes()).includes('Theirs')) throw new Error('the web version was overwritten: ' + (await notes()));
    await page.click('#d-desc-save');
    await synced(page);
    if (!(await notes()).includes('Mine, from Pocket'))
      throw new Error('the second save did not replace the other version: ' + (await notes()));
    // The same applies when the sheet closes. The user's notes are kept on the phone instead.
    await page.click('#d-desc');
    await page.fill('#d-desc-in', 'Mine again');
    await elsewhere('Theirs again');
    await page.click('#btn-sheet-close');
    // A message on the row, with an Open button, lets the user see both versions.
    const seeBoth = rowLine(page, 'Someone changed them').getByRole('button', { name: 'Open' });
    await expect(seeBoth).toBeVisible({ timeout: 15000 });
    await noToast(page);
    if (!(await notes()).includes('Theirs again'))
      throw new Error('the web version was overwritten on close: ' + (await notes()));
    await seeBoth.click();
    await page.waitForSelector('#d-desc-conflict:has-text("Theirs again")', { timeout: 15000 });
    if ((await page.inputValue('#d-desc-in')) !== 'Mine again')
      throw new Error('the kept draft is: ' + (await page.inputValue('#d-desc-in')));
    await page.click('#d-desc-cancel');
    await page.waitForSelector('#d-desc:has-text("Theirs again")');
  });

  await step('label-on-enter-and-people-suggested', async () => {
    await page.click('#d-add-label');
    await page.fill('#lp-q', label);
    await page.press('#lp-q', 'Enter');
    await page.waitForSelector(`.prop:has(.k:text("Labels")) .label-chip:has-text("${label}")`, { timeout: 10000 });
    await page.click('#d-add-label'); // closes the label picker
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    // People are suggested from those who can see the task's project. Here the task is in the project shared with ASSIGNEE.
    const team = projects2.find(p => p.title === ASSIGNEE_PROJECT);
    if (ASSIGNEE && team && (await api('/projects/1/users/search?q=x')).status !== 401) {
      const shared = await make(`Pocket smoke assign pick ${stamp}`, { due_date: todayAt(23) }, team.id);
      await refreshToday();
      await page.click(`${rowOf(shared.title)} > .body`, { timeout: 15000 });
      await page.click('#d-add-assignee');
      await page.fill('#d-assign-in', ASSIGNEE.slice(0, 2));
      await page.click(`#d-assign-list .chip:has-text("@${ASSIGNEE}")`, { timeout: 15000 });
      await page.waitForSelector(`#d-assignees .label-chip:has-text("${ASSIGNEE}")`, { timeout: 10000 });
      await page.click('#d-assign-done');
      await page.waitForSelector('#d-assign-in', { state: 'detached' });
      await page.click('#btn-sheet-close');
      await page.waitForSelector('#sheet', { state: 'hidden' });
    }
  });

  await step('enter-takes-the-suggestion', async () => {
    await page.fill('#in-capture', '');
    await page.type('#in-capture', `Pocket smoke enter ${stamp} *${label.slice(0, 9)}`);
    await page.waitForSelector(`#cap-chips .chip[data-kind=suggest]:has-text("*${label}")`, { timeout: 15000 });
    await page.press('#in-capture', 'Enter');
    if ((await page.inputValue('#in-capture')) !== `Pocket smoke enter ${stamp} *${label} `)
      throw new Error('text: ' + (await page.inputValue('#in-capture')));
    await page.fill('#in-capture', 'Call Ana at 5');
    await page.waitForSelector('#cap-chips .chip[data-kind=due]:has-text("5:00 PM")');
    await page.fill('#in-capture', 'Standup every weekday');
    await page.waitForSelector('#cap-chips .chip.warn:has-text("can\'t repeat")');
    await page.fill('#in-capture', '');
  });

  await step('back-closes-the-sheet-and-keeps-the-draft', async () => {
    const t = `Pocket smoke tick A ${stamp}`;
    await refreshToday();
    await page.click(`${rowOf(t)} > .body`, { timeout: 15000 });
    await page.fill('#d-cin', 'written before Back');
    await page.waitForSelector('#sheet.show'); // wait for the sheet to slide in, because Back closes only a sheet that is showing
    await page.goBack(); // the phone's Back
    await page.waitForSelector('#sheet', { state: 'hidden', timeout: 10000 });
    if (!(await page.evaluate(() => location.hash)).startsWith('#/today'))
      throw new Error('Back left Today: ' + (await page.evaluate(() => location.href)));
    await page.reload(); // the draft survives even after Pocket is closed
    await page.click(`${rowOf(t)} > .body`, { timeout: 15000 });
    if ((await page.inputValue('#d-cin')) !== 'written before Back')
      throw new Error('comment: ' + (await page.inputValue('#d-cin')));
    await page.fill('#d-cin', '');
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    // After a sheet is closed with ×, one Back goes to the previous screen, not to the same screen again.
    await page.click('nav.tabs a[data-tab=projects]');
    await page.waitForFunction(() => location.hash === '#/projects');
    await page.click('nav.tabs a[data-tab=today]');
    await page.click(`${rowOf(t)} > .body`, { timeout: 15000 });
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    await page.goBack();
    await page.waitForFunction(() => location.hash === '#/projects', null, { timeout: 10000 });
    await page.click('nav.tabs a[data-tab=today]');
  });

  await step('repeating-tick-shows-done-then-its-next-date', async () => {
    // A ticked repeating task shows as done, with its old date, until the batch clears. Tapping the tick before then
    // restores its dates, and also its reminder at a set time, which moved on with the due date.
    const r = await make(`Pocket smoke repeat undo ${stamp}`, {
      due_date: todayAt(9),
      repeat_after: 86400,
      reminders: [{ reminder: todayAt(8) }],
    });
    const R = page.locator(rowOf(r.title)),
      due = () => R.locator('.when .due').textContent();
    try {
      await toastGone();
      await refreshToday();
      const was = await due();
      await page.click(`${rowOf(r.title)} > .check`, { timeout: 15000 });
      await expect(R).toHaveClass(/\bleaving\b/);
      await expect(R).toHaveClass(/\bdone\b/);
      await expect(page.locator('#said')).toContainText(`Done: ${r.title}. It repeats, next `);
      if ((await due()) !== was) throw new Error(`the date changed to ${await due()} while the row shows done`);
      await page.click(`${rowOf(r.title)} > .check`);
      await expect(R).not.toHaveClass(/\bleaving\b/);
      await noToast(page);
      const want = new Date(r.due_date).getTime();
      await synced(page);
      if (new Date((await get(r.id)).due_date).getTime() !== want)
        throw new Error('the due date is ' + (await get(r.id)).due_date);
      const rem = (await get(r.id)).reminders?.[0]?.reminder;
      if (new Date(rem).getTime() !== new Date(todayAt(8)).getTime()) throw new Error('the reminder is at ' + rem);
      // When the batch is left to clear, the task is open again, with its next date.
      await page.click(`${rowOf(r.title)} > .check`);
      await expect(R).toHaveClass(/\bleaving\b/);
      await synced(page);
      await later(3000);
      await expect(R).not.toHaveClass(/\bleaving\b/);
      await expect(R).not.toHaveClass(/\bdone\b/);
      await synced(page);
      const next = new Date((await get(r.id)).due_date).getTime();
      if (next <= want) throw new Error('the task did not move to its next date: due ' + (await get(r.id)).due_date);
      if ((await due()) === was) throw new Error('the row still shows ' + was);
    } finally {
      await api('/tasks/' + r.id, { method: 'DELETE' });
    }
  });
  await step('a-repeating-subtask-keeps-its-date', async () => {
    // Completing a parent leaves a repeating subtask unchanged, because marking it done would only move it to its next
    // date. The parent's ring asks for confirmation first and says so.
    const parent = await make(`Pocket smoke parent of a repeat ${stamp}`),
      sub = await make(`Pocket smoke weekly subtask ${stamp}`, { due_date: todayAt(9), repeat_after: 604800 });
    try {
      await api(`/tasks/${parent.id}/relations`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ other_task_id: sub.id, relation_kind: 'subtask' }),
      });
      await toastGone();
      await page.evaluate(id => {
        location.hash = '#/project/' + id;
      }, home2);
      await loaded(page);
      await page.locator(`#view ${cardOf(parent.title)} > .card-head > .ring`).click({ timeout: 15000 });
      await expect(page.locator('#complete-note')).toHaveText('The one that repeats stays as it is.');
      await expect(page.locator('#complete-yes')).toHaveText('Complete it');
      await page.click('#complete-yes');
      await expect(page.locator(`#view ${cardOf(parent.title)}`)).toHaveClass(/\bdone\b/, { timeout: 20000 });
      await synced(page);
      if (!(await get(parent.id)).done) throw new Error("the parent isn't done");
      const s = await get(sub.id);
      if (s.done || new Date(s.due_date).getTime() !== new Date(sub.due_date).getTime())
        throw new Error(`subtask done ${s.done}, due ${s.due_date}`);
    } finally {
      for (const id of [sub.id, parent.id]) await api('/tasks/' + id, { method: 'DELETE' });
      await page.evaluate(() => {
        location.hash = '#/today';
      });
    }
  });
  await step('a-tick-whose-reply-is-lost-is-made-once', async () => {
    // The tick reaches Vikunja, which moves the task to its next date, but the reply is lost. The tick waits in the
    // Outbox, and the relay answers it from what it kept when it is sent again, so the task isn't ticked twice, which
    // would skip a date.
    const r = await make(`Pocket smoke repeat lost ${stamp}`, { due_date: todayAt(9), repeat_after: 86400 }),
      at = `**/v2/tasks/${r.id}`;
    let lost = 0;
    const lose = async x => {
      if (x.request().method() !== 'PATCH' || lost++) return x.fallback();
      await x.fetch();
      return x.abort('connectionreset');
    };
    try {
      await toastGone();
      await refreshToday();
      await page.route(at, lose);
      await page.click(`${rowOf(r.title)} > .check`, { timeout: 15000 });
      await expect(page.locator('#said')).toContainText(`Done: ${r.title}. It repeats, next `, { timeout: 20000 });
      await later(30000); // flush's timer sends what waits
      await synced(page);
      const due = new Date((await get(r.id)).due_date).getTime();
      if (due !== new Date(r.due_date).getTime() + 864e5)
        throw new Error('the due date is ' + (await get(r.id)).due_date);
    } finally {
      await page.unroute(at, lose);
      await api('/tasks/' + r.id, { method: 'DELETE' });
    }
  });

  // A refused change waits in the Outbox, marked failed, until Try again or Cancel there.
  const retryInOutbox = async text => {
    await page.click('#btn-refresh');
    await page.locator(`#outbox-rows .ob-row:has-text("${text}")`).getByRole('button', { name: 'Try again' }).click();
    await page.waitForSelector('#outbox-rows .ob-row', { state: 'detached' });
    await page.click('#btn-sheet-close');
  };
  const refusing = x => {
    if (x.request().method() !== 'PATCH') return x.fallback();
    refused.add(x.request().url());
    return x.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ message: 'Forbidden' }) });
  };
  await step('a-tick-vikunja-refuses-goes-back-and-waits-in-the-outbox', async () => {
    // The row is open again, and a message says why, with a button to the Outbox. Try again there ticks the task.
    const r = await make(`Pocket smoke not saved ${stamp}`, { due_date: todayAt(23) }),
      at = `**/v2/tasks/${r.id}`;
    try {
      await toastGone();
      await refreshToday();
      await page.route(at, refusing);
      await tick(r.title);
      await toast(page, `A tick on “${r.title}” couldn't be saved: Forbidden.`);
      await expect(page.locator(rowOf(r.title))).not.toHaveClass(/\bdone\b/);
      await page.unroute(at, refusing);
      await retryInOutbox('Done: ' + r.title);
      await synced(page);
      if (!(await get(r.id)).done) throw new Error('Try again did not mark the task done');
    } finally {
      await page.unroute(at, refusing);
      await api('/tasks/' + r.id, { method: 'DELETE' });
    }
  });
  /* After a full swipe, the row shows as done once it has slid away, not when Vikunja answers. While the reply is held
     back, the row is in place and ticked, and the green is gone. Tapping its tick then takes effect once the answer
     arrives. If Vikunja refuses it, the row is open again and the tick waits in the Outbox, as a tick's does. */
  await step('a-full-swipes-row-shows-done-as-it-goes-and-is-open-again-when-its-not-saved', async () => {
    const r = await make(`Pocket smoke gap ${stamp}`, { due_date: todayAt(23) }),
      R = rowOf(r.title),
      at = `**/v2/tasks/${r.id}`;
    let answer = () => {},
      sent = 0;
    const answered = new Promise(ok => {
      answer = ok;
    });
    const hold = async x => {
      if (x.request().method() !== 'PATCH') return x.fallback();
      sent++;
      await answered;
      await x.fallback();
    };
    try {
      await toastGone();
      await refreshToday();
      await page.route(at, hold);
      await swipeRow(page, R, 100);
      await expect(page.locator(R)).toHaveClass(/\bdone\b/);
      await expect(page.locator(`${R} > .del-gap`)).toHaveCount(0);
      await expect(uncovered(page)).toHaveCount(0);
      const undo = page.locator(R).getByRole('button', { name: 'Mark not done: ' + r.title, exact: true });
      await expect(undo).toBeVisible();
      if (!sent || (await get(r.id)).done) throw new Error('the row showed done only after Vikunja answered');
      await undo.click();
      await expect(page.locator(R)).toHaveClass(/\bdone\b/); // the tap has no effect yet, because the answer has not arrived
      answer();
      await expect(page.locator(R)).not.toHaveClass(/\bdone\b/);
      await synced(page);
      if ((await get(r.id)).done) throw new Error('a tick tapped before the answer was lost');
      await page.unroute(at, hold);
      // When Vikunja refuses it, the row shows as done while it slides away and is then open again, with a message.
      await toastGone();
      await page.route(at, refusing);
      await swipeRow(page, R, 100);
      await toast(page, `A tick on “${r.title}” couldn't be saved: Forbidden.`);
      await expect(page.locator(R)).not.toHaveClass(/\bdone\b/);
      await expect(page.locator(`${R} > .del-gap`)).toHaveCount(0);
      await expect(uncovered(page)).toHaveCount(0);
      await page.unroute(at, refusing);
      await retryInOutbox('Done: ' + r.title);
      await synced(page);
      if (!(await get(r.id)).done) throw new Error('Try again did not mark the task done');
    } finally {
      answer();
      await page.unroute(at, hold);
      await page.unroute(at, refusing);
      await api('/tasks/' + r.id, { method: 'DELETE' });
    }
  });
  /* When the phone asks for less motion, a swipe only changes things. The row still follows the touch. After release it
     snaps back, or becomes done in place, with no glide and no fade. (motion() in util.js is checked at release.) */
  await step('with-less-motion-a-row-let-go-is-only-there', async () => {
    const r = await make(`Pocket smoke still ${stamp}`, { due_date: todayAt(23) }),
      R = rowOf(r.title);
    try {
      await toastGone();
      await refreshToday();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await swipeRow(page, R, 25, { check: () => watchSlide(page, R, 400) });
      let seen = await slideSeen(page);
      if (seen.some(s => s.moving.length) || seen.slice(3).some(s => s.x || s.under !== null))
        throw new Error('after release, the row moved back: ' + JSON.stringify(seen.slice(0, 6)));
      await swipeRow(page, R, 100, { start: 25, check: () => watchSlide(page, R, 400) });
      await expect(page.locator(R)).toHaveClass(/\bdone\b/);
      seen = await slideSeen(page);
      if (seen.some(s => s.moving.length) || seen.slice(3).some(s => s.x || s.under !== null))
        throw new Error('after release past half, the row moved off: ' + JSON.stringify(seen.slice(0, 6)));
      if (await page.locator(R).evaluate(el => el.getAnimations({ subtree: true }).length))
        throw new Error('the row faded in as done');
      await synced(page);
      if (!(await get(r.id)).done) throw new Error('the task was never marked done');
    } finally {
      await page.emulateMedia({ reducedMotion: null });
      await api('/tasks/' + r.id, { method: 'DELETE' });
    }
  });
  await step('a-sheet-edit-vikunja-refuses-goes-back-and-waits-in-the-outbox', async () => {
    // A message at the top of the sheet says why, with a button to the Outbox. Try again there saves the change.
    const r = await make(`Pocket smoke sheet not saved ${stamp}`, { due_date: todayAt(23) }),
      at = `**/v2/tasks/${r.id}`;
    try {
      await refreshToday();
      await page.click(`${rowOf(r.title)} > .body`, { timeout: 15000 });
      await page.waitForSelector('#d-comments .comment-form', { timeout: 10000 });
      await page.route(at, refusing);
      await page.selectOption('#d-prio', '3');
      const line = placeLine(page, 'sheet:top');
      await expect(line).toContainText(`Priority on “${r.title}” couldn't be saved: Forbidden.`, { timeout: 20000 });
      await expect(line).toHaveClass(/failed/);
      await expect(page.locator('#d-prio')).toHaveValue('0');
      await noToast(page);
      await page.unroute(at, refusing);
      await line.getByRole('button', { name: 'Outbox' }).click();
      await page
        .locator('#outbox-rows .ob-row:has-text("Priority: High on")')
        .getByRole('button', { name: 'Try again' })
        .click();
      await page.waitForSelector('#outbox-rows .ob-row', { state: 'detached' });
      await page.click('#btn-sheet-close');
      await page.waitForSelector('#sheet', { state: 'hidden' });
      await synced(page);
      if ((await get(r.id)).priority !== 3) throw new Error('Try again did not save the change');
    } finally {
      await page.unroute(at, refusing);
      await api('/tasks/' + r.id, { method: 'DELETE' });
    }
  });
  /* An edit in a task's sheet shows on the task's row behind the sheet at once, before Vikunja answers. An edit Vikunja
     refuses puts back only its own field, in the sheet and on the row. A later edit of the task waits behind it in the
     Outbox, and is sent once the refused one is cancelled there. */
  await step('a-sheet-edit-shows-on-its-row-at-once-and-a-refused-one-puts-back-only-its-own-field', async () => {
    const r = await make(`Pocket smoke sheet row ${stamp}`, { due_date: todayAt(23) }),
      at = `**/v2/tasks/${r.id}`,
      renamed = r.title + ' renamed';
    let release = () => {};
    const title = new Promise(ok => {
      release = ok;
    });
    // Vikunja's answer to the title waits, then Vikunja refuses it.
    const hold = async x => {
      if (x.request().method() !== 'PATCH' || !('title' in x.request().postDataJSON())) return x.fallback();
      await title;
      return refusing(x);
    };
    const R = `#view .row[data-id="${r.id}"]`,
      rowTitle = page.locator(`${R} > .body .title > span:not(.sr)`).first(),
      bars = page.locator(`${R} .when .bars`);
    try {
      await toastGone();
      await refreshToday();
      await page.click(`${R} > .body`, { timeout: 15000 });
      await page.waitForSelector('#d-comments .comment-form', { timeout: 10000 });
      await page.route(at, hold);
      await ownTitle().click();
      await expect(page.locator('#d-title')).toBeFocused();
      await page.fill('#d-title', renamed);
      await page.press('#d-title', 'Enter');
      await expect(rowTitle).toHaveText(renamed);
      await page.selectOption('#d-prio', '3');
      await expect(bars).toHaveClass(/\bp3\b/);
      const kept = await get(r.id);
      if (kept.priority || kept.title !== r.title)
        throw new Error('Vikunja had the changes before the rows were checked');
      release();
      const line = placeLine(page, 'sheet:top');
      await expect(line).toContainText(`Renaming “${r.title}” couldn't be saved: Forbidden.`, { timeout: 20000 });
      await expect(rowTitle).toHaveText(r.title);
      await expect(ownTitle()).toHaveText(r.title);
      await expect(page.locator('#d-prio')).toHaveValue('3');
      await expect(bars).toHaveClass(/\bp3\b/);
      await page.unroute(at, hold);
      await line.getByRole('button', { name: 'Outbox' }).click();
      await page.locator('#outbox-rows .ob-row:has-text("Renaming")').getByRole('button', { name: 'Cancel' }).click();
      await page.waitForSelector('#outbox-rows .ob-row', { state: 'detached' });
      await page.click('#btn-sheet-close');
      await page.waitForSelector('#sheet', { state: 'hidden' });
      await synced(page);
      const now = await get(r.id);
      if (now.priority !== 3 || now.title !== r.title)
        throw new Error(`Vikunja has priority ${now.priority}, title "${now.title}"`);
    } finally {
      release();
      await page.unroute(at, hold);
      await api('/tasks/' + r.id, { method: 'DELETE' });
    }
  });

  await step('a-task-moves-and-goes-with-its-subtasks', async () => {
    const other = projects2.find(p => p.id !== home2);
    const parent = await make(`Pocket smoke move parent ${stamp}`, { due_date: todayAt(23) });
    const kids = [await make(`Pocket smoke move kid 1 ${stamp}`), await make(`Pocket smoke move kid 2 ${stamp}`)];
    for (const k of kids)
      await api(`/tasks/${parent.id}/relations`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ other_task_id: k.id, relation_kind: 'subtask' }),
      });
    await refreshToday();
    await page.click(`${cardOf(parent.title)} > .card-head`, { timeout: 15000 });
    await page.waitForFunction(() => document.querySelectorAll('#d-subtasks .row:not(.pending)').length === 2, null, {
      timeout: 10000,
    });
    if (other) {
      // From the ⋯ menu, with an Undo. Then from the Project row under Details.
      const where = async () => {
        await synced(page);
        return Promise.all([parent, ...kids].map(async t => (await get(t.id)).project_id));
      };
      const all = id => [id, id, id],
        line = placeLine(page, 'sheet:top');
      await page.click('#d-more');
      await expect(page.locator('#d-move-to')).toContainText('Its subtasks move with it.');
      await page.getByLabel('Move to another project').selectOption(String(other.id));
      await expect(line).toContainText(`Moved to ${other.title}, with its 2 subtasks`, { timeout: 20000 });
      await expect(page.locator('#d-menu')).toHaveCount(0);
      await expect(page.locator('#d-project-link')).toHaveText(other.title);
      expect(await where()).toEqual(all(other.id));
      await line.getByRole('button', { name: 'Undo' }).click();
      await expect(page.locator('#d-project-link')).not.toHaveText(other.title);
      expect(await where()).toEqual(all(parent.project_id));
      await page.selectOption('#d-proj', String(other.id));
      await expect(placeLine(page, 'sheet:props')).toContainText(`Moved to ${other.title}, with its 2 subtasks`, {
        timeout: 20000,
      });
      expect(await where()).toEqual(all(other.id));
    }
    await page.click('#d-more');
    if ((await page.textContent('#d-delete')) !== 'Delete task and its 2 subtasks')
      throw new Error('delete button text: ' + (await page.textContent('#d-delete')));
    await page.click('#d-delete');
    await page.waitForSelector('#sheet', { state: 'hidden', timeout: 15000 });
    await later(5000); // the deletion is sent once the Undo has expired
    await synced(page);
    if ((await Promise.all([parent, ...kids].map(t => get(t.id)))).some(Boolean)) throw new Error('a task is left');
  });

  /* A project's list follows the order of its List view in Vikunja, with each subtask under its parent in the subtask's
     own order. This is the same order as the web app. Holding a task and moving it up or down moves it among its
     siblings, and its new position is written to that view. */
  const order = { project: null, view: null, tasks: {} };
  const viewOrder = async () =>
    (await (await api(`/projects/${order.project.id}/views/${order.view}/tasks?expand=subtasks`)).json()).items;
  /* Lists what a project's open list shows, top to bottom: each task's title, from a row or a card, followed by the
     card's subtasks (its rows), each prefixed with "Subtask: ". */
  const listed = list =>
    list
      .locator(
        ':is(.item > .row > .body .title > span:not(.sr), .card-head .card-title, .card-rows > .row > .body .title > span:not(.sr))',
      )
      .evaluateAll(els => els.map(el => (el.closest('.card-rows') ? 'Subtask: ' : '') + el.textContent.trim()));
  const openRows = () => listed(page.locator('#view .list').first());
  // Holds a row, moves it past the first few pixels (so it counts as a move, not progress), then to the top or the
  // bottom of the row `to`, and releases.
  /* `selects` is a pair of selectors for simulating a phone's text selection. The first is what a long press selects
     when the touch goes down (the row's text, or the nearest thing that can be selected). The second is where a
     selection tries to start while the row moves. The hold must clear the first selection and block the second. */
  async function dragTo(sel, to, edge = 'top', selects = null) {
    await page.locator(sel).evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' })); // keep the row away from the screen edges, where the page would scroll
    const box = await steady(page.locator(sel)),
      x = box.x + box.width / 2,
      y0 = box.y + box.height / 2;
    const b = await page.locator(to).boundingBox(),
      y = edge === 'top' ? b.y + 4 : b.y + b.height - 4;
    await page.mouse.move(x, y0);
    await page.mouse.down();
    if (selects) await page.locator(selects[0]).evaluate(el => getSelection().selectAllChildren(el));
    await expect(page.locator(sel)).toHaveClass(/held/);
    await page.mouse.move(x, y0 + Math.sign(y - y0) * 14, { steps: 3 });
    if (
      selects &&
      (await page
        .locator(selects[1])
        .evaluate(el => el.dispatchEvent(new Event('selectstart', { bubbles: true, cancelable: true }))))
    )
      throw new Error('a selection could start while moving a row');
    await page.mouse.move(x, y, { steps: 12 });
    await page.mouse.up();
    return page.evaluate(() => getSelection().toString());
  }
  const rowById = id => `#view .row[data-id="${id}"]`;
  await step('project-in-list-view-order', async () => {
    order.project = await (
      await api('/projects', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ title: `PocketSmokeOrder${stamp}` }),
      })
    ).json();
    createdProjects.push(order.project.id);
    order.view = order.project.views
      .filter(v => v.view_kind === 'list')
      .sort((a, b) => a.position - b.position || a.id - b.id)[0].id;
    const mk = async (name, extra = {}) =>
      (order.tasks[name] = await (
        await api(`/projects/${order.project.id}/tasks`, {
          method: 'POST',
          headers: json,
          body: JSON.stringify({ title: `${name} ${stamp}`, ...extra }),
        })
      ).json());
    for (const name of ['Alpha', 'Bravo', 'Charlie', 'sub one', 'sub two', 'sub three'])
      await mk(name, name === 'Alpha' ? { description: '<p>Bring the long ladder</p>' } : {});
    await mk('Delta', { done: true });
    const T = order.tasks;
    for (const s of ['sub one', 'sub two', 'sub three'])
      await api(`/tasks/${T.Alpha.id}/relations`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ other_task_id: T[s].id, relation_kind: 'subtask' }),
      });
    // Give the tasks a separate order in the web app: Bravo, Alpha (sub three, sub one, sub two), Charlie.
    const at = { Bravo: 1000, Alpha: 2000, Charlie: 3000, 'sub three': 100, 'sub one': 200, 'sub two': 300 };
    for (const [name, position] of Object.entries(at))
      await api(`/tasks/${T[name].id}/position`, {
        method: 'PUT',
        headers: json,
        body: JSON.stringify({ project_view_id: order.view, position }),
      });
    await page.click('#btn-refresh'); // so Pocket loads the project
    await page.waitForSelector('#btn-refresh:not([disabled])');
    await page.evaluate(id => {
      location.hash = '#/project/' + id;
    }, order.project.id);
    const want = ['Bravo', 'Alpha', 'Subtask: sub three', 'Subtask: sub one', 'Subtask: sub two', 'Charlie'].map(
      n => `${n} ${stamp}`,
    );
    await expect.poll(openRows).toEqual(want);
    // Vikunja has the same order.
    const roots = (await viewOrder()).filter(t => !t.done && !t.related_tasks?.parenttask?.length).map(t => t.title);
    if (JSON.stringify(roots) !== JSON.stringify(['Bravo', 'Alpha', 'Charlie'].map(n => `${n} ${stamp}`)))
      throw new Error('Vikunja has ' + roots);
    // The done task is in the Done section, which is collapsed and shows a count.
    await expect(page.getByRole('button', { name: 'Done (1)' })).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#view .row', { hasText: `Delta ${stamp}` })).toHaveCount(0);
  });
  await step('drag-a-task-and-a-subtask', async () => {
    const T = order.tasks;
    // Holding and moving a row is a gesture, not a text selection. Nothing may be left selected afterwards, whatever
    // the phone's long press started (dragTo's `selects`).
    const unselected = (where, sel) => {
      if (sel) throw new Error(`moving ${where} left "${sel}" selected`);
    };
    // Bravo moves from the top to the bottom, under Charlie and past Alpha and its subtasks, which move with Alpha.
    unselected(
      "a row on a project's list",
      await dragTo(rowById(T.Bravo.id), rowById(T.Charlie.id), 'bottom', [
        `${rowById(T.Bravo.id)} .title`,
        `${rowById(T.Bravo.id)} .title`,
      ]),
    );
    await expect
      .poll(openRows)
      .toEqual(
        ['Alpha', 'Subtask: sub three', 'Subtask: sub one', 'Subtask: sub two', 'Charlie', 'Bravo'].map(
          n => `${n} ${stamp}`,
        ),
      );
    await synced(page);
    const pos = async () =>
      Object.fromEntries((await viewOrder()).map(t => [t.title.replace(` ${stamp}`, ''), t.position]));
    let p = await pos();
    if (!(p.Alpha < p.Charlie && p.Charlie < p.Bravo)) throw new Error('positions in Vikunja: ' + JSON.stringify(p));
    // A subtask moves only among its parent's subtasks. Here sub two moves to the top of them.
    await dragTo(rowById(T['sub two'].id), rowById(T['sub three'].id));
    await expect
      .poll(openRows)
      .toEqual(
        ['Alpha', 'Subtask: sub two', 'Subtask: sub three', 'Subtask: sub one', 'Charlie', 'Bravo'].map(
          n => `${n} ${stamp}`,
        ),
      );
    await synced(page);
    p = await pos();
    if (!(p['sub two'] < p['sub three'] && p['sub three'] < p['sub one']))
      throw new Error('positions in Vikunja: ' + JSON.stringify(p));
    // After a reload the order is the same, and Alpha's sheet shows its subtasks in that order too.
    await page.reload();
    await expect
      .poll(openRows, { timeout: 15000 })
      .toEqual(
        ['Alpha', 'Subtask: sub two', 'Subtask: sub three', 'Subtask: sub one', 'Charlie', 'Bravo'].map(
          n => `${n} ${stamp}`,
        ),
      );
    await page.click(`#view .day-card[data-id="${T.Alpha.id}"] > .card-head .card-open`);
    await expect(page.locator('#d-subtasks .row .title')).toHaveText(
      ['sub two', 'sub three', 'sub one'].map(n => `${n} ${stamp}`),
    );
    // In the sheet, subtasks move the same way. Here sub one moves to the top, and the new position is written to Vikunja's List view too.
    // In the sheet, a long press selects the nearest text, which is the Subtasks heading above the rows, or the notes.
    unselected(
      'a subtask in its sheet',
      await dragTo(
        `#d-subtasks .row[data-id="${T['sub one'].id}"]`,
        `#d-subtasks .row[data-id="${T['sub two'].id}"]`,
        'top',
        ['.h3:has(#d-subcount)', '#d-desc'],
      ),
    );
    // The heading and the subtasks' card cannot be selected. The notes can be selected when held on their own.
    const userSelect = q =>
      page.locator(q).evaluate(el => getComputedStyle(el).userSelect || getComputedStyle(el).webkitUserSelect);
    if ((await userSelect('.h3:has(#d-subcount)')) !== 'none' || (await userSelect('#d-subtasks')) !== 'none')
      throw new Error('the Subtasks heading or card can be selected');
    if ((await userSelect('#d-desc')) === 'none') throw new Error("the notes can't be selected");
    // Tapping the notes opens them for editing, so the long press here only selects text. No row is held.
    const notes = page.locator('#d-desc');
    if (!(await notes.evaluate(el => el.dispatchEvent(new Event('selectstart', { bubbles: true, cancelable: true })))))
      throw new Error('a long press on the notes selects nothing');
    await notes.evaluate(el => getSelection().selectAllChildren(el));
    if (!(await page.evaluate(() => getSelection().toString())).includes('Bring the long ladder'))
      throw new Error('the notes lost their selection');
    await page.evaluate(() => getSelection().removeAllRanges());
    await expect(page.locator('#d-subtasks .row .title')).toHaveText(
      ['sub one', 'sub two', 'sub three'].map(n => `${n} ${stamp}`),
    );
    await synced(page);
    p = await pos();
    if (!(p['sub one'] < p['sub two'] && p['sub two'] < p['sub three']))
      throw new Error('positions in Vikunja: ' + JSON.stringify(p));
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    await expect
      .poll(openRows)
      .toEqual(
        ['Alpha', 'Subtask: sub one', 'Subtask: sub two', 'Subtask: sub three', 'Charlie', 'Bravo'].map(
          n => `${n} ${stamp}`,
        ),
      );
  });
  await step('a-move-turned-down-goes-back-and-says-why', async () => {
    // Vikunja rejects the move. The row goes back where it was and shows Vikunja's reason.
    const T = order.tasks,
      refuse = r => {
        if (r.request().method() !== 'PUT') return r.fallback();
        refused.add(r.request().url());
        return r.fulfill({ status: 403, contentType: 'application/json', body: '{"detail":"Forbidden"}' });
      };
    await page.route('**/v2/tasks/*/position', refuse);
    await dragTo(rowById(T.Charlie.id), rowById(T.Bravo.id), 'bottom');
    await expect(rowLine(page, "The new order couldn't be saved: Forbidden.")).toBeVisible();
    await page.unroute('**/v2/tasks/*/position', refuse);
    await later(5000); // the message collapses and the row returns
    await expect
      .poll(openRows)
      .toEqual(
        ['Alpha', 'Subtask: sub one', 'Subtask: sub two', 'Subtask: sub three', 'Charlie', 'Bravo'].map(
          n => `${n} ${stamp}`,
        ),
      );
    await synced(page);
    const roots = (await viewOrder())
      .filter(t => !t.related_tasks?.parenttask?.length && !t.done)
      .map(t => t.title.replace(` ${stamp}`, ''));
    if (JSON.stringify(roots) !== JSON.stringify(['Alpha', 'Charlie', 'Bravo']))
      throw new Error('Vikunja has ' + roots);
  });
  await step('up-one-place-from-the-tasks-menu', async () => {
    // The task's menu reorders a task for keyboard and screen-reader users. A drag reorders a subtask.
    const T = order.tasks;
    await page.click(`${rowById(T.Bravo.id)} > .body`);
    await page.click('#d-more');
    await expect(page.getByRole('menuitem', { name: 'Down one place' })).toBeDisabled();
    await page.getByRole('menuitem', { name: 'Up one place' }).click();
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    await expect
      .poll(openRows)
      .toEqual(
        ['Alpha', 'Subtask: sub one', 'Subtask: sub two', 'Subtask: sub three', 'Bravo', 'Charlie'].map(
          n => `${n} ${stamp}`,
        ),
      );
    await dragTo(rowById(T['sub one'].id), rowById(T['sub two'].id), 'bottom');
    await expect
      .poll(openRows)
      .toEqual(
        ['Alpha', 'Subtask: sub two', 'Subtask: sub one', 'Subtask: sub three', 'Bravo', 'Charlie'].map(
          n => `${n} ${stamp}`,
        ),
      );
    await synced(page);
    const roots = (await viewOrder())
      .filter(t => !t.related_tasks?.parenttask?.length && !t.done)
      .map(t => t.title.replace(` ${stamp}`, ''));
    if (JSON.stringify(roots) !== JSON.stringify(['Alpha', 'Bravo', 'Charlie']))
      throw new Error('Vikunja has ' + roots);
  });
  /* On a desktop, Escape closes the innermost layer first. The task's ⋯ menu closes before the sheet, wherever the
     focus is: still on ⋯ (as Chrome leaves it), nowhere (as Safari leaves it), or on one of the menu's own items. The
     focus then returns to ⋯. A title that is being edited is cancelled before the sheet closes. */
  await step('escape-closes-what-is-innermost-first', async () => {
    const T = order.tasks,
      open = page.locator('#sheet.show'),
      menu = page.locator('#d-menu'),
      more = page.locator('#d-more');
    await page.click(`${rowById(T.Bravo.id)} > .body`);
    for (const [where, focus] of [
      ['on ⋯', () => more.focus()],
      ['nowhere', () => page.evaluate(() => document.activeElement.blur())],
      ['in the menu', () => page.focus('#d-share-text')],
    ]) {
      await more.click();
      await expect(menu).toBeVisible();
      await expect(page.locator('#d-share-text')).toBeFocused();
      await focus();
      await page.keyboard.press('Escape');
      await expect(menu, `the menu is still open, the focus ${where}`).toHaveCount(0);
      await expect(more).toBeFocused();
      await page.waitForTimeout(400); // a closing sheet would have disappeared by now
      await expect(open, `Escape closed the sheet with its menu, the focus ${where}`).toBeVisible();
    }
    await ownTitle().click();
    await expect(page.locator('#d-title')).toBeFocused();
    await page.keyboard.type(' renamed');
    await page.keyboard.press('Escape');
    await expect(page.locator('#d-title')).toHaveCount(0);
    await expect(ownTitle()).toHaveText(`Bravo ${stamp}`);
    await expect(open).toBeVisible();
    await page.keyboard.press('Escape');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    await synced(page);
    if ((await (await api('/tasks/' + T.Bravo.id)).json()).title !== `Bravo ${stamp}`)
      throw new Error('a cancelled title edit was saved');
  });
  await step('the-done-section-opens-loads-and-reopens', async () => {
    const T = order.tasks,
      done = page.getByRole('button', { name: /^Done/ }),
      delta = page.locator('#view .row', { hasText: `Delta ${stamp}` });
    // An old link to a project's done tasks opens its list with the Done section open.
    await page.evaluate(id => {
      location.hash = `#/project/${id}?done=1`;
    }, order.project.id);
    await expect(delta).toBeVisible({ timeout: 15000 });
    await expect(done).toHaveAttribute('aria-expanded', 'true');
    if ((await page.evaluate(() => location.hash)) !== '#/project/' + order.project.id)
      throw new Error('the address is ' + (await page.evaluate(() => location.hash)));
    // The section collapses and expands, and keeps its state after a reload.
    await done.click();
    await expect(delta).toBeHidden();
    await done.click();
    await expect(delta).toBeVisible();
    await page.reload();
    await expect(delta).toBeVisible({ timeout: 15000 });
    // Ticking the task reopens it. It returns to the open list and is not done in Vikunja.
    await page.getByRole('button', { name: `Mark not done: Delta ${stamp}` }).click();
    await expect(page.locator(`#view .row.leaving[data-id="${T.Delta.id}"]`)).not.toHaveClass(/\bdone\b/);
    await later(3000);
    await expect(page.locator('#view .list').first().locator(`.row[data-id="${T.Delta.id}"]`)).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByRole('button', { name: /^Done/ })).toHaveCount(0); // no done tasks remain
    await synced(page);
    if ((await (await api('/tasks/' + T.Delta.id)).json()).done) throw new Error('still done in Vikunja');
    // Ticking it done again removes it from the open list and counts it in Done.
    await page.getByRole('button', { name: `Mark done: Delta ${stamp}` }).click();
    await expect(page.locator(`#view .row.leaving[data-id="${T.Delta.id}"]`)).toHaveClass(/\bdone\b/);
    await synced(page);
    await later(3000);
    await expect(page.getByRole('button', { name: 'Done (1)' })).toBeVisible();
  });
  /* Completing a parent from its ring, after the question, completes its open subtasks too. The card stays, marked
     done, with those two subtasks ticked on it. Tapping the ring again reopens those two, and not the subtask that was
     already done before. */
  const doneIn = async (...names) =>
    Promise.all(names.map(async n => (await (await api('/tasks/' + order.tasks[n].id)).json()).done));
  const echoCard = () => page.locator(`#view .day-card[data-id="${order.tasks.Echo.id}"]`);
  await step('a-parent-completed-from-its-ring-and-undone-opens-only-those', async () => {
    const T = order.tasks,
      mk = async (name, extra = {}) =>
        (T[name] = await (
          await api(`/projects/${order.project.id}/tasks`, {
            method: 'POST',
            headers: json,
            body: JSON.stringify({ title: `${name} ${stamp}`, ...extra }),
          })
        ).json());
    await mk('Echo');
    for (const s of ['echo one', 'echo two']) await mk(s);
    await mk('echo done', { done: true });
    for (const s of ['echo one', 'echo two', 'echo done'])
      await api(`/tasks/${T.Echo.id}/relations`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ other_task_id: T[s].id, relation_kind: 'subtask' }),
      });
    await page.click('#btn-refresh');
    await page.waitForSelector('#btn-refresh:not([disabled])');
    await expect(echoCard().locator(`.row[data-id="${T['echo two'].id}"]`)).toBeVisible();
    await expect(echoCard().locator('.card-head > .ring .n')).toHaveText('1/3');
    await echoCard().locator('.card-head > .ring').click();
    await expect(page.locator('#complete-note')).toHaveText(
      /^Its 2 open subtasks will be marked done too: echo (one|two) \d+ and echo (one|two) \d+\.$/,
    );
    await page.click('#complete-yes');
    await expect(echoCard()).toHaveClass(/\bdone\b/);
    await expect(echoCard().locator('.card-rows > .row.done')).toHaveCount(2);
    await synced(page);
    if (JSON.stringify(await doneIn('Echo', 'echo one', 'echo two')) !== '[true,true,true]')
      throw new Error('not all tasks are done in Vikunja');
    await echoCard().locator('.card-head > .ring').click();
    await expect(echoCard()).not.toHaveClass(/\bdone\b/);
    await expect(echoCard().locator('.card-rows > .row:not(.done)')).toHaveCount(2);
    await synced(page);
    const now = await doneIn('Echo', 'echo one', 'echo two', 'echo done');
    if (JSON.stringify(now) !== '[false,false,false,true]')
      throw new Error('after tapping the ring again, done: ' + now);
  });
  /* A parent that is done while some subtasks are still open (ticked done in the web app, which leaves the subtasks
     open) shows as a card with its title struck through, above its open subtasks. The subtasks must not be listed on
     their own at the top. The card cannot be moved and the add box does not add to it. Tapping it opens its sheet.
     Tapping its ring reopens it in place with no question, because there is only one thing to do. */
  await step('a-done-parent-shows-over-its-open-subtasks', async () => {
    const T = order.tasks;
    await api('/tasks/' + T.Echo.id, { method: 'PATCH', headers: json, body: JSON.stringify({ done: true }) });
    await page.click('#btn-refresh');
    await page.waitForSelector('#btn-refresh:not([disabled])');
    await expect(echoCard()).toHaveClass(/\bdone\b/);
    await expect(echoCard().locator('.card-head .sr')).toContainText('Done, with subtasks still open');
    const rows = await openRows(),
      at = rows.indexOf(`Echo ${stamp}`);
    if (at < 0 || !rows.slice(at + 1, at + 3).every(r => /^Subtask: echo (one|two) /.test(r)))
      throw new Error('the rows are: ' + JSON.stringify(rows));
    if (rows.some(r => /^echo/.test(r)))
      throw new Error('a subtask is listed separately at the top: ' + JSON.stringify(rows));
    // Holding the card does not lift it for moving.
    const head = echoCard().locator('.card-head');
    await head.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    const box = await steady(head);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await later(800);
    await expect(echoCard()).not.toHaveClass(/held/);
    await page.mouse.up(); // releasing without a move counts as a tap, which opens the sheet
    await expect(page.locator('#sheet .row.own')).toHaveClass(/\bdone\b/);
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    await expect(page.locator('#cap-home')).toBeHidden(); // the add box stays at the bottom, adding a task rather than a subtask of this one
    // Tapping its ring reopens it in place, with its subtasks on it, and takes it out of Done.
    const count = +(await page.getByRole('button', { name: /^Done \(/ }).textContent()).match(/\d+/)[0];
    await expect(echoCard().locator('.card-head > .ring')).toHaveAttribute(
      'aria-label',
      `Mark not done: Echo ${stamp}`,
    );
    await echoCard().locator('.card-head > .ring').click();
    await expect(page.locator('#said')).toHaveText(`Not done: Echo ${stamp}`);
    if (await page.isVisible('#sheet')) throw new Error('a question was asked');
    await later(3000);
    await expect(echoCard()).not.toHaveClass(/\bdone\b/);
    await expect.poll(openRows).toEqual(rows);
    await expect(page.getByRole('button', { name: `Done (${count - 1})` })).toBeVisible();
    await synced(page);
    if (JSON.stringify(await doneIn('Echo', 'echo one', 'echo two')) !== '[false,false,false]')
      throw new Error('done flags in Vikunja: ' + (await doneIn('Echo', 'echo one', 'echo two')));
  });

  /* On a project's list, quick add's box adds a task to the project until it is moved under a task, either by a nudge
     on the task's row or by "Add a subtask here" in its ⋯ menu. Then the box sits in the list under that row and adds
     subtasks to the task. Each new subtask goes after the last subtask, or after the subtask the box is under, and
     each one after the one before. The row the box adds at is highlighted, and no other row is. A newly added
     subtask becomes the highlighted row in its turn. Ticking a row, swiping a row or closing a sheet leaves the box where it is. */
  const foot = { project: null, view: null, tasks: {} };
  const footRows = () => listed(page.locator('#view .list').first());
  const footName = n => `${n} ${stamp}`;
  const box = page.locator('#in-capture'),
    home = page.locator('#cap-home');
  // Checks where the box is. `boxUnder`: in the list, adding subtasks to `to`. Its label and placeholder say so, the
  // dashed placeholder it left at the bottom is showing, and the row it is under is highlighted (onlyLit).
  // `boxHome`: at the bottom, adding a task.
  const boxUnder = async to => {
    await expect(box).toHaveAttribute('aria-label', `New subtask of ${to}`);
    await expect(box).toHaveAttribute('placeholder', 'Subtask');
    await expect(home).toBeVisible();
  };
  const boxHome = async () => {
    await expect(home).toBeHidden();
    await expect(box).toHaveAttribute('aria-label', 'New task');
  };
  const footPositions = async () =>
    Object.fromEntries(
      (await (await api(`/projects/${foot.project.id}/views/${foot.view}/tasks?expand=subtasks`)).json()).items.map(
        t => [t.title.replace(` ${stamp}`, ''), t],
      ),
    ); // keyed by name, with position and related_tasks
  // A task on the list: a row, or a card (a task with open subtasks, highlighted like a row while the box adds to it).
  const itemById = id => `#view :is(.item > .row, .day-card)[data-id="${id}"]`;
  // Finds a subtask's row by name, either waiting to be sent or already sent. `onlyLit` checks that exactly one thing on the list is highlighted.
  const subRow = (name, waiting = false) =>
    `#view .card-rows > .row${waiting ? '.pending' : ':not(.pending)'}:has(> .body .title:has-text("${footName(name)}"))`;
  const onlyLit = async sel => {
    await expect(page.locator(sel)).toHaveClass(/\baimed\b/);
    await expect(page.locator('#view .aimed')).toHaveCount(1);
  };
  // Holds back Vikunja's answer to a task being created until the returned function is called.
  const holdAdds = async () => {
    let send;
    const sending = new Promise(ok => {
      send = ok;
    });
    const hold = async r => {
      if (r.request().method() === 'POST') await sending;
      await r.fallback();
    };
    await page.route('**/v2/projects/*/tasks', hold);
    return async () => {
      send();
      await page.unroute('**/v2/projects/*/tasks', hold);
    };
  };
  // Moves the box under task `id` with "Add a subtask here" in the sheet's ⋯ menu, which closes the sheet. The focus
  // that action gives the box is then removed, so scrolling can send the box home, as it does when nothing is being typed.
  const addHere = async id => {
    await page.click(`:is(${rowById(id)} > .body, #view .day-card[data-id="${id}"] > .card-head .card-open)`);
    await page.waitForSelector('#sheet .row.own');
    await page.click('#d-more');
    await page.click('#d-add-here');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    await box.blur();
  };
  await step('the-add-box-adds-subtasks-to-the-task-touched', async () => {
    foot.project = await (
      await api('/projects', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ title: `PocketSmokeFoot${stamp}` }),
      })
    ).json();
    createdProjects.push(foot.project.id);
    foot.view = foot.project.views
      .filter(v => v.view_kind === 'list')
      .sort((a, b) => a.position - b.position || a.id - b.id)[0].id;
    const mk = async name =>
      (foot.tasks[name] = await (
        await api(`/projects/${foot.project.id}/tasks`, {
          method: 'POST',
          headers: json,
          body: JSON.stringify({ title: footName(name) }),
        })
      ).json());
    for (const name of ['Van', 'Chairs', 'Tables', 'Lights']) await mk(name);
    const T = foot.tasks;
    for (const s of ['Chairs', 'Tables'])
      await api(`/tasks/${T.Van.id}/relations`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ other_task_id: T[s].id, relation_kind: 'subtask' }),
      });
    for (const [name, position] of Object.entries({ Van: 1000, Lights: 2000, Chairs: 100, Tables: 200 }))
      await api(`/tasks/${T[name].id}/position`, {
        method: 'PUT',
        headers: json,
        body: JSON.stringify({ project_view_id: foot.view, position }),
      });
    await page.click('#btn-refresh'); // so Pocket loads the project
    await page.waitForSelector('#btn-refresh:not([disabled])');
    await page.evaluate(id => {
      location.hash = '#/project/' + id;
    }, foot.project.id);
    await expect
      .poll(footRows, { timeout: 15000 })
      .toEqual(['Van', 'Subtask: Chairs', 'Subtask: Tables', 'Lights'].map(footName));
    // Before anything is touched, the box adds a task to the project.
    await expect(box).toHaveAttribute('placeholder', `Add a task to PocketSmokeFoot${stamp}`);
    await boxHome();
    // Once the box is moved under the task, the box says so, the task's row is highlighted, and a screen reader announces it.
    await addHere(T.Van.id);
    await boxUnder(footName('Van'));
    await onlyLit(itemById(T.Van.id));
    await expect(page.locator('#said')).toHaveText(`Add a subtask to ${footName('Van')}`);
    const original = await footRows(),
      positions = await footPositions();
    await box.fill('Draft');
    await page.locator(`#view .day-card[data-id="${T.Van.id}"] .card-open`).focus();
    await page.keyboard.press('Alt+ArrowDown');
    await onlyLit(subRow('Chairs'));
    await expect(box).toBeFocused();
    await page.keyboard.press('Alt+ArrowDown');
    await onlyLit(subRow('Tables'));
    await page.keyboard.press('Alt+ArrowUp');
    await onlyLit(subRow('Chairs'));
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(box).toHaveAttribute('placeholder', 'Task');
    await page.keyboard.press('Alt+ArrowRight');
    await expect(box).toHaveAttribute('placeholder', 'Subtask');
    await page.keyboard.press('Alt+ArrowUp');
    await onlyLit(itemById(T.Van.id));
    await expect(box).toHaveValue('Draft');
    await expect(box).toBeFocused();
    expect(await footRows()).toEqual(original);
    expect(await footPositions()).toEqual(positions);
    await box.fill('');
    // Type two subtasks and press Enter after each. The box keeps the focus. Under the task, the box adds the first
    // subtask, so the first goes before Chairs and the second goes after the first, in the order typed. The
    // highlight follows each new subtask. While Vikunja's answer for the first is held back, its waiting row is
    // highlighted at once and the task's own header is not. Once sent, the same row stays highlighted.
    await box.click();
    await box.fill(footName('Rope'));
    const send = await holdAdds();
    try {
      await box.press('Enter');
      await expect(box).toHaveValue('');
      await onlyLit(subRow('Rope', true));
      await boxUnder(footName('Van'));
    } finally {
      await send();
    }
    await onlyLit(subRow('Rope'));
    await boxUnder(footName('Van'));
    await box.fill(footName('Straps'));
    await box.press('Enter');
    await expect
      .poll(footRows)
      .toEqual(
        ['Van', 'Subtask: Rope', 'Subtask: Straps', 'Subtask: Chairs', 'Subtask: Tables', 'Lights'].map(footName),
      );
    if ((await page.evaluate(() => document.activeElement?.id)) !== 'in-capture')
      throw new Error('the box lost the focus');
    await boxUnder(footName('Van'));
    await onlyLit(subRow('Straps'));
    await noToast(page);
    await synced(page);
    const p = await footPositions();
    for (const s of ['Rope', 'Straps'])
      if (!p[s].related_tasks?.parenttask?.some(x => x.id === T.Van.id)) throw new Error(s + ' is not under Van');
    if (!(p.Rope.position < p.Straps.position && p.Straps.position < p.Chairs.position))
      throw new Error('positions are: ' + ['Rope', 'Straps', 'Chairs'].map(s => p[s].position));
    foot.tasks.Rope = p.Rope;
    foot.tasks.Straps = p.Straps;
    await page.reload();
    await expect
      .poll(footRows, { timeout: 15000 })
      .toEqual(
        ['Van', 'Subtask: Rope', 'Subtask: Straps', 'Subtask: Chairs', 'Subtask: Tables', 'Lights'].map(footName),
      );
    await boxHome(); // a reload resets the box
  });
  await step('the-add-box-adds-right-after-a-subtask-touched', async () => {
    const T = foot.tasks;
    await addHere(T.Chairs.id);
    await boxUnder(footName('Van'));
    await onlyLit(rowById(T.Chairs.id));
    // A pasted list adds several subtasks, and the next subtask goes after them. The last one added is the highlighted row.
    await box.fill(`${footName('Ladder')}
${footName('Hooks')}`);
    await expect(page.locator('#cap-chips')).toContainText('2 subtasks');
    await box.press('Enter');
    await boxUnder(footName('Van'));
    await onlyLit(subRow('Hooks'));
    await box.fill(`${footName('Tarp')} +Elsewhere`); // +project stays in the title
    await expect(page.locator('#cap-chips')).toContainText(
      "+project stays in the title. A subtask goes in its parent's project.",
    );
    await box.press('Enter');
    const want = [
      footName('Van'),
      ...['Rope', 'Straps', 'Chairs', 'Ladder', 'Hooks'].map(n => 'Subtask: ' + footName(n)),
      `Subtask: Tarp ${stamp} +Elsewhere`,
      'Subtask: ' + footName('Tables'),
      footName('Lights'),
    ];
    await expect.poll(footRows).toEqual(want);
    await boxUnder(footName('Van'));
    await onlyLit(subRow('Tarp'));
    await synced(page);
    const p = await footPositions(),
      tarp = Object.keys(p).find(k => k.startsWith('Tarp'));
    const order = ['Chairs', 'Ladder', 'Hooks', tarp, 'Tables'].map(s => p[s].position);
    if (order.some((x, i) => i && x <= order[i - 1])) throw new Error('positions are: ' + order);
    if (p[tarp].project_id !== foot.project.id) throw new Error('the subtask went to another project');
    await page.reload();
    await expect.poll(async () => (await footRows()).length, { timeout: 15000 }).toBe(want.length);
    await expect.poll(async () => (await footRows())[6]).toBe(`Subtask: Tarp ${stamp} +Elsewhere`);
  });
  await step('the-add-boxs-place-at-the-bottom-brings-it-back-to-adding-a-task', async () => {
    const T = foot.tasks;
    await addHere(T.Van.id);
    // The dashed placeholder the box left at the bottom shows the same text the box shows there, and tapping it brings
    // the box home. The box has no × of its own.
    const place = page.getByRole('button', { name: `Add a task to PocketSmokeFoot${stamp} instead` });
    await expect(place).toHaveText(`Add a task to PocketSmokeFoot${stamp}`);
    const size = await place.boundingBox();
    if (size.height < 44) throw new Error('the placeholder is ' + size.width + '×' + size.height);
    await place.click();
    await boxHome();
    await expect(page.locator(itemById(T.Van.id))).not.toHaveClass(/aimed/);
    await expect(box).toHaveAttribute('placeholder', `Add a task to PocketSmokeFoot${stamp}`);
    await box.fill(footName('Fuel'));
    await box.press('Enter');
    await expect.poll(async () => (await footRows())[0]).toBe(footName('Fuel')); // a separate task, first in the list, where Vikunja puts a new task
    await synced(page);
    const p = await footPositions();
    if (p.Fuel?.related_tasks?.parenttask?.length) throw new Error('Fuel was added as a subtask');
  });
  await step('a-tick-leaves-the-add-box-where-it-is', async () => {
    const T = foot.tasks;
    // With the box under Van, ticking a subtask done and then open again does not move the box, so rows never shift under the next tick.
    await addHere(T.Van.id);
    await page.getByRole('button', { name: 'Mark done: ' + footName('Rope'), exact: true }).click();
    await boxUnder(footName('Van'));
    await onlyLit(itemById(T.Van.id));
    await page.getByRole('button', { name: 'Mark not done: ' + footName('Rope'), exact: true }).click();
    await boxUnder(footName('Van'));
    await onlyLit(itemById(T.Van.id));
    await synced(page);
    await home.click();
    await boxHome();
  });
  await step('the-add-box-forgets-a-task-scrolled-away-or-left', async () => {
    const T = foot.tasks;
    await addHere(T.Lights.id);
    await boxUnder(footName('Lights'));
    // Scrolling the task off the screen returns the box to adding a task, and scrolling back does not undo that.
    await page.evaluate(() => {
      document.getElementById('view').style.paddingBottom = '3000px';
    });
    await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
    await boxHome();
    await expect(box).toHaveAttribute('placeholder', `Add a task to PocketSmokeFoot${stamp}`);
    await page.evaluate(() => scrollTo(0, 0));
    await expect(page.locator(rowById(T.Lights.id))).toBeInViewport();
    await boxHome();
    await page.evaluate(() => {
      document.getElementById('view').style.paddingBottom = '';
    });
    // Going to another screen and back also returns the box to adding a task.
    await addHere(T.Lights.id);
    await expect(home).toBeVisible();
    await page.click('nav.tabs a[data-tab=today]');
    await expect(box).toHaveAttribute('placeholder', 'Add a task');
    await page.goBack();
    await expect.poll(async () => (await footRows()).length, { timeout: 15000 }).toBeGreaterThan(0);
    await boxHome();
    await expect(box).toHaveAttribute('placeholder', `Add a task to PocketSmokeFoot${stamp}`);
  });
  /* A nudge is a touch on a row that turns into a short, slow scroll. It moves the add box under that row. These do
     not: a long or fast scroll, a hold, a tap (which opens the sheet, and closing the sheet leaves the box where it
     is), a done row, and a read-only row. The touch uses Chrome's own touch input (`finger` in helpers.mjs), so the
     page scrolls under it as on a phone. Each gesture starts from the top of the list, where the page cannot scroll,
     so no row moves out of sight meanwhile. */
  const cursorId = () => page.evaluate(() => Alpine.$data(document.body).cursor?.id ?? null);
  await step('a-nudge-aims-the-add-box', async () => {
    const T = foot.tasks,
      Fuel = rowOf(footName('Fuel')),
      Hooks = rowOf(footName('Hooks'));
    await page.evaluate(() => scrollTo(0, 0));
    await boxHome();
    // Dragging down 40px slowly makes the row it started on the target. The row is highlighted and a screen reader announces it.
    await touchDrag(`#view .day-card[data-id="${T.Van.id}"] > .card-head`, 40);
    await boxUnder(footName('Van'));
    await expect(page.locator(itemById(T.Van.id))).toHaveClass(/aimed/);
    await expect(page.locator('#said')).toHaveText(`Add a subtask to ${footName('Van')}`);
    // A nudge on a subtask puts the box after that subtask, under its task.
    await touchDrag(rowById(T.Tables.id), 30);
    await boxUnder(footName('Van'));
    // A drag longer than a row, however slow, or a fast drag, counts as a scroll, and the target stays.
    await touchDrag(rowById(T.Chairs.id), 150, 30);
    await touchDrag(Fuel, 50, 2, 8);
    // A hold that ends without moving is neither a tap nor a nudge.
    await touchDrag(rowById(T.Chairs.id), 0, 0, 0, 700);
    await expect(page.locator('#sheet')).toBeHidden();
    if ((await cursorId()) !== T.Tables.id) throw new Error('the target moved to ' + (await cursorId()));
    await boxUnder(footName('Van'));
    // Ticking a row done leaves the box where it is, and a nudge on that row while it leaves moves nothing. After the
    // row is ticked open again, the box is still where it was. When the project is made read only, no row in it can
    // have the box. The box goes home, a nudge on a row does not bring it back, and it stays home once the project can
    // be changed again.
    await page.getByRole('button', { name: 'Mark done: ' + footName('Hooks'), exact: true }).click();
    await boxUnder(footName('Van'));
    await onlyLit(rowById(T.Tables.id));
    await touchDrag(Hooks, 30);
    if ((await cursorId()) !== T.Tables.id) throw new Error('the target moved to ' + (await cursorId()));
    await page.getByRole('button', { name: 'Mark not done: ' + footName('Hooks'), exact: true }).click();
    await boxUnder(footName('Van'));
    await onlyLit(rowById(T.Tables.id));
    await page.evaluate(id => {
      Alpine.$data(document.body).perms[id] = 0;
    }, foot.project.id);
    try {
      await boxHome();
      await touchDrag(Fuel, 30);
      if ((await cursorId()) !== null) throw new Error('a read-only row is the target: ' + (await cursorId()));
    } finally {
      await page.evaluate(id => {
        delete Alpine.$data(document.body).perms[id];
      }, foot.project.id);
    }
    await boxHome();
    await expect(page.locator('#view .aimed')).toHaveCount(0);
    // A tap with a touch still opens the sheet. Closing the sheet leaves the box where it is, at the bottom.
    const b = await steady(page.locator(Fuel + ' > .body'));
    await touch('touchStart', b.x + b.width / 2, b.y + b.height / 2);
    await touch('touchEnd', 0, 0);
    await page.waitForSelector('#sheet .row.own');
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    await boxHome();
    await expect(page.locator('#view .aimed')).toHaveCount(0);
    await synced(page);
  });
  /* A mouse can nudge too. Pressing on a row, dragging a short, slow distance up or down and releasing moves the box
     under that row. The click that would follow is swallowed, so the row's sheet stays shut. A long drag, however
     slow, does nothing, and a plain mouse click still opens the sheet. */
  await step('a-mouse-nudges-too', async () => {
    const T = foot.tasks;
    const drag = async (sel, by, steps = 8, every = 40) => {
      const b = await steady(page.locator(sel)),
        x = b.x + b.width / 2,
        y = b.y + b.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      for (let i = 1; i <= steps; i++) {
        await page.mouse.move(x, y + (by * i) / steps);
        await page.waitForTimeout(every);
      }
      await page.mouse.up();
    };
    await page.evaluate(() => scrollTo(0, 0));
    await drag(rowById(T.Tables.id), 30);
    await onlyLit(rowById(T.Tables.id));
    await expect(page.locator('#cap-home')).toBeVisible(); // the place the box left at the bottom: it's in the list
    await expect(page.locator('#sheet')).toBeHidden();
    if ((await cursorId()) !== T.Tables.id) throw new Error('the box went to ' + (await cursorId()));
    await drag(rowById(T.Chairs.id), 150, 30);
    if ((await cursorId()) !== T.Tables.id) throw new Error('a long drag moved the box to ' + (await cursorId()));
    await page.click(rowById(T.Chairs.id) + ' > .body');
    await page.waitForSelector('#sheet .row.own');
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
  });
  /* The highlighted row follows what is added, and a nudge always selects a row. If the user nudges the row that was
     touched before a subtask was added, that row is highlighted again and the box goes back to it. The highlighted
     row is never a deleted row. When it is deleted, its task is highlighted, and the box goes back to that task's last
     subtask. Moving the row up or down does not remove it, so it stays highlighted. */
  await step('a-nudge-selects-the-row-touched-before-and-a-lit-row-gone-hands-over-to-its-task', async () => {
    const T = foot.tasks,
      head = `#view .day-card[data-id="${T.Van.id}"] > .card-head`;
    await page.evaluate(() => scrollTo(0, 0));
    await touchDrag(head, 40);
    await boxUnder(footName('Van'));
    await onlyLit(itemById(T.Van.id));
    await box.fill(footName('Cones'));
    await box.press('Enter');
    await onlyLit(subRow('Cones'));
    await boxUnder(footName('Van'));
    await synced(page);
    // Nudging the header again selects the row that was touched before. It is the highlighted row, and the box names only the task.
    await touchDrag(head, 40);
    await boxUnder(footName('Van'));
    await onlyLit(itemById(T.Van.id));
    await expect(page.locator('#said')).toHaveText(`Add a subtask to ${footName('Van')}`);
    // The next subtask goes first again, before Cones, which went first before Rope.
    await box.fill(footName('Flags'));
    await box.press('Enter');
    await onlyLit(subRow('Flags'));
    await synced(page);
    let p = await footPositions();
    if (!(p.Flags.position < p.Cones.position && p.Cones.position < p.Rope.position))
      throw new Error('positions are: ' + ['Flags', 'Cones', 'Rope'].map(s => p[s].position));
    // When the highlighted row is deleted, its task becomes highlighted and the box goes back to it. Restoring the row does not highlight it again without the user touching it.
    await swipeRow(page, subRow('Flags'), 'delete');
    await expect(page.locator(subRow('Flags'))).toHaveClass(/\bdeleted\b/);
    await boxUnder(footName('Van'));
    await onlyLit(itemById(T.Van.id));
    await page
      .locator(subRow('Flags'))
      .getByRole('button', { name: 'Restore ' + footName('Flags') })
      .click();
    await expect(page.locator(subRow('Flags'))).not.toHaveClass(/\bdeleted\b/);
    await boxUnder(footName('Van'));
    await onlyLit(itemById(T.Van.id));
    await synced(page);
    // Ticking the subtask done and open again does not move the box. The task stays highlighted.
    await page.getByRole('button', { name: 'Mark done: ' + footName('Flags'), exact: true }).click();
    await onlyLit(itemById(T.Van.id));
    await synced(page); // wait until the row is marked as sent, not merely held, so that tapping its tick removes the mark
    await page.getByRole('button', { name: 'Mark not done: ' + footName('Flags'), exact: true }).click();
    await boxUnder(footName('Van'));
    await onlyLit(itemById(T.Van.id));
    // Nudge the subtask, then drag it down one position. The same subtask stays highlighted after the move.
    await touchDrag(subRow('Flags'), 30);
    await onlyLit(subRow('Flags'));
    await synced(page);
    await dragTo(subRow('Flags'), subRow('Cones'), 'bottom');
    await boxUnder(footName('Van'));
    await onlyLit(subRow('Flags'));
    await synced(page);
    p = await footPositions();
    if (!(p.Cones.position < p.Flags.position))
      throw new Error("Flags didn't move down: " + ['Cones', 'Flags'].map(s => p[s].position));
    // A subtask that arrives done leaves with the batch, so it is not highlighted. Its task is.
    await box.fill('x ' + footName('Bolts'));
    await box.press('Enter');
    await expect(page.getByRole('button', { name: 'Mark not done: ' + footName('Bolts'), exact: true })).toBeVisible();
    await boxUnder(footName('Van'));
    await onlyLit(itemById(T.Van.id));
    await synced(page);
  });
  /* On Today the box adds a task until a row is nudged. Then the box sits under that row and adds subtasks, as on a
     project's list. Under a card's header, the new subtask lands on top, above the card's most urgent row, and shows as
     waiting. The box moves under it, so the next subtask goes under that. The card grows by a row each time until the
     user leaves the screen. Then the card is sorted as Today normally sorts it, with the dateless rows under More. In
     the project the new subtasks are first, in the order typed. Nudging a plain task turns it into a card with the
     added subtask. Tapping the placeholder at the bottom brings the box home. */
  await step('a-nudge-on-today-moves-the-add-box-under-the-row-to-add-a-subtask-there', async () => {
    const d = await make(`Pocket smoke nudge ${stamp}`, { due_date: todayAt(23) }),
      k = await make(`Pocket smoke nudge due ${stamp}`, { due_date: todayAt(22) });
    const plain = await make(`Pocket smoke nudge plain ${stamp}`, { due_date: todayAt(21) });
    const a = `Pocket smoke nudge sub A ${stamp}`,
      b = `Pocket smoke nudge sub B ${stamp}`,
      c = `Pocket smoke nudge sub C ${stamp}`,
      made = [];
    const lv = (await (await api(`/projects/${d.project_id}`)).json()).views
      .filter(v => v.view_kind === 'list')
      .sort((x, y) => x.position - y.position || x.id - y.id)[0].id;
    const find = async t =>
      ((await (await api('/tasks?q=' + encodeURIComponent(t))).json()).items || []).find(x => x.title === t);
    const places = async ids =>
      Object.fromEntries(
        (
          (
            await (
              await api(
                `/projects/${d.project_id}/views/${lv}/tasks?filter=` + encodeURIComponent('id in ' + ids.join(', ')),
              )
            ).json()
          ).items || []
        ).map(t => [t.id, t.position]),
      );
    const card = cardOf(d.title),
      rows = () =>
        page.$$eval(`${card} .card-rows > .row .title > span:not(.sr)`, es => es.map(e => e.textContent.trim()));
    const same = (got, want, what) => {
      if (JSON.stringify(got) !== JSON.stringify(want))
        throw new Error(`${what}: ${JSON.stringify(got)}, not ${JSON.stringify(want)}`);
    };
    try {
      await api(`/tasks/${d.id}/relations`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ other_task_id: k.id, relation_kind: 'subtask' }),
      });
      await api(`/tasks/${k.id}/position`, {
        method: 'PUT',
        headers: json,
        body: JSON.stringify({ project_view_id: lv, position: 1000 }),
      });
      await refreshToday();
      await expect(page.locator(card)).toBeVisible({ timeout: 15000 });
      await page.locator(card).evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await touchDrag(`${card} > .card-head`, 30);
      await expect(page.locator('#sheet')).toBeHidden();
      if ((await cursorId()) !== d.id) throw new Error('the box went under ' + (await cursorId()));
      await boxUnder(d.title);
      await expect(page.locator(card)).toHaveClass(/\baimed\b/);
      await box.fill(a);
      await box.press('Enter');
      await expect(page.locator(`${card} .card-rows > .row`).nth(0).locator('.title')).toContainText(a, {
        timeout: 15000,
      }); // the rows load after the template
      await synced(page);
      const A = await find(a);
      made.push(A);
      if (!A?.related_tasks?.parenttask?.some(p => p.id === d.id))
        throw new Error('not a subtask of the card nudged: ' + JSON.stringify(A?.related_tasks));
      if ((await cursorId()) !== A.id)
        throw new Error('the box did not follow the subtask added: under ' + (await cursorId()));
      await boxUnder(d.title);
      await box.fill(b);
      await box.press('Enter');
      await expect(page.locator(`${card} .card-rows > .row`).nth(1).locator('.title')).toContainText(b, {
        timeout: 15000,
      });
      await synced(page);
      const B = await find(b);
      made.push(B);
      same(
        await rows(),
        [a, b, k.title],
        'the added rows are where the box was, above the most urgent row, and the card grew by a row each time',
      );
      const at = await places([A.id, B.id, k.id]);
      if (!(at[A.id] < at[B.id] && at[B.id] < at[k.id]))
        throw new Error('the new subtasks are not first in the project in the order typed: ' + JSON.stringify(at));
      await expect(page.locator(`${card} > .card-more`)).toHaveCount(0); // every row is visible, so no More button
      await touchDrag(rowOf(plain.title), 30);
      await boxUnder(plain.title);
      await box.fill(c);
      await box.press('Enter');
      await expect(page.locator(`${cardOf(plain.title)} .card-rows > .row .title:has-text("${c}")`)).toBeVisible({
        timeout: 15000,
      });
      await synced(page);
      made.push(await find(c));
      await home.click();
      await boxHome();
      // After leaving the screen and coming back, the card is sorted as Today normally sorts it, with the most urgent
      // row on top and the dateless rows under More. (A refresh is not leaving: the rows stay where they were added.)
      await page.click('[data-tab="projects"]');
      await page.waitForURL(/#\/projects/);
      await refreshToday();
      await expect(page.locator(card)).toBeVisible({ timeout: 15000 });
      same(await rows(), [k.title], 'back on Today, the card is collapsed to its most urgent row');
      await page.click(`${card} > .card-more`);
      same(await rows(), [k.title, a, b], 'when opened, the rows without a date are last, in their project order');
    } finally {
      for (const t of [...made, k, d, plain]) if (t) await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });

  let vanCopy = '',
    vanId = 0,
    projectCopy = ''; // the task's Markdown copy, the task, and the project's copy, for the test that pastes them back
  await step('share-progress-copy-it-and-open-it-in-vikunja', async () => {
    // A separate project with "Pack the van" at 60%, with notes and a comment, and these subtasks in this order: one
    // done, one halfway, one assigned to the user. "Order milk" comes after it.
    const proj = await (
      await api('/projects', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ title: `PocketSmokeShare${stamp}` }),
      })
    ).json();
    createdProjects.push(proj.id);
    const view = proj.views
      .filter(v => v.view_kind === 'list')
      .sort((a, b) => a.position - b.position || a.id - b.id)[0].id;
    const me = await (await api('/user')).json(),
      my = (me.name || '').trim().split(/\s+/)[0] || me.username;
    const mk = async (name, extra = {}, position) => {
      const t = await (
        await api(`/projects/${proj.id}/tasks`, {
          method: 'POST',
          headers: json,
          body: JSON.stringify({ title: name, ...extra }),
        })
      ).json();
      await api(`/tasks/${t.id}/position`, {
        method: 'PUT',
        headers: json,
        body: JSON.stringify({ project_view_id: view, position }),
      });
      return t;
    };
    const van = await mk(
      `Pack the van ${stamp}`,
      { percent_done: 0.6, description: '<p>Bring the long cable</p><p>Keys in the office</p>' },
      1000,
    );
    await mk(`Order milk ${stamp}`, {}, 2000);
    const subs = [
      await mk('Load chairs', { done: true }, 100),
      await mk('Tables', { percent_done: 0.5 }, 200),
      await mk('Sound system', {}, 300),
      await mk('Lights', {}, 400),
    ];
    for (const s of subs)
      await api(`/tasks/${van.id}/relations`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ other_task_id: s.id, relation_kind: 'subtask' }),
      });
    await api(`/tasks/${subs[2].id}/assignees/bulk`, {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ assignees: [{ id: me.id }] }),
    });
    await api(`/tasks/${van.id}/comments`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ comment: '<p>Van keys are <b>in the office</b></p>' }),
    });
    await page.click('#btn-refresh'); // so Pocket loads the project
    await page.waitForSelector('#btn-refresh:not([disabled])');
    await page.evaluate(id => {
      location.hash = '#/project/' + id;
    }, proj.id);
    await page.click(`#view .day-card[data-id="${van.id}"] > .card-head .card-open`, { timeout: 15000 });
    await expect(page.locator('#d-subtasks .row .title')).toHaveText([
      'Load chairs',
      'Tables',
      'Sound system',
      'Lights',
    ]);
    await expect(
      page
        .locator('#d-subtasks')
        .getByRole('button', { name: 'Sound system is assigned to you. Tap to unassign yourself.' }),
    ).toBeVisible();
    await expect(page.locator('#d-comments .comment')).toHaveCount(1);

    // Sharing through the phone's share sheet sends plain text, with the task's name as its title. The progress is the
    // ring's value, worked out from the subtasks: (100 + 50 + 0 + 0) / 4 = 38%, not the 60% set before it had
    // subtasks. The text has one segment per subtask, filled for each subtask that is done.
    await expect(page.locator('#sheet .row.own > .ring .n')).toHaveText('1/4');
    await expect
      .poll(() =>
        page
          .locator('#sheet .row.own > .ring')
          .evaluate(el => Math.round(parseFloat(getComputedStyle(el).getPropertyValue('--ring')) * 100)),
      )
      .toBe(38);
    const text = [
      `Pack the van ${stamp}  ▰▱▱▱ 38%`,
      '✓ Load chairs',
      '◐ Tables 50%',
      `○ Sound system · ${my}`,
      '○ Lights',
    ].join('\n');
    await page.evaluate(() => {
      window.shared = [];
      navigator.share = async d => {
        window.shared.push(d);
      };
    });
    const menu = async () => {
      if (!(await page.locator('#d-menu').isVisible())) await page.click('#d-more');
      return page.locator('#d-menu');
    };
    await (await menu()).getByRole('menuitem', { name: 'Share as text' }).click();
    await expect.poll(() => page.evaluate(() => window.shared)).toEqual([{ title: `Pack the van ${stamp}`, text }]);
    await expect(page.locator('#d-menu')).toHaveCount(0);
    // Without a share sheet, the text is copied to the clipboard, and a message says so where the user shared from.
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(APP).origin });
    // Windows' clipboard returns lines separated by \r\n, so normalise them.
    const clip = () => page.evaluate(() => navigator.clipboard.readText()).then(t => t.replace(/\r\n/g, '\n'));
    await page.evaluate(() => navigator.clipboard.writeText(''));
    await page.evaluate(() => {
      navigator.share = undefined;
    });
    await (await menu()).getByRole('menuitem', { name: 'Share as text' }).click();
    await placeSays(page, 'sheet:top', 'Copied. Paste it into a message');
    await expect.poll(clip).toBe(text);
    // Copy beside ⋯ copies the same text in one tap, with no share sheet.
    await page.evaluate(() => {
      navigator.clipboard.writeText('');
      window.shared = [];
      navigator.share = async d => {
        window.shared.push(d);
      };
    });
    await page.click('#d-copy');
    await expect.poll(clip).toBe(text);
    await placeSays(page, 'sheet:top', 'Copied. Paste it into a message');
    expect(await page.evaluate(() => window.shared)).toEqual([]);
    await page.evaluate(() => {
      navigator.share = undefined;
    });
    // The Markdown list uses quick add's syntax, so pasting it back recreates the task. The task is a heading without
    // a percentage, because the percentage is worked out from the subtasks. Each subtask is a line.
    await (await menu()).getByRole('menuitem', { name: 'Copy as a Markdown list' }).click();
    await placeSays(page, 'sheet:top', 'Copied as a Markdown list');
    await expect
      .poll(clip)
      .toBe(
        [
          `## Pack the van ${stamp}`,
          '- [x] Load chairs',
          '- [ ] Tables (50%)',
          `- [ ] Sound system @${me.username}`,
          '- [ ] Lights',
        ].join('\n'),
      );
    vanCopy = await clip();
    vanId = van.id;
    // The menu links to the task's page in Vikunja, opened in the browser.
    const open = (await menu()).getByRole('menuitem', { name: 'Open in Vikunja' });
    await expect(open).toHaveAttribute('href', `${SERVER}/tasks/${van.id}`);
    await expect(open).toHaveAttribute('target', '_blank');
    await page.click('#d-more');
    // The notes and a comment can be copied as plain text.
    await page.getByRole('button', { name: 'Copy the notes' }).click();
    await placeSays(page, 'sheet:notes', 'Copied the notes');
    await expect.poll(clip).toBe('Bring the long cable\n\nKeys in the office');
    await page.getByRole('button', { name: 'Copy this comment' }).click();
    await placeSays(page, 'sheet:comments', 'Copied the comment');
    await expect.poll(clip).toBe('Van keys are in the office');

    // The project's ⋯ menu shares the open tasks in the list's order, with their open subtasks, and a count of how many are done.
    await page.click('#btn-sheet-close');
    await page.click('#btn-project');
    await page.evaluate(() => {
      window.shared = [];
      navigator.share = async d => {
        window.shared.push(d);
      };
    });
    await page.click('#p-share-text');
    await expect
      .poll(() => page.evaluate(() => window.shared[0]?.text))
      .toBe(
        [
          `PocketSmokeShare${stamp}  5 open · 1 done`,
          `◐ Pack the van ${stamp}  ▰▱▱▱ 38%`,
          '  ◐ Tables 50%',
          `  ○ Sound system · ${my}`,
          '  ○ Lights',
          `○ Order milk ${stamp}`,
          '✓ 1 done',
        ].join('\n'),
      );
    await page.click('#p-copy-md');
    await placeSays(page, 'sheet:top', 'Copied as a Markdown list');
    await expect
      .poll(clip)
      .toBe(
        [
          `# PocketSmokeShare${stamp} · 5 open · 1 done`,
          `- [ ] Pack the van ${stamp}`,
          '  - [ ] Tables (50%)',
          `  - [ ] Sound system @${me.username}`,
          '  - [ ] Lights',
          `- [ ] Order milk ${stamp}`,
        ].join('\n'),
      );
    projectCopy = await clip();
    await expect(page.locator('#p-open-vikunja')).toHaveAttribute('href', `${SERVER}/projects/${proj.id}`);
    await page.click('#btn-sheet-close');
    // Copy beside the project's ⋯ copies the shared text, and says so under the project's title.
    await page.click('#btn-copy');
    await placeSays(page, 'project', 'Copied. Paste it into a message');
    await expect.poll(clip).toBe(await page.evaluate(() => window.shared[0].text));
  });
  /* A copied task can be pasted back. Its Markdown, pasted into quick add's box, makes the same task again with the
     same subtasks, including whether each is done, how far along it is and who is assigned. The percentage is not
     written in the copy, so it is worked out again as 38%. */
  await step('a-tasks-copy-pasted-into-quick-add-makes-the-same-tasks', async () => {
    if (!vanCopy) throw new Error("no copy to paste: the step before didn't get that far");
    const title = `Pack the van ${stamp}`;
    // A task's subtasks in Vikunja as [title, done, progress, assignees] arrays, sorted by title.
    const shape = async id => {
      const subs = [];
      for (const s of (await get(id)).related_tasks?.subtask || []) {
        const t = await get(s.id);
        subs.push([t.title, t.done, Math.round(t.percent_done * 100), (t.assignees || []).map(u => u.username).join()]);
      }
      return JSON.stringify(subs.sort());
    };
    await refreshToday(); // Today is where the box adds a task, not a subtask
    // A project's copy starts with a heading with one #, which is the list's name. It is left out, and a chip says so.
    // The open tasks are read, each with its open subtasks. The test does not send this copy, because it would create the same tasks again.
    await page.fill('#in-capture', projectCopy);
    await expect(
      page.locator('#cap-chips .chip', { hasText: 'The # line is the list’s name, so it is left out' }),
    ).toBeVisible();
    if (!(await page.textContent('#cap-chips')).includes('2 tasks + 3 subtasks'))
      throw new Error("chips for a project's copy: " + (await page.textContent('#cap-chips')));
    await page.fill('#in-capture', vanCopy);
    await expect(page.locator('#cap-nest')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#cap-chips .chip[data-kind=done]')).toHaveText('1 will be added as done');
    if (!(await page.textContent('#cap-chips')).includes('1 task + 4 subtasks'))
      throw new Error('chips: ' + (await page.textContent('#cap-chips')));
    await page.click('#f-capture .go');
    await expect(page.locator(`#view ${cardOf(title)} > .card-head > .ring .n`)).toHaveText('1/4', { timeout: 20000 });
    await synced(page);
    const twin = ((await (await api('/tasks?q=' + encodeURIComponent(title))).json()).items || []).find(
      x => x.title === title && x.id !== vanId,
    );
    if (!twin) throw new Error('no second task titled ' + title);
    const made = [...((await get(twin.id)).related_tasks?.subtask || []), twin];
    try {
      if ((await shape(twin.id)) !== (await shape(vanId)))
        throw new Error(`the copy's subtasks ${await shape(twin.id)}, the original's ${await shape(vanId)}`);
      await expect.poll(async () => Math.round((await get(twin.id)).percent_done * 100)).toBe(38);
    } finally {
      for (const t of made) await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });

  // ---- Instant feel: a tab opens at once with its last saved copy, and a change looks like it is waiting only after a few seconds ----
  await step('a-tab-opens-at-once-with-its-last-copy-then-changes-in-place', async () => {
    const t = await make(`Instant ${stamp}`, { due_date: todayAt(23) });
    await refreshToday();
    await expect(page.locator(rowOf(`Instant ${stamp}`))).toBeVisible();
    await page.click('nav.tabs a[data-tab=projects]');
    await page.click('.tree .row .body');
    await expect(page.locator('#btn-project')).toBeVisible();
    await api('/tasks/' + t.id, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ title: `Instant renamed ${stamp}` }),
    });
    // Today's lists answer late. Meanwhile Pocket shows the saved copy, with no grey rows.
    let answer;
    const late = new Promise(ok => {
      answer = ok;
    });
    const slow = async r => {
      await late;
      await r.fallback();
    };
    await page.route(/\/api\/v2\/tasks\?/, slow);
    try {
      await page.click('nav.tabs a[data-tab=today]');
      await expect(page.locator(rowOf(`Instant ${stamp}`))).toBeVisible();
      await expect(page.locator('#view .skel-row')).toHaveCount(0);
      await page.locator(rowOf(`Instant ${stamp}`)).evaluate(el => {
        el.dataset.mark = 'kept';
      });
      await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'true');
      // When loading takes more than a second, a line under the header says it is loading. The line is not placed over the rows.
      await expect(page.locator('#behind')).toBeVisible();
    } finally {
      answer();
      await page.unroute(/\/api\/v2\/tasks\?/, slow);
    }
    // The change appears in place, in the same row and not in a row that was drawn again.
    await expect(page.locator(`[data-mark="kept"] .title > span:not(.sr)`)).toHaveText(`Instant renamed ${stamp}`, {
      timeout: 15000,
    });
    await expect(page.locator('#behind')).toBeHidden();
    await expect(page.locator('#view[aria-busy]')).toHaveCount(0);
  });

  await step('a-change-shows-at-once-and-looks-waiting-only-after-a-few-seconds', async () => {
    let send;
    const sending = new Promise(ok => {
      send = ok;
    });
    const hold = async r => {
      if (r.request().method() === 'POST') await sending;
      await r.fallback();
    };
    await page.route('**/v2/projects/*/tasks', hold);
    try {
      await page.fill('#in-capture', `Waits ${stamp}`);
      await page.press('#in-capture', 'Enter');
      // The task appears on Today at once, as it will finally look. For the first few seconds there is no dotted
      // waiting tick and the header's refresh button does not show a waiting state.
      const row = page.locator(`.row.pending:has(.title:has-text("Waits ${stamp}"))`);
      await expect(row).toBeVisible();
      await later(2000);
      await expect(row).not.toHaveClass(/\bwaits\b/);
      await expect(row.locator('.check.wait')).toHaveCount(0);
      await expect(page.locator('#btn-refresh.waits')).toHaveCount(0);
      // After that it looks like it is waiting.
      await later(1000);
      await expect(row).toHaveClass(/\bwaits\b/);
      await expect(row.locator('.check.wait')).toHaveCount(1);
      await expect(page.locator('#btn-refresh.waits')).toBeVisible();
    } finally {
      send();
      await page.unroute('**/v2/projects/*/tasks', hold);
    }
    await expect(page.locator(`.row:not(.pending):has(.title:has-text("Waits ${stamp}"))`)).toBeVisible({
      timeout: 15000,
    });
    await expect(page.locator('#btn-refresh.waits')).toHaveCount(0);
    await synced(page);
  });

  /* The stacked card. A task with open subtasks is a collapsed card on Today. The header shows the parent's ring with
     its count inside, then the title, the priority bars and the due time. Under the header is the most urgent open
     subtask: overdue first, then due today, then the earliest date, then List view order. A More button under it
     expands the card in place, and Less collapses it. The subtasks never get separate rows on Today. The card's rows
     act like any other row, so a tick or a swipe applies to that subtask. After a tick, the top row stays until the
     batch clears, then the next row slides up. */
  const listView = async pid =>
    ((await (await api('/projects/' + pid)).json()).views || [])
      .filter(v => v.view_kind === 'list')
      .sort((a, b) => (a.position || 0) - (b.position || 0) || a.id - b.id)[0];
  const placeIn = async (view, pairs) => {
    for (const [t, position] of pairs)
      await api(`/tasks/${t.id}/position`, {
        method: 'PUT',
        headers: json,
        body: JSON.stringify({ project_view_id: view.id, position }),
      });
  };
  const under = async (p, kids) => {
    for (const k of kids)
      await api(`/tasks/${p.id}/relations`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ other_task_id: k.id, relation_kind: 'subtask' }),
      });
  };
  // A collapsed card's top row, and its title as shown on screen, without the extra text for screen readers.
  const stepLine = t => `${cardOf(t)} .step-line`;
  const stepTitle = t => page.locator(`${stepLine(t)} .title > span:not(.sr)`);
  // The titles of a card's rows, top to bottom.
  const cardRows = t => page.locator(`${cardOf(t)} > .card-rows > .row .title > span:not(.sr)`);
  // A parent's ring arc as a percentage. It is the progress worked out from the subtasks (the --ring property).
  const ringPct = sel =>
    page.locator(sel).evaluate(el => Math.round(parseFloat(getComputedStyle(el).getPropertyValue('--ring')) * 100));
  await step('a-task-with-subtasks-is-a-stacked-card-on-today', async () => {
    // Due in the last minute of today, so the card is under Today whenever the test runs.
    const P = await make(`Review the deliveries and restock the café before opening ${stamp}`, {
      due_date: todayAt(23, 59),
      priority: 3,
    });
    const [A, B, C] = [
      await make(`Pocket smoke card A ${stamp}`),
      await make(`Pocket smoke card B ${stamp}`),
      await make(`Pocket smoke card C ${stamp}`, { due_date: todayAt(23, 59) }),
    ];
    const Q = await make(`Pocket smoke card's neighbour ${stamp}`, { due_date: todayAt(23, 59) }); // a plain row next to the card on Today
    await under(P, [A, B, C]);
    await placeIn(await listView(home2), [
      [B, 100],
      [C, 200],
      [A, 300],
    ]); // B, C, A is the order in the List view
    const card = page.locator(cardOf(P.title)),
      line = page.locator(stepLine(P.title)),
      title = stepTitle(P.title),
      ring = card.locator('.card-head > .ring');
    const more = card.locator('.card-more');
    try {
      await toastGone();
      await refreshToday();
      // There is one card, under Today, collapsed on C. C is due today, so it comes before B and A, even though B and A come first in the List view.
      await expect(page.locator(`div:has(> .sec.today) ${cardOf(P.title)}`)).toBeVisible({ timeout: 15000 });
      await expect(card).toHaveAttribute('role', 'group');
      await expect(card).toHaveAttribute('aria-label', P.title);
      await expect.poll(() => card.locator('.card-title').evaluate(el => el.getBoundingClientRect().height)).toBe(48);
      const firstLine = await card.locator('.card-head').evaluate(el => {
        const top = el.getBoundingClientRect().top;
        return [...el.querySelectorAll(':scope > .ring, .card-open > .due')].map(
          x => x.getBoundingClientRect().top - top,
        );
      });
      if (firstLine.some(top => top > 12)) throw new Error('the ring or date moved below the first line');
      await expect(title).toHaveText(C.title);
      await expect(card.locator('.card-rows > .row')).toHaveCount(1);
      for (const k of [A, B, C])
        await expect(page.locator(`.item > .row:has(.title:has-text("${k.title}"))`)).toHaveCount(0);
      // The header has the ring with its count and no separate tick, then the title, the priority bars and the due
      // time. A screen reader announces the count and percentage, the priority and the due time.
      await expect(ring.locator('.n')).toHaveText('0/3');
      await expect(ring).toHaveAttribute('aria-label', `Complete “${P.title}” and its 3 open subtasks`);
      await expect(card.locator('.card-head > .check')).toHaveCount(0);
      await expect(card.locator('.card-head .bars.p3')).toBeVisible();
      await expect(card.locator('.card-head .due')).toHaveText(/\S/);
      await expect(card.locator('.card-head .sr')).toContainText('0 of 3 subtasks done, 0%');
      await expect(card.locator('.card-head .sr')).toContainText('Priority: High');
      await expect(card.locator('.card-head .sr')).toContainText('Due Today');
      await expect(line).toHaveClass(/\bone-line\b/);
      // The project's dot appears once, on the card's header. The top row leaves its own dot out to give its text more
      // space, whereas a plain row next to the card has one.
      await expect(card.locator('.card-open > .dot')).toHaveCount(1);
      await expect(line.locator('.dot')).toHaveCount(0);
      await expect(page.locator(`.item > .row:has(.title:has-text("${Q.title}")) .when .dot`)).toHaveCount(1);
      // Due times are written short, "11p" where the phone writes "11:00 PM", and "11:59p" for "11:59 PM". This applies
      // to the card's header, its row and a plain row. A screen reader announces the time in full.
      const clock = (p, h, m) =>
        p.evaluate(at => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), todayAt(h, m));
      const [at23, at2359] = [await clock(page, 23), await clock(page, 23, 59)];
      if (/PM$/.test(at23) && (shortTime(at23) !== '11p' || shortTime(at2359) !== '11:59p'))
        throw new Error(`${at23} and ${at2359} shorten to ${shortTime(at23)} and ${shortTime(at2359)}`);
      await expect(card.locator('.card-head .due')).toHaveText(shortTime(at2359));
      await expect(line.locator('.when .due')).toHaveText(shortTime(at2359));
      await expect(page.locator(`.item > .row:has(.title:has-text("${Q.title}")) .when .due`)).toHaveText(
        shortTime(at2359),
      );
      await expect(card.locator('.card-head .sr')).toContainText('Today ' + at2359);
      await expect(line.locator('.title')).toContainText('Today ' + at2359);
      // On a phone with a 24-hour clock, the time is written the way that phone writes it, such as "23:59".
      const other = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-GB' }),
        p24 = await other.newPage();
      try {
        await hintSeen(other);
        p24.on('pageerror', e => errors.push(String(e)));
        await signIn(p24, APP, USER, PASSWORD);
        await p24.evaluate(() => {
          location.hash = '#/today';
        });
        const theirs = await clock(p24, 23, 59);
        if (!/^23[:.]59$/.test(theirs)) throw new Error('a browser set to en-GB writes 11:59 PM as ' + theirs);
        await expect(p24.locator(`${cardOf(P.title)} .card-head .due`)).toHaveText(theirs, { timeout: 15000 });
        await expect(p24.locator(`${stepLine(P.title)} .when .due`)).toHaveText(theirs);
      } finally {
        await other.close();
      }
      // A card's row shows its title on at most two lines.
      if ((await card.locator('.card-head').evaluate(el => el.offsetHeight)) > 70)
        throw new Error('the heading is more than two lines');
      if ((await line.evaluate(el => el.offsetHeight)) > 82)
        throw new Error('the top row is more than two lines: ' + (await line.evaluate(el => el.offsetHeight)));
      // The top row is indented one level, so its tick sits under the header's title, as a subtask's tick sits under
      // its parent (a plain row's tick sits 14px in). Each touch target is at least 48px wide over the row's full height:
      // the tick (the whole gutter up to the title), the title, and the assignee slot.
      await line.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      const zones = await line.evaluate(el => {
        const r = el.getBoundingClientRect();
        const name = (x, y) => {
          const b = document.elementFromPoint(x, r.top + y)?.closest('button');
          return b?.matches('.check')
            ? 'tick'
            : b?.matches('.body')
              ? 'title'
              : b?.matches('.claim')
                ? 'slot'
                : String(b?.className);
        };
        const body = el.querySelector(':scope > .body').getBoundingClientRect(),
          slot = el.querySelector(':scope > .claim').getBoundingClientRect();
        // The header's 44px touch strip reaches 6px into the row, which starts right under the 38px header, so the checks start 7px down.
        const want = {
            tick: [r.left + 1, body.left - 1],
            title: [body.left + 1, slot.left - 1],
            slot: [slot.left + 1, r.right - 1],
          },
          top = 7;
        const wrong = [];
        for (const [k, [x0, x1]] of Object.entries(want))
          for (const x of [x0, (x0 + x1) / 2, x1])
            for (const y of [top, r.height / 2, r.height - 2])
              if (name(x, y) !== k) wrong.push(`${k} at ${Math.round(x - r.left)},${Math.round(y)}: ${name(x, y)}`);
        const head = el.closest('.day-card').querySelector('.card-title').getBoundingClientRect();
        return {
          wrong,
          tick: el.querySelector(':scope > .check').getBoundingClientRect().left - r.left,
          under: el.querySelector(':scope > .check').getBoundingClientRect().left - head.left,
          widths: { tick: body.left - r.left, slot: r.right - slot.left },
          height: r.height - top + 1,
        };
      });
      if (zones.wrong.length) throw new Error('taps land elsewhere: ' + zones.wrong.join('; '));
      if (Object.values(zones.widths).some(w => w < 48) || zones.height < 48)
        throw new Error('a touch target is under 48px: ' + JSON.stringify(zones));
      // Today's assignee slot is as wide as "+ me" needs, 74px with 8px of padding before it, on a card's row and a plain
      // row alike. That way whatever comes before it, a time or a dot, ends in one vertical line down the list.
      const slotOf = R =>
        R.evaluate(el => {
          const c = el.querySelector(':scope > .claim'),
            s = getComputedStyle(c),
            w = el.querySelector('.when');
          return {
            min: s.minWidth,
            before: s.paddingLeft,
            width: c.getBoundingClientRect().width,
            when: w ? Math.round((el.getBoundingClientRect().right - w.getBoundingClientRect().right) * 2) / 2 : null,
          };
        });
      const slots = [await slotOf(line), await slotOf(page.locator(`.item > .row:has(.title:has-text("${Q.title}"))`))];
      for (const s of slots)
        if (s.min !== '74px' || s.before !== '8px' || s.width < 74 || s.width > 84)
          throw new Error("Today's slot isn't 74px, with 8px before it: " + JSON.stringify(slots));
      if (slots[0].when === null || slots[0].when !== slots[1].when)
        throw new Error(
          "the time on a card's row and the dot on a plain row don't end in one line: " + JSON.stringify(slots),
        );
      const rowTick = await page
        .locator(`.item > .row:has(.title:has-text("${Q.title}"))`)
        .evaluate(
          el => el.querySelector(':scope > .check').getBoundingClientRect().left - el.getBoundingClientRect().left,
        );
      // The tick sits 10px before the header's title. A subtask's tick is smaller and sits less far in than a plain row's.
      if (Math.abs(zones.under + 10) > 0.5 || zones.tick <= rowTick + 20)
        throw new Error(
          `the top row's tick isn't 10px before the header's title, indented one level:${JSON.stringify(zones)}, a row's at ${rowTick}`,
        );
      // More is a slim tab hanging under the top row, with ⌄ in it. Its touch target runs from the row's bottom edge,
      // 48px down to the next item in the list, and never overlaps the row. Tapping it expands the card in place, with
      // every open subtask in the same order, the top one first. Then a plain ⌃ with no tab, labelled "Show less",
      // collapses it again.
      await expect(more).toHaveAccessibleName('More');
      const foot = () =>
        card.evaluate(el => {
          const m = el.querySelector(':scope > .card-more'),
            row = el.querySelector('.card-rows > .row:last-child').getBoundingClientRect(),
            x = row.left + row.width / 2;
          const hit = y => document.elementFromPoint(x, y)?.closest('.card-more, .row, .day-card, .item');
          const last = !el.closest('.item').nextElementSibling?.matches('.item'),
            tab = getComputedStyle(m.querySelector('.tab'));
          return {
            row: hit(row.bottom - 1)?.matches('.row'),
            from: hit(row.bottom + 1) === m,
            to: hit(row.bottom + 47) === m,
            past: last || hit(row.bottom + 49) !== m,
            tab: tab.backgroundColor,
            corners: tab.borderBottomLeftRadius,
          };
        });
      await card.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      const shut = await foot();
      if (
        !shut.row ||
        !shut.from ||
        !shut.to ||
        !shut.past ||
        shut.tab === 'rgba(0, 0, 0, 0)' ||
        shut.corners === '0px'
      )
        throw new Error('the More footer is wrong: ' + JSON.stringify(shut));
      await more.click();
      await expect(cardRows(P.title)).toHaveText([C.title, B.title, A.title]);
      await expect(more).toHaveAccessibleName('Show less');
      if (await page.isVisible('#sheet')) throw new Error('More opened the task');
      const opened = await foot();
      if (!opened.from || !opened.to || opened.tab !== 'rgba(0, 0, 0, 0)')
        throw new Error('with the card open, the footer is wrong: ' + JSON.stringify(opened));
      await more.click();
      await expect(cardRows(P.title)).toHaveText([C.title]);
      // Ticking the top row marks it done in place, and the card keeps its height. Then the next row comes in and the
      // ring counts the tick. A collapsed card's top row leaves its position a second and a half after the tick, sooner
      // than the batch's three seconds (clearTops in leaving.js), but not at once.
      const h = await card.evaluate(el => el.offsetHeight);
      await line.locator('> .check').click();
      await expect(line).toHaveClass(/\bdone\b/);
      await expect(title).toHaveText(C.title);
      await synced(page);
      if (!(await get(C.id)).done) throw new Error('the task was never marked done');
      if ((await card.evaluate(el => el.offsetHeight)) !== h) throw new Error('the card changed height');
      await later(500);
      await expect(title).toHaveText(C.title);
      await later(1100);
      await expect(title).toHaveText(B.title, { timeout: 400 }); // this is well before the batch's three seconds
      await expect(line).not.toHaveClass(/\bdone\b/);
      await expect(ring.locator('.n')).toHaveText('1/3');
      if ((await card.evaluate(el => el.offsetHeight)) !== h)
        throw new Error('the card changed height as the batch cleared');
      // A plain swipe right on the top row sets that subtask's progress, not its parent's. The ring's percentage follows,
      // (100 + 50 + 0) / 3 = 50%, and is written to the parent task.
      await slideProgress(stepLine(P.title), 50);
      await expect(page.locator('#said')).toHaveText(`Progress of ${B.title} set to 50%`);
      await expect.poll(() => ringPct(`${cardOf(P.title)} > .card-head > .ring`)).toBe(50);
      await synced(page);
      if (Math.round((await get(B.id)).percent_done * 100) !== 50)
        throw new Error(`the subtask's progress: ${(await get(B.id)).percent_done}`);
      await expect.poll(async () => Math.round((await get(P.id)).percent_done * 100)).toBe(50);
      // Swiping the header a little to the right springs back and asks nothing.
      await swipeRow(page, `${cardOf(P.title)} > .card-head`, 'back', { one: true });
      await page.waitForTimeout(300);
      if (await page.isVisible('#sheet')) throw new Error('a partial swipe on the header opened something');
      // A full swipe right on the top row marks it done in place, as a tick does, with no gap. Then the next row slides
      // up. It is the last open one, so there is no More button.
      await slideProgress(stepLine(P.title), 100, null, 50);
      await expect(page.locator(`${cardOf(P.title)} .card-rows > .row.done`)).toContainText(B.title);
      await expect(page.locator(`${cardOf(P.title)} .del-gap`)).toHaveCount(0);
      await synced(page);
      await later(3000);
      await expect(title).toHaveText(A.title);
      await expect(more).toHaveCount(0);
      await expect(ring.locator('.n')).toHaveText('2/3');
      await synced(page);
      if (!(await get(B.id)).done || (await get(A.id)).done || (await get(P.id)).done)
        throw new Error('more than that subtask was changed');
      // Tapping the ring with one subtask open asks nothing. It completes that subtask and the parent, and the card stays,
      // marked done. Tapping the ring again reopens both.
      await ring.click();
      await expect(card).toHaveClass(/\bdone\b/);
      if (await page.isVisible('#sheet')) throw new Error('the question was asked with only one open subtask');
      await synced(page);
      await ring.click();
      await expect(card).not.toHaveClass(/\bdone\b/);
      await synced(page);
      if ((await get(P.id)).done || (await get(A.id)).done) throw new Error('tapping the ring again left them done');
    } finally {
      for (const t of [A, B, C, P, Q]) await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });

  /* A card's top row, once done, stays the top row until its wait is over, however long Vikunja takes to answer. The
     bug this guards against was that the next subtask raced the animation, cut it short and pulled up into its spot
     before the "undo" appeared. The card is worked out from what is done, and a subtask is done on the phone the
     moment the swipe is released, so the row is held from then (holdRow in leaving.js), not from Vikunja's answer. The
     test holds back the save's reply and watches a full swipe right frame by frame. The swiped row is the card's only
     row throughout, on the page and gliding all the way off, and the next subtask never appears under the card's
     header. The row shows as done with no gap even though nothing has been answered. Only once Vikunja answers and the
     wait is over does the next subtask slide up. Tapping the tick behaves the same: the row is done in place and the
     next one does not come up until then. */
  await step('a-cards-top-row-done-stays-its-top-row-until-its-wait-is-over-however-late-the-answer', async () => {
    const P = await make(`Pocket smoke top ${stamp}`, { due_date: todayAt(23) });
    const [A, B, C] = [
      await make(`Pocket smoke top A ${stamp}`),
      await make(`Pocket smoke top B ${stamp}`),
      await make(`Pocket smoke top C ${stamp}`),
    ];
    await under(P, [A, B, C]);
    await placeIn(await listView(home2), [
      [A, 100],
      [B, 200],
      [C, 300],
    ]); // A, B, C is the List view order, so A is on top
    const card = page.locator(cardOf(P.title)),
      line = stepLine(P.title),
      title = stepTitle(P.title),
      more = card.locator('.card-more');
    // Holds back the reply to one task's save until answer() is called.
    const heldBack = id => {
      let answer = () => {};
      const answered = new Promise(ok => {
          answer = ok;
        }),
        at = `**/v2/tasks/${id}`;
      const hold = async x => {
        if (x.request().method() !== 'PATCH') return x.fallback();
        await answered;
        await x.fallback();
      };
      return { answer, on: () => page.route(at, hold), off: () => page.unroute(at, hold) };
    };
    const a = heldBack(A.id),
      b = heldBack(B.id);
    // Returns the frames in which the watched row was not the card's only row on the page.
    const gaveWay = frames => frames.filter(s => !s.there || s.at !== 0 || s.rows !== 1);
    try {
      await toastGone();
      await refreshToday();
      await expect(title).toHaveText(A.title, { timeout: 15000 });
      await expect(more).toHaveAccessibleName('More');
      const h = await card.evaluate(el => el.offsetHeight);
      // A full swipe right, while the save stays unanswered.
      await a.on();
      await swipeRow(page, line, 100, { check: () => watchSlide(page, line, 900) });
      let seen = await slideSeen(page);
      if (gaveWay(seen).length)
        throw new Error('the top row gave way while it slid: ' + JSON.stringify(gaveWay(seen).slice(0, 3)));
      if (Math.max(...seen.map(s => s.x)) < 0.9 * seen[0].w)
        throw new Error(`the slide was cut short, at${Math.max(...seen.map(s => s.x))}px of ${seen[0].w}`);
      if (still(seen)) throw new Error('as the top row left, ' + still(seen));
      if (seen.some(s => s.gap)) throw new Error('a gap was drawn for a done row');
      if ((await get(A.id)).done) throw new Error('the save was answered, so nothing was held back');
      await expect(title).toHaveText(A.title);
      await expect(page.locator(line)).toHaveClass(/\bdone\b/);
      await expect(card.getByRole('button', { name: 'Mark not done: ' + A.title, exact: true })).toBeVisible();
      await expect(card.locator('.card-rows > .row')).toHaveCount(1);
      await expect(more).toHaveAccessibleName('More');
      if ((await card.evaluate(el => el.offsetHeight)) !== h) throw new Error('the card changed height');
      // While the save is unanswered, the row waits as long as it takes. Its wait starts once Vikunja has answered and the row is marked.
      await later(2000);
      await expect(title).toHaveText(A.title);
      // Once Vikunja answers, nothing changes on the card. When the wait is over, the next subtask slides up.
      a.answer();
      await synced(page);
      if (!(await get(A.id)).done) throw new Error('the task was never marked done');
      await expect(title).toHaveText(A.title);
      await expect(page.locator(line)).toHaveClass(/\bdone\b/);
      await later(3000);
      await expect(title).toHaveText(B.title);
      await expect(page.locator(line)).not.toHaveClass(/\bdone\b/);
      // Tapping the tick with the save unanswered marks the row done in place. It is still the card's only row until its wait is over.
      await b.on();
      await watchSlide(page, line, 600);
      await page.locator(line).locator('> .check').click();
      await expect(page.locator(line)).toHaveClass(/\bdone\b/);
      seen = await slideSeen(page);
      if (gaveWay(seen).length)
        throw new Error(
          'after a tick, the top row gave way before Vikunja answered: ' + JSON.stringify(gaveWay(seen).slice(0, 3)),
        );
      if ((await get(B.id)).done) throw new Error('the save was answered, so nothing was held back');
      await expect(title).toHaveText(B.title);
      b.answer();
      await synced(page);
      await expect(title).toHaveText(B.title);
      await later(3000);
      await expect(title).toHaveText(C.title);
      await expect(more).toHaveCount(0); // one open subtask is left, so the card has no More footer
    } finally {
      a.answer();
      b.answer();
      await a.off();
      await b.off();
      for (const t of [A, B, C, P]) await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });

  /* A subtask's ⋯ menu has "Turn into its own task" (ownTask in actions.js). It removes the subtask from under its
     parent, in Vikunja too, on both sides of the relation, and places it right after the parent on the project's list.
     The top of the sheet shows a message with Undo, which puts it back under the parent. The old parent's ring counts
     without it. A task that is not a subtask does not have this menu item. */
  await step('a-subtask-turned-into-its-own-task-and-back', async () => {
    const P = await make(`Pocket smoke own parent ${stamp}`),
      [A, B] = [await make(`Pocket smoke own A ${stamp}`), await make(`Pocket smoke own B ${stamp}`)];
    await under(P, [A, B]);
    await placeIn(await listView(home2), [
      [P, 50000],
      [A, 100],
      [B, 200],
    ]);
    const card = page.locator(`#view ${cardOf(P.title)}`),
      n = card.locator('.card-head > .ring .n'),
      item = page.getByRole('menuitem', { name: 'Turn into its own task' });
    const line = placeLine(page, 'sheet:top'),
      parentLink = page.locator('#d-parent');
    const linked = async () => [
      ((await get(B.id)).related_tasks?.parenttask || []).map(x => x.id),
      ((await get(P.id)).related_tasks?.subtask || []).map(x => x.id).sort((x, y) => x - y),
    ];
    try {
      await toastGone();
      await page.evaluate(id => {
        location.hash = '#/project/' + id;
      }, home2);
      await loaded(page);
      await page.click('#btn-refresh');
      await page.waitForSelector('#btn-refresh:not([disabled])');
      await expect(n).toHaveText('0/2', { timeout: 15000 });
      // The parent task is not a subtask, so its ⋯ menu has no such item.
      await card.locator('.card-head > .card-open').click();
      await expect(ownTitle()).toHaveText(P.title);
      await page.click('#d-more');
      await expect(page.locator('#d-menu')).toBeVisible();
      await expect(item).toHaveCount(0);
      await page.keyboard.press('Escape');
      await page.click('#btn-sheet-close');
      await page.waitForSelector('#sheet', { state: 'hidden' });
      // The subtask's ⋯ menu removes it from under its parent. The top of its sheet says so, and the link to the parent above its title disappears.
      await card.locator(`.row[data-id="${B.id}"] > .body`).click();
      await expect(ownTitle()).toHaveText(B.title);
      await expect(parentLink).toHaveText(P.title);
      await page.click('#d-more');
      await item.click();
      await expect(line).toContainText(`No longer a subtask of “${P.title}”`, { timeout: 15000 });
      await expect(parentLink).toHaveCount(0);
      await synced(page);
      if (JSON.stringify(await linked()) !== JSON.stringify([[], [A.id]]))
        throw new Error(
          "in Vikunja, the subtask's parents and the old parent's subtasks: " + JSON.stringify(await linked()),
        );
      // Undo puts the subtask back under its parent.
      await line.getByRole('button', { name: 'Undo' }).click();
      await expect(parentLink).toHaveText(P.title, { timeout: 15000 });
      await synced(page);
      if (JSON.stringify(await linked()) !== JSON.stringify([[P.id], [A.id, B.id].sort((x, y) => x - y)]))
        throw new Error('after Undo: ' + JSON.stringify(await linked()));
      // Turn it into its own task again and close the sheet. On the list it is now a separate row right after its old
      // parent's card, and the card's ring counts without it.
      await page.click('#d-more');
      await item.click();
      await expect(parentLink).toHaveCount(0, { timeout: 15000 });
      await synced(page);
      await page.click('#btn-sheet-close');
      await page.waitForSelector('#sheet', { state: 'hidden' });
      await expect(n).toHaveText('0/1', { timeout: 15000 });
      await expect(page.locator(`#view .item[data-id="${P.id}"] + .item[data-id="${B.id}"] > .row`)).toHaveCount(1, {
        timeout: 15000,
      });
      await expect(card.locator(`.row[data-id="${B.id}"]`)).toHaveCount(0);
    } finally {
      for (const t of [A, B, P]) await api('/tasks/' + t.id, { method: 'DELETE' });
      await page.evaluate(() => {
        location.hash = '#/today';
      });
      await loaded(page);
    }
  });

  /* An expanded card on Today collapses once it is scrolled off the screen, without moving anything that is still
     visible. Leaving Today collapses it too. */
  await step('an-opened-card-collapses-once-scrolled-away-or-left', async () => {
    const P = await make(`Pocket smoke folding card ${stamp}`, { due_date: todayAt(23) }),
      kids = [];
    for (let i = 1; i <= 3; i++) kids.push(await make(`Pocket smoke folding ${i} ${stamp}`));
    await under(P, kids);
    const card = page.locator(cardOf(P.title)),
      rows = card.locator('.card-rows > .row'),
      more = card.locator('.card-more');
    try {
      await toastGone();
      await refreshToday();
      await expect(card).toBeVisible({ timeout: 15000 });
      await card.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await more.click();
      await expect(rows).toHaveCount(3);
      // Scroll until the card is wholly off the top of the screen, then scroll back.
      await page.evaluate(() => {
        document.getElementById('view').style.paddingBottom = '3000px';
      });
      await page.evaluate(el => scrollBy(0, el.getBoundingClientRect().bottom + 200), await card.elementHandle());
      await expect(rows).toHaveCount(1);
      await page.evaluate(() => {
        document.getElementById('view').style.paddingBottom = '';
      });
      await card.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await expect(more).toHaveAccessibleName('More');
      await more.click();
      await expect(rows).toHaveCount(3);
      await page.click('nav.tabs a[data-tab=projects]');
      await page.click('nav.tabs a[data-tab=today]');
      await expect(rows).toHaveCount(1, { timeout: 15000 });
    } finally {
      await page.evaluate(() => {
        document.getElementById('view').style.paddingBottom = '';
      });
      for (const t of [...kids, P]) await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });

  await step('a-subtask-of-yours-made-today-brings-its-task-an-old-one-doesnt', async () => {
    const me = await (await api('/user')).json(),
      far = new Date(Date.now() + 30 * 864e5).toISOString();
    const P = await make(`Pocket smoke later ${stamp}`, { due_date: far }),
      Q = await make(`Pocket smoke older ${stamp}`, { due_date: far });
    const first = await make(`Pocket smoke later first ${stamp}`),
      mine = await make(`Pocket smoke later mine ${stamp}`),
      old = await make(`Pocket smoke older mine ${stamp}`);
    await under(P, [first, mine]);
    await under(Q, [old]);
    await placeIn(await listView(home2), [
      [first, 100],
      [mine, 200],
    ]);
    for (const t of [mine, old])
      await api(`/tasks/${t.id}/assignees`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ user_id: me.id }),
      });
    /* Makes `old` look as if it was created last week. Vikunja doesn't let a test backdate a task, so the test edits
       the replies to say so. Today's query for tasks created today then leaves it out, as it would for a real old task. */
    const week = new Date(Date.now() - 7 * 864e5).toISOString();
    const aged = async r => {
      const res = await r.fetch(),
        body = await res.json(),
        made = /created/.test(decodeURIComponent(r.request().url()));
      if (Array.isArray(body.items))
        body.items = body.items
          .filter(t => !(made && t.id === old.id))
          .map(t => (t.id === old.id ? { ...t, created: week } : t));
      await r.fulfill({ response: res, json: body });
    };
    await page.route(/\/api\/v2\/tasks\?/, aged);
    try {
      await toastGone();
      await refreshToday();
      const added = 'div:has(> .sec:has-text("Added today, no date"))';
      await expect(page.locator(`${added} ${cardOf(P.title)}`)).toBeVisible({ timeout: 15000 });
      // The top row follows the card's single rule: the first in the List view, since neither subtask has a date. It is
      // not the subtask assigned to the user that brought the card onto Today. The user's subtask is under it, in the expanded card.
      await expect(stepTitle(P.title)).toHaveText(first.title);
      await expect(page.locator(`${cardOf(P.title)} > .card-head > .ring .n`)).toHaveText('0/2');
      await page.locator(`${cardOf(P.title)} .card-more`).click();
      await expect(cardRows(P.title)).toHaveText([first.title, mine.title]);
      await expect(
        page.locator(`${cardOf(P.title)} .card-rows > .row:has(.title:has-text("${mine.title}")) .claim.mine`),
      ).toBeVisible();
      await expect(page.locator(cardOf(Q.title))).toHaveCount(0);
      await expect(page.locator(`.row .title:has-text("${old.title}")`)).toHaveCount(0);
    } finally {
      await page.unroute(/\/api\/v2\/tasks\?/, aged);
      for (const t of [first, mine, old, P, Q]) await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });

  await step('a-subtask-due-today-brings-its-undated-task-and-today-opens-with-it-at-once', async () => {
    const P = await make(`Pocket smoke undated card ${stamp}`),
      X = await make(`Pocket smoke due kid ${stamp}`, { due_date: todayAt(23, 59) }), // due today at any hour
      Y = await make(`Pocket smoke undated kid ${stamp}`);
    await under(P, [X, Y]);
    await placeIn(await listView(home2), [
      [Y, 100],
      [X, 200],
    ]);
    try {
      await toastGone();
      await refreshToday();
      // The card is under Today because of its subtask's date. That subtask, due today, is on top, even though the other comes first in the List view.
      await expect(page.locator(`div:has(> .sec.today) ${cardOf(P.title)}`)).toBeVisible({ timeout: 15000 });
      await expect(stepTitle(P.title)).toHaveText(X.title);
      await expect(page.locator(`.item > .row:has(.title:has-text("${X.title}"))`)).toHaveCount(0);
      // Today opens again at once from its saved copy, with its cards, while the lists answer late.
      await page.click('nav.tabs a[data-tab=projects]');
      await page.locator(stepLine(P.title)).waitFor({ state: 'detached' });
      let answer;
      const late = new Promise(ok => {
        answer = ok;
      });
      const slow = async r => {
        await late;
        await r.fallback();
      };
      await page.route(/\/api\/v2\/tasks\?/, slow);
      try {
        await page.click('nav.tabs a[data-tab=today]');
        await expect(stepTitle(P.title)).toHaveText(X.title);
        await expect(page.locator(`${stepLine(P.title)} .claim`)).toBeVisible();
        await expect(page.locator('#view .skel-row')).toHaveCount(0);
        await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'true');
      } finally {
        answer();
        await page.unroute(/\/api\/v2\/tasks\?/, slow);
      }
      await loaded(page);
      await expect(stepTitle(P.title)).toHaveText(X.title);
    } finally {
      for (const t of [X, Y, P]) await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });

  await step('a-long-title-with-no-spaces-doesnt-widen-the-page', async () => {
    const long = `Unbroken${'x'.repeat(120)}${stamp}`;
    const proj = await (
      await api('/projects', { method: 'POST', headers: json, body: JSON.stringify({ title: long }) })
    ).json();
    createdProjects.push(proj.id);
    await make(long, { due_date: todayAt(23) }, proj.id);
    // Finds elements on screen that reach past the right edge. It skips text inside a one-line title, which is cut short.
    const past = () =>
      page.evaluate(() => {
        const w = document.documentElement.clientWidth;
        return [...document.querySelectorAll('#app *, #sheet *')]
          .filter(
            el =>
              el.offsetParent !== null &&
              el.getBoundingClientRect().right > w + 1 &&
              !el.parentElement.closest('.one-line .title, .card-title'),
          )
          .map(
            el =>
              el.tagName.toLowerCase() +
              (el.id ? '#' + el.id : '') +
              (typeof el.className === 'string' && el.className ? '.' + el.className : ''),
          )
          .slice(0, 3);
      });
    await refreshToday();
    await expect(page.locator(rowOf(long))).toBeVisible();
    expect(await past(), 'past the edge on Today').toEqual([]);
    // The title stays on one line and is cut short with "…".
    const cut = await page
      .locator(`${rowOf(long)} .title`)
      .evaluate(el => [el.scrollWidth > el.clientWidth, getComputedStyle(el).textOverflow, el.offsetHeight]);
    if (!cut[0] || cut[1] !== 'ellipsis' || cut[2] > 30)
      throw new Error('the title is not cut short on one line: ' + cut);
    await page.evaluate(id => {
      location.hash = '#/project/' + id;
    }, proj.id);
    await page.click('#btn-project', { timeout: 15000 });
    await expect(page.locator('#p-sharing')).toBeVisible();
    await page.waitForTimeout(300); // wait for the sheet to slide in
    expect(await past(), "past the edge in the project's sheet").toEqual([]);
    await page.click('#btn-sheet-close');
    await page.click(`${rowOf(long)} > .body`);
    await expect(ownTitle()).toHaveText(long);
    await page.waitForTimeout(300);
    expect(await past(), "past the edge in the task's sheet").toEqual([]);
    // Tapping the title replaces it with a box to edit it in, in the same place and no wider.
    await ownTitle().click();
    await expect(page.locator('#d-title')).toBeFocused();
    expect(await past(), 'past the edge while the title is edited').toEqual([]);
    await page.press('#d-title', 'Escape');
    await expect(page.locator('#d-title')).toHaveCount(0);
    await page.click('#btn-sheet-close');
  });

  // ---- A long project: rows drawn in batches, Done's latest 100, the saved copy, and opening on it ----
  /* A long project created through the API: 80 open tasks, more than a screen draws at once, and 105 done tasks,
     more than Done shows at once. */
  const big = {},
    word = `Longlist${stamp}`;
  const bigRows = () => page.locator('#view .list').first().locator('.row[data-id]');
  const doneRows = page.locator('#view .done-sec ~ .list .row[data-id]'),
    doneSec = page.locator('#sec-done'),
    moreRow = page.locator('#more-done');
  const ids = loc => loc.evaluateAll(els => els.map(el => +el.dataset.id));
  await step('a-long-screens-rows-are-all-there-once-its-loaded', async () => {
    big.project = await (
      await api('/projects', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ title: `PocketSmokeLong${stamp}` }),
      })
    ).json();
    createdProjects.push(big.project.id);
    const all = [...Array(80)]
      .map((_, i) => [`${word} open ${i + 1}`, {}])
      .concat([...Array(105)].map((_, i) => [`${word} done ${i + 1}`, { done: true }]));
    // SQLite answers some of eight writes made at once with a 500 ("database is locked"), so each is tried again.
    const make = async (title, extra) => {
      for (let n = 0; ; n++) {
        const r = await api(`/projects/${big.project.id}/tasks`, {
          method: 'POST',
          headers: json,
          body: JSON.stringify({ title, ...extra }),
        });
        if (r.ok) return r.json();
        if (r.status < 500 || n === 5) throw new Error(`HTTP ${r.status} creating ${title}`);
        await new Promise(f => setTimeout(f, 300 * (n + 1)));
      }
    };
    const made = [];
    for (let i = 0; i < all.length; i += 8)
      made.push(...(await Promise.all(all.slice(i, i + 8).map(([title, extra]) => make(title, extra)))));
    [big.open, big.done] = [made.slice(0, 80), made.slice(80)];
    await page.click('#btn-refresh'); // so Pocket loads the project
    await page.waitForSelector('#btn-refresh:not([disabled])');
    // The first rows are drawn at once and the rest in batches afterwards, and the screen is marked busy until all are
    // drawn. Once it has loaded, every row is there, read once. The CPU is throttled to 4 times slower, as on a phone,
    // so the rows do arrive in batches.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    let shown;
    try {
      await page.evaluate(id => {
        location.hash = '#/project/' + id;
      }, big.project.id);
      await expect(bigRows().first()).toBeVisible({ timeout: 15000 });
      await loaded(page);
      shown = await ids(bigRows());
    } finally {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      await cdp.detach();
    }
    if (shown.length !== 80 || !shown.includes(big.open.at(-1).id))
      throw new Error(
        `${shown.length} rows once loaded, the last task's ${shown.includes(big.open.at(-1).id) ? '' : 'not '}among them`,
      );
  });
  /* Adding a task, or ticking a row and having it leave with the batch, must not recompute the list's other rows. Each
     time a row is computed, it calls rowSlot (who is assigned) once and rowMeta (what is under its title) twice. The
     test counts those calls on the page while one task is added and one is ticked, among 80 rows. Before, every row was
     recomputed each time the list changed, hundreds of times over for each of these. */
  await step('an-add-or-a-tick-on-a-long-list-asks-nothing-of-its-other-rows', async () => {
    const counting = on =>
      page.evaluate(on => {
        const a = window.Alpine.raw(document.body._x_dataStack[0]),
          W = (window.__asked ||= { n: 0, was: {} });
        for (const k of ['rowSlot', 'rowMeta']) {
          if (on) {
            W.was[k] = a[k];
            a[k] = function (...x) {
              W.n++;
              return W.was[k].apply(this, x);
            };
          } else a[k] = W.was[k];
        }
        const n = W.n;
        W.n = 0;
        return n;
      }, on);
    const t = big.open[3],
      title = `${word} added`;
    let added, ticked, made;
    // Wait until Pocket knows what the user may do in this project and who else can see it. Each is asked of every row
    // once, whenever that information arrives, so it must not be counted.
    await page.waitForFunction(id => id in window.Alpine.$data(document.body).perms, big.project.id);
    await page.evaluate(() => window.Alpine.$data(document.body).loadPeople(true));
    await later(100);
    await counting(true);
    try {
      await page.fill('#in-capture', title);
      await page.press('#in-capture', 'Enter');
      await expect(bigRows()).toHaveCount(81);
      await synced(page);
      await expect(page.locator('#view .row.pending')).toHaveCount(0);
      made = +(await page.locator('#view .row[data-id]', { hasText: title }).getAttribute('data-id'));
      added = await counting(false);
      await counting(true);
      await page.getByRole('button', { name: 'Mark done: ' + t.title, exact: true }).click();
      await synced(page);
      await later(3000);
      await expect(bigRows()).toHaveCount(80);
    } finally {
      ticked = await counting(false);
      // Restore the state for the later tests: reopen the ticked task and delete the added one.
      await api('/tasks/' + t.id, { method: 'PATCH', headers: json, body: JSON.stringify({ done: false }) });
      if (made) await api('/tasks/' + made, { method: 'DELETE' });
      await page.click('#btn-refresh');
      await page.waitForSelector('#btn-refresh:not([disabled])');
      await loaded(page);
    }
    await expect(bigRows()).toHaveCount(80);
    if (added > 20 || ticked > 20)
      throw new Error(
        `the other rows were recomputed ${added} times for an add and ${ticked} for a tick and its batch`,
      );
  });
  /* Done shows the 100 most recently done tasks. Its heading counts all of them, and a row at the end offers the rest.
     Tapping that row shows the rest and the row disappears when none are left. The focus moves to the first row it showed. */
  await step('done-shows-its-latest-100-and-a-row-for-the-rest', async () => {
    await expect(doneSec).toHaveText('Done (105)');
    await doneSec.click();
    await expect(doneRows).toHaveCount(100, { timeout: 15000 });
    await expect(moreRow).toHaveText('Show the last 5');
    await moreRow.click();
    await expect(doneRows).toHaveCount(105);
    await expect(moreRow).toHaveCount(0);
    const shown = await ids(doneRows);
    if (new Set(shown).size !== 105 || big.done.some(t => !shown.includes(t.id)))
      throw new Error('Done shows ' + shown.length + ', not every task made');
    const focus = await page.evaluate(() => +document.activeElement?.closest('.row')?.dataset.id);
    if (!shown.slice(100).includes(focus))
      throw new Error('the focus is on ' + focus + ', not the first row shown by the tap');
  });
  /* A project's saved copy opens Done only if Done is open now, and it keeps Done's count but not its tasks. After
     Done is opened, closed and the project left, the project shows no done rows when the user returns, whether from the
     saved copy or freshly loaded. Done starts again at its latest 100. */
  await step('a-projects-kept-copy-opens-done-only-if-its-open-now', async () => {
    await doneSec.click();
    await expect(doneSec).toHaveAttribute('aria-expanded', 'false');
    await page.click('nav.tabs a[data-tab=today]');
    await expect(page.locator('nav.tabs a[data-tab=today]')).toHaveAttribute('aria-current', 'page');
    await loaded(page);
    // The lists answer late, so Pocket shows the saved copy meanwhile.
    let answer;
    const late = new Promise(ok => {
      answer = ok;
    });
    const slow = async r => {
      await late;
      await r.fallback();
    };
    const lists = new RegExp(`/api/v2/projects/${big.project.id}/(views/\\d+/)?tasks`);
    await page.route(lists, slow);
    try {
      await page.evaluate(id => {
        location.hash = '#/project/' + id;
      }, big.project.id);
      await expect(page.locator(rowById(big.open[0].id))).toBeVisible();
      await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'true');
      await expect(doneSec).toHaveAttribute('aria-expanded', 'false');
      await expect(doneSec).toHaveText('Done (105)');
      if (await page.locator('#view .done-sec ~ .list .row').count()) throw new Error('the copy has done rows');
      const kept = await page.evaluate(
        id => JSON.parse(localStorage.getItem(`pocket.saved.project.${id}.open`)).groups.find(g => g.key === 'done'),
        big.project.id,
      );
      if (kept.tasks.length || kept.count !== 105)
        throw new Error(`the copy keeps ${kept.tasks.length} done tasks, counting ${kept.count}`);
    } finally {
      answer();
      await page.unroute(lists, slow);
    }
    await loaded(page);
    if (await page.locator('#view .done-sec ~ .list .row').count()) throw new Error('done rows are shown once loaded');
    await doneSec.click();
    await expect(doneRows).toHaveCount(100, { timeout: 15000 });
    await expect(moreRow).toHaveText('Show the last 5');
    await doneSec.click();
  });
  /* Search shows the 50 most recently done matches. Its heading counts all of them, and the same kind of row offers 50 more. */
  await step('search-shows-its-latest-50-done-and-a-row-for-more', async () => {
    await page.click('#btn-search');
    await page.fill('#in-search', word);
    const found = page.locator('#view div:has(> .sec:has-text("Done")) .row[data-id]');
    await expect(found).toHaveCount(50, { timeout: 15000 });
    await expect(page.locator('#view .sec:has-text("Done") .n')).toHaveText('105');
    await expect(moreRow.locator('.title')).toHaveText('Show 50 done earlier');
    await expect(moreRow.locator('.note')).toHaveText('55 more not shown');
    await moreRow.click();
    await expect(found).toHaveCount(100);
    await expect(moreRow).toHaveText('Show the last 5');
    await moreRow.click();
    await expect(found).toHaveCount(105);
    await expect(moreRow).toHaveCount(0);
    await page.click('#btn-search-cancel');
  });
  /* Opening Pocket with the sign-in it last confirmed shows the saved screen at once, before Vikunja says who is
     signed in. A change made meanwhile waits and is sent once Vikunja has answered. */
  await step('opens-on-the-kept-screen-before-vikunja-says-whos-signed-in', async () => {
    const t = big.open[0],
      sent = [];
    await page.evaluate(id => {
      location.hash = '#/project/' + id;
    }, big.project.id);
    await expect(page.locator(rowById(t.id))).toBeVisible();
    await loaded(page);
    let answer,
      asked = false;
    const late = new Promise(ok => {
      answer = ok;
    });
    const user = /\/api\/v2\/user(\?|$)/,
      slow = async r => {
        asked = true;
        await late;
        await r.fallback();
      };
    const sends = r => r.method() !== 'GET' && r.url().includes('/v2/') && sent.push(r.url());
    await page.route(user, slow);
    page.on('request', sends);
    try {
      await page.reload();
      await expect.poll(() => asked).toBe(true);
      await expect(page.locator(rowById(t.id))).toBeVisible();
      await page.getByRole('button', { name: 'Mark done: ' + t.title, exact: true }).click();
      await expect(page.locator(rowById(t.id))).toHaveClass(/\bdone\b/);
      await page.waitForTimeout(1000); // give any wrongly sent request time to show up
      if (sent.length) throw new Error('a request was sent before Vikunja said who is signed in: ' + sent);
    } finally {
      answer();
      await page.unroute(user, slow);
    }
    await synced(page);
    page.off('request', sends);
    if (!sent.some(u => u.endsWith('/tasks/' + t.id))) throw new Error('the tick was never sent: ' + sent);
    if (!(await (await api('/tasks/' + t.id)).json()).done) throw new Error('not done in Vikunja');
    await later(3000);
    await page.click('nav.tabs a[data-tab=today]');
    await api('/projects/' + big.project.id, { method: 'DELETE' }); // this removes its tasks from Today for the later tests
  });
  await step('project-sheet-renames-and-deletes', async () => {
    const proj = await (
      await api('/projects', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ title: `PocketSmokeSheet${stamp}` }),
      })
    ).json();
    createdProjects.push(proj.id);
    await page.click('#btn-refresh'); // so Pocket loads the project
    await page.waitForSelector('#btn-refresh:not([disabled])');
    await page.evaluate(id => {
      location.hash = '#/project/' + id;
    }, proj.id);
    await page.click('#btn-project', { timeout: 15000 });
    await page.fill('#p-name', `PocketSmokeSheet${stamp} renamed`);
    await page.press('#p-name', 'Enter');
    await synced(page);
    if ((await (await api('/projects/' + proj.id)).json()).title !== `PocketSmokeSheet${stamp} renamed`)
      throw new Error('the project was not renamed');
    await page.waitForSelector('#p-archive');
    if ((await page.textContent('#p-delete')) !== 'Delete project and its 0 tasks')
      throw new Error('delete button text: ' + (await page.textContent('#p-delete')));
    await page.click('#p-delete');
    await page.waitForFunction(() => location.hash === '#/projects', null, { timeout: 15000 });
    if ((await api('/projects/' + proj.id)).ok) throw new Error('the project is still there');
  });

  await step('projects', async () => {
    await page.click('nav.tabs a[data-tab=projects]');
    await page.click('.tree .row .body');
    await expect(page.locator('#btn-project')).toBeVisible();
  });
  await page.screenshot({ path: `${OUT}/project.png` });
  await step('deep-link-add', async () => {
    await page.goto(APP + '#/add?text=Buy+milk+friday');
    await page.waitForFunction(() => document.querySelector('#in-capture').value === 'Buy milk friday');
  });
  if (errors.length) {
    steps.failed++;
    console.log('FAIL console errors:', errors);
  }
} finally {
  await synced(page, { timeout: 5000 }).catch(() => {}); // wait first for anything Pocket is still sending
  await browser.close();
  for (const id of createdProjects) await api('/projects/' + id, { method: 'DELETE' }); // deleting a project deletes its tasks too
  // Delete anything this run left behind (every title it creates ends with the run's stamp).
  const tasks = await (
    await api('/tasks?q=' + stamp)
  )
    .json()
    .then(d => d.items)
    .catch(() => []);
  for (const t of tasks || [])
    if (t.title.endsWith(String(stamp))) {
      // Try a few times, because Vikunja on SQLite (the local one with DB=sqlite) can answer 500 "database is locked" while busy.
      let r;
      for (let i = 0; i < 5 && !(r = await api('/tasks/' + t.id, { method: 'DELETE' })).ok; i++)
        await new Promise(ok => setTimeout(ok, 500));
      if (!r.ok) console.log(`Could not delete leftover task ${t.id} (HTTP ${r.status})`);
    }
}

steps.end();
