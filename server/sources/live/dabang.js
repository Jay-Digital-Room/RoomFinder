import { parseKoreanMoney, round1 } from '../../model.js';
import { createClient } from '../../crawl/http.js';
import { splitBbox } from '../../crawl/geo.js';
import { parseRoomDesc, roomTypeFromText, toIso } from './common.js';

/**
 * 다방 크롤러 (비공식 웹 API v5).
 *
 * GET /api/v5/room-list/category/{one-two|house-villa|officetel}/bbox
 *     ?filters=<JSON>&bbox={"sw":{lat,lng},"ne":{lat,lng}}&zoom=16&useMap=naver&page=N
 * → { code, result: { roomList: [...], hasMore, page } }  (페이지당 24개)
 *
 * roomList 항목: id, seq, roomTypeName, roomTitle, roomDesc("5층, 19.83m², 관리비 7만"),
 *               priceTypeName(월세/전세/매매), priceTitle("1000/63" | "3억9000", 만원), randomLocation{lat,lng}, dongName
 * 주의: 다방은 정확한 주소/좌표를 주지 않는다(randomLocation 은 의도적으로 흐린 값).
 */
const BASE = 'https://www.dabangapp.com/api/v5/room-list/category';
const RANGE = { min: 0, max: 999999 };

// 서버가 모든 키를 요구함 (누락 시 400)
const FILTERS = {
  'one-two': {
    sellingTypeList: ['MONTHLY_RENT', 'LEASE'],
    depositRange: RANGE,
    priceRange: RANGE,
    isIncludeMaintenance: false,
    pyeongRange: RANGE,
    useApprovalDateRange: RANGE,
    // 빈 배열 = 조건 없음
    roomFloorList: [],
    roomTypeList: [],
    dealTypeList: ['AGENT'],
    canParking: false,
    isShortLease: false,
    hasElevator: false,
    hasPano: false,
    isDivision: false,
    isDuplex: false,
  },
};
// 빌라/오피스텔 필터 키는 확인되지 않아 원룸·투룸 필터를 기반으로 시도한다 (실패해도 다른 카테고리는 계속)
const CATEGORIES = [
  { key: 'one-two', roomTypes: ['원룸', '투룸'], selling: ['MONTHLY_RENT', 'LEASE'] },
  { key: 'house-villa', roomTypes: ['빌라', '투룸', '쓰리룸+'], selling: ['MONTHLY_RENT', 'LEASE', 'SELL'] },
  { key: 'officetel', roomTypes: ['오피스텔'], selling: ['MONTHLY_RENT', 'LEASE', 'SELL'] },
];
const SELLING = { 월세: 'MONTHLY_RENT', 전세: 'LEASE', 매매: 'SELL' };

/** 수집 조건에 맞는 카테고리·거래유형만 남긴다 */
export function plan(conditions) {
  if (!conditions) return CATEGORIES;
  const wanted = conditions.dealTypes.map((d) => SELLING[d]);
  return CATEGORIES.filter((c) => c.roomTypes.some((r) => conditions.roomTypes.includes(r)))
    .map((c) => ({ ...c, selling: c.selling.filter((s) => wanted.includes(s)) }))
    .filter((c) => c.selling.length);
}

let client;
function http(ctx) {
  client ??= createClient({
    name: 'dabang',
    minDelayMs: ctx.delayMs ?? 1000,
    headers: {
      'D-Api-Version': '5.0.0',
      'D-App-Version': '1',
      'D-Call-Type': 'web',
      csrf: 'token',
      referer: 'https://www.dabangapp.com/',
    },
  });
  return client;
}

function url(cat, tile, page, conditions) {
  const category = cat.key;
  const filters = {
    ...FILTERS['one-two'],
    sellingTypeList: cat.selling,
    depositRange: { min: 0, max: conditions?.depositMax ?? RANGE.max },
    priceRange: { min: 0, max: conditions?.rentMax ?? RANGE.max },
  };
  const p = new URLSearchParams({
    filters: JSON.stringify(filters),
    bbox: JSON.stringify({ sw: { lat: tile.south, lng: tile.west }, ne: { lat: tile.north, lng: tile.east } }),
    zoom: '16',
    useMap: 'naver',
    page: String(page),
  });
  return `${BASE}/${category}/bbox?${p}`;
}

export default {
  key: 'dabang',
  name: '다방',
  color: '#3366ff',
  homepage: 'https://www.dabangapp.com',

  async fetchRaw(ctx) {
    const api = http(ctx);
    const maxPages = ctx.maxPages ?? 5;
    const out = [];
    const errors = [];
    // 줌 16 화면 크기 정도로 나눠 요청
    const tiles = splitBbox(ctx.bbox, 0.02);

    for (const cat of plan(ctx.conditions)) {
      for (const tile of tiles) {
        for (let page = 1; page <= maxPages; page++) {
          let res;
          try {
            res = await api.request(url(cat, tile, page, ctx.conditions));
          } catch (err) {
            errors.push(`${cat.key} p${page}: ${err.message}`);
            break;
          }
          const r = res.result ?? res;
          for (const room of r.roomList ?? []) out.push({ ...room, _category: cat.key });
          if (!r.hasMore) break;
        }
      }
    }
    if (!out.length && errors.length) throw new Error(errors.slice(0, 3).join(' / '));
    ctx.warn?.(errors);
    return out;
  },

  normalize(raw) {
    const desc = parseRoomDesc(raw.roomDesc);
    const dealType = raw.priceTypeName;
    let deposit;
    let monthlyRent = 0;
    if (dealType === '월세' && String(raw.priceTitle).includes('/')) {
      const [d, m] = String(raw.priceTitle).split('/');
      deposit = parseKoreanMoney(d);
      monthlyRent = parseKoreanMoney(m);
    } else {
      deposit = parseKoreanMoney(raw.priceTitle);
    }
    const loc = raw.randomLocation ?? raw.random_location ?? {};
    const lat = Number(loc.lat ?? (Array.isArray(loc) ? loc[1] : NaN));
    const lng = Number(loc.lng ?? (Array.isArray(loc) ? loc[0] : NaN));
    const dong = raw.dongName ?? '';
    const addr = { sido: '', sigungu: '', dong, jibun: '' };

    return {
      id: `dabang:${raw.id}`,
      source: 'dabang',
      sourceId: String(raw.id),
      url: `https://www.dabangapp.com/room/${raw.id}`,
      title: raw.roomTitle ?? raw.complexName ?? '',
      dealType,
      roomType: roomTypeFromText(raw.roomTypeName, raw._category === 'officetel' ? '오피스텔' : raw._category === 'house-villa' ? '빌라' : '원룸'),
      deposit,
      monthlyRent,
      maintenanceFee: desc.maintenanceFee,
      areaM2: round1(desc.areaM2),
      floor: desc.floor,
      totalFloors: null,
      address: [raw.complexName, dong].filter(Boolean).join(' · ') || dong,
      addr,
      lat,
      lng,
      images: raw.imgUrlList?.length ? [raw.imgUrlList[0]] : raw.imgUrl ? [raw.imgUrl] : [],
      updatedAt: toIso(raw.updatedAt ?? raw.saved_time), // 목록 API에 날짜가 없으면 null → 최초 수집 시각으로 채움
    };
  },
};
