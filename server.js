// 대한민국 낚시지도 - 백엔드
// - 정적 프론트엔드 서빙 (Leaflet + OSM)
// - 공공데이터 프록시: 낚시포인트 / 날씨(기상청) / 편의점·상점(OSM Overpass) / 물때(KHOA, 연결 대기)
//
// 모든 외부 API 키는 .env 에서만 읽고, 클라이언트(브라우저)로 절대 내려주지 않습니다.

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// 1) 낚시포인트 데이터
// ---------------------------------------------------------------------------
// data/spots.geojson 이 있으면 그걸(= 공식 데이터로 가져온 전국 데이터) 우선 사용하고,
// 없으면 샘플 데이터(data/spots.sample.geojson)로 대체합니다.
// 공식 데이터 적용 방법: README.md 및 data/scripts/import_standard_csv.js 참고.
//
// data/boat_spots.geojson(`npm run geocode:boats`)과 data/japan_spots.geojson
// (`npm run fetch:japan`)은 둘 다 선택적으로 생성되는 파일이라, 있으면 병합하고 없으면
// 조용히 건너뜁니다.
function readGeojsonSafe(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error(`${filePath} 파싱 실패, 이 파일은 건너뜁니다:`, err);
    return null;
  }
}

app.get('/api/spots', (req, res) => {
  const officialPath = path.join(__dirname, 'data', 'spots.geojson');
  const samplePath = path.join(__dirname, 'data', 'spots.sample.geojson');
  const file = fs.existsSync(officialPath) ? officialPath : samplePath;

  res.setHeader('Content-Type', 'application/geo+json; charset=utf-8');

  const boats = readGeojsonSafe(path.join(__dirname, 'data', 'boat_spots.geojson'));
  const japan = readGeojsonSafe(path.join(__dirname, 'data', 'japan_spots.geojson'));

  if (!boats && !japan) {
    return fs.createReadStream(file).pipe(res);
  }

  try {
    const base = JSON.parse(fs.readFileSync(file, 'utf8'));
    base.features = [
      ...(base.features || []),
      ...(boats?.features || []),
      ...(japan?.features || []),
    ];
    res.json(base);
  } catch (err) {
    console.error('낚시포인트 데이터 병합 실패, 기본 데이터만 반환합니다:', err);
    fs.createReadStream(file).pipe(res);
  }
});

// ---------------------------------------------------------------------------
// 1-1) 시/도(또는 도도부현) 경계(폴리곤)
// - 한국: KOSTAT 2013 행정구역 경계. 출처: https://github.com/southkorea/southkorea-maps
//   (KOSTAT, "free to share or remix"). mapshaper로 3%까지 단순화(28MB -> ~470KB).
// - 일본: dataofjapan/land (https://github.com/dataofjapan/land)의 47개 도도부현 경계.
//   마찬가지로 mapshaper 3% 단순화(13MB -> ~130KB), 표시용 이름은 한글 표기로 붙였습니다
//   (data/boundaries/japan-prefectures.geo.json). 일본 파일이 없으면 한국 경계만 내려줍니다
//   (기존 동작과 100% 동일하게 유지).
// ---------------------------------------------------------------------------
app.get('/api/boundaries/provinces', (req, res) => {
  const koreaPath = path.join(__dirname, 'data', 'boundaries', 'skorea-provinces.geo.json');
  const japanPath = path.join(__dirname, 'data', 'boundaries', 'japan-prefectures.geo.json');
  res.setHeader('Content-Type', 'application/geo+json; charset=utf-8');

  const japan = readGeojsonSafe(japanPath);
  if (!japan) {
    return fs.createReadStream(koreaPath).pipe(res);
  }

  try {
    const korea = JSON.parse(fs.readFileSync(koreaPath, 'utf8'));
    res.json({
      type: 'FeatureCollection',
      features: [...(korea.features || []), ...(japan.features || [])],
    });
  } catch (err) {
    console.error('경계 데이터 병합 실패, 한국 경계만 반환합니다:', err);
    fs.createReadStream(koreaPath).pipe(res);
  }
});

// 기상청(날씨)·국립해양조사원(물때)·카카오 로컬(주변 편의점) API는 전부 대한민국 영토만
// 지원합니다. 일본 낚시포인트가 추가되면서 이 범위 밖 좌표로 이 API들을 호출하면 엉뚱한
// 격자/관측소 값이 나오거나 빈 결과가 나올 수 있어서, 대한민국 영역을 벗어나면 API를 호출하지
// 않고 "지원 범위 밖" 안내를 보여줍니다.
//
// ⚠️ 단순 위경도 사각 범위(bbox)로는 이걸 구분할 수 없습니다 — 대마도(일본 규슈 인근)와 부산이
// 위경도상 아주 가깝고, 규슈 지역 경도가 제주/경남 경도와 겹쳐서, 사각 범위로 하면 일본 규슈
// 지점이 "대한민국 범위 안"으로 잘못 판정됩니다. 그래서 실제 대한민국 시/도 폴리곤(이미
// /api/boundaries/provinces에 쓰는 그 파일) 안에 점이 실제로 들어있는지로 정확히 판정합니다.
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

const KOREA_PROVINCES = readGeojsonSafe(path.join(__dirname, 'data', 'boundaries', 'skorea-provinces.geo.json'));

