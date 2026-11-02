import { inBbox } from '../crawl/geo.js';
import { monthlyCost } from '../aggregator.js';
import { describeParsed, formatManwon, parseQuery } from './parse.js';

/**
 * 자연어 매물 검색 (RAG 방식).
 *
 *  1) 해석: 검색어에서 확실한 조건(거래유형·가격·지역·층…)을 규칙으로 뽑는다        → parse.js
 *  2) 검색: 그 조건으로 매물을 거르고, 남은 단어(선호 키워드)로 점수를 매겨 후보를 고른다
 *  3) 판단: (API 키가 있으면) Claude 가 후보 매물 설명을 읽고 요청에 맞는 순서로 골라 이유를 붙인다
 *
 * API 키가 없거나 AI 호출이 실패하면 2) 의 결과를 그대로 돌려준다.
 */

export const MAX_CANDIDATES = 60;
export const MAX_RESULTS = 30;

/** 1)에서 뽑은 필수 조건으로 거르기 */
export function hardFilter(groups, f) {
  return groups.filter((g) => {
    if (f.dealTypes.length && !f.dealTypes.includes(g.dealType)) return false;
    if (f.roomTypes.length && !f.roomTypes.includes(g.roomType)) return false;
    if (f.depositMax != null && g.deposit > f.depositMax) return false;
    if (f.rentMax != null && g.dealType === '월세' && g.monthlyRent > f.rentMax) return false;
    if (f.maintenanceMax != null && g.maintenanceFee > f.maintenanceMax) return false;
    if (f.areaMinM2 != null && g.areaM2 < f.areaMinM2 - 0.5) return false;
    if (f.floorMin != null && (g.floor == null || g.floor < f.floorMin)) return false;
    if (f.excludeBasement && g.floor != null && g.floor < 1) return false;
    if (f.places.length) {
      const ok = f.places.some((p) => (p.dong ? g.addr?.dong === p.dong || g.address.includes(p.dong) : inBbox(g, p)));
      if (!ok) return false;
    }
    return true;
  });
}

function haystack(g) {
  return `${g.title} ${g.address} ${g.roomType} ${g.dealType} ${(g.offers ?? []).map((o) => o.title).join(' ')}`.toLowerCase();
}

/** 선호 키워드가 매물 텍스트에 몇 개 들어있는지 */
export function keywordScore(g, keywords) {
  if (!keywords.length) return { score: 0, matched: [] };
  const text = haystack(g);
  const matched = keywords.filter((k) => text.includes(k.toLowerCase()));
  return { score: matched.length, matched };
}

/** 2) 후보 고르기: 키워드 점수 높은 순 → 월 환산 비용 낮은 순 */
export function retrieve(groups, f) {
  return hardFilter(groups, f)
    .map((g) => ({ g, ...keywordScore(g, f.keywords) }))
    .sort((a, b) => b.score - a.score || monthlyCost(a.g) - monthlyCost(b.g));
}

function basicReason(g, matched, f) {
  const bits = [];
  if (matched.length) bits.push(`'${matched.join("', '")}' 포함`);
  if (f.rentMax != null && g.dealType === '월세') bits.push(`월세 ${g.monthlyRent}만`);
  if (f.depositMax != null) bits.push(`보증금 ${formatManwon(g.deposit)}`);
  if (g.sources.length > 1) bits.push(`${g.sources.length}개 플랫폼 등록`);
  return bits.join(' · ') || '필수 조건 충족';
}

/** 매물 한 줄 요약 (Claude 에게 보여줄 후보 설명) */
export function listingLine(g) {
  const price = g.dealType === '월세' ? `월세 ${g.deposit}/${g.monthlyRent}` : `${g.dealType} ${formatManwon(g.deposit)}`;
  const floor = g.floor == null ? '층 비공개' : g.floor < 1 ? (g.floor === -0.5 ? '반지하' : `지하${-g.floor}층`) : `${g.floor}층`;
  const days = Math.max(0, Math.round((Date.now() - Date.parse(g.updatedAt)) / 86400000));
  return [
    `[${g.id}]`,
    price,
    `관리비 ${g.maintenanceFee}만`,
    g.roomType,
    `${g.areaM2}㎡(${(g.areaM2 / 3.3058).toFixed(1)}평)`,
    g.totalFloors ? `${floor}/${g.totalFloors}층` : floor,
    g.address,
    `"${String(g.title).replace(/\s+/g, ' ').slice(0, 80)}"`,
    `등록 ${g.sources.length}곳`,
    `${days}일 전`,
  ].join(' · ');
}

/**
 * @param {object[]} groups  통합 매물 목록 (getAggregated().groups)
 * @param {string} query
 * @param {{ ai?: { rank(query, parsedText, candidates): Promise<{summary, picks:{id,reason}[]}> } | null }} opts
 */
export async function search(groups, query, { ai = null } = {}) {
  const dongs = [...new Set(groups.map((g) => g.addr?.dong).filter(Boolean))];
  const f = parseQuery(query, { dongs });
  const parsedText = describeParsed(f);
  const ranked = retrieve(groups, f);

  const basic = () =>
    ranked.slice(0, MAX_RESULTS).map(({ g, matched }) => ({ id: g.id, reason: basicReason(g, matched, f) }));

  const result = { query, parsed: f, parsedText, totalMatched: ranked.length, mode: 'basic', summary: null, results: [], note: null };

  if (!ai) {
    result.results = basic();
    return result;
  }
  if (!ranked.length) {
    result.mode = 'ai';
    result.note = '필수 조건에 맞는 매물이 없어 AI 판단을 건너뛰었어요. 조건을 조금 완화해 보세요.';
    return result;
  }

  const candidates = ranked.slice(0, MAX_CANDIDATES).map(({ g }) => g);
  try {
    const out = await ai.rank(query, parsedText, candidates);
    const valid = new Set(candidates.map((g) => g.id));
    const seen = new Set();
    result.results = (out.picks ?? [])
      .filter((p) => valid.has(p.id) && !seen.has(p.id) && seen.add(p.id))
      .slice(0, MAX_RESULTS)
      .map((p) => ({ id: p.id, reason: String(p.reason ?? '').slice(0, 200) }));
    result.summary = out.summary ?? null;
    result.mode = 'ai';
    if (ranked.length > MAX_CANDIDATES) {
      result.note = `조건에 맞는 ${ranked.length}개 중 키워드 점수 상위 ${MAX_CANDIDATES}개를 AI가 검토했어요.`;
    }
  } catch (err) {
    console.warn('[AI 검색] 실패, 기본 검색으로 대체:', err.message);
    result.results = basic();
    result.note = `AI 검색에 실패해 기본 검색 결과를 보여드려요 (${err.userMessage ?? err.message})`;
  }
  return result;
}
