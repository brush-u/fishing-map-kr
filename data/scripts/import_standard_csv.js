#!/usr/bin/env node
/**
 * 공공데이터포털의 공식 CSV를 data/spots.geojson 으로 변환합니다.
 *
 * 사용법:
 *   1) data.go.kr 에서 아래 두 파일을 내려받아 data/raw/ 에 둡니다.
 *      - 낚시터정보.csv (전국낚시터정보표준데이터)  https://www.data.go.kr/data/15021144/standard.do
 *      - 갯바위낚시포인트.csv                        https://www.data.go.kr/data/15148580/fileData.do
 *      (두 파일 모두 다운로드 시 CP949/EUC-KR 인코딩으로 제공됩니다. 아래 스크립트가 직접 UTF-8로
 *       변환해 읽으므로 원본 그대로 두면 됩니다. 파일명이 다르면 RAW_FILES 목록에 추가하세요.)
 *   2) npm run import:spots   (= node data/scripts/import_standard_csv.js)
 *   3) data/spots.geojson 이 생성되면 서버가 샘플 데이터 대신 이 파일을 사용합니다.
 *
 * 실제 다운로드 데이터 기준(2026-08) 특이사항:
 *  - 낚시터정보.csv: WGS84위도/경도 컬럼에 좌표가 바로 들어있음. 42건 정도는 좌표가 비어있어 건너뜀.
 *    낚시터유형(바다/저수지/평지/계곡/기타) 중 "기타"는 바다・민물이 섞여있어(실내 바다낚시터 포함)
 *    이름/주요어종 키워드로 보정 분류함 — 완벽하지 않을 수 있음.
 *  - 갯바위낚시포인트.csv: "갯바위낚시포인트경도" 컬럼이 대부분(975/1076) 비어있어서 쓸 수 없음.
 *    대신 "공간정보" 컬럼의 POINT(x y)가 EPSG:5179(Korea 2000 / Unified CS) 평면좌표라서
 *    proj4로 WGS84 위经도로 변환함. (도분초위도 컬럼과 대조해 변환이 맞는지 확인됨)
 */
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const proj4 = require('proj4');

const RAW_DIR = path.join(__dirname, '..', 'raw');
const OUT_PATH = path.join(__dirname, '..', 'spots.geojson');

// 실제 내려받은 파일명과, 예전/다른 배포명을 함께 후보로 둡니다.
const STANDARD_FILE_CANDIDATES = ['낚시터정보.csv', '전국낚시터정보표준데이터.csv'];
const ROCKPOINT_FILE_CANDIDATES = ['갯바위낚시포인트.csv'];

// EPSG:5179 (Korea 2000 / Unified CS) — 공간정보 POINT(x y)가 이 좌표계로 제공됨
const EPSG5179 = '+proj=tmerc +lat_0=38 +lon_0=127.5 +k=0.9996 +x_0=1000000 +y_0=2000000 +ellps=GRS80 +units=m +no_defs';
const WGS84 = '+proj=longlat +datum=WGS84 +no_defs';

// 2013년 KOSTAT 정식명칭(및 실제 CSV에 쓰인 변형 표기) -> 화면용 짧은 이름
const SIDO_ALIASES = {
  서울특별시: '서울',
  부산광역시: '부산',
  대구광역시: '대구',
  인천광역시: '인천',
  광주광역시: '광주',
  대전광역시: '대전', 대전: '대전',
  울산광역시: '울산',
  세종특별자치시: '세종', 세종시: '세종',
  경기도: '경기',
  강원도: '강원', 강원특별자치도: '강원',
  충청북도: '충북',
  충청남도: '충남', 충남: '충남',
  전라북도: '전북', 전북특별자치도: '전북',
  전라남도: '전남',
  경상북도: '경북',
  경상남도: '경남', 경남: '경남',
  제주특별자치도: '제주',
};

const GWANGJU_DISTRICTS = ['동구', '서구', '남구', '북구', '광산구'];

function stripSuffix(name) {
  if (!name) return name;
  return name.replace(/(특별자치시|특별자치도|특별시|광역시)$/, '').replace(/(시|군|구)$/, (m, _p, offset, s) => (s.length > 1 ? '' : m));
}

/**
 * 주소 문자열(도로명/지번)에서 "짧은 시도명 [+ 시/군/구명]" 형태의 표시용 region을 뽑아냅니다.
 * 실제 CSV에는 "전남광주통합특별시" 같은 데이터 제공기관의 통합 행정코드 표기가 섞여있어
 * (좌표상 전라남도/광주광역시 지역), 뒤따르는 시/군/구 이름으로 광주인지 전남인지 다시 판별합니다.
 */
function parseRegionFromAddress(address) {
  if (!address) return null;
  const tokens = address.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const sido = tokens[0];
  const second = tokens[1] || '';

  if (sido === '전남광주통합특별시') {
    if (GWANGJU_DISTRICTS.includes(second)) return '광주';
    return second ? `전남 ${stripSuffix(second)}` : '전남';
  }

  const short = SIDO_ALIASES[sido];
  if (!short) return sido; // 매핑 실패 시 원문 그대로(누락 방지)

  const metros = ['서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종'];
  if (metros.includes(short)) return short; // 메트로는 구 단위까지는 표시하지 않음(기존 표기 스타일과 통일)
  return second ? `${short} ${stripSuffix(second)}` : short;
}

