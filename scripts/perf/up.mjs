// A Vikunja just for measuring, apart from pocket-dev: containers pocket-perf and pocket-perf-db, on 127.0.0.1:3470.
//
//   node scripts/perf/up.mjs --seed M            a fresh one, seeded (below), with Pocket as committed at HEAD
//   node scripts/perf/up.mjs --at b884d9a        restart only Vikunja, keeping the data, with Pocket as at that commit
//   node scripts/perf/up.mjs --plugin pocket     ... with Pocket from a folder as it is (an unminified build, say)
//   --maxpp 50                                   Vikunja's service.maxitemsperpage (50, its own default)
//
// --at archives that commit's pocket/ (git archive), so edits in the working tree don't move the numbers. --seed fills
// it with user perf / perf-password: a project "Big" (S: 150 open and 500 done, M: 600 and 3,000, L: 2,000 and
// 8,000; a twentieth of the open tasks overdue, a twentieth due in the next 8 days, every twentieth a parent of 3),
// "Errands" with 25, and an API token with every permission for 30 days. Due dates are from the day it's seeded, so
// seed again before measuring on another day. Everything it keeps is in test-results/perf/ (state.json: {base,
// token, scale, projects}).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'test-results', 'perf');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const SEED = arg('seed'), MAXPP = arg('maxpp', '50'), AT = arg('at', 'HEAD');
const PORT = 3470, BASE = `http://127.0.0.1:${PORT}`, NAME = 'pocket-perf', DB = 'pocket-perf-db';
const STATE = join(OUT, 'state.json');

