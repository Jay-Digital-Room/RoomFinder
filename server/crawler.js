import { collect } from './aggregator.js';
import { bboxSizeKm } from './crawl/geo.js';

/**
 * 크롤링 오케스트레이션.
 *  - 소스별로 동시에 하나의 수집만 (같은 사이트에 중복 요청 방지)
 *  - 결과를 store 에 반영하고 소스별 상태 기록
 */
export function createCrawler({ store, getSources, options = {} }) {
  const status = new Map(); // key → { running, lastRunAt, lastOkAt, lastError, lastCount, warnings }
  let current = null;

  async function run(bbox, { reason = 'manual' } = {}) {
    if (current) return current;
    current = (async () => {
      const sources = getSources();
      for (const s of sources) status.set(s.key, { ...(status.get(s.key) ?? {}), running: true });
      const started = Date.now();
      try {
        const { listings, status: st } = await collect({
          sources,
          timeoutMs: options.timeoutMs ?? 5 * 60 * 1000,
          ctx: { bbox, maxPages: options.maxPages, maxItems: options.maxItems, delayMs: options.delayMs },
        });
        store.upsertMany(listings);
        store.prune();
        for (const s of st) {
          const prev = status.get(s.key) ?? {};
          status.set(s.key, {
            running: false,
            lastRunAt: started,
            lastOkAt: s.ok ? Date.now() : prev.lastOkAt,
            lastError: s.ok ? null : s.error,
            lastCount: s.count,
            normalizeFailed: s.normalizeFailed ?? 0,
            warnings: s.warnings ?? [],
            ms: s.ms,
          });
          const tag = `[crawl:${reason}] ${s.key}`;
          if (s.ok) console.log(`${tag} ${s.count}건 (${s.ms}ms)${s.normalizeFailed ? `, 변환 실패 ${s.normalizeFailed}` : ''}`);
          else console.warn(`${tag} 실패: ${s.error}`);
        }
      } finally {
        for (const [k, v] of status) if (v.running) status.set(k, { ...v, running: false });
        current = null;
      }
    })();
    return current;
  }

  return {
    run,
    get running() {
      return Boolean(current);
    },
    status(key) {
      return status.get(key) ?? {};
    },
    /** 사용자가 요청한 영역이 너무 크면 거절 (차단 방지) */
    validateArea(bbox, maxKm = options.maxAreaKm ?? 6) {
      const { width, height } = bboxSizeKm(bbox);
      return width <= maxKm && height <= maxKm;
    },
  };
}
