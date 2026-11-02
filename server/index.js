import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapConfig } from './config.js';
import { askConditions } from './prompt.js';
import { search } from './search/index.js';
import { createAiRanker } from './search/ai.js';
import { defaultStore, getAggregated } from './aggregator.js';
import { createCrawler } from './crawler.js';
import { inBbox, parseBbox } from './crawl/geo.js';
import { DEAL_TYPES, ROOM_TYPES } from './model.js';
import { applyFilters, parseQuery, sortAndPage } from './query.js';
import { dataMode, getSources } from './sources/index.js';
import { REGIONS, areasOf, describe, loadConditions, matches, sanitize, saveConditions } from './conditions.js';

const PUBLIC_DIR = resolve(fileURLToPath(new URL('../public', import.meta.url)));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function serveStatic(res, pathname) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  let file = join(PUBLIC_DIR, rel || 'index.html');
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'not found' });
  }
}

/** 리스트 응답에서는 무거운 필드를 줄인다 */
const summarize = ({ offers, images, addr, ...g }) => ({
  ...g,
  image: images[0] ?? null,
  offerCount: offers.length,
  offers: offers.map(({ source, deposit, monthlyRent }) => ({ source, deposit, monthlyRent })),
});

async function readBody(req, limit = 10_000) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw Object.assign(new Error('body too large'), { status: 413 });
  }
  return body ? JSON.parse(body) : {};
}

/**
 * 앱 생성. 테스트에서는 store/crawler 를 주입한다.
 */
export function createApp({ store = defaultStore, crawler, sources = getSources, mode = dataMode(), conditions, logger, persist = true, ai } = {}) {
  crawler ??= createCrawler({ store, getSources: sources, options: crawlOptions(), logger });
  let current = conditions ?? loadConditions().conditions;

  // AI 검색: ai 를 넘기면 그대로(null = 끔), 안 넘기면 .env 의 ANTHROPIC_API_KEY 로 생성
  let aiRanker = ai ?? null;
  const aiReady = ai === undefined ? createAiRanker().then((r) => (aiRanker = r)).catch(() => null) : Promise.resolve(aiRanker);

  /** 현재 조건으로 수집 (mock 모드는 조건과 무관하게 전체 가상 데이터) */
  function crawlConditions(reason) {
    if (mode === 'mock') return crawler.run({ south: -90, west: -180, north: 90, east: 180 }, { reason });
    return crawler.run(areasOf(current), { reason, conditions: current });
  }

  /** 조건 변경 → 새 조건에 안 맞는 매물(다른 지역·유형) 정리 */
  function setConditions(next) {
    current = sanitize(next);
    if (persist) saveConditions(current);
    if (mode !== 'mock') {
      const areas = areasOf(current);
      store.retain((l) => current.sources.includes(l.source) && matches(l, current) && areas.some((a) => inBbox(l, a)));
    }
    return current;
  }

  function sourceStatus() {
    const counts = store.countBySource();
    return sources().map((s) => {
      const st = crawler.status(s.key);
      return {
        key: s.key,
        name: s.name,
        color: s.color,
        homepage: s.homepage,
        verified: s.verified !== false,
        count: counts[s.key] ?? 0,
        ok: !st.lastError,
        running: Boolean(st.running),
        lastRunAt: st.lastRunAt ? new Date(st.lastRunAt).toISOString() : null,
        lastOkAt: st.lastOkAt ? new Date(st.lastOkAt).toISOString() : null,
        error: st.lastError ?? null,
        errors: st.errors ?? [],
        warnings: st.warnings ?? [],
      };
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;

    try {
      if (pathname === '/api/health') return sendJson(res, 200, { ok: true });

      if (pathname === '/api/meta') {
        const agg = getAggregated(store);
        return sendJson(res, 200, {
          dealTypes: DEAL_TYPES,
          roomTypes: ROOM_TYPES,
          sources: sourceStatus(),
          stats: agg.stats,
          dataMode: mode,
          crawling: crawler.running,
          map: mapConfig(),
          conditions: current,
          conditionsText: describe(current),
          regions: REGIONS,
          ai: { enabled: Boolean(aiRanker), model: aiRanker?.model ?? null },
        });
      }

      if (pathname === '/api/search') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        const body = await readBody(req);
        const query = String(body.query ?? '').trim().slice(0, 300);
        if (!query) return sendJson(res, 400, { error: '검색어를 입력해 주세요' });
        await aiReady;
        const useAi = body.ai !== false && aiRanker;
        const started = Date.now();
        const result = await search(getAggregated(store).groups, query, { ai: useAi ? aiRanker : null });
        console.log(`[검색:${result.mode}] "${query}" → ${result.results.length}개 (${Date.now() - started}ms)`);
        return sendJson(res, 200, { ...result, aiAvailable: Boolean(aiRanker) });
      }

      if (pathname === '/api/conditions') {
        if (req.method === 'GET') return sendJson(res, 200, { conditions: current, text: describe(current), regions: REGIONS });
        if (req.method !== 'PUT') return sendJson(res, 405, { error: 'method not allowed' });
        const body = await readBody(req);
        if (crawler.running) return sendJson(res, 409, { error: '수집이 끝난 뒤에 다시 시도해 주세요' });
        setConditions(body);
        if (body.crawl !== false) crawlConditions('조건변경').catch((err) => console.error(err));
        return sendJson(res, 200, { conditions: current, text: describe(current), crawling: crawler.running });
      }

      if (pathname === '/api/crawl') {
        if (req.method === 'GET') return sendJson(res, 200, { crawling: crawler.running, sources: sourceStatus(), stats: getAggregated(store).stats });
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        const body = await readBody(req);
        const bbox = parseBbox(body.bounds);
        if (!bbox) return sendJson(res, 400, { error: 'bounds 형식: "남,서,북,동"' });
        if (!crawler.validateArea(bbox)) return sendJson(res, 400, { error: '영역이 너무 넓어요. 지도를 더 확대한 뒤 다시 시도하세요.' });
        if (crawler.running) return sendJson(res, 409, { error: '이미 수집 중입니다' });
        // 지도 영역 수집도 현재 조건(거래유형·방 종류·가격·플랫폼)을 적용
        const opts = mode === 'mock' ? { reason: '지도' } : { reason: '지도', conditions: current };
        crawler.run({ ...bbox, name: '지도 영역' }, opts).catch((err) => console.error(err));
        return sendJson(res, 202, { started: true });
      }

      if (pathname === '/api/listings') {
        const agg = getAggregated(store);
        const f = parseQuery(url.searchParams);
        const filtered = applyFilters(agg.groups, f);
        const page = sortAndPage(filtered, f);
        // 지도용 마커: 필터 결과 전체(페이지 무관), 최소 필드만
        // 지도 마커는 목록과 달리 "지도 영역·선택한 건물" 조건을 빼고 전체를 보낸다
        // (목록은 지도를 따라가고, 지도에는 조건에 맞는 매물이 항상 다 보이도록)
        const markers =
          url.searchParams.get('markers') === 'true'
            ? (f.bounds || f.ids.length ? applyFilters(agg.groups, { ...f, bounds: null, ids: [] }) : filtered).map((g) => ({
                id: g.id,
                lat: g.lat,
                lng: g.lng,
                dealType: g.dealType,
                deposit: g.deposit,
                monthlyRent: g.monthlyRent,
                n: g.sources.length,
              }))
            : undefined;
        return sendJson(res, 200, { ...page, items: page.items.map(summarize), markers });
      }

      const m = pathname.match(/^\/api\/listings\/([a-f0-9]+)$/);
      if (m) {
        const g = getAggregated(store).byId.get(m[1]);
        return g ? sendJson(res, 200, g) : sendJson(res, 404, { error: '매물을 찾을 수 없습니다' });
      }

      if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
      return serveStatic(res, pathname);
    } catch (err) {
      if (err.status) return sendJson(res, err.status, { error: err.message });
      if (err instanceof SyntaxError) return sendJson(res, 400, { error: 'invalid JSON' });
      console.error(err);
      return sendJson(res, 500, { error: 'internal error' });
    }
  }

  return { handle, crawler, store, crawlConditions, setConditions, get conditions() { return current; } };
}

function crawlOptions() {
  const n = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    maxPages: n(process.env.CRAWL_MAX_PAGES, 3),
    maxItems: n(process.env.CRAWL_MAX_ITEMS, 200),
    delayMs: n(process.env.CRAWL_DELAY_MS, 1500),
  };
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    /* 브라우저를 못 열어도 주소는 콘솔에 출력됨 */
  }
}

