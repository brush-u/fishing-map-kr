#!/usr/bin/env node
/**
 * 공공데이터포털의 공식 CSV를 data/spots.geojson 으로 변환합니다.
 *
 * 사용법:
 *   1) data.go.kr 에서 아래 두 파일을 내려받아 data/raw/ 에 둡니다.
 *      - 전국낚시터정보표준데이터.csv   (https://www.data.go.kr/data/15021144/standard.do)
 *      - 갯바위낚시포인트.csv           (https://www.data.go.kr/data/15148580/fileData.do)
 *   2) node data/scripts/import_standard_csv.js
 *   3) data/spots.geojson 이 생성되면 서버가 샘플 데이터 대신 이 파일을 사용합니다.
 *
 * CSV의 정확한 컬럼명은 배포 시점에 따라 소폭 달라질 수 있습니다.
 * 아래 COLUMN_ALIASES 에 실제 다운로드한 파일의 헤더를 추가/수정해서 맞춰주세요.
 */
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const RAW_DIR = path.join(__dirname, '..', 'raw');
const OUT_PATH = path.join(__dirname, '..', 'spots.geojson');

const STANDARD_FILE = path.join(RAW_DIR, '전국낚시터정보표준데이터.csv');
const ROCKPOINT_FILE = path.join(RAW_DIR, '갯바위낚시포인트.csv');

// 표준데이터 컬럼 별칭 (실제 헤더와 다르면 여기에 추가하세요)
const COLUMN_ALIASES = {
  name: ['낚시터명', '낚시터 명칭', '시설명'],
  lat: ['위도', 'WGS84위도', '지리정보위도'],
  lon: ['경도', 'WGS84경도', '지리정보경도'],
  waterType: ['낚시터구분', '낚시터 유형', '낚시터유형'],
  address: ['소재지도로명주소', '소재지지번주소', '소재지주소'],
  species: ['주요어종'],
  region: ['소재지도로명주소', '소재지지번주소'],
};

function pick(row, keys) {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== '') return row[k];
  }
  return null;
}

function normalizeWaterType(raw) {
  if (!raw) return 'sea';
  const s = String(raw);
  if (/민물|담수|저수지|호수|강|계곡/.test(s)) return 'freshwater';
  return 'sea';
}

function dmsToDecimal(dms) {
  // "35-12-34" 또는 "351234" 같은 도분초 표기를 십진도로 변환
  if (dms === null || dms === undefined || dms === '') return null;
  const s = String(dms).trim();
  const parts = s.includes('-') ? s.split('-').map(Number) : null;
  if (parts && parts.length === 3) {
    const [d, m, sec] = parts;
    return d + m / 60 + sec / 3600;
  }
  const num = parseFloat(s);
  if (!Number.isNaN(num) && num > 1000) {
    // 351234.00 형태 (DDMMSS)
    const str = String(Math.floor(num)).padStart(6, '0');
    const d = parseInt(str.slice(0, -4), 10);
    const m = parseInt(str.slice(-4, -2), 10);
    const sec = parseInt(str.slice(-2), 10);
    return d + m / 60 + sec / 3600;
  }
  return Number.isNaN(num) ? null : num;
}

function loadCsv(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8').replace(/^﻿/, '');
  return parse(content, { columns: true, skip_empty_lines: true });
}

function buildFromStandard() {
  const rows = loadCsv(STANDARD_FILE);
  const features = [];
  for (const row of rows) {
    const lat = parseFloat(pick(row, COLUMN_ALIASES.lat));
    const lon = parseFloat(pick(row, COLUMN_ALIASES.lon));
    if (Number.isNaN(lat) || Number.isNaN(lon)) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: {
        name: pick(row, COLUMN_ALIASES.name) || '이름없음',
        waterType: normalizeWaterType(pick(row, COLUMN_ALIASES.waterType)),
        region: pick(row, COLUMN_ALIASES.region) || null,
        species: (pick(row, COLUMN_ALIASES.species) || '').split(/[,\/]/).map((s) => s.trim()).filter(Boolean),
        lifestyleFishing: null,
        source: '전국낚시터정보표준데이터',
      },
    });
  }
  return features;
}

function buildFromRockpoint() {
  const rows = loadCsv(ROCKPOINT_FILE);
  const features = [];
  for (const row of rows) {
    const lat = dmsToDecimal(row['갯바위낚시포인트도분초위도']);
    const lon = parseFloat(row['갯바위낚시포인트경도']);
    if (lat === null || Number.isNaN(lon)) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: {
        name: row['포인트명'] || row['포인트지역명'] || '갯바위 포인트',
        waterType: 'sea',
        region: row['행정구역명'] || null,
        species: (row['낚시방법대상내용'] || '').split(/[,\/]/).map((s) => s.trim()).filter(Boolean),
        depthRange: row['수심범위내용'] || null,
        tideNote: row['조수물때내용'] || null,
        lifestyleFishing: null,
        source: '갯바위낚시포인트',
      },
    });
  }
  return features;
}

function main() {
  const features = [...buildFromStandard(), ...buildFromRockpoint()];
  if (features.length === 0) {
    console.error(
      `변환할 데이터가 없습니다. ${RAW_DIR} 에 아래 파일을 먼저 내려받아 두세요:\n` +
        ` - ${path.basename(STANDARD_FILE)}\n - ${path.basename(ROCKPOINT_FILE)}`
    );
    process.exit(1);
  }
  const geojson = {
    type: 'FeatureCollection',
    metadata: { source: 'data.go.kr', importedAt: new Date().toISOString(), count: features.length },
    features,
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(geojson, null, 2));
  console.log(`${features.length}개 지점을 ${OUT_PATH} 에 저장했습니다.`);
}

main();
