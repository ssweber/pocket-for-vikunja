// How long reading a whole list from the measuring Vikunja (up.mjs) takes through proxy.mjs, at each page size: one page
// after another, or page 1 and then all the rest at once, as Pocket does (allPages, src/js/api.js).
//   node scripts/perf/api-bench.mjs [--rtt 100 --kbps 5000 --gzip] [--per 50,500]
// Lists: Big's open tasks through its List view with subtasks (a project screen), and all its done tasks. A page size
// over Vikunja's max_items_per_page gets that many (up.mjs --maxpp).
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)), OUT = join(HERE, '..', '..', 'test-results', 'perf');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const state = JSON.parse(readFileSync(join(OUT, 'state.json'), 'utf8'));
const pass = ['--port', '3472', ...['rtt', 'kbps'].flatMap(k => arg(k) ? ['--' + k, arg(k)] : []), ...(process.argv.includes('--gzip') ? ['--gzip'] : [])];
const proxy = spawn(process.execPath, [join(HERE, 'proxy.mjs'), ...pass], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(ok => proxy.stdout.once('data', ok));
const PX = 'http://127.0.0.1:3472';
const stats = async () => (await fetch(PX + '/__stats')).json();
const get = async path => { const r = await fetch(PX + '/api/v2' + path, { headers: { Authorization: 'Bearer ' + state.token } }); if (!r.ok) throw new Error(path + ' ' + r.status); return r.json(); };

const views = await get(`/projects/${state.projects.big}/views`);
const list = (views.items || views).find(v => (v.view_kind ?? v.viewKind) === 'list' || v.view_kind === 0);
const TZ = 'UTC';
const lists = {
  'Big open (List view, subtasks)': `/projects/${state.projects.big}/views/${list.id}/tasks?expand=subtasks&filter_timezone=${TZ}&expand=comment_count`,
  'Big done': `/projects/${state.projects.big}/tasks?filter=${encodeURIComponent('done = true')}&sort_by=done_at&order_by=desc&expand=comment_count`,
};
const page = (path, p, per) => get(`${path}&page=${p}&per_page=${per}`);
const ways = {
  // Pocket before 21c4444: one page after another.
  async oneByOne(path, per){ const out = []; for (let p = 1; p <= 400; p++) { const d = await page(path, p, per); out.push(...d.items); if (!d.items.length || p >= (d.total_pages || 1)) break; } return out; },
  // Page 1 says how many there are; the rest at once (allPages).
  async restAtOnce(path, per){ const d = await page(path, 1, per), n = d.total_pages || 1; const rest = await Promise.all(Array.from({ length: n - 1 }, (_, i) => page(path, i + 2, per))); return [...d.items, ...rest.flatMap(x => x.items)]; },
};
const pers = arg('per', '50,500').split(',').map(Number);
const rows = [];
for (const [name, path] of Object.entries(lists)) for (const per of pers) for (const [way, f] of Object.entries(ways)) {
  const times = [];
  let got, s;
  for (let r = 0; r < 3; r++) { await fetch(PX + '/__reset'); const t = Date.now(); got = await f(path, per); times.push(Date.now() - t); s = await stats(); }
  times.sort((a, b) => a - b);
  rows.push({ list: name, per_page: per, way, tasks: got.length, requests: s.api, KB: Math.round(s.apiBytes / 1024), ms: times[1] });
}
proxy.kill();
console.log(`proxy ${pass.slice(2).join(' ') || '(none)'}; scale ${state.scale}; median of 3`);
console.table(rows);
