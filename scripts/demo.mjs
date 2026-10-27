// The README's two GIFs and the guide's clips of single gestures, made from the real app against the local Vikunja of
// `npm run dev`.
//
//   npm run dev          in another terminal; it keeps running
//   npm run demo         writes docs/screenshots/pocket-demo.gif, pocket-checklist.gif and the clips, pocket-<name>.gif
//
// The story is a small café. Alex owns it, and Jamie is the shift lead who opens up. The demo creates both users and
// gives them made-up tasks. Each run replaces alex's tasks and projects.
// The page's clock is fixed at Wednesday 30 September 2026, 10:05, so "Today 10:30 AM" and "2 days ago" read the same
// every time. BROWSER_CHANNEL=msedge|chrome works as it does for the tests. FRAMES=<folder> also saves the GIF's frames
// there.
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import gifenc from 'gifenc';
import { hintSeen } from '../tests/helpers.mjs';
const { GIFEncoder, quantize, applyPalette } = gifenc;

const BASE = (process.env.VIKUNJA_URL || 'http://127.0.0.1:3456').replace(/\/+$/, '');
const APP = BASE + '/api/v1/plugins/pocket/';
const OUT = new URL('../docs/screenshots/', import.meta.url);
const NOW = new Date(2026, 8, 30, 10, 5); // Wednesday 30 September 2026, 10:05, local time
const at = (days, h = 0, m = 0) => {
  const d = new Date(NOW);
  d.setDate(d.getDate() + days);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};
const frames = []; // the frames of the GIF being filmed, as {png, delay}

