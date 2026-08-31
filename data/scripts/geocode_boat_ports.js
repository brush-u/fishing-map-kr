#!/usr/bin/env node
/**
 * 해양수산부 "낚시어선업신고대장정보" CSV(등록된 낚시어선 70,000여 척의 출입항/영업장소 목록,
 * 좌표 없음)를 지도에 표시할 수 있는 GeoJSON(data/boat_spots.geojson)으로 변환합니다.
 *
 * 이 CSV에는 위경도 좌표가 전혀 없고, 대신 "출입항명"/"낚시어선영업장소명" 같은 텍스트 주소만
 * 있습니다. 같은 항구에서 여러 척이 등록되어 있는 경우가 많아(예: 오천항 1,170척), 배 한 척마다
 * 지도에 점을 찍는 대신 "같은 출입항/영업장소"를 하나로 묶어서 그 위치를 카카오 로컬 API로
 * 지오코딩(주소 -> 좌표 변환)한 뒤, "OO항 · 선상낚시 배 N척" 형태의 지점 하나로 표시합니다.
 *
 * 사용법 (컴퓨터에서, .env에 KAKAO_REST_API_KEY가 설정되어 있어야 함 — 지도 앱이 이미 쓰고 있는
 * 그 키를 그대로 재사용합니다. 새로 발급받을 필요 없음):
 *   npm install        (iconv-lite가 새로 추가되어 처음 한 번은 다시 설치해야 합니다)
 *   npm run geocode:boats
 *
 * 완료되면 data/boat_spots.geojson 파일이 생성/갱신됩니다. 이 파일이 있으면 서버가 자동으로
 * 기존 낚시포인트 데이터에 합쳐서 내려줍니다 (별도 설정 불필요).
 *
 * 소요 시간: 등록 위치가 약 5,000~6,000개라 보통 3~6분 정도 걸립니다. 실행 중 진행 상황이
 * 콘솔에 계속 출력됩니다.
 *
 * 주의: 이 데이터는 2021-12-30 기준으로, 그 사이 폐업/이전한 업체가 있을 수 있습니다. 최신
 * 데이터가 data.go.kr에 올라오면 이 CSV를 교체하고 다시 실행하면 됩니다.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');
const { parse } = require('csv-parse/sync');

const RAW_DIR = path.join(__dirname, '..', 'raw');
const OUT_PATH = path.join(__dirname, '..', 'boat_spots.geojson');
const FAIL_LOG_PATH = path.join(__dirname, '..', 'boat_spots.geocode_failures.txt');

const CSV_CANDIDATES = [
  '낚시어선업신고대장정보_20211230.csv',
  '해양수산부_공동활용체계_낚시어선업신고대장정보_20211230.csv',
];

const KAKAO_KEY = process.env.KAKAO_REST_API_KEY;
const BATCH_SIZE = 5; // 카카오 API 동시 요청 수 (무료 한도 안에서 안전하게)
const BATCH_DELAY_MS = 150;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findCsv() {
  for (const name of CSV_CANDIDATES) {
    const p = path.join(RAW_DIR, name);
    if (fs.existsSync(p)) return p;
  }
  // 후보 이름과 정확히 안 맞으면, raw 폴더에서 "낚시어선"이 들어간 첫 csv를 찾아봅니다.
  const found = fs.readdirSync(RAW_DIR).find((f) => f.includes('낚시어선') && f.endsWith('.csv'));
  return found ? path.join(RAW_DIR, found) : null;
}

function readCsvSmart(filePath) {
  const buf = fs.readFileSync(filePath);
  // data.go.kr CSV는 보통 CP949(EUC-KR 확장)로 내려받아지므로 그걸 우선 시도하고,
  // 혹시 UTF-8이면 그대로 씁니다.
  let text = iconv.decode(buf, 'cp949');
  if (text.includes('�')) {
    // 치환문자가 많이 섞이면 CP949가 아니었던 것 — UTF-8(BOM 포함)로 재시도
    text = buf.toString('utf8').replace(/^﻿/, '');
  }
  return parse(text, { columns: true, skip_empty_lines: true });
}

// 일부 행은 "낚시어선영업장소명"에 순수 숫자(행정구역코드로 보이는 값, 예: 46840370)만 들어있는
// 데이터 오류가 있어 지오코딩에 쓸 수 없습니다. 그런 값은 걸러냅니다.
function isUsableLocationText(s) {
  if (!s) return false;
  const t = s.trim();
  if (!t) return false;
  if (/^\d+$/.test(t)) return false; // 순수 숫자만 있으면 제외
  return true;
}

function bestQueryText(row) {
  const specific = row['영업장소특수주소']?.trim();
  const place = row['낚시어선영업장소명']?.trim();
  const port = row['출입항명']?.trim();
  const area = row['낚시어선영업구역명']?.trim();

  if (isUsableLocationText(place)) return place;
  if (isUsableLocationText(specific) && isUsableLocationText(area)) return `${area} ${specific}`;
  if (isUsableLocationText(port) && isUsableLocationText(area)) return `${area} ${port}`;
  if (isUsableLocationText(port)) return port;
  return null;
}

function displayName(row, key) {
  const port = row['출입항명']?.trim();
  if (isUsableLocationText(port)) return port;
  return key;
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { Authorization: `KakaoAK ${KAKAO_KEY}` } });
  if (!r.ok) throw new Error(`Kakao API HTTP ${r.status}`);
  return r.json();
}

// "해상일원", "관할수역", "연안일원" 계열은 실제 지번/도로명이 아니라 대략적인 관할 해역·행정
// 구역을 뜻하는 서류상 표현이라 그 자체로는 지오코딩이 안 됩니다. 실제 데이터에는
// "관할수역"/"해상일원"/"해역일원"/"연안일원"/"관내일원"/"연근해일원"/"해사일원"/"수역일원" 등
// 조합이 매우 다양하게 등장하고, "OO항일원"처럼 특정 지명 뒤에 "일원"만 붙는 경우도 있어
// 개별 조합을 일일이 나열하는 대신 "일원"/"수역"/"관할" 같은 핵심 낱말 자체를 지워서 남은
// 부분(있다면 구체적인 지명)만 남기는 방식으로 처리합니다.
const AREA_FILLER_TOKENS = ['일원', '수역', '관할', '해상', '해역', '연안', '해사'];

// 문자 사이에 공백이 섞여 들어와도("해역 일원") 잡아낼 수 있도록 각 글자 사이에 \s*를 허용하는
// 정규식을 만듭니다.
function flexibleRe(word, flags) {
  return new RegExp(word.split('').join('\\s*'), flags);
}

function stripAreaFillers(s) {
  let t = s;
  for (const w of AREA_FILLER_TOKENS) {
    t = t.replace(flexibleRe(w, 'g'), ' ');
  }
  return collapseSpaces(t);
}

// "(후면참조)", "(참고)" 처럼 실제 지명이 아니라 서류상 주석인 괄호 내용은 지오코딩에 방해만
// 되므로 통째로 제거합니다.
const JUNK_PAREN_WORDS = ['후면참조', '참조', '참고', '비고', '해당없음', '확인요망', '미상'];

function stripParenCount(s) {
  // 안전장치: 혹시 "(배 N척)" 같은 꼬리표가 섞여 들어오면 제거
  return s.replace(/\s*\(배\s*\d+\s*척\)\s*$/, '').trim();
}

function stripJunkParens(s) {
  return s.replace(/\(([^)]*)\)/g, (whole, inner) => (JUNK_PAREN_WORDS.includes(inner.trim()) ? ' ' : whole));
}

function collapseSpaces(s) {
  return s.replace(/\s+/g, ' ').trim();
}

// "가력항ㅇ" 처럼 끝에 완성되지 않은 낱자(자음/모음 하나)가 잘못 붙은 경우 제거
function stripStrayJamo(s) {
  return s.replace(/[ㄱ-ㅎㅏ-ㅣ]+$/, '').trim();
}

// 원본 텍스트 하나로 실패했을 때 순서대로 시도해볼 대체 검색어 목록을 만듭니다.
// 앞쪽일수록 더 정확하다고 보고 우선 시도합니다.
function queryVariants(rawKey) {
  const variants = [];
  const seen = new Set();
  const add = (v) => {
    const t = v && collapseSpaces(stripStrayJamo(v));
    if (t && !seen.has(t)) {
      seen.add(t);
      variants.push(t);
    }
  };

  const key = stripParenCount(rawKey);
  add(key);

  // 0) 의미 없는 참고용 괄호("(후면참조)" 등)를 먼저 제거해 뒤 단계가 방해받지 않게 함
  const noJunk = collapseSpaces(stripJunkParens(key));
  if (noJunk !== key) add(noJunk);

  // 1) "관할수역"/"해상일원"/"해사일원"/"OO항일원" 등 행정상 표현 제거
  //    (예: "경상남도 관할수역 산양읍 영운리" -> "경상남도 산양읍 영운리",
  //         "북항일원" -> "북항")
  const noArea = collapseSpaces(stripAreaFillers(noJunk));
  if (noArea && noArea !== noJunk) add(noArea);

  // 2) 남은 텍스트에 괄호가 있으면(예: "OO관할수역 사량면(대항할항)", "격포항(해창)",
  //    "충청남도해사일원(도비도항)") 괄호 안 내용과 앞/뒤 텍스트를 각각 후보로 시도.
  //    괄호 안이 진짜 지명인 경우도 있고, 괄호 밖(앞/뒤)이 진짜 지명인 경우도 있어 둘 다 시도.
  const parenBase = noArea || noJunk;
  const genericParenMatch = parenBase.match(/^(.*?)\(([^)]+)\)\s*(.*)$/);
  if (genericParenMatch) {
    const prefix = collapseSpaces(genericParenMatch[1]);
    const inner = genericParenMatch[2].trim();
    const suffix = collapseSpaces(genericParenMatch[3]);
    add(inner);
    if (prefix) add(`${prefix} ${inner}`);
    if (suffix) add(suffix);
    if (prefix && suffix) add(`${prefix} ${suffix}`);
  }

  // 3) 여러 항/포구 이름이 콤마 또는 공백으로 나열된 경우 ("위도항,격포항", "위도항 격포항")
  //    각각을 분리해서 시도. "XX항/포구/선착장/신고소"로 끝나는 조각이 2개 이상 있을 때만 분리
  //    (일반 지번주소를 잘못 쪼개지 않도록 하기 위한 안전장치).
  const forSplit = (noArea || noJunk).replace(/[()]/g, ' ');
  const facilityTokens = [...forSplit.matchAll(/[가-힣0-9]+(?:항|포구|선착장|신고소)/g)].map((m) => m[0]);
  const uniqueFacilities = [...new Set(facilityTokens)];
  if (uniqueFacilities.length >= 2) {
    uniqueFacilities.forEach((f) => add(f));
  }
  // 콤마로 구분된 경우는 안전하게 그대로 분리 시도
  if (/[,，·]/.test(forSplit)) {
    forSplit.split(/[,，·]/).map((s) => s.trim()).filter(Boolean).forEach((part) => add(part));
  }

  // 4) 마지막 수단: "OO선착장", "OO항" 앞의 리(里) 단위 주소만이라도 시도 (근사 위치)
  const base = noArea || noJunk;
  const lastTokenStripped = base.replace(/\s*\S*(선착장|포구|항)\s*$/, '').trim();
  if (lastTokenStripped && lastTokenStripped !== base && lastTokenStripped.length >= 4) {
    add(lastTokenStripped);
  }

  // 5) "OOO번지 N호" 형식은 카카오 주소 API가 쓰는 "OOO-N" 하이픈 표기로 바꿔서 한 번 더 시도
  //    (예: "축산리 12번지 4호" -> "축산리 12-4", "치도리 234번지" -> "치도리 234")
  const lotVariant = collapseSpaces(
    base
      .replace(/(\d+)\s*번지\s*(\d+)\s*호/g, '$1-$2')
      .replace(/번지/g, '')
      .replace(/(?<=\d)\s*호(?=\s|$)/g, '')
  );
  if (lotVariant && lotVariant !== base) add(lotVariant);

  return variants;
}

async function geocodeOne(query) {
  // 1순위: 주소 검색 (도로명/지번 주소에 가장 정확)
  try {
    const url = `https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(query)}`;
    const data = await fetchJson(url);
    if (data.documents && data.documents.length) {
      const d = data.documents[0];
      return { lat: parseFloat(d.y), lon: parseFloat(d.x), matchedVia: 'address', matchedQuery: query };
    }
  } catch (err) {
    console.warn(`  ⚠ 주소 검색 실패 (${query}): ${err.message}`);
  }
  // 2순위: 키워드 검색 (선착장/항 이름 등 정식 주소가 아닌 경우)
  try {
    const url = `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(query)}`;
    const data = await fetchJson(url);
    if (data.documents && data.documents.length) {
      const d = data.documents[0];
      return { lat: parseFloat(d.y), lon: parseFloat(d.x), matchedVia: 'keyword', matchedQuery: query };
    }
  } catch (err) {
    console.warn(`  ⚠ 키워드 검색 실패 (${query}): ${err.message}`);
  }
  return null;
}

// 원본 텍스트로 실패하면, 위에서 만든 변형들을 순서대로 시도합니다.
async function geocodeWithFallback(rawKey) {
  const variants = queryVariants(rawKey);
  for (const v of variants) {
    const result = await geocodeOne(v);
    if (result) return result;
  }
  return null;
}

async function main() {
  if (!KAKAO_KEY) {
    console.error('✗ .env에 KAKAO_REST_API_KEY가 없습니다. 지도 앱에서 쓰는 것과 같은 카카오 REST API 키를 .env에 넣어주세요.');
    process.exit(1);
  }

  const csvPath = findCsv();
  if (!csvPath) {
    console.error(`✗ data/raw/ 에서 낚시어선업 CSV 파일을 찾지 못했습니다. 아래 이름 중 하나로 저장해주세요:\n  ${CSV_CANDIDATES.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`➜ CSV 읽는 중: ${csvPath}`);
  const rows = readCsvSmart(csvPath);
  console.log(`➜ 전체 등록 낚시어선: ${rows.length}척`);

  // 같은 출입항/영업장소끼리 묶기
  const groups = new Map(); // key(지오코딩할 텍스트) -> { displayName, boatCount, totalCapacity, maxCapacity, sampleRow }
  let skipped = 0;
  for (const row of rows) {
    const key = bestQueryText(row);
    if (!key) {
      skipped++;
      continue;
    }
    const capacity = parseInt(row['최대승객수'], 10) || 0;
    if (!groups.has(key)) {
      groups.set(key, {
        displayName: displayName(row, key),
        boatCount: 0,
        totalCapacity: 0,
        maxCapacity: 0,
        sampleRow: row,
      });
    }
    const g = groups.get(key);
    g.boatCount += 1;
    g.totalCapacity += capacity;
    g.maxCapacity = Math.max(g.maxCapacity, capacity);
  }
  console.log(`➜ 위치 텍스트로 묶은 결과: ${groups.size}곳 (좌표를 만들 수 없는 ${skipped}건은 제외)`);

  const keys = Array.from(groups.keys());
  const features = [];
  const failures = [];
  let done = 0;

  for (let i = 0; i < keys.length; i += BATCH_SIZE) {
    const batch = keys.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map((k) => geocodeWithFallback(k)));
    batch.forEach((k, idx) => {
      const g = groups.get(k);
      const geo = results[idx];
      if (!geo) {
        failures.push(`${k} (배 ${g.boatCount}척)`);
        return;
      }
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [geo.lon, geo.lat] },
        properties: {
          name: `${g.displayName} (선상낚시)`,
          waterType: 'sea',
          category: 'boat',
          boatCount: g.boatCount,
          maxCapacity: g.maxCapacity,
          totalCapacity: g.totalCapacity,
          geocodeQuery: k,
          geocodeMatchedQuery: geo.matchedQuery,
          geocodeVia: geo.matchedVia,
          source: '해양수산부 낚시어선업신고대장정보 (2021-12-30 기준, data.go.kr)',
        },
      });
    });
    done += batch.length;
    if (done % 100 < BATCH_SIZE || done === keys.length) {
      console.log(`  진행: ${done}/${keys.length} (성공 ${features.length}, 실패 ${failures.length})`);
    }
    await sleep(BATCH_DELAY_MS);
  }

  const geojson = {
    type: 'FeatureCollection',
    metadata: {
      source: 'data.go.kr 해양수산부_공동활용체계_낚시어선업신고대장정보_20211230.csv (지오코딩: 카카오 로컬 API)',
      generatedAt: new Date().toISOString(),
      totalBoats: rows.length,
      locationCount: groups.size,
      geocodedCount: features.length,
      failedCount: failures.length,
      note: '2021-12-30 기준 등록 정보입니다. 같은 출입항/영업장소에 등록된 여러 척을 하나의 지점으로 묶었습니다.',
    },
    features,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(geojson, null, 2), 'utf8');
  console.log(`\n✅ 완료: ${OUT_PATH}`);
  console.log(`   지오코딩 성공: ${features.length}곳 / 실패: ${failures.length}곳`);

  if (failures.length) {
    fs.writeFileSync(FAIL_LOG_PATH, failures.join('\n'), 'utf8');
    console.log(`   실패 목록 저장: ${FAIL_LOG_PATH} (필요하면 나중에 수동으로 보완 가능)`);
  }
}

main().catch((err) => {
  console.error('✗ 실행 중 오류:', err);
  process.exit(1);
});