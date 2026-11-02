/* RoomFinder 프론트엔드 — 프레임워크 없이 동작하는 단일 모듈 */
import { createMap } from './maps/index.js';

const $ = (sel) => document.querySelector(sel);
const state = {
  meta: null,
  filters: {
    q: '',
    dealType: new Set(),
    roomType: new Set(),
    source: new Set(),
  },
  sort: 'recent',
  page: 1,
  items: [],
  total: 0,
};

/* ---------- 포맷터 ---------- */

/** 만원 → "1억 2,000" */
export function formatMoney(manwon) {
  const eok = Math.floor(manwon / 10000);
  const rest = manwon % 10000;
  const restStr = rest.toLocaleString('ko-KR');
  if (!eok) return restStr;
  return rest ? `${eok}억 ${restStr}` : `${eok}억`;
}

export function formatPrice({ dealType, deposit, monthlyRent }) {
  if (dealType === '월세') return `월세 ${formatMoney(deposit)}/${monthlyRent}`;
  return `${dealType} ${formatMoney(deposit)}`;
}

function formatFloor(floor, total) {
  let f;
  if (floor == null) f = '층 비공개';
  else if (floor === -0.5) f = '반지하';
  else if (floor < 0) f = `지하${-floor}층`;
  else f = `${floor}층`;
  return total ? `${f}/${total}층` : f;
}

const pyeong = (m2) => (m2 / 3.305785).toFixed(1);

