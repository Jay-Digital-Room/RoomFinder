/**
 * 크롤링용 HTTP 클라이언트.
 *  - 소스별로 요청을 한 줄로 세우고(동시 요청 1개), 요청 사이 최소 간격을 둔다
 *  - 429/5xx 는 Retry-After 또는 지수 백오프로 재시도
 *  - 응답 쿠키를 저장해 다음 요청에 보냄 (세션 쿠키가 필요한 사이트 대응)
 */
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} ${url.split('?')[0]}`);
    this.status = status;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createClient({
  name,
  minDelayMs = 1500,
  headers = {},
  retries = 3,
  retryOn429 = true,
  timeoutMs = 15000,
  fetchImpl = globalThis.fetch,
} = {}) {
  let chain = Promise.resolve();
  let lastAt = 0;
  const cookies = new Map();
  let requestCount = 0;
  let offline = null; // { until, message } — 접속 불가 판정 후 잠시 요청을 보내지 않음

  function storeCookies(res) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of list) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (i > 0) cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }

  async function doRequest(url, { method = 'GET', headers: h = {}, body, json = true } = {}) {
    if (offline && Date.now() < offline.until) throw new Error(offline.message);
    for (let attempt = 0; ; attempt++) {
      const wait = lastAt + minDelayMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastAt = Date.now();
      requestCount++;

      const reqHeaders = {
        'user-agent': DEFAULT_UA,
        accept: 'application/json, text/plain, */*',
        'accept-language': 'ko-KR,ko;q=0.9,en;q=0.8',
        ...headers,
        ...h,
      };
      if (cookies.size) reqHeaders.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
      if (body && typeof body !== 'string') {
        body = JSON.stringify(body);
        reqHeaders['content-type'] ??= 'application/json';
      }

      let res;
      try {
        res = await fetchImpl(url, { method, headers: reqHeaders, body, signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        const code = err.cause?.code ?? err.name ?? err.message;
        // 주소를 못 찾거나 접속이 거부되면 재시도해도 소용없음 → 바로 실패 (기다리는 시간 줄이기)
        const fatal = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'CERT_HAS_EXPIRED'].includes(code);
        const message = `[${name}] 네트워크 오류: ${code}`;
        if (fatal) offline = { until: Date.now() + 60_000, message };
        if (fatal || attempt >= Math.min(retries, 1)) throw new Error(message);
        await sleep(1000);
        continue;
      }
      storeCookies(res);

      if ((res.status === 429 && retryOn429) || res.status >= 500) {
        if (attempt >= retries) throw new HttpError(res.status, url, await res.text().catch(() => ''));
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new HttpError(res.status, url, await res.text().catch(() => ''));
      if (!json) return res.text();
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`[${name}] JSON 이 아닌 응답 (차단되었을 수 있음): ${text.slice(0, 120)}`);
      }
    }
  }

  return {
    /** 요청을 소스별 큐에 넣어 순차 실행 */
    request(url, opts) {
      const p = chain.then(() => doRequest(url, opts));
      chain = p.catch(() => {});
      return p;
    },
    get requestCount() {
      return requestCount;
    },
    cookies,
  };
}
