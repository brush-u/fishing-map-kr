// 줌 컨트롤은 기본(top-left) 위치가 좌측 "권역 목록" 패널과 겹치므로 bottom-left로 옮깁니다.
const map = L.map('map', { zoomControl: false }).setView([36.2, 127.8], 7); // 대한민국 전체가 보이는 초기 시야
L.control.zoom({ position: 'bottomleft' }).addTo(map);

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

// 낚시포인트가 많이 몰려있는 지역은 마커를 하나하나 다 그리는 대신 뭉쳐서(클러스터) 숫자로
// 보여주고, 줌인하면 자동으로 풀립니다. 10개 이상 뭉쳐있으면 빨간색, 10개 미만이면 파란색.
const CLUSTER_COUNT_THRESHOLD = 10;
const detailMarkerLayer = L.markerClusterGroup({
  showCoverageOnHover: false,
  spiderfyOnMaxZoom: true,
  // 기본값(80px)보다 작게 잡아서 클러스터가 더 잘게 나뉘게 하고, 어느 정도 줌인하면(14 이상)
  // 아예 클러스터링을 끄고 낱개 마커를 바로 보여줘서 — 클릭을 여러 번 안 해도 개별 낚시포인트에
  // 빨리 도달하도록 합니다.
  maxClusterRadius: 50,
  disableClusteringAtZoom: 14,
  iconCreateFunction: (cluster) => {
    const count = cluster.getChildCount();
    const big = count >= CLUSTER_COUNT_THRESHOLD;
    return L.divIcon({
      html: `<div class="cluster-badge ${big ? 'cluster-big' : 'cluster-small'}">${count}</div>`,
      className: 'cluster-icon-wrap',
      iconSize: L.point(big ? 44 : 36, big ? 44 : 36),
    });
  },
});
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

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// 구글맵 스타일의 물방울(teardrop) 핀 아이콘을 SVG로 직접 그려서 divIcon으로 사용합니다.
// (이미지 파일 없이, 바다(파랑)/민물(초록) 색상만 바꿔서 재사용)
const pinIconCache = {};
function pinIcon(type) {
  if (pinIconCache[type]) return pinIconCache[type];
  const color = markerColor[type] || '#999';
  const emoji = type === 'freshwater' ? '🐟' : '🎣';
  const html = `
    <div class="pin-wrap">
      <svg width="28" height="40" viewBox="0 0 28 40" xmlns="http://www.w3.org/2000/svg">
        <path d="M14 0C6.3 0 0 6.3 0 14c0 10 14 26 14 26s14-16 14-26C28 6.3 21.7 0 14 0z"
              fill="${color}" stroke="#ffffff" stroke-width="1.5"/>
        <circle cx="14" cy="14" r="9" fill="rgba(255,255,255,0.92)"/>
      </svg>
      <span class="pin-emoji">${emoji}</span>
    </div>`;
  const icon = L.divIcon({
    className: 'spot-pin-icon',
    html,
    iconSize: [28, 40],
    iconAnchor: [14, 38],
    popupAnchor: [0, -34],
    tooltipAnchor: [0, -30],
  });
  pinIconCache[type] = icon;
  return icon;
}

// 마커에 마우스를 올리면 뜨는 "풍선말"에 이름뿐 아니라 권역/어종/수종 등 상세 정보를 보여줍니다.
// (클릭하면 열리는 우측 상세 패널과는 별개로, 지도를 훑어볼 때 바로 핵심 정보를 알 수 있게 함)
function tooltipHtml(p) {
  const type = waterTypeOf({ properties: p });
  const typeLabel = type === 'freshwater' ? '민물낚시' : '바다낚시';
  const speciesStr = Array.isArray(p.species) && p.species.length ? p.species.slice(0, 5).join(', ') : '';
  const lifestyleBadge = p.lifestyleFishing ? '<span class="tt-badge">생활낚시</span>' : '';
  return `
    <div class="spot-tooltip">
      <div class="tt-name">${escapeHtml(p.name)}${lifestyleBadge}</div>
      <div class="tt-meta">${typeLabel}${p.region ? ' · ' + escapeHtml(p.region) : ''}</div>
      ${speciesStr ? `<div class="tt-species">🐟 ${escapeHtml(speciesStr)}</div>` : ''}
    </div>`;
}

function makeSpotMarker(feature) {
  const [lng, lat] = feature.geometry.coordinates;
  const p = feature.properties;
  const type = waterTypeOf(feature);
  const marker = L.marker([lat, lng], { icon: pinIcon(type) });
  marker.bindTooltip(tooltipHtml(p), { direction: 'top', opacity: 0.97, className: 'spot-tooltip-wrapper' });
  marker.on('click', (e) => {
    // 마커 클릭이 지도 자체의 클릭으로도 전파되면, 아래 "지점 주변 보기" 지도 클릭 핸들러가
    // 같이 실행돼서 목록이 그 마커 위치 기준으로 다시 바뀌어버립니다 — 그걸 막습니다.
    L.DomEvent.stopPropagation(e);
    openPanel(p, lat, lng);
  });
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
    // 경계선은 데이터(건수)와 무관하게 항상 또렷한 색/두께로 고정해서, 인접한 권역끼리도
    // 선으로 확실히 구분되게 합니다. (채움 색/투명도만 건수에 따라 달라집니다)
    color: '#4b5a6b',
    weight: 1.4,
    opacity: 0.85,
    fillColor: '#1d6fb8',
    fillOpacity: has ? Math.min(0.12 + count * 0.035, 0.55) : 0.04,
  };
}

