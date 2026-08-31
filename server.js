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
app.get('/api/spots', (req, res) => {
  const officialPath = path.join(__dirname, 'data', 'spots.geojson');
  const samplePath = path.join(__dirname, 'data', 'spots.sample.geojson');
  const file = fs.existsSync(officialPath) ? officialPath : samplePath;
  res.setHeader('Content-Type', 'application/geo+json; charset=utf-8');
  fs.createReadStream(file).pipe(res);
});

// ---------------------------------------------------------------------------
// 1-1) 시/도 경계(폴리곤) — KOSTAT 2013 행정구역 경계
// 출처: https://github.com/southkorea/southkorea-maps (KOSTAT, "free to share or remix")
// mapshaper로 3%까지 단순화(28MB -> ~470KB)하여 웹에서 바로 쓸 수 있게 가공했습니다.
// ---------------------------------------------------------------------------
app.get('/api/boundaries/provinces', (req, res) => {
  const file = path.join(__dirname, 'data', 'boundaries', 'skorea-provinces.geo.json');
  res.setHeader('Content-Type', 'application/geo+json; charset=utf-8');
  fs.createReadStream(file).pipe(res);
});

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
const TIDE_STATIONS = [
  { code: 'IE_0060', name: '이어도', lat: 32.12277778, lon: 125.1822222 },
  { code: 'IE_0062', name: '옹진소청초', lat: 37.423056, lon: 124.738056 },
  { code: 'IE_0061', name: '신안가거초', lat: 33.941944, lon: 124.592778 },
  { code: 'DT_0002', name: '평택', lat: 36.966944, lon: 126.822778 },
  { code: 'DT_0003', name: '영광', lat: 35.426111, lon: 126.420556 },
  { code: 'DT_0004', name: '제주', lat: 33.5275, lon: 126.543056 },
  { code: 'DT_0005', name: '부산', lat: 35.096389, lon: 129.035278 },
  { code: 'DT_0006', name: '묵호', lat: 37.550278, lon: 129.116389 },
  { code: 'DT_0007', name: '목포', lat: 34.779722, lon: 126.375556 },
  { code: 'DT_0008', name: '안산', lat: 37.192222, lon: 126.647222 },
  { code: 'DT_0010', name: '서귀포', lat: 33.24, lon: 126.561667 },
  { code: 'DT_0011', name: '후포', lat: 36.6775, lon: 129.453056 },
  { code: 'DT_0012', name: '속초', lat: 38.207222, lon: 128.594167 },
  { code: 'DT_0013', name: '울릉도', lat: 37.491389, lon: 130.913611 },
  { code: 'DT_0016', name: '여수', lat: 34.747222, lon: 127.765556 },
  { code: 'DT_0017', name: '대산', lat: 37.0075, lon: 126.352778 },
  { code: 'DT_0018', name: '군산', lat: 35.975556, lon: 126.563056 },
  { code: 'DT_0021', name: '추자도', lat: 33.961944, lon: 126.300278 },
  { code: 'DT_0023', name: '모슬포', lat: 33.214444, lon: 126.251111 },
  { code: 'DT_0028', name: '진도', lat: 34.377778, lon: 126.308611 },
  { code: 'DT_0032', name: '강화대교', lat: 37.731944, lon: 126.522222 },
  { code: 'DT_0020', name: '울산', lat: 35.501944, lon: 129.387222 },
  { code: 'DT_0022', name: '성산포', lat: 33.474722, lon: 126.927778 },
  { code: 'DT_0024', name: '장항', lat: 36.006944, lon: 126.6875 },
  { code: 'DT_0026', name: '고흥발포', lat: 34.481111, lon: 127.342778 },
  { code: 'DT_0027', name: '완도', lat: 34.315556, lon: 126.759722 },
  { code: 'DT_0029', name: '거제도', lat: 34.801389, lon: 128.699167 },
  { code: 'DT_0031', name: '거문도', lat: 34.028333, lon: 127.308889 },
  { code: 'DT_0035', name: '흑산도', lat: 34.684167, lon: 125.435556 },
  { code: 'DT_0044', name: '영종대교', lat: 37.545556, lon: 126.584444 },
  { code: 'DT_0050', name: '태안', lat: 36.91305556, lon: 126.2388889 },
  { code: 'DT_0051', name: '서천마량', lat: 36.12888889, lon: 126.4952778 },
  { code: 'DT_0049', name: '광양', lat: 34.903672, lon: 127.754836 },
  { code: 'DT_0056', name: '부산항신항', lat: 35.0775, lon: 128.786944 },
  { code: 'DT_0057', name: '동해항', lat: 37.494722, lon: 129.143889 },
  { code: 'DT_0055', name: '순천만', lat: 34.88411111, lon: 127.5125556 },
  { code: 'DT_0058', name: '경인항', lat: 37.560833, lon: 126.601111 },
  { code: 'DT_0038', name: '굴업도', lat: 37.194444, lon: 125.995 },
  { code: 'DT_0025', name: '보령', lat: 36.406389, lon: 126.486111 },
  { code: 'DT_0001', name: '인천', lat: 37.451944, lon: 126.592222 },
  { code: 'DT_0052', name: '인천송도', lat: 37.33805556, lon: 126.5861111 },
  { code: 'DT_0014', name: '통영', lat: 34.827778, lon: 128.434722 },
  { code: 'DT_0037', name: '어청도', lat: 36.117222, lon: 125.984722 },
  { code: 'DT_0043', name: '영흥도', lat: 37.23861111, lon: 126.4286111 },
  { code: 'DT_0061', name: '삼천포', lat: 34.924167, lon: 128.069722 },
  { code: 'DT_0068', name: '위도', lat: 35.61808444, lon: 126.3018158 },
  { code: 'DT_0065', name: '덕적도', lat: 37.226333, lon: 126.156556 },
  { code: 'DT_0066', name: '향화도', lat: 35.167667, lon: 126.359556 },
  { code: 'DT_0067', name: '안흥', lat: 36.67463889, lon: 126.1295556 },
  { code: 'DT_0091', name: '포항', lat: 36.047128, lon: 129.383806 },
  { code: 'DT_0063', name: '가덕도', lat: 35.024178, lon: 128.810933 },
  { code: 'DT_0062', name: '마산', lat: 35.1975, lon: 128.576389 },
  { code: 'DT_0092', name: '여호항', lat: 34.661944, lon: 127.469167 },
  { code: 'DT_0094', name: '서거차도', lat: 34.25142222, lon: 125.91545 },
  { code: 'DT_0093', name: '소무의도', lat: 37.373069, lon: 126.440066 },
];

