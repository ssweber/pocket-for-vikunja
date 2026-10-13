// Measures what every row costs once a screen is open, against the benchmark Vikunja (up.mjs --runs). It covers a
// checklist screen sitting idle and being swiped, a tick, a swipe, a nudge and an add on a long project, and the start
// of a scroll while a long list is drawn.
//   npm run perf:rows -- <what> [--profile fast] [--runs 3] [--label name]
//     run     a checklist screen (20 and 60 steps, one of each with a step counting down). Measures how many times a
//             second the checklist is computed while the screen sits idle, the main thread's time per second and its
//             longest task, how long the reload every 20 seconds takes, a step's row swiped for 3 seconds and
//             watched frame by frame (the longest wait between two frames at a one-second tick, and away from one),
//             and a tap on that step's tick (until the step is drawn done).
//     list    Big (660 rows) and Errands (25). Measures a tapped tick (from the touch ending to the tick drawn) and a
//             full swipe (how long the page takes to handle the pointer going down, before the row can follow it, then
//             from release to the row moving and to its delete gap being drawn, and the longest wait between two
//             frames of the slide). It also measures the batch clearing (the main thread's time around the rows
//             leaving, and its longest task), a nudge (until the row is highlighted), and two subtasks added from the
//             add box (from Enter until the waiting row is drawn, and until the sent row is drawn).
//     scroll  a touch scroll on Big while its later batches are drawn, after it is drawn, and while its Done section
//             opens. Measures the time from the first touch move being sent to the page receiving it, and to the
//             page having scrolled.
//     counts  counts instead of timing (fast profile, once). It counts the bindings evaluated per row for each action
//             above (using the copy of Alpine with a counter, lib.mjs), what each row asks of the component as Big
//             opens, and the event listeners on a row.
// Every number is the median of the runs with the lowest and highest in brackets, in ms. Results go to
// test-results/perf/results/rows-<what>-<label>.json, with every run. `list` ticks tasks and adds subtasks, so at the
// end it restores them through Vikunja's API: it unticks the tasks and deletes the subtasks.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { arg, loaded, median, OUT, phone, PROFILES, proxyUp, sleep, spread, traced, vikunja } from './lib.mjs';

const WHAT = process.argv[2], NAME = arg('profile', 'fast'), PROFILE = PROFILES[NAME], RUNS = +arg('runs', 3);
if (!PROFILE || !['run', 'list', 'scroll', 'counts'].includes(WHAT)) throw new Error('rows-bench.mjs run|list|scroll|counts [--profile ' + Object.keys(PROFILES).join('|') + '] [--runs 3]');
const proxy = await proxyUp(WHAT === 'counts' ? PROFILES.fast : PROFILE);
const ph = await phone(WHAT === 'counts' ? PROFILES.fast : PROFILE, { counting: WHAT === 'counts' });
const { state, browser } = ph;
if (!state.runs) throw new Error('no runs seeded: node scripts/perf/up.mjs --runs');
const LABEL = arg('label', `${state.pocket || 'folder'}-${WHAT === 'counts' ? 'fast' : NAME}`);
const out = {}, add = (k, v) => (out[k] ||= []).push(v);
const r1 = x => x == null ? null : Math.round(x * 10) / 10;

