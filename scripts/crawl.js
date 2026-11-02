#!/usr/bin/env node
/**
 * 크롤러 점검용 CLI. 사이트 API가 바뀌어 수집이 안 될 때 원인 파악에 사용한다.
 *
 *   npm run crawl                                  # 모든 소스, 기본 영역
 *   npm run crawl -- --source peterpan --dump      # 원본 응답을 data/debug/peterpan.json 에 저장
 *   npm run crawl -- --bbox 37.49,127.02,37.51,127.05 --pages 1
 *   npm run crawl -- --all                         # 저장된 수집 조건 무시하고 전체 유형 수집
 */
import '../server/config.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { isValidListing } from '../server/aggregator.js';
import { parseBbox } from '../server/crawl/geo.js';
import { getSources } from '../server/sources/index.js';
import { areasOf, loadConditions } from '../server/conditions.js';

// 기본값: 저장된 수집 조건(npm start 에서 고른 것)의 첫 번째 지역
const { conditions } = loadConditions();
const first = areasOf(conditions)[0];

const { values } = parseArgs({
  options: {
    source: { type: 'string' },
    bbox: { type: 'string', default: [first.south, first.west, first.north, first.east].join(',') },
    all: { type: 'boolean', default: false }, // 수집 조건(거래유형·방 종류·가격) 무시
    pages: { type: 'string', default: '1' },
    dump: { type: 'boolean', default: false },
  },
});

const bbox = parseBbox(values.bbox);
if (!bbox) {
  console.error('--bbox 형식: 남,서,북,동');
  process.exit(1);
}
const sources = getSources('live').filter((s) => !values.source || s.key === values.source);
if (!sources.length) {
  console.error(`알 수 없는 소스: ${values.source}`);
  process.exit(1);
}

for (const src of sources) {
  console.log(`\n=== ${src.name} (${src.key})${src.verified === false ? '  [미검증 어댑터]' : ''} ===`);
  const started = Date.now();
  const warnings = [];
  let raws;
  try {
    raws = await src.fetchRaw({
      bbox,
      conditions: values.all ? null : conditions,
      maxPages: Number(values.pages),
      maxItems: 60,
      warn: (w) => warnings.push(...w),
    });
  } catch (err) {
    console.log(`❌ 수집 실패: ${err.message}`);
    if (err.body) console.log(`   응답 본문: ${String(err.body).slice(0, 300)}`);
    continue;
  }
  let ok = 0;
  let bad = 0;
  let sample = null;
  let badSample = null;
  for (const raw of raws) {
    try {
      const l = src.normalize(raw);
      if (isValidListing(l)) {
        ok++;
        sample ??= l;
      } else {
        bad++;
        badSample ??= { raw, normalized: l };
      }
    } catch (err) {
      bad++;
      badSample ??= { raw, error: err.message };
    }
  }
  console.log(`✅ 원본 ${raws.length}건 → 정상 ${ok}건, 변환 실패 ${bad}건 (${Date.now() - started}ms)`);
  if (warnings.length) console.log(`⚠️  경고 ${warnings.length}건:\n   ${warnings.slice(0, 5).join('\n   ')}`);
  if (sample) console.log('예시:', JSON.stringify(sample, null, 2).slice(0, 900));
  if (badSample) console.log('변환 실패 예시:', JSON.stringify(badSample, null, 2).slice(0, 900));
  if (values.dump) {
    mkdirSync('data/debug', { recursive: true });
    const file = `data/debug/${src.key}.json`;
    writeFileSync(file, JSON.stringify(raws.slice(0, 50), null, 2));
    console.log(`원본 저장: ${file}`);
  }
}
