/**
 * 실제 크롤러 어댑터 테스트.
 * 네트워크 대신 가짜 fetch 로, 각 사이트의 (조사된) 응답 형태를 흉내내 요청 흐름과 정규화를 검증한다.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import zigbang from '../server/sources/live/zigbang.js';
import dabang from '../server/sources/live/dabang.js';
import naver from '../server/sources/live/naver.js';
import peterpan, { extractHouses } from '../server/sources/live/peterpan.js';
import { isValidListing } from '../server/aggregator.js';

const BBOX = { south: 37.55, west: 126.91, north: 37.56, east: 126.925 };
const ctx = { bbox: BBOX, maxPages: 3, delayMs: 0 };

let routes;
let calls;
beforeEach(() => {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [match, handler] of routes) {
      if (String(url).includes(match)) {
        const r = handler(String(url), init);
        return new Response(JSON.stringify(r.body ?? r), { status: r.status ?? 200 });
      }
    }
    return new Response('{}', { status: 404 });
  };
});

/* ---------------- 직방 ---------------- */

const zigbangSummary = (id, o = {}) => ({
  item_id: id,
  sales_type: '월세',
  contract: '',
  service_type: '원룸',
  room_type: '02',
  deposit: 1000,
  rent: 55,
  size_m2: 19.8,
  exclusive_area: { m2: 19.83, p: '6' },
  floor: '3',
  building_floor: '5',
  manage_cost: '70000',
  title: '홍대 분리형 원룸',
  reg_date: '2026-10-30T10:00:00+09:00',
  location: { lat: 37.5551, lng: 126.9201 },
  address_origin: { local1: '서울시', local2: '마포구', local3: '서교동', address2: '', fullText: '서울시 마포구 서교동' },
  address1: '서울시 마포구 서교동',
  images_thumbnail: 'https://ic.zigbang.com/ic/items/1.jpg',
  ...o,
});

test('직방: geohash 핀 → bbox 안의 ID만 15개씩 배치 조회 → 정규화', async () => {
  const inside = Array.from({ length: 20 }, (_, i) => ({ id: 100 + i, lat: 37.555, lng: 126.92 }));
  routes = [
    ['/items/onerooms', () => ({ items: [...inside, { id: 999, lat: 37.6, lng: 127.0 }] })],
    ['/items/villas', () => ({ items: [] })],
    ['/items/officetels', () => ({ items: [] })],
    ['/items/list', (_, init) => ({ items: JSON.parse(init.body).itemIds.map((id) => zigbangSummary(id)) })],
  ];
  const raws = await zigbang.fetchRaw(ctx);
  assert.equal(raws.length, 20); // bbox 밖(999) 제외
  const batches = calls.filter((c) => c.url.includes('/items/list'));
  assert.ok(batches.every((c) => JSON.parse(c.init.body).itemIds.length <= 15));
  assert.equal(calls[0].init.headers['x-zigbang-platform'], 'www');
  assert.match(decodeURIComponent(calls[0].url), /salesTypes\[0\]=전세/);

  const l = zigbang.normalize(raws[0]);
  assert.ok(isValidListing(l));
  assert.equal(l.deposit, 1000);
  assert.equal(l.monthlyRent, 55);
  assert.equal(l.maintenanceFee, 7); // 원 → 만원
  assert.equal(l.areaM2, 19.8);
  assert.equal(l.floor, 3);
  assert.equal(l.addr.dong, '서교동');
  assert.equal(l.addr.sido, '서울');
  assert.equal(l.roomType, '원룸');
  assert.match(l.url, /zigbang\.com\/home\/oneroom\/items\/100/);
});