// 참고: 경계 데이터가 3% 단순화돼 있어서, 해안선 바로 위 낚시포인트가 아주 드물게 폴리곤
// 바깥으로 살짝 벗어나 있을 수 있습니다. 하지만 여기서는 "혹시 모르니 가까운 쪽으로
// 넘겨준다" 같은 보정을 일부러 안 합니다 — 그렇게 하면 대마도처럼 실제로 가까운 일본 지점을
// 다시 대한민국으로 잘못 판정할 위험이 더 커지기 때문에, 폴리곤 안에 정확히 없으면 "지원
// 범위 밖"으로 처리하는 쪽이 더 안전한 실패 방식입니다.
function isInKorea(lat, lon) {
  if (!KOREA_PROVINCES) return true; // 경계 파일을 못 읽었으면(있을 수 없는 상황) 기존 동작 유지
  const point = [lon, lat];
  return KOREA_PROVINCES.features.some((f) => pointInGeometry(point, f.geometry));
}

// ---------------------------------------------------------------------------
// 2) 날씨: 기상청_단기예보 조회서비스 (data.go.kr)
// ---------------------------------------------------------------------------
// 위경도 -> 기상청 격자(nx, ny) 변환 (기상청 공개 알고리즘, Lambert Conformal Conic)
function latLonToGrid(lat, lon) {
  const RE = 6371.00877; // 지구 반경(km)
  const GRID = 5.0; // 격자 간격(km)
  const SLAT1 = 30.0 * (Math.PI / 180);
  const SLAT2 = 60.0 * (Math.PI / 180);
  const OLON = 126.0 * (Math.PI / 180);
  const OLAT = 38.0 * (Math.PI / 180);
  const XO = 43;
  const YO = 136;

  const re = RE / GRID;
  let sn = Math.tan(Math.PI * 0.25 + SLAT2 * 0.5) / Math.tan(Math.PI * 0.25 + SLAT1 * 0.5);
  sn = Math.log(Math.cos(SLAT1) / Math.cos(SLAT2)) / Math.log(sn);
  let sf = Math.tan(Math.PI * 0.25 + SLAT1 * 0.5);
  sf = (Math.pow(sf, sn) * Math.cos(SLAT1)) / sn;
  let ro = Math.tan(Math.PI * 0.25 + OLAT * 0.5);
  ro = (re * sf) / Math.pow(ro, sn);

  const DEGRAD = Math.PI / 180;
  const latRad = lat * DEGRAD;
  const lonRad = lon * DEGRAD;

  let ra = Math.tan(Math.PI * 0.25 + latRad * 0.5);
  ra = (re * sf) / Math.pow(ra, sn);
  let theta = lonRad - OLON;
  if (theta > Math.PI) theta -= 2.0 * Math.PI;
  if (theta < -Math.PI) theta += 2.0 * Math.PI;
  theta *= sn;

  const nx = Math.floor(ra * Math.sin(theta) + XO + 0.5);
  const ny = Math.floor(ro - ra * Math.cos(theta) + YO + 0.5);
  return { nx, ny };
}

// 단기예보는 하루 8회(0200,0500,0800,1100,1400,1700,2000,2300) 발표 + 약 10분 지연
function latestBaseDateTime(now = new Date()) {
  // 서버 타임존이 UTC라고 가정하고 KST(UTC+9)로 보정
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const hh = kst.getUTCHours();
  const mm = kst.getUTCMinutes();
  const slots = [2, 5, 8, 11, 14, 17, 20, 23];

  let chosen = null;
  for (const s of slots) {
    if (hh > s || (hh === s && mm >= 10)) chosen = s;
  }

  const dateStr = (y, m, day) => `${y}${String(m).padStart(2, '0')}${String(day).padStart(2, '0')}`;

  if (chosen === null) {
    // 오늘 02:10 이전 -> 전날 23시 발표 사용
    const prev = new Date(kst.getTime() - 24 * 60 * 60 * 1000);
    return {
      base_date: dateStr(prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate()),
      base_time: '2300',
    };
  }
  return {
    base_date: dateStr(kst.getUTCFullYear(), kst.getUTCMonth() + 1, kst.getUTCDate()),
    base_time: `${String(chosen).padStart(2, '0')}00`,
  };
}

const SKY_MAP = { 1: '맑음', 3: '구름많음', 4: '흐림' };
const PTY_MAP = { 0: '없음', 1: '비', 2: '비/눈', 3: '눈', 4: '소나기' };

// 같은 격자(nx,ny)는 낚시포인트 상세패널과 권역 날씨 배지에서 동시에 여러 번 조회될 수 있어
// (권역 안 여러 지점이 같은 5km 격자에 속하는 경우가 흔함) 캐싱해서 KMA 호출 횟수를 줄입니다.
const weatherCache = new Map(); // key: "nx,ny,base_date,base_time" -> { ts, data }
const WEATHER_CACHE_TTL_MS = 1000 * 60 * 10; // 10분

