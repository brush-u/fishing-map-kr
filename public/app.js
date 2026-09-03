// 줌 컨트롤은 기본(top-left) 위치가 좌측 "권역 목록" 패널과 겹치므로 bottom-left로 옮깁니다.
// 초기 시야는 일단 한국+일본이 대략 다 보이는 값으로 잡아두고, 실제 권역 경계 데이터가
// 로드되면 그 전체 범위에 맞춰 fitBounds로 다시 한번 정확히 맞춥니다(아래 OVERVIEW_VIEW).
const map = L.map('map', { zoomControl: false }).setView([34.5, 132], 5);
L.control.zoom({ position: 'bottomleft' }).addTo(map);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' +
    ' | 시도 경계: KOSTAT 2013 (via southkorea/southkorea-maps), dataofjapan/land',
}).addTo(map);

// 전체 권역 화면으로 돌아갈 때 쓰는 기준 시야. 처음엔 대략값이고, 권역 경계 데이터가 로드되면
// 실제 데이터 범위(한국+일본 전체)에 맞춰 갱신됩니다.
let OVERVIEW_VIEW = { center: [34.5, 132], zoom: 5 };
let OVERVIEW_BOUNDS = null; // L.latLngBounds — 경계 데이터 로드 후 채워짐
const markerColor = { sea: '#1d6fb8', freshwater: '#2e8b4f', boat: '#8b5cf6' };

