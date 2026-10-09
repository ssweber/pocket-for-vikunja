// Builds Pocket's page, pocket/app/index.html, from src/:
//
//   npm run build           once
//   npm run build -- --watch   again on every change in src/ (npm run dev does this)
//
// It reads src/index.html and puts into it, in place:
//   <!-- include markup/x.html -->                 src/markup/x.html (and any includes in it, also from src/)
//   <link rel="stylesheet" href="styles.css">      that stylesheet from src/, minified, in a <style>
//   <script type="module" src="js/main.js">        that script from src/ and everything it imports, as one minified
//                                                  script, with a source map next to the page (pocket.js.map)
//   <script defer src="alpine-3.17.4-pocket.2.min.js">
//                                                  src/vendor/alpine-3.17.4.js, minified, written as that file
//                                                  next to the page (vendor, below)
// A stylesheet or script that isn't in src/ (the libraries in pocket/app/) is left as it is. The page is also written
// compressed, as index.html.br and index.html.gz, for main.go to send a browser that takes one (compressed, below).
//
// Everything Pocket's page needs is in that one file, so a phone never mixes a new page with old code, and sw.js and
// main.go need nothing more. Edit src/, never pocket/app/index.html: the build overwrites it, and CI checks it's the
// build of src/.
import { existsSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { brotliCompressSync, brotliDecompressSync, constants, gunzipSync, gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SRC = join(ROOT, 'src'), OUT = join(ROOT, 'pocket', 'app');
const MAP = 'pocket.js.map';

// The same output on every computer: \n line endings, whatever git checked out.
const read = file => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const inSrc = (from, path) => {
  const file = resolve(dirname(from), path);
  return file.startsWith(SRC + sep) && existsSync(file) ? file : null;
};

export function include(file, seen = []){
  if (seen.includes(file)) throw new Error(`${relative(ROOT, file)} includes itself`);
  return read(file).replace(/^([ \t]*)<!-- include (\S+) -->\n?/gm, (_, indent, path) => {
    const part = inSrc(join(SRC, 'index.html'), path);                         // always from src/, wherever it's written
    if (!part) throw new Error(`${relative(ROOT, file)}: no src file ${path} to include`);
    return include(part, [...seen, file]);
  });
}

export async function css(file){
  const r = await esbuild.build({ entryPoints: [file], bundle: true, minify: true, write: false, logLevel: 'silent' });
  return r.outputFiles[0].text.trim();
}

async function js(file){
  const r = await esbuild.build({
    entryPoints: [file], bundle: true, format: 'esm', target: 'es2022', minify: true, write: false, logLevel: 'silent',
    sourcemap: 'external', sourceRoot: '', outdir: OUT, sourcesContent: true, legalComments: 'none',
  });
  const code = r.outputFiles.find(f => f.path.endsWith('.js')).text.trim();
  const map = JSON.parse(r.outputFiles.find(f => f.path.endsWith('.map')).text);
  map.sources = map.sources.map(s => s.replace(/^(\.\.\/)+/, ''));       // "src/js/api.js", the same on every computer
  map.sourcesContent = map.sourcesContent.map(s => s.replace(/\r\n/g, '\n'));   // esbuild reads them as checked out
  map.file = 'index.html';
  return { code, map: JSON.stringify(map) + '\n' };
}

async function build(){
  let page = include(join(SRC, 'index.html')), map = null;
  const tag = /<link rel="stylesheet" href="([^"]+)">|<script type="module" src="([^"]+)"><\/script>/g;
  const parts = [];
  for (const m of page.matchAll(tag)) {
    const file = inSrc(join(SRC, 'index.html'), m[1] || m[2]);
    if (!file) continue;
    if (m[1]) parts.push([m[0], `<style>${await css(file)}</style>`]);
    else {
      if (map) throw new Error('Only one script from src/ can go in the page: import the rest from it');
      const out = await js(file);
      map = out.map;
      parts.push([m[0], `<script type="module">${out.code}\n//# sourceMappingURL=${MAP}\n</script>`]);
    }
  }
  for (const [from, to] of parts) page = page.replace(from, () => to);
  // A "</script" or "</style" inside what was put in would end it early.
  for (const [, to] of parts) if (/<\/(script|style)/i.test(to.replace(/^<(script|style)[^>]*>/, '').replace(/<\/(script|style)>$/, '')))
    throw new Error('A </script> or </style> inside the inlined code would cut it short');
  write(join(OUT, 'index.html'), page);
  compressed(join(OUT, 'index.html'), page);
  if (map) write(join(OUT, MAP), map);
  await vendor(page);
}

/* A library Pocket patches is kept readable in src/vendor/ (alpine-3.17.4.js: Alpine as published, then patched, each
   change marked "Pocket:") and minified here, as its own makers do, into the file the page names
   (alpine-3.17.4-pocket.2.min.js). That name changes with each change to the patch: sw.js keeps the libraries by name,
   so a changed file under an old name would never reach an installed Pocket. */
async function vendor(page){
  for (const [, name, lib] of page.matchAll(/<script[^>]* src="(([\w.-]+?)-pocket\.\d+\.min\.js)"/g)) {
    const file = join(SRC, 'vendor', lib + '.js');
    if (!existsSync(file)) throw new Error(`The page loads ${name}, but there's no src/vendor/${lib}.js to make it from`);
    const { code } = await esbuild.transform(read(file), { minify: true, banner: `/* ${lib}.js, patched by Pocket: src/vendor/${lib}.js */` });
    write(join(OUT, name), code);
  }
}

/* The page compressed, which main.go sends a browser that takes it: brotli (a fifth of the size) and gzip. Each is made
   again only when what's there doesn't decode to the page, so a build that changes nothing is quick, and it's the same
   bytes on every computer: gzip's header has no time in it, and its "made on" byte is set, not this computer's. */
export function compressed(file, page){
  const text = Buffer.from(page);
  const ways = {
    '.br': [brotliDecompressSync, () => brotliCompressSync(text, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT, [constants.BROTLI_PARAM_SIZE_HINT]: text.length } })],
    '.gz': [gunzipSync, () => { const gz = gzipSync(text, { level: 9 }); gz.writeUInt32LE(0, 4); gz[9] = 255; return gz; }],   // 255: made on "unknown"
  };
  for (const [ext, [unzip, zip]] of Object.entries(ways)) {
    try { if (unzip(readFileSync(file + ext)).equals(text)) continue; } catch {}
    writeFileSync(file + ext, zip());
  }
}

// Only a file that changed is written: a new modification time is a new version of Pocket to every open copy of it,
// which reloads to get it.
function write(file, text){
  if (!existsSync(file) || read(file) !== text) writeFileSync(file, text);
}

// Run as a script, it builds; imported (by the specimen page), it only lends its functions.
if (resolve(process.argv[1] || '').toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  try {
    await build();
    console.log('Built pocket/app/index.html from src/');
  } catch (e) {
    console.error(e.message || e);
    if (!process.argv.includes('--watch')) process.exit(1);
  }

  if (process.argv.includes('--watch')) {
    let timer;
    watch(SRC, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => build().then(() => console.log(new Date().toLocaleTimeString(), 'rebuilt'), e => console.error(e.message || e)), 100);
    });
    console.log('Watching src/ for changes');
  }
}