/* ---------- a checklist screen ---------- */
// The checklist reloads 20 s after Pocket opens and every 20 s after that (core.js). The idle seconds are measured between two reloads.
const pageTime = page => page.evaluate(() => performance.now());
const until = async (page, ms) => sleep(ms - await pageTime(page));
async function runScreen(key){
  const run = state.runs[key], n = run.steps.length;
  const { page } = await ph.page('#/run/' + run.id);
  await page.waitForFunction(n => document.querySelectorAll('#run-steps > .row').length === n && document.getElementById('view').getAttribute('aria-busy') !== 'true', n, { polling: 200, timeout: 120000 });
  // Idle: 10 whole seconds, from one tick of the clock to the tenth tick after it. Count and trace them without sending the page any requests meanwhile.
  await until(page, 26000);                                                  // well past the reload at 20 s, since on a slow phone reading 60 steps again takes a few seconds
  const idle = await traced(browser, page, async () => {
    await page.evaluate(() => { const P = window.__pf; P.stopCount = P.counted(['runView']); P.clock(() => P.stopCount.now.runView.n); });
    await sleep(10500);
    return page.evaluate(() => { const P = window.__pf; P.stopCount(); return P.ticks; });
  });
  // Measure from the clock's first tick to its last in those seconds (the first entry is the effect starting). A phone
  // that needs over a second to process a tick ticks less often than once a second, and `ticks` records how many it managed.
  const seen = idle.out.slice(1, 12), ticks = seen.map(t => t.t), last = ticks.length - 1;
  if (last < 1) throw new Error('the clock ticked ' + ticks.length + ' times');
  const span = (ticks[last] - ticks[0]) / 1000;
  // Time one evaluation of runView on its own, averaged over 200 evaluations.
  const each = await page.evaluate(() => { const a = window.__pf.app(), t = performance.now(); for (let i = 0; i < 200; i++) void a.runView; return (performance.now() - t) / 200; });
  const res = { ticks: last, callsPerSec: r1((seen[last].n - seen[0].n) / span), msPerSec: r1(idle.sum(ticks[0] - 2, ticks[last] - 2) / span), longest: r1(idle.longest(ticks[0] - 2, ticks[last] - 2)),
    layoutPerSec: r1(idle.layout(ticks[0] - 2, ticks[last] - 2) / span), runViewMs: Math.round(each * 1000) / 1000 };
  // The reload at 40 s after Pocket opened. Take the main thread's time over a 6 s window that starts at 38.5 s, minus what idling would take in the same time.
  await until(page, 38500);
  const reload = await traced(browser, page, async () => { const from = await pageTime(page); await sleep(6000); return { from, to: await pageTime(page) }; });
  res.reloadMs = r1(reload.sum(reload.out.from, reload.out.to) - res.msPerSec * (reload.out.to - reload.out.from) / 1000); res.reloadLongest = r1(reload.longest(reload.out.from, reload.out.to));
  // Swipe a step's row back and forth for 3 seconds without stopping, and record the time of each frame and of each clock tick.
  await until(page, 45500);
  const box = await page.evaluate(() => {
    const row = [...document.querySelectorAll('#run-steps > .row:not(.done)')][3]; row.scrollIntoView({ block: 'center' });
    const b = row.getBoundingClientRect(); row.id = 'pf-row'; return { x: b.x + 120, y: b.y + b.height / 2 };
  });
  await sleep(300);
  await page.evaluate(() => { const P = window.__pf; P.ticks = []; P.stopRec = P.record('#pf-row'); });
  await page.mouse.move(box.x, box.y); await page.mouse.down();
  const t0 = Date.now();
  for (let i = 1; Date.now() - t0 < 3200; i++) { await page.mouse.move(box.x + 30 + 25 * (1 - Math.cos(i / 9)), box.y); await sleep(12); }   // moves between 30 and 80 px sideways
  await page.mouse.move(box.x + 3, box.y); await page.mouse.up();
  const sw = await page.evaluate(() => { const P = window.__pf; return { frames: P.stopRec(), ticks: P.ticks.map(t => t.t) }; });
  const moving = sw.frames.filter(f => f[1] > 0), gaps = moving.slice(1).map((f, i) => ({ at: moving[i][0], ms: f[0] - moving[i][0] }));
  // For each one-second tick while the row was swiped sideways, find the longest wait between two frames around it. A
  // tick's time is when the clock's effect ran. If recomputing the screen caused a long wait, that is the end of the wait.
  const near = (g, t) => t > g.at - 20 && t < g.at + g.ms + 20, swiped = sw.ticks.filter(t => t > moving[0][0] + 50 && t < moving.at(-1)[0] - 50);
  const atTick = swiped.map(t => Math.max(0, ...gaps.filter(g => near(g, t)).map(g => g.ms))), away = gaps.filter(g => !sw.ticks.some(t => near(g, t))).map(g => g.ms);
  Object.assign(res, { frame: r1(median(gaps.map(g => g.ms))), frameAtTick: r1(median(atTick)), frameAtTickMost: r1(Math.max(0, ...atTick)), frameAway: r1(Math.max(0, ...away)), ticksSwiped: atTick.length,
    late: gaps.filter(g => g.ms > 25).length, frames: gaps.length });
  // Tap that step's tick. Measure from the touch ending to the step being drawn done, and the main thread's longest task.
  await sleep(600);
  const cb = await boxOf(page, '#pf-row > .check'), stepId = await page.evaluate(() => +document.getElementById('pf-row').dataset.id);
  const tk = await traced(browser, page, async () => {
    await page.evaluate(() => window.__pf.clear());
    const done = page.evaluate(() => { const row = document.getElementById('pf-row'); return window.__pf.when(() => row.matches('.done'), row, { attributes: true, attributeFilter: ['class'] }); });
    await page.touchscreen.tap(cb.x + cb.w / 2, cb.y + cb.h / 2);
    const d = await done, up = await lastEv(page, 'pointerup');
    await idleSync(page); await sleep(400);
    return { up, d };
  });
  Object.assign(res, { stepTick: r1(tk.out.d.drawn - tk.out.up), stepTickLongest: r1(tk.longest(tk.out.up - 5, tk.out.up + 400)) });
  await page.close();
  await vikunja('PATCH', '/tasks/' + stepId, { done: false });               // restore the step for the next run
  return res;
}