// 2013년 KOSTAT 정식명칭 -> 화면에 쓰는 짧은 이름
// (강원도/전라북도는 2023~2024년에 강원특별자치도/전북특별자치도로 명칭이 바뀌었지만,
//  원본 경계 데이터가 2013년 기준이라 표시용 짧은 이름은 그대로 둡니다)
const FULL_TO_SHORT = {
  서울특별시: '서울', 부산광역시: '부산', 대구광역시: '대구', 인천광역시: '인천',
  광주광역시: '광주', 대전광역시: '대전', 울산광역시: '울산', 세종특별자치시: '세종',
  경기도: '경기', 강원도: '강원', 충청북도: '충북', 충청남도: '충남',
  전라북도: '전북', 전라남도: '전남', 경상북도: '경북', 경상남도: '경남', 제주특별자치도: '제주',

  // 일본 47개 도도부현(한글 표기) -> 화면에 쓰는 짧은 이름 (data/boundaries/japan-prefectures.geo.json)
  홋카이도: '홋카이도', 아오모리현: '아오모리', 이와테현: '이와테', 미야기현: '미야기',
  아키타현: '아키타', 야마가타현: '야마가타', 후쿠시마현: '후쿠시마', 이바라키현: '이바라키',
  도치기현: '도치기', 군마현: '군마', 사이타마현: '사이타마', 지바현: '지바',
  도쿄도: '도쿄', 가나가와현: '가나가와', 니가타현: '니가타', 도야마현: '도야마',
  이시카와현: '이시카와', 후쿠이현: '후쿠이', 야마나시현: '야마나시', 나가노현: '나가노',
  기후현: '기후', 시즈오카현: '시즈오카', 아이치현: '아이치', 미에현: '미에',
  시가현: '시가', 교토부: '교토', 오사카부: '오사카', 효고현: '효고',
  나라현: '나라', 와카야마현: '와카야마', 돗토리현: '돗토리', 시마네현: '시마네',
  오카야마현: '오카야마', 히로시마현: '히로시마', 야마구치현: '야마구치', 도쿠시마현: '도쿠시마',
  가가와현: '가가와', 에히메현: '에히메', 고치현: '고치', 후쿠오카현: '후쿠오카',
  사가현: '사가', 나가사키현: '나가사키', 구마모토현: '구마모토', 오이타현: '오이타',
  미야자키현: '미야자키', 가고시마현: '가고시마', 오키나와현: '오키나와',
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
  // 기본값(80px)보다 훨씬 작게 잡아서 클러스터가 더 잘게 나뉘게 하고, 살짝만 줌인해도(12 이상)
  // 아예 클러스터링을 끄고 낱개 마커를 바로 보여줘서 — 클릭을 여러 번 안 해도 개별 낚시포인트에
  // 빨리 도달하도록 합니다.
  maxClusterRadius: 30,
  disableClusteringAtZoom: 12,
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
let detailMarkersByType = { sea: [], freshwater: [], boat: [] };

function getActiveTypes() {
  return {
    sea: document.getElementById('f-sea').checked,
    freshwater: document.getElementById('f-freshwater').checked,
    boat: document.getElementById('f-boat').checked,
  };
}

function waterTypeOf(feature) {
  return feature.properties.waterType === 'freshwater' ? 'freshwater' : 'sea';
}

// 배낚시/선상낚시(data/boat_spots.geojson, category:"boat")는 waterType상으로는 "바다"이지만
// 필터/아이콘/색상은 바다낚시와 별도로 구분해서 보여줍니다.
function spotCategory(feature) {
  if (feature.properties.category === 'boat') return 'boat';
  return waterTypeOf(feature);
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
  const emoji = type === 'freshwater' ? '🐟' : type === 'boat' ? '🚤' : '🎣';
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

// 구글맵 공개 링크 — API 키 없이도 새 탭에서 그 좌표를 바로 구글맵으로 볼 수 있습니다.
function googleMapsLink(name, lat, lng) {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}${name ? `(${encodeURIComponent(name)})` : ''}`;
}

// 네이버맵 공개 링크 — API 키 없이도 새 탭에서 그 좌표를 바로 네이버맵으로 볼 수 있습니다.
function naverMapLink(name, lat, lng) {
  return `https://map.naver.com/p/search/${encodeURIComponent(name || '낚시포인트')}?c=${lng},${lat},15,0,0,0,dh`;
}

// 이름 옆에 "구글/네이버/카카오" 중 원하는 지도 앱을 골라서 열 수 있는 작은 링크 3개를
// 나란히 붙여줍니다. 특정 앱 하나로 고정하지 않고 매번 선택할 수 있게 하기 위함입니다.
// (kakaoMapLink는 이 파일 아래쪽에 정의돼 있지만, 함수 선언은 호이스팅되므로 여기서 바로 씁니다)
function mapLinksHtml(name, lat, lng, extraClass) {
  const cls = `map-links${extraClass ? ' ' + extraClass : ''}`;
  return (
    `<span class="${cls}">` +
    `<a href="${googleMapsLink(name, lat, lng)}" target="_blank" rel="noopener" title="구글맵에서 보기">구글</a>` +
    `<a href="${naverMapLink(name, lat, lng)}" target="_blank" rel="noopener" title="네이버맵에서 보기">네이버</a>` +
    `<a href="${kakaoMapLink(name, lat, lng)}" target="_blank" rel="noopener" title="카카오맵에서 보기">카카오</a>` +
    `</span>`
  );
}

// 마커에 마우스를 올리면 뜨는 "풍선말"에 이름뿐 아니라 권역/어종/수종 등 상세 정보를 보여줍니다.
// (클릭하면 열리는 우측 상세 패널과는 별개로, 지도를 훑어볼 때 바로 핵심 정보를 알 수 있게 함)
// 이름 옆의 구글/네이버/카카오 중 하나를 누르면 그 지도 앱으로 연결됩니다 — 풍선말이
// interactive:true라야 안의 링크가 클릭됩니다.
function tooltipHtml(p, lat, lng) {
  const type = spotCategory({ properties: p });
  const typeLabel = type === 'freshwater' ? '민물낚시' : type === 'boat' ? '배낚시/선상낚시' : '바다낚시';
  const speciesStr = Array.isArray(p.species) && p.species.length ? p.species.slice(0, 5).join(', ') : '';
  const lifestyleBadge = p.lifestyleFishing ? '<span class="tt-badge">생활낚시</span>' : '';
  const boatMeta = type === 'boat' && p.boatCount ? `<div class="tt-species">🚤 등록 낚시어선 ${p.boatCount}척</div>` : '';
  return `
    <div class="spot-tooltip">
      <span class="tt-name">${escapeHtml(p.name)}</span>${lifestyleBadge}
      ${mapLinksHtml(p.name, lat, lng)}
      <div class="tt-meta">${typeLabel}${p.region ? ' · ' + escapeHtml(p.region) : ''}</div>
      ${speciesStr ? `<div class="tt-species">🐟 ${escapeHtml(speciesStr)}</div>` : ''}
      ${boatMeta}
    </div>`;
}

// 마커에 "마우스를 올리면 풍선말이 뜨고, 풍선말 안으로 마우스를 옮겨서 그 안의 링크를
// 클릭할 수 있는" 팝업을 붙입니다. 낚시포인트 마커와 주변 편의점/상점 마커 양쪽에서 씁니다.
//
// Leaflet의 bindTooltip 기본 동작은 마우스가 "마커"에서 벗어나는 순간 곧바로 닫혀버려서,
// 마커에서 풍선말 쪽으로 마우스를 옮기는 도중에 닫혀 안의 링크를 클릭할 수 없었습니다.
// (편의점 마커는 애초에 bindPopup을 쓰고 있었지만, mouseout에서 지연 없이 바로
// closePopup()을 호출하고 있어서 똑같은 문제가 있었습니다 — 아래처럼 고쳤습니다.)
// bindPopup은 자동으로 닫히지 않으므로, 직접 mouseover/mouseout으로 열고 닫되, 풍선말
// 자체에 마우스가 들어와 있는 동안은 약간의 지연(150ms) 후에도 닫지 않습니다.
function bindHoverPopup(marker, popupHtml, popupOptions) {
  marker.bindPopup(popupHtml, popupOptions);

  let closeTimer = null;
  const cancelClose = () => {
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer = setTimeout(() => marker.closePopup(), 150);
  };
  marker.on('popupopen', () => {
    const el = marker.getPopup()?.getElement();
    if (!el) return;
    el.addEventListener('mouseenter', cancelClose);
    el.addEventListener('mouseleave', scheduleClose);
  });
  marker.on('mouseover', () => {
    cancelClose();
    marker.openPopup();
  });
  marker.on('mouseout', scheduleClose);
  return marker;
}

function makeSpotMarker(feature) {
  const [lng, lat] = feature.geometry.coordinates;
  const p = feature.properties;
  const type = spotCategory(feature);
  const marker = L.marker([lat, lng], { icon: pinIcon(type) });

  bindHoverPopup(marker, tooltipHtml(p, lat, lng), {
    className: 'spot-tooltip-wrapper',
    closeButton: false,
    autoPan: false,
    offset: [0, -28],
  });

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
    if (!active[spotCategory(f)]) return;
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
  if (OVERVIEW_BOUNDS) map.fitBounds(OVERVIEW_BOUNDS, { padding: [20, 20] });
  else map.setView(OVERVIEW_VIEW.center, OVERVIEW_VIEW.zoom);
  document.getElementById('region-nav').classList.add('hidden');
  document.getElementById('region-title').textContent = '';
  document.getElementById('region-weather').textContent = '';

  currentRegionFeatures = [];
  currentFeatureMarker = new Map();
  activeListItemEl = null;
  document.getElementById('spot-list').classList.add('hidden');
  document.getElementById('spot-list-reopen')?.classList.add('hidden');
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
  detailMarkersByType = { sea: [], freshwater: [], boat: [] };
  nearbyLayer.clearLayers(); // 이전에 "지점 주변 보기"에서 표시했던 편의점 마커가 남아있지 않도록 정리

  const active = getActiveTypes();
  features.forEach((f) => {
    const marker = makeSpotMarker(f);
    currentFeatureMarker.set(f, marker);
    detailMarkersByType[spotCategory(f)].push(marker);
    if (active[spotCategory(f)]) marker.addTo(detailMarkerLayer);
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
  detailMarkersByType = { sea: [], freshwater: [], boat: [] };

  const active = getActiveTypes();
  features.forEach((f) => {
    const marker = makeSpotMarker(f);
    currentFeatureMarker.set(f, marker);
    detailMarkersByType[spotCategory(f)].push(marker);
    if (active[spotCategory(f)]) marker.addTo(detailMarkerLayer);
  });
  detailMarkerLayer.addTo(map);

  // 클릭할 때마다 지도를 강제로 확대/축소해서 다시 맞추면 화면이 계속 튀는 느낌이 들어서
  // (사용자가 확대해둔 상태에서 클릭하면 갑자기 줄어들고, 축소해둔 상태에서 클릭하면 갑자기
  // 커지는 문제) — 클릭한 지점은 이미 현재 화면 안에 보이는 곳이므로, 지도 위치/줌은 그대로
  // 두고 목록/마커만 갱신합니다.

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

// 하늘/강수 상태 문자열을 보고 알아보기 쉬운 이모지 아이콘으로 바꿔줍니다.
// (날씨 정보를 텍스트만으로 훑어보기 어렵다는 피드백이 있어, 상단 배지/상세패널 양쪽에서 공용으로 씁니다)
function weatherEmoji(sky, precip) {
  if (precip && precip !== '없음' && precip !== '-') {
    if (precip.includes('눈')) return '🌨️';
    if (precip.includes('비') || precip.includes('소나기')) return '🌧️';
    return '🌦️';
  }
  if (!sky || sky === '-') return '🌤️';
  if (sky.includes('맑')) return '☀️';
  if (sky.includes('흐')) return '☁️';
  if (sky.includes('구름')) return '⛅';
  return '🌤️';
}

// 기상청 단기예보는 5km 격자 단위(사실상 지역 단위) 정보라 낚시터 하나하나가 아니라
// "이 주변은 지금 대략 이런 날씨"로 봐도 무방합니다. 대표지점 기준으로 한 번만 조회해서
// 상단 타이틀 옆에 눈에 잘 띄는 배지로 보여줍니다.
function loadRegionWeather(point) {
  const el = document.getElementById('region-weather');
  if (!point) {
    el.innerHTML = '';
    return;
  }
  const { lat, lng } = point;
  el.innerHTML = '날씨 불러오는 중...';
  fetch(`/api/weather?lat=${lat}&lng=${lng}`)
    .then((r) => r.json())
    .then((w) => {
      if (w.error) {
        el.innerHTML = '';
        return;
      }
      const parts = [];
      if (w.mocked) parts.push('⚠️ 예시데이터');
      parts.push(escapeHtml(w.sky ?? '-'));
      if (w.precipitationType && w.precipitationType !== '없음') parts.push(`강수 ${escapeHtml(w.precipitationType)}`);
      if (w.temperature != null) parts.push(`${w.temperature}℃`);
      if (w.windSpeed != null) parts.push(`풍속 ${w.windSpeed}m/s`);
      if (w.waveHeight) parts.push(`파고 ${w.waveHeight}m`);
      const emoji = weatherEmoji(w.sky, w.precipitationType);
      el.innerHTML = `<span class="weather-badge-icon">${emoji}</span><span class="weather-badge-text">${parts.join(' · ')}</span>`;
      el.title = '권역 대표지점 기준 날씨입니다. 기상청 격자(5km) 단위 예보라 실제 낚시포인트와 약간 다를 수 있어요.';
    })
    .catch(() => { el.innerHTML = ''; });
}

document.getElementById('btn-back').addEventListener('click', showRegionView);

// 지도를 줌아웃해서 권역 상세 뷰보다 더 넓은 범위가 보이면 자동으로 전체 권역 뷰로 돌아갑니다.
// 전체 권역(한국+일본)을 fitBounds한 실제 줌 레벨로 아래 데이터 로드 시 갱신됩니다.
let AUTO_COLLAPSE_ZOOM = OVERVIEW_VIEW.zoom;
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
  boat: { label: '🚤 배낚시/선상낚시' },
};

// 좌측 목록을 바다/민물 두 그룹으로 나눠 보여줍니다. 상단 체크박스(#f-sea/#f-freshwater)와
// 목록 헤더의 칩 버튼(.chip)이 같은 필터 상태를 공유하며 서로 동기화됩니다.
function renderSpotList(regionShortName) {
  const listEl = document.getElementById('spot-list');
  const titleEl = document.getElementById('spot-list-title');
  const bodyEl = document.getElementById('spot-list-body');
  const active = getActiveTypes();

  const visibleFeatures = currentRegionFeatures.filter((f) => active[spotCategory(f)]);

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

  const groups = { sea: [], freshwater: [], boat: [] };
  visibleFeatures.forEach((f) => groups[spotCategory(f)].push(f));

  ['sea', 'freshwater', 'boat'].forEach((type) => {
    const items = groups[type];
    if (items.length === 0) return;

    const section = document.createElement('div');
    section.className = 'spot-group';

    const h4 = document.createElement('h4');
    h4.className = `spot-group-title spot-group-title-${type}`;
    h4.textContent = `${WATER_GROUP_META[type].label} (${items.length})`;
    section.appendChild(h4);

    const ul = document.createElement('ul');
    ul.className = 'spot-group-items';
    items.forEach((f) => {
      const p = f.properties;
      const li = document.createElement('li');
      const dotColor = markerColor[spotCategory(f)];
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
// 별개로, 창 전체의 높이(=얼마나 펼쳐 보이는지)가 바뀝니다. (기존 기능, 그대로 유지)
// - 헤더(제목/칩 버튼이 있는 줄) 영역에서만 드래그를 인식합니다 — 목록 본문(#spot-list-body)의
//   터치는 그대로 일반 스크롤로 남겨둡니다.
// - 손을 떼면 접힘/기본/펼침 세 지점 중 가장 가까운 높이로 스냅됩니다.
// 여기에 두 가지를 추가합니다:
// 1) 드래그 없이 헤더를 짧게 "탭"만 하면(칩 버튼 위가 아닌 경우) 접힘→기본→펼침 순서로
//    한 단계씩 순환합니다.
// 2) 목록 본문이 이미 맨 위로 스크롤된 상태에서 손가락을 더 아래로 그으면(pull-to-close),
//    목록 창 전체가 화면 아래로 내려가며 닫힙니다 — 화면 아래쪽에 나타나는 작은
//    "목록 다시 보기" 버튼으로 다시 열 수 있습니다.
// ---------------------------------------------------------------------------
const SHEET_BREAKPOINTS_VH = { collapsed: 11, default: 42, expanded: 82 };
const SHEET_ORDER = ['collapsed', 'default', 'expanded'];
let sheetState = 'default'; // 탭으로 순환할 때 "지금 몇 단계인지" 기준

function isMobileSheetLayout() {
  return window.matchMedia('(max-width: 680px)').matches;
}

function resetSpotListSheetHeight() {
  const listEl = document.getElementById('spot-list');
  if (listEl) {
    listEl.style.maxHeight = '';
    listEl.style.opacity = '';
    listEl.classList.remove('hidden');
  }
  sheetState = 'default';
  document.getElementById('spot-list-reopen')?.classList.add('hidden');
}

function setupSpotListSheetDrag() {
  const sheet = document.getElementById('spot-list');
  const handle = document.getElementById('spot-list-header');
  const body = document.getElementById('spot-list-body');
  const reopenBtn = document.getElementById('spot-list-reopen');
  if (!sheet || !handle) return;

  const vh = (v) => window.innerHeight * (v / 100);
  const DRAG_THRESHOLD_PX = 8;

  function clampHeight(h) {
    return Math.max(vh(SHEET_BREAKPOINTS_VH.collapsed), Math.min(vh(SHEET_BREAKPOINTS_VH.expanded), h));
  }

  function nearestBreakpointKey(h) {
    let nearestKey = SHEET_ORDER[0];
    let bestDiff = Infinity;
    SHEET_ORDER.forEach((key) => {
      const diff = Math.abs(h - vh(SHEET_BREAKPOINTS_VH[key]));
      if (diff < bestDiff) {
        bestDiff = diff;
        nearestKey = key;
      }
    });
    return nearestKey;
  }

  function snapTo(key) {
    sheet.style.transition = 'max-height 0.2s ease';
    sheet.style.maxHeight = `${vh(SHEET_BREAKPOINTS_VH[key])}px`;
    sheetState = key;
  }

  // ------- 헤더 드래그 + 탭 순환 -------
  let dragging = false;
  let movedEnough = false;
  let startY = 0;
  let startHeight = 0;
  let draggedHeight = 0; // 지금까지 끌어서 "의도한" 높이 — 목록이 비어있어 실제 렌더링 높이가
                         // max-height보다 작을 수 있으므로, 스냅 판정은 실제 렌더링 높이가 아니라
                         // 이 값(의도한 높이) 기준으로 합니다.
  let startTarget = null;

  function onStart(clientY, target) {
    if (!isMobileSheetLayout()) return;
    dragging = true;
    movedEnough = false;
    startY = clientY;
    startTarget = target || null;
    // 시작 높이는 "지금 펼쳐진 정도"를 기준으로 잡아야 하므로, 목록이 비어서 실제 렌더링 높이가
    // 작더라도 직전에 설정해둔 max-height(없으면 현재 단계)를 기준으로 삼습니다.
    const inlineMax = parseFloat(sheet.style.maxHeight);
    startHeight = Number.isFinite(inlineMax) ? inlineMax : vh(SHEET_BREAKPOINTS_VH[sheetState]);
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
      // 실제로 끌지 않고 짧게 "탭"만 한 경우입니다.
      // 칩 버튼(바다/민물/배낚시 필터) 위를 탭한 거라면 그 버튼 자신의 클릭 동작에 맡기고
      // 아무것도 하지 않습니다. 그 외 헤더 영역(핸들 바/제목 등)이었다면 접힘 → 기본 → 펼침
      // 순서로 창 크기를 한 단계씩 순환시킵니다.
      if (startTarget && startTarget.closest && startTarget.closest('.chip')) return;
      const nextIdx = (SHEET_ORDER.indexOf(sheetState) + 1) % SHEET_ORDER.length;
      snapTo(SHEET_ORDER[nextIdx]);
      return;
    }
    snapTo(nearestBreakpointKey(draggedHeight));
  }

  handle.addEventListener('touchstart', (e) => onStart(e.touches[0].clientY, e.target), { passive: true });
  handle.addEventListener('touchmove', (e) => onMove(e.touches[0].clientY, e), { passive: false });
  handle.addEventListener('touchend', onEnd);
  handle.addEventListener('touchcancel', onEnd);

  // 마우스(창 폭을 줄여서 모바일 레이아웃을 흉내 낼 때도 같은 방식으로 테스트할 수 있도록)
  handle.addEventListener('mousedown', (e) => {
    onStart(e.clientY, e.target);
    const onMouseMove = (ev) => onMove(ev.clientY, ev);
    const onMouseUp = () => {
      onEnd();
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });

  // ------- 본문 목록: 이미 맨 위로 스크롤된 상태에서 아래로 더 긁으면(pull-to-close)
  //         창 전체를 닫습니다 -------
  if (body) {
    let pulling = false;
    let pullDecided = null; // null(미정) | 'pull' | 'scroll'
    let pullStartY = 0;
    let pullStartHeight = 0;

    function pullStart(clientY) {
      if (!isMobileSheetLayout()) return;
      pulling = false;
      pullDecided = null;
      pullStartY = clientY;
      const inlineMax = parseFloat(sheet.style.maxHeight);
      pullStartHeight = Number.isFinite(inlineMax) ? inlineMax : vh(SHEET_BREAKPOINTS_VH[sheetState]);
    }

    function pullMove(clientY, evt) {
      if (!isMobileSheetLayout() || pullDecided === 'scroll') return;
      const dy = clientY - pullStartY; // 아래로 내리면 +
      if (!pulling) {
        if (Math.abs(dy) < DRAG_THRESHOLD_PX) return;
        // 위로 긁거나(dy<0), 이미 목록이 스크롤되어 맨 위가 아니면 일반 스크롤에 맡깁니다.
        if (dy < 0 || body.scrollTop > 0) {
          pullDecided = 'scroll';
          return;
        }
        pulling = true;
        pullDecided = 'pull';
        sheet.style.transition = 'none';
      }
      if (evt && evt.cancelable) evt.preventDefault();
      const newHeight = Math.max(0, pullStartHeight - dy);
      sheet.style.maxHeight = `${newHeight}px`;
      sheet.style.opacity = String(Math.max(0.3, newHeight / Math.max(1, pullStartHeight)));
    }

    function pullEnd() {
      const wasPulling = pulling;
      pulling = false;
      pullDecided = null;
      if (!wasPulling) return;
      sheet.style.transition = 'max-height 0.2s ease, opacity 0.2s ease';
      sheet.style.opacity = '';
      const inlineMax = parseFloat(sheet.style.maxHeight);
      const collapsedH = vh(SHEET_BREAKPOINTS_VH.collapsed);
      if (Number.isFinite(inlineMax) && inlineMax < collapsedH * 0.6) {
        // 접힘 단계보다도 많이 끌어내렸으면 완전히 닫습니다 — "목록 다시 보기" 버튼으로 복구.
        sheet.classList.add('hidden');
        sheet.style.maxHeight = '';
        sheetState = 'default';
        reopenBtn?.classList.remove('hidden');
      } else {
        snapTo('collapsed');
      }
    }

    body.addEventListener('touchstart', (e) => pullStart(e.touches[0].clientY), { passive: true });
    body.addEventListener('touchmove', (e) => pullMove(e.touches[0].clientY, e), { passive: false });
    body.addEventListener('touchend', pullEnd);
    body.addEventListener('touchcancel', pullEnd);
  }

  reopenBtn?.addEventListener('click', () => {
    sheet.classList.remove('hidden');
    reopenBtn.classList.add('hidden');
    snapTo('default');
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
  const boatChip = document.querySelector('.chip-boat');
  if (seaChip) seaChip.classList.toggle('active', active.sea);
  if (freshChip) freshChip.classList.toggle('active', active.freshwater);
  if (boatChip) boatChip.classList.toggle('active', active.boat);
}

function applyFilters() {
  syncFilterChips();
  if (currentView.mode === 'region') {
    rebuildProvinceLayer();
    return;
  }
  const active = getActiveTypes();
  ['sea', 'freshwater', 'boat'].forEach((type) => {
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
document.getElementById('f-boat').addEventListener('change', applyFilters);

document.querySelectorAll('#spot-list-chips .chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    const type = chip.dataset.type;
    const checkbox = document.getElementById(`f-${type}`);
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

    // 실제 권역 경계 전체(한국 + 일본이 있으면 일본도 포함)에 맞춰 초기 시야를 다시 잡습니다.
    if (provinceFeatures.length) {
      OVERVIEW_BOUNDS = L.geoJSON({ type: 'FeatureCollection', features: provinceFeatures }).getBounds();
      map.fitBounds(OVERVIEW_BOUNDS, { padding: [20, 20] });
      // fitBounds는 동기적으로 뷰를 확정하므로, 바로 이어서 읽은 줌 레벨이 실제 "전체 보기" 줌입니다.
      OVERVIEW_VIEW = { center: map.getCenter(), zoom: map.getZoom() };
      AUTO_COLLAPSE_ZOOM = map.getZoom();
    }
  })
  .catch((err) => console.error('지도 데이터 로드 실패', err));

// ---------------------------------------------------------------------------
// 우측 정보 패널 (날씨 / 물때 / 주변 편의점)
// ---------------------------------------------------------------------------
const panel = document.getElementById('panel');
document.getElementById('panel-close').addEventListener('click', () => panel.classList.add('hidden'));
document.getElementById('panel-to-region-view').addEventListener('click', showRegionView);

let currentSpot = null; // { lat, lng }

function openPanel(props, lat, lng) {
  panel.classList.remove('hidden');
  currentSpot = { lat, lng };
  document.getElementById('panel-title').innerHTML =
    `<span class="panel-title-name">${escapeHtml(props.name)}</span>` + mapLinksHtml(props.name, lat, lng, 'map-links-panel');
  const categoryLabel =
    props.category === 'boat' ? '배낚시/선상낚시' : props.waterType === 'freshwater' ? '민물' : '바다';
  document.getElementById('panel-meta').textContent =
    `${props.region || ''} · ${categoryLabel}` +
    (props.species?.length ? ` · 주요어종: ${props.species.join(', ')}` : '') +
    (props.category === 'boat' && props.boatCount ? ` · 🚤 등록 낚시어선 ${props.boatCount}척` : '');

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
      if (w.unsupported) {
        el.innerHTML = `<div class="tide-badge tide-badge-empty">🌍 ${escapeHtml(w.message || '이 지역은 아직 날씨 정보를 지원하지 않습니다.')}</div>`;
        return;
      }
      const emoji = weatherEmoji(w.sky, w.precipitationType);
      const mockedBadge = w.mocked ? '<div class="weather-mocked">⚠️ 예시 데이터 (KMA_FORECAST_KEY 미설정)</div>' : '';
      const stats = [
        { label: '강수', value: w.precipitationType ?? '-' },
        { label: '풍속', value: w.windSpeed != null ? `${w.windSpeed}m/s` : '-' },
      ];
      if (w.waveHeight) stats.push({ label: '파고', value: `${w.waveHeight}m` });
      el.innerHTML =
        mockedBadge +
        `<div class="weather-main">
          <span class="weather-emoji">${emoji}</span>
          <span class="weather-temp">${w.temperature != null ? `${w.temperature}℃` : '-'}</span>
          <span class="weather-sky">${escapeHtml(w.sky ?? '-')}</span>
        </div>` +
        `<div class="weather-grid">${stats
          .map((s) => `<div class="weather-stat"><span class="weather-stat-label">${s.label}</span><span class="weather-stat-value">${escapeHtml(String(s.value))}</span></div>`)
          .join('')}</div>`;
    })
    .catch(() => { el.textContent = '날씨 정보를 가져오지 못했습니다.'; });
}

function loadTide(lat, lng) {
  const el = document.getElementById('panel-tide');
  el.textContent = '불러오는 중...';
  const qs = new URLSearchParams({ lat, lng });
  fetch(`/api/tide?${qs.toString()}`)
    .then((r) => r.json())
    .then((t) => {
      if (t.unsupported) {
        el.innerHTML = `<div class="tide-badge tide-badge-empty">🌍 ${escapeHtml(t.message || '이 지역은 아직 물때 정보를 지원하지 않습니다.')}</div>`;
        return;
      }
      const blocks = [];

      // 안내/에러 배지 — 눈에 확실히 띄도록 날씨 배지와 같은 방식으로 색을 넣습니다.
      if (t.mocked) {
        blocks.push(`<div class="tide-badge tide-badge-mocked">⚠️ 예시 데이터 — ${escapeHtml(t.message || 'KHOA 키 미설정')}</div>`);
      }
      if (t.error) {
        blocks.push(`<div class="tide-badge tide-badge-error">⛔ ${escapeHtml(t.error)}</div>`);
      }
      if (t.apiError) {
        const { code, msg, hint } = t.apiError;
        blocks.push(
          `<div class="tide-badge tide-badge-error">KHOA 응답 코드: ${escapeHtml(code || '-')}${msg ? ` / ${escapeHtml(msg)}` : ''}` +
            (hint ? `<br>→ ${escapeHtml(hint)}` : '') +
            '</div>'
        );
      }

      if (t.station) {
        blocks.push(
          `<div class="tide-hint">관측소: ${escapeHtml(t.station.name)} (${escapeHtml(t.station.code)})` +
            (t.station.distanceKm != null ? ` · 약 ${t.station.distanceKm}km` : '') +
            '</div>'
        );
      }
      // 가장 가까운 관측소에 그날 예보가 없어서 다음으로 가까운 관측소 데이터를 대신 보여준
      // 경우, 그 사실을 알려줍니다 (안 그러면 "왜 이 관측소가 뜨지?" 하고 헷갈릴 수 있어서).
      if (t.fallbackFrom?.length) {
        blocks.push(
          `<div class="tide-hint">(가장 가까운 관측소(${t.fallbackFrom.map((n) => escapeHtml(n)).join(', ')})엔 이 날짜 예보가 없어서, 다음으로 가까운 관측소 값을 대신 보여드려요)</div>`
        );
      }

      // 고조/저조 시각 — 실제 값이 있을 때는 크고 또렷한 색 칩으로 강조합니다.
      if (t.highTide || t.lowTide) {
        blocks.push('<div class="tide-grid">' +
          (t.highTide ? `<div class="tide-stat tide-stat-high"><span class="tide-stat-label">🔺 고조</span><span class="tide-stat-value">${escapeHtml(t.highTide.join(', '))}</span></div>` : '') +
          (t.lowTide ? `<div class="tide-stat tide-stat-low"><span class="tide-stat-label">🔻 저조</span><span class="tide-stat-value">${escapeHtml(t.lowTide.join(', '))}</span></div>` : '') +
          '</div>');
      }

      if (!t.highTide && !t.lowTide && !t.error && !t.apiError) {
        const triedText = t.triedStations?.length > 1
          ? ` (가까운 관측소 ${t.triedStations.map((n) => escapeHtml(n)).join(', ')} 모두 확인해봤지만 이 날짜엔 예보가 없었어요)`
          : '';
        blocks.push(`<div class="tide-badge tide-badge-empty">이 날짜에는 근처 관측소의 고조/저조 예보 데이터가 없습니다.${triedText}</div>`);
      }

      // 정상적으로 고조/저조가 나왔을 때는 원본 JSON 덤프까지 보여줄 필요가 없고, 값이 하나도
      // 안 나왔을 때만(원인 파악용 디버그 정보로) 보여줍니다.
      if (t.raw && !t.highTide && !t.lowTide) {
        blocks.push(`<pre class="tide-raw">${escapeHtml(JSON.stringify(t.raw, null, 2).slice(0, 800))}</pre>`);
      }
      if (t.rawResponsePreview) {
        blocks.push('<div class="tide-hint">KHOA 원본 응답 (디버그용):</div>');
        blocks.push(`<pre class="tide-raw">${escapeHtml(t.rawResponsePreview)}</pre>`);
      }
      if (t.mocked) {
        blocks.push('<div class="tide-hint">서버 배포 주소 뒤에 <code>/api/status</code>를 붙여서 열어보면 KHOA_TIDE_KEY가 실제로 반영됐는지 확인할 수 있습니다.</div>');
      }
      el.innerHTML = blocks.join('');
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
        const shopStyle = SHOP_TYPE_STYLE[f.properties.shop] || SHOP_TYPE_STYLE.unknown;
        const typeLabelHtml = `<span style="color:${shopStyle.color};font-weight:700;">${escapeHtml(typeLabel)}</span>`;
        const distText = f.properties.distanceM != null ? `${f.properties.distanceM}m` : '';
        const popupHtml = `
          <div class="shop-popup">
            <a class="shop-popup-name" href="${kakaoMapLink(name, flat, flng)}" target="_blank" rel="noopener">${shopStyle.emoji} ${escapeHtml(name)}</a>
            <div class="shop-popup-meta">${typeLabelHtml}${distText ? ' · ' + distText : ''}</div>
          </div>`;
        // 마우스를 올릴 때(mouseover)와 클릭할 때 각각 다른 작은/큰 풍선말이 따로 뜨던 걸 없애고,
        // 항상 같은 팝업(popupHtml)이 뜨도록 통일합니다.
        const shopMarker = L.marker([flat, flng], {
          icon: L.divIcon({
            className: 'shop-icon',
            html: `<div class="shop-icon-badge" style="background:${shopStyle.color}">${shopStyle.emoji}</div>`,
            iconSize: [30, 30],
            iconAnchor: [15, 15],
          }),
        }).addTo(nearbyLayer);
        // 풍선말 안의 이름(링크)을 클릭할 수 있도록, 낚시포인트 마커와 같은 "마우스가 풍선말
        // 안으로 들어가면 안 닫히는" 방식을 씁니다 (예전에는 mouseout에서 바로 닫아버려서
        // 편의점/주유소 풍선말의 링크를 클릭하기 전에 닫히는 문제가 있었습니다).
        bindHoverPopup(shopMarker, popupHtml);
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
          const shopStyle = SHOP_TYPE_STYLE[f.properties.shop] || SHOP_TYPE_STYLE.unknown;
          const typeLabelHtml = `<span style="color:${shopStyle.color};font-weight:700;">${escapeHtml(typeLabel)}</span>`;
          return (
            `<div class="shop-item">${shopStyle.emoji} <a href="${kakaoMapLink(f.properties.name, flat, flng)}" target="_blank" rel="noopener">${escapeHtml(f.properties.name)}</a>` +
            ` (${typeLabelHtml})${distText}</div>`
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
    const type = spotCategory(f);
    const icon = type === 'freshwater' ? '🐟' : type === 'boat' ? '🚤' : '🎣';
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
  const type = spotCategory(feature);
  const checkbox = document.getElementById(`f-${type}`);
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