// 권역 상세(드릴다운) 뷰에서 쓰는 시/도 경계 스타일.
// - 지금 보고 있는 권역(isActive)은 완전히 투명하게 지워서 낚시포인트 마커를 가리지 않게 하고,
// - 나머지 권역은 아주 옅게만 표시해서, 클릭하면 바로 그 권역으로 넘어갈 수 있다는 걸 은은하게 알려줍니다.
function detailProvinceStyle(isActive) {
  return isActive
    ? { color: '#1d6fb8', weight: 0, fillColor: '#1d6fb8', fillOpacity: 0, opacity: 0 }
    : { color: '#8a94a3', weight: 1, fillColor: '#8a94a3', fillOpacity: 0.03, opacity: 0.3 };
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
        layer.on('click', (e) => {
          // 권역 폴리곤 클릭은 여기서 확정적으로 처리하므로, 지도 자체의 클릭으로 다시 전파되어
          // 아래 map.on('click', ...)이 같은 클릭에 대해 또 실행되는 걸 항상 막습니다.
          L.DomEvent.stopPropagation(e);
          if (currentView.mode === 'region') {
            // 전체 권역 화면에서의 클릭은 원래 동작 그대로: 그 권역 전체로 드릴다운.
            enterProvince(name);
          } else {
            // 이미 권역 상세/지점 보기 상태라면, 권역 전체로 점프하지 않고 클릭한 지점 주변만 보여줍니다.
            showNearbyPointView(e.latlng, POINT_VIEW_RADIUS_KM);
          }
        });
        layer.on('mouseover', () => {
          // 권역 상세/지점 보기 상태에서는 지금 보고 있는 권역(투명 처리된 폴리곤)은 굳이 강조하지 않고,
          // 다른 권역만 살짝 강조해서 "클릭하면 주변이 바뀐다"는 힌트를 줍니다.
          if (currentView.mode !== 'region') {
            const isActive = currentView.mode === 'detail' && name === currentView.name;
            if (!isActive) layer.setStyle({ weight: 2, fillOpacity: 0.16, opacity: 0.55 });
            return;
          }
          layer.setStyle({ weight: 2.5, fillOpacity: Math.min((counts.get(name) || 0) * 0.035 + 0.25, 0.7) });
        });
        layer.on('mouseout', () => {
          if (currentView.mode !== 'region') {
            const isActive = currentView.mode === 'detail' && name === currentView.name;
            layer.setStyle(detailProvinceStyle(isActive));
            return;
          }
          layer.setStyle(provinceStyle(count));
        });
      },
    }
  );

  if (currentView.mode === 'region') provinceLayer.addTo(map);
}

