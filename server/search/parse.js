import { REGIONS } from '../conditions.js';
import { PYEONG_TO_M2 } from '../model.js';

/**
 * 자연어 검색어 → 필터 (규칙 기반, API 키 없이 동작).
 *
 * "강남역 근처 월세 60 이하 풀옵션 원룸, 반지하 제외, 관리비 10만 이하"
 *  → { places:[강남역], dealTypes:[월세], roomTypes:[원룸], rentMax:60, maintenanceMax:10, excludeBasement:true, keywords:[풀옵션] }
 *
 * 확실한 조건만 "필수 조건"으로 뽑고, 나머지 단어는 keywords(선호)로 남긴다.
 */

const UPTO = '(?:이하|미만|까지|아래|안쪽|이내|안으로|밑으로|넘지\\s*않는)';
const ABOUT = '(?:정도|쯤|내외|안팎|선)';
const MONEY = '([\\d.,]+\\s*억?\\s*[\\d.,]*\\s*천?\\s*[\\d.,]*\\s*백?\\s*[\\d.,]*|천|오백|삼천|이천|일억|이억|삼억)';

/** "1억5천" / "1.5억" / "5천" / "1500" / "천" → 만원 */
export function parseKoreanAmount(raw) {
  let s = String(raw).replace(/[,\s]/g, '').replace(/만원?$/, '');
  const words = { 일억: '1억', 이억: '2억', 삼억: '3억', 삼천: '3천', 이천: '2천', 오백: '5백' };
  s = words[s] ?? s;
  if (s === '천') return 1000;
  let total = 0;
  let matched = false;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)?(억|천|백)?/g)) {
    if (!m[0]) continue;
    matched = true;
    const n = m[1] === undefined ? 1 : Number(m[1]);
    total += m[2] === '억' ? n * 10000 : m[2] === '천' ? n * 1000 : m[2] === '백' ? n * 100 : n;
  }
  return matched && Number.isFinite(total) && total > 0 ? Math.round(total) : null;
}

const DEAL_WORDS = [
  ['월세', /월세|반전세/],
  ['전세', /전세(?!금)|전세금/],
  ['매매', /매매|매수|사려|살\s*집|구매/],
];
const ROOM_WORDS = [
  ['원룸', /원룸|1룸|오픈형|분리형/],
  ['투룸', /투룸|2룸|방\s*(?:2|두)\s*개?|쓰리룸\s*말고\s*투룸/],
  ['쓰리룸+', /쓰리룸|3룸|방\s*(?:3|세)\s*개?|포룸|방\s*(?:4|네)\s*개?/],
  ['오피스텔', /오피스텔|오피/],
  ['아파트', /아파트|apt/i],
  ['빌라', /빌라|다세대|연립|주택/],
];

/** 선호 키워드 정규화 (동의어 → 대표어) */
const SYNONYMS = {
  엘베: '엘리베이터', 엘레베이터: '엘리베이터', 주차장: '주차', 주차가능: '주차',
  풀옵: '풀옵션', 신축급: '신축', 역세권: '역세권', 역근처: '역세권', 역가까운: '역세권',
  반려동물: '반려', 애완: '반려', 강아지: '반려', 고양이: '반려', 펫: '반려',
  햇빛: '채광', 햇볕: '채광', 밝은: '채광', 넓은: '넓은', 복층: '복층', 분리형: '분리형',
  조용한: '조용', 깨끗한: '깔끔', 깔끔한: '깔끔', 대학가: '대학', 남향: '남향', 테라스: '테라스', 베란다: '베란다',
};

const STOP = new Set(
  ('근처 주변 부근 인근 쪽 동네 지역 이하 미만 까지 정도 쯤 원 만원 만 매물 방 집 찾아줘 찾아 줘 보여줘 알려줘 추천 추천해줘 원해 원함 싶어 좋겠어 ' +
    '있는 있고 없는 좋은 괜찮은 그리고 또는 이고 하고 이면 으로 에서 에 의 및 제외 빼고 말고 싫어 x 이상 넘는 넘게 층 평 ' +
    '보증금 월세 전세 매매 관리비 원룸 투룸 쓰리룸 오피스텔 아파트 빌라 가격 예산 싼 저렴한 싸게 저렴 혼자 살 사는 살기 구해 구해줘 구함 가능 가능한 되는 됨 곳 데 거 것 좀 꼭 최대 적당한')
    .split(' '),
);