async function call(method, path, body, token) {
  const form = body instanceof FormData;
  const r = await fetch(BASE + '/api/v2' + path, {
    method,
    body: body && !form ? JSON.stringify(body) : body,
    headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body && !form ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!r.ok && r.status !== 304) throw new Error(`${method} ${path}: HTTP ${r.status} ${await r.text()}`);
  return r.status === 204 || r.status === 304 ? null : r.json(); // 304 means a PATCH changed nothing
}
// Create a demo user on the first run, with a display name.
async function account(username, name) {
  await call('POST', '/register', {
    username,
    email: `${username}@example.com`,
    password: `${username}-password`,
  }).catch(() => {});
  const { token } = await call('POST', '/login', { username, password: `${username}-password` });
  await call('PATCH', '/user/settings/general', { name }, token);
  return { token, user: await call('GET', '/user', null, token) };
}

// ---------- the demo's tasks ----------
const alex = await account('alex', 'Alex Rivera'),
  jamie = await account('jamie', 'Jamie Taylor');
const A = (method, path, body) => call(method, path, body, alex.token);
const proj = {},
  label = {};
/* Put alex's projects, labels and tasks back as the story starts, so each clip films the same café whatever the clips
   before it changed. Inbox becomes the default project again, because a clip ends with the café as the default, and
   everything else is deleted first. */
async function seed() {
  const own = (await A('GET', '/projects')).items.filter(p => p.id > 0 && p.owner?.id === alex.user.id);
  const inbox = own.find(p => p.title === 'Inbox') || (await A('POST', '/projects', { title: 'Inbox' }));
  await A('PATCH', '/user/settings/general', { default_project_id: inbox.id });
  for (const p of own) if (p.id !== inbox.id) await A('DELETE', '/projects/' + p.id);
  for (
    let page = (await A('GET', '/tasks?per_page=100')).items;
    page.length;
    page = (await A('GET', '/tasks?per_page=100')).items
  )
    for (const t of page) await A('DELETE', '/tasks/' + t.id);
  for (const l of (await A('GET', '/labels')).items)
    if (l.created_by?.id === alex.user.id) await A('DELETE', '/labels/' + l.id);
  await A('PATCH', '/projects/' + inbox.id, { title: 'Inbox', hex_color: '' });

  // Three projects. The café holds the checklists, Orders holds the supplier orders, and Home is personal. Below, the café
  // and Orders are shared with Jamie.
  for (const [title, hex_color] of [
    ['Café', '1d6b52'],
    ['Orders', '2563eb'],
    ['Home', 'e07a1f'],
  ])
    proj[title] = await A('POST', '/projects', { title, hex_color });
  await A('PATCH', '/projects/' + proj['Café'].id, {
    description: '<p>The café: opening up, closing down, and the jobs in between.</p><p>pocket:checklists</p>',
  });
  for (const p of ['Café', 'Orders'])
    await A('POST', `/projects/${proj[p].id}/users`, { username: 'jamie', permission: 1 });
  // A task Alex adds goes to the café unless he names another project.
  await A('PATCH', '/user/settings/general', { default_project_id: proj['Café'].id });
  for (const [title, hex_color] of [
    ['suppliers', 'db2777'],
    ['calls', '7c3aed'],
    ['quick', '0891b2'],
  ])
    label[title] = await A('POST', '/labels', { title, hex_color });

  async function task(project, t, { labels = [], subtasks = [], comment, file, assign } = {}) {
    const made = await A('POST', `/projects/${proj[project].id}/tasks`, t);
    for (const l of labels) await A('POST', `/tasks/${made.id}/labels`, { label_id: label[l].id });
    if (assign) await A('POST', `/tasks/${made.id}/assignees`, { user_id: assign.user.id });
    // Create the subtasks in reverse. Vikunja's List view puts a new task at the top, and Pocket shows subtasks in that order.
    for (const [title, done] of [...subtasks].reverse()) {
      const s = await A('POST', `/projects/${proj[project].id}/tasks`, { title, done });
      await A('POST', `/tasks/${made.id}/relations`, { other_task_id: s.id, relation_kind: 'subtask' });
    }
    if (comment) await call('POST', `/tasks/${made.id}/comments`, { comment }, jamie.token);
    if (file) {
      const f = new FormData();
      f.append('files', new Blob([file.text, new Uint8Array(file.size)], { type: 'application/pdf' }), file.name);
      await A('POST', `/tasks/${made.id}/attachments`, f);
    }
    return made;
  }
  await task(
    'Orders',
    {
      title: 'Order oat milk from Riverside Dairy',
      due_date: at(-2, 9),
      priority: 4,
      percent_done: 0.4,
      description: '<p>Two cases a week from October: set it up as a standing order.</p>',
    },
    {
      labels: ['suppliers'],
      comment: '<p>We’re on the last case. Riverside’s cut-off is 2pm for next-day delivery.</p>',
      file: { name: 'riverside-price-list.pdf', text: '%PDF-1.4 demo', size: 184000 },
      subtasks: [
        ['Count what’s left in the fridge', true],
        ['Ask about the October price', false],
        ['Set up the standing order', false],
      ],
    },
  );
  await task('Orders', { title: 'Pay the coffee roaster’s invoice', due_date: at(1) }); // due tomorrow, so it isn't overdue and Today has space for one more task
  await task('Café', { title: 'Post next week’s rota', due_date: at(0, 10, 30), priority: 3 });
  await task(
    'Café',
    { title: 'Call the plumber about the dishwasher', due_date: at(0) },
    { labels: ['calls'], assign: jamie },
  ); // shows Jamie's picture on the row
  await task('Café', { title: 'Pick up change from the bank', due_date: at(0, 15, 30) }, { labels: ['quick'] });
  await task('Café', { title: 'Try the autumn menu with Jamie', due_date: at(1, 14) });
  await task('Café', { title: 'Deep-clean the espresso machine', due_date: at(2), repeat_after: 604800 });
  await task('Home', { title: 'Book the van in for a service', due_date: at(3) });
  await task('Café', {
    title: 'Renew the food hygiene certificate',
    due_date: at(4),
    priority: 2,
    reminders: [{ reminder: at(3, 9) }],
  });
}

// ---------- the browser ----------
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined });
// A phone-sized browser with touch, the fixed clock, and a dot that shows where the touch is.
async function phone({ scale = 2, height = 844 } = {}) {
  const context = await browser.newContext({
    viewport: { width: 390, height },
    deviceScaleFactor: scale,
    hasTouch: true,
    isMobile: true,
  });
  await hintSeen(context); // keeps the one-time hint out of the pictures
  // Alex has hidden the Checklists screen's Getting started card for the café, as anyone who uses it for long has.
  await context.addInitScript(id => {
    try {
      localStorage.setItem('pocket.started.hidden', JSON.stringify({ [id]: true }));
    } catch {}
  }, proj['Café'].id);
  await context.addInitScript(() =>
    addEventListener('DOMContentLoaded', () => {
      // The finger shows before it lands (demoFinger), darkens and shrinks a little while pressed, and fades after it
      // lifts, so a viewer sees where each tap is.
      const dot = Object.assign(document.createElement('div'), { id: 'demo-finger' });
      dot.style.cssText =
        'position:fixed;left:-99px;top:-99px;width:40px;height:40px;margin:-20px 0 0 -20px;border-radius:50%;' +
        'background:rgba(23,32,28,.2);box-shadow:0 0 0 2px rgba(255,255,255,.85);pointer-events:none;z-index:9999;' +
        'opacity:0;transition:opacity .3s,transform .12s,background .12s';
      document.body.append(dot);
      const move = (x, y) => {
        dot.style.left = x + 'px';
        dot.style.top = y + 'px';
      };
      const look = (opacity, scale, shade) =>
        Object.assign(dot.style, { opacity, transform: `scale(${scale})`, background: `rgba(23,32,28,${shade})` });
      window.demoFinger = (x, y) => {
        move(x, y);
        look(1, 1, 0.2);
      };
      // Pointer and touch moves both: a drag's first moves come as pointer moves, and once a hold turns into a drag the
      // browser cancels the pointer, but the touch goes on.
      const at = e => e.touches[0] && move(e.touches[0].clientX, e.touches[0].clientY);
      addEventListener('pointermove', e => move(e.clientX, e.clientY), true);
      addEventListener(
        'touchstart',
        e => {
          at(e);
          look(1, 0.8, 0.4);
        },
        true,
      );
      addEventListener('touchmove', at, true);
      for (const type of ['touchend', 'touchcancel']) addEventListener(type, () => look(0, 1, 0.2), true);
    }),
  );
  const page = await context.newPage();
  await page.clock.setFixedTime(NOW);
  await page.goto(APP);
  await page.waitForSelector('#auth-step:not([hidden])');
  await page.fill('#in-user', 'alex');
  await page.fill('#in-pass', 'alex-password');
  await page.click('#f-pass button[type=submit]');
  await page.waitForSelector('#view .loading', { state: 'detached' });
  await page.waitForTimeout(400);
  const cdp = await context.newCDPSession(page);
  const touch = (type, x, y) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  return { context, page, touch, cdp };
}
const centre = async (page, sel) => {
  const b = await page.locator(sel).first().boundingBox();
  return [b.x + b.width / 2, b.y + b.height / 2];
};

