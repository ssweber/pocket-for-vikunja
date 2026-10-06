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
// A stylesheet or script that isn't in src/ (the libraries in pocket/app/) is left as it is.
//
// Everything Pocket's page needs is in that one file, so a phone never mixes a new page with old code, and sw.js and
// main.go need nothing more. Edit src/, never pocket/app/index.html: the build overwrites it, and CI checks it's the
// build of src/.
import { existsSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
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

function include(file, seen = []){
  if (seen.includes(file)) throw new Error(`${relative(ROOT, file)} includes itself`);
  return read(file).replace(/^([ \t]*)<!-- include (\S+) -->\n?/gm, (_, indent, path) => {
    const part = inSrc(join(SRC, 'index.html'), path);                         // always from src/, wherever it's written
    if (!part) throw new Error(`${relative(ROOT, file)}: no src file ${path} to include`);
    return include(part, [...seen, file]);
  });
}

async function css(file){
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
  if (map) write(join(OUT, MAP), map);
}

// Only a file that changed is written: a new modification time is a new version of Pocket to every open copy of it,
// which reloads to get it.
function write(file, text){
  if (!existsSync(file) || read(file) !== text) writeFileSync(file, text);
}

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