/* ---------- a long project ---------- */
// The rows the user can tap now: plain open tasks (not a card, not a subtask) that are on screen and clear of the header and the add box.
const plainRows = page => page.evaluate(() => [...document.querySelectorAll('#view .list > .item > .row')].filter(r => {
  const b = r.getBoundingClientRect(), c = r.querySelector(':scope > .check:not(.no-tick)');
  return c && !c.disabled && !r.matches('.done, .pending, .leaving') && b.top > 140 && b.bottom < innerHeight - 170;
}).map(r => +r.dataset.id));
const rowSel = id => `#view .item > .row[data-id="${id}"]`;
const boxOf = (page, sel) => page.evaluate(sel => { const b = document.querySelector(sel).getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }, sel);
// Resolves when the row has left its list as the batch clears, with the time in the page's time.
const gone = (page, id) => page.evaluate(id => { const row = document.querySelector(`#view .item > .row[data-id="${id}"]`); return window.__pf.when(() => !row.isConnected, document.getElementById('view'), { subtree: true, childList: true }); }, id);
const lastEv = (page, type) => page.evaluate(type => window.__pf.ev[type]?.at(-1)?.t ?? null, type);
const idleSync = page => page.waitForFunction(() => document.documentElement.dataset.sync === 'idle', null, { polling: 100, timeout: 180000 });