function parseRegionFromAdminName(adminName) {
  if (!adminName) return null;
  const tokens = adminName.trim().split(/\s+/).filter(Boolean);
  const sido = tokens[0];
  const second = tokens[1] || '';
  const short = SIDO_ALIASES[sido] || sido;
  const metros = ['서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종'];
  if (metros.includes(short)) return second ? `${short} ${stripSuffix(second)}` : short;
  return second ? `${short} ${stripSuffix(second)}` : short;
}

function splitSpecies(raw) {
  if (!raw) return [];
  return raw
    .split(/[,+\/·]/)
    .map((s) => s.trim().replace(/\s*등$/, ''))
    .filter((s) => s && s !== '-');
}

// 갯바위낚시포인트의 "낚시방법대상내용"은 "▶어종 - 낚시기법/낚시기법 ▶어종2 - 기법" 형식이라
// 일반 splitSpecies로는 기법까지 어종으로 쪼개져버립니다. "▶"로 구간을 나눈 뒤 " - " 앞부분(어종명)만 취합니다.
function parseRockpointSpecies(raw) {
  if (!raw) return [];
  return raw
    .split('▶')
    .map((seg) => seg.split(/\s*-\s*/)[0].trim())
    .filter(Boolean);
}

// "기타" 유형(낚시카페 등)은 바다/민물이 섞여있어 이름·어종 키워드로 보정 분류합니다.
const FRESH_KW = ['붕어', '잉어', '향어', '메기', '가물치', '배스', '블루길', '쏘가리', '빙어', '민물', '내수면', '비단잉어', '동자개', '끄리', '피라미', '양어'];
const SEA_KW = ['감성돔', '감섬돔', '강도다리', '광어', '넙치', '농어', '능성어', '다금바리', '도다리', '돌돔', '돗돔', '랍스터', '매가리', '민어', '바다', '바닷가재', '바리', '방어', '병어', '숭어', '점농어', '점성어', '줄돔', '참돔', '해면', '우럭', '노래미', '볼락', '전갱이', '고등어', '갑오징어', '오징어', '주꾸미', '낙지', '망둥어', '쏨뱅이', '열기', '돔'];

function classifyEtcWaterType(name, speciesRaw) {
  if (/바다|해양|해수/.test(name || '')) return 'sea';
  let seaScore = 0;
  let freshScore = 0;
  const s = speciesRaw || '';
  for (const kw of SEA_KW) if (s.includes(kw)) seaScore++;
  for (const kw of FRESH_KW) if (s.includes(kw)) freshScore++;
  return seaScore > freshScore ? 'sea' : 'freshwater';
}

function normalizeWaterType(rawType, name, speciesRaw) {
  const t = (rawType || '').trim();
  if (t === '바다') return 'sea';
  if (t === '저수지' || t === '평지' || t === '계곡') return 'freshwater';
  if (t === '기타') return classifyEtcWaterType(name, speciesRaw);
  return 'freshwater';
}

