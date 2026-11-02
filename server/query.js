import { monthlyCost } from './aggregator.js';

const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);
const num = (v) => (v === undefined || v === null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** URLSearchParams → 필터 객체 */
export function parseQuery(params) {
  const get = (k) => params.get(k) ?? undefined;
  const bounds = list(get('bounds')).map(Number); // south,west,north,east
  return {
    q: get('q')?.trim() || '',
    dealTypes: list(get('dealType')),
    roomTypes: list(get('roomType')),
    sources: list(get('source')),
    depositMin: num(get('depositMin')),
    depositMax: num(get('depositMax')),
    rentMin: num(get('rentMin')),
    rentMax: num(get('rentMax')),
    areaMin: num(get('areaMin')),
    areaMax: num(get('areaMax')),
    multiSourceOnly: get('multiSourceOnly') === 'true',
    priceGapOnly: get('priceGapOnly') === 'true',
    bounds: bounds.length === 4 && bounds.every(Number.isFinite) ? bounds : null,
    ids: list(get('ids')).slice(0, 500), // 지도에서 선택한 건물의 매물만
    sort: get('sort') || 'recent',
    page: Math.max(1, num(get('page')) ?? 1),
    pageSize: Math.min(200, Math.max(1, num(get('pageSize')) ?? 30)),
  };
}

const inRange = (v, min, max) => (min == null || v >= min) && (max == null || v <= max);

export function applyFilters(groups, f) {
  const terms = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  const ids = f.ids?.length ? new Set(f.ids) : null;
  return groups.filter((g) => {
    if (ids && !ids.has(g.id)) return false;
    if (f.dealTypes.length && !f.dealTypes.includes(g.dealType)) return false;
    if (f.roomTypes.length && !f.roomTypes.includes(g.roomType)) return false;
    if (f.sources.length && !g.sources.some((s) => f.sources.includes(s))) return false;
    if (!inRange(g.deposit, f.depositMin, f.depositMax)) return false;
    if (!inRange(g.monthlyRent, f.rentMin, f.rentMax)) return false;
    if (!inRange(g.areaM2, f.areaMin, f.areaMax)) return false;
    if (f.multiSourceOnly && g.sources.length < 2) return false;
    if (f.priceGapOnly && !g.priceGap) return false;
    if (f.bounds) {
      const [s, w, n, e] = f.bounds;
      if (g.lat < s || g.lat > n || g.lng < w || g.lng > e) return false;
    }
    if (terms.length) {
      const hay = `${g.title} ${g.address} ${g.roomType} ${g.dealType}`.toLowerCase();
      if (!terms.every((t) => hay.includes(t))) return false;
    }
    return true;
  });
}

const SORTERS = {
  recent: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
  priceAsc: (a, b) => monthlyCost(a) - monthlyCost(b) || a.deposit - b.deposit,
  priceDesc: (a, b) => monthlyCost(b) - monthlyCost(a) || b.deposit - a.deposit,
  areaDesc: (a, b) => b.areaM2 - a.areaM2,
  sources: (a, b) => b.sources.length - a.sources.length || SORTERS.recent(a, b),
};

export function sortAndPage(groups, f) {
  const sorted = [...groups].sort(SORTERS[f.sort] ?? SORTERS.recent);
  const start = (f.page - 1) * f.pageSize;
  return {
    total: sorted.length,
    page: f.page,
    pageSize: f.pageSize,
    items: sorted.slice(start, start + f.pageSize),
  };
}
