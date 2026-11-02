import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 수집된 매물 저장소 (메모리 + JSON 파일).
 *  - 같은 ID는 덮어쓰고 firstSeenAt/lastSeenAt 을 관리
 *  - 오래 안 보인 매물(거래 완료·삭제 추정)은 prune() 으로 정리
 */
export function createStore({ file = null, maxAgeMs = 3 * 24 * 3600 * 1000 } = {}) {
  /** @type {Map<string, {listing: object, firstSeenAt: number, lastSeenAt: number}>} */
  const items = new Map();
  let version = 0;
  let saveTimer = null;

  if (file) {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      for (const e of data.items ?? []) items.set(e.listing.id, e);
      version++;
    } catch {
      /* 첫 실행 */
    }
  }

  function scheduleSave() {
    if (!file || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        mkdirSync(dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, JSON.stringify({ savedAt: new Date().toISOString(), items: [...items.values()] }));
        renameSync(tmp, file);
      } catch (err) {
        console.error('[store] 저장 실패:', err.message);
      }
    }, 1000);
    saveTimer.unref?.();
  }

  return {
    upsertMany(listings, now = Date.now()) {
      for (const l of listings) {
        const prev = items.get(l.id);
        items.set(l.id, { listing: l, firstSeenAt: prev?.firstSeenAt ?? now, lastSeenAt: now });
      }
      if (listings.length) {
        version++;
        scheduleSave();
      }
    },
    prune(now = Date.now()) {
      let removed = 0;
      for (const [id, e] of items) {
        if (now - e.lastSeenAt > maxAgeMs) {
          items.delete(id);
          removed++;
        }
      }
      if (removed) {
        version++;
        scheduleSave();
      }
      return removed;
    },
    /** 날짜가 없는 매물은 최초 수집 시각으로 채워서 반환 */
    listings() {
      return [...items.values()].map((e) => (e.listing.updatedAt ? e.listing : { ...e.listing, updatedAt: new Date(e.firstSeenAt).toISOString() }));
    },
    countBySource() {
      const counts = {};
      for (const { listing } of items.values()) counts[listing.source] = (counts[listing.source] ?? 0) + 1;
      return counts;
    },
    /** 조건에 맞는 매물만 남긴다 (수집 조건을 바꿨을 때) */
    retain(predicate) {
      let removed = 0;
      for (const [id, e] of items) {
        if (!predicate(e.listing)) {
          items.delete(id);
          removed++;
        }
      }
      if (removed) {
        version++;
        scheduleSave();
      }
      return removed;
    },
    clear() {
      items.clear();
      version++;
    },
    get version() {
      return version;
    },
    get size() {
      return items.size;
    },
  };
}
