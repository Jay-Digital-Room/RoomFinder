/** bbox = { south, west, north, east } */

export function parseBbox(str) {
  const n = String(str).split(',').map(Number);
  if (n.length !== 4 || !n.every(Number.isFinite)) return null;
  const [south, west, north, east] = n;
  if (south >= north || west >= east) return null;
  return { south, west, north, east };
}

export function bboxCenter(b) {
  return { lat: (b.south + b.north) / 2, lng: (b.west + b.east) / 2 };
}

/** bbox 의 대략적인 크기 (km) */
export function bboxSizeKm(b) {
  const lat = bboxCenter(b).lat;
  return {
    width: (b.east - b.west) * 111.32 * Math.cos((lat * Math.PI) / 180),
    height: (b.north - b.south) * 110.57,
  };
}

/** 큰 bbox 를 step(도) 크기의 타일로 나눈다 */
export function splitBbox(b, step = 0.01) {
  const rows = Math.max(1, Math.ceil((b.north - b.south) / step - 1e-9));
  const cols = Math.max(1, Math.ceil((b.east - b.west) / step - 1e-9));
  const tiles = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      tiles.push({
        south: b.south + r * step,
        west: b.west + c * step,
        north: r === rows - 1 ? b.north : b.south + (r + 1) * step,
        east: c === cols - 1 ? b.east : b.west + (c + 1) * step,
      });
    }
  }
  return tiles;
}

export function inBbox(p, b) {
  return p.lat >= b.south && p.lat <= b.north && p.lng >= b.west && p.lng <= b.east;
}

/* ---- geohash (직방 API가 geohash 단위로 검색) ---- */

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export function geohashEncode(lat, lng, precision = 5) {
  let latR = [-90, 90];
  let lngR = [-180, 180];
  let hash = '';
  let bit = 0;
  let ch = 0;
  let even = true;
  while (hash.length < precision) {
    const r = even ? lngR : latR;
    const v = even ? lng : lat;
    const mid = (r[0] + r[1]) / 2;
    if (v >= mid) {
      ch |= 1 << (4 - bit);
      r[0] = mid;
    } else r[1] = mid;
    even = !even;
    if (++bit === 5) {
      hash += BASE32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return hash;
}

/** bbox 를 덮는 geohash 목록 (precision 5 ≈ 4.9km × 4.9km) */
export function geohashesForBbox(b, precision = 5) {
  // precision 5 셀 크기: 위도 ~0.0439°, 경도 ~0.0439°
  const latStep = 180 / 2 ** Math.floor((precision * 5) / 2);
  const lngStep = 360 / 2 ** Math.ceil((precision * 5) / 2);
  const set = new Set();
  for (let lat = b.south; lat <= b.north + latStep; lat += latStep / 2) {
    for (let lng = b.west; lng <= b.east + lngStep; lng += lngStep / 2) {
      set.add(geohashEncode(Math.min(lat, b.north), Math.min(lng, b.east), precision));
    }
  }
  return [...set];
}
