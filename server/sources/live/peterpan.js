import { parseAddress, parseFloor, round1 } from '../../model.js';
import { createClient } from '../../crawl/http.js';
import { bboxCenter } from '../../crawl/geo.js';
import { composeAddress, guessManwon, roomTypeFromText, shortSido, toIso } from './common.js';

/**
 * 피터팬의 좋은방 구하기 크롤러 (비공식 웹 API).
 *
 * ⚠️ 미검증: 다른 세 소스와 달리 공개된 참고 구현을 찾지 못해, 웹사이트가 사용하던 API 형태를 기준으로 작성했다.
 *    응답 형태가 다르면 `npm run crawl -- --source peterpan --dump` 로 원본을 저장해 확인하고
 *    아래 extractHouses()/normalize() 를 맞추면 된다.
 *
 * GET https://api.peterpanz.com/houses/area/pc
 *   ?zoomLevel=15&center={"y":lat,"_lat":lat,"x":lng,"_lng":lng}
 *   &filter=latitude:S~N||longitude:W~E||checkMonth:999~999||contractType;["월세","전세","매매"]||roomType;[...]
 *   &pageSize=90&pageIndex=N
 * → { houses: { withoutFee: { image: [...], noImage: [...] }, withFee: {...}, recommend: {...} } }
 */
const BASE = 'https://api.peterpanz.com/houses/area/pc';
const PAGE_SIZE = 90;

let client;
function http(ctx) {
  client ??= createClient({
    name: 'peterpan',
    minDelayMs: ctx.delayMs ?? 1500,
    headers: { origin: 'https://www.peterpanz.com', referer: 'https://www.peterpanz.com/' },
  });
  return client;
}

const PP_ROOM = { 원룸: '원룸', 투룸: '투룸', '쓰리룸+': '쓰리룸', 오피스텔: '오피스텔', 빌라: '빌라' };

function url(bbox, pageIndex, conditions) {
  const c = bboxCenter(bbox);
  const deals = conditions?.dealTypes ?? ['월세', '전세', '매매'];
  const rooms = (conditions?.roomTypes ?? Object.keys(PP_ROOM)).map((r) => PP_ROOM[r]).filter(Boolean);
  const filter = [
    `latitude:${bbox.south}~${bbox.north}`,
    `longitude:${bbox.west}~${bbox.east}`,
    'checkMonth:999~999',
    `contractType;${JSON.stringify(deals)}`,
    `roomType;${JSON.stringify(rooms.length ? rooms : Object.values(PP_ROOM))}`,
  ].join('||');
  const p = new URLSearchParams({
    zoomLevel: '15',
    center: JSON.stringify({ y: c.lat, _lat: c.lat, x: c.lng, _lng: c.lng }),
    dong: '',
    gungu: '',
    filter,
    filter_version: '5.1',
    pageSize: String(PAGE_SIZE),
    pageIndex: String(pageIndex),
    search: '',
  });
  return `${BASE}?${p}`;
}

/** 응답에서 매물 배열을 찾아 모은다 (그룹 구조가 바뀌어도 hidx 를 가진 객체 배열이면 수집) */
export function extractHouses(res) {
  const out = [];
  const seen = new Set();
  const visit = (node, depth) => {
    if (!node || depth > 5) return;
    if (Array.isArray(node)) {
      if (node.length && node[0] && typeof node[0] === 'object' && 'hidx' in node[0]) {
        for (const h of node) if (!seen.has(h.hidx)) seen.add(h.hidx) && out.push(h);
      } else node.forEach((n) => visit(n, depth + 1));
      return;
    }
    if (typeof node === 'object') Object.values(node).forEach((v) => visit(v, depth + 1));
  };
  visit(res.houses ?? res, 0);
  return out;
}

export default {
  key: 'peterpan',
  name: '피터팬',
  color: '#00a0e9',
  homepage: 'https://www.peterpanz.com',
  verified: false,

  async fetchRaw(ctx) {
    const api = http(ctx);
    const maxPages = ctx.maxPages ?? 5;
    const out = [];
    for (let page = 1; page <= maxPages; page++) {
      let res;
      try {
        res = await api.request(url(ctx.bbox, page, ctx.conditions));
      } catch (err) {
        if (out.length) {
          ctx.warn?.([`page ${page}: ${err.message}`]);
          break;
        }
        throw err;
      }
      const houses = extractHouses(res);
      out.push(...houses);
      if (houses.length < PAGE_SIZE / 3) break; // 그룹별로 나뉘어 오므로 넉넉히 판단
    }
    return out;
  },

  normalize(raw) {
    const info = raw.info ?? {};
    const price = raw.price ?? {};
    const type = raw.type ?? {};
    const loc = raw.location ?? {};
    const coord = loc.coordinate ?? loc.coordinates ?? {};
    const a = loc.address ?? {};
    const addr =
      typeof a === 'string'
        ? parseAddress(a)
        : {
            sido: shortSido(a.sido),
            sigungu: a.sigungu ?? a.gungu ?? '',
            dong: a.dong ?? a.bname ?? '',
            jibun: String(a.jibun ?? a.bunji ?? '').replace(/-0+$/, ''),
          };

    const contract = type.contract_type ?? type.contractType ?? info.contract_type ?? '';
    const dealType = /매매/.test(contract) ? '매매' : /전세/.test(contract) ? '전세' : '월세';
    const floorRaw = raw.floor ?? {};
    const { floor } = parseFloor(floorRaw.target ?? floorRaw.target_floor ?? floorRaw);
    const total = Number(floorRaw.total ?? floorRaw.total_floor) || null;
    const area = Number(info.real_size ?? info.realSize ?? info.supplied_size ?? info.size);
    const deposit = guessManwon(price.deposit, 1_000_000);
    const imgs = raw.images?.S ?? raw.images?.M ?? raw.images ?? [];
    const firstImg = Array.isArray(imgs) ? imgs[0] : null;

    return {
      id: `peterpan:${raw.hidx}`,
      source: 'peterpan',
      sourceId: String(raw.hidx),
      url: `https://www.peterpanz.com/house/${raw.hidx}`,
      title: info.subject ?? info.title ?? '',
      dealType,
      roomType: roomTypeFromText(`${info.room_type ?? ''} ${type.building_type ?? ''} ${info.subject ?? ''}`),
      deposit: dealType === '매매' ? guessManwon(price.sale ?? price.deposit, 1_000_000) : deposit,
      monthlyRent: dealType === '월세' ? guessManwon(price.monthly_fee ?? price.monthlyFee) : 0,
      maintenanceFee: guessManwon(price.maintenance_cost ?? price.maintenanceCost, 1000), // 관리비 1000만원은 없으므로 1000 이상이면 원
      areaM2: round1(area),
      floor,
      totalFloors: total,
      address: composeAddress(addr),
      addr,
      lat: Number(coord.latitude ?? coord.lat),
      lng: Number(coord.longitude ?? coord.lng),
      images: typeof firstImg === 'string' ? [firstImg] : firstImg?.path ? [firstImg.path] : [],
      updatedAt: toIso(raw.updated_at ?? raw.created_at),
    };
  },
};
