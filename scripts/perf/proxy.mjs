// In front of the measuring Vikunja (up.mjs): a phone's connection and a reverse proxy, as Pocket would meet them.
//   node scripts/perf/proxy.mjs [--port 3471] [--gzip] [--pass-encoding] [--rtt 100] [--kbps 5000]
// --gzip compresses HTML, JS and JSON as nginx does by default (level 1); --pass-encoding sends the browser's
// Accept-Encoding on to Vikunja, and a reply it sent compressed (the plugin's index.html.br or .gz) passes as it is, as
// nginx passes it; --rtt delays each reply by that many ms (a request's round trip); --kbps is the
// link's speed, shared by every reply at once. GET /__stats gives {requests, bytes, api, apiBytes, list} since the
// last GET /__reset.
import http from 'node:http';
import zlib from 'node:zlib';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const PORT = +arg('port', 3471), RTT = +arg('rtt', 0), KBPS = +arg('kbps', 0), GZIP = process.argv.includes('--gzip');
const UP = 'http://127.0.0.1:3470', PASS = process.argv.includes('--pass-encoding');
// Vikunja's reply with its body as sent (fetch would decode it): {status, headers: Headers, buf}.
const raw = (url, opts, body) => new Promise((ok, fail) => {
  const r = http.request(UP + url, opts, res => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => {
    const h = new Headers(); for (const [k, v] of Object.entries(res.headers)) h.set(k, Array.isArray(v) ? v.join(', ') : v);
    ok({ status: res.statusCode, headers: h, buf: Buffer.concat(c) });
  }); });
  r.on('error', fail); r.end(body);
});
let stats = { requests: 0, bytes: 0, api: 0, apiBytes: 0, list: [] };
let linkFree = 0;                                               // when the shared link is next free, ms
const bytesPerMs = KBPS ? KBPS * 1000 / 8 / 1000 : 0;
const sleep = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));

async function send(res, buf){
  if (!bytesPerMs) { res.end(buf); return; }
  for (let i = 0; i < buf.length; i += 16384) {
    const chunk = buf.subarray(i, i + 16384), start = Math.max(Date.now(), linkFree);
    linkFree = start + chunk.length / bytesPerMs;
    await sleep(linkFree - Date.now());
    res.write(chunk);
  }
  res.end();
}

http.createServer(async (req, res) => {
  if (req.url === '/__stats') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(stats)); return; }
  if (req.url === '/__reset') { stats = { requests: 0, bytes: 0, api: 0, apiBytes: 0, list: [] }; res.end('ok'); return; }
  const t0 = Date.now();
  const body = await new Promise(ok => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => ok(Buffer.concat(c))); });
  const headers = { ...req.headers }; if (!PASS) delete headers['accept-encoding']; headers.host = '127.0.0.1:3470';
  let up, buf;
  try {
    if (PASS) ({ buf, ...up } = await raw(req.url, { method: req.method, headers }, ['GET', 'HEAD'].includes(req.method) ? undefined : body));
    else { up = await fetch(UP + req.url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body, redirect: 'manual' }); buf = Buffer.from(await up.arrayBuffer()); }
  } catch (e) { res.statusCode = 502; res.end(String(e)); return; }
  const out = {}, sent = PASS && up.headers.get('content-encoding');
  up.headers.forEach((v, k) => { if (!['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(k)) out[k] = v; });
  if (sent) out['content-encoding'] = sent;
  const type = up.headers.get('content-type') || '';
  if (!sent && GZIP && buf.length > 20 && /gzip/.test(req.headers['accept-encoding'] || '') && /json|html|javascript/.test(type)) {
    buf = zlib.gzipSync(buf, { level: 1 }); out['content-encoding'] = 'gzip'; out.vary = 'Accept-Encoding';
  }
  out['content-length'] = buf.length;
  await sleep(RTT - (Date.now() - t0));                       // the round trip, less what Vikunja itself took
  res.writeHead(up.status, out);
  stats.requests++; stats.bytes += buf.length;
  if (req.url.startsWith('/api/v2')) { stats.api++; stats.apiBytes += buf.length; stats.list.push({ url: req.url.slice(0, 140), bytes: buf.length, ms: Date.now() - t0 }); }
  await send(res, buf);
}).listen(PORT, '127.0.0.1', () => console.log(`proxy :${PORT} gzip=${GZIP} rtt=${RTT} kbps=${KBPS} pass=${PASS}`));