// CLIPS=reschedule,demo makes only those. The names are demo, checklist, reschedule, progress, nudge, people,
// quickadd, list, asks and done.
const want = name => !process.env.CLIPS || process.env.CLIPS.split(',').includes(name);

// ---------- the GIFs ----------
let gif; // the phone being filmed, as {context, page, touch}
// Every frame is in CSS pixels, as Chrome's screencast sends them, so a still and a filmed frame are the same size.
const snap = async (delay = 100) => frames.push({ png: await gif.page.screenshot({ scale: 'css' }), delay });
const hold = ms => {
  frames[frames.length - 1].delay += ms;
};
/* Film what the page draws while `act` runs, then for `ms` more. Chrome sends a frame each time the page changes
   (Page.startScreencast), so motion plays smoothly. Each frame is shown until the next one came, so the GIF plays in
   real time. */
async function film(ms, act = () => {}) {
  const { cdp, page } = gif,
    got = [],
    keep = f => {
      got.push(f);
      cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    };
  const [w, h] = await page.evaluate(() => [innerWidth * devicePixelRatio, innerHeight * devicePixelRatio]);
  cdp.on('Page.screencastFrame', keep);
  const start = Date.now();
  await cdp.send('Page.startScreencast', { format: 'png', maxWidth: w, maxHeight: h });
  await act();
  await page.waitForTimeout(ms);
  await cdp.send('Page.stopScreencast');
  cdp.off('Page.screencastFrame', keep);
  const end = Date.now(),
    at = got.map(f => f.metadata.timestamp * 1000);
  if (frames.length && got.length) hold(Math.max(0, at[0] - start)); // the last frame stays until the page changes
  got.forEach((f, i) =>
    frames.push({ png: Buffer.from(f.data, 'base64'), delay: Math.round((at[i + 1] ?? end) - at[i]) }),
  );
}
// A tap as a viewer can follow it: the finger shows where it will land, presses, lifts, and the screen is filmed for
// `ms` while the tap's change plays out.
async function tap(sel, ms = 600) {
  const { page, touch } = gif;
  await page.locator(sel).first().scrollIntoViewIfNeeded(); // a touch can only tap what is on screen
  const [x, y] = await centre(page, sel);
  await film(ms, async () => {
    await page.evaluate(([x, y]) => window.demoFinger(x, y), [x, y]);
    await page.waitForTimeout(300);
    await touch('touchStart', x, y);
    await page.waitForTimeout(180);
    await touch('touchEnd');
  });
}
/* A finger that shows at (x, y), presses, waits `wait` ms, moves through `path` (offsets from the press, one every
   `stepMs`), rests `rest` ms and lifts, all filmed, and then `ms` more. */
