import { createHash } from 'node:crypto';
import { addressKey, distanceM } from './model.js';
import { getSources } from './sources/index.js';

/**
 * 같은 실물 매물인지 판단하는 기준.
 * 가격은 플랫폼·중개사마다 다를 수 있으므로 매칭 기준에서 제외한다.
 */
export const MATCH_RULES = {
  maxDistanceM: 40, // 주소가 없거나 다를 때 좌표 거리 허용치
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
  if (ka && kb) return ka === kb && distanceM(a, b) < 300; // 주소가 같으면 동일 (좌표는 터무니없지 않은지만 확인)
  return distanceM(a, b) <= MATCH_RULES.maxDistanceM;
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

  // 동(洞) 단위로 버킷을 나눠 비교 횟수를 줄인다
  const buckets = new Map();
  listings.forEach((l, i) => {
    const key = `${l.addr.sigungu}|${l.addr.dong}|${l.dealType}`;
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
    images: members.flatMap((m) => m.images),
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
 * 모든 소스에서 매물을 수집한다. 일부 소스가 실패해도 나머지 결과로 응답한다.
 */
export async function collect({ timeoutMs = 8000, sources = getSources() } = {}) {
  const results = await Promise.allSettled(
    sources.map(async (src) => {
      const started = Date.now();
      const raws = await withTimeout(Promise.resolve(src.fetchRaw()), timeoutMs, src.key);
      const listings = [];
      let failed = 0;
      for (const raw of raws) {
        try {
          const l = src.normalize(raw);
          if (Number.isFinite(l.deposit) && Number.isFinite(l.areaM2)) listings.push(l);
          else failed++;
        } catch {
          failed++;
        }
      }
      return { src, listings, failed, ms: Date.now() - started };
    }),
  );

  const listings = [];
  const status = [];
  results.forEach((r, i) => {
    const src = sources[i];
    const meta = { key: src.key, name: src.name, color: src.color, homepage: src.homepage };
    if (r.status === 'fulfilled') {
      listings.push(...r.value.listings);
      status.push({ ...meta, ok: true, count: r.value.listings.length, normalizeFailed: r.value.failed, ms: r.value.ms });
    } else {
      status.push({ ...meta, ok: false, count: 0, error: r.reason?.message ?? String(r.reason) });
    }
  });
  return { listings, status };
}

/* ------------------------------------------------------------------ */

const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS ?? 5 * 60 * 1000);
let cache = null;
let inflight = null;

/** 캐시된 통합 데이터. TTL이 지나면 다시 수집한다. */
export async function getAggregated({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache;
  inflight ??= (async () => {
    try {
      const { listings, status } = await collect();
      const groups = dedupe(listings);
      cache = {
        at: Date.now(),
        groups,
        byId: new Map(groups.map((g) => [g.id, g])),
        status,
        stats: { rawCount: listings.length, groupCount: groups.length, duplicatesMerged: listings.length - groups.length },
      };
      return cache;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
