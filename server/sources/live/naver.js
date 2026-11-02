import { parseFloor, round1 } from '../../model.js';
import { createClient } from '../../crawl/http.js';
import { composeAddress, shortSido, toIso, wonToManwon } from './common.js';

/**
 * 네이버 부동산 크롤러 (fin.land.naver.com 비공식 front-api).
 *
 * POST /front-api/v1/article/boundedArticles
 *   { filter, boundingBox{left,right,top,bottom}, precision, articlePagingRequest{size, lastInfo...}, userChannelType }
 * → { isSuccess, detailCode, result: { list: [{ representativeArticleInfo, duplicatedArticleInfo }], hasNextPage, lastInfo } }
 *
 * 단위: 가격·관리비 모두 "원". 면적 ㎡. 좌표 address.coordinates{xCoordinate=경도, yCoordinate=위도}.
 * 네이버는 차단이 가장 엄격하다: 429 를 받으면 재시도하지 않고 15분간 쉰다.
 */
const URL_ = 'https://fin.land.naver.com/front-api/v1/article/boundedArticles';
const COOLDOWN_MS = 15 * 60 * 1000;

const TRADE = { A1: '매매', B1: '전세', B2: '월세', B3: '월세' /* 단기임대 */ };
const REAL_ESTATE = { A01: '아파트', A02: '오피스텔', C01: '원룸', C02: '빌라', C03: '빌라', A05: '빌라', A06: '빌라', A07: '빌라' };

let client;
let blockedUntil = 0;

function http(ctx) {
  client ??= createClient({
    name: 'naver',
    minDelayMs: ctx.delayMs ?? 2000, // 공개 클라이언트들이 쓰는 1초보다 보수적으로
    retryOn429: false,
    headers: {
      origin: 'https://fin.land.naver.com',
      referer: 'https://fin.land.naver.com/',
      'accept-language': 'ko,en-US;q=0.9,en;q=0.8',
    },
  });
  return client;
}

const TRADE_CODE = { 매매: 'A1', 전세: 'B1', 월세: 'B2' };
const ROOM_CODES = { 원룸: ['C01'], 투룸: ['C01', 'C02'], '쓰리룸+': ['C02'], 빌라: ['C02'], 오피스텔: ['A02'], 아파트: ['A01'] };

/** 공개 참고 구현의 기본 필터 (검증을 통과한다고 알려진 형식) */
const SAFE_TRADE = ['A1', 'B1', 'B2'];
const SAFE_REAL_ESTATE = ['A01', 'A02', 'A05', 'A06', 'A07', 'C02'];

/**
 * 요청 형식 후보. 네이버는 어떤 항목이 틀렸는지 알려주지 않으므로(FST_ERR_VALIDATION),
 * 조건을 반영한 형식이 거절되면 참고 구현의 기본 형식으로 다시 시도한다 (조건은 수집 후 걸러냄).
 */
export const VARIANTS = [
  { name: '조건 반영', useConditions: true },
  { name: '기본 형식', useConditions: false },
];
let preferredVariant = 0; // 한 번 통과한 형식은 다음 수집에도 사용

export function payload(bbox, paging, conditions, variant = VARIANTS[0]) {
  const c = variant.useConditions ? conditions : null;
  const tradeTypes = c ? c.dealTypes.map((d) => TRADE_CODE[d]) : SAFE_TRADE;
  const realEstateTypes = c ? [...new Set(c.roomTypes.flatMap((r) => ROOM_CODES[r] ?? []))] : SAFE_REAL_ESTATE;
  const range = {};
  // 가격 필터는 "원" 단위. 다른 거래유형은 걸러내지 않는다(네이버 동작)
  if (c?.depositMax) range.warrantyPrice = { max: c.depositMax * 10000 };
  if (c?.rentMax) range.rentPrice = { max: c.rentMax * 10000 };
  return {
    filter: {
      tradeTypes,
      realEstateTypes,
      ...range,
      roomCount: [],
      bathRoomCount: [],
      optionTypes: [],
      oneRoomShapeTypes: [],
      moveInTypes: [],
      floorTypes: [],
      directionTypes: [],
      parkingTypes: [],
      entranceTypes: [],
      hasArticle: false, // 서버가 모든 키를 요구 (빠지면 FST_ERR_VALIDATION)
      legalDivisionNumbers: [],
      legalDivisionType: 'EUP',
      filtersExclusiveSpace: false,
      hasArticlePhoto: false,
      isAuthorizedByOwner: false,
    },
    boundingBox: { left: bbox.west, right: bbox.east, top: bbox.north, bottom: bbox.south },
    precision: 16,
    // 첫 요청은 seed/lastInfo 없이 (null 로 보내면 검증 오류). 다음 페이지부터 응답의 값을 그대로
    articlePagingRequest: {
      size: 20, // 참고 구현과 같게 (큰 값은 검증에서 거절될 수 있음)
      userChannelType: 'PC',
      articleSortType: 'RANKING_DESC',
      ...(paging?.seed != null && { seed: paging.seed }),
      ...(paging?.lastInfo != null && { lastInfo: paging.lastInfo }),
    },
    userChannelType: 'PC',
  };
}

