import { parseAddress, parseFloor, round1 } from '../../model.js';
import { createClient } from '../../crawl/http.js';
import { geohashesForBbox, inBbox } from '../../crawl/geo.js';
import { composeAddress, roomTypeFromText, shortSido, toIso } from './common.js';

/**
 * 직방 크롤러 (비공식 웹 API).
 *
 * 1) GET  /house/property/v1/items/{onerooms|villas|officetels}?geohash=xxxxx&salesTypes[0]=..
 *    → 지도 핀 목록 { items: [{ id, lat, lng }] }  (가격 없음)
 * 2) POST /house/property/v1/items/list  { itemIds: [...최대 15개] }
 *    → 매물 요약 { items: [ItemSummary] }
 *
 * 단위: deposit/rent 만원, manage_cost 원(문자열), size_m2 ㎡. 좌표(location)는 직방이 일부러 흐린 값.
 */
const BASE = 'https://apis.zigbang.com';
const CATEGORIES = [
  { path: 'onerooms', salesTypes: ['전세', '월세'], web: 'oneroom' },
  { path: 'villas', salesTypes: ['전세', '월세', '매매'], web: 'villa' },
  { path: 'officetels', salesTypes: ['전세', '월세', '매매'], web: 'officetel' },
];
const BATCH = 15;

let client;
function http(ctx) {
  client ??= createClient({
    name: 'zigbang',
    minDelayMs: ctx.delayMs ?? 1000,
    headers: {
      accept: 'application/json',
      origin: 'https://www.zigbang.com',
      referer: 'https://www.zigbang.com/',
      'x-zigbang-platform': 'www',
    },
  });
  return client;
}

function listUrl(cat, geohash) {
  const p = new URLSearchParams({ geohash });
  cat.salesTypes.forEach((t, i) => p.append(`salesTypes[${i}]`, t));
  return `${BASE}/house/property/v1/items/${cat.path}?${p}`;
}

// 직방 room_type 코드 (원룸 서비스 기준, 추정): 01 오픈형, 02 분리형, 03 복층형, 04 투룸, 05 쓰리룸+
const ZIGBANG_ROOM_CODE = { '01': '원룸', '02': '원룸', '03': '원룸', '04': '투룸', '05': '쓰리룸+', '06': '쓰리룸+' };

export default {
  key: 'zigbang',
  name: '직방',
  color: '#ff7a00',
  homepage: 'https://www.zigbang.com',

  async fetchRaw(ctx) {
    const api = http(ctx);
    const out = [];
    const errors = [];
    const maxItems = ctx.maxItems ?? 300;

    for (const cat of CATEGORIES) {
      const ids = [];
      for (const gh of geohashesForBbox(ctx.bbox, 5)) {
        try {
          const res = await api.request(listUrl(cat, gh));
          for (const it of res.items ?? []) {
            if (inBbox({ lat: it.lat, lng: it.lng }, ctx.bbox)) ids.push(it.id ?? it.itemId ?? it.item_id);
          }
        } catch (err) {
          errors.push(`${cat.path}/${gh}: ${err.message}`);
        }
      }
      const unique = [...new Set(ids.filter(Boolean))].slice(0, Math.max(0, maxItems - out.length));
      for (let i = 0; i < unique.length; i += BATCH) {
        try {
          const res = await api.request(`${BASE}/house/property/v1/items/list`, {
            method: 'POST',
            body: { itemIds: unique.slice(i, i + BATCH) },
          });
          for (const item of res.items ?? []) out.push({ ...item, _category: cat.web });
        } catch (err) {
          errors.push(`items/list: ${err.message}`);
        }
      }
      if (out.length >= maxItems) break;
    }
    if (!out.length && errors.length) throw new Error(errors.slice(0, 3).join(' / '));
    ctx.warn?.(errors);
    return out;
  },

  normalize(raw) {
    const o = raw.address_origin ?? {};
    const addr = o.local2
      ? { sido: shortSido(o.local1), sigungu: o.local2, dong: o.local3 ?? '', jibun: '' }
      : parseAddress(raw.address1 ?? raw.address ?? '');
    const { floor } = parseFloor(raw.floor ?? raw.floor_string);
    const area = raw.exclusive_area?.m2 ?? raw.size_m2;
    const service = raw.service_type ?? '';
    const roomType =
      service === '원룸' ? ZIGBANG_ROOM_CODE[raw.room_type] ?? roomTypeFromText(raw.title) : roomTypeFromText(service, roomTypeFromText(raw.title));
    const loc = raw.location ?? raw.random_location ?? {};
    const category = raw._category ?? 'oneroom';
    const thumb = raw.images_thumbnail;

    return {
      id: `zigbang:${raw.item_id}`,
      source: 'zigbang',
      sourceId: String(raw.item_id),
      url: `https://www.zigbang.com/home/${category}/items/${raw.item_id}`,
      title: raw.title ?? '',
      dealType: raw.sales_type,
      roomType,
      deposit: Number(raw.deposit),
      monthlyRent: Number(raw.rent ?? 0),
      maintenanceFee: Math.round(Number(String(raw.manage_cost ?? 0).replace(/[^\d.]/g, '') || 0) / 10000),
      areaM2: round1(Number(area)),
      floor,
      totalFloors: Number(raw.building_floor) || null,
      address: composeAddress(addr),
      addr,
      lat: Number(loc.lat),
      lng: Number(loc.lng),
      images: thumb ? [thumb] : [],
      updatedAt: toIso(raw.reg_date ?? raw.updated_at),
    };
  },
};
