import './config.js'; // .env 를 먼저 로드
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { addressKey, distanceM } from './model.js';
import { dataMode, getSources } from './sources/index.js';
import { createStore } from './store.js';

/**
 * 같은 실물 매물인지 판단하는 기준.
 * 가격은 플랫폼·중개사마다 다를 수 있으므로 매칭 기준에서 제외한다.
 */
export const MATCH_RULES = {
  maxDistanceM: 40, // 주소가 없거나 다를 때 좌표 거리 허용치
  blurredDistanceM: 300, // 좌표를 흐려서 주는 플랫폼끼리 비교할 때 허용치 (같은 동 + 층·가격 일치 조건과 함께)
  areaTolerancePct: 0.04, // 전용면적 오차 (평↔㎡ 변환 반올림 등)
  areaToleranceM2: 1.0,
};

function areaClose(a, b) {
  const tol = Math.max(MATCH_RULES.areaToleranceM2, Math.max(a, b) * MATCH_RULES.areaTolerancePct);
  return Math.abs(a - b) <= tol;
}

function floorCompatible(a, b) {
  if (a == null || b == null || a === b) return true;
  // "반지하"와 "B1"/"지하1층"은 플랫폼마다 혼용되므로 지하끼리는 같은 층으로 본다
  return a < 1 && b < 1;
}

export function isSameProperty(a, b) {
  if (a.dealType !== b.dealType) return false;
  if (!areaClose(a.areaM2, b.areaM2)) return false;
  if (!floorCompatible(a.floor, b.floor)) return false;
  if (a.totalFloors != null && b.totalFloors != null && a.totalFloors !== b.totalFloors) return false;

  const ka = addressKey(a.addr);
  const kb = addressKey(b.addr);
  const d = distanceM(a, b);
  if (ka && kb) return ka === kb && d < 300; // 주소가 같으면 동일 (좌표는 터무니없지 않은지만 확인)
  if (d <= MATCH_RULES.maxDistanceM) return true;

  // 실제 플랫폼들은 지번을 숨기고 좌표도 일부러 흐린다.
  // → 같은 동 + 층이 둘 다 명시되어 같음 + 가격이 거의 같음 + 가까움 이면 같은 매물로 본다
  const sameDong = a.addr.dong && a.addr.dong === b.addr.dong;
  return Boolean(
    sameDong && a.floor != null && b.floor != null && d <= MATCH_RULES.blurredDistanceM && priceClose(a, b),
  );
}

function priceClose(a, b) {
  const near = (x, y, abs, pct) => Math.abs(x - y) <= Math.max(abs, Math.max(x, y) * pct);
  if (a.dealType === '월세') return near(a.deposit, b.deposit, 500, 0.2) && near(a.monthlyRent, b.monthlyRent, 5, 0.1);
  return near(a.deposit, b.deposit, 0, 0.05);
}

