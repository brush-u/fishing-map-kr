const map = L.map('map').setView([36.2, 127.8], 7); // 대한민국 전체가 보이는 초기 시야

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

const KOREA_VIEW = { center: [36.2, 127.8], zoom: 7 };
const markerColor = { sea: '#1d6fb8', freshwater: '#2e8b4f' };

// ---------------------------------------------------------------------------
// 지역(권역) 키 판별
// 상위 17개 시/도 기준으로 spot.properties.region 문자열의 첫 단어를 매칭합니다.
// 실제 행정구역 경계(폴리곤)가 아니라, 같은 권역 지점들을 묶어 중심점에 버블을 띄우는 방식입니다.
// ---------------------------------------------------------------------------
const METRO = ['서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종'];
const PROVINCE = ['경기', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주'];

function regionKeyOf(regionStr) {
  if (!regionStr) return '기타';
  const first = regionStr.trim().split(/\s+/)[0];
  if (METRO.includes(first) || PROVINCE.includes(first)) return first;
  const two = first.slice(0, 2);
  if (METRO.includes(two) || PROVINCE.includes(two)) return two;
  return first;
}

let allFeatures = [];
let regionGroupsCache = new Map(); // key -> { count, features, lat, lng }
let currentView = { mode: 'region' }; // { mode: 'region' } | { mode: 'detail', key }

const regionBubbleLayer = L.layerGroup();
const detailMarkerLayer = L.layerGroup();
const nearbyLayer = L.layerGroup().addTo(map);
let detailMarkersByType = { sea: [], freshwater: [] };

function getActiveTypes() {
  return {
    sea: document.getElementById('f-sea').checked,
    freshwater: document.getElementById('f-freshwater').checked,
  };
}

function waterTypeOf(feature) {
  return feature.properties.waterType === 'freshwater' ? 'freshwater' : 'sea';
}

function makeSpotMarker(feature) {
  const [lng, lat] = feature.geometry.coordinates;
  const p = feature.properties;
  const color = markerColor[waterTypeOf(feature)] || '#999';
  const marker = L.circleMarker([lat, lng], {
    radius: 7,
    color,
    weight: 2,
    fillColor: color,
    fillOpacity: 0.7,
  });
  marker.bindTooltip(p.name);
  marker.on('click', () => openPanel(p, lat, lng));
  return marker;
}

// ---------------------------------------------------------------------------
// 1) 권역(그룹) 뷰
// ---------------------------------------------------------------------------
function rebuildRegionBubbles() {
  regionBubbleLayer.clearLayers();
  const active = getActiveTypes();
  const groups = new Map();

  allFeatures.forEach((f) => {
    if (!active[waterTypeOf(f)]) return;
    const key = f._regionKey;
    if (!groups.has(key)) groups.set(key, { count: 0, latSum: 0, lngSum: 0, features: [] });
    const g = groups.get(key);
    g.count += 1;
    g.latSum += f.geometry.coordinates[1];
    g.lngSum += f.geometry.coordinates[0];
    g.features.push(f);
  });

  regionGroupsCache = groups;

  groups.forEach((g, key) => {
    const lat = g.latSum / g.count;
    const lng = g.lngSum / g.count;
    const size = Math.max(34, Math.min(64, 28 + g.count * 4));
    const icon = L.divIcon({
      className: 'region-bubble',
      html: `<div class="bubble" style="width:${size}px;height:${size}px;"><span>${key}</span><small>${g.count}곳</small></div>`,
      iconSize: [size, size],
    });
    const marker = L.marker([lat, lng], { icon });
    marker.on('click', () => enterRegion(key));
    marker.addTo(regionBubbleLayer);
  });
}

function showRegionView() {
  currentView = { mode: 'region' };
  map.removeLayer(detailMarkerLayer);
  detailMarkerLayer.clearLayers();
  rebuildRegionBubbles();
  if (!map.hasLayer(regionBubbleLayer)) regionBubbleLayer.addTo(map);
  map.setView(KOREA_VIEW.center, KOREA_VIEW.zoom);
  document.getElementById('region-nav').classList.add('hidden');
  document.getElementById('region-title').textContent = '';
}

// ---------------------------------------------------------------------------
// 2) 권역 상세(드릴다운) 뷰
// ---------------------------------------------------------------------------
function enterRegion(key) {
  const g = regionGroupsCache.get(key);
  if (!g) return;

  currentView = { mode: 'detail', key };
  map.removeLayer(regionBubbleLayer);
  detailMarkerLayer.clearLayers();
  detailMarkersByType = { sea: [], freshwater: [] };

  g.features.forEach((f) => {
    const marker = makeSpotMarker(f);
    detailMarkersByType[waterTypeOf(f)].push(marker);
    marker.addTo(detailMarkerLayer);
  });
  detailMarkerLayer.addTo(map);

  const bounds = L.latLngBounds(g.features.map((f) => [f.geometry.coordinates[1], f.geometry.coordinates[0]]));
  map.fitBounds(bounds, { padding: [60, 60], maxZoom: 13 });

  document.getElementById('region-nav').classList.remove('hidden');
  document.getElementById('region-title').textContent = `${key} · 낚시포인트 ${g.count}곳`;
}

document.getElementById('btn-back').addEventListener('click', showRegionView);

// ---------------------------------------------------------------------------
// 필터(바다/민물) — 현재 뷰에 맞춰 적용
// ---------------------------------------------------------------------------
function applyFilters() {
  if (currentView.mode === 'region') {
    rebuildRegionBubbles();
    return;
  }
  const active = getActiveTypes();
  ['sea', 'freshwater'].forEach((type) => {
    detailMarkersByType[type].forEach((m) => {
      if (active[type]) {
        if (!detailMarkerLayer.hasLayer(m)) m.addTo(detailMarkerLayer);
      } else if (detailMarkerLayer.hasLayer(m)) {
        detailMarkerLayer.removeLayer(m);
      }
    });
  });
}

document.getElementById('f-sea').addEventListener('change', applyFilters);
document.getElementById('f-freshwater').addEventListener('change', applyFilters);

// ---------------------------------------------------------------------------
// 데이터 로드
// ---------------------------------------------------------------------------
fetch('/api/spots')
  .then((r) => r.json())
  .then((geojson) => {
    allFeatures = geojson.features.map((f) => ({ ...f, _regionKey: regionKeyOf(f.properties.region) }));
    rebuildRegionBubbles();
    regionBubbleLayer.addTo(map);
  })
  .catch((err) => console.error('낚시포인트 로드 실패', err));

// ---------------------------------------------------------------------------
// 우측 정보 패널 (날씨 / 물때 / 주변 편의점)
// ---------------------------------------------------------------------------
const panel = document.getElementById('panel');
document.getElementById('panel-close').addEventListener('click', () => panel.classList.add('hidden'));

function openPanel(props, lat, lng) {
  panel.classList.remove('hidden');
  document.getElementById('panel-title').textContent = props.name;
  document.getElementById('panel-meta').textContent =
    `${props.region || ''} · ${props.waterType === 'freshwater' ? '민물' : '바다'}` +
    (props.species?.length ? ` · 주요어종: ${props.species.join(', ')}` : '');

  loadWeather(lat, lng);
  loadTide(lat, lng);
  loadNearby(lat, lng);
}

function loadWeather(lat, lng) {
  const el = document.getElementById('panel-weather');
  el.textContent = '불러오는 중...';
  fetch(`/api/weather?lat=${lat}&lng=${lng}`)
    .then((r) => r.json())
    .then((w) => {
      if (w.error) {
        el.textContent = '날씨 정보를 가져오지 못했습니다.';
        return;
      }
      const lines = [];
      if (w.mocked) lines.push('⚠️ 예시 데이터 (KMA_FORECAST_KEY 미설정)');
      lines.push(`하늘: ${w.sky ?? '-'} / 강수: ${w.precipitationType ?? '-'}`);
      lines.push(`기온: ${w.temperature ?? '-'}℃ / 풍속: ${w.windSpeed ?? '-'}m/s`);
      if (w.waveHeight) lines.push(`파고: ${w.waveHeight}m`);
      el.innerHTML = lines.map((l) => `<div>${l}</div>`).join('');
    })
    .catch(() => { el.textContent = '날씨 정보를 가져오지 못했습니다.'; });
}

function loadTide(lat, lng) {
  const el = document.getElementById('panel-tide');
  el.textContent = '불러오는 중...';
  fetch(`/api/tide?lat=${lat}&lng=${lng}`)
    .then((r) => r.json())
    .then((t) => {
      const lines = [];
      if (t.mocked) lines.push('⚠️ 예시 데이터 (KHOA 연동 전)');
      if (t.highTide) lines.push(`고조: ${t.highTide.join(', ')}`);
      if (t.lowTide) lines.push(`저조: ${t.lowTide.join(', ')}`);
      if (!t.highTide && !t.lowTide) lines.push('이 지점의 물때 정보는 아직 연결되지 않았습니다.');
      el.innerHTML = lines.map((l) => `<div>${l}</div>`).join('');
    })
    .catch(() => { el.textContent = '물때 정보를 가져오지 못했습니다.'; });
}

function loadNearby(lat, lng) {
  const el = document.getElementById('panel-nearby');
  el.textContent = '불러오는 중...';
  nearbyLayer.clearLayers();
  fetch(`/api/nearby?lat=${lat}&lng=${lng}&radius=1000`)
    .then((r) => r.json())
    .then((geojson) => {
      if (!geojson.features?.length) {
        el.textContent = '반경 1km 내 편의점/상점 정보가 없습니다.';
        return;
      }
      el.innerHTML = geojson.features
        .slice(0, 15)
        .map((f) => `<div class="shop-item">🏪 ${f.properties.name} (${f.properties.shop})</div>`)
        .join('');
      geojson.features.forEach((f) => {
        const [flng, flat] = f.geometry.coordinates;
        L.marker([flat, flng], {
          icon: L.divIcon({ className: 'shop-icon', html: '🏪', iconSize: [18, 18] }),
        })
          .bindTooltip(f.properties.name)
          .addTo(nearbyLayer);
      });
    })
    .catch(() => { el.textContent = '주변 상점 정보를 가져오지 못했습니다.'; });
}
