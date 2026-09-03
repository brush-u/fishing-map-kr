#!/usr/bin/env node
/**
 * data/boat_spots.geojson(= npm run geocode:boats로 만든 배낚시 지점 목록)에서
 * "육지 내륙"으로 보이는(=주소/키워드 지오코딩이 잘못 매칭된 것으로 의심되는) 지점을
 * 걸러냅니다.
 *
 * 왜 필요한가:
 *   geocode_boat_ports.js는 CSV에 있는 텍스트 주소/장소명을 카카오 로컬 API로 좌표 변환합니다.
 *   낚시어선업 CSV의 "출입항명"/"영업장소명"이 짧거나 흔한 이름(예: 동명의 다른 지역 상호,
 *   행정동 이름 등)일 경우, 카카오 검색이 실제로는 전혀 다른 내륙의 장소로 잘못 매칭되는
 *   경우가 있습니다. 낚시어선은 정의상 바다에 접한 항/포구에서 출항하므로, 실제 해안선에서
 *   많이 떨어진 지점은 지오코딩이 잘못된 것으로 볼 수 있습니다.
 *
 * 어떻게 판단하는가 (이 프로젝트 샌드박스에는 실제 해안선 지리 데이터가 없어서, 아래 두 가지를
 * "해안 기준점" 삼아 각 배낚시 지점에서 가장 가까운 기준점까지의 직선거리를 씁니다):
 *   1) data/spots.geojson(또는 sample)의 category !== 'boat' && waterType === 'sea' 지점들
 *      (이미 확인된 바다 낚시포인트)
 *   2) data/tide_stations.json의 국립해양조사원 조위관측소 55곳 (전부 실제 해안/도서에 설치된
 *      관측소라 아주 신뢰할 수 있는 "해안선 위의 점"입니다)
 *
 * 주의(정확도의 한계): 이건 "실제 해안선까지의 거리"가 아니라 "가장 가까운 기준점까지의
 * 직선거리"라서, ①두 기준점 사이 간격이 넓은 해안 구간에 있는 진짜 항구는 잘못 걸러질 수
 * 있고 ②반도/곶처럼 바다를 사이에 두고 육지가 가까운 지형에서는 내륙인데도 직선거리가
 * 짧게 나와 못 걸러질 수 있습니다. 그래서 자동으로 지우지 않고, 기본은 "미리보기(dry-run)"
 * 로 무엇이 지워질지 목록만 보여주고, --apply를 붙였을 때만 실제로 파일을 덮어씁니다.
 * (원본은 자동으로 .backup.geojson으로 백업됩니다)
 *
 * 사용법:
 *   node data/scripts/filter_boat_spots.js                 # 미리보기만 (파일 변경 없음)
 *   node data/scripts/filter_boat_spots.js --apply          # 실제로 걸러내고 저장
 *   node data/scripts/filter_boat_spots.js --apply --threshold=8   # 기준 거리(km)를 직접 지정 (기본 5km)
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..');
const BOAT_PATH = path.join(DATA_DIR, 'boat_spots.geojson');
const BACKUP_PATH = path.join(DATA_DIR, 'boat_spots.backup.geojson');
const REPORT_PATH = path.join(DATA_DIR, 'boat_spots.filter_report.txt');
const TIDE_STATIONS_PATH = path.join(DATA_DIR, 'tide_stations.json');
const SPOTS_PATH = fs.existsSync(path.join(DATA_DIR, 'spots.geojson'))
  ? path.join(DATA_DIR, 'spots.geojson')
  : path.join(DATA_DIR, 'spots.sample.geojson');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const thresholdArg = args.find((a) => a.startsWith('--threshold='));
const THRESHOLD_KM = thresholdArg ? parseFloat(thresholdArg.split('=')[1]) : 5;

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function main() {
  if (!fs.existsSync(BOAT_PATH)) {
    console.error(`✗ ${BOAT_PATH} 가 없습니다. 먼저 "npm run geocode:boats"를 실행해서 배낚시 데이터를 만들어주세요.`);
    process.exit(1);
  }

  const boatGeojson = JSON.parse(fs.readFileSync(BOAT_PATH, 'utf8'));
  const tideStations = JSON.parse(fs.readFileSync(TIDE_STATIONS_PATH, 'utf8'));
  const spotsGeojson = JSON.parse(fs.readFileSync(SPOTS_PATH, 'utf8'));

  // 해안 기준점 = 조위관측소 55곳 + 기존 바다(sea) 낚시포인트들.
  // 단, 이름에 "실내"가 들어간 곳(예: 대전실내바다낚시터, 수원 드림바다 실내 낚시터)은 실제로는
  // 내륙 도시에 있는 실내 인공 바닷물 낚시터라서 해안 기준점으로 쓰면 오히려 내륙을 "해안 근처"로
  // 잘못 판정하게 만듭니다 (실측: 대전/수원 등 내륙 도시에 다수 존재). 그래서 제외합니다.
  const isIndoorPond = (name) => /실내/.test(name || '');
  const seaSpots = spotsGeojson.features.filter(
    (f) => f.properties?.category !== 'boat' && f.properties?.waterType === 'sea' && !isIndoorPond(f.properties?.name)
  );
  const coastalPoints = [
    ...tideStations.map((s) => ({ lat: s.lat, lon: s.lon, label: `조위관측소 ${s.name}` })),
    ...seaSpots.map((f) => ({ lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], label: f.properties?.name || '바다 낚시포인트' })),
  ];
  console.log(`➜ 해안 기준점 ${coastalPoints.length}곳 (조위관측소 ${tideStations.length} + 바다 낚시포인트 ${coastalPoints.length - tideStations.length})`);
  console.log(`➜ 배낚시 지점 ${boatGeojson.features.length}곳을 검사합니다 (기준 거리: ${THRESHOLD_KM}km)`);

  const kept = [];
  const removed = [];

  for (const f of boatGeojson.features) {
    const [lon, lat] = f.geometry.coordinates;
    let bestDist = Infinity;
    let bestLabel = null;
    for (const c of coastalPoints) {
      const d = haversineKm(lat, lon, c.lat, c.lon);
      if (d < bestDist) {
        bestDist = d;
        bestLabel = c.label;
      }
    }
    const distRounded = Math.round(bestDist * 10) / 10;
    if (bestDist <= THRESHOLD_KM) {
      kept.push(f);
    } else {
      removed.push({ feature: f, distKm: distRounded, nearest: bestLabel });
    }
  }

  removed.sort((a, b) => b.distKm - a.distKm);

  console.log(`\n✅ 유지: ${kept.length}곳 (해안 기준점에서 ${THRESHOLD_KM}km 이내)`);
  console.log(`🗑 제외 대상: ${removed.length}곳 (${THRESHOLD_KM}km 초과, 내륙으로 의심)`);
  if (removed.length) {
    console.log('\n제외 대상 목록 (거리가 먼 순):');
    for (const r of removed.slice(0, 50)) {
      console.log(`  - ${r.feature.properties.name}  (약 ${r.distKm}km, 가장 가까운 기준점: ${r.nearest})`);
    }
    if (removed.length > 50) console.log(`  ... 외 ${removed.length - 50}곳 (전체 목록은 ${path.basename(REPORT_PATH)} 참고)`);
  }

  const reportLines = [
    `배낚시 데이터 내륙 필터링 리포트 (${new Date().toISOString()})`,
    `기준 거리: ${THRESHOLD_KM}km, 원본: ${boatGeojson.features.length}곳, 유지: ${kept.length}곳, 제외: ${removed.length}곳`,
    '',
    '=== 제외된 지점 (거리가 먼 순) ===',
    ...removed.map((r) => `${r.feature.properties.name}\t약 ${r.distKm}km\t가장 가까운 기준점: ${r.nearest}\t지오코딩 방식: ${r.feature.properties.geocodeVia || '-'}\t검색어: ${r.feature.properties.geocodeQuery || '-'}`),
  ];
  fs.writeFileSync(REPORT_PATH, reportLines.join('\n'), 'utf8');
  console.log(`\n📄 전체 리포트 저장: ${REPORT_PATH}`);

  if (!APPLY) {
    console.log('\n(미리보기 모드입니다. 실제로 파일을 걸러내려면 --apply를 붙여서 다시 실행하세요.)');
    console.log('  예: node data/scripts/filter_boat_spots.js --apply');
    return;
  }

  fs.copyFileSync(BOAT_PATH, BACKUP_PATH);
  console.log(`\n↩ 원본 백업: ${BACKUP_PATH} (되돌리고 싶으면 이 파일을 boat_spots.geojson으로 복사하세요)`);

  const outGeojson = {
    ...boatGeojson,
    metadata: {
      ...(boatGeojson.metadata || {}),
      inlandFilter: {
        thresholdKm: THRESHOLD_KM,
        removedCount: removed.length,
        filteredAt: new Date().toISOString(),
      },
    },
    features: kept,
  };
  fs.writeFileSync(BOAT_PATH, JSON.stringify(outGeojson, null, 2), 'utf8');
  console.log(`✅ 적용 완료: ${BOAT_PATH} (${kept.length}곳으로 갱신, 서버 재시작하면 반영됩니다)`);
}

main();