app.get('/api/weather', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lng ?? req.query.lon);
    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      return res.status(400).json({ error: 'lat, lng 쿼리 파라미터가 필요합니다.' });
    }

    if (!isInKorea(lat, lon)) {
      return res.json({
        unsupported: true,
        message: '기상청 단기예보는 대한민국 영토만 지원해서, 이 지점은 날씨 정보를 제공할 수 없습니다.',
      });
    }

    const key = process.env.KMA_FORECAST_KEY;
    if (!key) {
      return res.json({
        mocked: true,
        message: 'KMA_FORECAST_KEY가 설정되지 않아 예시 값을 반환합니다. .env에 키를 넣으면 실제 날씨가 표시됩니다.',
        sky: '맑음',
        precipitationType: '없음',
        temperature: null,
        windSpeed: null,
      });
    }

    const { nx, ny } = latLonToGrid(lat, lon);
    const { base_date, base_time } = latestBaseDateTime();

    const cacheKey = `${nx},${ny},${base_date},${base_time}`;
    const cached = weatherCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < WEATHER_CACHE_TTL_MS) {
      return res.json({ ...cached.data, cached: true });
    }

    const url = new URL('http://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst');
    url.searchParams.set('serviceKey', key);
    url.searchParams.set('numOfRows', '1000');
    url.searchParams.set('pageNo', '1');
    url.searchParams.set('dataType', 'JSON');
    url.searchParams.set('base_date', base_date);
    url.searchParams.set('base_time', base_time);
    url.searchParams.set('nx', String(nx));
    url.searchParams.set('ny', String(ny));

    const r = await fetch(url.toString());
    const data = await r.json();
    const items = data?.response?.body?.items?.item || [];

    // 가장 가까운 미래 시각의 항목들을 모아 요약
    const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const nowDate = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
    const nowHHMM = `${String(now.getUTCHours()).padStart(2, '0')}00`;

    const upcoming = items
      .filter((it) => it.fcstDate > nowDate || (it.fcstDate === nowDate && it.fcstTime >= nowHHMM))
      .sort((a, b) => (a.fcstDate + a.fcstTime).localeCompare(b.fcstDate + b.fcstTime));

    const firstSlot = upcoming.length ? upcoming[0].fcstDate + upcoming[0].fcstTime : null;
    const slotItems = upcoming.filter((it) => it.fcstDate + it.fcstTime === firstSlot);

    const get = (cat) => slotItems.find((i) => i.category === cat)?.fcstValue;

    const payload = {
      mocked: false,
      nx,
      ny,
      baseDate: base_date,
      baseTime: base_time,
      forecastAt: firstSlot,
      sky: SKY_MAP[get('SKY')] || get('SKY') || null,
      precipitationType: PTY_MAP[get('PTY')] ?? get('PTY') ?? null,
      temperature: get('TMP') ?? null,
      humidity: get('REH') ?? null,
      windSpeed: get('WSD') ?? null,
      waveHeight: get('WAV') ?? null,
    };
    weatherCache.set(cacheKey, { ts: Date.now(), data: payload });
    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: '기상청 API 호출에 실패했습니다.', detail: String(err) });
  }
});

// ---------------------------------------------------------------------------
// 3) 물때: 국립해양조사원(KHOA) 조석 API
// ---------------------------------------------------------------------------
// KHOA 오픈API는 공통적으로 아래 URL 패턴을 씁니다 (다른 KHOA API 실제 호출 예시로 확인됨):
//   http://www.khoa.go.kr/oceangrid/grid/api/<엔드포인트명>/search.do
//     ?ServiceKey=...&ObsCode=DT_0001&Date=20260830&ResultType=json
// ObsCode는 "DT_0001" 같은 문자열 코드입니다 (숫자 아님). 조위 "예보"용 엔드포인트명이
// tideObsPreTab인지는 확실하지 않으니, 키 발급 후 data.go.kr의 활용가이드 문서에서
// 정확한 엔드포인트명과 응답 필드명을 확인해 아래 TODO를 맞춰주세요.
//
// 관측소 코드(ObsCode)를 프런트엔드에서 직접 안 넣어도, 아래 TIDE_STATIONS 목록에서
// 낚시터 좌표와 가장 가까운 관측소를 자동으로 찾아서 씁니다. (사용자가 직접 입력창에
// 코드를 넣으면 그 값을 그대로 우선 사용합니다 — 자동으로 고른 관측소가 실제 조류/해협
// 특성상 안 맞을 때를 위한 수동 재정의 용도)
//
// 출처: data.go.kr "국립해양조사원_조위관측소 운영 현황_20250818" (사용자가 직접 내려받아
// 제공, 로그인 불필요 공개 파일데이터). 폐지되어 새 코드로 대체된 구(舊) 관측소
// (위도(구)/가덕도(구)/안흥(구)/포항(과거)/포항_구)는 목록에서 제외했습니다.
// 관측소 목록은 data/tide_stations.json에 분리해서, 배낚시 데이터의 "내륙 좌표 걸러내기"
// 스크립트(data/scripts/filter_boat_spots.js)에서도 같은 좌표 기준(실제 해안선 위 지점들)을
// 재사용할 수 있게 했습니다.
const TIDE_STATIONS = require('./data/tide_stations.json');

function findNearestTideStation(lat, lon) {
  const list = findNearestTideStations(lat, lon, 1);
  return list[0] || null;
}