async function listScreen(name, pid, undo){
  const { page, cdp } = await ph.page('#/project/' + pid);
  await page.locator('#view .item > .row').first().waitFor();
  await loaded(page); await sleep(7000);                                          // the preload loads the other tabs' copies 2 s after a screen loads
  const rows = await page.evaluate(() => document.querySelectorAll('#view .row').length);
  const ids = await plainRows(page);
  if (ids.length < 6) throw new Error(name + ': only ' + ids.length + ' plain rows in sight');
  const res = { rows };
  // Measure the batch clearing around the moment the row is seen to have left the list. Count whatever the main thread
  // was doing from 400 ms before that to 900 ms after. On a slow phone the task that removes the row from the list
  // started long before it, so tasks that overlap the window count too.
  const clearing = (tr, at) => ({ clearMs: r1(tr.sumOver(at - 400, at + 900)), clearLongest: r1(tr.longestOver(at - 400, at + 900)) });

  // Add a task from the add box. Measure from Enter to the waiting row drawn, to the sent row drawn, and the main thread's time for all of it.
  const addOne = async (k, text) => {
    await page.locator('#in-capture').fill(text);
    await sleep(700);                                                             // wait for the box to read its chips and look up @people
    const tr = await traced(browser, page, async () => {
      await page.evaluate(() => window.__pf.clear());
      const waiting = page.evaluate(() => window.__pf.when(() => !!document.querySelector('#view .row.pending'), document.getElementById('view'), { subtree: true, childList: true }));
      await page.keyboard.press('Enter');
      const w = await waiting, down = await lastEv(page, 'keydown');
      const sent = await page.evaluate(() => window.__pf.when(() => !document.querySelector('#view .row.pending'), document.getElementById('view'), { subtree: true, childList: true }));
      await idleSync(page); await sleep(900);                                     // a task added to the project itself makes the screen redraw once it is sent
      return { down, w, sent, end: await pageTime(page) };
    });
    Object.assign(res, { [k]: r1(tr.out.w.drawn - tr.out.down), [k + 'Longest']: r1(tr.longest(tr.out.down - 5, tr.out.down + 400)), [k + 'Sent']: r1(tr.out.sent.drawn - tr.out.down),
      [k + 'Work']: r1(tr.sum(tr.out.down - 5, tr.out.end)), [k + 'SentLongest']: r1(tr.longest(tr.out.down + 400, tr.out.end)) });
  };
  // 0. Add a task with no row highlighted, so it is a top-level task in the project.
  {
    const title = `perf add0 ${Date.now() % 100000}`;
    await addOne('add0', title);
    const made = await page.evaluate(t => +([...document.querySelectorAll('#view .row[data-id]')].find(r => r.textContent.includes(t))?.dataset.id || 0), title);
    if (made) undo.push(() => vikunja('DELETE', '/tasks/' + made));
  }

  // 1. Tap a tick.
  let id = ids[0], b = await boxOf(page, rowSel(id) + ' > .check');
  undo.push(() => vikunja('PATCH', '/tasks/' + id0, { done: false })); const id0 = id;
  let tr = await traced(browser, page, async () => {
    await page.evaluate(() => window.__pf.clear());
    const ticked = page.evaluate(sel => { const row = document.querySelector(sel); return window.__pf.when(() => row.matches('.leaving, .done'), row, { attributes: true, attributeFilter: ['class'] }); }, rowSel(id));
    const left = gone(page, id);
    await page.touchscreen.tap(b.x + b.w / 2, b.y + b.h / 2);
    const t = await ticked, up = await lastEv(page, 'pointerup');
    const g = await left; await sleep(1000);
    return { up, t, g };
  });
  Object.assign(res, { tick: r1(tr.out.t.drawn - tr.out.up), tickWork: r1(tr.out.t.at - tr.out.up), tickLongest: r1(tr.longest(tr.out.up - 5, tr.out.up + 400)), tickSum: r1(tr.sum(tr.out.up - 5, tr.out.up + 400)) }, clearing(tr, tr.out.g.at));

  // 2. A full swipe with a pointer, watched frame by frame from before the release.
  id = ids[2]; b = await boxOf(page, rowSel(id));
  const id2 = id; undo.push(() => vikunja('PATCH', '/tasks/' + id2, { done: false }));
  tr = await traced(browser, page, async () => {
    await page.evaluate(sel => { const P = window.__pf; P.clear(); P.stopRec = P.record(sel); }, rowSel(id));
    const left = gone(page, id), x = b.x + 90, y = b.y + b.h / 2, far = b.w * 0.62;
    // `press` is how long the page takes to handle the pointer going down, before the row can follow it.
    await page.mouse.move(x, y); const t = Date.now(); await page.mouse.down(); const press = Date.now() - t;
    for (let i = 1; i <= 14; i++) { await page.mouse.move(x + far * i / 14, y); await sleep(14); }
    await sleep(120);
    await page.mouse.up();
    await sleep(900);
    const frames = await page.evaluate(() => window.__pf.stopRec()), up = await lastEv(page, 'pointerup');
    const g = await left; await sleep(1000);
    return { up, frames, g, press };
  });
  {
    const { up, frames, g } = tr.out, after = frames.filter(f => f[0] >= up), x0 = frames.filter(f => f[0] < up).at(-1)?.[1] ?? after[0][1];
    const moved = after.find(f => f[1] !== null && Math.abs(f[1] - x0) > 0.5), gap = after.find(f => f[2]);
    const slide = after.filter(f => f[0] <= (gap ? gap[0] : up + 600)), waits = slide.slice(1).map((f, i) => f[0] - slide[i][0]);
    Object.assign(res, { swipePress: tr.out.press, swipeMoves: moved ? r1(moved[0] - up) : null, swipeGap: gap ? r1(gap[0] - up) : null, swipeFrame: r1(Math.max(0, ...waits)), swipeLate: waits.filter(w => w > 25).length,
      swipeLongest: r1(tr.longest(up - 5, up + 500)), swipeSum: r1(tr.sum(up - 5, up + 500)), swipeClearMs: clearing(tr, g.at).clearMs, swipeClearLongest: clearing(tr, g.at).clearLongest });
  }

  // 3. A nudge: a short, slow downward drag on a row, which highlights the row as the target of the add box.
  id = ids[4]; b = await boxOf(page, rowSel(id) + ' > .body');
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  tr = await traced(browser, page, async () => {
    await page.evaluate(() => window.__pf.clear());
    const lit = page.evaluate(sel => { const item = document.querySelector(sel).parentElement; return window.__pf.when(() => !!item.querySelector('.aimed'), item); }, rowSel(id));
    const x = b.x + b.w / 2, y = b.y + b.h / 2;
    await touch('touchStart', x, y);
    for (let i = 1; i <= 8; i++) { await sleep(40); await touch('touchMove', x, y + 30 * i / 8); }
    await sleep(40); await touch('touchEnd', x, y + 30);
    const l = await lit, up = await lastEv(page, 'touchend');
    await sleep(500);
    return { up, l };
  });
  Object.assign(res, { nudge: r1(tr.out.l.drawn - tr.out.up), nudgeLongest: r1(tr.longest(tr.out.up - 5, tr.out.up + 400)) });

  // 4. Add two subtasks from the add box, targeting that row. The first makes the row a card. The second goes under the highlighted card.
  const parent = id; undo.push(async () => { for (const s of (await vikunja('GET', '/tasks/' + parent)).related_tasks?.subtask || []) await vikunja('DELETE', '/tasks/' + s.id); });
  for (const k of ['add1', 'add2']) await addOne(k, `perf ${k} ${Date.now() % 100000}`);
  await page.close();
  return res;
}