function stripParticle(t) {
  return t.replace(/(으로|에서|이고|이며|이랑|하고|이면|인데|에|의|을|를|은|는|이|가|도|만|랑|과|와|로)$/, '');
}

/**
 * @param {string} query
 * @param {{ dongs?: string[] }} ctx  수집된 매물에 있는 동 이름 목록 (동 이름 인식용)
 */
export function parseQuery(query, { dongs = [] } = {}) {
  const q = ` ${String(query ?? '').trim()} `;
  let rest = q;
  const used = (re) => (rest = rest.replace(re, ' '));
  const f = {
    dealTypes: [],
    roomTypes: [],
    depositMax: null,
    rentMax: null,
    maintenanceMax: null,
    areaMinM2: null,
    floorMin: null,
    excludeBasement: false,
    places: [], // { name, south, west, north, east } | { name, dong }
    keywords: [],
  };

  // ---- 가격 ----
  const priceRe = (label) => new RegExp(`(${label})\\s*(?:은|는|이|가)?\\s*${MONEY}\\s*(?:만\\s*원?|원)?\\s*(${UPTO}|${ABOUT})`, 'g');
  for (const m of q.matchAll(priceRe('월세|월'))) {
    const v = parseKoreanAmount(m[2]);
    if (v != null && v < 1000) {
      f.rentMax = new RegExp(ABOUT).test(m[3]) ? Math.round(v * 1.1) : v;
      used(m[0]);
    }
  }
  for (const m of q.matchAll(priceRe('보증금|전세금|전세가|전세|매매가|매매|예산'))) {
    const v = parseKoreanAmount(m[2]);
    if (v != null) {
      f.depositMax = new RegExp(ABOUT).test(m[3]) ? Math.round(v * 1.1) : v;
      if (/전세/.test(m[1]) && !f.dealTypes.includes('전세')) f.dealTypes.push('전세');
      if (/매매/.test(m[1]) && !f.dealTypes.includes('매매')) f.dealTypes.push('매매');
      used(m[0]);
    }
  }
  // "1000/60" 표기 → 보증금/월세 상한
  for (const m of q.matchAll(/(\d{2,5})\s*\/\s*(\d{1,3})(?!\d)/g)) {
    f.depositMax ??= Number(m[1]);
    f.rentMax ??= Number(m[2]);
    if (!f.dealTypes.includes('월세')) f.dealTypes.push('월세');
    used(m[0]);
  }
  for (const m of q.matchAll(new RegExp(`관리비\\s*(?:은|는|가)?\\s*(\\d+)\\s*(?:만\\s*원?)?\\s*${UPTO}`, 'g'))) {
    f.maintenanceMax = Number(m[1]);
    used(m[0]);
  }
  if (/관리비\s*(?:없는|없음|0|포함)/.test(q)) {
    f.maintenanceMax = 0;
    used(/관리비\s*(?:없는|없음|0|포함)/g);
  }

  // ---- 면적·층 ----
  const pyeong = q.match(/(\d+(?:\.\d+)?)\s*평\s*(?:이상|넘|부터|은\s*넘|보다\s*넓)/);
  if (pyeong) {
    f.areaMinM2 = Math.round(Number(pyeong[1]) * PYEONG_TO_M2 * 10) / 10;
    used(pyeong[0]);
  }
  const m2 = q.match(/(\d+(?:\.\d+)?)\s*(?:㎡|m2|제곱미터|평방미터)\s*(?:이상|넘|부터)/i);
  if (m2) {
    f.areaMinM2 = Number(m2[1]);
    used(m2[0]);
  }
  const floor = q.match(/(\d+)\s*층\s*(?:이상|넘|부터|위)/);
  if (floor) {
    f.floorMin = Number(floor[1]);
    used(floor[0]);
  }
  if (/반지하\s*(?:는|은)?\s*(?:제외|빼|말고|싫|x|안\s*돼|아닌|없는|노)|지상층?만|반지하\s*no/i.test(q)) {
    f.excludeBasement = true;
    used(/반지하\s*(?:는|은)?\s*(?:제외|빼고|말고|싫어|x|안\s*돼|아닌|없는|노)|지상층?만/gi);
  }
  if (/저층\s*(?:제외|말고|싫)|고층/.test(q) && f.floorMin == null) f.floorMin = /고층/.test(q) ? 5 : 3;

  // ---- 거래·방 종류 ----
  for (const [deal, re] of DEAL_WORDS) {
    if (re.test(q) && !f.dealTypes.includes(deal)) f.dealTypes.push(deal);
  }
  for (const [room, re] of ROOM_WORDS) {
    if (re.test(q)) f.roomTypes.push(room);
  }

  // ---- 장소: 역 이름 / 동 이름 ----
  for (const r of REGIONS) {
    const base = r.name.replace(/역$/, '');
    if (new RegExp(`${base}(?:역|입구)?`).test(q) && base.length >= 2) {
      f.places.push({ name: r.name, south: r.south - 0.004, west: r.west - 0.005, north: r.north + 0.004, east: r.east + 0.005 });
      used(new RegExp(`${base}(?:역|입구)?`, 'g'));
    }
  }
  for (const d of dongs) {
    if (d && d.length >= 2 && q.includes(d) && !f.places.some((p) => p.dong === d)) {
      f.places.push({ name: d, dong: d });
      used(new RegExp(d, 'g'));
    }
  }

  // ---- 남은 단어 → 선호 키워드 ----
  const kw = new Set();
  for (const raw of rest.split(/[\s,.!?~·/]+/)) {
    let t = stripParticle(raw.trim().toLowerCase());
    if (t.length < 2 || STOP.has(t) || /^\d/.test(t)) continue;
    for (const [room, re] of ROOM_WORDS) if (re.test(t)) t = '';
    for (const [, re] of DEAL_WORDS) if (re.test(t)) t = '';
    if (!t) continue;
    kw.add(SYNONYMS[t] ?? t);
  }
  f.keywords = [...kw].slice(0, 8);
  return f;
}

