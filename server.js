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

    res.json({
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
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: '기상청 API 호출에 실패했습니다.', detail: String(err) });
  }
});

// ---------------------------------------------------------------------------
// 3) 물때: 국립해양조사원(KHOA) 조석 API — 연결 대기 (TODO)
// ---------------------------------------------------------------------------
// data.go.kr에서 활용신청 승인을 받으면 제공되는 "오픈API 활용가이드" 문서에
// 정확한 요청 파라미터/응답 필드명이 있습니다. 이 스캐폴드는 구조만 잡아두고,
// 실제 필드명은 승인 후 확인하여 아래 TODO 부분만 채우면 됩니다.
app.get('/api/tide', async (req, res) => {
  const key = process.env.KHOA_TIDE_KEY;
  const obsCode = req.query.obsCode; // 관측소 코드 (KHOA 관측소 목록에서 확인)
  const date = req.query.date; // YYYYMMDD

  if (!key || !obsCode) {
    return res.json({
      mocked: true,
      message:
        'KHOA_TIDE_KEY 또는 obsCode가 없어 예시 값을 반환합니다. 실제 연동은 README의 "물때 API 연결하기" 절 참고.',
      obsCode: obsCode || null,
      date: date || null,
      highTide: ['04:12', '16:35'],
      lowTide: ['10:24', '22:50'],
    });
  }

  // TODO: 실제 KHOA 조석예보 오픈API 엔드포인트/파라미터명으로 교체
  // 예시(확인 필요): https://www.khoa.go.kr/api/oceangrid/tideObsPreTab/search.do?ServiceKey=...&ObsCode=...&Date=...
  try {
    const url = new URL('https://www.khoa.go.kr/api/oceangrid/tideObsPreTab/search.do');
    url.searchParams.set('ServiceKey', key);
    url.searchParams.set('ObsCode', obsCode);
    url.searchParams.set('Date', date || '');
    url.searchParams.set('ResultType', 'json');

    const r = await fetch(url.toString());
    const data = await r.json();
    res.json({ mocked: false, raw: data });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'KHOA 조석 API 호출에 실패했습니다. 파라미터명을 가이드 문서로 확인해주세요.', detail: String(err) });
  }
});

// ---------------------------------------------------------------------------
// 4) 주변 편의점/상점: OpenStreetMap Overpass API (무료, 키 불필요)
// ---------------------------------------------------------------------------
const overpassCache = new Map(); // key: "lat,lng,radius" -> { ts, data }
const CACHE_TTL_MS = 1000 * 60 * 30; // 30분 캐시 (Overpass 공정 사용 정책 준수)

app.get('/api/nearby', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lng ?? req.query.lon);
    const radius = Math.min(parseInt(req.query.radius, 10) || 1000, 3000); // 최대 3km로 제한
    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      return res.status(400).json({ error: 'lat, lng 쿼리 파라미터가 필요합니다.' });
    }

    const cacheKey = `${lat.toFixed(4)},${lon.toFixed(4)},${radius}`;
    const cached = overpassCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      return res.json(cached.data);
    }

    const endpoint = process.env.OVERPASS_ENDPOINT || 'https://overpass-api.de/api/interpreter';
    const query = `
      [out:json][timeout:25];
      (
        node["shop"="convenience"](around:${radius},${lat},${lon});
        node["shop"="supermarket"](around:${radius},${lat},${lon});
        node["shop"="bait"](around:${radius},${lat},${lon});
        node["shop"="fishing"](around:${radius},${lat},${lon});
        node["amenity"="fuel"](around:${radius},${lat},${lon});
      );
      out body;
    `;

    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: query,
    });
    const data = await r.json();

    const features = (data.elements || []).map((el) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [el.lon, el.lat] },
      properties: {
        name: el.tags?.name || '이름 없음',
        shop: el.tags?.shop || el.tags?.amenity || 'unknown',
        brand: el.tags?.brand || null,
      },
    }));

    const geojson = { type: 'FeatureCollection', features };
    overpassCache.set(cacheKey, { ts: Date.now(), data: geojson });
    res.json(geojson);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Overpass API 호출에 실패했습니다.', detail: String(err) });
  }
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`fishing-map-kr listening on :${PORT}`);
});
