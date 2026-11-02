import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DEFAULT_CONDITIONS, REGIONS, areasOf, describe, matches, sanitize } from '../server/conditions.js';
import { parseNumbers } from '../server/prompt.js';
import { plan as zigbangPlan } from '../server/sources/live/zigbang.js';
import { plan as dabangPlan } from '../server/sources/live/dabang.js';
import { createCrawler } from '../server/crawler.js';
import { createStore } from '../server/store.js';

const silent = { log() {}, warn() {} };
import { createApp } from '../server/index.js';

const C = (o = {}) => sanitize({ ...DEFAULT_CONDITIONS, ...o });

test('터미널 번호 입력 파싱: 쉼표·공백·범위, 범위 밖 무시', () => {
  assert.deepEqual(parseNumbers('1,3', 5), [1, 3]);
  assert.deepEqual(parseNumbers('2 4-5', 5), [2, 4, 5]);
  assert.deepEqual(parseNumbers('0, 9, x', 5), []);
});

test('조건 정리: 잘못된 값 제거, 빈 값은 기본값, 지역 최대 6곳', () => {
  const c = sanitize({ regions: ['nope', 'gangnam'], dealTypes: ['월세', '임대'], roomTypes: [], depositMax: '-5', rentMax: '60', sources: [] });
  assert.deepEqual(c.regions, ['gangnam']);
  assert.deepEqual(c.dealTypes, ['월세']);
  assert.equal(c.roomTypes.length, 6);
  assert.equal(c.depositMax, null);
  assert.equal(c.rentMax, 60);
  assert.equal(c.sources.length, 4);
  assert.equal(sanitize({ regions: REGIONS.map((r) => r.id) }).regions.length, 6);
  assert.deepEqual(sanitize({ regions: [] }).regions, DEFAULT_CONDITIONS.regions);
});

test('지역 영역은 약 2km × 2km', () => {
  const [a] = areasOf(C({ regions: ['gangnam'] }));
  assert.ok(Math.abs((a.north - a.south) * 110.6 - 2) < 0.1);
  assert.ok(Math.abs((a.east - a.west) * 88.3 - 2) < 0.1);
  assert.match(describe(C({ regions: ['gangnam'] })), /강남역/);
});

test('조건 매칭', () => {
  const c = C({ dealTypes: ['월세'], roomTypes: ['원룸'], depositMax: 1000, rentMax: 60 });
  const l = { dealType: '월세', roomType: '원룸', deposit: 1000, monthlyRent: 60 };
  assert.ok(matches(l, c));
  assert.ok(!matches({ ...l, monthlyRent: 61 }, c));
  assert.ok(!matches({ ...l, deposit: 2000 }, c));
  assert.ok(!matches({ ...l, roomType: '빌라' }, c));
  assert.ok(!matches({ ...l, dealType: '전세' }, c));
});

test('조건에 따라 필요한 요청만: 원룸·월세만이면 직방 원룸 카테고리만', () => {
  const p = zigbangPlan(C({ dealTypes: ['월세'], roomTypes: ['원룸'] }));
  assert.deepEqual(p.map((c) => [c.path, c.salesTypes]), [['onerooms', ['월세']]]);
  // 원룸 카테고리는 매매 미지원 → 매매만 고르면 원룸 요청 없음
  assert.deepEqual(zigbangPlan(C({ dealTypes: ['매매'], roomTypes: ['원룸'] })), []);
  const d = dabangPlan(C({ dealTypes: ['전세'], roomTypes: ['오피스텔'] }));
  assert.deepEqual(d.map((c) => [c.key, c.selling]), [['officetel', ['LEASE']]]);
});

function fakeSource(key, { delay = 0, fail = false, items }) {
  return {
    key,
    name: key,
    color: '#000',
    calls: [],
    async fetchRaw(ctx) {
      this.calls.push(ctx);
      await new Promise((r) => setTimeout(r, delay));
      if (fail) throw new Error('down');
      return items(ctx);
    },
    normalize: (raw) => raw,
  };
}

const listing = (id, source, o = {}) => ({
  id: `${source}:${id}`, source, sourceId: id, url: null, title: 't', dealType: '월세', roomType: '원룸',
  deposit: 1000, monthlyRent: 50, maintenanceFee: 5, areaM2: 20, floor: 2, totalFloors: 5,
  address: '', addr: { sido: '', sigungu: '', dong: '서교동', jibun: '' }, lat: 37.557, lng: 126.924, images: [], updatedAt: null, ...o,
});

test('먼저 끝난 사이트 결과가 바로 저장되고, 조건에 안 맞는 매물은 걸러진다', async () => {
  const store = createStore();
  const fast = fakeSource('zigbang', { items: () => [listing('1', 'zigbang'), listing('2', 'zigbang', { monthlyRent: 99 })] });
  const slow = fakeSource('dabang', { delay: 150, items: () => [listing('3', 'dabang')] });
  const broken = fakeSource('naver', { fail: true, items: () => [] });
  const crawler = createCrawler({ store, getSources: () => [fast, slow, broken], logger: silent });
  const c = C({ dealTypes: ['월세'], rentMax: 60, sources: ['zigbang', 'dabang', 'naver'] });

  const p = crawler.run(areasOf(c), { conditions: c });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(store.size, 1); // 직방만 끝남, 월세 99 는 조건 밖이라 제외
  assert.equal(crawler.status('dabang').running, true);
  await p;
  assert.equal(store.size, 2);
  assert.equal(fast.calls[0].conditions, c); // 어댑터에 조건 전달
  assert.equal(crawler.status('naver').lastError, '홍대입구역: down');
  assert.equal(crawler.status('zigbang').lastError, null);
});

test('선택하지 않은 플랫폼은 요청하지 않는다', async () => {
  const a = fakeSource('zigbang', { items: () => [] });
  const b = fakeSource('dabang', { items: () => [] });
  const crawler = createCrawler({ store: createStore(), getSources: () => [a, b], logger: silent });
  await crawler.run(areasOf(C()), { conditions: C({ sources: ['dabang'] }) });
  assert.equal(a.calls.length, 0);
  assert.equal(b.calls.length, 1);
});

test('PUT /api/conditions: 저장 → 다른 지역 매물 정리 → 새 조건으로 수집', async () => {
  const store = createStore();
  const src = fakeSource('zigbang', { delay: 100, items: (ctx) => [listing(`${ctx.bbox.name}`, 'zigbang', { lat: (ctx.bbox.south + ctx.bbox.north) / 2, lng: (ctx.bbox.west + ctx.bbox.east) / 2 })] });
  const app = createApp({ store, sources: () => [src], mode: 'live', conditions: C({ regions: ['hongdae'] }), logger: silent, persist: false, ai: null });
  await app.crawlConditions('test');
  assert.equal(store.size, 1);

  const server = createServer(app.handle);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/conditions`, { method: 'PUT', body: JSON.stringify({ ...C(), regions: ['gangnam'] }) });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(body.conditions.regions, ['gangnam']);
    assert.match(body.text, /강남역/);
    assert.equal(store.size, 0); // 홍대 매물 정리
    while (app.crawler.running) await new Promise((r) => setTimeout(r, 5));
    assert.equal(store.size, 1);
    assert.equal(store.listings()[0].sourceId, '강남역');

    const meta = await fetch(`${base}/api/meta`).then((r) => r.json());
    assert.equal(meta.conditions.regions[0], 'gangnam');
    assert.ok(meta.regions.length > 20);
  } finally {
    server.close();
  }
});
