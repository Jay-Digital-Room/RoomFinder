import zigbangLive from './live/zigbang.js';
import dabangLive from './live/dabang.js';
import naverLive from './live/naver.js';
import peterpanLive from './live/peterpan.js';
import zigbangMock from './mock/zigbang.js';
import dabangMock from './mock/dabang.js';
import naverMock from './mock/naver.js';
import peterpanMock from './mock/peterpan.js';

/**
 * 소스 어댑터 레지스트리.
 *
 * 어댑터 형태:
 *   { key, name, color, homepage,
 *     fetchRaw(ctx): Promise<any[]>   // ctx = { bbox, maxPages, maxItems, delayMs, warn(msgs) }
 *     normalize(raw): Listing }
 *
 * DATA_MODE=live(기본) 이면 실제 사이트 크롤러, mock 이면 가상 데이터.
 * SOURCES=zigbang,naver 처럼 지정하면 해당 소스만 활성화.
 */
const LIVE = [zigbangLive, dabangLive, naverLive, peterpanLive];
const MOCK = [zigbangMock, dabangMock, naverMock, peterpanMock];

export function dataMode() {
  return process.env.DATA_MODE === 'mock' || process.argv.includes('--mock') ? 'mock' : 'live';
}

export function getSources(mode = dataMode()) {
  const all = mode === 'mock' ? MOCK : LIVE;
  const enabled = process.env.SOURCES?.split(',').map((s) => s.trim()).filter(Boolean);
  return enabled?.length ? all.filter((s) => enabled.includes(s.key)) : all;
}
