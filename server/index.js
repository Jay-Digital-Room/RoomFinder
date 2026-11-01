import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapConfig } from './config.js';
import { defaultStore, getAggregated } from './aggregator.js';
import { createCrawler } from './crawler.js';
import { parseBbox } from './crawl/geo.js';
import { DEAL_TYPES, ROOM_TYPES } from './model.js';
import { applyFilters, parseQuery, sortAndPage } from './query.js';
import { dataMode, getSources } from './sources/index.js';

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
export function createApp({ store = defaultStore, crawler, sources = getSources, mode = dataMode() } = {}) {
  crawler ??= createCrawler({ store, getSources: sources, options: crawlOptions() });

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
        });
      }

      if (pathname === '/api/crawl') {
        if (req.method === 'GET') return sendJson(res, 200, { crawling: crawler.running, sources: sourceStatus(), stats: getAggregated(store).stats });
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        const body = await readBody(req);
        const bbox = parseBbox(body.bounds);
        if (!bbox) return sendJson(res, 400, { error: 'bounds 형식: "남,서,북,동"' });
        if (!crawler.validateArea(bbox)) return sendJson(res, 400, { error: '영역이 너무 넓어요. 지도를 더 확대한 뒤 다시 시도하세요.' });
        if (crawler.running) return sendJson(res, 409, { error: '이미 수집 중입니다' });
        crawler.run(bbox, { reason: 'user' }).catch((err) => console.error(err));
        return sendJson(res, 202, { started: true });
      }

      if (pathname === '/api/listings') {
        const agg = getAggregated(store);
        const f = parseQuery(url.searchParams);
        const filtered = applyFilters(agg.groups, f);
        const page = sortAndPage(filtered, f);
        // 지도용 마커: 필터 결과 전체(페이지 무관), 최소 필드만
        const markers =
          url.searchParams.get('markers') === 'true'
            ? filtered.map((g) => ({ id: g.id, lat: g.lat, lng: g.lng, dealType: g.dealType, deposit: g.deposit, monthlyRent: g.monthlyRent, n: g.sources.length }))
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

  return { handle, crawler, store };
}

function crawlOptions() {
  const n = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    maxPages: n(process.env.CRAWL_MAX_PAGES, 5),
    maxItems: n(process.env.CRAWL_MAX_ITEMS, 300),
    delayMs: n(process.env.CRAWL_DELAY_MS, 1500),
  };
}

/** CRAWL_BBOXES="s,w,n,e;s,w,n,e" */
function configuredBboxes() {
  const raw = process.env.CRAWL_BBOXES ?? '37.545,126.900,37.565,126.935';
  return raw.split(';').map(parseBbox).filter(Boolean);
}

async function main() {
  const port = Number(process.env.PORT ?? 3000);
  const mode = dataMode();
  const app = createApp({ mode });
  createServer(app.handle).listen(port, () => {
    console.log(`RoomFinder 실행 중 → http://localhost:${port}  (데이터: ${mode}, 지도: ${mapConfig().provider})`);
  });

  if (mode === 'mock') {
    app.store.clear();
    await app.crawler.run({ south: -90, west: -180, north: 90, east: 180 }, { reason: 'mock' });
    return;
  }

  const bboxes = configuredBboxes();
  const crawlAll = async (reason) => {
    for (const b of bboxes) await app.crawler.run(b, { reason });
  };
  crawlAll('startup').catch((err) => console.error(err));
  const intervalMin = Number(process.env.CRAWL_INTERVAL_MIN ?? 60);
  if (intervalMin > 0) setInterval(() => crawlAll('schedule').catch((err) => console.error(err)), intervalMin * 60 * 1000);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
