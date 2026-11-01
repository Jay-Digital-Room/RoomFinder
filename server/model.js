/**
 * 공통 매물 스키마 (모든 소스 어댑터는 이 형태로 정규화해서 반환한다)
 *
 * @typedef {'매매'|'전세'|'월세'} DealType
 * @typedef {'원룸'|'투룸'|'쓰리룸+'|'오피스텔'|'아파트'|'빌라'} RoomType
 *
 * @typedef {Object} Listing
 * @property {string}   id           `${source}:${sourceId}` 형태의 전역 고유 ID
 * @property {string}   source       소스 키 (zigbang | dabang | naver ...)
 * @property {string}   sourceId     원본 플랫폼에서의 매물 ID
 * @property {string}   url          원본 매물 페이지 링크
 * @property {string}   title
 * @property {DealType} dealType
 * @property {RoomType} roomType
 * @property {number}   deposit      보증금 또는 매매가 (만원)
 * @property {number}   monthlyRent  월세 (만원, 매매/전세는 0)
 * @property {number}   maintenanceFee 관리비 (만원)
 * @property {number}   areaM2       전용면적 (㎡)
 * @property {number|null} floor     해당 층 (지하는 음수, 알 수 없으면 null)
 * @property {number|null} totalFloors
 * @property {string}   address      지번 주소 (표시용)
 * @property {{sido:string, sigungu:string, dong:string, jibun:string}} addr 파싱된 주소
 * @property {number}   lat
 * @property {number}   lng
 * @property {string[]} images
 * @property {string}   updatedAt    ISO 8601
 */

export const DEAL_TYPES = ['매매', '전세', '월세'];
export const ROOM_TYPES = ['원룸', '투룸', '쓰리룸+', '오피스텔', '아파트', '빌라'];

export const PYEONG_TO_M2 = 3.305785;

const SIDO_ALIASES = {
  서울특별시: '서울', 서울시: '서울', 서울: '서울',
  경기도: '경기', 경기: '경기',
  인천광역시: '인천', 인천: '인천',
  부산광역시: '부산', 부산: '부산',
};

/**
 * 플랫폼마다 제각각인 지번 주소 표기를 파싱한다.
 *  "서울특별시 마포구 서교동 123-4" / "서울 마포구 서교동 123-4번지" / "마포구 서교동 123-4"
 */
export function parseAddress(raw) {
  const tokens = String(raw ?? '')
    .replace(/번지/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

  let sido = '';
  if (tokens.length && SIDO_ALIASES[tokens[0]]) sido = SIDO_ALIASES[tokens.shift()];

  const sigungu = tokens.find((t) => /[시군구]$/.test(t)) ?? '';
  const dong = tokens.find((t) => /[동읍면리가]$/.test(t) && t !== sigungu) ?? '';
  const jibunToken = tokens.find((t) => /^(산\s?)?\d+(-\d+)?$/.test(t)) ?? '';
  // "123-0" 과 "123" 은 같은 번지
  const jibun = jibunToken.replace(/-0+$/, '');

  return { sido: sido || (sigungu ? '서울' : ''), sigungu, dong, jibun };
}

/** 중복 판별용 주소 키: 시군구+동+지번 */
export function addressKey(addr) {
  if (!addr.dong || !addr.jibun) return '';
  return `${addr.sigungu}|${addr.dong}|${addr.jibun}`;
}

/** "3층", "3/15", "B1", "반지하", "옥탑", "고층" 등 → { floor, totalFloors } */
export function parseFloor(raw) {
  const s = String(raw ?? '').replace(/\s/g, '');
  let floor = null;
  let totalFloors = null;

  const slash = s.match(/^([^/]+)\/(\d+)/);
  const head = slash ? slash[1] : s;
  if (slash) totalFloors = Number(slash[2]);

  const totalMatch = s.match(/(\d+)층건물|전체(\d+)/);
  if (totalMatch) totalFloors = Number(totalMatch[1] ?? totalMatch[2]);

  if (/반지하/.test(head)) floor = -0.5;
  else if (/옥탑/.test(head)) floor = totalFloors != null ? totalFloors + 0.5 : null;
  else if (/^(B|지하)(\d+)/i.test(head)) floor = -Number(head.match(/^(?:B|지하)(\d+)/i)[1]);
  else if (/^\d+/.test(head)) floor = Number(head.match(/^\d+/)[0]);

  return { floor, totalFloors };
}

/** 미터 단위 거리 (haversine) */
export function distanceM(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function round1(n) {
  return Math.round(n * 10) / 10;
}

/** "2억 1,000" / "1억5000" / "5,000" / "3억" → 만원 */
export function parseKoreanMoney(s) {
  const str = String(s ?? '').replace(/[,\s]/g, '');
  const m = str.match(/^(?:(\d+)억)?(\d+)?$/);
  if (!str || !m) return NaN;
  return Number(m[1] ?? 0) * 10000 + Number(m[2] ?? 0);
}