/* ---------- the start of a scroll ---------- */
/* A touch scroll up the page, sent as Chrome's own touch input. The first move is 24 px (past the distance where a
   touch becomes a scroll), then come 11 moves of 14 px, 16 ms apart.
   `heard`: the time from the first move being sent (by this computer's clock, which the page's clock is set from) until
     the page's own listeners receive it. The listener in holdToSlide can stop a scroll, so the page can't scroll until
     the main thread has answered.
   `moved`: the time until the page's own code saw a frame with the page scrolled.
   `shown`: Chrome's own measurement, from the touch move that started the scroll to its first frame on the screen.
     The compositor makes that frame, and it scrolls without the main thread once it is allowed to.
   `busy`: how much longer the main thread stayed in the task it was running when the move was sent (0 means it was free).
   `when`: 'drawing' is Big past its first three screens, while its batches (about a second each) are drawn. 'drawn' is
     once the whole list is there. 'done' is while the rows of its Done section arrive. */
async function scrollStart(when, delay){
  const { page, cdp } = await ph.page('#/today');
  await page.locator('#view .row').first().waitFor(); await loaded(page); await sleep(7000);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  const big = () => page.evaluate(id => { location.hash = '#/project/' + id; }, state.projects.big);
  if (when !== 'drawing') {
    await big(); await page.locator('#sec-done').waitFor(); await loaded(page); await sleep(3000);
    if (when === 'done') {
      // Close Done if a previous run left it open, then scroll to the bottom of the page, where Done is.
      await page.evaluate(() => { const b = document.getElementById('sec-done'); if (b.getAttribute('aria-expanded') === 'true') b.click(); }); await sleep(1500);
      await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); await sleep(1500);
    }
  }
  // Where the touch starts: on a plain row (a task with hundreds of siblings) in the middle of the screen.
  const spot = () => page.evaluate(() => {
    const rows = [...document.querySelectorAll('#view .list > .item > .row:not(.done)')].map(r => r.getBoundingClientRect()).filter(b => b.top > 380 && b.bottom < innerHeight - 170);
    return rows.length ? { x: 195, y: rows[0].top + rows[0].height / 2 } : { x: 195, y: 600 };
  });
  // Ask the page everything it needs before the list starts to draw. While the list draws, a request to the page would wait for a batch to end.
  const tr = await traced(browser, page, async () => {
    await page.evaluate(() => { const P = window.__pf; P.clear(); P.long = []; P.stopRec = P.record('#view'); });
    if (when === 'drawing') {
      await big();
      await page.evaluate(() => new Promise(ok => { const a = window.__pf.app(); window.Alpine.effect(() => { if (a.route.name === 'project' && a.drawTo > 60) ok(); }); }));
    }
    if (when === 'done') await page.evaluate(() => { document.getElementById('sec-done').click(); return window.__pf.when(() => !!document.querySelector('.done-sec ~ .list .row'), document.getElementById('view'), { subtree: true, childList: true }); });
    const { x, y } = await spot(), sends = [];
    await sleep(delay);
    // As a real touch does: start, then move 30 ms later whether or not the page has answered the touch yet.
    const all = [touch('touchStart', x, y)]; await sleep(30);
    for (let i = 1; i <= 12; i++) { sends.push(Date.now()); all.push(touch('touchMove', x, y - 10 - 14 * i)); await sleep(16); }
    all.push(touch('touchEnd', x, y - 10 - 14 * 12)); await Promise.all(all);
    await loaded(page); await sleep(500);
    if (when === 'done') await page.evaluate(() => document.getElementById('sec-done').click());   // close it again, as the next run expects
    return { sends, ...await page.evaluate(() => { const P = window.__pf; return { origin: performance.timeOrigin, moves: P.ev.touchmove || [], frames: P.stopRec(), long: P.long, rows: document.querySelectorAll('#view .row').length }; }) };
  }, ['input', 'benchmark', 'latencyInfo'], false);
  const { sends, origin, moves, frames, long, rows } = tr.out, sent = sends[0] - origin, y0 = frames.filter(f => f[0] < sent).at(-1)?.[3] ?? frames[0][3], moved = frames.find(f => f[0] > sent && f[3] !== y0);
  const first = tr.events.filter(e => e.name === 'EventLatency' && e.args?.event_latency?.event_type === 'FIRST_GESTURE_SCROLL_UPDATE'), b = first.find(e => e.ph === 'b');
  const e = b && tr.events.filter(e => e.name === 'EventLatency' && e.ph === 'e' && e.pid === b.pid && e.id2?.local === b.id2?.local && e.ts >= b.ts).sort((x, y) => x.ts - y.ts)[0];
  const task = long.find(t => t.at <= sent && t.at + t.ms > sent);
  await page.close();
  return { rows, heard: moves.length ? r1(moves[0].now - sent) : null, moved: moved ? r1(moved[0] - sent) : null, shown: b && e ? r1((e.ts - b.ts) / 1000) : null, busy: task ? r1(task.at + task.ms - sent) : 0, events: tr.events };
}

