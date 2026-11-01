/**
 * 데모용 가상 매물 데이터.
 *
 * 실제 서비스에서는 각 플랫폼과의 제휴 API / 중개사 직접 등록 / 공공데이터 등으로 대체된다.
 * (README의 "데이터 수집과 법적 이슈" 참고)
 *
 * 같은 "실물 매물"이 여러 플랫폼에 조금씩 다른 표기·가격으로 올라오는 현실을 흉내내기 위해,
 * 하나의 기준 매물(BASE)에서 플랫폼별 원본(raw) 데이터를 파생시킨다.
 */

// 결정적(deterministic) 난수 — 서버를 재시작해도 같은 데이터가 나오도록
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NEIGHBORHOODS = [
  { sigungu: '마포구', dong: '서교동', lat: 37.5552, lng: 126.9195, station: '홍대입구역' },
  { sigungu: '마포구', dong: '망원동', lat: 37.5563, lng: 126.9019, station: '망원역' },
  { sigungu: '관악구', dong: '봉천동', lat: 37.4816, lng: 126.9527, station: '서울대입구역' },
  { sigungu: '관악구', dong: '신림동', lat: 37.4842, lng: 126.9297, station: '신림역' },
  { sigungu: '강남구', dong: '역삼동', lat: 37.5006, lng: 127.0366, station: '역삼역' },
  { sigungu: '강남구', dong: '논현동', lat: 37.5112, lng: 127.0286, station: '신논현역' },
  { sigungu: '성동구', dong: '성수동1가', lat: 37.5446, lng: 127.0560, station: '성수역' },
  { sigungu: '광진구', dong: '화양동', lat: 37.5466, lng: 127.0703, station: '건대입구역' },
  { sigungu: '송파구', dong: '잠실동', lat: 37.5133, lng: 127.1001, station: '잠실역' },
  { sigungu: '영등포구', dong: '여의도동', lat: 37.5219, lng: 126.9245, station: '여의도역' },
];

const ROOM_PROFILES = [
  { roomType: '원룸', area: [16, 26], floors: [2, 6], weight: 4 },
  { roomType: '투룸', area: [30, 45], floors: [2, 6], weight: 2 },
  { roomType: '쓰리룸+', area: [50, 70], floors: [2, 5], weight: 1 },
  { roomType: '오피스텔', area: [20, 40], floors: [5, 20], weight: 2 },
  { roomType: '아파트', area: [59, 115], floors: [10, 30], weight: 2 },
  { roomType: '빌라', area: [40, 65], floors: [3, 5], weight: 1 },
];

const ADJECTIVES = ['풀옵션', '신축', '역세권', '채광좋은', '깔끔한', '넓은', '조용한', '주차가능', '엘리베이터', '분리형'];