async function drag(x, y, path, { wait = 0, stepMs = 40, rest = 0, ms = 800 } = {}) {
  const { page, touch } = gif;
  await film(ms, async () => {
    await page.evaluate(([x, y]) => window.demoFinger(x, y), [x, y]);
    await page.waitForTimeout(300);
    await touch('touchStart', x, y);
    await page.waitForTimeout(wait);
    for (const [dx, dy] of path) {
      await touch('touchMove', x + dx, y + dy);
      await page.waitForTimeout(stepMs);
    }
    await page.waitForTimeout(rest);
    await touch('touchEnd');
  });
}
// `n` moves in a straight line to (dx, dy), starting from (fx, fy).
const line = (dx, dy, n, fx = 0, fy = 0) =>
  Array.from({ length: n }, (_, i) => [fx + ((dx - fx) * (i + 1)) / n, fy + ((dy - fy) * (i + 1)) / n]);
// A swipe right on `sel` to 50%. It moves sideways at once, or a row on Today held still would lift instead.
async function swipe(sel) {
  const b = await gif.page.locator(sel).boundingBox(),
    to = b.width * 0.3; // 50% is reached at a quarter of the row's width, done at half
  await drag(b.x + 110, b.y + b.height / 2, [[12, 0], ...line(to, 0, 8, 12)], { stepMs: 90, rest: 600, ms: 1600 });
}
// Close the keyboard, and scroll the new row `title` until its middle is `y` px from the top, so the clip ends on
// what was added.
async function showNew(title, y) {
  const { page } = gif;
  await page.locator('#in-capture').blur();
  await film(1200, () =>
    page.locator(`.row:has-text("${title}")`).evaluate((el, y) => {
      const r = el.getBoundingClientRect();
      scrollBy({ top: r.top + r.height / 2 - y, behavior: 'smooth' });
    }, y),
  );
}
/* The guide's clips, each from the same café: one gesture, then a pause on its result. A clip is a square of the
   screen, as wide as the phone, centred `shift` px below the middle of `around` as the clip starts. */
const SQUARE = 390;
// `setup` runs before filming starts, for a clip that opens on another screen or needs more of the story.
async function clip(name, around, shift, act, setup) {
  if (!want(name)) return;
  await seed();
  gif = await phone({ scale: 1.5, height: 760 });
  if (setup) await setup(gif.page);
  const b = await gif.page.locator(around).first().boundingBox(),
    top = Math.round(Math.max(0, Math.min(760 - SQUARE, b.y + b.height / 2 + shift - SQUARE / 2)));
  await snap(1000);
  await act(gif.page);
  hold(1500);
  await gif.context.close();
  await writeGif(`pocket-${name}.gif`, top);
}

