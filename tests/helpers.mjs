// What the end-to-end tests share: Playwright's assertions that try again, waiting until Pocket has sent everything,
// and signing in. Not a test file itself.
import { expect as base } from 'playwright/test';

/* Playwright's own expect, without its test runner: `await expect(locator).toBeVisible()` tries again until it passes
   or 10 seconds go by, so a test needn't wait for the page and then check it. */
export const expect = base.configure({ timeout: 10000 });

/* Until everything Pocket has to send has reached Vikunja: <html data-sync> says "idle" (core.js), and still does a
   moment later, as a tap's handler may be about to send. Before a test reads Vikunja, or deletes what it made.
   Something kept that can't go now (a deletion whose Undo still shows, no connection, turned down) never gets there. */
export async function synced(page, { timeout = 20000, settle = 250 } = {}){
  let since = 0, state;
  for (const end = Date.now() + timeout; ; await new Promise(r => setTimeout(r, 50))) {
    state = await page.evaluate(() => document.documentElement.dataset.sync).catch(() => null);    // mid-reload: again
    if (state !== 'idle') since = 0; else if (!since) since = Date.now(); else if (Date.now() - since >= settle) return;
    if (Date.now() > end) throw new Error(`Pocket never finished sending: data-sync is "${state}"`);
  }
}

// Signed in with an API token, from Pocket's sign-in screen at `url`, until its first list has loaded.
export async function signIn(page, url, token){
  await page.goto(url);
  await expect(page.locator('#auth-step')).toBeVisible();                  // no address to enter: it's this Vikunja
  const tab = page.getByRole('button', { name: 'API token', exact: true });
  if (await tab.isVisible()) await tab.click();                            // not there when passwords are off
  await page.getByLabel('API token').fill(token);
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#view .loading')).toHaveCount(0, { timeout: 15000 });
}

/* A message in its place (lines.js): under a heading ("overdue"), by the add box ("cap"), in a sheet ("sheet:notes"), on
   a run ("step", "run"), as Pocket asked for it (data-place). Its action is a button with its name: line.getByRole(…). */
export const placeLine = (page, where) => page.locator(`.place-line[data-place="${where}"]`);
export const placeSays = (page, where, text, timeout = 20000) => expect(placeLine(page, where)).toContainText(text, { timeout, ignoreCase: true });
// A line in a row's place: what it says, and its action.
export const rowLine = (page, text) => page.locator('.row-line', { hasText: text });
// No message at the bottom of the screen.
export const noToast = async page => { if (await page.locator('#toast.show').count()) throw new Error('the toast said: ' + await page.textContent('#toast-msg')); };
// A message showing in the toast (a hidden one keeps its words, only see-through: so only one showing counts).
export const toast = (page, text, timeout = 20000) => expect(page.locator('#toast.show #toast-msg')).toContainText(text, { timeout, ignoreCase: true });
// So the next one is new: the one showing goes now, as its own timer would make it. (Not by moving the page's clock on,
// which would also bring every other timer round sooner: the run screen's reload every 20 seconds, under a finger.)
export async function toastGone(page){
  await page.evaluate(() => { const t = window.Alpine?.$data(document.body)?.toast; if (t) t.show = false; });
  await expect(page.locator('#toast.show')).toHaveCount(0);
}

// Where an element is once it has stopped moving (a sheet sliding in, a list scrolling): to put a finger on it.
export async function steady(locator, timeout = 5000){
  let was = null;
  for (const end = Date.now() + timeout; Date.now() < end; await new Promise(r => setTimeout(r, 80))) {
    const box = await locator.boundingBox();
    if (box && was && Math.abs(box.x - was.x) < 0.5 && Math.abs(box.y - was.y) < 0.5) return box;
    was = box;
  }
  throw new Error('it never stopped moving');
}