/* ---------- counted, not timed ---------- */
// The component methods and getters that a row and a list call. counted() in lib.mjs counts each one while Big opens.
const ASKED = ['rowRing', 'canTick', 'shownPct', 'rowMeta', 'rowWhen', 'rowSlot', 'isRunTask', 'isStepRow', 'cardOf', 'cardHead', 'cardEntered', 'hintOn', 'rowTitle', 'isGap', 'ringOf', 'claimSlot', 'peopleOf', 'stepRun',
  'canWrite', 'listGroups', 'listBase', 'pendingTasks', 'hiddenRows', 'waitingByTask', 'subSlots', 'subtasks', 'templateSteps', 'runView'];
const fx = (page, reset = true) => page.evaluate(reset => { const r = window.__fx.read(); if (reset) window.__fx.reset(); return r; }, reset);
const flat = c => ({ runs: c.runs, rows: c.rows, most: c.most, cls: c.cls, clsMost: c.clsMost, by: Object.entries(c.by).map(([k, n]) => `${k} ${n}`).join(', ') });
async function counts(){
  const res = {}, undo = [];
  let { page, cdp } = await ph.page('#/today');
  await page.locator('#view .row').first().waitFor(); await loaded(page); await sleep(6000);
  // On Today (506 rows), count after a tick, after its save is answered, and after the batch clears.
  {
    const of = await page.evaluate(() => document.querySelectorAll('#view .row').length), id = (await plainRows(page))[1], b = await boxOf(page, rowSel(id) + ' > .check');
    undo.push(() => vikunja('PATCH', '/tasks/' + id, { done: false }));
    await fx(page);
    const left = gone(page, id);
    await page.touchscreen.tap(b.x + b.w / 2, b.y + b.h / 2); await sleep(40); res['on Today, a tick, at once'] = { ...flat(await fx(page)), of };
    await idleSync(page); await sleep(300); res['on Today, its save answered'] = flat(await fx(page));
    await left; await sleep(800); res['on Today, the batch clearing'] = flat(await fx(page));
    await sleep(1500);
  }
  // Open Big, then count the bindings evaluated and what its rows asked of the component.
  await page.evaluate(names => { window.__fx.reset(); window.__pf.stop = window.__pf.counted(names); }, ASKED);
  await page.evaluate(id => { location.hash = '#/project/' + id; }, state.projects.big);
  await page.locator('#sec-done').waitFor(); await loaded(page); await sleep(3000);
  const rows = await page.evaluate(() => document.querySelectorAll('#view .row').length);
  res['Big opens'] = { ...flat(await fx(page)), of: rows };
  const asked = await page.evaluate(() => window.__pf.stop());
  res.asked = Object.fromEntries(Object.entries(asked).filter(([, c]) => c.n).map(([k, c]) => [k, { n: c.n, perRow: r1(c.n / rows), ms: r1(c.ms) }]));
  // The event listeners on one plain row, counting the row itself and everything inside it.
  const ids = await plainRows(page);
  const { result } = await cdp.send('Runtime.evaluate', { expression: `document.querySelector('${rowSel(ids[1])}')` });
  const tree = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId, depth: -1 });
  res.listeners = { onARow: tree.listeners.length, types: Object.entries(tree.listeners.reduce((m, l) => (m[l.type] = (m[l.type] || 0) + 1, m), {})).map(([k, n]) => `${k} ${n}`).join(', ') };
  // For each action below, count the bindings evaluated: a row touched (no tick), a tick, its save answered, the batch
  // clearing, a full swipe, a nudge, and two adds.
  await sleep(4000); await fx(page);
  let b = await boxOf(page, rowSel(ids[1]) + ' > .body');
  await page.mouse.move(b.x + 200, b.y + 20); await page.mouse.down(); await sleep(200); res['a row touched'] = flat(await fx(page));
  await page.mouse.move(b.x + 200, b.y + 120); await page.mouse.up(); await sleep(300); await fx(page);
  b = await boxOf(page, rowSel(ids[0]) + ' > .check');
  undo.push(() => vikunja('PATCH', '/tasks/' + ids[0], { done: false }));
  let left = gone(page, ids[0]);
  await page.touchscreen.tap(b.x + b.w / 2, b.y + b.h / 2); await sleep(40); res['a tick, at once'] = flat(await fx(page));
  await idleSync(page); await sleep(300); res['its save answered'] = flat(await fx(page));
  await left; await sleep(800); res['the batch clearing'] = flat(await fx(page));
  b = await boxOf(page, rowSel(ids[2]));
  undo.push(() => vikunja('PATCH', '/tasks/' + ids[2], { done: false }));
  left = gone(page, ids[2]);
  await page.mouse.move(b.x + 90, b.y + b.h / 2); await page.mouse.down();
  for (let i = 1; i <= 14; i++) { await page.mouse.move(b.x + 90 + b.w * 0.62 * i / 14, b.y + b.h / 2); await sleep(14); }
  res['a swipe, held'] = flat(await fx(page));
  await page.mouse.up(); await sleep(40); res['a full swipe let go'] = flat(await fx(page));
  await left; await sleep(800); await fx(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  b = await boxOf(page, rowSel(ids[4]) + ' > .body');
  await touch('touchStart', b.x + b.w / 2, b.y + b.h / 2);
  for (let i = 1; i <= 8; i++) { await sleep(40); await touch('touchMove', b.x + b.w / 2, b.y + b.h / 2 + 30 * i / 8); }
  await sleep(40); await touch('touchEnd', b.x + b.w / 2, b.y + b.h / 2 + 30); await sleep(500);
  res['a nudge'] = flat(await fx(page));
  undo.push(async () => { for (const s of (await vikunja('GET', '/tasks/' + ids[4])).related_tasks?.subtask || []) await vikunja('DELETE', '/tasks/' + s.id); });
  for (const k of ['an add (makes a card)', 'an add under a lit card']) {
    await page.locator('#in-capture').fill('perf count ' + Date.now() % 100000); await sleep(800); await fx(page);
    await page.keyboard.press('Enter');
    await page.locator('#view .row.pending').first().waitFor(); await sleep(30); res[k + ', waiting'] = flat(await fx(page));
    await page.locator('#view .row.pending').waitFor({ state: 'detached' }); await idleSync(page); await sleep(400); res[k + ', sent'] = flat(await fx(page));
  }
  // Open a task's sheet with subtasks, and a template's sheet with 20 steps, and count how often each list is built as the sheet opens.
  const sheet = async id => {
    await page.evaluate(() => { window.__pf.stop = window.__pf.counted(['subSlots', 'subtasks', 'templateSteps']); window.__fx.reset(); });
    await page.evaluate(id => window.__pf.app().openTask(id), id); await page.locator('#d-subtasks .row').first().waitFor(); await sleep(1500);
    return { ...flat(await fx(page)), ...Object.fromEntries(Object.entries(await page.evaluate(() => window.__pf.stop())).map(([k, c]) => [k, c.n])) };
  };
  res['a sheet with 3 subtasks'] = await sheet(await page.evaluate(() => +document.querySelector('#view .day-card').dataset.id));
  await page.close(); for (const fn of undo.splice(0)) await fn().catch(e => console.log('not put back:', e.message));
  ({ page } = await ph.page('#/checklists'));
  await page.locator('#view .row').first().waitFor(); await loaded(page); await sleep(3000);
  res['a template of 20 steps, its sheet'] = await sheet(state.template);
  await page.close();
  // A checklist screen sitting idle: count what is evaluated in one second.
  for (const key of ['plain20', 'plain60', 'timed20']) {
    ({ page } = await ph.page('#/run/' + state.runs[key].id));
    const n = state.runs[key].steps.length;
    await page.waitForFunction(n => document.querySelectorAll('#run-steps > .row').length === n, n, { polling: 200 });
    await until(page, 23000); await fx(page); await sleep(10000);
    const c = await fx(page);
    res[`a run of ${n}${key.startsWith('timed') ? ', counting down' : ''}, idle, a second`] = { ...flat(c), runs: Math.round(c.runs / 10), most: Math.round(c.most / 10), clsMost: Math.round(c.clsMost / 10), by: Object.entries(c.by).map(([k, n]) => `${k} ${Math.round(n / 10)}`).join(', ') };
    await page.close();
  }
  return res;
}