// 가까운 순서대로 관측소 여러 곳을 반환합니다. 조석예보 API는 관측소에 따라 그날 예보 데이터가
// 아예 없는(=정상 응답인데 items가 빈 배열인) 경우가 있어서, 가장 가까운 관측소 하나만 보고
// 포기하지 않고 순서대로 몇 곳을 더 시도해보기 위해 씁니다.
function findNearestTideStations(lat, lon, n) {
  return TIDE_STATIONS.map((st) => ({ ...st, distanceKm: Math.round((haversineMeters(lat, lon, st.lat, st.lon) / 1000) * 10) / 10 }))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, n);
}

// data.go.kr 계열 공공API가 공통으로 쓰는 게이트웨이 레벨 에러 코드표 (서비스키/URL 문제일 때
// type=json을 요청해도 이 형식의 XML 에러가 내려오는 경우가 있어 별도로 처리합니다)
const OPENAPI_ERROR_HINTS = {
  '1': '애플리케이션 오류',
  '4': 'HTTP 오류',
  '10': '요청 파라미터가 올바르지 않습니다.',
  '11': '필수 요청 파라미터가 누락되었습니다.',
  '12': '해당 오픈API 서비스를 찾을 수 없습니다 (엔드포인트명이 틀렸을 수 있습니다).',
  '20': '서비스 접근이 거부되었습니다.',
  '21': '일시적으로 사용할 수 없는 서비스키입니다.',
  '22': '일일 요청 제한 횟수를 초과했습니다.',
  '30': '등록되지 않은 서비스키입니다 (활용신청 후 승인 대기 중일 수 있습니다).',
  '31': '기한이 만료된 서비스키입니다.',
  '32': '등록되지 않은 IP에서의 요청입니다 (IP 화이트리스트 등록이 필요할 수 있습니다).',
  '33': '서명되지 않은 요청입니다.',
};

function extractOpenApiError(text) {
  const msg = /<returnAuthMsg>([^<]*)<\/returnAuthMsg>/.exec(text)?.[1]
    || /<errMsg>([^<]*)<\/errMsg>/.exec(text)?.[1]
    || /<resultMsg>([^<]*)<\/resultMsg>/.exec(text)?.[1];
  const code = /<returnReasonCode>([^<]*)<\/returnReasonCode>/.exec(text)?.[1]
    || /<resultCode>([^<]*)<\/resultCode>/.exec(text)?.[1];
  if (!msg && !code) return null;
  const hint = code && OPENAPI_ERROR_HINTS[code];
  return { code: code || null, msg: msg || null, hint: hint || null };
}

