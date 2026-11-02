import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseKoreanAmount, parseQuery } from '../server/search/parse.js';
import { search, listingLine } from '../server/search/index.js';
import { createAiRanker, DEFAULT_MODEL } from '../server/search/ai.js';

test('한국어 금액', () => {
  assert.equal(parseKoreanAmount('1억5천'), 15000);
  assert.equal(parseKoreanAmount('1.5억'), 15000);
  assert.equal(parseKoreanAmount('2억 3000'), 23000);
  assert.equal(parseKoreanAmount('5천'), 5000);
  assert.equal(parseKoreanAmount('천'), 1000);
  assert.equal(parseKoreanAmount('60'), 60);
});

test('자연어 → 필수 조건 + 선호 키워드', () => {
  const f = parseQuery('강남역 근처 월세 60 이하 풀옵션 원룸, 반지하 제외, 관리비 10만 이하');
  assert.deepEqual(f.dealTypes, ['월세']);
  assert.deepEqual(f.roomTypes, ['원룸']);
  assert.equal(f.rentMax, 60);
  assert.equal(f.maintenanceMax, 10);
  assert.equal(f.excludeBasement, true);
  assert.equal(f.places[0].name, '강남역');
  assert.deepEqual(f.keywords, ['풀옵션']);

  const g = parseQuery('보증금 1억5천 이하 전세 투룸 10평 이상 엘베 있는 곳 3층 이상');
  assert.equal(g.depositMax, 15000);
  assert.deepEqual(g.dealTypes, ['전세']);
  assert.deepEqual(g.roomTypes, ['투룸']);
  assert.equal(g.areaMinM2, 33.1);
  assert.equal(g.floorMin, 3);
  assert.deepEqual(g.keywords, ['엘리베이터']);

  const h = parseQuery('서교동 1000/50 정도 조용한 곳', { dongs: ['서교동'] });
  assert.equal(h.depositMax, 1000);
  assert.equal(h.rentMax, 50);
  assert.deepEqual(h.places.map((p) => p.dong), ['서교동']);
  assert.deepEqual(h.keywords, ['조용']);
});

const G = (id, o = {}) => ({
  id, title: '깔끔한 원룸', dealType: '월세', roomType: '원룸', deposit: 1000, monthlyRent: 50, maintenanceFee: 7,
  areaM2: 20, floor: 3, totalFloors: 5, address: '서울 마포구 서교동', addr: { dong: '서교동' },
  lat: 37.556, lng: 126.92, sources: ['zigbang'], offers: [], updatedAt: '2026-11-01T00:00:00Z', ...o,
});

const groups = [
  G('a', { title: '풀옵션 신축 원룸', monthlyRent: 55 }),
  G('b', { title: '풀옵션 원룸', monthlyRent: 45 }),
  G('c', { monthlyRent: 40 }),
  G('d', { title: '풀옵션 반지하 원룸', floor: -0.5, monthlyRent: 30 }),
  G('e', { monthlyRent: 80 }),
  G('f', { dealType: '전세', deposit: 20000, monthlyRent: 0 }),
];

test('기본 검색: 필수 조건으로 거르고 키워드 많이 맞는 순 → 싼 순', async () => {
  const r = await search(groups, '월세 60 이하 풀옵션 신축, 반지하 제외');
  assert.equal(r.mode, 'basic');
  assert.deepEqual(r.results.map((x) => x.id), ['a', 'b', 'c']);
  assert.match(r.results[0].reason, /풀옵션/);
  assert.equal(r.totalMatched, 3);
});

test('AI 검색: 후보만 넘기고, 후보에 없는 id·중복은 버린다', async () => {
  let seen;
  const ai = {
    async rank(query, parsedText, candidates) {
      seen = candidates.map((g) => g.id);
      return { summary: '해석', picks: [{ id: 'c', reason: '가장 저렴' }, { id: 'zzz', reason: '가짜' }, { id: 'c', reason: '중복' }, { id: 'a', reason: '풀옵션' }] };
    },
  };
  const r = await search(groups, '월세 60 이하 반지하 제외', { ai });
  assert.deepEqual(seen.sort(), ['a', 'b', 'c']);
  assert.equal(r.mode, 'ai');
  assert.deepEqual(r.results, [{ id: 'c', reason: '가장 저렴' }, { id: 'a', reason: '풀옵션' }]);
});

test('AI 실패 시 기본 검색으로 대체', async () => {
  const ai = { rank: async () => { throw Object.assign(new Error('boom'), { userMessage: 'API 키 오류' }); } };
  const r = await search(groups, '월세 60 이하', { ai });
  assert.equal(r.mode, 'basic');
  assert.ok(r.results.length > 0);
  assert.match(r.note, /API 키 오류/);
});

test('API 키가 없으면 AI 비활성', async () => {
  assert.equal(await createAiRanker({ apiKey: '' }), null);
});

test('Claude 요청 형식: 모델·구조화 출력·fallback·effort, 매물은 <listings> 안에', async () => {
  let req;
  const client = {
    beta: {
      messages: {
        create: async (r) => {
          req = r;
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ summary: 's', picks: [{ id: 'a', reason: 'r' }] }) }], usage: {} };
        },
      },
    },
  };
  const ai = await createAiRanker({ client });
  const out = await ai.rank('풀옵션 원룸', '선호: 풀옵션', [groups[0]]);
  assert.deepEqual(out.picks, [{ id: 'a', reason: 'r' }]);
  assert.equal(req.model, DEFAULT_MODEL);
  assert.equal(req.model, 'claude-opus-5-5');
  assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(req.fallbacks, 'default');
  assert.equal(req.output_config.effort, 'low');
  assert.equal(req.output_config.format.type, 'json_schema');
  assert.equal(req.output_config.format.schema.additionalProperties, false);
  assert.equal(req.thinking, undefined);
  assert.match(req.messages[0].content, /<listings>\n\[a\] · 월세 1000\/55[^\n]*\n<\/listings>/);
  assert.match(listingLine(groups[0]), /20㎡\(6\.0평\) · 3층\/5층/);

  // 거절·잘림·형식 오류는 사용자에게 보여줄 메시지로
  client.beta.messages.create = async () => ({ stop_reason: 'refusal', content: [] });
  await assert.rejects(ai.rank('q', '', [groups[0]]), (e) => /답하지 않았/.test(e.userMessage));
  client.beta.messages.create = async () => { throw Object.assign(new Error('unauthorized'), { status: 401 }); };
  await assert.rejects(ai.rank('q', '', [groups[0]]), (e) => /API 키/.test(e.userMessage));
});
