#!/usr/bin/env node
/**
 * 일본 낚시포인트 데이터를 만듭니다 (data/japan_spots.geojson) — OSM PBF 추출 파일을 오프라인으로
 * 직접 읽어서 처리하는 방식입니다.
 *
 * 왜 Overpass API(실시간 조회) 대신 이 방식을 쓰나요?
 * 2026년 들어 공개 Overpass 서버(overpass-api.de)가 AI 크롤러 과부하 때문에 요청을 광범위하게
 * 406/429로 거부하는 일이 매우 잦아졌습니다 (이건 이 프로젝트나 여러분의 네트워크 설정 문제가
 * 아니라 Overpass 운영자들이 공개적으로 인정한 서버 과부하 상황입니다). Overpass 쪽에서도
 * "나라 단위로 많은 데이터가 필요하면 실시간 API 대신 지역 추출 파일(extract)을 내려받아
 * 오프라인으로 처리하라"고 권장하고 있어서, 이 스크립트는 그 방식을 씁니다:
 *
 *   1) Geofabrik(OSM 추출 파일을 무료로 제공하는 곳)에서 일본 전체 OSM 데이터 파일
 *      (japan-latest.osm.pbf, 약 1.5GB)을 직접 내려받습니다 — 딱 한 번만 하면 됩니다.
 *   2) 이 스크립트가 그 파일을 로컬에서 읽어서 leisure=fishing(낚시터) 태그가 붙은 지점만
 *      골라냅니다. 네트워크 요청이 전혀 없으므로 차단/속도제한 문제가 없습니다.
 *   3) 그 다음은 기존과 동일하게 실제 도도부현 폴리곤으로 소속을 정하고, 바다/민물을 분류합니다.
 *
 * 사용법:
 *   1. https://download.geofabrik.de/asia/japan-latest.osm.pbf 에서 파일을 내려받습니다.
 *      (브라우저로 열면 바로 다운로드가 시작됩니다. 용량이 커서 몇 분 걸릴 수 있습니다.)
 *   2. 받은 파일을 이 프로젝트의 data/raw/japan-latest.osm.pbf 위치에 둡니다
 *      (data/raw 폴더가 없으면 새로 만들어서 그 안에 넣어주세요).
 *   3. npm run fetch:japan 을 실행합니다.
 *
 * 완료되면 data/japan_spots.geojson 이 생성/갱신됩니다. 이 파일이 있으면 서버가 자동으로
 * 기존 낚시포인트 데이터에 합쳐서 내려줍니다(별도 설정 불필요).
 *
 * 바다/민물 구분: 완전한 내륙현(바다가 없는 8개 현 — 群馬/埼玉/山梨/長野/岐阜/滋賀/奈良/栃木)은
 * 무조건 민물로 분류합니다. 그 외 현은 지점 이름에 강/호수/저수지를 뜻하는 낱말(湖·池·沼·川·
 * ダム 등)이 있으면 민물로, 아니면 바다로 분류합니다 (근사치입니다 — README 참고).
 *
 * 소요 시간: 파일을 한 번 내려받는 데는 네트워크 속도에 따라 몇 분, 이 스크립트 자체의 처리
 * 시간은 보통 1~3분 정도입니다(기기 성능에 따라 다름) — Overpass 방식(10~20분, 차단되면 무한정)
 * 보다 훨씬 빠르고 안정적입니다.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..');
const PREFECTURES_PATH = path.join(DATA_DIR, 'boundaries', 'japan-prefectures.geo.json');
const OUT_PATH = path.join(DATA_DIR, 'japan_spots.geojson');
const PBF_PATH = process.env.JAPAN_PBF_PATH || path.join(DATA_DIR, 'raw', 'japan-latest.osm.pbf');
const DOWNLOAD_URL = 'https://download.geofabrik.de/asia/japan-latest.osm.pbf';

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

const FRESHWATER_KEYWORDS = /湖|池|沼|川|渓流|ダム|養魚場/;

function classifyWaterType(name, landlocked) {
  if (landlocked) return 'freshwater';
  const n = name || '';
  if (FRESHWATER_KEYWORDS.test(n)) return 'freshwater';
  return 'sea'; // 연안현 기본값 — 이름에 실마리가 없으면 바다로 간주 (근사치, README 참고)
}

function printDownloadInstructions() {
  console.error(`✗ ${PBF_PATH} 파일이 없습니다.\n`);
  console.error('이 스크립트는 일본 전체 OSM 데이터 파일을 로컬에서 직접 읽어서 처리합니다');
  console.error('(공개 Overpass API 서버가 요즘 과부하로 요청을 자주 막아서, 대신 이 방식을 씁니다).\n');
  console.error('다음 순서로 준비해주세요:');
  console.error(`  1. 브라우저로 ${DOWNLOAD_URL} 을 열어 내려받습니다 (약 1.5GB, 몇 분 걸릴 수 있습니다).`);
  console.error(`  2. 받은 파일을 "${PBF_PATH}" 위치에 둡니다 (data/raw 폴더가 없으면 새로 만들어주세요).`);
  console.error('  3. npm run fetch:japan 을 다시 실행합니다.\n');
}

async function main() {
  if (!fs.existsSync(PREFECTURES_PATH)) {
    console.error(`✗ ${PREFECTURES_PATH} 가 없습니다. 먼저 일본 도도부현 경계 파일을 받아주세요.`);
    process.exit(1);
  }
  if (!fs.existsSync(PBF_PATH)) {
    printDownloadInstructions();
    process.exit(1);
  }

  let pbf2json;
  try {
    pbf2json = require('pbf2json');
  } catch (err) {
    console.error('✗ pbf2json 패키지가 설치되어 있지 않습니다. "npm install"을 먼저 실행해주세요.');
    process.exit(1);
  }

  const prefectures = JSON.parse(fs.readFileSync(PREFECTURES_PATH, 'utf8')).features;
  const stat = fs.statSync(PBF_PATH);
  console.log(`➜ ${PBF_PATH} (${(stat.size / 1024 / 1024).toFixed(0)}MB) 에서 leisure=fishing 태그 지점을 읽는 중...`);
  console.log('  (파일 크기에 따라 1~3분 정도 걸릴 수 있습니다. 네트워크 요청 없이 로컬에서만 처리합니다.)');

  const rawElements = [];
  let scanned = 0;

  await new Promise((resolve, reject) => {
    const stream = pbf2json.createReadStream({ file: PBF_PATH, tags: ['leisure~fishing'] });
    stream.on('data', (el) => {
      scanned++;
      rawElements.push(el);
      if (scanned % 200 === 0) process.stdout.write(`\r  ${scanned}건 발견...`);
    });
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  console.log(`\r  ${scanned}건 발견 (완료)          `);

  // 같은 지점(osm type+id)이 중복으로 잡혔을 수 있어 제거합니다.
  const seen = new Set();
  const deduped = rawElements.filter((el) => {
    const key = `${el.type}/${el.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  console.log(`➜ 전체 ${rawElements.length}건 중 중복 제거 후 ${deduped.length}건`);

  const features = [];
  let skippedNoCoord = 0;
  for (const el of deduped) {
    // node는 lat/lon이 직접 있고, way는 pbf2json이 계산해주는 centroid를 씁니다.
    // (relation은 현재 pbf2json이 기본 설정으로는 노드까지 풀어내지 못해 좌표가 없는 경우가
    // 있어서, 그런 경우는 자동으로 건너뜁니다 — 대부분의 낚시터는 node/way로 매핑되어 있어
    // 실제 누락은 적습니다.)
    let lat, lon;
    if (el.type === 'node') {
      lat = el.lat;
      lon = el.lon;
    } else if (el.centroid) {
      lat = parseFloat(el.centroid.lat);
      lon = parseFloat(el.centroid.lon);
    }
    if (typeof lat !== 'number' || typeof lon !== 'number' || Number.isNaN(lat) || Number.isNaN(lon)) {
      skippedNoCoord++;
      continue;
    }

    const name = el.tags?.name || el.tags?.['name:ja'] || null;

    // 실제 폴리곤 경계로 정확히 어느 현에 속하는지 판정합니다. 폴리곤에 안 걸리면 가장 가까운
    // 현으로 대체합니다 — 해안 단순화로 깎여나간 자리의 진짜 해안 낚시포인트를 버리지 않기
    // 위함입니다.
    const coord = [lon, lat];
    const matchedPref = findPrefecture(coord, prefectures);
    if (!matchedPref) continue; // 이론상 여기 도달하지 않음 (현이 0개일 때만)

    const waterType = classifyWaterType(name, matchedPref.properties.landlocked);

    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
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
      source: 'OpenStreetMap (Geofabrik 추출 파일, leisure=fishing 태그) — ODbL 라이선스',
      extractFile: path.basename(PBF_PATH),
      generatedAt: new Date().toISOString(),
      totalFetched: deduped.length,
      featureCount: features.length,
      note: '전국 단위 공식 공공데이터가 없어 OSM 크라우드소싱 데이터를 대신 사용했습니다. Overpass 실시간 API 대신 Geofabrik의 오프라인 추출 파일을 로컬에서 처리했습니다 (공개 Overpass 서버의 과부하/차단 문제 회피). 바다/민물 구분은 내륙현 여부 + 지점명 키워드로 판정한 근사치입니다.',
    },
    features,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(geojson, null, 2), 'utf8');
  console.log(`\n✅ 완료: ${OUT_PATH} (${features.length}곳, 좌표 없어 제외 ${skippedNoCoord}건)`);
}

main().catch((err) => {
  console.error('✗ 실행 중 오류:', err);
  process.exit(1);
});