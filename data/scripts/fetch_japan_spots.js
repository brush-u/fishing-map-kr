#!/usr/bin/env node
/**
 * 일본 낚시포인트 데이터를 만듭니다 (data/japan_spots.geojson).
 *
 * 한국은 해양수산부/data.go.kr에 낚시터 목록을 정리한 공식 공공데이터가 있지만, 일본은
 * (제가 조사해본 바로는) 그런 전국 단위의 무료 "낚시 스팟 좌표" 공공데이터가 없습니다. 대신
 * OpenStreetMap(오픈스트리트맵)의 leisure=fishing 태그(바다/강/호수 낚시터에 실제로 널리
 * 쓰이는 태그입니다 — 이미 이 프로젝트에서 편의점/주유소 검색에 쓰고 있는 것과 같은
 * Overpass API로 조회)를 씁니다. OSM은 오픈 라이선스(ODbL)라 이렇게 가져다 써도 됩니다.
 *
 * 방법: 일본 47개 도도부현을 하나씩 돌면서(전국을 한 번에 조회하면 Overpass 서버가 타임아웃
 * 내거나 거부하는 경우가 많아서), 그 도도부현의 사각 범위(bbox) 안에 있는 leisure=fishing
 * 지점을 가져옵니다. 그 다음 실제 폴리곤 경계로 다시 한번 정확히 어느 현에 속하는지
 * 판정합니다(bbox는 겹칠 수 있어서).
 *
 * 바다/민물 구분: 완전한 내륙현(바다가 없는 8개 현 — 群馬/埼玉/山梨/長野/岐阜/滋賀/奈良/栃木)은
 * 무조건 민물로 분류합니다. 그 외 현은 지점 이름에 강/호수/저수지를 뜻하는 낱말(湖·池·沼·川·
 * ダム 등)이 있으면 민물로, 아니면 바다로 분류합니다(연안현이라도 내륙 하천 낚시터가 있을 수
 * 있는데, 이름에 그런 실마리가 없으면 기본값을 바다로 두는 근사치입니다 — 100% 정확하진
 * 않습니다).
 *
 * 사용법: npm run fetch:japan
 * 완료되면 data/japan_spots.geojson 이 생성/갱신됩니다. 이 파일이 있으면 서버가 자동으로
 * 기존 낚시포인트 데이터에 합쳐서 내려줍니다(별도 설정 불필요) — data/boat_spots.geojson과
 * 동일한 방식입니다.
 *
 * 소요 시간: 47개 현을 하나씩 조회하느라 넉넉히 잡으면 10~20분 정도 걸릴 수 있습니다(무료
 * Overpass 서버가 혼잡하면 더 걸릴 수 있음). 실행 중 진행 상황이 계속 출력됩니다.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..');
const PREFECTURES_PATH = path.join(DATA_DIR, 'boundaries', 'japan-prefectures.geo.json');
const OUT_PATH = path.join(DATA_DIR, 'japan_spots.geojson');
const FAIL_LOG_PATH = path.join(DATA_DIR, 'japan_spots.fetch_failures.txt');

const OVERPASS_ENDPOINTS = process.env.OVERPASS_ENDPOINT
  ? [process.env.OVERPASS_ENDPOINT]
  : [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
      'https://overpass.osm.ch/api/interpreter',
    ];

const DELAY_BETWEEN_PREFECTURES_MS = 2000; // Overpass 무료 서버에 너무 몰아치지 않도록 예의상 간격을 둡니다.
const REQUEST_TIMEOUT_MS = 60000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 점-폴리곤 판정 (public/app.js의 pointInRing/pointInPolygonCoords/pointInGeometry와 동일한
// 표준 ray-casting 알고리즘 — 브라우저 쪽과 로직을 맞추기 위해 그대로 옮겨왔습니다)
// ---------------------------------------------------------------------------
function pointInRing(point, ring) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInPolygonCoords(point, rings) {
  if (!pointInRing(point, rings[0])) return false;
  for (let k = 1; k < rings.length; k++) {
    if (pointInRing(point, rings[k])) return false;
  }
  return true;
}

function pointInGeometry(point, geometry) {
  if (geometry.type === 'Polygon') return pointInPolygonCoords(point, geometry.coordinates);
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.some((poly) => pointInPolygonCoords(point, poly));
  return false;
}

function bboxCenterOf(geometry) {
  const { minX, minY, maxX, maxY } = bboxOf(geometry);
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

function haversineKm([lng1, lat1], [lng2, lat2]) {
  const R = 6371;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// 낚시포인트는 해안가/방파제처럼 지도 경계 데이터가 3% 단순화되면서 깎여나간 자리에 있는
// 경우가 흔해서, 어느 현 폴리곤에도 정확히 안 들어가는 점이 꽤 나옵니다. 그런 점을 그냥
// 버리면 정작 중요한 해안 낚시포인트가 많이 빠지게 되므로, 폴리곤 매칭에 실패하면 가장 가까운
// 현(폴리곤 중심 기준)에 배정합니다 — public/app.js의 assignProvinces와 같은 방식입니다.
function findPrefecture(coord, prefectures) {
  const exact = prefectures.find((pf) => pointInGeometry(coord, pf.geometry));
  if (exact) return exact;
  let best = null;
  let bestDist = Infinity;
  for (const pf of prefectures) {
    const d = haversineKm(coord, bboxCenterOf(pf.geometry));
    if (d < bestDist) {
      bestDist = d;
      best = pf;
    }
  }
  return best;
}

function bboxOf(geometry) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const visit = (ring) => ring.forEach(([x, y]) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  });
  const polys = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
  polys.forEach((poly) => poly.forEach(visit));
  return { minX, minY, maxX, maxY };
}

const FRESHWATER_KEYWORDS = /湖|池|沼|川|渓流|ダム|養魚場/;
const SEA_KEYWORDS = /海|磯|港|浜|波止|堤防|沖|防波堤/;

function classifyWaterType(name, landlocked) {
  if (landlocked) return 'freshwater';
  const n = name || '';
  if (FRESHWATER_KEYWORDS.test(n)) return 'freshwater';
  return 'sea'; // 연안현 기본값 — 이름에 실마리가 없으면 바다로 간주 (근사치, README 참고)
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function queryOverpassBbox(south, west, north, east) {
  const query = `[out:json][timeout:50];nwr["leisure"="fishing"](${south},${west},${north},${east});out center tags;`;
  let lastErr = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const r = await fetchWithTimeout(
        endpoint,
        { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: query },
        REQUEST_TIMEOUT_MS
      );
      if (!r.ok) throw new Error(`Overpass HTTP ${r.status} (${endpoint})`);
      const data = await r.json();
      return data.elements || [];
    } catch (err) {
      lastErr = err;
      console.warn(`  ⚠ ${endpoint} 실패: ${err.message || err}`);
    }
  }
  throw lastErr || new Error('모든 Overpass 서버 실패');
}

async function main() {
  if (!fs.existsSync(PREFECTURES_PATH)) {
    console.error(`✗ ${PREFECTURES_PATH} 가 없습니다. 먼저 일본 도도부현 경계 파일을 받아주세요.`);
    process.exit(1);
  }
  const prefectures = JSON.parse(fs.readFileSync(PREFECTURES_PATH, 'utf8')).features;
  console.log(`➜ 일본 ${prefectures.length}개 도도부현을 순서대로 조회합니다 (Overpass API, leisure=fishing 태그)`);

  const allElements = [];
  const failures = [];

  for (let i = 0; i < prefectures.length; i++) {
    const pref = prefectures[i];
    const { minX, minY, maxX, maxY } = bboxOf(pref.geometry);
    process.stdout.write(`  [${i + 1}/${prefectures.length}] ${pref.properties.name} 조회 중... `);
    try {
      const elements = await queryOverpassBbox(minY, minX, maxY, maxX);
      console.log(`${elements.length}건`);
      allElements.push(...elements);
    } catch (err) {
      console.log(`실패 (${err.message || err})`);
      failures.push(`${pref.properties.name}: ${err.message || err}`);
    }
    if (i < prefectures.length - 1) await sleep(DELAY_BETWEEN_PREFECTURES_MS);
  }

  // bbox가 도도부현 경계끼리 겹칠 수 있어서, 같은 지점(osm type+id)이 여러 번 잡혔을 수 있습니다.
  const seen = new Set();
  const deduped = allElements.filter((el) => {
    const key = `${el.type}/${el.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  console.log(`\n➜ 전체 ${allElements.length}건 중 중복 제거 후 ${deduped.length}건`);

  const features = [];
  let skippedNoCoord = 0;
  for (const el of deduped) {
    const point = el.type === 'node' ? { lat: el.lat, lon: el.lon } : el.center;
    if (!point) {
      skippedNoCoord++;
      continue;
    }
    const name = el.tags?.name || el.tags?.['name:ja'] || null;

    // 실제 폴리곤 경계로 정확히 어느 현에 속하는지 재판정합니다 (bbox 조회는 겹칠 수 있어서
    // 근사치였습니다 — 여기서 정확한 소속을 다시 매깁니다. 폴리곤에 안 걸리면 가장 가까운
    // 현으로 대체합니다 — 해안 단순화로 깎여나간 자리의 진짜 해안 낚시포인트를 버리지
    // 않기 위함입니다).
    const coord = [point.lon, point.lat];
    const matchedPref = findPrefecture(coord, prefectures);
    if (!matchedPref) continue; // 이론상 여기 도달하지 않음 (현이 0개일 때만)

    const waterType = classifyWaterType(name, matchedPref.properties.landlocked);

    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
      properties: {
        name: name || `${matchedPref.properties.name} 낚시포인트`,
        waterType,
        region: matchedPref.properties.name,
        species: [],
        facilityType: null,
        source: 'OpenStreetMap contributors (ODbL) — leisure=fishing',
        country: 'JP',
      },
    });
  }

  const geojson = {
    type: 'FeatureCollection',
    metadata: {
      source: 'OpenStreetMap (Overpass API, leisure=fishing 태그) — ODbL 라이선스',
      generatedAt: new Date().toISOString(),
      totalFetched: deduped.length,
      featureCount: features.length,
      note: '전국 단위 공식 공공데이터가 없어 OSM 크라우드소싱 데이터를 대신 사용했습니다. 바다/민물 구분은 내륙현 여부 + 지점명 키워드로 판정한 근사치입니다.',
    },
    features,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(geojson, null, 2), 'utf8');
  console.log(`\n✅ 완료: ${OUT_PATH} (${features.length}곳, 좌표 없어 제외 ${skippedNoCoord}건)`);

  if (failures.length) {
    fs.writeFileSync(FAIL_LOG_PATH, failures.join('\n'), 'utf8');
    console.log(`⚠ 일부 현 조회 실패 (${failures.length}곳) — ${path.basename(FAIL_LOG_PATH)} 참고. 그냥 이 스크립트를 다시 실행하면 처음부터 다시 받습니다.`);
  }
}

main().catch((err) => {
  console.error('✗ 실행 중 오류:', err);
  process.exit(1);
});