import { parseAddress, parseFloor, parseKoreanMoney, round1 } from '../../model.js';
import { baseListings, jitterCoord, jitterPrice, sourceRand } from './seed.js';

/**
 * 네이버 부동산 어댑터 (데모용 목업).
 *
 * 원본 형태: 필드명이 약어(atclNo, tradTpNm ...), 가격은 "2억 1,000" 문자열,
 * 층은 "3/15" 또는 "고/15", 주소에서 시·도가 생략되는 경우가 있음.
 */
const RLET_MAP = { 원룸: '원룸', 투룸: '투룸', 쓰리룸: '쓰리룸+', 오피스텔: '오피스텔', 아파트: '아파트', 빌라: '빌라' };

function formatNaverPrice(manwon) {
  const eok = Math.floor(manwon / 10000);
  const rest = manwon % 10000;
  const restStr = rest.toLocaleString('en-US');
  if (!eok) return restStr;
  return rest ? `${eok}억 ${restStr}` : `${eok}억`;
}

export default {
  key: 'naver',
  name: '네이버부동산',
  color: '#03c75a',
  homepage: 'https://land.naver.com',

  async fetchRaw() {
    return baseListings()
      .filter((b) => b.onNaver)
      .map((b) => {
        const r = sourceRand(b, 'naver');
        const price = jitterPrice(b, r, 500);
        const { lat, lng } = jitterCoord(b, r);
        // 네이버는 고층 아파트의 경우 층수를 "고/중/저"로만 공개하기도 함
        let flr;
        if (b.floor === -0.5) flr = `B1/${b.totalFloors}`;
        else if (b.roomType === '아파트' && r() < 0.5) {
          const ratio = b.floor / b.totalFloors;
          flr = `${ratio > 0.66 ? '고' : ratio > 0.33 ? '중' : '저'}/${b.totalFloors}`;
        } else flr = `${b.floor}/${b.totalFloors}`;

        return {
          atclNo: String(2600000000 + b.baseId * 13),
          atclNm: b.title,
          rletTpNm: b.roomType === '쓰리룸+' ? '쓰리룸' : b.roomType,
          tradTpNm: b.dealType,
          prc: formatNaverPrice(price.deposit),
          rentPrc: b.dealType === '월세' ? String(price.monthlyRent) : '',
          mngFee: b.maintenanceFee,
          spc2: b.areaM2.toFixed(2), // 전용면적 문자열
          flrInfo: flr,
          addr: `${b.sigungu} ${b.dong} ${b.jibun}`,
          lat,
          lng,
          repImgUrl: null,
          cfmYmd: b.updatedAt.slice(0, 10).replace(/-/g, '.'),
        };
      });
  },

  normalize(raw) {
    const addr = parseAddress(raw.addr);
    const { floor, totalFloors } = parseFloor(raw.flrInfo);
    return {
      id: `naver:${raw.atclNo}`,
      source: 'naver',
      sourceId: raw.atclNo,
      url: `https://new.land.naver.com/articles/${raw.atclNo}`,
      title: raw.atclNm,
      dealType: raw.tradTpNm,
      roomType: RLET_MAP[raw.rletTpNm] ?? '원룸',
      deposit: parseKoreanMoney(raw.prc),
      monthlyRent: raw.rentPrc ? Number(raw.rentPrc) : 0,
      maintenanceFee: raw.mngFee ?? 0,
      areaM2: round1(Number(raw.spc2)),
      floor, // "고/15" 처럼 층이 비공개면 null
      totalFloors,
      address: `${addr.sido} ${addr.sigungu} ${addr.dong} ${addr.jibun}`.trim(),
      addr,
      lat: raw.lat,
      lng: raw.lng,
      images: raw.repImgUrl ? [raw.repImgUrl] : [],
      updatedAt: new Date(`${raw.cfmYmd.replace(/\./g, '-')}T00:00:00+09:00`).toISOString(),
    };
  },
};
