import { parseAddress, parseFloor, round1 } from '../model.js';
import { baseListings, jitterCoord, jitterPrice, sourceRand } from './seed.js';

/**
 * 직방 어댑터 (데모용 목업).
 *
 * 원본 형태: 가격은 만원, 면적은 ㎡, 층은 "3층" 문자열, 주소는 "서울시 ..." 표기.
 * 실제 연동 시 fetchRaw()만 제휴 API 호출로 교체하면 된다.
 */
const ROOM_TYPE_MAP = { 원룸: '원룸', 투룸: '투룸', 쓰리룸: '쓰리룸+', 오피스텔: '오피스텔', 아파트: '아파트', 빌라: '빌라' };

export default {
  key: 'zigbang',
  name: '직방',
  color: '#ff7a00',
  homepage: 'https://www.zigbang.com',

  async fetchRaw() {
    return baseListings()
      .filter((b) => b.onZigbang)
      .map((b) => {
        const r = sourceRand(b, 'zigbang');
        const price = jitterPrice(b, r, 500);
        const { lat, lng } = jitterCoord(b, r);
        return {
          item_id: 30000000 + b.baseId * 7,
          sales_type: b.dealType,
          service_type: b.roomType === '쓰리룸+' ? '쓰리룸' : b.roomType,
          deposit: price.deposit,
          rent: price.monthlyRent,
          manage_cost: b.maintenanceFee,
          size_m2: b.areaM2,
          floor: b.floor === -0.5 ? '반지하' : `${b.floor}층`,
          building_floor: `${b.totalFloors}`,
          address: `서울시 ${b.sigungu} ${b.dong} ${b.jibun}`,
          location: { lat, lng },
          title: b.title,
          images: [],
          updated_at: b.updatedAt,
        };
      });
  },

  normalize(raw) {
    const addr = parseAddress(raw.address);
    const { floor } = parseFloor(raw.floor);
    return {
      id: `zigbang:${raw.item_id}`,
      source: 'zigbang',
      sourceId: String(raw.item_id),
      url: `https://www.zigbang.com/home/oneroom/items/${raw.item_id}`,
      title: raw.title,
      dealType: raw.sales_type,
      roomType: ROOM_TYPE_MAP[raw.service_type] ?? '원룸',
      deposit: raw.deposit,
      monthlyRent: raw.rent ?? 0,
      maintenanceFee: raw.manage_cost ?? 0,
      areaM2: round1(raw.size_m2),
      floor,
      totalFloors: Number(raw.building_floor) || null,
      address: `${addr.sido} ${addr.sigungu} ${addr.dong} ${addr.jibun}`.trim(),
      addr,
      lat: raw.location.lat,
      lng: raw.location.lng,
      images: raw.images,
      updatedAt: raw.updated_at,
    };
  },
};