test('직방: 반지하·옥탑방·빌라 매매', () => {
  assert.equal(zigbang.normalize(zigbangSummary(1, { floor: '반지하' })).floor, -0.5);
  const v = zigbang.normalize(zigbangSummary(2, { service_type: '빌라', sales_type: '매매', deposit: 35000, rent: 0, _category: 'villa' }));
  assert.equal(v.roomType, '빌라');
  assert.equal(v.dealType, '매매');
  assert.match(v.url, /\/home\/villa\//);
});

/* ---------------- 다방 ---------------- */

const dabangRoom = (i, o = {}) => ({
  seq: 1000 + i,
  id: `65a1b2c3d4e5f6a7b8c9d0${String(i).padStart(2, '0')}`,
  roomTypeName: '원룸',
  randomLocation: { lat: 37.5552, lng: 126.9203 },
  roomTitle: '채광 좋은 원룸',
  roomDesc: '3층, 19.83m², 관리비 7만',
  priceTypeName: '월세',
  priceTitle: '1000/55',
  dongName: '서교동',
  ...o,
});

test('다방: 필수 헤더·filters JSON·bbox, hasMore 까지 페이지 순회', async () => {
  routes = [
    ['/one-two/bbox', (url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      return { code: 200, result: { roomList: [dabangRoom(page)], hasMore: page < 2, page } };
    }],
    ['/house-villa/bbox', () => ({ status: 400, body: { code: 400 } })],
    ['/officetel/bbox', () => ({ code: 200, result: { roomList: [], hasMore: false } })],
  ];
  const warnings = [];
  const raws = await dabang.fetchRaw({ ...ctx, warn: (w) => warnings.push(...w) });
  assert.equal(raws.length, 2);
  assert.equal(warnings.length, 1); // house-villa 400 은 경고로만
  const first = calls[0];
  assert.equal(first.init.headers['D-Api-Version'], '5.0.0');
  const sp = new URL(first.url).searchParams;
  const filters = JSON.parse(sp.get('filters'));
  assert.deepEqual(filters.sellingTypeList, ['MONTHLY_RENT', 'LEASE']);
  assert.deepEqual(JSON.parse(sp.get('bbox')).sw, { lat: 37.55, lng: 126.91 });

  const l = dabang.normalize(raws[0]);
  assert.ok(isValidListing(l));
  assert.deepEqual([l.deposit, l.monthlyRent, l.maintenanceFee, l.areaM2, l.floor], [1000, 55, 7, 19.8, 3]);
  assert.equal(l.addr.dong, '서교동');
  assert.equal(l.updatedAt, null); // 날짜 없음 → store 가 최초 수집 시각으로 채움
});

test('다방: 전세·매매 억 단위, 반지하', () => {
  assert.equal(dabang.normalize(dabangRoom(1, { priceTypeName: '전세', priceTitle: '2억5000' })).deposit, 25000);
  assert.equal(dabang.normalize(dabangRoom(1, { roomDesc: '반지하, 23.1m², 관리비 5만' })).floor, -0.5);
  assert.equal(dabang.normalize(dabangRoom(1, { roomTypeName: '투룸' })).roomType, '투룸');
});

/* ---------------- 네이버 ---------------- */

const naverItem = (no, o = {}) => ({
  representativeArticleInfo: {
    articleNumber: String(no),
    articleName: '서교동 원룸',
    tradeType: 'B2',
    realEstateType: 'C01',
    spaceInfo: { supplySpace: 26.4, exclusiveSpace: 19.83 },
    articleDetail: { articleFeatureDescription: '역세권 풀옵션', floorInfo: '3/5', floorDetailInfo: { targetFloor: '3', totalFloor: '5' } },
    address: { city: '서울시', division: '마포구', sector: '서교동', coordinates: { xCoordinate: 126.9202, yCoordinate: 37.5553 } },
    priceInfo: { dealPrice: 0, warrantyPrice: 10000000, rentPrice: 550000, managementFeeAmount: 70000 },
    verificationInfo: { articleConfirmDate: '2026-10-31' },
    articleMedia: { imageUrl: 'https://landthumb.pstatic.net/1.jpg' },
    ...o,
  },
});

test('네이버: lastInfo 로 페이지 순회, bbox 변환, 원 → 만원', async () => {
  routes = [
    ['boundedArticles', (_, init) => {
      const body = JSON.parse(init.body);
      const page = body.articlePagingRequest.lastInfo ? 2 : 1;
      return { isSuccess: true, result: { list: [naverItem(page)], hasNextPage: page === 1, lastInfo: page === 1 ? [123, 'x'] : null } };
    }],
  ];
  const raws = await naver.fetchRaw(ctx);
  assert.equal(raws.length, 2);
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.boundingBox, { left: 126.91, right: 126.925, top: 37.56, bottom: 37.55 });
  assert.deepEqual(JSON.parse(calls[1].init.body).articlePagingRequest.lastInfo, [123, 'x']);

  const l = naver.normalize(raws[0]);
  assert.ok(isValidListing(l));
  assert.deepEqual([l.dealType, l.deposit, l.monthlyRent, l.maintenanceFee, l.areaM2, l.floor, l.totalFloors], ['월세', 1000, 55, 7, 19.8, 3, 5]);
  assert.equal(l.title, '역세권 풀옵션');
  assert.equal(l.lat, 37.5553);
  assert.equal(l.addr.dong, '서교동');
});

