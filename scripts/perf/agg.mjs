// A CPU profile's time by function, its own (self) and with what it calls (total): what prof.mjs prints.
//   node scripts/perf/agg.mjs <file.cpuprofile> [how many] [--mine]
// --mine: Pocket's own functions only (in its page), leaving out Alpine's and the browser's.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function report(p, n = 40, mine = false){
  const byId = new Map(p.nodes.map(x => [x.id, x])), parent = new Map();
  for (const x of p.nodes) for (const c of x.children || []) parent.set(c, x.id);
  const dt = new Map(); p.samples.forEach((s, i) => dt.set(s, (dt.get(s) || 0) + (p.timeDeltas[i] || 0)));
  const ours = x => !mine || (/\/pocket\/(index\.html)?(#.*)?$/.test(x.callFrame.url) && x.callFrame.lineNumber > 0);
  const key = x => `${x.callFrame.functionName || '(anon)'} @${x.callFrame.url.split('/').pop().slice(0, 20)}:${x.callFrame.lineNumber + 1}`;
  const self = new Map(), total = new Map();
  for (const [id, t] of dt) {
    const x = byId.get(id); if (ours(x)) self.set(key(x), (self.get(key(x)) || 0) + t);
    const seen = new Set();
    for (let y = id; y != null; y = parent.get(y)) { const z = byId.get(y), k = key(z); if (ours(z) && !seen.has(k)) { seen.add(k); total.set(k, (total.get(k) || 0) + t); } }
  }
  const top = (m, k) => [...m].sort((a, b) => b[1] - a[1]).slice(0, k).map(([f, t]) => `${(t / 1000).toFixed(0).padStart(7)} ms  ${f}`).join('\n');
  return `--- self\n${top(self, 20)}\n--- total (inclusive)\n${top(total, n)}`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, n] = process.argv.slice(2).filter(a => !a.startsWith('--'));
  console.log(report(JSON.parse(readFileSync(file, 'utf8')), +(n || 40), process.argv.includes('--mine')));
}
