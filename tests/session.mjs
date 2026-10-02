// Sharing Vikunja's web sign-in: Pocket and Vikunja's own web app, side by side in one browser.
//
//   npm run test:local        (runs this against a local Vikunja with the plugin)
//   VIKUNJA_URL=... VIKUNJA_USER=... VIKUNJA_PASSWORD=... node tests/session.mjs   (needs password sign-in)
//
// Checks that signing in or out on either side carries over, and that renewing the session from both sides at
// once, which spends Vikunja's single-use refresh cookie, never signs either of them out.
// Optional: SSO_USER / SSO_PASSWORD to also sign in through the first single sign-on provider (see scripts/dev.mjs --sso),
// OTHER_USER / OTHER_PASSWORD (a second account) to check that Pocket follows a switch to another account.
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const SERVER = (process.env.VIKUNJA_URL || '').replace(/\/+$/, '');
const USER = process.env.VIKUNJA_USER, PASSWORD = process.env.VIKUNJA_PASSWORD;
const OUT = process.env.OUT || 'test-results';
if (!SERVER || !USER || !PASSWORD) { console.error('Set VIKUNJA_URL, VIKUNJA_USER and VIKUNJA_PASSWORD'); process.exit(2); }
const POCKET = process.env.POCKET_URL || SERVER + '/api/v1/plugins/pocket/';

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined });
let failed = 0, context, vikunja, pocket;
const errors = [];
async function fresh(){                                   // a new browser profile: no one signed in
  await context?.close();
  context = await browser.newContext();
  vikunja = await context.newPage();
  pocket = await context.newPage();
  for (const p of [vikunja, pocket]) p.on('pageerror', e => errors.push(String(e)));
}
async function step(name, fn){
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, '-', e.message.split('\n')[0]); await pocket?.screenshot({ path: `${OUT}/session-fail-${name}.png` }).catch(() => {}); }
}
const vikunjaSignedIn = async () => { await vikunja.goto(SERVER + '/'); await vikunja.waitForLoadState('networkidle'); return !new URL(vikunja.url()).pathname.startsWith('/login'); };
async function vikunjaSignIn(){
  await vikunja.goto(SERVER + '/login');
  await vikunja.fill('#username', USER);
  await vikunja.fill('#password', PASSWORD);
  await vikunja.keyboard.press('Enter');
  await vikunja.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: 15000 });
}
const pocketInApp = () => pocket.waitForSelector('#app:not([hidden]) #view .row, #app:not([hidden]) #view .empty', { timeout: 15000 });
const tokenValid = async t => (await fetch(SERVER + '/api/v1/user', { headers: { Authorization: 'Bearer ' + t } })).ok;
// What a phone left overnight has: a well-formed sign-in token that expired an hour ago.
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const EXPIRED = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ type: 1, id: 1, exp: Math.floor(Date.now() / 1000) - 3600 })}.expired-signature`;
const expire = page => page.evaluate(t => localStorage.setItem('token', t), EXPIRED);

try {
  await fresh();
  await step('vikunja-sign-in-carries-to-pocket', async () => {
    await vikunjaSignIn();
    await pocket.goto(POCKET);
    await pocketInApp();
    if (await pocket.isVisible('#login')) throw new Error('Pocket asked to sign in');
  });

  if (process.env.OTHER_USER) await step('another-account-signing-in-is-followed', async () => {
    // Someone else's session replaces this one without a sign-out Pocket saw, and the first check of whose it is fails.
    const login = await fetch(SERVER + '/api/v1/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: process.env.OTHER_USER, password: process.env.OTHER_PASSWORD }) });
    const other = (await login.json()).token, mine = await pocket.evaluate(() => localStorage.getItem('token'));
    const whoami = url => url.pathname.endsWith('/api/v1/user');
    let cut = true;
    await pocket.route(whoami, r => cut ? r.abort('internetdisconnected') : r.fallback());
    // Who the account sheet names. Switching closes the sheet, so it may already be gone when it's closed here.
    const who = async () => {
      await pocket.click('#btn-account');
      const name = await pocket.textContent('#sheet .prop:has(.k:text-is("User")) .v');
      await pocket.click('#btn-sheet-close', { timeout: 2000 }).catch(() => {});
      await pocket.waitForSelector('#sheet', { state: 'hidden' });
      return name.trim();
    };
    await vikunja.evaluate(t => localStorage.setItem('token', t), other);     // from the other tab, as a sign-in there would
    await pocket.waitForTimeout(1500);
    if (await who() !== '@' + USER) throw new Error('switched before it knew');
    // A task added now mustn't be added as the other person: it waits until Pocket knows, and goes as its own person.
    const title = `Pocket session capture ${Date.now()}`;
    const find = async t => ((await (await fetch(SERVER + '/api/v1/tasks?s=' + encodeURIComponent(title), { headers: { Authorization: 'Bearer ' + t } })).json()) || []).filter(x => x.title === title);
    await pocket.fill('#in-capture', title);
    await pocket.click('#f-capture .go');
    await pocket.waitForSelector(`.row.pending:has(.title:has-text("${title}"))`);
    if ((await find(other)).length || (await find(mine)).length) throw new Error('added before Pocket knew whose session it was');
    cut = false;
    await pocket.evaluate(() => window.dispatchEvent(new Event('online')));   // the next try to send asks again
    for (let i = 0; i < 30 && await who() !== '@' + process.env.OTHER_USER; i++) await pocket.waitForTimeout(500);
    if (await who() !== '@' + process.env.OTHER_USER) throw new Error('still shows ' + await who());
    await pocket.unroute(whoami);
    await vikunja.evaluate(t => localStorage.setItem('token', t), mine);      // and back, for the steps below
    for (let i = 0; i < 30 && await who() !== '@' + USER; i++) await pocket.waitForTimeout(500);
    if (await who() !== '@' + USER) throw new Error('didn\'t switch back: ' + await who());
    for (let i = 0; i < 30 && !(await find(mine)).length; i++) await pocket.waitForTimeout(500);
    const added = await find(mine);
    if (added.length !== 1 || added[0].created_by?.username !== USER) throw new Error('added: ' + JSON.stringify(added.map(t => t.created_by?.username)));
    await fetch(SERVER + '/api/v1/tasks/' + added[0].id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + mine } });
  });

  await step('expired-token-renews-and-vikunja-stays-signed-in', async () => {
    await expire(pocket);
    await pocket.click('#btn-refresh');                  // any request: 401, then a renewal, then the retry
    await pocket.waitForFunction(t => localStorage.getItem('token') !== t, EXPIRED, { timeout: 15000 });
    await pocket.waitForSelector('#btn-refresh:not([disabled])');
    if (await pocket.isVisible('#login')) throw new Error('Pocket signed out');
    if (!await tokenValid(await pocket.evaluate(() => localStorage.getItem('token')))) throw new Error('renewed token does not work');
    if (!await vikunjaSignedIn()) throw new Error('Vikunja web app signed out');
  });

  await step('renewing-from-both-at-once', async () => {
    for (let i = 0; i < 5; i++) {
      await expire(pocket);
      await Promise.all([pocket.click('#btn-refresh'), vikunjaSignedIn()]);   // Vikunja renews on load too
      await pocket.waitForSelector('#btn-refresh:not([disabled])');
      await pocket.waitForTimeout(300);
      if (await pocket.isVisible('#login')) throw new Error(`round ${i + 1}: Pocket signed out`);
      if (!await vikunjaSignedIn()) throw new Error(`round ${i + 1}: Vikunja signed out`);
    }
  });

  await step('signing-out-in-vikunja-signs-out-pocket', async () => {
    await vikunja.evaluate(() => localStorage.removeItem('token'));             // what Vikunja's logout does in the browser
    await pocket.waitForSelector('#login:not([hidden])', { timeout: 10000 });   // after the 2-second check
    if (!(await pocket.textContent('#login-err')).includes('signed out in Vikunja')) throw new Error('no message');
  });

  await fresh();
  await step('password-in-pocket-signs-in-vikunja', async () => {
    await pocket.goto(POCKET);
    await pocket.waitForSelector('#f-pass:not([hidden])', { timeout: 10000 });
    await pocket.fill('#in-user', USER);
    await pocket.fill('#in-pass', PASSWORD);
    await pocket.click('#f-pass button[type=submit]');
    await pocketInApp();
    if (!await vikunjaSignedIn()) throw new Error('Vikunja web app is not signed in');
  });

  await step('signing-out-in-pocket-signs-out-vikunja', async () => {
    await pocket.bringToFront();
    await pocket.click('#btn-account');
    await pocket.click('#btn-signout');
    await pocket.waitForSelector('#login:not([hidden])');
    if (await vikunjaSignedIn()) throw new Error('Vikunja web app is still signed in');
  });

  if (process.env.SSO_USER) {
    await fresh();
    await step('single-sign-on-from-pocket', async () => {
      await pocket.goto(POCKET);
      const button = await pocket.waitForSelector('#sso .sso-btn', { timeout: 10000 });
      const [tab] = await Promise.all([context.waitForEvent('page'), button.click()]);
      // The provider's login form (the mock provider used by scripts/dev.mjs --sso asks for a username only).
      await tab.waitForLoadState();
      const field = await tab.$('input[name=username], input[type=text], input[type=email]');
      if (field) { await field.fill(process.env.SSO_USER); await tab.keyboard.press('Enter'); }
      await pocketInApp();                                // Pocket picks the session up by itself
      if (!tab.isClosed()) throw new Error('the sign-in tab was not closed');
      if (!await vikunjaSignedIn()) throw new Error('Vikunja web app is not signed in');
    });
  }
  if (errors.length) { failed++; console.log('FAIL page errors:', errors); }
} finally {
  await browser.close();
}
console.log(failed ? `${failed} failed` : 'All passed');
process.exitCode = failed ? 1 : 0;