export default {
  key: 'naver',
  name: '네이버부동산',
  color: '#03c75a',
  homepage: 'https://fin.land.naver.com',

  async fetchRaw(ctx) {
    if (Date.now() < blockedUntil) {
      throw new Error(`요청 제한으로 대기 중 (${Math.ceil((blockedUntil - Date.now()) / 60000)}분 후 재시도)`);
    }
    const api = http(ctx);
    const maxPages = ctx.maxPages ?? 5;
    const out = [];
    let paging = null; // { seed, lastInfo } — 응답에서 받은 커서
    let vi = ctx.conditions ? preferredVariant : 1;
    const failures = [];

    for (let page = 1; page <= maxPages; page++) {
      let res;
      try {
        res = await api.request(URL_, { method: 'POST', body: payload(ctx.bbox, paging, ctx.conditions, VARIANTS[vi]) });
      } catch (err) {
        if (err.status === 429) blockedUntil = Date.now() + COOLDOWN_MS;
        // 형식 검증 오류 → 다음 형식으로 재시도 (첫 페이지에서만)
        if (err.status === 400 && page === 1 && vi < VARIANTS.length - 1) {
          failures.push(`${VARIANTS[vi].name} 형식 거절: ${err.message.split(' — ')[1] ?? err.message}`);
          vi++;
          page--;
          continue;
        }
        if (failures.length) err.message += ` (앞서 ${failures.join(' / ')})`;
        if (err.status === 400) {
          err.message += ` · 보낸 요청: ${JSON.stringify(payload(ctx.bbox, null, ctx.conditions, VARIANTS[vi])).slice(0, 600)}`;
        }
        if (out.length) {
          ctx.warn?.([`page ${page}: ${err.message}`]);
          break;
        }
        throw err;
      }
      if (res.isSuccess === false) {
        if (res.detailCode === 'TOO_MANY_REQUESTS') blockedUntil = Date.now() + COOLDOWN_MS;
        throw new Error(`네이버 응답 오류: ${res.detailCode ?? ''} ${res.message ?? ''}`.trim());
      }
      if (page === 1) {
        if (vi !== preferredVariant && ctx.conditions) {
          ctx.warn?.([`네이버가 조건 반영 형식을 거절해 '${VARIANTS[vi].name}'으로 수집했어요 (조건은 수집 후 걸러냄)`, ...failures]);
        }
        if (ctx.conditions) preferredVariant = vi;
      }
      const r = res.result ?? {};
      for (const item of r.list ?? []) out.push(item);
      if (!r.hasNextPage || r.lastInfo == null) break;
      paging = { seed: r.seed ?? paging?.seed ?? null, lastInfo: r.lastInfo };
    }
    return out;
  },

  normalize(raw) {
    const a = raw.representativeArticleInfo ?? raw;
    const price = a.priceInfo ?? {};
    const dealType = TRADE[a.tradeType] ?? '월세';
    const ad = a.address ?? {};
    const addr = { sido: shortSido(ad.city), sigungu: ad.division ?? '', dong: ad.sector ?? '', jibun: '' };
    const detail = a.articleDetail ?? {};
    const fd = detail.floorDetailInfo ?? {};
    let { floor, totalFloors } = parseFloor(detail.floorInfo);
    if (floor == null && fd.targetFloor != null) floor = parseFloor(String(fd.targetFloor)).floor;
    totalFloors ??= Number(fd.totalFloor) || null;
    const space = a.spaceInfo ?? {};

    return {
      id: `naver:${a.articleNumber}`,
      source: 'naver',
      sourceId: String(a.articleNumber),
      url: `https://fin.land.naver.com/articles/${a.articleNumber}`,
      title: detail.articleFeatureDescription || a.articleName || a.complexName || '',
      dealType,
      roomType: REAL_ESTATE[a.realEstateType] ?? '빌라',
      deposit: wonToManwon(dealType === '매매' ? price.dealPrice : price.warrantyPrice),
      monthlyRent: dealType === '월세' ? wonToManwon(price.rentPrice) : 0,
      maintenanceFee: wonToManwon(price.managementFeeAmount),
      areaM2: round1(Number(space.exclusiveSpace || space.supplySpace)),
      floor,
      totalFloors,
      address: [composeAddress(addr), a.complexName].filter(Boolean).join(' '),
      addr,
      lat: Number(ad.coordinates?.yCoordinate),
      lng: Number(ad.coordinates?.xCoordinate),
      images: a.articleMedia?.imageUrl ? [a.articleMedia.imageUrl] : [],
      updatedAt: toIso(a.verificationInfo?.articleConfirmDate ?? a.verificationInfo?.exposureStartDate),
    };
  },
};
