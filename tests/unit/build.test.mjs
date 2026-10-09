// The page written compressed by the build (scripts/build.mjs, compressed), which main.go sends a browser that takes it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { compressed } from '../../scripts/build.mjs';

test('the page is written as .br and .gz that decode to it, with no time or computer in the gzip header', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-build-')), file = join(dir, 'index.html'), page = '<!doctype html><p>Café ✓</p>\n'.repeat(50);
  try {
    compressed(file, page);
    assert.equal(brotliDecompressSync(readFileSync(file + '.br')).toString(), page);
    assert.equal(gunzipSync(readFileSync(file + '.gz')).toString(), page);
    assert.deepEqual([...readFileSync(file + '.gz').subarray(4, 10)], [0, 0, 0, 0, 2, 255], 'time 0, best compression, made on "unknown"');
  } finally { rmSync(dir, { recursive: true }); }
});

test('a copy that already decodes to the page is left as it is, and one that doesn\'t is made again', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-build-')), file = join(dir, 'index.html');
  try {
    compressed(file, 'one');
    const br = statSync(file + '.br').mtimeMs;
    writeFileSync(file + '.gz', 'not gzip');
    compressed(file, 'one');
    assert.equal(statSync(file + '.br').mtimeMs, br, 'the .br is as it was');
    assert.equal(gunzipSync(readFileSync(file + '.gz')).toString(), 'one');
    compressed(file, 'two');
    assert.equal(brotliDecompressSync(readFileSync(file + '.br')).toString(), 'two');
  } finally { rmSync(dir, { recursive: true }); }
});

test('the committed page\'s compressed copies are of it', () => {
  const page = readFileSync('pocket/app/index.html');
  assert.ok(brotliDecompressSync(readFileSync('pocket/app/index.html.br')).equals(page), 'index.html.br: run npm run build');
  assert.ok(gunzipSync(readFileSync('pocket/app/index.html.gz')).equals(page), 'index.html.gz: run npm run build');
});