function pickWeighted(rand, items) {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = rand() * total;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

const int = (rand, min, max) => Math.floor(rand() * (max - min + 1)) + min;
const roundTo = (n, unit) => Math.round(n / unit) * unit;

function priceFor(rand, roomType, dealType, areaM2, premium) {
  // 아주 거친 시세 모델 (만원 단위)
  const salePerM2 = { 원룸: 900, 투룸: 850, '쓰리룸+': 800, 오피스텔: 950, 아파트: 1700, 빌라: 700 }[roomType];
  const sale = roundTo(salePerM2 * areaM2 * premium * (0.9 + rand() * 0.2), 500);
  if (dealType === '매매') return { deposit: sale, monthlyRent: 0 };
  if (dealType === '전세') return { deposit: roundTo(sale * (0.55 + rand() * 0.15), 500), monthlyRent: 0 };
  const deposit = [500, 1000, 1000, 2000, 3000, 5000][int(rand, 0, 5)];
  const monthlyRent = roundTo(Math.max(35, (sale * 0.0035 - deposit * 0.004) * (0.9 + rand() * 0.2)), 5);
  return { deposit, monthlyRent };
}

/** 기준(실물) 매물 목록 생성 */
export function generateBaseListings(count = 80, seed = 20261101) {
  const rand = mulberry32(seed);
  const premiumBySigungu = { 강남구: 1.6, 송파구: 1.4, 성동구: 1.3, 영등포구: 1.25, 마포구: 1.2, 광진구: 1.1, 관악구: 0.85 };
  const now = Date.parse('2026-11-01T09:00:00+09:00');
  const list = [];

  for (let i = 0; i < count; i++) {
    const hood = NEIGHBORHOODS[int(rand, 0, NEIGHBORHOODS.length - 1)];
    const profile = pickWeighted(rand, ROOM_PROFILES);
    const dealRoll = rand();
    const dealType =
      profile.roomType === '아파트'
        ? dealRoll < 0.45 ? '매매' : dealRoll < 0.85 ? '전세' : '월세'
        : dealRoll < 0.1 ? '매매' : dealRoll < 0.35 ? '전세' : '월세';

    const areaM2 = Math.round((profile.area[0] + rand() * (profile.area[1] - profile.area[0])) * 100) / 100;
    const totalFloors = int(rand, profile.floors[0], profile.floors[1]);
    const floorRoll = rand();
    const floor = floorRoll < 0.06 && totalFloors <= 6 ? -0.5 : int(rand, 1, totalFloors);
    const premium = premiumBySigungu[hood.sigungu] ?? 1;
    const { deposit, monthlyRent } = priceFor(rand, profile.roomType, dealType, areaM2, premium);
    const bunji = int(rand, 1, 999);
    const ho = rand() < 0.6 ? int(rand, 1, 40) : 0;

    list.push({
      baseId: i + 1,
      dealType,
      roomType: profile.roomType,
      areaM2,
      floor,
      totalFloors,
      deposit,
      monthlyRent,
      maintenanceFee: profile.roomType === '아파트' ? int(rand, 15, 35) : int(rand, 3, 15),
      sigungu: hood.sigungu,
      dong: hood.dong,
      jibun: ho ? `${bunji}-${ho}` : `${bunji}`,
      lat: hood.lat + (rand() - 0.5) * 0.012,
      lng: hood.lng + (rand() - 0.5) * 0.014,
      title: `${hood.station} ${ADJECTIVES[int(rand, 0, ADJECTIVES.length - 1)]} ${profile.roomType}`,
      updatedAt: new Date(now - int(rand, 0, 14 * 24) * 3600 * 1000).toISOString(),
      // 어떤 플랫폼에 올라와 있는지 (최소 1곳)
      onZigbang: rand() < 0.6,
      onDabang: rand() < 0.55,
      onNaver: rand() < 0.65,
      onPeterpan: rand() < 0.4,
    });
    const last = list[list.length - 1];
    if (!last.onZigbang && !last.onDabang && !last.onNaver && !last.onPeterpan) last.onNaver = true;
  }
  return list;
}

let cached;
export function baseListings() {
  cached ??= generateBaseListings();
  return cached;
}

/** 소스·매물별 독립 난수 (호출 순서와 무관하게 항상 같은 결과) */
export function sourceRand(base, sourceKey) {
  let h = 2166136261;
  for (const ch of `${sourceKey}:${base.baseId}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return mulberry32(h >>> 0);
}

/**
 * 가격 변동(같은 매물이 플랫폼마다 조금씩 다른 가격) 적용.
 * 중개사가 다르거나, 한쪽 플랫폼만 가격 갱신이 안 된 경우를 흉내낸다.
 */
export function jitterPrice(base, rand, step) {
  const d = rand() < 0.25 ? (rand() < 0.5 ? -1 : 1) : 0;
  if (!d) return { deposit: base.deposit, monthlyRent: base.monthlyRent };
  if (base.dealType === '월세') return { deposit: base.deposit, monthlyRent: Math.max(5, base.monthlyRent + d * 5) };
  return { deposit: Math.max(500, base.deposit + d * step), monthlyRent: 0 };
}

/** 위치 좌표도 플랫폼마다 미세하게 다름 (건물 중심 vs 필지 중심 등) */
export function jitterCoord(base, rand, meters = 15) {
  const dLat = ((rand() - 0.5) * 2 * meters) / 111000;
  const dLng = ((rand() - 0.5) * 2 * meters) / 88000;
  return { lat: base.lat + dLat, lng: base.lng + dLng };
}