test('네이버: 매매가·층 비공개("고/15")', () => {
  const l = naver.normalize(
    naverItem(9, {
      tradeType: 'A1',
      realEstateType: 'A01',
      priceInfo: { dealPrice: 1350000000, warrantyPrice: 0, rentPrice: 0 },
      articleDetail: { floorInfo: '고/15' },
    }),
  );
  assert.deepEqual([l.dealType, l.deposit, l.monthlyRent, l.roomType, l.floor, l.totalFloors], ['매매', 135000, 0, '아파트', null, 15]);
});

test('네이버: 429 를 받으면 재시도하지 않고 쿨다운', async () => {
  routes = [['boundedArticles', () => ({ status: 429, body: {} })]];
  await assert.rejects(naver.fetchRaw(ctx), (err) => err.status === 429);
  const n = calls.length;
  await assert.rejects(naver.fetchRaw(ctx), /대기 중/);
  assert.equal(calls.length, n); // 쿨다운 중엔 요청 자체를 안 보냄
});

/* ---------------- 피터팬 ---------------- */

const peterpanHouse = (hidx, o = {}) => ({
  hidx,
  info: { subject: '신축 풀옵션 원룸', room_type: '원룸', real_size: 19.83 },
  type: { contract_type: '월세' },
  price: { deposit: 10000000, monthly_fee: 550000, maintenance_cost: 70000 },
  floor: { target: '3', total: 5 },
  location: {
    address: { sido: '서울특별시', sigungu: '마포구', dong: '서교동', jibun: '123-4' },
    coordinate: { latitude: 37.5554, longitude: 126.9204 },
  },
  ...o,
});

test('피터팬: 그룹(withoutFee/withFee/recommend)에 흩어진 매물을 중복 없이 수집', () => {
  const res = {
    houses: {
      recommend: { image: [peterpanHouse(1)] },
      withoutFee: { image: [peterpanHouse(1), peterpanHouse(2)], noImage: [peterpanHouse(3)] },
      withFee: { image: [] },
    },
  };
  assert.deepEqual(extractHouses(res).map((h) => h.hidx), [1, 2, 3]);
});

test('피터팬: 정규화 (원 단위 가격, 지번 주소)', async () => {
  routes = [['houses/area', () => ({ houses: { withoutFee: { image: [peterpanHouse(7)] } } })]];
  const raws = await peterpan.fetchRaw(ctx);
  assert.equal(raws.length, 1);
  assert.match(decodeURIComponent(calls[0].url), /latitude:37\.55~37\.56/);
  const l = peterpan.normalize(raws[0]);
  assert.ok(isValidListing(l));
  assert.deepEqual([l.deposit, l.monthlyRent, l.maintenanceFee, l.areaM2, l.floor], [1000, 55, 7, 19.8, 3]);
  assert.equal(l.address, '서울 마포구 서교동 123-4');
  // 만원 단위로 오는 경우도 처리
  const m = peterpan.normalize(peterpanHouse(8, { price: { deposit: 1000, monthly_fee: 55, maintenance_cost: 7 } }));
  assert.deepEqual([m.deposit, m.monthlyRent, m.maintenanceFee], [1000, 55, 7]);
});
