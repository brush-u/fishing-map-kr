const map = L.map('map').setView([36.2, 127.8], 7); // 대한민국 전체가 보이는 초기 시야

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' +
    ' | 시도 경계: KOSTAT 2013 (via southkorea/southkorea-maps)',
}).addTo(map);

const KOREA_VIEW = { center: [36.2, 127.8], zoom: 7 };
const markerColor = { sea: '#1d6fb8', freshwater: '#2e8b4f' };

// 2013년 KOSTAT 정식명칭 -> 화면에 쓰는 짧은 이름
// (강원도/전라북도는 2023~2024년에 강원특별자치도/전북특별자치도로 명칭이 바뀌었지만,
//  원본 경계 데이터가 2013년 기준이라 표시용 짧은 이름은 그대로 둡니다)
const FULL_TO_SHORT = {
  서울특별시: '서울', 부산광역시: '부산', 대구광역시: '대구', 인천광역시: '인천',
  광주광역시: '광주', 대전광역시: '대전', 울산광역시: '울산', 세종특별자치시: '세종',
  경기도: '경기', 강원도: '강원', 충청북도: '충북', 충청남도: '충남',
  전라북도: '전북', 전라남도: '전남', 경상북도: '경북', 경상남도: '경남', 제주특별자치도: '제주',
};

let allFeatures = [];
let provinceFeatures = []; // 시/도 경계 폴리곤 원본 feature 목록
let provinceLayer = null; // L.geoJSON 레이어 (권역 뷰)
let currentView = { mode: 'region' }; // { mode: 'region' } | { mode: 'detail', name }

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
// 각 낚시포인트가 속한 시/도 판별 (실제 경계 폴리곤 기준, 레이캐스팅 point-in-polygon)
// 해안가 지점은 단순화된 경계선 밖으로 살짝 벗어날 수 있어, 포함 판정이 안 되면
// 가장 가까운 시/도의 바운딩박스 중심을 기준으로 보정합니다.
// (외부 지도/GIS 라이브러리 없이 직접 구현 — 의존성을 최소화하기 위함)
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
  if (!pointInRing(point, rings[0])) return false; // 외곽선 밖이면 제외
  for (let k = 1; k < rings.length; k++) {
    if (pointInRing(point, rings[k])) return false; // 구멍(hole) 안이면 제외
  }
  return true;
}

function pointInGeometry(point, geometry) {
  if (geometry.type === 'Polygon') return pointInPolygonCoords(point, geometry.coordinates);
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.some((poly) => pointInPolygonCoords(point, poly));
  return false;
}

function bboxCenterOf(geometry) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const visit = (ring) => ring.forEach(([x, y]) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  });
  const polys = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
  polys.forEach((poly) => poly.forEach(visit));
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

function assignProvinces(features, provinces) {
  const centers = provinces.map((pf) => ({ name: pf.properties.name, center: bboxCenterOf(pf.geometry) }));
  features.forEach((f) => {
    const point = f.geometry.coordinates;
    let matched = provinces.find((pf) => pointInGeometry(point, pf.geometry))?.properties.name || null;

    if (!matched) {
      let best = null;
      let bestDist = Infinity;
      centers.forEach((c) => {
        const d = haversineKm(point, c.center);
        if (d < bestDist) {
          bestDist = d;
          best = c.name;
        }
      });
      matched = best;
    }
    f._provinceName = matched;
  });
}

// ---------------------------------------------------------------------------
// 1) 권역(시/도 경계) 뷰
// ---------------------------------------------------------------------------
function countsByProvince() {
  const active = getActiveTypes();
  const counts = new Map();
  allFeatures.forEach((f) => {
    if (!active[waterTypeOf(f)]) return;
    counts.set(f._provinceName, (counts.get(f._provinceName) || 0) + 1);
  });
  return counts;
}

function provinceStyle(count) {
  const has = count > 0;
  return {
    color: '#1d6fb8',
    weight: 1.3,
    fillColor: '#1d6fb8',
    fillOpacity: has ? Math.min(0.12 + count * 0.035, 0.55) : 0.04,
    opacity: has ? 0.8 : 0.35,
  };
}

function rebuildProvinceLayer() {
  const counts = countsByProvince();

  if (provinceLayer) map.removeLayer(provinceLayer);

  provinceLayer = L.geoJSON(
    { type: 'FeatureCollection', features: provinceFeatures },
    {
      style: (feature) => provinceStyle(counts.get(feature.properties.name) || 0),
      onEachFeature: (feature, layer) => {
        const name = feature.properties.name;
        const short = FULL_TO_SHORT[name] || name;
        const count = counts.get(name) || 0;
        layer.bindTooltip(`${short} · ${count}곳`, { sticky: true });
        layer.on('click', () => enterProvince(name));
        layer.on('mouseover', () => layer.setStyle({ weight: 2.5, fillOpacity: Math.min((counts.get(name) || 0) * 0.035 + 0.25, 0.7) }));
        layer.on('mouseout', () => layer.setStyle(provinceStyle(count)));
      },
    }
  );

  if (currentView.mode === 'region') provinceLayer.addTo(map);
}

function showRegionView() {
  currentView = { mode: 'region' };
  map.removeLayer(detailMarkerLayer);
  detailMarkerLayer.clearLayers();
  rebuildProvinceLayer();
  map.setView(KOREA_VIEW.center, KOREA_VIEW.zoom);
  document.getElementById('region-nav').classList.add('hidden');
  document.getElementById('region-title').textContent = '';
}

// ---------------------------------------------------------------------------
// 2) 권역 상세(드릴다운) 뷰
// ---------------------------------------------------------------------------
function enterProvince(name) {
  const features = allFeatures.filter((f) => f._provinceName === name);
  const provinceFeature = provinceFeatures.find((pf) => pf.properties.name === name);
  if (!provinceFeature) return;

  currentView = { mode: 'detail', name };
  if (provinceLayer) map.removeLayer(provinceLayer);
  detailMarkerLayer.clearLayers();
  detailMarkersByType = { sea: [], freshwater: [] };

  const active = getActiveTypes();
  features.forEach((f) => {
    const marker = makeSpotMarker(f);
    detailMarkersByType[waterTypeOf(f)].push(marker);
    if (active[waterTypeOf(f)]) marker.addTo(detailMarkerLayer);
  });
  detailMarkerLayer.addTo(map);

  const bounds = L.geoJSON(provinceFeature).getBounds();
  map.fitBounds(bounds, { padding: [40, 40], maxZoom: 12 });

  const short = FULL_TO_SHORT[name] || name;
  document.getElementById('region-nav').classList.remove('hidden');
  document.getElementById('region-title').textContent = `${short} · 낚시포인트 ${features.length}곳`;
}

document.getElementById('btn-back').addEventListener('click', showRegionView);

// ---------------------------------------------------------------------------
// 필터(바다/민물) — 현재 뷰에 맞춰 적용
// ---------------------------------------------------------------------------
function applyFilters() {
  if (currentView.mode === 'region') {
    rebuildProvinceLayer();
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
// 데이터 로드 (낚시포인트 + 시/도 경계)
// ---------------------------------------------------------------------------
Promise.all([fetch('/api/spots').then((r) => r.json()), fetch('/api/boundaries/provinces').then((r) => r.json())])
  .then(([spotsGeojson, boundariesGeojson]) => {
    allFeatures = spotsGeojson.features;
    provinceFeatures = boundariesGeojson.features;
    assignProvinces(allFeatures, provinceFeatures);
    rebuildProvinceLayer();
  })
  .catch((err) => console.error('지도 데이터 로드 실패', err));

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
