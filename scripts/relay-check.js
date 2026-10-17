// Checks Pocket's relay on a live Vikunja. Open Vikunja's web app, signed in, press F12, and paste this into the
// Console. It uses your session, makes one task called "Pocket relay check" in your default project through the
// relay, sends the same request again with the same key, checks that one task was made, and deletes it.
/* global localStorage, crypto, fetch, console, URLSearchParams */
(async () => {
  const token = localStorage.getItem('token');
  const headers = key => ({
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + token,
    ...(key && { 'Idempotency-Key': `"${key}"` }),
  });
  // A UUIDv7: the relay reads the time a key was made from its first 48 bits.
  const b = crypto.getRandomValues(new Uint8Array(16)),
    ms = Date.now();
  for (let i = 0; i < 6; i++) b[i] = Math.floor(ms / 2 ** (8 * (5 - i))) % 256;
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  const key = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  const user = await (await fetch('/api/v2/user', { headers: headers() })).json();
  const url = `/api/v1/plugins/pocket/v2/projects/${user.settings.default_project_id}/tasks`;
  const body = JSON.stringify({ title: 'Pocket relay check ' + key.slice(-6) });
  const send = async () => {
    const r = await fetch(url, { method: 'POST', headers: headers(key), body });
    return { status: r.status, replayed: r.headers.get('Idempotent-Replayed'), json: await r.json().catch(() => null) };
  };
  const first = await send(),
    again = await send();
  console.log('first:', first.status, first.json);
  console.log('again:', again.status, 'replayed:', again.replayed, 'same task:', again.json?.id === first.json?.id);
  if (first.json?.id) {
    const found = await (
      await fetch('/api/v2/tasks?' + new URLSearchParams({ filter: `title = '${JSON.parse(body).title}'` }), {
        headers: headers(),
      })
    ).json();
    console.log('tasks with that title:', (found.items || []).length, '(should be 1)');
    await fetch('/api/v2/tasks/' + first.json.id, { method: 'DELETE', headers: headers() });
    console.log('deleted the test task');
  }
  console.log(
    first.status === 201 && again.replayed === 'true' && again.json?.id === first.json?.id
      ? 'RELAY OK'
      : 'RELAY PROBLEM: send these lines to Claude',
  );
})();