// The README's first clip: the bottom of Today, where three ways of recording work fit in one square.
await clip('demo', '#capture', 0, async page => {
  // Swipe right on a task nobody has claimed. Its ring fills to 50%, and "+ me" becomes Alex's initial.
  await swipe('.row:has-text("Post next week")');
  await page.waitForSelector('.row:has-text("Post next week") .claim.mine');
  hold(1000);
  // A ticked row stays in place for 3 seconds, then leaves.
  await tap('.row:has-text("Pick up change from the bank") .check', 3600);
  // Log a job already done. Quick add highlights the words it reads before the task is sent.
  await tap('#in-capture');
  for (const ch of 'x Fixed the dripping tap') {
    await page.keyboard.type(ch);
    await snap(ch === ' ' ? 40 : 75);
  }
  hold(1500);
  await tap('#f-capture .go');
  await film(1500, () => page.locator('#in-capture').blur()); // the box's help goes with the keyboard
});

// ---------- the checklist GIF: opening up the café, with the checklist's row and ring, the square step boxes and the timed steps ----------
/* Create a template in the café the way Pocket does. It has the label "template", its steps are marked done, then the
   template is marked done. A step is a title, or [title, description] for a step with notes or asks. */
async function template(title, steps) {
  const tplLabel =
    (await A('GET', '/labels')).items.find(l => l.title === 'template') ||
    (await A('POST', '/labels', { title: 'template' }));
  const t = await A('POST', `/projects/${proj['Café'].id}/tasks`, { title });
  for (const step of steps) {
    const [stepTitle, description] = [step].flat();
    const s = await A('POST', `/projects/${proj['Café'].id}/tasks`, { title: stepTitle, description });
    await A('POST', `/tasks/${t.id}/relations`, { other_task_id: s.id, relation_kind: 'subtask' });
    await A('PATCH', '/tasks/' + s.id, { done: true });
  }
  await A('POST', `/tasks/${t.id}/labels`, { label_id: tplLabel.id });
  await A('PATCH', '/tasks/' + t.id, { done: true });
}

if (want('checklist')) {
  await seed();
  // Four steps, so the start sheet's Start button fits on the GIF's screen.
  await template('Opening up', [
    'Turn on the espresso machine {#machine}',
    'Put the croissants in the oven {#croissants}',
    'Dial in the grinder T#20m:machine',
    'Take the croissants out T#18m:croissants',
  ]);
  await template('Closing down', [
    'Backflush the espresso machine',
    'Count the till',
    'Wipe down the tables',
    'Lock up',
  ]);

  gif = await phone({ scale: 1.5, height: 760 });
  const { page } = gif;
  await tap('nav.tabs a[data-tab=checklists]');
  await page.waitForSelector('.cl-start');
  await page.waitForTimeout(300);
  await snap(1400);
  await tap('.cl-tpl:has-text("Opening up") .cl-start');
  await page.waitForSelector('#start-go:not([disabled])');
  await page.waitForTimeout(500);
  await snap(2600); // shows the steps and when each is due
  await tap('#start-go');
  await page.waitForSelector('#step-title');
  await page.waitForTimeout(400);
  await snap(1800); // a message says the checklist has started, with an Undo
  await tap('#step-done');
  await page.waitForSelector('#step-title:text-is("Put the croissants in the oven")');
  await page.waitForTimeout(300);
  await snap(1200);
  await tap('#step-done'); // the next step is the grinder, due in 20m, with the croissants step pinned above it
  await page.waitForSelector('#step-title:text-is("Dial in the grinder")');
  await page.waitForSelector('#run-timers');
  await page.waitForTimeout(400);
  await film(600);
  hold(3600);
  await gif.context.close();
  await writeGif('pocket-checklist.gif');
}

