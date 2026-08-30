const map = L.map('map').setView([36.2, 127.8], 7); // 대한민국 전체가 보이는 초기 시야

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

const markerColor = { sea: '#1d6fb8', freshwater: '#2e8b4f' };
const markersByType = { sea: [], freshwater: [] };
let nearbyLayer = L.layerGroup().addTo(map);

function makeSpotMarker(feature) {
  const [lng, lat] = feature.geometry.coordinates;
  const p = feature.properties;
  const color = markerColor[p.waterType] || '#999';
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

fetch('/api/spots')
  .then((r) => r.json())
  .then((geojson) => {
    geojson.features.forEach((f) => {
      const type = f.properties.waterType === 'freshwater' ? 'freshwater' : 'sea';
      const marker = makeSpotMarker(f);
      markersByType[type].push(marker);
      marker.addTo(map);
    });
  })
  .catch((err) => console.error('낚시포인트 로드 실패', err));

document.getElementById('f-sea').addEventListener('change', (e) => toggleType('sea', e.target.checked));
document.getElementById('f-freshwater').addEventListener('change', (e) => toggleType('freshwater', e.target.checked));

function toggleType(type, show) {
  markersByType[type].forEach((m) => {
    if (show) m.addTo(map);
    else map.removeLayer(m);
  });
}

// ---- 우측 정보 패널 ----
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
