import zigbang from './zigbang.js';
import dabang from './dabang.js';
import naver from './naver.js';

/**
 * 소스 어댑터 레지스트리.
 *
 * 새 플랫폼(예: 피터팬, 부동산114, 공공데이터 실거래가 등)을 추가하려면
 *   { key, name, color, homepage, fetchRaw(): Promise<any[]>, normalize(raw): Listing }
 * 형태의 모듈을 만들어 여기에 등록하면 된다.
 *
 * 환경변수 SOURCES=zigbang,naver 처럼 지정하면 해당 소스만 활성화된다.
 */
const ALL = [zigbang, dabang, naver];

export function getSources() {
  const enabled = process.env.SOURCES?.split(',').map((s) => s.trim()).filter(Boolean);
  return enabled?.length ? ALL.filter((s) => enabled.includes(s.key)) : ALL;
}
