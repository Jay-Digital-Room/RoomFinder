import { PYEONG_TO_M2, parseAddress, parseKoreanMoney, parseFloor, round1 } from '../model.js';
import { baseListings, jitterCoord, jitterPrice, sourceRand } from './seed.js';

/**
 * 다방 어댑터 (데모용 목업).
 *
 * 원본 형태: 거래유형이 숫자 코드, 가격은 "1000/50" 같은 문자열,
 * 면적은 평(소수점), 좌표는 [lng, lat] 배열, 주소는 "서울특별시 ... 번지" 표기.
 */
const PRICE_TYPE = { 0: '월세', 1: '전세', 2: '매매' };
const PRICE_TYPE_REV = { 월세: 0, 전세: 1, 매매: 2 };
const ROOM_TYPE = { 0: '원룸', 1: '투룸', 2: '쓰리룸+', 3: '오피스텔', 4: '아파트', 5: '빌라' };
const ROOM_TYPE_REV = Object.fromEntries(Object.entries(ROOM_TYPE).map(([k, v]) => [v, Number(k)]));

function formatKoreanMoney(manwon) {
  const eok = Math.floor(manwon / 10000);
  const rest = manwon % 10000;
  if (!eok) return String(rest);
  return rest ? `${eok}억${rest}` : `${eok}억`;
}

export default {
  key: 'dabang',
  name: '다방',
  color: '#3366ff',
  homepage: 'https://www.dabangapp.com',

  async fetchRaw() {
    return baseListings()
      .filter((b) => b.onDabang)
      .map((b) => {
        const r = sourceRand(b, 'dabang');
        const price = jitterPrice(b, r, 1000);
        const { lat, lng } = jitterCoord(b, r);
        const priceTitle =
          b.dealType === '월세'
            ? `${formatKoreanMoney(price.deposit)}/${price.monthlyRent}`
            : formatKoreanMoney(price.deposit);
        return {
          id: `5f${(b.baseId * 2654435761 >>> 0).toString(16)}`,
          price_type: PRICE_TYPE_REV[b.dealType],
          room_type: ROOM_TYPE_REV[b.roomType],
          price_title: priceTitle,
          maintenance_cost: b.maintenanceFee * 10000, // 원 단위
          room_size: Math.round((b.areaM2 / PYEONG_TO_M2) * 100) / 100, // 평
          floor_string: b.floor === -0.5 ? `반지하/${b.totalFloors}` : `${b.floor}/${b.totalFloors}`,
          jibun_address: `서울특별시 ${b.sigungu} ${b.dong} ${b.jibun}번지`,
          random_location: [lng, lat],
          title: b.title.replace(/\s+/g, ' '),
          img_urls: [],
          saved_time_str: b.updatedAt,
        };
      });
  },

  normalize(raw) {
    const addr = parseAddress(raw.jibun_address);
    const { floor, totalFloors } = parseFloor(raw.floor_string);
    const dealType = PRICE_TYPE[raw.price_type];
    let deposit;
    let monthlyRent = 0;
    if (dealType === '월세') {
      const [d, m] = raw.price_title.split('/');
      deposit = parseKoreanMoney(d);
      monthlyRent = Number(m);
    } else {
      deposit = parseKoreanMoney(raw.price_title);
    }
    return {
      id: `dabang:${raw.id}`,
      source: 'dabang',
      sourceId: raw.id,
      url: `https://www.dabangapp.com/room/${raw.id}`,
      title: raw.title,
      dealType,
      roomType: ROOM_TYPE[raw.room_type] ?? '원룸',
      deposit,
      monthlyRent,
      maintenanceFee: Math.round(raw.maintenance_cost / 10000),
      areaM2: round1(raw.room_size * PYEONG_TO_M2),
      floor,
      totalFloors,
      address: `${addr.sido} ${addr.sigungu} ${addr.dong} ${addr.jibun}`.trim(),
      addr,
      lat: raw.random_location[1],
      lng: raw.random_location[0],
      images: raw.img_urls,
      updatedAt: raw.saved_time_str,
    };
  },
};
