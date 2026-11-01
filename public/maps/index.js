/**
 * 지도 제공자 추상화.
 *
 * 모든 구현체는 아래 인터페이스를 따른다 (좌표는 항상 {lat, lng}):
 *   setOverlays([{ lat, lng, el: HTMLElement }])  // el 의 좌상단이 좌표에 놓임 → 정렬은 CSS(.ov-*)로
 *   getBounds() → { south, west, north, east }
 *   fitTo([{lat,lng}], { padding, maxZoomIn })
 *   focus({lat,lng})                               // 해당 위치로 이동 + 적당히 확대
 *   onIdle(cb)                                     // 이동·확대 끝났을 때
 *   relayout()                                     // 컨테이너 크기 변경 후 호출
 *   name
 */

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`지도 스크립트 로드 실패: ${src}`));
    document.head.appendChild(s);
  });
}

const DEFAULT_CENTER = { lat: 37.53, lng: 126.99 };

/* ---------------- 카카오맵 ---------------- */

async function createKakao(el, { key }) {
  await loadScript(`https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&autoload=false`);
  await new Promise((r) => window.kakao.maps.load(r));
  const { kakao } = window;
  const map = new kakao.maps.Map(el, { center: new kakao.maps.LatLng(DEFAULT_CENTER.lat, DEFAULT_CENTER.lng), level: 7 });
  map.addControl(new kakao.maps.ZoomControl(), kakao.maps.ControlPosition.RIGHT);
  let overlays = [];

  return {
    name: 'kakao',
    setOverlays(items) {
      overlays.forEach((o) => o.setMap(null));
      overlays = items.map(
        ({ lat, lng, el: content }) =>
          new kakao.maps.CustomOverlay({ map, position: new kakao.maps.LatLng(lat, lng), content, xAnchor: 0, yAnchor: 0, clickable: true }),
      );
    },
    getBounds() {
      const b = map.getBounds();
      const sw = b.getSouthWest();
      const ne = b.getNorthEast();
      return { south: sw.getLat(), west: sw.getLng(), north: ne.getLat(), east: ne.getLng() };
    },
    fitTo(points, { padding = 40, maxZoomIn = false } = {}) {
      if (!points.length) return;
      const b = new kakao.maps.LatLngBounds();
      points.forEach((p) => b.extend(new kakao.maps.LatLng(p.lat, p.lng)));
      map.setBounds(b, padding, padding, padding, padding);
      // 카카오는 level 이 작을수록 확대. 너무 확대되지 않도록 제한
      if (maxZoomIn && map.getLevel() < 3) map.setLevel(3);
    },
    focus({ lat, lng }) {
      map.setCenter(new kakao.maps.LatLng(lat, lng));
      if (map.getLevel() > 4) map.setLevel(4);
    },
    onIdle(cb) {
      kakao.maps.event.addListener(map, 'idle', cb);
    },
    relayout() {
      map.relayout();
    },
  };
}

/* ---------------- 네이버 지도 ---------------- */

async function createNaver(el, { key }) {
  // 네이버 클라우드 플랫폼 Maps (2025년 신규 콘솔부터 파라미터명이 ncpKeyId)
  window.navermap_authFailure = () => {
    el.innerHTML = '<p class="map-error">네이버 지도 인증 실패: Client ID와 등록된 서비스 URL을 확인하세요.</p>';
  };
  await loadScript(`https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${encodeURIComponent(key)}`);
  const { naver } = window;
  const map = new naver.maps.Map(el, {
    center: new naver.maps.LatLng(DEFAULT_CENTER.lat, DEFAULT_CENTER.lng),
    zoom: 13,
    zoomControl: true,
    zoomControlOptions: { position: naver.maps.Position.TOP_RIGHT },
  });
  let markers = [];

  return {
    name: 'naver',
    setOverlays(items) {
      markers.forEach((m) => m.setMap(null));
      markers = items.map(
        ({ lat, lng, el: content }) =>
          new naver.maps.Marker({
            map,
            position: new naver.maps.LatLng(lat, lng),
            icon: { content, anchor: new naver.maps.Point(0, 0) },
          }),
      );
    },
    getBounds() {
      const b = map.getBounds();
      const sw = b.getSW();
      const ne = b.getNE();
      return { south: sw.lat(), west: sw.lng(), north: ne.lat(), east: ne.lng() };
    },
    fitTo(points, { padding = 40, maxZoomIn = false } = {}) {
      if (!points.length) return;
      const b = new naver.maps.LatLngBounds(
        new naver.maps.LatLng(points[0].lat, points[0].lng),
        new naver.maps.LatLng(points[0].lat, points[0].lng),
      );
      points.forEach((p) => b.extend(new naver.maps.LatLng(p.lat, p.lng)));
      map.fitBounds(b, { top: padding, right: padding, bottom: padding, left: padding });
      if (maxZoomIn && map.getZoom() > 17) map.setZoom(17);
    },
    focus({ lat, lng }) {
      map.setCenter(new naver.maps.LatLng(lat, lng));
      if (map.getZoom() < 16) map.setZoom(16);
    },
    onIdle(cb) {
      naver.maps.Event.addListener(map, 'idle', cb);
    },
    relayout() {
      map.setSize(new naver.maps.Size(el.clientWidth, el.clientHeight));
    },
  };
}

/* ---------------- Leaflet + OSM (API 키 없을 때 대체) ---------------- */

async function createLeaflet(el) {
  const { L } = window;
  if (!L) throw new Error('Leaflet 로드 실패');
  const map = L.map(el).setView([DEFAULT_CENTER.lat, DEFAULT_CENTER.lng], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
  const layer = L.layerGroup().addTo(map);

  return {
    name: 'leaflet',
    setOverlays(items) {
      layer.clearLayers();
      for (const { lat, lng, el: html } of items) {
        layer.addLayer(L.marker([lat, lng], { icon: L.divIcon({ className: '', html, iconSize: null }) }));
      }
    },
    getBounds() {
      const b = map.getBounds();
      return { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
    },
    fitTo(points, { padding = 40, maxZoomIn = false } = {}) {
      if (!points.length) return;
      map.fitBounds(L.latLngBounds(points.map((p) => [p.lat, p.lng])), { padding: [padding, padding], maxZoom: maxZoomIn ? 17 : 18 });
    },
    focus({ lat, lng }) {
      map.setView([lat, lng], Math.max(map.getZoom(), 16));
    },
    onIdle(cb) {
      map.on('moveend', cb);
    },
    relayout() {
      map.invalidateSize();
    },
  };
}

/**
 * config.map = { provider: 'kakao'|'naver'|'leaflet', key }
 * 카카오/네이버 로드에 실패하면 Leaflet 으로 대체한다.
 */
export async function createMap(el, config) {
  const factories = { kakao: createKakao, naver: createNaver, leaflet: createLeaflet };
  const factory = factories[config?.provider] ?? createLeaflet;
  try {
    // 키가 잘못되면 SDK 가 로드되고도 초기화가 끝나지 않는 경우가 있어 타임아웃을 둔다
    return await Promise.race([
      factory(el, config ?? {}),
      new Promise((_, reject) => setTimeout(() => reject(new Error('지도 초기화 시간 초과 (API 키·허용 도메인 확인)')), 8000)),
    ]);
  } catch (err) {
    console.warn(`[map] ${config?.provider} 실패, Leaflet 으로 대체:`, err);
    el.innerHTML = '';
    return createLeaflet(el);
  }
}