function timeAgo(iso) {
  const diff = (Date.now() - Date.parse(iso)) / 1000;
  if (diff < 3600) return `${Math.max(1, Math.floor(diff / 60))}분 전`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
  return `${Math.floor(diff / 86400)}일 전`;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function sourceMeta(key) {
  return state.meta?.sources.find((s) => s.key === key) ?? { key, name: key, color: '#888' };
}

function sourceBadge(key) {
  const s = sourceMeta(key);
  return `<span class="badge" style="--c:${s.color}">${esc(s.name)}</span>`;
}

/* ---------- 필터 UI ---------- */

function renderChips(container, values, set, labelOf = (v) => v, colorOf = null) {
  container.innerHTML = values
    .map((v) => {
      const style = colorOf ? ` style="--c:${colorOf(v)}"` : '';
      return `<button type="button" class="chip${set.has(v) ? ' on' : ''}" data-v="${esc(v)}" aria-pressed="${set.has(v)}"${style}>${esc(labelOf(v))}</button>`;
    })
    .join('');
  container.onclick = (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    const v = btn.dataset.v;
    set.has(v) ? set.delete(v) : set.add(v);
    btn.classList.toggle('on');
    btn.setAttribute('aria-pressed', set.has(v));
    refresh();
  };
}

const NUM_FIELDS = ['depositMin', 'depositMax', 'rentMin', 'rentMax', 'areaMin', 'areaMax'];
const BOOL_FIELDS = ['multiSourceOnly', 'priceGapOnly'];

function buildParams(page) {
  const p = new URLSearchParams();
  const f = state.filters;
  if (f.q) p.set('q', f.q);
  for (const k of ['dealType', 'roomType', 'source']) if (f[k].size) p.set(k, [...f[k]].join(','));
  for (const id of NUM_FIELDS) {
    const v = $(`#${id}`).value;
    if (v !== '') p.set(id, v);
  }
  for (const id of BOOL_FIELDS) if ($(`#${id}`).checked) p.set(id, 'true');
  if ($('#boundsOnly').checked && map) {
    const b = map.getBounds();
    p.set('bounds', [b.south, b.west, b.north, b.east].map((n) => n.toFixed(5)).join(','));
  }
  p.set('sort', state.sort);
  p.set('page', page);
  p.set('pageSize', 30);
  return p;
}

/** 필터 상태를 URL에 반영 → 새로고침·공유해도 같은 결과 */
function syncUrl() {
  const p = buildParams(1);
  p.delete('page');
  p.delete('pageSize');
  p.delete('bounds');
  if (p.get('sort') === 'recent') p.delete('sort');
  history.replaceState(null, '', p.toString() ? `?${p}` : location.pathname);
}

function restoreFromUrl() {
  const p = new URLSearchParams(location.search);
  state.filters.q = p.get('q') ?? '';
  $('#q').value = state.filters.q;
  for (const k of ['dealType', 'roomType', 'source']) {
    // 칩 핸들러가 Set 참조를 들고 있으므로 교체하지 않고 내용만 바꾼다
    state.filters[k].clear();
    for (const v of (p.get(k) ?? '').split(',').filter(Boolean)) state.filters[k].add(v);
  }
  for (const id of NUM_FIELDS) $(`#${id}`).value = p.get(id) ?? '';
  for (const id of BOOL_FIELDS) $(`#${id}`).checked = p.get(id) === 'true';
  state.sort = p.get('sort') ?? 'recent';
  $('#sort').value = state.sort;
}

/* ---------- 결과 목록 ---------- */

function cardHtml(g) {
  const gap = g.priceGap
    ? `<span class="gap">플랫폼 간 최대 ${g.priceGap.monthlyRent ? `월 ${g.priceGap.monthlyRent}만` : `${formatMoney(Math.abs(g.priceGap.deposit))}만`} 차이</span>`
    : '';
  return `
    <li class="card${g.image ? ' has-thumb' : ''}" data-id="${g.id}" tabindex="0" role="button" aria-label="${esc(g.title)} 상세 보기">
      ${g.image ? `<img class="thumb" src="${esc(g.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />` : ''}
      <div class="card-top">
        <span class="room-type">${esc(g.roomType)}</span>
        <span class="updated">${timeAgo(g.updatedAt)}</span>
      </div>
      <div class="price">${formatPrice(g)}<small>${g.offerCount > 1 ? ' 최저' : ''}</small></div>
      <div class="spec">${g.areaM2}㎡ (${pyeong(g.areaM2)}평) · ${formatFloor(g.floor, g.totalFloors)} · 관리비 ${g.maintenanceFee}만</div>
      <div class="title">${esc(g.title)}</div>
      <div class="addr">${esc(g.address)}</div>
      <div class="card-foot">
        <div class="badges">${g.sources.map(sourceBadge).join('')}</div>
        ${gap}
      </div>
    </li>`;
}

let fetchSeq = 0;

async function refresh() {
  state.page = 1;
  syncUrl();
  await load({ append: false });
}

async function load({ append }) {
  const seq = ++fetchSeq;
  const params = buildParams(state.page);
  if (!append) params.set('markers', 'true');
  $('#resultCount').textContent = '불러오는 중…';

  let data;
  try {
    const res = await fetch(`/api/listings?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    if (seq === fetchSeq) $('#resultCount').textContent = `불러오기 실패: ${err.message}`;
    return;
  }
  if (seq !== fetchSeq) return; // 더 최신 요청이 있으면 무시

  state.items = append ? state.items.concat(data.items) : data.items;
  state.total = data.total;

  const cards = $('#cards');
  if (append) cards.insertAdjacentHTML('beforeend', data.items.map(cardHtml).join(''));
  else cards.innerHTML = data.items.length
    ? data.items.map(cardHtml).join('')
    : `<li class="empty">${
        state.meta?.stats.rawCount === 0
          ? state.meta.crawling
            ? '매물을 수집하는 중이에요. 잠시만 기다려 주세요…'
            : '아직 수집된 매물이 없어요. 지도에서 원하는 지역으로 이동한 뒤 <b>이 지역 매물 불러오기</b>를 눌러 보세요.'
          : '조건에 맞는 매물이 없어요. 필터를 조정해 보세요.'
      }</li>`;

  $('#resultCount').innerHTML = `매물 <strong>${data.total.toLocaleString()}</strong>개`;
  $('#loadMore').hidden = state.items.length >= data.total;
  if (data.markers) renderMarkers(data.markers);
}

/* ---------- 지도 ---------- */

let map = null; // public/maps/index.js 의 공통 인터페이스 (카카오/네이버/Leaflet)

async function initMap(config) {
  map = await createMap($('#map'), config);
  document.body.dataset.mapProvider = map.name;
  if (lastMarkers.length) renderMarkers(lastMarkers);
  else focusConditionAreas();
  let t;
  map.onIdle(() => {
    renderMarkers(lastMarkers); // 확대/축소에 따라 클러스터 다시 계산
    if (!$('#boundsOnly').checked) return;
    clearTimeout(t);
    t = setTimeout(refresh, 300);
  });
}

function shortPrice(m) {
  if (m.dealType === '월세') return `${formatMoney(m.deposit)}/${m.monthlyRent}`;
  return m.deposit >= 10000 ? `${(m.deposit / 10000).toFixed(m.deposit % 10000 ? 1 : 0)}억` : formatMoney(m.deposit);
}

