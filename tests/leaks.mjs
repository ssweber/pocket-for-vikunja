// Checks that using Pocket for a while leaves nothing behind. It opens and closes a task's sheet many times, and
// switches between the screens many times. After each, the page must have about as many DOM nodes, Alpine effects,
// timers and event listeners as after a warm-up round. A leak grows with every round, so a small tolerance is enough.
//
//   VIKUNJA_URL=https://tasks.example.com VIKUNJA_USER=... VIKUNJA_PASSWORD=... VIKUNJA_TOKEN=tk_... node tests/leaks.mjs
//   npm run test:local        (starts a local Vikunja with the plugin and runs everything against it)
//
// Creates two projects of its own, one of them for checklists, and deletes them at the end.
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { expect, hintSeen, loaded, signIn, stepper } from './helpers.mjs';

const SERVER = (process.env.VIKUNJA_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.VIKUNJA_TOKEN,
  USER = process.env.VIKUNJA_USER,
  PASSWORD = process.env.VIKUNJA_PASSWORD;
const OUT = process.env.OUT || 'test-results';
if (!SERVER || !TOKEN || !USER || !PASSWORD) {
  console.error('Set VIKUNJA_URL, VIKUNJA_TOKEN, VIKUNJA_USER and VIKUNJA_PASSWORD');
  process.exit(2);
}
const POCKET = process.env.POCKET_URL || SERVER + '/api/v1/plugins/pocket/';
const api = async (path, body, method = body ? 'POST' : 'GET') => {
  for (let i = 0; ; i++) {
    const r = await fetch(SERVER + '/api/v2' + path, {
      method,
      headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body),
    });
    if (r.status === 500 && i < 4) await new Promise(res => setTimeout(res, 300 * (i + 1)));
    else if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status}`);
    else return r.status === 204 ? null : r.json();
  }
};

/* How much each count may grow over the rounds. Chrome's node count grows by about 50 once, the first few times a
   sheet opens. One effect, listener or timer left behind in each round is more than this, and so is one row's nodes. */
const ROUNDS = { sheet: 20, screens: 10 };
const TOLERANCE = { elements: 30, nodes: 100, effects: 5, listeners: 5, timers: 2, frames: 1 };

/* Keeps count of what the page has alive, from before Pocket's own scripts run: timers set and not yet run or
   cleared, animation frames requested and not yet run, and Alpine effects made and not yet released. Alpine releases a
   binding's effect when its element leaves the page, so an effect kept after that is a leak. Alpine keeps no count of
   its own, so this wraps its reactivity engine before Alpine starts. */
const counting = () => {
  const live = (window.__live = { timers: new Set(), frames: new Set(), effects: new Set() });
  const wrap = (set, clear, ids, once) => {
    window[set] = new Proxy(window[set], {
      apply(f, self, [fn, ...rest]) {
        const id = Reflect.apply(
          f,
          self,
          once && typeof fn === 'function'
            ? [
                (...a) => {
                  ids.delete(id);
                  return fn(...a);
                },
                ...rest,
              ]
            : [fn, ...rest],
        );
        ids.add(id);
        return id;
      },
    });
    window[clear] = new Proxy(window[clear], {
      apply(f, self, [id]) {
        ids.delete(id);
        return Reflect.apply(f, self, [id]);
      },
    });
  };
  // A timeout and an interval share their ids, and either clear function clears either.
  wrap('setTimeout', 'clearTimeout', live.timers, true);
  wrap('setInterval', 'clearInterval', live.timers, false);
  wrap('requestAnimationFrame', 'cancelAnimationFrame', live.frames, true);
  document.addEventListener('alpine:init', () => {
    const A = window.Alpine,
      effect = A.effect,
      release = A.release;
    A.setReactivityEngine({
      reactive: A.reactive,
      raw: A.raw,
      effect: callback => {
        const runner = effect(callback);
        live.effects.add(runner);
        return runner;
      },
      release: runner => {
        live.effects.delete(runner);
        return release(runner);
      },
    });
  });
};

await mkdir(OUT, { recursive: true });
const stamp = Date.now();
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
await hintSeen(context);
await context.addInitScript(counting);
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
const steps = stepper(name => page.screenshot({ path: `${OUT}/leaks-fail-${name}.png` })),
  { step, setup } = steps;

/* Everything counted, after a garbage collection. `nodes` and `listeners` are Chrome's own counts, and include
   elements no longer on the page that something still holds. `elements` are the ones on the page. Something that
   ends by itself (a toast's timer, a row's buttons redrawn when late data arrives) can be running, so this counts
   until nothing has changed for a second. */
const sample = async () => {
  await cdp.send('HeapProfiler.collectGarbage');
  const { nodes, jsEventListeners: listeners } = await cdp.send('Memory.getDOMCounters');
  const own = await page.evaluate(() => ({
    elements: document.getElementsByTagName('*').length,
    effects: window.__live.effects.size,
    timers: window.__live.timers.size,
    frames: window.__live.frames.size,
  }));
  return { ...own, nodes, listeners };
};
async function counts() {
  let was = JSON.stringify(await sample()),
    same = 0;
  for (let i = 0; i < 20 && same < 4; i++) {
    await page.waitForTimeout(250);
    const now = JSON.stringify(await sample());
    same = now === was ? same + 1 : 0;
    was = now;
  }
  return JSON.parse(was);
}
// Fails, naming each count that grew by more than its tolerance since `base`.
async function noLeaks(base, rounds) {
  const now = await counts();
  const grew = Object.keys(TOLERANCE)
    .filter(k => now[k] - base[k] > TOLERANCE[k])
    .map(k => `${k} grew by ${now[k] - base[k]} (from ${base[k]} to ${now[k]})`);
  if (grew.length) throw new Error(`after ${rounds} rounds, ${grew.join(', ')}`);
}

const projectName = `Pocket leaks ${stamp}`,
  runName = `Leak checklist ${stamp}`;
let project, checklists;
const tab = async name => {
  await page.click(`nav.tabs a[data-tab=${name}]`);
  await loaded(page);
};
const openProject = async () => {
  await tab('projects');
  await page.click(`.tree .row .body:has-text("${projectName}")`);
  await expect(page.locator('#view').getByText('Leak parent', { exact: true })).toBeVisible();
  await loaded(page);
};
const openSheet = async title => {
  await page.locator('#view').getByText(title, { exact: true }).click();
  await expect(page.locator('#sheet')).toBeVisible();
  await expect(page.locator('#sheet .row.own .title')).toContainText(title);
  await page.click('#btn-sheet-close');
  await expect(page.locator('#sheet')).toBeHidden();
};
// One round of the screens: Today, Projects, a project, Checklists, a checklist, and a search.
const screens = async () => {
  await tab('today');
  await openProject();
  await tab('checklists');
  await page.click(`.cl[data-project="${checklists.id}"] .cl-runs .row .body:has-text("${runName}")`);
  await expect(page.locator('#step-title')).toHaveText('First step');
  await page.click('#btn-search');
  await page.fill('#in-search', String(stamp));
  await expect(page.locator('#view .row .title', { hasText: 'Leak one' })).toBeVisible();
  await page.click('#btn-search-cancel');
  await tab('today');
};

try {
  project = await api('/projects', { title: projectName });
  checklists = await api('/projects', {
    title: `Pocket leak checklists ${stamp}`,
    description: '<p>pocket:checklists</p>',
  });
  const task = (pid, title, extra = {}) => api(`/projects/${pid}/tasks`, { title, ...extra });
  const subtask = (parent, child) =>
    api(`/tasks/${parent.id}/relations`, { other_task_id: child.id, relation_kind: 'subtask' });
  const parent = await task(project.id, 'Leak parent');
  for (const t of ['Leak sub A', 'Leak sub B']) await subtask(parent, await task(project.id, t));
  await task(project.id, 'Leak one ' + stamp, { due_date: new Date(Date.now() + 864e5).toISOString() });
  await task(project.id, 'Leak two');
  // A checklist as Pocket starts one: a task marked as a checklist, with its steps as subtasks.
  const run = await task(checklists.id, runName, { description: '<p>pocket:run</p>' });
  for (const t of ['First step', 'Second step'])
    await subtask(run, await task(checklists.id, t, { description: `<p>pocket:step ${t}</p>` }));

  await setup('sign-in', () => signIn(page, POCKET, USER, PASSWORD));

  await step('opening-and-closing-a-sheet-again-and-again-leaves-nothing-behind', async () => {
    await openProject();
    await openSheet('Leak parent');
    await openSheet('Leak two');
    const base = await counts();
    for (let i = 0; i < ROUNDS.sheet; i++) await openSheet(i % 2 ? 'Leak two' : 'Leak parent');
    await noLeaks(base, ROUNDS.sheet);
  });

  await step('switching-screens-again-and-again-leaves-nothing-behind', async () => {
    await screens();
    const base = await counts();
    for (let i = 0; i < ROUNDS.screens; i++) await screens();
    await noLeaks(base, ROUNDS.screens);
  });

  if (errors.length) {
    steps.failed++;
    console.log('FAIL page errors:', errors);
  }
} finally {
  await browser.close();
  for (const p of [project, checklists]) if (p) await api('/projects/' + p.id, null, 'DELETE').catch(() => {});
}
steps.end();
