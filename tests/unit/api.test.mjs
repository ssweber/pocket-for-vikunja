// Reading a whole list from Vikunja (allPages in src/js/api.js). It reads page 1, then requests the remaining pages at
// the same time, using the largest page size Vikunja allows.
import { component } from './fake.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allPages, partOf } from '../../src/js/api.js';

/* A fake Vikunja with a list of `n` items, paged the way Vikunja pages them (at most `max` per page). Each reply is
   delayed briefly so requests made together overlap. It records the requests (`asked`, as [page, per_page]) and the
   most requests open at once (`most`). The page number `fail` answers 500. */
function list(n, { max = 50, fail = 0 } = {}){
  const v = { asked: [], most: 0 };
  let open = 0;
  globalThis.fetch = async url => {
    const q = new URL(url).searchParams, page = +q.get('page'), per = Math.min(+q.get('per_page'), max);
    v.asked.push([page, +q.get('per_page')]);
    v.most = Math.max(v.most, ++open);
    await new Promise(ok => setTimeout(ok, 5));
    open--;
    if (page === fail) return new Response('{"message":"broken"}', { status: 500 });
    const all = Array.from({ length: n }, (_, k) => ({ id: k + 1 }));
    return new Response(JSON.stringify({ items: all.slice((page - 1) * per, page * per), total: n, total_pages: Math.ceil(n / per) }), { status: 200 });
  };
  return v;
}
const ids = n => Array.from({ length: n }, (_, k) => k + 1);

test('a list is read to its end in order, with page 1 first and the other pages at once, past the old limit of 40 pages', async () => {
  component(); const v = list(2210);
  assert.deepEqual((await allPages('/tasks?filter=done+%3D+true')).map(t => t.id), ids(2210));
  assert.equal(v.asked.length, 45);
  assert.deepEqual(v.asked[0], [1, 50], 'the page size is 50 when /info does not give one');
  assert.equal(v.most, 44, 'pages 2 to 45 are requested together');
});

test('a list uses the page size that Vikunja says it allows', async () => {
  const app = component(); app.info = { max_items_per_page: 500 };
  const v = list(1200, { max: 500 });
  assert.deepEqual((await allPages('/projects')).map(t => t.id), ids(1200));
  assert.deepEqual(v.asked.map(([p, per]) => p + '/' + per).sort(), ['1/500', '2/500', '3/500']);
});

test('a list of one page, or an empty list, takes one request', async () => {
  component(); let v = list(12);
  assert.equal((await allPages('/labels')).length, 12);
  assert.equal(v.asked.length, 1);
  v = list(0);
  assert.deepEqual(await allPages('/labels'), []);
  assert.equal(v.asked.length, 1);
});

test('a page that fails fails the whole read', async () => {
  component(); list(500, { fail: 7 });
  await assert.rejects(allPages('/tasks'), { status: 500 });
});

/* partOf reads one slice of a list, such as a project's Done list shown 100 at a time. It requests the fewest pages
   that cover the slice, all at once, and also returns the total number of items. */
test('a part of a list is read at once in as few pages as possible, together with the total number of items', async () => {
  const app = component(); let v = list(3000);
  let part = await partOf('/projects/2/tasks?filter=done+%3D+true', 0, 100);
  assert.deepEqual(part.items.map(t => t.id), ids(100));
  assert.equal(part.total, 3000);
  assert.deepEqual(v.asked.sort(), [[1, 50], [2, 50]], 'with 50 to a page, two pages are requested together');
  assert.equal(v.most, 2);
  v = list(3000);
  part = await partOf('/tasks', 100, 100);
  assert.deepEqual(part.items.map(t => t.id), ids(200).slice(100), 'the next part holds the next 100 items');
  assert.deepEqual(v.asked.sort(), [[3, 50], [4, 50]]);

  app.info = { max_items_per_page: 500 }; v = list(3000, { max: 500 });
  part = await partOf('/tasks', 200, 100);
  assert.deepEqual(part.items.map(t => t.id), ids(300).slice(200));
  assert.deepEqual(v.asked, [[3, 100]], 'when Vikunja allows 100 to a page, one page of 100 is requested');

  app.info = { max_items_per_page: 30 }; v = list(3000, { max: 30 });
  part = await partOf('/tasks', 100, 100);
  assert.deepEqual(part.items.map(t => t.id), ids(200).slice(100), 'when pages do not line up with the part, only the part\'s items are returned');
  assert.deepEqual(v.asked.map(([p]) => p).sort((a, b) => a - b), [4, 5, 6, 7]);

  app.info = {}; list(130);
  assert.deepEqual((await partOf('/tasks', 100, 100)).items.map(t => t.id), ids(130).slice(100), 'a part at the end of the list holds the items that remain');
  list(130);
  assert.deepEqual(await partOf('/tasks', 200, 100), { items: [], total: 130 }, 'a part past the end of the list holds no items');
});