/** 수집 조건의 지역으로 지도 이동 (아직 매물이 없을 때) */
function focusConditionAreas() {
  const c = state.meta?.conditions;
  if (!map || !c || state.meta.dataMode !== 'live') return;
  const areas = [...c.regions.map((id) => state.meta.regions.find((r) => r.id === id)).filter(Boolean), ...c.customAreas];
  const pts = areas.flatMap((a) => [{ lat: a.south, lng: a.west }, { lat: a.north, lng: a.east }]);
  if (pts.length) map.fitTo(pts, { padding: 20 });
}

let lastMarkers = [];
let fittedOnce = false;
const CLUSTER_PX = 70;
const CLUSTER_ABOVE_M_PER_PX = 5; // 이보다 축소된 화면이면 클러스터링 (대략 줌 15 미만)

/**
 * 위경도 격자 기반 클러스터링 — 지도 종류와 무관하게 동작.
 * 격자 크기는 현재 화면의 "픽셀당 거리"로 정한다.
 */
function clusterMarkers(markers) {
  const b = map.getBounds();
  const widthPx = $('#map').clientWidth || 800;
  const heightPx = $('#map').clientHeight || 600;
  const cellLng = ((b.east - b.west) / widthPx) * CLUSTER_PX;
  const cellLat = ((b.north - b.south) / heightPx) * CLUSTER_PX;
  const metersPerPx = ((b.east - b.west) * 88000) / widthPx;
  if (!(metersPerPx > CLUSTER_ABOVE_M_PER_PX)) return markers.map((m) => [m]);

  const cells = new Map();
  for (const m of markers) {
    const key = `${Math.floor(m.lng / cellLng)}:${Math.floor(m.lat / cellLat)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(m);
  }
  return [...cells.values()];
}

function el(html, onClick) {
  const wrap = document.createElement('div');
  wrap.innerHTML = html.trim();
  const node = wrap.firstChild;
  if (onClick) {
    node.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
  }
  return node;
}

function renderMarkers(markers) {
  if (!map) return;
  lastMarkers = markers;
  if (!fittedOnce && markers.length) {
    fittedOnce = true;
    map.fitTo(markers);
    return; // fitTo 이후 idle 이벤트에서 다시 그려짐
  }

  const overlays = [];
  for (const g of clusterMarkers(markers)) {
    if (g.length > 1) {
      const lat = g.reduce((s, m) => s + m.lat, 0) / g.length;
      const lng = g.reduce((s, m) => s + m.lng, 0) / g.length;
      const size = Math.round(Math.min(60, 30 + Math.sqrt(g.length) * 5));
      overlays.push({
        lat,
        lng,
        el: el(
          `<div class="ov-center"><div class="cluster" style="width:${size}px;height:${size}px" title="매물 ${g.length}개">${g.length}</div></div>`,
          () => map.fitTo(g, { padding: 60, maxZoomIn: true }),
        ),
      });
      continue;
    }
    const m = g[0];
    overlays.push({
      lat: m.lat,
      lng: m.lng,
      el: el(
        `<div class="ov-bottom"><div class="pin deal-${m.dealType}" data-mid="${m.id}" title="${shortPrice(m)}">${shortPrice(m)}${m.n > 1 ? `<b>${m.n}</b>` : ''}</div></div>`,
        () => openDetail(m.id),
      ),
    });
  }
  map.setOverlays(overlays);
}

/* ---------- 상세 ---------- */

async function openDetail(id) {
  const dlg = $('#detail');
  $('#detailBody').innerHTML = '<p class="loading">불러오는 중…</p>';
  if (!dlg.open) dlg.showModal();

  const res = await fetch(`/api/listings/${id}`);
  if (!res.ok) {
    $('#detailBody').innerHTML = '<p>매물 정보를 불러오지 못했습니다.</p>';
    return;
  }
  const g = await res.json();
  const best = g.offers[0];

  const rows = g.offers
    .map((o, i) => {
      const s = sourceMeta(o.source);
      const diff =
        i === 0
          ? '<span class="tag best">최저가</span>'
          : o.dealType === '월세'
            ? o.monthlyRent - best.monthlyRent || o.deposit - best.deposit
              ? `<span class="tag">+${o.monthlyRent - best.monthlyRent ? `월 ${o.monthlyRent - best.monthlyRent}만` : `${formatMoney(o.deposit - best.deposit)}만`}</span>`
              : '<span class="tag same">동일</span>'
            : o.deposit - best.deposit
              ? `<span class="tag">+${formatMoney(o.deposit - best.deposit)}만</span>`
              : '<span class="tag same">동일</span>';
      return `
        <tr>
          <td><span class="badge" style="--c:${s.color}">${esc(s.name)}</span></td>
          <td class="num">${formatPrice(o)}</td>
          <td>${diff}</td>
          <td class="muted">${timeAgo(o.updatedAt)}</td>
          <td>${o.url ? `<a href="${esc(o.url)}" target="_blank" rel="noopener noreferrer">원문 보기 ↗</a>` : '<span class="muted" title="가상 데이터 모드의 매물은 실제 사이트에 없습니다">가상 매물</span>'}</td>
        </tr>`;
    })
    .join('');

  $('#detailBody').innerHTML = `
    <header class="detail-head">
      <div>
        <p class="room-type">${esc(g.roomType)} · ${esc(g.dealType)}</p>
        <h2 id="detailTitle">${esc(g.title)}</h2>
        <p class="addr">${esc(g.address)}</p>
      </div>
      <button class="icon-btn" id="closeDetail" aria-label="닫기">✕</button>
    </header>

    <div class="detail-price">${formatPrice(g)} <small>최저</small></div>

    <dl class="facts">
      <div><dt>전용면적</dt><dd>${g.areaM2}㎡ (${pyeong(g.areaM2)}평)</dd></div>
      <div><dt>층</dt><dd>${formatFloor(g.floor, g.totalFloors)}</dd></div>
      <div><dt>관리비</dt><dd>${g.maintenanceFee}만원</dd></div>
      <div><dt>등록 플랫폼</dt><dd>${g.sources.length}곳</dd></div>
    </dl>

    <h3>플랫폼별 가격 비교</h3>
    <div class="table-wrap">
      <table class="offers">
        <thead><tr><th>플랫폼</th><th>가격</th><th>차이</th><th>확인</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="note">같은 주소·면적·층의 매물을 자동으로 묶었습니다. 실제 계약 전 원문과 등기부등본을 꼭 확인하세요.</p>
  `;
  $('#closeDetail').onclick = () => dlg.close();

  map?.focus(g);
}

/* ---------- 수집 상태 ---------- */

function renderSourceBar() {
  const { sources, stats, crawling, dataMode } = state.meta;
  const ago = (iso) => (iso ? timeAgo(iso) : '아직 안 함');
  $('#sourceBar').innerHTML =
    sources
      .map((s) => {
        const cls = s.running ? 'running' : s.error ? 'fail' : 'ok';
        const label = s.running ? `수집 중${s.total > 1 ? ` ${s.done ?? 0}/${s.total}` : '…'}` : s.error ? '오류' : `${s.count}`;
        const tip = s.error
          ? `마지막 시도 ${ago(s.lastRunAt)} 실패: ${s.error}`
          : `마지막 수집 ${ago(s.lastOkAt)}${s.warnings?.length ? ` · 경고 ${s.warnings.length}건` : ''}`;
        return `<span class="src ${cls}" style="--c:${s.color}" title="${esc(tip)}">${esc(s.name)} ${label}${s.verified ? '' : '<sup title="응답 형식이 검증되지 않은 수집기">β</sup>'}</span>`;
      })
      .join('') +
    `<span class="src-summary">${
      dataMode === 'mock'
        ? '<b>가상 데이터</b> · '
        : `<button type="button" class="link cond-summary" title="수집 조건 바꾸기">${esc(state.meta.conditionsText ?? '')}</button> · `
    }원본 ${stats.rawCount}건 → 중복 ${stats.duplicatesMerged}건 통합</span>`;
  $('#sourceBar .cond-summary')?.addEventListener('click', openConditions);
}

let crawlTimer = null;
function watchCrawl() {
  clearTimeout(crawlTimer);
  $('#crawlHere').disabled = true;
  $('#crawlHere').textContent = '불러오는 중…';
  const tick = async () => {
    try {
      const r = await fetch('/api/crawl').then((x) => x.json());
      const grew = r.stats.rawCount !== state.meta.stats.rawCount;
      Object.assign(state.meta, { sources: r.sources, stats: r.stats, crawling: r.crawling });
      renderSourceBar();
      if (grew) refresh(); // 먼저 끝난 사이트의 매물부터 바로 보여주기
      if (r.crawling) {
        crawlTimer = setTimeout(tick, 2500);
        return;
      }
    } catch {
      crawlTimer = setTimeout(tick, 5000);
      return;
    }
    $('#crawlHere').disabled = false;
    $('#crawlHere').textContent = '이 지역 매물 불러오기';
    refresh();
  };
  crawlTimer = setTimeout(tick, 1500);
}

async function crawlHere() {
  if (!map) return;
  const b = map.getBounds();
  const res = await fetch('/api/crawl', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bounds: [b.south, b.west, b.north, b.east].map((n) => n.toFixed(5)).join(',') }),
  });
  if (res.status === 202 || res.status === 409) {
    state.meta.crawling = true;
    renderSourceBar();
    watchCrawl();
  } else {
    const { error } = await res.json().catch(() => ({}));
    alert(error ?? '수집 요청 실패');
  }
}

/* ---------- 수집 조건 ---------- */

const SOURCE_LABEL = { zigbang: '직방', dabang: '다방', naver: '네이버부동산', peterpan: '피터팬' };
let draft = null;

function chipGroup(container, values, selected, labelOf = (v) => v) {
  container.innerHTML = values
    .map((v) => `<button type="button" class="chip${selected.includes(v) ? ' on' : ''}" data-v="${esc(v)}" aria-pressed="${selected.includes(v)}">${esc(labelOf(v))}</button>`)
    .join('');
  container.onclick = (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    const v = btn.dataset.v;
    const i = selected.indexOf(v);
    i >= 0 ? selected.splice(i, 1) : selected.push(v);
    btn.classList.toggle('on', i < 0);
    btn.setAttribute('aria-pressed', String(i < 0));
    $('#condError').textContent = '';
  };
}

function renderCustomAreas() {
  $('#condCustom').innerHTML = draft.customAreas
    .map((a, i) => `<span class="chip on">${esc(a.name)} <button type="button" class="x" data-i="${i}" aria-label="삭제">✕</button></span>`)
    .join('');
  $('#condCustom').onclick = (e) => {
    const x = e.target.closest('.x');
    if (!x) return;
    draft.customAreas.splice(Number(x.dataset.i), 1);
    renderCustomAreas();
  };
}

function openConditions() {
  const c = state.meta.conditions;
  draft = structuredClone(c);
  chipGroup($('#condRegions'), state.meta.regions.map((r) => r.id), draft.regions, (id) => state.meta.regions.find((r) => r.id === id)?.name ?? id);
  chipGroup($('#condDeals'), state.meta.dealTypes, draft.dealTypes);
  chipGroup($('#condRooms'), state.meta.roomTypes, draft.roomTypes);
  chipGroup($('#condSources'), Object.keys(SOURCE_LABEL), draft.sources, (k) => SOURCE_LABEL[k]);
  $('#condDepositMax').value = c.depositMax ?? '';
  $('#condRentMax').value = c.rentMax ?? '';
  renderCustomAreas();
  $('#condError').textContent = '';
  $('#condAddMapArea').hidden = !map;
  $('#conditions').showModal();
}

function addMapArea() {
  if (!map) return;
  const b = map.getBounds();
  const km = (b.east - b.west) * 88.3;
  const kmH = (b.north - b.south) * 110.6;
  if (km > 6 || kmH > 6) {
    $('#condError').textContent = '지도 영역이 너무 넓어요 (한 변 6km 이하). 지도를 더 확대한 뒤 추가해 주세요.';
    return;
  }
  const r = (n) => Number(n.toFixed(5));
  draft.customAreas.push({ name: `지도 영역 ${draft.customAreas.length + 1}`, south: r(b.south), west: r(b.west), north: r(b.north), east: r(b.east) });
  renderCustomAreas();
}

async function saveConditionsForm(e) {
  e.preventDefault();
  const err = (m) => ($('#condError').textContent = m);
  if (!draft.regions.length && !draft.customAreas.length) return err('지역을 하나 이상 골라 주세요.');
  if (draft.regions.length + draft.customAreas.length > 6) return err('지역은 최대 6곳까지 고를 수 있어요.');
  if (!draft.dealTypes.length) return err('거래 유형을 하나 이상 골라 주세요.');
  if (!draft.roomTypes.length) return err('방 종류를 하나 이상 골라 주세요.');
  if (!draft.sources.length) return err('플랫폼을 하나 이상 골라 주세요.');
  draft.depositMax = $('#condDepositMax').value || null;
  draft.rentMax = $('#condRentMax').value || null;

  $('#condSave').disabled = true;
  try {
    const res = await fetch('/api/conditions', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft) });
    const body = await res.json();
    if (!res.ok) return err(body.error ?? '저장 실패');
    state.meta.conditions = body.conditions;
    state.meta.conditionsText = body.text;
    state.meta.crawling = true;
    $('#conditions').close();
    fittedOnce = false; // 새 매물이 들어오면 그 위치로 지도 맞춤
    focusConditionAreas();
    renderSourceBar();
    refresh();
    watchCrawl();
  } finally {
    $('#condSave').disabled = false;
  }
}

/* ---------- 초기화 ---------- */

async function init() {
  restoreFromUrl();
  const res = await fetch('/api/meta');
  state.meta = await res.json();
  // 지도 SDK 로드는 목록 표시를 막지 않도록 기다리지 않는다
  initMap(state.meta.map).catch((err) => {
    console.error(err);
    $('#map').innerHTML = '<p class="map-error">지도를 불러오지 못했습니다.</p>';
  });

  renderSourceBar();
  if (state.meta.dataMode === 'live') $('#crawlHere').hidden = false;
  $('#openConditions').hidden = state.meta.dataMode !== 'live';
  $('#openConditions').addEventListener('click', openConditions);
  $('#closeConditions').addEventListener('click', () => $('#conditions').close());
  $('#condAddMapArea').addEventListener('click', addMapArea);
  $('#condForm').addEventListener('submit', saveConditionsForm);
  $('#crawlHere').addEventListener('click', crawlHere);
  if (state.meta.crawling) watchCrawl();

  renderChips($('#dealTypeChips'), state.meta.dealTypes, state.filters.dealType);
  renderChips($('#roomTypeChips'), state.meta.roomTypes, state.filters.roomType);
  renderChips(
    $('#sourceChips'),
    state.meta.sources.map((s) => s.key),
    state.filters.source,
    (k) => sourceMeta(k).name,
    (k) => sourceMeta(k).color,
  );

  // 이벤트
  $('#searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    state.filters.q = $('#q').value.trim();
    refresh();
  });
  let qTimer;
  $('#q').addEventListener('input', () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      state.filters.q = $('#q').value.trim();
      refresh();
    }, 350);
  });

  let numTimer;
  for (const id of NUM_FIELDS) {
    $(`#${id}`).addEventListener('input', () => {
      clearTimeout(numTimer);
      numTimer = setTimeout(refresh, 400);
    });
  }
  for (const id of [...BOOL_FIELDS, 'boundsOnly']) $(`#${id}`).addEventListener('change', refresh);

  $('#sort').addEventListener('change', (e) => {
    state.sort = e.target.value;
    refresh();
  });

  $('#loadMore').addEventListener('click', () => {
    state.page += 1;
    load({ append: true });
  });

  $('#resetFilters').addEventListener('click', () => {
    history.replaceState(null, '', location.pathname);
    $('#boundsOnly').checked = false;
    restoreFromUrl();
    document.querySelectorAll('.chip.on').forEach((c) => {
      c.classList.remove('on');
      c.setAttribute('aria-pressed', 'false');
    });
    refresh();
  });

  const cards = $('#cards');
  cards.addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (card) openDetail(card.dataset.id);
  });
  cards.addEventListener('keydown', (e) => {
    const card = e.target.closest('.card');
    if (card && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      openDetail(card.dataset.id);
    }
  });
  cards.addEventListener('mouseover', (e) => {
    const card = e.target.closest('.card');
    document.querySelectorAll('.pin.hl').forEach((p) => p.classList.remove('hl'));
    if (card) document.querySelector(`#map .pin[data-mid="${card.dataset.id}"]`)?.classList.add('hl');
  });

  $('#detail').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.close(); // 바깥 클릭 시 닫기
  });

  // 모바일: 필터 패널 / 목록·지도 전환
  $('#filterToggle').addEventListener('click', () => document.body.classList.toggle('show-filters'));
  $('#applyFilters').addEventListener('click', () => document.body.classList.remove('show-filters'));
  document.querySelectorAll('.mobile-tabs button').forEach((btn) =>
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mobile-tabs button').forEach((b) => b.classList.toggle('active', b === btn));
      document.body.dataset.view = btn.dataset.view;
      if (btn.dataset.view === 'map') setTimeout(() => map?.relayout(), 50);
    }),
  );

  await refresh();
}

init();
