import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collect, dedupe, isSameProperty } from '../server/aggregator.js';
import { parseAddress } from '../server/model.js';
import { baseListings } from '../server/sources/mock/seed.js';
import { getSources } from '../server/sources/index.js';

function listing(overrides) {
  const address = overrides.address ?? '서울 마포구 서교동 100-1';
  return {
    id: `t:${Math.random()}`,
    source: 'zigbang',
    sourceId: '1',
    url: '',
    title: 't',
    dealType: '월세',
    roomType: '원룸',
    deposit: 1000,
    monthlyRent: 60,
    maintenanceFee: 7,
    areaM2: 20,
    floor: 3,
    totalFloors: 5,
    address,
    addr: parseAddress(address),
    lat: 37.555,
    lng: 126.92,
    images: [],
    updatedAt: '2026-10-30T00:00:00.000Z',
    ...overrides,
  };
}

test('주소·면적·층이 같으면 가격이 달라도 같은 매물', () => {
  const a = listing({ source: 'zigbang', monthlyRent: 60 });
  const b = listing({ source: 'naver', monthlyRent: 65, areaM2: 20.3, lat: 37.5551 });
  assert.ok(isSameProperty(a, b));
});

test('거래유형/층/면적이 다르면 다른 매물', () => {
  const a = listing({});
  assert.ok(!isSameProperty(a, listing({ dealType: '전세' })));
  assert.ok(!isSameProperty(a, listing({ floor: 4 })));
  assert.ok(!isSameProperty(a, listing({ areaM2: 26 })));
  assert.ok(!isSameProperty(a, listing({ address: '서울 마포구 서교동 101' })));
});

test('층 비공개(null)는 어느 층과도 매칭 가능, 반지하와 B1은 같은 층', () => {
  assert.ok(isSameProperty(listing({ floor: 7 }), listing({ floor: null })));
  assert.ok(isSameProperty(listing({ floor: -0.5 }), listing({ floor: -1 })));
});

test('좌표가 흐린 플랫폼끼리: 같은 동·층·비슷한 가격이면 300m 이내에서 같은 매물', () => {
  const noJibun = (o) => listing({ address: '', addr: { sido: '', sigungu: '', dong: '서교동', jibun: '' }, ...o });
  const a = noJibun({ source: 'zigbang', lat: 37.555, lng: 126.92 });
  const b = noJibun({ source: 'dabang', lat: 37.5565, lng: 126.9205, monthlyRent: 62 }); // ~170m
  assert.ok(isSameProperty(a, b));
  // 층 정보가 없거나, 가격이 많이 다르거나, 동이 다르면 합치지 않음
  assert.ok(!isSameProperty(a, { ...b, floor: null }));
  assert.ok(!isSameProperty(a, { ...b, monthlyRent: 90 }));
  assert.ok(!isSameProperty(a, { ...b, addr: { ...b.addr, dong: '망원동' } }));
});

test('그룹은 최저가를 대표 가격으로, 가격 차이를 계산한다', () => {
  const [g] = dedupe([
    listing({ id: 'zigbang:1', source: 'zigbang', monthlyRent: 65 }),
    listing({ id: 'dabang:1', source: 'dabang', monthlyRent: 60 }),
  ]);
  assert.equal(g.monthlyRent, 60);
  assert.equal(g.offers[0].source, 'dabang');
  assert.deepEqual(g.sources.sort(), ['dabang', 'zigbang']);
  assert.deepEqual(g.priceGap, { deposit: 0, monthlyRent: 5 });
});

test('그룹 ID는 입력 순서와 무관하게 안정적', () => {
  const a = listing({ id: 'zigbang:1' });
  const b = listing({ id: 'naver:9', source: 'naver' });
  assert.equal(dedupe([a, b])[0].id, dedupe([b, a])[0].id);
});

test('목업 데이터 전체: 실제 매물 수와 통합 결과가 일치하고 잘못 합쳐진 그룹이 없다', async () => {
  const { listings, status } = await collect({ sources: getSources('mock') });
  assert.ok(status.every((s) => s.ok && s.normalizeFailed === 0));
  const groups = dedupe(listings);
  assert.equal(groups.length, baseListings().length);
  for (const g of groups) {
    // 한 그룹 안에서 같은 플랫폼이 두 번 나오면 잘못 합쳐진 것
    assert.equal(new Set(g.offers.map((o) => o.source)).size, g.offers.length, `group ${g.id}`);
  }
});

test('일부 소스가 실패해도 나머지 결과를 반환한다', async () => {
  const ok = { key: 'ok', name: 'OK', fetchRaw: async () => [{ x: 1 }], normalize: () => listing({ id: 'ok:1' }) };
  const broken = { key: 'broken', name: 'Broken', fetchRaw: async () => { throw new Error('down'); }, normalize: () => null };
  const slow = { key: 'slow', name: 'Slow', fetchRaw: () => new Promise(() => {}), normalize: () => null };
  const { listings, status } = await collect({ sources: [ok, broken, slow], timeoutMs: 50 });
  assert.equal(listings.length, 1);
  assert.deepEqual(status.map((s) => s.ok), [true, false, false]);
  assert.match(status[2].error, /timeout/);
});
