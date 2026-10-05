// A throwaway Vikunja in Docker with Pocket's plugin loaded straight from this repo, plus a mock single sign-on
// provider standing in for Cloudron's login.
//
//   npm run dev          start it, then open the printed address and sign in as dev / dev-password, or with "Mock SSO"
//   npm run test:local   start it and run all the test files against it
//
// Edits to pocket/app/ show up on reload; after changing pocket/main.go, run it again. The data lives only as long as
// the containers. Stop them with: docker rm -f pocket-dev pocket-dev-sso
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = process.env.VIKUNJA_VERSION || '2.7.0';
const PORT = process.env.PORT || '3456', SSO_PORT = process.env.SSO_PORT || '8080';
const NAME = 'pocket-dev', SSO = 'pocket-dev-sso';
const BASE = `http://127.0.0.1:${PORT}`;
const PLUGIN = fileURLToPath(new URL('../pocket', import.meta.url));

function run(cmd, args, opts = {}){
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args[0]} failed:\n${r.stderr || r.stdout}`);
  return r;
}
async function call(method, path, body, token){
  const r = await fetch(BASE + '/api/v2' + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body && JSON.stringify(body) });
  return r.ok ? r.json() : null;
}
async function waitFor(url, what){
  for (let i = 0; ; i++) {
    try { if ((await fetch(url)).ok) return; } catch {}
    if (i > 60) throw new Error(`${what} did not start`);
    await new Promise(r => setTimeout(r, 1000));
  }
}

run('docker', ['rm', '-f', NAME, SSO], { allowFail: true });

// The mock provider signs anyone in as "sso". Vikunja joins its network, so both the browser and Vikunja reach the
// provider at the same 127.0.0.1 address, which OpenID Connect needs.
const claims = { sub: 'sso-user', email: 'sso@example.com', preferred_username: 'sso', name: 'SSO User' };
run('docker', ['run', '-d', '--name', SSO, '-p', `127.0.0.1:${PORT}:3456`, '-p', `127.0.0.1:${SSO_PORT}:8080`,
  '-e', 'JSON_CONFIG=' + JSON.stringify({ interactiveLogin: false, tokenCallbacks: [{ issuerId: 'default', tokenExpiry: 3600,
    requestMappings: [{ requestParam: 'grant_type', match: '*', claims }] }] }),
  'ghcr.io/navikt/mock-oauth2-server:2.1.10']);
await waitFor(`http://127.0.0.1:${SSO_PORT}/default/.well-known/openid-configuration`, 'The mock sign-on provider');

const config = join(tmpdir(), 'pocket-dev-vikunja.yml');
// Vikunja allows 10 sign-in requests a minute per address, which the tests' many Vikunja page loads use up.
writeFileSync(config, `ratelimit:
  noauthlimit: 1000
auth:
  openid:
    enabled: true
    providers:
      mock:
        name: "Mock SSO"
        authurl: "http://127.0.0.1:${SSO_PORT}/default"
        clientid: "pocket-dev"
        clientsecret: "pocket-dev-secret"
`);
run('docker', ['run', '-d', '--name', NAME, '--network', `container:${SSO}`,
  '-v', `${PLUGIN}:/app/vikunja/plugins/pocket:ro`, '-v', `${config}:/etc/vikunja/config.yml:ro`,
  '-e', `VIKUNJA_SERVICE_PUBLICURL=${BASE}/`, '-e', 'VIKUNJA_SERVICE_SECRET=pocket-dev-only', '-e', 'VIKUNJA_SERVICE_ENABLEREGISTRATION=true',
  '-e', 'VIKUNJA_DATABASE_PATH=/tmp/vikunja.db', '-e', 'VIKUNJA_FILES_BASEPATH=/tmp/files',
  '-e', 'VIKUNJA_PLUGINS_ENABLED=true', '-e', 'VIKUNJA_PLUGINS_LOADER=yaegi', '-e', 'VIKUNJA_PLUGINS_POCKET_STEPTIMES=true',
  `vikunja/vikunja:${VERSION}`]);
await waitFor(BASE + '/api/v2/info', 'Vikunja');

const logs = run('docker', ['logs', NAME]);
if (!/pocket: serving/.test(logs.stdout + logs.stderr) || !/pocket: step times on/.test(logs.stdout + logs.stderr)) throw new Error('The plugin did not load:\n' + (logs.stdout + logs.stderr).split('\n').filter(l => /plugin|pocket/i.test(l)).join('\n'));
const info = await (await fetch(BASE + '/api/v2/info')).json();
if (!info.auth?.openid_connect?.providers?.length) throw new Error('Vikunja does not offer the mock sign-on provider; see: docker logs ' + NAME);

// Two users and a project they share, so @assignee can be tried.
for (const u of ['dev', 'bob']) await call('POST', '/register', { username: u, email: `${u}@example.com`, password: `${u}-password` });
const { token } = await call('POST', '/login', { username: 'dev', password: 'dev-password' });
const team = await call('POST', '/projects', { title: 'Team' }, token);
await call('POST', `/projects/${team.id}/users`, { username: 'bob', permission: 1 }, token);

console.log(`Vikunja ${VERSION}: ${BASE}  (sign in as dev / dev-password, or with Mock SSO)`);
console.log(`Pocket:        ${BASE}/api/v1/plugins/pocket/`);
console.log(`Stop with:     docker rm -f ${NAME} ${SSO}`);

if (process.argv.includes('--test')) {
  const env = { ...process.env, VIKUNJA_URL: BASE, VIKUNJA_TOKEN: token, ASSIGNEE: 'bob', ASSIGNEE_PROJECT: 'Team',
    VIKUNJA_USER: 'dev', VIKUNJA_PASSWORD: 'dev-password', SSO_USER: 'sso', OTHER_USER: 'bob', OTHER_PASSWORD: 'bob-password' };
  const results = ['tests/parse.mjs', 'tests/smoke.mjs', 'tests/session.mjs', 'tests/offline.mjs', 'tests/checklists.mjs', 'tests/steptimes.mjs'].map(test =>
    run(process.execPath, [fileURLToPath(new URL('../' + test, import.meta.url))], { env, stdio: 'inherit', allowFail: true }).status);
  process.exitCode = results.some(Boolean) ? 1 : 0;
}