/** 정규화된 매물 목록 → 동일 매물끼리 묶은 그룹 목록 */
export function dedupe(listings) {
  const parent = listings.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i, j) => {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[rj] = ri;
  };

  // 동(洞) 단위로 버킷을 나눠 비교 횟수를 줄인다 (구 이름은 플랫폼마다 없을 수 있어 동만 사용)
  const buckets = new Map();
  listings.forEach((l, i) => {
    const area = l.addr.dong || `geo:${l.lat.toFixed(2)},${l.lng.toFixed(2)}`;
    const key = `${area}|${l.dealType}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(i);
  });

  for (const idxs of buckets.values()) {
    for (let x = 0; x < idxs.length; x++) {
      for (let y = x + 1; y < idxs.length; y++) {
        const a = listings[idxs[x]];
        const b = listings[idxs[y]];
        if (isSameProperty(a, b)) union(idxs[x], idxs[y]);
      }
    }
  }

  const groups = new Map();
  listings.forEach((l, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(l);
  });

  return [...groups.values()].map(buildGroup);
}

function mostCommon(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/** 월 환산 비용 (보증금 전환율 연 5% 가정) — 정렬·최저가 판단용 */
export function monthlyCost(o, conversionRate = 0.05) {
  return o.monthlyRent + (o.deposit * conversionRate) / 12;
}

function priceKey(o) {
  return o.dealType === '월세' ? monthlyCost(o) : o.deposit;
}

function buildGroup(members) {
  const ids = members.map((m) => m.id).sort();
  const id = createHash('sha1').update(ids.join(',')).digest('hex').slice(0, 12);
  const offers = members
    .map((m) => ({
      id: m.id,
      source: m.source,
      sourceId: m.sourceId,
      url: m.url,
      title: m.title,
      dealType: m.dealType,
      deposit: m.deposit,
      monthlyRent: m.monthlyRent,
      maintenanceFee: m.maintenanceFee,
      updatedAt: m.updatedAt,
    }))
    .sort((a, b) => priceKey(a) - priceKey(b));

  const best = offers[0];
  const worst = offers[offers.length - 1];
  const areas = members.map((m) => m.areaM2).sort((a, b) => a - b);
  const withFloor = members.find((m) => m.floor != null);
  const withAddr = members.find((m) => addressKey(m.addr)) ?? members[0];

  return {
    id,
    dealType: best.dealType,
    roomType: mostCommon(members.map((m) => m.roomType)),
    title: members[0].title,
    deposit: best.deposit,
    monthlyRent: best.monthlyRent,
    maintenanceFee: Math.min(...members.map((m) => m.maintenanceFee)),
    areaM2: areas[Math.floor(areas.length / 2)],
    floor: withFloor?.floor ?? null,
    totalFloors: members.find((m) => m.totalFloors != null)?.totalFloors ?? null,
    address: withAddr.address,
    addr: withAddr.addr,
    lat: members.reduce((s, m) => s + m.lat, 0) / members.length,
    lng: members.reduce((s, m) => s + m.lng, 0) / members.length,
    images: members.flatMap((m) => m.images).slice(0, 6),
    updatedAt: members.map((m) => m.updatedAt).sort().at(-1),
    sources: [...new Set(members.map((m) => m.source))],
    offers,
    // 플랫폼 간 가격 차이 (같은 매물인데 더 싸게 올라온 곳이 있는지)
    priceGap:
      offers.length > 1 && priceKey(worst) !== priceKey(best)
        ? { deposit: worst.deposit - best.deposit, monthlyRent: worst.monthlyRent - best.monthlyRent }
        : null,
  };
}

/* ------------------------------------------------------------------ */

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout (${ms}ms)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 소스 하나에서 수집 → 정규화 → 검증. 실패하면 예외.
 */
export async function collectOne(src, ctx = {}, timeoutMs = 8000) {
  const started = Date.now();
  const warnings = [];
  const raws = await withTimeout(
    Promise.resolve(src.fetchRaw({ ...ctx, warn: (msgs) => warnings.push(...(msgs ?? [])) })),
    timeoutMs,
    src.key,
  );
  const listings = [];
  let failed = 0;
  for (const raw of raws ?? []) {
    try {
      const l = src.normalize(raw);
      if (isValidListing(l)) listings.push(l);
      else failed++;
    } catch {
      failed++;
    }
  }
  return { listings, failed, warnings: warnings.slice(0, 10), ms: Date.now() - started };
}

/**
 * 모든 소스에서 매물을 수집한다. 일부 소스가 실패해도 나머지 결과로 응답한다.
 * ctx 는 각 어댑터의 fetchRaw(ctx) 로 전달된다 (bbox, conditions, maxPages 등).
 */
export async function collect({ timeoutMs = 8000, sources = getSources(), ctx = {} } = {}) {
  const results = await Promise.allSettled(sources.map((src) => collectOne(src, ctx, timeoutMs)));
  const listings = [];
  const status = [];
  results.forEach((r, i) => {
    const src = sources[i];
    const meta = { key: src.key, name: src.name, color: src.color, homepage: src.homepage };
    if (r.status === 'fulfilled') {
      listings.push(...r.value.listings);
      status.push({ ...meta, ok: true, count: r.value.listings.length, normalizeFailed: r.value.failed, warnings: r.value.warnings, ms: r.value.ms });
    } else {
      status.push({ ...meta, ok: false, count: 0, error: r.reason?.message ?? String(r.reason) });
    }
  });
  return { listings, status };
}

const DEALS = new Set(['매매', '전세', '월세']);
export function isValidListing(l) {
  return (
    l &&
    DEALS.has(l.dealType) &&
    Number.isFinite(l.deposit) &&
    Number.isFinite(l.monthlyRent) &&
    Number.isFinite(l.areaM2) &&
    l.areaM2 > 0 &&
    Number.isFinite(l.lat) &&
    Number.isFinite(l.lng)
  );
}

/* ------------------------------------------------------------------ */

/** 기본 저장소 (서버에서 사용). 테스트는 별도 store 를 만들어 쓴다. */
export const defaultStore = createStore({
  // 모드별로 파일을 분리해 가상 데이터와 실제 데이터가 섞이지 않게 한다
  file: process.env.NODE_ENV === 'test' ? null : fileURLToPath(new URL(`../data/listings.${dataMode()}.json`, import.meta.url)),
});

let cache = null;

/** store 내용이 바뀌었을 때만 중복 통합을 다시 계산 */
export function getAggregated(store = defaultStore) {
  if (cache && cache.store === store && cache.version === store.version) return cache;
  const listings = store.listings();
  const groups = dedupe(listings);
  cache = {
    store,
    version: store.version,
    at: Date.now(),
    groups,
    byId: new Map(groups.map((g) => [g.id, g])),
    stats: { rawCount: listings.length, groupCount: groups.length, duplicatesMerged: listings.length - groups.length },
  };
  return cache;
}
