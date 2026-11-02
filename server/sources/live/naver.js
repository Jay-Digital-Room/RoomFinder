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

function payload(bbox, lastInfo, conditions) {
  const tradeTypes = conditions ? conditions.dealTypes.map((d) => TRADE_CODE[d]) : ['A1', 'B1', 'B2'];
  const realEstateTypes = conditions
    ? [...new Set(conditions.roomTypes.flatMap((r) => ROOM_CODES[r] ?? []))]
    : ['C01', 'C02', 'A02', 'A01'];
  const range = {};
  // 가격 필터는 "원" 단위. 다른 거래유형은 걸러내지 않는다(네이버 동작)
  if (conditions?.depositMax) range.warrantyPrice = { max: conditions.depositMax * 10000 };
  if (conditions?.rentMax) range.rentPrice = { max: conditions.rentMax * 10000 };
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
      legalDivisionNumbers: [],
      legalDivisionType: 'EUP',
      filtersExclusiveSpace: false,
      hasArticlePhoto: false,
      isAuthorizedByOwner: false,
    },
    boundingBox: { left: bbox.west, right: bbox.east, top: bbox.north, bottom: bbox.south },
    precision: 16,
    articlePagingRequest: { size: 50, userChannelType: 'PC', articleSortType: 'DATE_DESC', seed: null, lastInfo: lastInfo ?? null },
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
    let lastInfo = null;

    for (let page = 1; page <= maxPages; page++) {
      let res;
      try {
        res = await api.request(URL_, { method: 'POST', body: payload(ctx.bbox, lastInfo, ctx.conditions) });
      } catch (err) {
        if (err.status === 429) blockedUntil = Date.now() + COOLDOWN_MS;
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
      const r = res.result ?? {};
      for (const item of r.list ?? []) out.push(item);
      if (!r.hasNextPage || r.lastInfo == null) break;
      lastInfo = r.lastInfo;
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