function findNearestTideStation(lat, lon) {
  let best = null;
  let bestDist = Infinity;
  for (const st of TIDE_STATIONS) {
    const d = haversineMeters(lat, lon, st.lat, st.lon);
    if (d < bestDist) {
      bestDist = d;
      best = st;
    }
  }
  return best ? { ...best, distanceKm: Math.round((bestDist / 1000) * 10) / 10 } : null;
}

app.get('/api/tide', async (req, res) => {
  const key = process.env.KHOA_TIDE_KEY;
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lng ?? req.query.lon);
  const date = req.query.date || new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, '');

  // 사용자가 직접 관측소 코드를 넣었으면 그걸 그대로 쓰고, 아니면 좌표 기준으로 가장 가까운
  // 관측소를 자동으로 골라줍니다.
  let obsCode = req.query.obsCode;
  let station = null;
  if (!obsCode && !Number.isNaN(lat) && !Number.isNaN(lon)) {
    station = findNearestTideStation(lat, lon);
    if (station) obsCode = station.code;
  } else if (obsCode) {
    station = TIDE_STATIONS.find((s) => s.code === obsCode) || null;
  }

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

  // data.go.kr 계열 공공API가 공통으로 쓰는 에러 코드표 (문서로 명시 확인은 못했지만
  // 대부분의 공공데이터포털 OpenAPI가 공유하는 표준 스펙이라 참고용으로 매핑해둡니다)
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

  // 엔드포인트명(tideObsPreTab)은 data.go.kr 활용가이드 상 명확히 재확인되지 않은 값이라,
  // 실패 시 원인을 바로 알 수 있도록 원본 응답 전체를 프런트로 내려줍니다.
  try {
    const url = new URL('http://www.khoa.go.kr/oceangrid/grid/api/tideObsPreTab/search.do');
    url.searchParams.set('ServiceKey', key);
    url.searchParams.set('ObsCode', obsCode);
    url.searchParams.set('Date', date);
    url.searchParams.set('ResultType', 'json');

    const r = await fetch(url.toString());
    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // 키/파라미터/엔드포인트명이 맞지 않으면 KHOA가 JSON이 아닌 에러 XML/HTML을 줄 수 있습니다.
      const apiError = extractOpenApiError(text);
      return res.status(502).json({
        error: 'KHOA 응답이 JSON이 아닙니다. ServiceKey/ObsCode/엔드포인트명을 다시 확인해주세요.',
        httpStatus: r.status,
        contentType: r.headers.get('content-type') || null,
        apiError,
        rawResponsePreview: text.slice(0, 1500),
      });
    }
    res.json({ mocked: false, obsCode, station, date, raw: data });
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
      { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: query },
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

  const kakaoKey = process.env.KAKAO_REST_API_KEY;
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