// ---------- the guide's clips ----------
// Hold a task on Today, then move right. The row lifts, the four date chips appear around the finger, and Tomorrow
// lights. On release the row leaves for tomorrow, and a gap says "Moved to Tomorrow" with Undo.
await clip('reschedule', '.row:has-text("Call the plumber")', 0, async page => {
  const b = await page.locator('.row:has-text("Call the plumber")').boundingBox();
  await drag(b.x + b.width * 0.45, b.y + b.height / 2, line(60, 0, 12), { wait: 1000, rest: 600, ms: 2200 });
});
// Swipe right on a task nobody has claimed. The ring in the green space fills to 25%, then 50%. On release the row
// springs back with its tick half filled, and "+ me" becomes Alex's initial.
await clip('progress', '.row:has-text("Post next week")', 0, async page => {
  await swipe('.row:has-text("Post next week")');
  await page.waitForSelector('.row:has-text("Post next week") .claim.mine');
});
// Nudge a row: press it and drag down a little, slowly. The add box moves under the row and adds its first subtask.
await clip('nudge', '.row:has-text("Post next week")', 80, async page => {
  const b = await page.locator('.row:has-text("Post next week")').boundingBox();
  await drag(b.x + 150, b.y + b.height / 2, line(0, 40, 10), { stepMs: 45, ms: 900 });
  if (!(await page.evaluate(() => document.activeElement?.id === 'in-capture'))) await tap('#in-capture');
  for (const ch of 'Check who is off next week') {
    await page.keyboard.type(ch);
    await snap(ch === ' ' ? 40 : 70);
  }
  hold(800);
  await film(1500, () => page.keyboard.press('Enter'));
});
// Hold "+ me". A menu of the people who can see the project opens under the row. Tapping Jamie assigns her.
await clip('people', '.row:has-text("Pick up change")', -60, async page => {
  const [x, y] = await centre(page, '.row:has-text("Pick up change") > .claim');
  await drag(x, y, [], { wait: 900, ms: 900 });
  await tap('.people-menu [role=menuitemcheckbox]:has-text("@jamie")', 1200);
});
// Quick add highlights the words it reads, and the chips under the box show what will be saved.
await clip('quickadd', '#capture', 0, async page => {
  await tap('#in-capture');
  for (const ch of 'Order 6 bags of house blend fri at 9 +orders !3') {
    await page.keyboard.type(ch);
    await snap(ch === ' ' ? 40 : 70);
  }
  hold(1500);
  await tap('#f-capture .go', 900);
  await showNew('Order 6 bags', 560); // above the add box, inside the clip's square
});
// A step that asks for the fridge's temperature and whether its seal is intact. The checklist starts off camera. The
// answers are typed on the step's card, and Done sends them and ticks the step.
await clip(
  'asks',
  '#step-asks',
  40,
  async page => {
    await tap('#step-asks .answer-in');
    for (const ch of '3.5') {
      await page.keyboard.type(ch);
      await snap(120);
    }
    await page.locator('#step-asks .answer-in').blur();
    await tap('#step-asks button:has-text("Yes")', 900);
    await tap('#step-done', 1500);
  },
  async page => {
    await template('Fridge check', [
      ['Check the milk fridge', '<p>pocket:ask Temp: number °C 0..5</p><p>pocket:ask Seal intact: yes-no</p>'],
      'Wipe the door seals',
    ]);
    await page.click('nav.tabs a[data-tab=checklists]');
    await page.click('.cl-tpl:has-text("Fridge check") .cl-start');
    await page.click('#start-go:not([disabled])');
    await page.waitForSelector('#step-asks');
    await page.waitForTimeout(600);
  },
);
// Tick the last task on Today. It leaves, Done today appears under the list and counts it, and tapping Done today
// lists it. The clip is the bottom of the screen, where Done today is.
await clip(
  'done',
  '#capture',
  SQUARE,
  async page => {
    // Scroll to the end before each tap, or Done today's heading is still behind the add box.
    const toEnd = () =>
      film(900, () => page.evaluate(() => scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })));
    await tap('.row:has-text("Renew the food") .check', 3600);
    await toEnd();
    await tap('#sec-donetoday', 300);
    await toEnd();
    await tap('#btn-copy-done', 300);
    await toEnd();
  },
  async page => {
    await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(400);
  },
);
// A pasted list. The pictures under the box show the ways to add it. Picking the last makes it one task, with the
// other lines as its notes, and the new row has the notes icon.
await clip('list', '#capture', 0, async page => {
  await tap('#in-capture');
  await film(900, () => page.fill('#in-capture', 'Restock supplies\n- oat milk\n- syrups\n- cups, 8oz'));
  hold(1200);
  await tap('#cap-chips .list-ways button:has(.sr:text-is("1 task + notes"))', 900);
  hold(1500);
  await tap('#f-capture .go', 900);
  await showNew('Restock supplies', 560);
});
await browser.close();