function showRegionView() {
  currentView = { mode: 'region' };
  map.removeLayer(detailMarkerLayer);
  detailMarkerLayer.clearLayers();
  nearbyLayer.clearLayers();
  rebuildProvinceLayer();
  map.setView(KOREA_VIEW.center, KOREA_VIEW.zoom);
  document.getElementById('region-nav').classList.add('hidden');
  document.getElementById('region-title').textContent = '';
  document.getElementById('region-weather').textContent = '';

  currentRegionFeatures = [];
  currentFeatureMarker = new Map();
  activeListItemEl = null;
  document.getElementById('spot-list').classList.add('hidden');
  panel.classList.add('hidden');
  document.getElementById('hint').classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// 2) 권역 상세(드릴다운) 뷰
// ---------------------------------------------------------------------------
let currentRegionFeatures = [];
let currentFeatureMarker = new Map(); // feature -> Leaflet marker (현재 드릴다운된 권역 한정)
let featureToLiEl = new Map(); // feature -> 좌측 목록의 <li> (현재 드릴다운된 권역 한정, 검색 결과 포커싱에 사용)
let activeListItemEl = null;

function enterProvince(name) {
  const features = allFeatures.filter((f) => f._provinceName === name);
  const provinceFeature = provinceFeatures.find((pf) => pf.properties.name === name);
  if (!provinceFeature) return;

  const short = FULL_TO_SHORT[name] || name;
  currentView = { mode: 'detail', name, label: short };
  currentRegionFeatures = features;
  currentFeatureMarker = new Map();

  // 권역 경계 레이어는 지도에서 완전히 없애지 않고 계속 띄워둡니다.
  // 대신 지금 보고 있는 권역은 투명하게, 나머지 권역은 옅게 스타일만 바꿔서
  // 상세(드릴다운) 화면에서도 다른 권역을 바로 클릭해서 이동할 수 있게 합니다.
  if (provinceLayer) {
    if (!map.hasLayer(provinceLayer)) provinceLayer.addTo(map);
    provinceLayer.eachLayer((layer) => {
      layer.setStyle(detailProvinceStyle(layer.feature.properties.name === name));
    });
    provinceLayer.bringToBack();
  }
  detailMarkerLayer.clearLayers();
  detailMarkersByType = { sea: [], freshwater: [] };
  nearbyLayer.clearLayers(); // 이전에 "지점 주변 보기"에서 표시했던 편의점 마커가 남아있지 않도록 정리

  const active = getActiveTypes();
  features.forEach((f) => {
    const marker = makeSpotMarker(f);
    currentFeatureMarker.set(f, marker);
    detailMarkersByType[waterTypeOf(f)].push(marker);
    if (active[waterTypeOf(f)]) marker.addTo(detailMarkerLayer);
  });
  detailMarkerLayer.addTo(map);

  const bounds = L.geoJSON(provinceFeature).getBounds();
  map.fitBounds(bounds, { padding: [40, 40], maxZoom: 12 });

  document.getElementById('region-nav').classList.remove('hidden');
  document.getElementById('region-title').textContent = `${short} · 낚시포인트 ${features.length}곳`;
  document.getElementById('hint').classList.add('hidden');

  resetSpotListSheetHeight();
  renderSpotList(short);
  const [wLng, wLat] = bboxCenterOf(provinceFeature.geometry);
  loadRegionWeather({ lat: wLat, lng: wLng });
}

// 지도를 클릭했을 때 "그 지점 주변"만 보여줄 기본 반경(km). 값만 바꾸면 전체 동작에 바로 적용됩니다.
const POINT_VIEW_RADIUS_KM = 15;

// 이미 권역 상세(또는 지점 보기) 상태에서 지도의 다른 곳(시/도 경계가 없는 바다 위 등 포함)을
// 클릭하면, 전체 권역으로 이동하는 대신 클릭한 지점을 중심으로 반경 내 낚시터만 다시 보여줍니다.
function showNearbyPointView(latlng, radiusKm) {
  const center = [latlng.lng, latlng.lat]; // haversineKm은 [lng, lat] 순서
  const features = allFeatures.filter((f) => haversineKm(center, f.geometry.coordinates) <= radiusKm);
  const label = `선택 지점 주변 (반경 ${radiusKm}km)`;

  currentView = { mode: 'point', lat: latlng.lat, lng: latlng.lng, radiusKm, label };
  currentRegionFeatures = features;
  currentFeatureMarker = new Map();

  // 특정 권역에 "들어가 있는" 상태가 아니므로, 모든 시/도 경계를 똑같이 옅은 스타일로 둡니다.
  if (provinceLayer) {
    if (!map.hasLayer(provinceLayer)) provinceLayer.addTo(map);
    provinceLayer.eachLayer((layer) => layer.setStyle(detailProvinceStyle(false)));
    provinceLayer.bringToBack();
  }
  detailMarkerLayer.clearLayers();
  detailMarkersByType = { sea: [], freshwater: [] };

  const active = getActiveTypes();
  features.forEach((f) => {
    const marker = makeSpotMarker(f);
    currentFeatureMarker.set(f, marker);
    detailMarkersByType[waterTypeOf(f)].push(marker);
    if (active[waterTypeOf(f)]) marker.addTo(detailMarkerLayer);
  });
  detailMarkerLayer.addTo(map);

  // 클릭한 지점이 중심에 오고, 반경 전체가 화면에 들어오도록 맞춥니다.
  // (L.circle을 지도에 추가하지 않고 getBounds()를 바로 쓰면 내부적으로 지도 투영 정보가
  // 없어서 에러가 나므로, 위도/경도 오프셋으로 간단히 사각 범위를 직접 계산합니다)
  const latDelta = radiusKm / 111; // 위도 1도 ≈ 111km
  const lngDelta = radiusKm / (111 * Math.cos((latlng.lat * Math.PI) / 180));
  const radiusBounds = L.latLngBounds(
    [latlng.lat - latDelta, latlng.lng - lngDelta],
    [latlng.lat + latDelta, latlng.lng + lngDelta]
  );
  map.fitBounds(radiusBounds, { padding: [40, 40], maxZoom: 13 });

  document.getElementById('region-nav').classList.remove('hidden');
  document.getElementById('region-title').textContent = `${label} · 낚시포인트 ${features.length}곳`;
  document.getElementById('hint').classList.add('hidden');

  resetSpotListSheetHeight();
  renderSpotList(label);
  loadRegionWeather({ lat: latlng.lat, lng: latlng.lng });
  // 클릭한 지점 주변의 편의점/상점도 같이 조회해서 지도에 표시합니다 (개별 낚시터를 클릭하지 않아도).
  renderNearbyShopMarkers(latlng.lat, latlng.lng);
}

// 지도를 클릭했을 때의 동작 — 이미 권역 상세/지점 보기 상태라면 "전체 권역으로 점프"하지 않고
// 클릭한 지점 주변만 다시 보여줍니다. (시/도 경계 폴리곤 위 클릭은 위 onEachFeature의 click에서
// 먼저 처리되고 stopPropagation되므로, 여기는 경계가 없는 바다 등 나머지 영역을 클릭했을 때만 실행됩니다)
map.on('click', (e) => {
  if (currentView.mode === 'region') return;
  showNearbyPointView(e.latlng, POINT_VIEW_RADIUS_KM);
});

// 기상청 단기예보는 5km 격자 단위(사실상 지역 단위) 정보라 낚시터 하나하나가 아니라
// "이 주변은 지금 대략 이런 날씨"로 봐도 무방합니다. 대표지점 기준으로 한 번만 조회해서
// 상단 타이틀 옆에 배지로 보여줍니다.
function loadRegionWeather(point) {
  const el = document.getElementById('region-weather');
  if (!point) {
    el.textContent = '';
    return;
  }
  const { lat, lng } = point;
  el.textContent = '· 날씨 불러오는 중...';
  fetch(`/api/weather?lat=${lat}&lng=${lng}`)
    .then((r) => r.json())
    .then((w) => {
      if (w.error) {
        el.textContent = '';
        return;
      }
      const parts = [];
      if (w.mocked) parts.push('⚠️ 예시데이터');
      parts.push(w.sky ?? '-');
      if (w.precipitationType && w.precipitationType !== '없음') parts.push(`강수:${w.precipitationType}`);
      if (w.temperature != null) parts.push(`${w.temperature}℃`);
      if (w.windSpeed != null) parts.push(`풍속${w.windSpeed}m/s`);
      if (w.waveHeight) parts.push(`파고${w.waveHeight}m`);
      el.textContent = `· ${parts.join(' · ')}`;
      el.title = '권역 대표지점 기준 날씨입니다. 기상청 격자(5km) 단위 예보라 실제 낚시포인트와 약간 다를 수 있어요.';
    })
    .catch(() => { el.textContent = ''; });
}

document.getElementById('btn-back').addEventListener('click', showRegionView);

// 지도를 줌아웃해서 권역 상세 뷰보다 더 넓은 범위가 보이면 자동으로 전체 권역 뷰로 돌아갑니다.
// (17개 시/도 전체를 기준으로 드릴다운 시 도달하는 최소 줌 레벨이 8이어서, 7 이하를 "축소됨"으로 판단)
const AUTO_COLLAPSE_ZOOM = KOREA_VIEW.zoom;
map.on('zoomend', () => {
  if (currentView.mode !== 'region' && map.getZoom() <= AUTO_COLLAPSE_ZOOM) {
    showRegionView();
  }
});

// ---------------------------------------------------------------------------
// 좌측 "권역 내 낚시터 목록" 패널
// ---------------------------------------------------------------------------
const WATER_GROUP_META = {
  sea: { label: '🎣 바다낚시' },
  freshwater: { label: '🐟 민물낚시' },
};

// 좌측 목록을 바다/민물 두 그룹으로 나눠 보여줍니다. 상단 체크박스(#f-sea/#f-freshwater)와
// 목록 헤더의 칩 버튼(.chip)이 같은 필터 상태를 공유하며 서로 동기화됩니다.
function renderSpotList(regionShortName) {
  const listEl = document.getElementById('spot-list');
  const titleEl = document.getElementById('spot-list-title');
  const bodyEl = document.getElementById('spot-list-body');
  const active = getActiveTypes();

  const visibleFeatures = currentRegionFeatures.filter((f) => active[waterTypeOf(f)]);

  titleEl.textContent = `${regionShortName} 낚시터 (${visibleFeatures.length}곳)`;
  bodyEl.innerHTML = '';
  featureToLiEl = new Map();

  if (visibleFeatures.length === 0) {
    const p = document.createElement('p');
    p.className = 'spot-list-empty';
    p.textContent = '표시할 낚시터가 없습니다. (필터를 확인해주세요)';
    bodyEl.appendChild(p);
    listEl.classList.remove('hidden');
    return;
  }

  const groups = { sea: [], freshwater: [] };
  visibleFeatures.forEach((f) => groups[waterTypeOf(f)].push(f));

  ['sea', 'freshwater'].forEach((type) => {
    const items = groups[type];
    if (items.length === 0) return;

    const section = document.createElement('div');
    section.className = 'spot-group';

    const h4 = document.createElement('h4');
    h4.className = 'spot-group-title';
    h4.textContent = `${WATER_GROUP_META[type].label} (${items.length})`;
    section.appendChild(h4);

    const ul = document.createElement('ul');
    ul.className = 'spot-group-items';
    items.forEach((f) => {
      const p = f.properties;
      const li = document.createElement('li');
      const dotColor = markerColor[waterTypeOf(f)];
      li.innerHTML =
        `<div class="spot-name"><span class="water-dot" style="background:${dotColor}"></span>${escapeHtml(p.name)}</div>` +
        `<div class="spot-meta">${escapeHtml(p.region || '')}${p.species?.length ? ' · ' + escapeHtml(p.species.slice(0, 3).join(', ')) : ''}</div>`;
      li.addEventListener('click', () => selectSpotFromList(f, li));
      ul.appendChild(li);
      featureToLiEl.set(f, li);
    });
    section.appendChild(ul);
    bodyEl.appendChild(section);
  });

  listEl.classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// 모바일 바텀시트: 목록 창 헤더를 손가락으로 위아래로 끌면 목록 안의 데이터 스크롤과는
// 별개로, 창 전체의 높이(=얼마나 펼쳐 보이는지)가 바뀝니다.
// - 헤더(제목/칩 버튼이 있는 줄) 영역에서만 드래그를 인식합니다 — 목록 본문(#spot-list-body)의
//   터치는 그대로 일반 스크롤로 남겨둡니다.
// - 충분히 움직이기 전까지는 그냥 "탭"으로 보고 아무것도 안 해서, 칩 버튼 클릭이 평소처럼 동작합니다.
// - 손을 떼면 접힘/기본/펼침 세 지점 중 가장 가까운 높이로 스냅됩니다.
// ---------------------------------------------------------------------------
const SHEET_BREAKPOINTS_VH = { collapsed: 11, default: 42, expanded: 82 };

function isMobileSheetLayout() {
  return window.matchMedia('(max-width: 680px)').matches;
}

function resetSpotListSheetHeight() {
  const listEl = document.getElementById('spot-list');
  if (listEl) listEl.style.maxHeight = '';
}

function setupSpotListSheetDrag() {
  const sheet = document.getElementById('spot-list');
  const handle = document.getElementById('spot-list-header');
  if (!sheet || !handle) return;

  const vh = (v) => window.innerHeight * (v / 100);
  const DRAG_THRESHOLD_PX = 8;

  let dragging = false;
  let movedEnough = false;
  let startY = 0;
  let startHeight = 0;
  let draggedHeight = 0; // 지금까지 끌어서 "의도한" 높이 — 목록이 비어있어 실제 렌더링 높이가
                         // max-height보다 작을 수 있으므로, 스냅 판정은 실제 렌더링 높이가 아니라
                         // 이 값(의도한 높이) 기준으로 합니다.

  function clampHeight(h) {
    return Math.max(vh(SHEET_BREAKPOINTS_VH.collapsed), Math.min(vh(SHEET_BREAKPOINTS_VH.expanded), h));
  }

  function onStart(clientY) {
    if (!isMobileSheetLayout()) return;
    dragging = true;
    movedEnough = false;
    startY = clientY;
    // 시작 높이는 "지금 펼쳐진 정도"를 기준으로 잡아야 하므로, 목록이 비어서 실제 렌더링 높이가
    // 작더라도 직전에 설정해둔 max-height(없으면 기본 42vh)를 기준으로 삼습니다.
    const inlineMax = parseFloat(sheet.style.maxHeight);
    startHeight = Number.isFinite(inlineMax) ? inlineMax : vh(SHEET_BREAKPOINTS_VH.default);
    draggedHeight = startHeight;
    sheet.style.transition = 'none';
  }

  function onMove(clientY, evt) {
    if (!dragging) return;
    const dy = startY - clientY; // 위로 끌면 +(커짐), 아래로 끌면 -(작아짐)
    if (!movedEnough && Math.abs(dy) > DRAG_THRESHOLD_PX) movedEnough = true;
    if (!movedEnough) return;
    if (evt && evt.cancelable) evt.preventDefault();
    draggedHeight = clampHeight(startHeight + dy);
    sheet.style.maxHeight = `${draggedHeight}px`;
  }

  function onEnd() {
    if (!dragging) return;
    dragging = false;
    sheet.style.transition = 'max-height 0.2s ease';
    if (!movedEnough) {
      // 실제로는 거의 움직이지 않은 "탭"이었으므로 아무것도 바꾸지 않습니다.
      return;
    }
    const points = [
      vh(SHEET_BREAKPOINTS_VH.collapsed),
      vh(SHEET_BREAKPOINTS_VH.default),
      vh(SHEET_BREAKPOINTS_VH.expanded),
    ];
    let nearest = points[0];
    let bestDiff = Infinity;
    points.forEach((p) => {
      const diff = Math.abs(draggedHeight - p);
      if (diff < bestDiff) {
        bestDiff = diff;
        nearest = p;
      }
    });
    sheet.style.maxHeight = `${nearest}px`;
  }

  handle.addEventListener('touchstart', (e) => onStart(e.touches[0].clientY), { passive: true });
  handle.addEventListener('touchmove', (e) => onMove(e.touches[0].clientY, e), { passive: false });
  handle.addEventListener('touchend', onEnd);
  handle.addEventListener('touchcancel', onEnd);

  // 마우스(창 폭을 줄여서 모바일 레이아웃을 흉내 낼 때도 같은 방식으로 테스트할 수 있도록)
  handle.addEventListener('mousedown', (e) => {
    onStart(e.clientY);
    const onMouseMove = (ev) => onMove(ev.clientY, ev);
    const onMouseUp = () => {
      onEnd();
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}
setupSpotListSheetDrag();

// 마커가 클러스터(여러 개를 뭉친 원형 아이콘) 안에 숨어있을 수도 있으므로, 목록에서 낚시터를
// 선택했을 때 필요하면 자동으로 줌인해서 그 마커가 실제로 보이게 만든 다음 풍선말을 엽니다.
function focusMarkerOnMap(marker, lat, lng) {
  if (typeof detailMarkerLayer.zoomToShowLayer === 'function') {
    detailMarkerLayer.zoomToShowLayer(marker, () => marker.openTooltip());
  } else {
    map.setView([lat, lng], Math.max(map.getZoom(), 13), { animate: true });
    marker.openTooltip();
  }
}

function selectSpotFromList(feature, li) {
  const marker = currentFeatureMarker.get(feature);
  if (!marker) return;
  const [lng, lat] = feature.geometry.coordinates;

  focusMarkerOnMap(marker, lat, lng);

  if (activeListItemEl) activeListItemEl.classList.remove('active');
  li.classList.add('active');
  activeListItemEl = li;
  li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  openPanel(feature.properties, lat, lng);
}

// ---------------------------------------------------------------------------
// 필터(바다/민물) — 현재 뷰에 맞춰 적용
// 상단 체크박스(#f-sea/#f-freshwater)가 필터의 단일 기준(source of truth)이고,
// 좌측 목록 헤더의 칩 버튼(.chip)은 이 상태를 보여주기만 하는 거울입니다.
// ---------------------------------------------------------------------------
function syncFilterChips() {
  const active = getActiveTypes();
  const seaChip = document.querySelector('.chip-sea');
  const freshChip = document.querySelector('.chip-freshwater');
  if (seaChip) seaChip.classList.toggle('active', active.sea);
  if (freshChip) freshChip.classList.toggle('active', active.freshwater);
}

function applyFilters() {
  syncFilterChips();
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
  renderSpotList(currentView.label);
}

document.getElementById('f-sea').addEventListener('change', applyFilters);
document.getElementById('f-freshwater').addEventListener('change', applyFilters);

document.querySelectorAll('#spot-list-chips .chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    const type = chip.dataset.type;
    const checkbox = document.getElementById(type === 'sea' ? 'f-sea' : 'f-freshwater');
    checkbox.checked = !checkbox.checked;
    applyFilters();
  });
});

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
document.getElementById('panel-to-region-view').addEventListener('click', showRegionView);

let currentSpot = null; // { lat, lng } — 물때 관측소 코드를 다시 조회할 때 사용
let lastObsCode = ''; // 같은 세션에서 편의상 마지막으로 입력한 관측소 코드를 기억

function openPanel(props, lat, lng) {
  panel.classList.remove('hidden');
  currentSpot = { lat, lng };
  document.getElementById('panel-title').textContent = props.name;
  document.getElementById('panel-meta').textContent =
    `${props.region || ''} · ${props.waterType === 'freshwater' ? '민물' : '바다'}` +
    (props.species?.length ? ` · 주요어종: ${props.species.join(', ')}` : '');

  document.getElementById('tide-obscode').value = lastObsCode;

  loadWeather(lat, lng);
  loadTide(lat, lng, lastObsCode);
  loadNearby(lat, lng);
}

document.getElementById('tide-obscode-apply').addEventListener('click', () => {
  if (!currentSpot) return;
  lastObsCode = document.getElementById('tide-obscode').value.trim();
  loadTide(currentSpot.lat, currentSpot.lng, lastObsCode);
});

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

function loadTide(lat, lng, obsCode) {
  const el = document.getElementById('panel-tide');
  el.textContent = '불러오는 중...';
  const qs = new URLSearchParams({ lat, lng });
  if (obsCode) qs.set('obsCode', obsCode);
  fetch(`/api/tide?${qs.toString()}`)
    .then((r) => r.json())
    .then((t) => {
      const lines = [];
      if (t.mocked) lines.push('⚠️ 예시 데이터 (KHOA 키/관측소 코드 미설정)');
      if (t.error) lines.push(`⚠️ ${escapeHtml(t.error)}`);
      if (t.apiError) {
        const { code, msg, hint } = t.apiError;
        lines.push(
          `<div class="tide-hint">KHOA 응답 코드: ${escapeHtml(code || '-')}${msg ? ` / ${escapeHtml(msg)}` : ''}` +
            (hint ? `<br>→ ${escapeHtml(hint)}` : '') +
            '</div>'
        );
      }
      if (t.highTide) lines.push(`고조: ${t.highTide.join(', ')}`);
      if (t.lowTide) lines.push(`저조: ${t.lowTide.join(', ')}`);
      if (t.raw) lines.push(`<pre class="tide-raw">${escapeHtml(JSON.stringify(t.raw, null, 2).slice(0, 800))}</pre>`);
      if (t.rawResponsePreview) {
        lines.push('<div class="tide-hint">KHOA 원본 응답 (디버그용):</div>');
        lines.push(`<pre class="tide-raw">${escapeHtml(t.rawResponsePreview)}</pre>`);
      }
      if (!t.highTide && !t.lowTide && !t.raw && !t.error) lines.push('이 지점의 물때 정보는 아직 연결되지 않았습니다.');
      el.innerHTML = lines.map((l) => `<div>${l}</div>`).join('');
    })
    .catch(() => { el.textContent = '물때 정보를 가져오지 못했습니다.'; });
}

// API 키 없이도 되는 카카오맵 공개 링크 — 새 탭에서 그 지점을 카카오맵으로 바로 볼 수 있습니다.
function kakaoMapLink(name, lat, lng) {
  return `https://map.kakao.com/link/map/${encodeURIComponent(name)},${lat},${lng}`;
}

const SHOP_TYPE_LABEL = {
  convenience: '편의점',
  supermarket: '슈퍼마켓',
  kiosk: '매점',
  bait: '낚시/미끼',
  fishing: '낚시용품',
  fuel: '주유소',
  unknown: '상점',
};

// 지도 위 상점 마커 — 종류별로 이모지/색깔을 다르게 줘서 한눈에 구분되게 합니다.
const SHOP_TYPE_STYLE = {
  convenience: { emoji: '🏪', color: '#1d6fb8' },
  supermarket: { emoji: '🛒', color: '#2e8b4f' },
  kiosk: { emoji: '🏪', color: '#6b7785' },
  bait: { emoji: '🎣', color: '#c9822e' },
  fishing: { emoji: '🎣', color: '#c9822e' },
  fuel: { emoji: '⛽', color: '#e08a1e' },
  unknown: { emoji: '📍', color: '#6b7785' },
};

// 주변 편의점/상점을 조회해서 지도(nearbyLayer)에 마커로 표시합니다.
// - 우측 상세 패널(특정 낚시터 클릭 시)과, 반경 내 낚시터 보기(지도 클릭 시) 양쪽에서 공용으로 씁니다.
// - 반환값은 실패 시 null, 성공 시 서버 응답(geojson)입니다 — 호출한 쪽에서 텍스트 목록 등 추가로
//   보여줄 게 있으면 이 값을 이어서 씁니다.
function renderNearbyShopMarkers(lat, lng) {
  nearbyLayer.clearLayers();
  return fetch(`/api/nearby?lat=${lat}&lng=${lng}`)
    .then((r) => r.json())
    .then((geojson) => {
      if (geojson.error || !geojson.features?.length) return geojson;
      geojson.features.forEach((f) => {
        const [flng, flat] = f.geometry.coordinates;
        const name = f.properties.name;
        const typeLabel = SHOP_TYPE_LABEL[f.properties.shop] || f.properties.shop;
        const distText = f.properties.distanceM != null ? `${f.properties.distanceM}m` : '';
        const popupHtml = `
          <div class="shop-popup">
            <div class="shop-popup-name">🏪 ${escapeHtml(name)}</div>
            <div class="shop-popup-meta">${escapeHtml(typeLabel)}${distText ? ' · ' + distText : ''}</div>
            <a class="shop-popup-link" href="${kakaoMapLink(name, flat, flng)}" target="_blank" rel="noopener">카카오맵에서 보기 →</a>
          </div>`;
        const shopStyle = SHOP_TYPE_STYLE[f.properties.shop] || SHOP_TYPE_STYLE.unknown;
        L.marker([flat, flng], {
          icon: L.divIcon({
            className: 'shop-icon',
            html: `<div class="shop-icon-badge" style="background:${shopStyle.color}">${shopStyle.emoji}</div>`,
            iconSize: [30, 30],
            iconAnchor: [15, 15],
          }),
        })
          .bindTooltip(name)
          .bindPopup(popupHtml)
          .addTo(nearbyLayer);
      });
      return geojson;
    })
    .catch(() => null);
}

function loadNearby(lat, lng) {
  const el = document.getElementById('panel-nearby');
  el.textContent = '불러오는 중...';
  renderNearbyShopMarkers(lat, lng).then((geojson) => {
    if (!geojson) {
      el.textContent = '주변 상점 정보를 가져오지 못했습니다.';
      return;
    }
    if (geojson.error) {
      el.textContent = `⚠️ ${geojson.error}`;
      return;
    }
    const radiusKm = geojson.radiusUsed ? (geojson.radiusUsed / 1000).toFixed(geojson.radiusUsed % 1000 ? 1 : 0) : null;
    const providerNote = geojson.provider === 'overpass'
      ? '<div class="tide-hint">OpenStreetMap 기반이라 농어촌·섬 지역은 등록이 안 되어 있을 수 있어요. (더 정확한 검색을 원하면 카카오 로컬 API 키를 추가할 수 있습니다 — README 참고)</div>'
      : '';
    if (!geojson.features?.length) {
      el.innerHTML = `<div>반경 ${radiusKm}km 내에 편의점/상점 정보가 없습니다.</div>${providerNote}`;
      return;
    }
    el.innerHTML =
      geojson.features
        .slice(0, 15)
        .map((f) => {
          const [flng, flat] = f.geometry.coordinates;
          const distText = f.properties.distanceM != null ? ` · ${f.properties.distanceM}m` : '';
          const typeLabel = SHOP_TYPE_LABEL[f.properties.shop] || f.properties.shop;
          return (
            `<div class="shop-item">🏪 ${escapeHtml(f.properties.name)} (${escapeHtml(typeLabel)})${distText}` +
            ` · <a href="${kakaoMapLink(f.properties.name, flat, flng)}" target="_blank" rel="noopener">카카오맵</a></div>`
          );
        })
        .join('') + providerNote;
  });
}

// ---------------------------------------------------------------------------
// 낚시터 이름 검색 — 전국 어디서든 이름으로 검색해서 해당 권역으로 이동한 뒤
// 좌측 목록과 지도 마커를 모두 그 낚시터로 포커싱합니다.
// ---------------------------------------------------------------------------
const searchInput = document.getElementById('search-input');
const searchResultsEl = document.getElementById('search-results');
let searchMatches = [];
let searchActiveIndex = -1;

function searchFeaturesByName(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return allFeatures.filter((f) => (f.properties.name || '').toLowerCase().includes(q)).slice(0, 8);
}

function highlightSearchIndex(index) {
  searchActiveIndex = index;
  searchResultsEl.querySelectorAll('.search-result-item').forEach((el, i) => {
    el.classList.toggle('active', i === index);
    if (i === index) el.scrollIntoView({ block: 'nearest' });
  });
}

function renderSearchResults(matches) {
  searchResultsEl.innerHTML = '';
  searchActiveIndex = -1;

  if (matches.length === 0) {
    const div = document.createElement('div');
    div.className = 'search-empty';
    div.textContent = '검색 결과가 없습니다.';
    searchResultsEl.appendChild(div);
    searchResultsEl.classList.remove('hidden');
    return;
  }

  matches.forEach((f) => {
    const p = f.properties;
    const type = waterTypeOf(f);
    const icon = type === 'freshwater' ? '🐟' : '🎣';
    const div = document.createElement('div');
    div.className = 'search-result-item';
    div.innerHTML =
      `<div class="search-result-name">${icon} ${escapeHtml(p.name)}</div>` +
      `<div class="search-result-meta">${escapeHtml(p.region || '')}${p.species?.length ? ' · ' + escapeHtml(p.species.slice(0, 3).join(', ')) : ''}</div>`;
    div.addEventListener('click', () => goToSearchResult(f));
    searchResultsEl.appendChild(div);
  });
  searchResultsEl.classList.remove('hidden');
}

// 검색으로 선택한 낚시터가 속한 권역으로 이동(필요시)하고, 목록 항목과 지도 마커를 모두 포커싱합니다.
function goToSearchResult(feature) {
  const type = waterTypeOf(feature);
  const checkbox = document.getElementById(type === 'freshwater' ? 'f-freshwater' : 'f-sea');
  if (!checkbox.checked) checkbox.checked = true; // 필터 때문에 안 보이는 상태였다면 켜줌

  const province = feature._provinceName;
  if (currentView.mode === 'detail' && currentView.name === province) {
    applyFilters(); // 이미 같은 권역이면 필터만 재적용해서 목록/마커를 최신 상태로
  } else {
    enterProvince(province);
  }

  const li = featureToLiEl.get(feature);
  if (li) {
    selectSpotFromList(feature, li);
  } else {
    const marker = currentFeatureMarker.get(feature);
    if (marker) {
      const [lng, lat] = feature.geometry.coordinates;
      focusMarkerOnMap(marker, lat, lng);
      openPanel(feature.properties, lat, lng);
    }
  }

  searchResultsEl.classList.add('hidden');
  searchInput.value = feature.properties.name;
}

searchInput.addEventListener('input', () => {
  searchMatches = searchFeaturesByName(searchInput.value);
  if (searchInput.value.trim()) {
    renderSearchResults(searchMatches);
  } else {
    searchResultsEl.classList.add('hidden');
  }
});

searchInput.addEventListener('focus', () => {
  if (searchInput.value.trim() && searchMatches.length) searchResultsEl.classList.remove('hidden');
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (searchMatches.length) highlightSearchIndex(Math.min(searchActiveIndex + 1, searchMatches.length - 1));
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (searchMatches.length) highlightSearchIndex(Math.max(searchActiveIndex - 1, 0));
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const target = searchMatches[searchActiveIndex >= 0 ? searchActiveIndex : 0];
    if (target) goToSearchResult(target);
  } else if (e.key === 'Escape') {
    searchResultsEl.classList.add('hidden');
  }
});

document.addEventListener('click', (e) => {
  if (!document.getElementById('search-box').contains(e.target)) {
    searchResultsEl.classList.add('hidden');
  }
});
