// A throwaway Vikunja in Docker with Pocket's plugin loaded straight from this repo.
//
//   npm run dev          start it, then open the printed address and sign in as dev / dev-password
//   npm run test:local   start it and run both test files against it
//
// Edits to pocket/app/ show up on reload; after changing pocket/main.go, run it again. The data lives only as long as
// the container. Stop it with: docker rm -f pocket-dev
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION = process.env.VIKUNJA_VERSION || '2.6.0';
const PORT = process.env.PORT || '3456';
const NAME = 'pocket-dev';
const BASE = `http://127.0.0.1:${PORT}`;
const PLUGIN = fileURLToPath(new URL('../pocket', import.meta.url));

function run(cmd, args, opts = {}){
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args[0]} failed:\n${r.stderr || r.stdout}`);
  return r;
}
async function call(method, path, body, token){
  const r = await fetch(BASE + '/api/v1' + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body && JSON.stringify(body) });
  return r.ok ? r.json() : null;
}

run('docker', ['rm', '-f', NAME], { allowFail: true });
run('docker', ['run', '-d', '--name', NAME, '-p', `127.0.0.1:${PORT}:3456`,
  '-v', `${PLUGIN}:/app/vikunja/plugins/pocket:ro`,
  '-e', `VIKUNJA_SERVICE_PUBLICURL=${BASE}/`, '-e', 'VIKUNJA_SERVICE_SECRET=pocket-dev-only', '-e', 'VIKUNJA_SERVICE_ENABLEREGISTRATION=true',
  '-e', 'VIKUNJA_DATABASE_PATH=/tmp/vikunja.db', '-e', 'VIKUNJA_FILES_BASEPATH=/tmp/files',
  '-e', 'VIKUNJA_PLUGINS_ENABLED=true', '-e', 'VIKUNJA_PLUGINS_LOADER=yaegi',
  `vikunja/vikunja:${VERSION}`]);

for (let i = 0; ; i++) {
  try { if ((await fetch(BASE + '/api/v1/info')).ok) break; } catch {}
  if (i > 60) throw new Error('Vikunja did not start; see: docker logs ' + NAME);
  await new Promise(r => setTimeout(r, 1000));
}
const logs = run('docker', ['logs', NAME]);
if (!/pocket: serving/.test(logs.stdout + logs.stderr)) throw new Error('The plugin did not load:\n' + (logs.stdout + logs.stderr).split('\n').filter(l => /plugin|pocket/i.test(l)).join('\n'));

// Two users and a project they share, so @assignee can be tried.
for (const u of ['dev', 'bob']) await call('POST', '/register', { username: u, email: `${u}@example.com`, password: `${u}-password` });
const { token } = await call('POST', '/login', { username: 'dev', password: 'dev-password' });
const team = await call('PUT', '/projects', { title: 'Team' }, token);
await call('PUT', `/projects/${team.id}/users`, { username: 'bob', permission: 1 }, token);

console.log(`Vikunja ${VERSION}: ${BASE}  (sign in as dev / dev-password)`);
console.log(`Pocket:        ${BASE}/api/v1/plugins/pocket/`);
console.log(`Stop with:     docker rm -f ${NAME}`);

if (process.argv.includes('--test')) {
  const env = { ...process.env, VIKUNJA_URL: BASE, VIKUNJA_TOKEN: token, ASSIGNEE: 'bob', ASSIGNEE_PROJECT: 'Team' };
  const results = ['tests/parse.mjs', 'tests/smoke.mjs'].map(test =>
    run(process.execPath, [fileURLToPath(new URL('../' + test, import.meta.url))], { env, stdio: 'inherit', allowFail: true }).status);
  process.exitCode = results.some(Boolean) ? 1 : 0;
}