// 공공데이터포털 "조석예보(고, 저조) 조회 서비스" (서비스ID SV-AP-04-006, 오퍼레이션
// getTideFcstHghLwApi) — data.go.kr에서 받은 공식 "오픈API 활용가이드" 문서로 확인된 실제 스펙입니다.
//   엔드포인트: https://apis.data.go.kr/1192136/tideFcstHghLw/GetTideFcstHghLwApiService
//   필수 파라미터: serviceKey, obsCode / 옵션: reqDate(YYYYMMDD), type(xml|json), numOfRows, pageNo
//   응답 items: obsvtrNm, lot(경도), lat(위도), predcDt("YYYY-MM-DD HH:MM"), predcTdlvVl(cm),
//     extrSe(1=오전고조, 2=오전저조, 3=오후고조, 4=오후저조)
//
// 관측소 하나에 대해 KHOA에 실제로 요청을 보내고 결과를 구조화해서 돌려줍니다. 반환값의 kind로
// 호출 쪽에서 무슨 일이 있었는지 구분합니다:
//   'data'    - 정상 응답이고 고조/저조 시각이 1개 이상 있음
//   'empty'   - 정상 응답(resultCode 00)인데 그 관측소/날짜엔 예보 항목이 0개 — 관측소마다 있을 수
//               있는 정상적인 경우라, 이 경우만 다른(다음으로 가까운) 관측소로 재시도해볼 가치가 있음
//   'error'   - KHOA가 명시적으로 에러를 반환(서비스키/파라미터 문제 등) — 다른 관측소로 바꿔도
//               똑같이 실패할 가능성이 높은 종류라 재시도하지 않고 바로 사용자에게 보여줌
// date를 안 주면(null/undefined) reqDate 파라미터 자체를 아예 안 보내서, KHOA가 문서에 적힌
// 기본값("현재일자")을 그대로 쓰게 합니다 — 우리가 계산한 날짜와 KHOA 서버가 판단하는 "오늘"이
// 어긋나서 빈 결과가 나올 가능성을 배제해보기 위한 용도입니다 (공식 요청 예제에도 reqDate가
// 아예 빠져 있습니다).
async function fetchKhoaTide(key, obsCode, date) {
  // data.go.kr 서비스키는 "인코딩된 키"(이미 %2F 등으로 퍼센트인코딩된 상태)로 발급되는 경우와
  // "디코딩된 키"(원문)로 발급되는 경우가 있어, 값에 %XX 패턴이 이미 있으면 인코딩된 키로 보고
  // 그대로 붙이고, 아니면 URLSearchParams가 정상적으로 인코딩하게 둡니다. (반대로 처리하면
  // 이중 인코딩되어 인증이 깨집니다)
  const looksPreEncoded = /%[0-9A-Fa-f]{2}/.test(key);
  const params = new URLSearchParams();
  params.set('obsCode', obsCode);
  if (date) params.set('reqDate', date);
  params.set('type', 'json');
  params.set('numOfRows', '50');
  params.set('pageNo', '1');
  const base = 'https://apis.data.go.kr/1192136/tideFcstHghLw/GetTideFcstHghLwApiService';
  const url = `${base}?${params.toString()}&serviceKey=${looksPreEncoded ? key : encodeURIComponent(key)}`;

  const r = await fetch(url);
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // 서비스키/파라미터가 잘못되면 type=json을 요청해도 XML 에러가 내려올 수 있습니다.
    return {
      kind: 'error',
      httpStatus: r.status,
      contentType: r.headers.get('content-type') || null,
      apiError: extractOpenApiError(text),
      error: 'KHOA 응답이 JSON이 아닙니다. ServiceKey를 다시 확인해주세요.',
      rawResponsePreview: text.slice(0, 1500),
    };
  }

  const header = data?.response?.header;
  // resultCode는 스펙상 "00"(2자리, 앞에 0 포함)이라 JSON에서도 항상 문자열로 내려오지만,
  // 혹시 모를 타입 차이에 안전하게 대응하기 위해 문자열로 변환해서 비교합니다.
  const resultCode = header?.resultCode != null ? String(header.resultCode).trim() : null;
  if (header && resultCode && resultCode !== '00') {
    const hint = OPENAPI_ERROR_HINTS[resultCode] || null;
    return {
      kind: 'error',
      error: header.resultMsg || 'KHOA 조석 API 오류',
      apiError: { code: resultCode, msg: header.resultMsg || null, hint },
    };
  }

  let items = data?.response?.body?.items?.item || [];
  if (!Array.isArray(items)) items = [items];

  const highTide = [];
  const lowTide = [];
  for (const it of items) {
    const timeStr = (it.predcDt || '').split(' ')[1] || '';
    if (!timeStr) continue;
    // ⚠️ data.go.kr의 JSON 응답은 숫자처럼 생긴 값("1","2"...)을 문자열이 아니라 실제 숫자로
    // 내려주는 경우가 흔합니다(예: extrSe: 2 대신 "2"). 엄격 비교(===)로 문자열만 비교하면
    // 이 경우 전부 걸러져서 물때 시각이 하나도 안 나오는 버그가 생기므로, 항상 문자열로
    // 변환해서 비교합니다.
    const extrSe = it.extrSe != null ? String(it.extrSe).trim() : '';
    if (extrSe === '1' || extrSe === '3') highTide.push(timeStr);
    else if (extrSe === '2' || extrSe === '4') lowTide.push(timeStr);
  }

  const totalCount = data?.response?.body?.totalCount;
  if (!highTide.length && !lowTide.length) {
    return { kind: 'empty', totalCount: totalCount != null ? Number(totalCount) : 0, raw: items };
  }
  return {
    kind: 'data',
    highTide,
    lowTide,
    totalCount: totalCount != null ? Number(totalCount) : undefined,
    raw: items,
  };
}