// ---------- encode the GIF with one palette for all frames, where each frame keeps only the pixels that changed ----------
async function writeGif(name, top = null) {
  /* Browsers show a GIF frame shorter than 20ms for 100ms, so frames filmed 16ms apart would play slowly. Show the frame
     on screen at every 40ms instead (25 frames a second), and join the ticks that show the same frame. */
  const TICK = 40,
    timed = [];
  let t = 0;
  for (const f of frames) timed.push({ f, from: t, to: (t += f.delay) });
  const ticked = [];
  for (let at = 0, i = 0; at < t; at += TICK) {
    while (timed[i].to <= at) i++;
    if (ticked.at(-1)?.png === timed[i].f.png) ticked.at(-1).delay += TICK;
    else ticked.push({ png: timed[i].f.png, delay: TICK });
  }
  frames.splice(0, frames.length, ...ticked);
  // With `top`, each frame is cut to the square from `top` down.
  const images = frames.map(f => {
    const png = PNG.sync.read(f.png),
      [y, h] = top === null ? [0, png.height] : [top, SQUARE],
      row = png.width * 4;
    return {
      data: new Uint8Array(png.data.subarray(y * row, (y + h) * row)), // a copy: gifenc reads a frame from the start of its buffer
      width: png.width,
      height: h,
      delay: f.delay,
    };
  });
  const { width, height } = images[0];
  if (images.some(im => im.width !== width || im.height !== height))
    throw new Error(name + ': frames of different sizes');
  const sample = new Uint8Array(images.length * width * 4 * Math.ceil(height / 8));
  let o = 0;
  for (const im of images)
    for (let row = 0; row < height; row += 8) {
      sample.set(im.data.subarray(row * width * 4, (row + 1) * width * 4), o);
      o += width * 4;
    }
  const palette = quantize(sample.subarray(0, o), 255);
  while (palette.length < 256) palette.push([0, 0, 0]); // the last entry marks an unchanged pixel
  const KEEP = 255;
  const enc = GIFEncoder();
  let prev = null;
  for (const [i, im] of images.entries()) {
    const idx = applyPalette(im.data, palette.slice(0, 255));
    const out = idx.slice();
    if (prev) for (let p = 0; p < out.length; p++) if (idx[p] === prev[p]) out[p] = KEEP;
    enc.writeFrame(out, width, height, {
      palette: i === 0 ? palette : undefined,
      delay: im.delay,
      transparent: !!prev,
      transparentIndex: KEEP,
      dispose: 1,
    });
    prev = idx;
  }
  enc.finish();
  await mkdir(OUT, { recursive: true });
  await writeFile(new URL(name, OUT), enc.bytes());
  const stem = name.replace(/\.gif$/, '');
  if (process.env.FRAMES) {
    await mkdir(process.env.FRAMES, { recursive: true });
    for (const [i, f] of frames.entries())
      await writeFile(`${process.env.FRAMES}/${stem}-${String(i).padStart(3, '0')}-${f.delay}ms.png`, f.png);
  }
  console.log(
    `${name}: ${frames.length} frames, ${(frames.reduce((s, f) => s + f.delay, 0) / 1000).toFixed(1)} s, ${(enc.bytes().length / 1048576).toFixed(2)} MB`,
  );
  frames.length = 0;
}
