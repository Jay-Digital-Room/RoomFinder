import { collectOne } from './aggregator.js';
import { bboxSizeKm } from './crawl/geo.js';
import { matches } from './conditions.js';

/**
 * 크롤링 오케스트레이션.
 *  - 여러 사이트는 동시에, 같은 사이트 안에서는 영역을 하나씩 순서대로 수집
 *  - 사이트 하나·영역 하나가 끝날 때마다 바로 store 에 반영 → 화면에 먼저 끝난 것부터 보임
 *  - 수집 조건(conditions)에 맞지 않는 매물은 저장하지 않음
 */
export function createCrawler({ store, getSources, options = {}, logger = console }) {
  const status = new Map(); // key → { running, done, total, lastRunAt, lastOkAt, lastError, lastCount, warnings }
  let current = null;

  async function crawlSource(src, areas, { conditions, reason }) {
    const started = Date.now();
    const prev = status.get(src.key) ?? {};
    status.set(src.key, { ...prev, running: true, done: 0, total: areas.length });
    let count = 0;
    let normalizeFailed = 0;
    const errors = [];
    const warnings = [];

    for (const [i, area] of areas.entries()) {
      try {
        const r = await collectOne(
          src,
          { bbox: area, conditions, maxPages: options.maxPages, maxItems: options.maxItems, delayMs: options.delayMs },
          options.timeoutMs ?? 3 * 60 * 1000,
        );
        const kept = conditions ? r.listings.filter((l) => matches(l, conditions)) : r.listings;
        store.upsertMany(kept);
        count += kept.length;
        normalizeFailed += r.failed;
        warnings.push(...r.warnings);
      } catch (err) {
        errors.push(`${area.name ?? '영역'}: ${err.message}`);
      }
      status.set(src.key, { ...status.get(src.key), done: i + 1, lastCount: count });
    }

    const ok = errors.length < areas.length; // 하나라도 성공하면 OK (부분 실패는 경고)
    status.set(src.key, {
      running: false,
      done: areas.length,
      total: areas.length,
      lastRunAt: started,
      lastOkAt: ok ? Date.now() : prev.lastOkAt,
      lastError: ok ? null : errors[0],
      lastCount: count,
      normalizeFailed,
      warnings: [...(ok ? errors : []), ...warnings].slice(0, 10),
      ms: Date.now() - started,
    });
    const tag = `[수집:${reason}] ${src.name}`;
    if (ok) logger.log(`${tag} ${count}건 (${((Date.now() - started) / 1000).toFixed(1)}초)${normalizeFailed ? `, 변환 실패 ${normalizeFailed}` : ''}`);
    else logger.warn(`${tag} 실패: ${errors[0]}`);
  }

  /**
   * @param {object|object[]} areas  bbox 하나 또는 여러 개
   * @param {{reason?:string, conditions?:object}} opts
   */
  async function run(areas, { reason = 'manual', conditions = null } = {}) {
    if (current) return current;
    const list = Array.isArray(areas) ? areas : [areas];
    current = (async () => {
      const sources = getSources().filter((s) => !conditions || conditions.sources.includes(s.key));
      for (const s of sources) status.set(s.key, { ...(status.get(s.key) ?? {}), running: true, done: 0, total: list.length });
      try {
        await Promise.all(sources.map((src) => crawlSource(src, list, { conditions, reason })));
        store.prune();
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