app.get('/api/tide', async (req, res) => {
  const key = process.env.KHOA_TIDE_KEY;
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lng ?? req.query.lon);
  const date = req.query.date || new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, '');

  // 사용자가 직접 관측소 코드를 넣었으면 그 관측소만 시도하고, 아니면 좌표 기준으로 가까운
  // 관측소 여러 곳(기본 4곳)을 후보로 둡니다 — 가장 가까운 관측소가 그날 예보 데이터가 없는
  // 경우(정상 응답인데 items가 빈 배열)가 있어서, 그럴 때 바로 포기하지 않고 다음으로 가까운
  // 관측소를 순서대로 시도해봅니다.
  // 국립해양조사원 관측소는 전부 대한민국 해역에 있어서, 대한민국 범위 밖 좌표(예: 일본
  // 낚시포인트)에서는 "가장 가까운 관측소"를 자동으로 골라도 사실 아주 멀리 떨어진 엉뚱한
  // 값이라 의미가 없습니다. obsCode를 직접 지정하지 않았다면 이 경우 바로 "지원 범위 밖"으로
  // 안내합니다.
  if (!req.query.obsCode && !Number.isNaN(lat) && !Number.isNaN(lon) && !isInKorea(lat, lon)) {
    return res.json({
      unsupported: true,
      message: '국립해양조사원 조석 예보는 대한민국 해역만 지원해서, 이 지점은 물때 정보를 제공할 수 없습니다.',
    });
  }

  let obsCode = req.query.obsCode;
  let stationCandidates = [];
  if (!obsCode && !Number.isNaN(lat) && !Number.isNaN(lon)) {
    stationCandidates = findNearestTideStations(lat, lon, 4);
  } else if (obsCode) {
    const found = TIDE_STATIONS.find((s) => s.code === obsCode) || null;
    stationCandidates = found ? [found] : [{ code: obsCode, name: null, distanceKm: null }];
  }
  const station = stationCandidates[0] || null;
  if (!obsCode) obsCode = station?.code;

  if (!key || !obsCode) {
    return res.json({
      mocked: true,
      message: !key
        ? 'KHOA_TIDE_KEY가 없어 예시 값을 반환합니다.'
        : '이 지점 근처의 관측소를 찾지 못해 예시 값을 반환합니다. 관측소 코드를 직접 입력해보세요.',
      obsCode: obsCode || null,
      station,
      date,
      highTide: ['04:12', '16:35'],
      lowTide: ['10:24', '22:50'],
    });
  }

  try {
    let lastEmpty = null;
    let triedStations = [];
    for (const candidate of req.query.obsCode ? [station] : stationCandidates) {
      const result = await fetchKhoaTide(key, candidate.code, date);
      triedStations.push(candidate.name || candidate.code);

      if (result.kind === 'error') {
        // 서비스키/파라미터 문제 등은 관측소를 바꿔도 똑같이 실패할 종류라 바로 응답합니다.
        return res.status(502).json({
          error: result.error,
          httpStatus: result.httpStatus,
          contentType: result.contentType,
          apiError: result.apiError,
          rawResponsePreview: result.rawResponsePreview,
          obsCode: candidate.code,
          station: candidate,
          date,
        });
      }

      if (result.kind === 'data') {
        return res.json({
          mocked: false,
          obsCode: candidate.code,
          station: candidate,
          date,
          highTide: result.highTide,
          lowTide: result.lowTide,
          totalCount: result.totalCount,
          raw: result.raw,
          fallbackFrom: triedStations.length > 1 ? triedStations.slice(0, -1) : undefined,
        });
      }

      // kind === 'empty': 이 관측소는 그날 예보 데이터가 없음 — 다음 후보로 넘어갑니다.
      lastEmpty = { obsCode: candidate.code, station: candidate, raw: result.raw };
    }

    // 가까운 관측소를 여러 곳 시도했는데도 전부 빈 응답이면, 우리가 계산한 날짜(reqDate)가
    // KHOA 쪽 "오늘" 판단과 어긋났을 가능성을 배제하기 위해, reqDate를 아예 안 보내고
    // (KHOA 기본값인 "현재일자" 사용) 가장 가까운 관측소로 한 번 더 시도해봅니다.
    const dateOmittedResult = await fetchKhoaTide(key, station.code, null);
    if (dateOmittedResult.kind === 'data') {
      return res.json({
        mocked: false,
        obsCode: station.code,
        station,
        date,
        dateOmitted: true,
        highTide: dateOmittedResult.highTide,
        lowTide: dateOmittedResult.lowTide,
        totalCount: dateOmittedResult.totalCount,
        raw: dateOmittedResult.raw,
      });
    }

    // 그래도 안 되면, 시도했던 관측소들과 원본 응답(raw)을 그대로 보여줘서 정말 데이터가 없는
    // 건지 다른 문제인지 판단할 수 있게 합니다.
    res.json({
      mocked: false,
      obsCode: lastEmpty.obsCode,
      station: lastEmpty.station,
      date,
      raw: lastEmpty.raw,
      triedStations,
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'KHOA 조석 API 호출에 실패했습니다.', detail: String(err) });
  }
});

// ---------------------------------------------------------------------------
// 4) 주변 편의점/상점
//    - 기본: OpenStreetMap Overpass API (무료, 키 불필요, 대신 농어촌/섬 지역은 등록이 부실할 수 있음)
//    - KAKAO_REST_API_KEY가 설정되어 있으면 카카오 로컬 API(카테고리 검색)를 대신 사용합니다.
//      국내 편의점/주유소 커버리지가 OSM보다 훨씬 좋고 응답도 빠릅니다. 카카오 계정만 있으면
//      무료로 REST API 키를 받을 수 있고(신용카드 불필요), 일 100,000건 무료 쿼터입니다.
//      발급: https://developers.kakao.com -> 내 애플리케이션 -> 앱 생성 -> "REST API 키" 복사
// ---------------------------------------------------------------------------
const nearbyCache = new Map(); // key: "provider,lat,lng,radius" -> { ts, data }
const CACHE_TTL_MS = 1000 * 60 * 30; // 30분 캐시

const DEFAULT_NEARBY_RADIUS = 3000; // 편의점/상점은 처음부터 넉넉한 반경으로 한 번에 조회 (왕복 여러 번 대신 1번)
const MAX_NEARBY_RADIUS = 5000;

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
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

// Overpass 공개 서버(overpass-api.de)가 최근 User-Agent가 없거나 너무 평범한(기본 fetch/curl)
// 요청, Accept-Encoding이 없는 요청 등을 "봇으로 추정"해서 406 Not Acceptable로 거부하는
// 사례가 늘었습니다 (AI 크롤러 과부하 때문에 차단 기준이 강화된 것으로 보임). 그래서 일반
// 브라우저/앱이 보낼 법한 헤더를 명시적으로 붙여서 보냅니다.
const OVERPASS_HEADERS = {
  'Content-Type': 'text/plain',
  'User-Agent': 'fishing-map-kr/1.0 (+https://github.com/; contact via GitHub issues)',
  Accept: '*/*',
  'Accept-Encoding': 'gzip, deflate, br',
  'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
};