function run(cmd, args, opts = {}){
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stderr || r.stdout}`);
  return r;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(url){ for (let i = 0; i < 90; i++) { try { if ((await fetch(url)).ok) return; } catch {} await sleep(1000); } throw new Error('no ' + url); }
async function call(method, path, body, token){
  const r = await fetch(BASE + '/api/v2' + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body && JSON.stringify(body) });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

// The plugin folder Vikunja loads: one given as it is, or a commit's pocket/.
let plugin = arg('plugin') && resolve(arg('plugin'));
if (!plugin) {
  const sha = run('git', ['-C', ROOT, 'rev-parse', '--short', AT]).stdout.trim();
  plugin = join(OUT, 'plugin-' + sha);
  rmSync(plugin, { recursive: true, force: true }); mkdirSync(plugin, { recursive: true });
  run('git', ['-C', ROOT, 'archive', '-o', join(OUT, 'plugin.tar'), `${sha}:pocket`]);
  run('tar', ['-xf', '../plugin.tar'], { cwd: plugin }); rmSync(join(OUT, 'plugin.tar'));   // relative: Git's tar reads "C:" as a host
}
if (!existsSync(join(plugin, 'main.go'))) throw new Error('no main.go in ' + plugin);

if (SEED) {
  run('docker', ['rm', '-f', NAME, DB], { allowFail: true });
  // Postgres publishes the port; Vikunja joins its network. Data in memory, thrown away with the container.
  run('docker', ['run', '-d', '--name', DB, '-p', `127.0.0.1:${PORT}:3456`, '--tmpfs', '/var/lib/postgresql/data',
    '-e', 'POSTGRES_USER=vikunja', '-e', 'POSTGRES_PASSWORD=vikunja', '-e', 'POSTGRES_DB=vikunja',
    'postgres:16-alpine', '-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off']);
  for (let i = 0; run('docker', ['exec', DB, 'pg_isready', '-h', '127.0.0.1', '-U', 'vikunja', '-d', 'vikunja'], { allowFail: true }).status; i++) {
    if (i > 60) throw new Error('Postgres did not start'); await sleep(500);
  }
  await sleep(1500);                                         // the image's first Postgres restarts once
}
run('docker', ['rm', '-f', NAME], { allowFail: true });
run('docker', ['run', '-d', '--name', NAME, '--network', `container:${DB}`, '-v', `${plugin}:/app/vikunja/plugins/pocket:ro`,
  '-e', `VIKUNJA_SERVICE_PUBLICURL=${BASE}/`, '-e', 'VIKUNJA_SERVICE_SECRET=pocket-perf-only', '-e', 'VIKUNJA_SERVICE_ENABLEREGISTRATION=true',
  '-e', `VIKUNJA_SERVICE_MAXITEMSPERPAGE=${MAXPP}`, '-e', 'VIKUNJA_RATELIMIT_NOAUTHLIMIT=1000',
  '-e', 'VIKUNJA_DATABASE_TYPE=postgres', '-e', 'VIKUNJA_DATABASE_HOST=127.0.0.1', '-e', 'VIKUNJA_DATABASE_USER=vikunja',
  '-e', 'VIKUNJA_DATABASE_PASSWORD=vikunja', '-e', 'VIKUNJA_DATABASE_DATABASE=vikunja', '-e', 'VIKUNJA_FILES_BASEPATH=/tmp/files',
  '-e', 'VIKUNJA_PLUGINS_ENABLED=true', '-e', 'VIKUNJA_PLUGINS_LOADER=yaegi', 'vikunja/vikunja:2.7.0']);
await waitFor(BASE + '/api/v2/info');
const logs = run('docker', ['logs', NAME]);
if (!/pocket: serving/.test(logs.stdout + logs.stderr)) throw new Error('the plugin did not load');
console.log(`Vikunja up with ${plugin}, maxitemsperpage ${(await (await fetch(BASE + '/api/v2/info')).json()).max_items_per_page}`);

if (SEED) {
  const scale = { S: { open: 150, done: 500 }, M: { open: 600, done: 3000 }, L: { open: 2000, done: 8000 } }[SEED];
  if (!scale) throw new Error('--seed S, M or L');
  await call('POST', '/register', { username: 'perf', email: 'perf@example.com', password: 'perf-password' });
  const { token } = await call('POST', '/login', { username: 'perf', password: 'perf-password' });
  const me = await call('GET', '/user', undefined, token);
  const big = await call('POST', '/projects', { title: 'Big' }, token);
  const small = await call('POST', '/projects', { title: 'Errands' }, token);
  const labels = [];
  for (const t of ['orders', 'suppliers', 'shop', 'urgent', 'admin']) labels.push(await call('POST', '/labels', { title: t, hex_color: 'e8a33d' }, token));
  const day = 86400000, now = Date.now();
  const words = 'check order supplier invoice call email ship pack review update fix clean count restock price quote send'.split(' ');
  let n = 0;
  const pick = a => a[(n * 7919 + a.length * 31) % a.length];
  const desc = i => i % 3 ? '' : `<p>${Array.from({ length: 40 }, (_, k) => words[(i + k) % words.length]).join(' ')}.</p><ul><li>${words[i % 16]} first</li><li>then ${words[(i + 5) % 16]}</li></ul>`;
  // Open: 5% overdue, 5% in the next 8 days, 20% later, 70% undated; a tenth carry a label; every 20th is a parent of 3.
  function openTask(i){
    const r = i % 20, t = { title: `${pick(words)} ${pick(words)} #${i}`, description: desc(i), priority: i % 6 === 0 ? (i % 5) + 1 : 0 };
    if (r === 0) t.due_date = new Date(now - (1 + i % 30) * day).toISOString();
    else if (r === 1) t.due_date = new Date(now + (i % 8) * day + 3600000).toISOString();
    else if (r < 6) t.due_date = new Date(now + (10 + i % 120) * day).toISOString();
    return t;
  }
  async function pool(count, make, width = 12){
    let next = 0, done = 0;
    await Promise.all(Array.from({ length: width }, async () => {
      while (next < count) { const i = next++; n++; await make(i); if (++done % 500 === 0) console.log('  ', done, '/', count); }
    }));
  }
  console.log('seeding', SEED, scale);
  const parents = [];
  await pool(scale.open, async i => {
    const t = await call('POST', `/projects/${big.id}/tasks`, openTask(i), token);
    if (i % 10 === 3) await call('POST', `/tasks/${t.id}/labels`, { label_id: labels[i % labels.length].id }, token);
    if (i % 20 === 7) parents.push(t.id);
  });
  for (const p of parents) for (let k = 0; k < 3; k++) {
    const s = await call('POST', `/projects/${big.id}/tasks`, { title: `step ${k + 1} of #${p}` }, token);
    await call('POST', `/tasks/${p}/relations`, { other_task_id: s.id, relation_kind: 'subtask' }, token);
  }
  await pool(scale.done, async i => { await call('POST', `/projects/${big.id}/tasks`, { title: `done ${pick(words)} #${i}`, description: desc(i), done: true }, token); });
  await pool(25, async i => { await call('POST', `/projects/${small.id}/tasks`, { title: `errand ${i}`, due_date: i % 4 ? undefined : new Date(now + i * 3600000).toISOString() }, token); });
  await call('POST', `/projects/${me.settings.default_project_id}/tasks`, { title: 'inbox task', due_date: new Date(now + 2 * 3600000).toISOString() }, token);
  // An API token with every permission: a sign-in's lasts 10 minutes, less than a measuring run.
  const auth = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const routes = await (await fetch(BASE + '/api/v1/routes', { headers: auth })).json();
  const body = JSON.stringify({ title: 'perf ' + now, expires_at: new Date(now + 30 * day).toISOString(), permissions: Object.fromEntries(Object.entries(routes).map(([g, r]) => [g, Object.keys(r)])) });
  let r = await fetch(BASE + '/api/v2/tokens', { method: 'POST', headers: auth, body });
  if (!r.ok) r = await fetch(BASE + '/api/v1/tokens', { method: 'PUT', headers: auth, body });
  const api = await r.json();
  if (!api.token) throw new Error('no API token: ' + r.status + ' ' + JSON.stringify(api).slice(0, 300));
  mkdirSync(OUT, { recursive: true });
  writeFileSync(STATE, JSON.stringify({ base: BASE, token: api.token, scale: SEED, seeded: new Date(now).toISOString(), projects: { big: big.id, small: small.id } }, null, 2));
  console.log('seeded; state in', STATE);
} else if (existsSync(STATE)) console.log('state', readFileSync(STATE, 'utf8'));