async function main() {
  const port = Number(process.env.PORT ?? 3000);
  const mode = dataMode();
  const args = process.argv.slice(2);
  // 터미널에서 직접 실행했을 때만 질문 (--no-ask 로 생략, 백그라운드 실행 시 자동 생략)
  const interactive = mode === 'live' && process.stdin.isTTY && !args.includes('--no-ask');

  let { conditions, saved } = loadConditions();
  if (interactive) {
    conditions = await askConditions(conditions, { saved });
    saveConditions(conditions);
  }

  const app = createApp({ mode, conditions });
  if (mode === 'mock') app.store.clear();

  const server = createServer(app.handle);
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n포트 ${port} 이(가) 이미 사용 중입니다. 이미 실행 중인 RoomFinder 창을 닫거나, .env 에서 PORT 를 바꿔 주세요.`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log(`\nRoomFinder 실행 중 → ${url}  (데이터: ${mode === 'mock' ? '가상' : '실제'}, 지도: ${mapConfig().provider})`);
    if (mode === 'live') console.log(`수집 조건: ${describe(app.conditions)}`);
    console.log('매물은 사이트별로 수집이 끝나는 대로 화면에 나타납니다. 끄려면 Ctrl + C');
    if (!args.includes('--no-open') && process.env.NO_OPEN !== '1') openBrowser(url);
  });

  await app.crawlConditions(mode === 'mock' ? '가상' : '시작').catch((err) => console.error(err));
  const intervalMin = Number(process.env.CRAWL_INTERVAL_MIN ?? 60);
  if (mode === 'live' && intervalMin > 0) {
    setInterval(() => app.crawlConditions('주기').catch((err) => console.error(err)), intervalMin * 60 * 1000);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