function buildOverpassQuery(radius, lat, lon) {
  // node뿐 아니라 건물(way)/부지(relation)로 매핑된 상점도 잡기 위해 nwr + out center 사용
  return `
    [out:json][timeout:12];
    (
      nwr["shop"="convenience"](around:${radius},${lat},${lon});
      nwr["shop"="supermarket"](around:${radius},${lat},${lon});
      nwr["shop"="kiosk"](around:${radius},${lat},${lon});
      nwr["shop"="bait"](around:${radius},${lat},${lon});
      nwr["shop"="fishing"](around:${radius},${lat},${lon});
      nwr["amenity"="fuel"](around:${radius},${lat},${lon});
      nwr["amenity"="convenience_store"](around:${radius},${lat},${lon});
    );
    out center;
  `;
}

// Overpass 공개 서버(overpass-api.de)는 무료지만, 혼잡할 때 느려지거나 응답이 없을 때가 있고
// (특히 클라우드/데이터센터 IP에서 오는 요청은 더 자주 느리거나 막히는 경향이 있습니다 — Cloud Run도
// 여기 해당), 서버 하나만 쓰면 그 서버가 느릴 때 그대로 타임아웃이 나버립니다.
// OVERPASS_ENDPOINT를 직접 지정하지 않았다면, 여러 무료 미러 서버에 "동시에" 물어보고
// 가장 먼저 응답하는 서버 결과를 씁니다 (순서대로 하나씩 기다리는 것보다 훨씬 빠르고 안정적).
const OVERPASS_ENDPOINTS = process.env.OVERPASS_ENDPOINT
  ? [process.env.OVERPASS_ENDPOINT]
  : [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
      'https://overpass.osm.ch/api/interpreter',
      'https://z.overpass-api.de/api/interpreter',
      'https://lz4.overpass-api.de/api/interpreter',
    ];

function parseOverpassElements(data, lat, lon) {
  return (data.elements || [])
    .map((el) => {
      const point = el.type === 'node' ? { lat: el.lat, lon: el.lon } : el.center;
      if (!point) return null;
      return {
        name: el.tags?.name || '이름 없음',
        shop: el.tags?.shop || el.tags?.amenity || 'unknown',
        brand: el.tags?.brand || null,
        lat: point.lat,
        lon: point.lon,
        distanceM: Math.round(haversineMeters(lat, lon, point.lat, point.lon)),
      };
    })
    .filter(Boolean);
}

async function queryOverpassEndpoint(endpoint, query, lat, lon, timeoutMs) {
  try {
    const r = await fetchWithTimeout(
      endpoint,
      { method: 'POST', headers: OVERPASS_HEADERS, body: query },
      timeoutMs
    );
    if (!r.ok) throw new Error(`Overpass HTTP ${r.status} (${endpoint})`);
    const data = await r.json();
    return parseOverpassElements(data, lat, lon);
  } catch (err) {
    console.warn(`Overpass 서버 실패 (${endpoint}): ${err.message || err}`);
    throw err;
  }
}

async function queryOverpass(lat, lon, radius) {
  const query = buildOverpassQuery(radius, lat, lon);
  const attempts = OVERPASS_ENDPOINTS.map((endpoint) => queryOverpassEndpoint(endpoint, query, lat, lon, 9000));

  if (attempts.length === 1) return attempts[0];

  try {
    // 여러 미러 중 가장 먼저 성공하는 쪽을 그대로 씁니다.
    return await Promise.any(attempts);
  } catch (aggregateErr) {
    // AggregateError: 모든 미러가 실패한 경우. 원인 중 하나를 대표로 올려서
    // 아래 /api/nearby 핸들러가 타임아웃 여부 등을 판단할 수 있게 합니다.
    throw (aggregateErr.errors && aggregateErr.errors[0]) || aggregateErr;
  }
}

const KAKAO_CATEGORY_LABELS = { CS2: 'convenience', OL7: 'fuel' };

// 카카오 로컬의 category_group_code 목록에는 "낚시용품점" 카테고리가 따로 없어서,
// 편의점/주유소는 카테고리 검색으로, 낚시용품/미끼가게는 키워드 검색("낚시")으로 별도 조회합니다.
async function queryKakaoCategory(lat, lon, radius, apiKey, code) {
  const url = new URL('https://dapi.kakao.com/v2/local/search/category.json');
  url.searchParams.set('category_group_code', code);
  url.searchParams.set('x', String(lon));
  url.searchParams.set('y', String(lat));
  url.searchParams.set('radius', String(Math.min(radius, 20000)));
  url.searchParams.set('sort', 'distance');
  url.searchParams.set('size', '15');
  const r = await fetchWithTimeout(url.toString(), { headers: { Authorization: `KakaoAK ${apiKey}` } }, 8000);
  if (!r.ok) throw new Error(`Kakao Local API HTTP ${r.status}`);
  const data = await r.json();
  return (data.documents || []).map((d) => ({
    name: d.place_name,
    shop: KAKAO_CATEGORY_LABELS[code] || code,
    brand: null,
    lat: parseFloat(d.y),
    lon: parseFloat(d.x),
    distanceM: d.distance ? parseInt(d.distance, 10) : Math.round(haversineMeters(lat, lon, parseFloat(d.y), parseFloat(d.x))),
  }));
}

