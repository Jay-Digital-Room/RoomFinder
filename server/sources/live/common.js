import { parseFloor } from '../../model.js';

/** 원 → 만원 (반올림) */
export const wonToManwon = (won) => Math.round(Number(won || 0) / 10000);

/**
 * 단위가 불확실한 금액: threshold 이상이면 원 단위로 보고 만원으로 변환.
 *  - 월세: 10만(원) 이상이면 원 (기본값)
 *  - 관리비: 1000 이상이면 원
 *  - 보증금·매매가: 100만(원) 이상이면 원 (만원 단위로 100억 넘는 주거용 매물은 드묾)
 */
export function guessManwon(v, threshold = 100000) {
  const n = Number(v || 0);
  return n >= threshold ? Math.round(n / 10000) : n;
}

/** 방 종류 텍스트 → 공통 RoomType */
export function roomTypeFromText(text, fallback = '원룸') {
  const t = String(text ?? '');
  if (/아파트/.test(t)) return '아파트';
  if (/오피스텔/.test(t)) return '오피스텔';
  if (/쓰리룸|3룸|방\s?3|포룸|4룸/.test(t)) return '쓰리룸+';
  if (/투룸|2룸|방\s?2/.test(t)) return '투룸';
  if (/빌라|다세대|연립|주택|다가구/.test(t)) return '빌라';
  if (/원룸|1룸|오픈형|분리형/.test(t)) return '원룸';
  return fallback;
}

/** "5층, 19.83m², 관리비 7만" 같은 설명 문자열에서 정보 추출 */
export function parseRoomDesc(desc) {
  const s = String(desc ?? '');
  const area = s.match(/([\d.]+)\s*(?:m²|㎡|m2)/i);
  const pyeong = !area && s.match(/([\d.]+)\s*평/);
  const fee = s.match(/관리비\s*([\d.]+)\s*만/);
  const floorTok = s.match(/(반지하|옥탑(?:방)?|지하\s?\d+층|B\d+|\d+층|저층|중층|고층)/);
  let floor = null;
  if (floorTok && !/저층|중층|고층/.test(floorTok[1])) floor = parseFloor(floorTok[1].replace(/\s/g, '')).floor;
  return {
    areaM2: area ? Number(area[1]) : pyeong ? Number(pyeong[1]) * 3.305785 : NaN,
    maintenanceFee: fee ? Number(fee[1]) : 0,
    floor,
  };
}

/** 날짜 문자열 → ISO. 없거나 해석 불가하면 null */
export function toIso(v) {
  if (!v) return null;
  const s = String(v).trim();
  // "20261030" / "2026.10.30" / "2026-10-30" / ISO
  const m = s.match(/^(\d{4})[.\-/]?(\d{2})[.\-/]?(\d{2})$/);
  const d = m ? new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00+09:00`) : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function composeAddress(addr) {
  return [addr.sido, addr.sigungu, addr.dong, addr.jibun].filter(Boolean).join(' ');
}

/** "서울시"/"서울특별시" → "서울" */
export function shortSido(s) {
  return String(s ?? '').replace(/(특별시|광역시|특별자치시|특별자치도|시|도)$/, '') || '';
}
