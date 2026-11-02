import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEAL_TYPES, ROOM_TYPES } from './model.js';

/**
 * 수집 조건 — 어디서, 어떤 매물을 수집할지.
 * 터미널(npm start)과 웹 화면("수집 조건") 양쪽에서 바꿀 수 있고 data/conditions.json 에 저장된다.
 *
 * @typedef {Object} Conditions
 * @property {string[]} regions      REGIONS 의 id 목록
 * @property {{name:string, south:number, west:number, north:number, east:number}[]} customAreas 지도에서 고른 영역
 * @property {string[]} dealTypes
 * @property {string[]} roomTypes
 * @property {number|null} depositMax 만원
 * @property {number|null} rentMax    만원
 * @property {string[]} sources
 */

/** 역 중심 반경 약 1km 영역 (좌표는 역 위치 기준 근사값) */
const STATIONS = [
  ['hongdae', '홍대입구역', 37.5572, 126.9245],
  ['hapjeong', '합정역', 37.5496, 126.9139],
  ['mangwon', '망원역', 37.556, 126.91],
  ['sinchon', '신촌역', 37.5552, 126.9369],
  ['seoulstation', '서울역', 37.5547, 126.9707],
  ['yongsan', '용산역', 37.5299, 126.9648],
  ['hyehwa', '혜화역', 37.5822, 127.0019],
  ['wangsimni', '왕십리역', 37.5612, 127.0371],
  ['seongsu', '성수역', 37.5446, 127.056],
  ['konkuk', '건대입구역', 37.5404, 127.0692],
  ['hoegi', '회기역', 37.5898, 127.0579],
  ['suyu', '수유역', 37.638, 127.0257],
  ['nowon', '노원역', 37.6551, 127.0613],
  ['gangnam', '강남역', 37.4979, 127.0276],
  ['yeoksam', '역삼역', 37.5006, 127.0366],
  ['seolleung', '선릉역', 37.5045, 127.049],
  ['samseong', '삼성역', 37.5088, 127.0631],
  ['jamsil', '잠실역', 37.5133, 127.1001],
  ['cheonho', '천호역', 37.5386, 127.1236],
  ['sadang', '사당역', 37.4766, 126.9816],
  ['snu', '서울대입구역', 37.4812, 126.9527],
  ['sillim', '신림역', 37.4842, 126.9297],
  ['gdigital', '구로디지털단지역', 37.4852, 126.9015],
  ['sindorim', '신도림역', 37.5089, 126.8913],
  ['yeouido', '여의도역', 37.5216, 126.9243],
  ['mokdong', '목동역', 37.526, 126.8648],
  ['magok', '마곡역', 37.5602, 126.8254],
];

const HALF_LAT = 0.009; // ≈ 1km
const HALF_LNG = 0.0113; // ≈ 1km (위도 37.5 기준)

export const REGIONS = STATIONS.map(([id, name, lat, lng]) => ({
  id,
  name,
  south: +(lat - HALF_LAT).toFixed(5),
  west: +(lng - HALF_LNG).toFixed(5),
  north: +(lat + HALF_LAT).toFixed(5),
  east: +(lng + HALF_LNG).toFixed(5),
}));

export const SOURCE_KEYS = ['zigbang', 'dabang', 'naver', 'peterpan'];

export const DEFAULT_CONDITIONS = Object.freeze({
  regions: ['hongdae'],
  customAreas: [],
  dealTypes: ['월세', '전세'],
  roomTypes: ['원룸', '투룸', '오피스텔'],
  depositMax: null,
  rentMax: null,
  sources: [...SOURCE_KEYS],
});

const MAX_AREAS = 6; // 한 번에 수집할 영역 수 제한 (차단·시간 방지)

const pick = (arr, allowed) => [...new Set((Array.isArray(arr) ? arr : []).filter((v) => allowed.includes(v)))];
const posNum = (v) => (v === null || v === undefined || v === '' ? null : Number(v) > 0 ? Math.round(Number(v)) : null);

/** 입력값을 검증·정리. 잘못된 값은 버리고, 비면 기본값 */
export function sanitize(input = {}) {
  const regionIds = REGIONS.map((r) => r.id);
  const customAreas = (Array.isArray(input.customAreas) ? input.customAreas : [])
    .filter((a) => a && [a.south, a.west, a.north, a.east].every(Number.isFinite) && a.south < a.north && a.west < a.east)
    .map((a) => ({ name: String(a.name ?? '지도에서 선택한 영역').slice(0, 40), south: a.south, west: a.west, north: a.north, east: a.east }));
  let regions = pick(input.regions, regionIds);
  if (!regions.length && !customAreas.length) regions = [...DEFAULT_CONDITIONS.regions];
  const total = regions.length + customAreas.length;
  if (total > MAX_AREAS) {
    regions = regions.slice(0, Math.max(0, MAX_AREAS - customAreas.length));
  }
  const dealTypes = pick(input.dealTypes, DEAL_TYPES);
  const roomTypes = pick(input.roomTypes, ROOM_TYPES);
  const sources = pick(input.sources, SOURCE_KEYS);
  return {
    regions,
    customAreas: customAreas.slice(0, MAX_AREAS),
    dealTypes: dealTypes.length ? dealTypes : [...DEFAULT_CONDITIONS.dealTypes],
    roomTypes: roomTypes.length ? roomTypes : [...ROOM_TYPES],
    depositMax: posNum(input.depositMax),
    rentMax: posNum(input.rentMax),
    sources: sources.length ? sources : [...SOURCE_KEYS],
  };
}

/** 조건 → 수집할 영역 목록 */
export function areasOf(c) {
  return [
    ...c.regions.map((id) => REGIONS.find((r) => r.id === id)).filter(Boolean),
    ...c.customAreas,
  ];
}

/** 사람이 읽는 요약 (터미널·화면 표시용) */
export function describe(c) {
  const money = c.depositMax || c.rentMax
    ? [c.depositMax && `보증금 ${c.depositMax.toLocaleString()}만 이하`, c.rentMax && `월세 ${c.rentMax}만 이하`].filter(Boolean).join(', ')
    : '가격 제한 없음';
  return [
    `지역: ${areasOf(c).map((a) => a.name).join(', ')}`,
    `거래: ${c.dealTypes.join('·')}`,
    `방: ${c.roomTypes.join('·')}`,
    money,
  ].join(' / ');
}

/** 수집된 매물이 조건에 맞는지 (사이트 API 필터가 완벽하지 않아 한 번 더 거른다) */
export function matches(l, c) {
  if (!c.dealTypes.includes(l.dealType)) return false;
  if (!c.roomTypes.includes(l.roomType)) return false;
  if (c.depositMax && l.dealType !== '매매' && l.deposit > c.depositMax) return false;
  if (c.rentMax && l.dealType === '월세' && l.monthlyRent > c.rentMax) return false;
  return true;
}

/* ---------- 저장 ---------- */

const FILE = fileURLToPath(new URL('../data/conditions.json', import.meta.url));

export function loadConditions(file = FILE) {
  try {
    return { conditions: sanitize(JSON.parse(readFileSync(file, 'utf8'))), saved: true };
  } catch {
    return { conditions: sanitize(DEFAULT_CONDITIONS), saved: false };
  }
}

export function saveConditions(c, file = FILE) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(c, null, 2));
}
