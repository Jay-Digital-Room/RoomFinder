import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../server/crawl/http.js';
import { geohashEncode, geohashesForBbox, splitBbox } from '../server/crawl/geo.js';

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, at: Date.now() });
    const r = responses.shift() ?? { status: 200, body: '{}' };
    return new Response(r.body ?? '{}', { status: r.status ?? 200, headers: r.headers ?? {} });
  };
  fn.calls = calls;
  return fn;
}

test('요청 사이 최소 간격을 지킨다', async () => {
  const f = fakeFetch([]);
  const c = createClient({ name: 't', minDelayMs: 60, fetchImpl: f });
  await Promise.all([c.request('http://x/1'), c.request('http://x/2'), c.request('http://x/3')]);
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls[1].at - f.calls[0].at >= 55);
  assert.ok(f.calls[2].at - f.calls[1].at >= 55);
});

test('429/5xx 는 재시도, retryOn429=false 면 즉시 실패', async () => {
  const f = fakeFetch([{ status: 503 }, { status: 429, headers: { 'retry-after': '0' } }, { status: 200, body: '{"ok":1}' }]);
  const c = createClient({ name: 't', minDelayMs: 0, fetchImpl: f });
  // 백오프 시간을 줄이기 위해 첫 재시도만 확인
  const res = await c.request('http://x');
  assert.deepEqual(res, { ok: 1 });
  assert.equal(f.calls.length, 3);

  const g = fakeFetch([{ status: 429 }]);
  const c2 = createClient({ name: 't', minDelayMs: 0, retryOn429: false, fetchImpl: g });
  await assert.rejects(c2.request('http://x'), (err) => err.status === 429);
});

test('JSON 이 아닌 응답(차단 페이지 등)은 명확한 오류', async () => {
  const c = createClient({ name: 't', minDelayMs: 0, fetchImpl: fakeFetch([{ body: '<html>captcha</html>' }]) });
  await assert.rejects(c.request('http://x'), /JSON 이 아닌 응답/);
});

test('쿠키를 저장해 다음 요청에 보낸다', async () => {
  const f = fakeFetch([{ headers: { 'set-cookie': 'SID=abc; Path=/' } }, {}]);
  const c = createClient({ name: 't', minDelayMs: 0, fetchImpl: f });
  await c.request('http://x/1');
  await c.request('http://x/2');
  assert.equal(f.calls[1].init.headers.cookie, 'SID=abc');
});

test('geohash', () => {
  assert.equal(geohashEncode(37.5665, 126.978, 5), 'wydm9');
  const hs = geohashesForBbox({ south: 37.545, west: 126.9, north: 37.565, east: 126.935 });
  assert.ok(hs.length >= 1 && hs.every((h) => h.length === 5));
});

test('splitBbox 는 영역을 빠짐없이 나눈다', () => {
  const tiles = splitBbox({ south: 37.5, west: 127.0, north: 37.53, east: 127.025 }, 0.01);
  assert.equal(tiles.length, 9);
  assert.equal(Math.max(...tiles.map((t) => t.north)), 37.53);
});

test('접속 불가(ENOTFOUND)면 이후 요청은 기다리지 않고 바로 실패', async () => {
  let n = 0;
  const f = async () => {
    n++;
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  };
  const c = createClient({ name: 't', minDelayMs: 500, fetchImpl: f });
  const t0 = Date.now();
  await assert.rejects(c.request('http://x/1'), /ENOTFOUND/);
  await assert.rejects(c.request('http://x/2'), /ENOTFOUND/);
  await assert.rejects(c.request('http://x/3'), /ENOTFOUND/);
  assert.equal(n, 1);
  assert.ok(Date.now() - t0 < 300);
});