async function queryKakaoKeyword(lat, lon, radius, apiKey, keyword, shopType) {
  const url = new URL('https://dapi.kakao.com/v2/local/search/keyword.json');
  url.searchParams.set('query', keyword);
  url.searchParams.set('x', String(lon));
  url.searchParams.set('y', String(lat));
  url.searchParams.set('radius', String(Math.min(radius, 20000)));
  url.searchParams.set('sort', 'distance');
  url.searchParams.set('size', '15');
  const r = await fetchWithTimeout(url.toString(), { headers: { Authorization: `KakaoAK ${apiKey}` } }, 8000);
  if (!r.ok) throw new Error(`Kakao Local API HTTP ${r.status}`);
  const data = await r.json();
  return (data.documents || []).map((d) => ({
    name: d.place_name,
    shop: shopType,
    brand: null,
    lat: parseFloat(d.y),
    lon: parseFloat(d.x),
    distanceM: d.distance ? parseInt(d.distance, 10) : Math.round(haversineMeters(lat, lon, parseFloat(d.y), parseFloat(d.x))),
  }));
}

async function queryKakaoLocal(lat, lon, radius, apiKey) {
  const [cs2, ol7, bait] = await Promise.all([
    queryKakaoCategory(lat, lon, radius, apiKey, 'CS2'), // 편의점
    queryKakaoCategory(lat, lon, radius, apiKey, 'OL7'), // 주유소/충전소
    queryKakaoKeyword(lat, lon, radius, apiKey, '낚시', 'bait'), // 낚시용품/미끼가게
  ]);
  // 키워드 검색은 카테고리 검색보다 잡음(낚시가 들어간 음식점 등)이 섞일 수 있어서,
  // 장소명에 "낚시"가 들어간 결과만 남기고, 편의점/주유소 결과와 중복되는 항목은 제거합니다.
  const baitFiltered = bait.filter((d) => d.name.includes('낚시'));
  const seen = new Set([...cs2, ...ol7].map((d) => `${d.name}@${d.lat.toFixed(5)},${d.lon.toFixed(5)}`));
  const baitDeduped = baitFiltered.filter((d) => !seen.has(`${d.name}@${d.lat.toFixed(5)},${d.lon.toFixed(5)}`));
  return [...cs2, ...ol7, ...baitDeduped];
}

app.get('/api/nearby', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lng ?? req.query.lon);
  const radius = Math.min(parseInt(req.query.radius, 10) || DEFAULT_NEARBY_RADIUS, MAX_NEARBY_RADIUS);
  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    return res.status(400).json({ error: 'lat, lng 쿼리 파라미터가 필요합니다.' });
  }

  // 카카오 로컬 API는 대한민국 좌표만 결과가 나옵니다 — 일본 낚시포인트처럼 범위 밖 좌표에서
  // 카카오 키가 설정돼 있다고 그대로 쓰면 빈 결과만 나오니, 이 경우엔 전 세계 어디서나 되는
  // Overpass(OSM)를 대신 씁니다.
  const useKakao = !!process.env.KAKAO_REST_API_KEY && isInKorea(lat, lon);
  const kakaoKey = useKakao ? process.env.KAKAO_REST_API_KEY : null;
  const provider = kakaoKey ? 'kakao' : 'overpass';
  const cacheKey = `${provider},${lat.toFixed(4)},${lon.toFixed(4)},${radius}`;
  const cached = nearbyCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return res.json({ ...cached.data, cached: true });
  }

  try {
    const results = kakaoKey ? await queryKakaoLocal(lat, lon, radius, kakaoKey) : await queryOverpass(lat, lon, radius);
    results.sort((a, b) => a.distanceM - b.distanceM);

    const features = results.map((r) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
      properties: { name: r.name, shop: r.shop, brand: r.brand, distanceM: r.distanceM },
    }));

    const payload = { type: 'FeatureCollection', features, radiusUsed: radius, provider };
    nearbyCache.set(cacheKey, { ts: Date.now(), data: payload });
    res.json(payload);
  } catch (err) {
    console.error(err);
    const timedOut = err.name === 'AbortError';
    res.status(502).json({
      error: timedOut
        ? `${provider === 'kakao' ? '카카오 로컬' : 'Overpass'} API 응답이 너무 오래 걸려 중단했습니다. 잠시 후 다시 시도해주세요.`
        : `${provider === 'kakao' ? '카카오 로컬' : 'Overpass'} API 호출에 실패했습니다.`,
      detail: String(err),
    });
  }
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

// 지금 이 서버(배포본)에 어떤 API 키가 실제로 설정돼있는지 true/false로만 보여줍니다 (키 값 자체는
// 절대 내려주지 않음). Cloud Run 콘솔까지 안 들어가도, 배포 주소 뒤에 /api/status를 붙여서 열어보면
// "GitHub Secrets/​.env에 넣은 키가 이 배포에 실제로 반영됐는지"를 바로 확인할 수 있습니다.
app.get('/api/status', (req, res) => {
  res.json({
    kmaForecastKey: !!process.env.KMA_FORECAST_KEY,
    khoaTideKey: !!process.env.KHOA_TIDE_KEY,
    khoaFishingIndexKey: !!process.env.KHOA_FISHING_INDEX_KEY,
    kakaoRestApiKey: !!process.env.KAKAO_REST_API_KEY,
    note: '각 값이 false면, 그 키가 이 서버에는 아직 반영되지 않은 것입니다 (.env 또는 GitHub Secrets를 확인해주세요).',
  });
});

app.listen(PORT, () => {
  console.log(`fishing-map-kr listening on :${PORT}`);
});