function findRawFile(candidates) {
  for (const name of candidates) {
    const p = path.join(RAW_DIR, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function loadCsv(filePath) {
  let content = fs.readFileSync(filePath).toString('utf8').replace(/^﻿/, '');
  // UTF-8로 읽었는데 한글이 깨져보이면(CP949 원본을 그대로 둔 경우) 재디코딩 시도
  if (/�/.test(content.slice(0, 200))) {
    content = fs.readFileSync(filePath).toString('latin1');
    content = Buffer.from(content, 'binary').toString('utf8');
  }
  return parse(content, { columns: true, skip_empty_lines: true });
}

// 대한민국 영토를 넉넉히 덮는 바운딩박스 (독도 포함). 이 밖의 좌표는 원본 데이터의 오타로 판단해 제외합니다.
const KR_BOUNDS = { minLat: 32.5, maxLat: 39.0, minLon: 124.0, maxLon: 131.95 };
function inKoreaBounds(lat, lon) {
  return lat >= KR_BOUNDS.minLat && lat <= KR_BOUNDS.maxLat && lon >= KR_BOUNDS.minLon && lon <= KR_BOUNDS.maxLon;
}

function parseTimestamp(row) {
  const s = row['최종수정시점'] || row['데이터갱신시점'] || row['데이터기준일자'] || '';
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
}

function buildFromStandard(filePath) {
  const rawRows = loadCsv(filePath);
  let skippedNoCoord = 0;
  let skippedOutOfBounds = 0;

  // 같은 낚시터가 해마다 다른 관리번호로 재등록되어 좌표가 완전히 동일한 채 중복 수록된 경우가 많습니다
  // (예: 충북 음성 일부 저수지가 12중복). 이름+좌표가 같으면 최신 수정시점 한 건만 남깁니다.
  const byKey = new Map();
  for (const row of rawRows) {
    const lat = parseFloat(row['WGS84위도']);
    const lon = parseFloat(row['WGS84경도']);
    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      skippedNoCoord++;
      continue;
    }
    if (!inKoreaBounds(lat, lon)) {
      skippedOutOfBounds++;
      continue;
    }
    const key = `${row['낚시터명']}|${lat.toFixed(5)}|${lon.toFixed(5)}`;
    const existing = byKey.get(key);
    if (!existing || parseTimestamp(row) >= parseTimestamp(existing)) {
      byKey.set(key, row);
    }
  }

  const features = [];
  for (const row of byKey.values()) {
    const lat = parseFloat(row['WGS84위도']);
    const lon = parseFloat(row['WGS84경도']);
    const address = row['소재지도로명주소'] || row['소재지지번주소'] || '';
    const speciesRaw = row['주요어종'] || '';
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: {
        name: row['낚시터명'] || '이름없음',
        waterType: normalizeWaterType(row['낚시터유형'], row['낚시터명'], speciesRaw),
        region: parseRegionFromAddress(address),
        species: splitSpecies(speciesRaw),
        lifestyleFishing: null,
        facilityType: row['낚시터유형'] || null,
        phone: row['낚시터전화번호'] || null,
        fee: row['이용요금'] || null,
        capacity: row['최대수용인원'] || null,
        address: address || null,
        safetyFacilities: row['안전시설현황'] || null,
        convenienceFacilities: row['편익시설현황'] || null,
        managingOrg: row['관리기관명'] || null,
        source: '전국낚시터정보표준데이터',
      },
    });
  }
  console.log(
    `  낚시터정보.csv: ${rawRows.length}건 중 ${features.length}건 변환` +
      ` (좌표없음 ${skippedNoCoord}건, 범위밖좌표 ${skippedOutOfBounds}건, 중복제거 ${rawRows.length - skippedNoCoord - skippedOutOfBounds - features.length}건 제외)`
  );
  return features;
}

function buildFromRockpoint(filePath) {
  const rows = loadCsv(filePath);
  const features = [];
  let skipped = 0;
  for (const row of rows) {
    const spatial = row['공간정보'] || '';
    const m = /POINT\s*\(\s*([0-9.+-]+)\s+([0-9.+-]+)\s*\)/i.exec(spatial);
    if (!m) {
      skipped++;
      continue;
    }
    const x = parseFloat(m[1]);
    const y = parseFloat(m[2]);
    let lon, lat;
    try {
      [lon, lat] = proj4(EPSG5179, WGS84, [x, y]);
    } catch {
      skipped++;
      continue;
    }
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !inKoreaBounds(lat, lon)) {
      skipped++;
      continue;
    }
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: {
        name: row['포인트명'] || row['포인트지역명'] || '갯바위 포인트',
        waterType: 'sea',
        region: parseRegionFromAdminName(row['행정구역명']),
        species: parseRockpointSpecies(row['낚시방법대상내용']),
        fishingMethodDetail: row['낚시방법대상내용'] || null,
        depthRange: row['수심범위내용'] || null,
        bottomType: row['주원료내용'] || null,
        tideNote: row['조수물때내용'] || null,
        areaName: row['포인트지역명'] || null,
        lifestyleFishing: null,
        source: '갯바위낚시포인트',
      },
    });
  }
  console.log(`  갯바위낚시포인트.csv: ${rows.length}건 중 ${features.length}건 변환 (좌표변환실패 ${skipped}건 제외)`);
  return features;
}

function main() {
  const standardPath = findRawFile(STANDARD_FILE_CANDIDATES);
  const rockpointPath = findRawFile(ROCKPOINT_FILE_CANDIDATES);

  if (!standardPath && !rockpointPath) {
    console.error(
      `변환할 데이터가 없습니다. ${RAW_DIR} 에 아래 파일을 먼저 내려받아 두세요:\n` +
        ` - ${STANDARD_FILE_CANDIDATES[0]}\n - ${ROCKPOINT_FILE_CANDIDATES[0]}`
    );
    process.exit(1);
  }

  console.log('원본 CSV 변환 중...');
  const features = [
    ...(standardPath ? buildFromStandard(standardPath) : []),
    ...(rockpointPath ? buildFromRockpoint(rockpointPath) : []),
  ];

  const seaCount = features.filter((f) => f.properties.waterType === 'sea').length;
  const freshCount = features.length - seaCount;

  const geojson = {
    type: 'FeatureCollection',
    metadata: {
      source: 'data.go.kr (전국낚시터정보표준데이터 + 갯바위낚시포인트)',
      importedAt: new Date().toISOString(),
      count: features.length,
      seaCount,
      freshwaterCount: freshCount,
    },
    features,
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(geojson, null, 2));
  console.log(`총 ${features.length}개 지점(바다 ${seaCount} / 민물 ${freshCount})을 ${OUT_PATH} 에 저장했습니다.`);
}

main();