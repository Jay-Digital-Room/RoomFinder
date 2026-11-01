import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { handle } from '../server/index.js';

let server;
let base;
before(async () => {
  server = createServer(handle);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const get = async (path) => {
  const res = await fetch(base + path);
  return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
};

test('GET /api/meta', async () => {
  const { status, body } = await get('/api/meta');
  assert.equal(status, 200);
  assert.deepEqual(body.sources.map((s) => s.key), ['zigbang', 'dabang', 'naver']);
  assert.ok(body.stats.duplicatesMerged > 0);
});

test('GET /api/listings 필터·정렬·페이지', async () => {
  const { body } = await get('/api/listings?dealType=월세&rentMax=70&sort=priceAsc&pageSize=5');
  assert.ok(body.total > 0);
  assert.ok(body.items.length <= 5);
  for (const g of body.items) {
    assert.equal(g.dealType, '월세');
    assert.ok(g.monthlyRent <= 70);
  }
});

test('multiSourceOnly / source 필터', async () => {
  const { body } = await get('/api/listings?multiSourceOnly=true&source=dabang&pageSize=200');
  assert.ok(body.items.every((g) => g.sources.length >= 2 && g.sources.includes('dabang')));
});

test('검색어 필터', async () => {
  const { body } = await get(`/api/listings?q=${encodeURIComponent('망원동')}&pageSize=200`);
  assert.ok(body.total > 0);
  assert.ok(body.items.every((g) => g.address.includes('망원동')));
});

test('상세 조회 및 404', async () => {
  const { body: list } = await get('/api/listings?pageSize=1');
  const { status, body } = await get(`/api/listings/${list.items[0].id}`);
  assert.equal(status, 200);
  assert.ok(body.offers.length >= 1);
  assert.equal((await get('/api/listings/ffffffffffff')).status, 404);
});

test('정적 파일 및 경로 탈출 차단', async () => {
  assert.equal((await get('/')).status, 200);
  assert.notEqual((await get('/..%2fpackage.json')).status, 200);
});