/** 만원 → "1억 5,000만" */
export function formatManwon(v) {
  const eok = Math.floor(v / 10000);
  const rest = v % 10000;
  if (!eok) return `${v.toLocaleString()}만`;
  return rest ? `${eok}억 ${rest.toLocaleString()}만` : `${eok}억`;
}

/** 사람이 읽는 해석 문장 */
export function describeParsed(f) {
  const parts = [];
  if (f.places.length) parts.push(f.places.map((p) => p.name).join('·'));
  if (f.dealTypes.length) parts.push(f.dealTypes.join('·'));
  if (f.roomTypes.length) parts.push(f.roomTypes.join('·'));
  if (f.depositMax != null) parts.push(`${f.dealTypes.length === 1 && f.dealTypes[0] === '매매' ? '매매가' : '보증금'} ${formatManwon(f.depositMax)} 이하`);
  if (f.rentMax != null) parts.push(`월세 ${f.rentMax}만 이하`);
  if (f.maintenanceMax != null) parts.push(f.maintenanceMax === 0 ? '관리비 없음' : `관리비 ${f.maintenanceMax}만 이하`);
  if (f.areaMinM2 != null) parts.push(`${f.areaMinM2}㎡ 이상`);
  if (f.floorMin != null) parts.push(`${f.floorMin}층 이상`);
  if (f.excludeBasement) parts.push('반지하 제외');
  if (f.keywords.length) parts.push(`선호: ${f.keywords.join(', ')}`);
  return parts.join(' / ') || '조건 없음';
}
