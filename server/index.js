import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAggregated } from './aggregator.js';
import { DEAL_TYPES, ROOM_TYPES } from './model.js';
import { applyFilters, parseQuery, sortAndPage } from './query.js';

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
  offerCount: offers.length,
  offers: offers.map(({ source, deposit, monthlyRent }) => ({ source, deposit, monthlyRent })),
});

export async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;

  try {
    if (pathname === '/api/health') return sendJson(res, 200, { ok: true });

    if (pathname === '/api/meta') {
      const agg = await getAggregated();
      return sendJson(res, 200, {
        dealTypes: DEAL_TYPES,
        roomTypes: ROOM_TYPES,
        sources: agg.status,
        stats: agg.stats,
        updatedAt: new Date(agg.at).toISOString(),
      });
    }

    if (pathname === '/api/listings') {
      const agg = await getAggregated({ force: url.searchParams.get('refresh') === 'true' });
      const f = parseQuery(url.searchParams);
      const filtered = applyFilters(agg.groups, f);
      const page = sortAndPage(filtered, f);
      // 지도용 마커: 필터 결과 전체(페이지 무관), 최소 필드만
      const markers = url.searchParams.get('markers') === 'true'
        ? filtered.map((g) => ({ id: g.id, lat: g.lat, lng: g.lng, dealType: g.dealType, deposit: g.deposit, monthlyRent: g.monthlyRent, n: g.sources.length }))
        : undefined;
      return sendJson(res, 200, { ...page, items: page.items.map(summarize), markers });
    }

    const m = pathname.match(/^\/api\/listings\/([a-f0-9]+)$/);
    if (m) {
      const agg = await getAggregated();
      const g = agg.byId.get(m[1]);
      return g ? sendJson(res, 200, g) : sendJson(res, 404, { error: '매물을 찾을 수 없습니다' });
    }

    if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
    return serveStatic(res, pathname);
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: 'internal error' });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  createServer(handle).listen(port, () => {
    console.log(`RoomFinder 실행 중 → http://localhost:${port}`);
  });
}
