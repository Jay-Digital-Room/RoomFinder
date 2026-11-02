import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../server/index.js';
import { createStore } from '../server/store.js';

const silent = { log() {}, warn() {} };
import { getSources } from '../server/sources/index.js';

let server;
let base;
let app;
before(async () => {
  app = createApp({ store: createStore(), sources: () => getSources('mock'), mode: 'mock', logger: silent, persist: false });
  await app.crawler.run({ south: -90, west: -180, north: 90, east: 180 });
  server = createServer(app.handle);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const req = async (path, init) => {
  const res = await fetch(base + path, init);
  return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
};
const get = (path) => req(path);

test('GET /api/meta', async () => {
  const { status, body } = await get('/api/meta');
  assert.equal(status, 200);
  assert.deepEqual(body.sources.map((s) => s.key), ['zigbang', 'dabang', 'naver', 'peterpan']);
  assert.ok(body.sources.every((s) => s.count > 0 && s.ok));
  assert.ok(body.stats.duplicatesMerged > 0);
  assert.equal(body.map.provider, 'leaflet'); // 키가 없으면 leaflet
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
  const { body } = await get('/api/listings?multiSourceOnly=true&source=peterpan&pageSize=200');
  assert.ok(body.total > 0);
  assert.ok(body.items.every((g) => g.sources.length >= 2 && g.sources.includes('peterpan')));
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

test('POST /api/crawl 입력 검증', async () => {
  const post = (body) => req('/api/crawl', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal((await post('{"bounds":"oops"}')).status, 400);
  assert.equal((await post('{"bounds":"37.0,126.0,38.0,127.5"}')).status, 400); // 너무 넓음
  assert.equal((await post('not json')).status, 400);
  const ok = await post('{"bounds":"37.55,126.91,37.56,126.93"}');
  assert.equal(ok.status, 202);
  while (app.crawler.running) await new Promise((r) => setTimeout(r, 10));
});

test('정적 파일 및 경로 탈출 차단', async () => {
  assert.equal((await get('/')).status, 200);
  assert.equal((await get('/maps/index.js')).status, 200);
  assert.notEqual((await get('/..%2fpackage.json')).status, 200);
});
