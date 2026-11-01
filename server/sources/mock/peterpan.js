import peterpanLive from '../live/peterpan.js';
import { baseListings, jitterCoord, jitterPrice, sourceRand } from './seed.js';

/**
 * 피터팬 목업 — 실제 크롤러(live/peterpan.js)가 기대하는 원본 형태로 만들어
 * 같은 normalize() 를 그대로 사용한다. 피터팬은 가격을 "원" 단위로 준다고 가정.
 */
export default {
  ...peterpanLive,
  async fetchRaw() {
    return baseListings()
      .filter((b) => b.onPeterpan)
      .map((b) => {
        const r = sourceRand(b, 'peterpan');
        const price = jitterPrice(b, r, 500);
        const { lat, lng } = jitterCoord(b, r);
        const [bunji, ho] = b.jibun.split('-');
        return {
          hidx: 900000 + b.baseId * 3,
          info: { subject: b.title, room_type: b.roomType === '쓰리룸+' ? '쓰리룸' : b.roomType, real_size: b.areaM2 },
          type: { contract_type: b.dealType },
          price: {
            deposit: price.deposit * 10000,
            monthly_fee: price.monthlyRent * 10000,
            maintenance_cost: b.maintenanceFee * 10000,
          },
          floor: { target: b.floor === -0.5 ? '반지하' : String(b.floor), total: b.totalFloors },
          location: {
            address: { sido: '서울특별시', sigungu: b.sigungu, dong: b.dong, jibun: ho ? `${bunji}-${ho}` : bunji },
            coordinate: { latitude: lat, longitude: lng },
          },
          images: { S: [] },
          updated_at: b.updatedAt,
        };
      });
  },
};