const show = (title, rows) => { console.log('\n' + title); console.table(Object.fromEntries(Object.entries(rows).map(([k, runs]) => [k, Object.fromEntries(Object.keys(runs[0]).map(f => [f, spread(runs.map(x => x[f]), 1)]))]))); };
const undo = [];
try {
  if (WHAT === 'run') for (let r = 0; r < RUNS; r++) for (const key of Object.keys(state.runs).filter(k => k.includes(arg('only', '')))) { add(key, await runScreen(key)); console.log(key, JSON.stringify(out[key].at(-1))); }
  if (WHAT === 'list') for (let r = 0; r < RUNS; r++) for (const [name, pid] of [['Big', state.projects.big], ['Errands', state.projects.small]]) {
    try { add(name, await listScreen(name, pid, undo)); } finally { for (const fn of undo.splice(0)) await fn().catch(e => console.log('not put back:', e.message)); }
    console.log(name, JSON.stringify(out[name].at(-1)));
  }
  if (WHAT === 'counts') {
    const res = await counts(), { asked, ...rest } = res;
    out.counts = [res];
    console.log('\nWhat was worked out (runs: bindings; rows: on how many rows; most: on one row; cls: rows whose own class was; clsMost: how often at most)'); console.table(rest);
    console.log('\nWhat the rows asked of the component as Big opened (n: times; perRow; ms: inside it)'); console.table(asked);
  }
  if (WHAT === 'scroll') for (let r = 0; r < RUNS; r++) for (const [when, delays] of [['drawing', [100, 400, 700]], ['drawn', [0]], ['done', [0, 150, 400]]]) {
    const { events, ...res } = await scrollStart(when, delays[r % delays.length]);
    add(when, res); console.log(when, JSON.stringify(res));
    if (process.argv.includes('--events')) for (const e of events.filter(e => e.name === 'EventLatency' && /SCROLL/.test(e.args?.event_latency?.event_type || '')).slice(0, 6)) console.log(JSON.stringify(e).slice(0, 700));
  }
} finally { await ph.close(); proxy.stop(); }

mkdirSync(join(OUT, 'results'), { recursive: true });
writeFileSync(join(OUT, 'results', `rows-${WHAT}-${LABEL}.json`), JSON.stringify({ label: LABEL, what: WHAT, profile: NAME, pocket: state.pocket, runs: out }, null, 2));
if (WHAT !== 'counts') show(`${WHAT}, ${LABEL}: median (least–most) of ${RUNS}, ms`, out);
