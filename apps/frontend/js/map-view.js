import { state, onStateUpdate } from './state.js?v=20261015-7';
import { estimateRouteConflicts, COLLISION_MODEL } from './collision-check.js?v=20261019-2';
import {
  uploadMission,
  startMission,
  resumeMission,
  pauseMission,
  clearMission,
  callAction,
  changeSpeed,
  setFlightMode,
  setTakeoffAltitude,
} from './api.js?v=20261020-1';

import { FLIGHT_CONFIG, FLIGHT_MODE_OPTIONS, LANDING_STATION_CONFIG, MAP_CONFIG, loadFlightSettings as loadSavedFlightSettings } from './config.js?v=20261029-5';

let map;
let vehicleMarkers = {};
let routeLayers;
let stationLayers;
let hasAutoFitted = false;
let uploadedRoutes = {};
let selectedRouteSegment = null;
let selectedSegmentLayer = null;
let routeRenderSignature = '';
let stationRenderSignature = '';
let flightSettings = {};

function loadFlightSettings() {
  try {
    flightSettings = loadSavedFlightSettings();
    if (!flightSettings || Array.isArray(flightSettings) || typeof flightSettings !== 'object') {
      flightSettings = {};
    }
  } catch {
    flightSettings = {};
  }
}

function settingsFor(uavId) {
  const saved = flightSettings[uavId];
  const settings = {
    altitudeM: Number.isFinite(saved?.altitudeM)
      && saved.altitudeM >= FLIGHT_CONFIG.minimumAltitudeM
      && saved.altitudeM <= FLIGHT_CONFIG.maximumAltitudeM
      ? saved.altitudeM
      : FLIGHT_CONFIG.defaultAltitudeM,
    speedMps: Number.isFinite(saved?.speedMps)
      && saved.speedMps >= FLIGHT_CONFIG.minimumSpeedMps
      && saved.speedMps <= FLIGHT_CONFIG.maximumSpeedMps
      ? saved.speedMps
      : FLIGHT_CONFIG.defaultSpeedMps,
  };
  flightSettings[uavId] = settings;
  return settings;
}

function saveFlightSettings() {
  try {
    localStorage.setItem(FLIGHT_CONFIG.settingsStorageKey, JSON.stringify(flightSettings));
    return true;
  } catch (error) {
    alert(`Could not save flight settings in this browser: ${error.message}`);
    return false;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

export function initMap() {
  loadFlightSettings();
  configureFlightInputs();
  onStateUpdate(handleUpdate);
  wireButtons();

  const mapStatus = document.getElementById('map-status');
  mapStatus.textContent = 'Loading map… live UAV data is available while the map loads.';

  loadLeafletAssets()
    .then(() => initializeLeafletMap(mapStatus))
    .catch(() => {
      mapStatus.hidden = false;
      mapStatus.textContent = 'Map library unavailable. Live UAV data remains active.';
    });
}

function configureFlightInputs() {
  const altitude = document.getElementById('target-altitude');
  altitude.min = FLIGHT_CONFIG.minimumAltitudeM;
  altitude.max = FLIGHT_CONFIG.maximumAltitudeM;
  altitude.step = FLIGHT_CONFIG.altitudeStepM;
  altitude.value = FLIGHT_CONFIG.defaultAltitudeM;

  const speed = document.getElementById('target-speed');
  speed.min = FLIGHT_CONFIG.minimumSpeedMps;
  speed.max = FLIGHT_CONFIG.maximumSpeedMps;
  speed.step = FLIGHT_CONFIG.speedStepMps;
  speed.value = FLIGHT_CONFIG.defaultSpeedMps;
}

function loadLeafletAssets() {
  if (window.L) return Promise.resolve();
  if (window.leafletLoadPromise) return window.leafletLoadPromise;

  for (const href of [
    'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  ]) {
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = href;
    document.head.append(stylesheet);
  }

  window.leafletLoadPromise = new Promise((resolve, reject) => {
    const sources = [
      'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js',
      'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
    ];
    const loadSource = (index) => {
      if (index === sources.length) {
        reject(new Error('Leaflet CDN unavailable'));
        return;
      }
      const script = document.createElement('script');
      const timeout = setTimeout(() => {
        script.remove();
        loadSource(index + 1);
      }, 7000);
      script.async = true;
      script.src = sources[index];
      script.onload = () => {
        clearTimeout(timeout);
        if (window.L) resolve();
        else loadSource(index + 1);
      };
      script.onerror = () => {
        clearTimeout(timeout);
        loadSource(index + 1);
      };
      document.head.append(script);
    };
    loadSource(0);
  });
  return window.leafletLoadPromise;
}

function initializeLeafletMap(mapStatus) {
  if (!window.L || map) {
    if (!window.L) {
    mapStatus.hidden = false;
      mapStatus.textContent = 'Leaflet failed to load. Live UAV data remains available.';
    }
    return;
  }
  map = L.map('map', { zoomControl: true, maxZoom: MAP_CONFIG.maximumZoom }).setView(MAP_CONFIG.initialCenter, MAP_CONFIG.initialZoom);
  L.marker(MAP_CONFIG.initialCenter)
    .addTo(map)
    .bindPopup('Ho Chi Minh City University of Technology (HCMUT)');

  const tileOptions = {
    maxZoom: MAP_CONFIG.maximumZoom,
    maxNativeZoom: MAP_CONFIG.maximumNativeZoom,
  };
  const satelliteTiles = L.tileLayer(MAP_CONFIG.tileUrl, {
    ...tileOptions,
    attribution: MAP_CONFIG.tileAttribution,
  });
  const streetTiles = L.tileLayer(MAP_CONFIG.streetTileUrl, {
    ...tileOptions,
    attribution: MAP_CONFIG.streetTileAttribution,
  });
  let tileLoaded = false;
  satelliteTiles.on('tileload', () => {
    tileLoaded = true;
    mapStatus.hidden = true;
  });
  satelliteTiles.on('tileerror', () => {
    if (!tileLoaded) {
      mapStatus.hidden = false;
      mapStatus.textContent = 'Map tiles unavailable. Live UAV data remains active.';
    }
  });
  satelliteTiles.addTo(map);
  L.control.layers(
    { Satellite: satelliteTiles, 'Street map': streetTiles },
    null,
    { position: 'topright', collapsed: true },
  ).addTo(map);
  routeLayers = L.layerGroup().addTo(map);
  stationLayers = L.layerGroup().addTo(map);

  map.on('click', (event) => {
    if (!state.activeUav) {
      alert('Select a UAV on the left before adding a waypoint.');
      return;
    }
    const route = state.draftRoutes[state.activeUav] ?? [];
    const settings = settingsFor(state.activeUav);
    route.push({
      lat: event.latlng.lat,
      lon: event.latlng.lng,
      alt: settings.altitudeM,
      speed_m_s: settings.speedMps,
    });
    state.draftRoutes[state.activeUav] = route;
    routeRenderSignature = '';
    renderMissionPlanning();
  });

  handleUpdate(state.vehicles);
}

function uavIcon(heading, connected) {
  const color = connected ? '#2dd4bf' : '#e5484d';
  const rotation = heading ?? 0;
  return L.divIcon({
    className: '',
    html: `<div style="transform: rotate(${rotation}deg); width:36px; height:36px; display:flex; align-items:center; justify-content:center;">
             <svg width="30" height="30" viewBox="0 0 24 24" fill="${color}"><path d="M12 2 L20 20 L12 16 L4 20 Z"/></svg>
           </div>`,
    iconSize: [40, 40],
    iconAnchor: [18, 18],
  });
}

function handleUpdate(vehicles) {
  renderUavList(vehicles);
  renderTelemetry(vehicles);
  if (!map || !window.L) {
    renderMissionPlanning();
    return;
  }
  renderVehiclePositions(vehicles);
  renderMissionPlanning();
  maybeAutoFit(vehicles);
}

function maybeAutoFit(vehicles) {
  if (!map || !window.L || hasAutoFitted) return;
  const withFix = vehicles.filter(hasValidGpsPosition);
  if (withFix.length === 0) return;
  const bounds = L.latLngBounds(withFix.map((vehicle) => [vehicle.lat, vehicle.lon]));
  map.fitBounds(bounds, { padding: [60, 60], maxZoom: 17 });
  hasAutoFitted = true;
}

function renderUavList(vehicles) {
  const element = document.getElementById('uav-list');
  element.innerHTML = vehicles.map((vehicle) => `
    <div class="uav-item ${state.activeUav === vehicle.uav_id ? 'active' : ''}" data-uav="${escapeHtml(vehicle.uav_id)}">
      <span class="dot ${vehicle.connected ? 'connected' : 'disconnected'}"></span>${escapeHtml(vehicle.uav_id)}
      <div class="mode">${escapeHtml(vehicle.flight_mode ?? '—')} · ${vehicle.armed ? 'ARMED' : 'DISARMED'}</div>
    </div>
  `).join('');
  element.querySelectorAll('.uav-item').forEach((row) => {
    row.addEventListener('click', () => selectUav(row.dataset.uav));
  });
  if (!state.activeUav && vehicles.length > 0) selectUav(vehicles[0].uav_id);
}

function selectUav(uavId) {
  state.activeUav = uavId;
  document.getElementById('active-uav-label').innerText = uavId;
  routeRenderSignature = '';
  renderUavList(state.vehicles);
  renderTelemetry(state.vehicles);
  renderMissionPlanning();
}

function renderTelemetry(vehicles) {
  const vehicle = vehicles.find((item) => item.uav_id === state.activeUav);
  if (!vehicle) return;
  document.getElementById('t-connected').innerText = vehicle.connected ? 'Connected' : 'Disconnected';
  document.getElementById('t-autopilot').innerText = vehicle.autopilot ?? 'Waiting for heartbeat';
  document.getElementById('t-mode').innerText = vehicle.flight_mode ?? '-';
  document.getElementById('t-ground-speed').innerText = Number.isFinite(vehicle.ground_speed_m_s)
    ? `${vehicle.ground_speed_m_s.toFixed(1)} m/s`
    : '-';
  renderFlightWarnings('flight-warnings', vehicle.flight_warnings);
  document.getElementById('t-armed').innerText = vehicle.armed ? 'ARMED' : 'DISARMED';
  document.getElementById('t-battery').innerText = vehicle.battery_percent ?? '-';
  document.getElementById('t-alt').innerText = vehicle.alt != null ? vehicle.alt.toFixed(1) : '-';
  document.getElementById('t-heading').innerText = vehicle.heading != null ? vehicle.heading.toFixed(0) : '-';
  document.getElementById('t-latlon').innerText = vehicle.lat != null && vehicle.lon != null
    ? `${vehicle.lat.toFixed(5)}, ${vehicle.lon.toFixed(5)}`
    : '-';
  document.getElementById('t-gps-fix').innerText = formatGpsFix(vehicle);
  const settings = settingsFor(vehicle.uav_id);
  const altitudeInput = document.getElementById('target-altitude');
  const speedInput = document.getElementById('target-speed');
  if (document.activeElement !== altitudeInput) altitudeInput.value = settings.altitudeM;
  if (document.activeElement !== speedInput) speedInput.value = settings.speedMps;

  const pitch = vehicle.pitch_deg;
  const roll = vehicle.roll_deg;
  const horizon = document.querySelector('.attitude-horizon');
  if (pitch != null && roll != null) {
    horizon.style.transform = `translateY(${Math.max(-30, Math.min(30, pitch)) * 1.2}px) rotate(${-roll}deg)`;
    document.getElementById('t-attitude').innerText = `Pitch / roll: ${pitch.toFixed(1)}° / ${roll.toFixed(1)}°`;
  } else {
    horizon.style.transform = 'none';
    document.getElementById('t-attitude').innerText = 'Pitch / roll: waiting for telemetry';
  }

  const verticalSpeed = vehicle.vertical_speed_m_s;
  let trend = 'HOLDING ALTITUDE';
  let trendClass = 'steady';
  if (verticalSpeed == null) {
    trend = 'WAITING FOR FLIGHT DATA';
    trendClass = 'unknown';
  } else if (verticalSpeed > FLIGHT_CONFIG.climbThresholdMps) {
    trend = 'CLIMBING';
    trendClass = 'climbing';
  } else if (verticalSpeed < -FLIGHT_CONFIG.climbThresholdMps) {
    trend = 'DESCENDING';
    trendClass = 'descending';
  } else if (vehicle.is_landed) {
    trend = 'ON GROUND';
    trendClass = 'steady';
  }
  const trendElement = document.getElementById('flight-trend');
  trendElement.innerText = trend;
  trendElement.className = trendClass;
  document.getElementById('t-vertical-speed').innerText = verticalSpeed == null
    ? 'Vertical speed: waiting for telemetry'
    : `Vertical speed: ${verticalSpeed >= 0 ? '+' : ''}${verticalSpeed.toFixed(2)} m/s`;

  renderModeCommands('flight-modes', vehicle);
}

function renderVehiclePositions(vehicles) {
  if (!map || !window.L) return;
  vehicles.forEach((vehicle) => {
    if (!hasValidGpsPosition(vehicle)) {
      vehicleMarkers[vehicle.uav_id]?.remove();
      delete vehicleMarkers[vehicle.uav_id];
      return;
    }
    const icon = uavIcon(vehicle.heading, vehicle.connected);
    if (!vehicleMarkers[vehicle.uav_id]) {
      vehicleMarkers[vehicle.uav_id] = L.marker([vehicle.lat, vehicle.lon], { icon, title: vehicle.uav_id })
        .addTo(map).bindTooltip(vehicle.uav_id, { permanent: true, direction: 'top', offset: [0, -21] });
    } else {
      vehicleMarkers[vehicle.uav_id].setLatLng([vehicle.lat, vehicle.lon]);
      vehicleMarkers[vehicle.uav_id].setIcon(icon);
    }
  });
}

function hasValidGpsPosition(vehicle) {
  return Number.isFinite(vehicle.lat)
    && Number.isFinite(vehicle.lon)
    && vehicle.lat >= -90 && vehicle.lat <= 90
    && vehicle.lon >= -180 && vehicle.lon <= 180
    && (vehicle.lat !== 0 || vehicle.lon !== 0);
}

function formatGpsFix(vehicle) {
  const labels = ['No GPS', 'No fix', '2D fix', '3D fix', 'DGPS', 'RTK float', 'RTK fixed'];
  const fixType = Number.isInteger(vehicle.gps_fix_type) ? vehicle.gps_fix_type : null;
  if (fixType == null) return vehicle.lat != null ? 'Position available' : 'Waiting for GPS';
  const label = labels[fixType] ?? `Fix type ${fixType}`;
  return vehicle.gps_satellites == null ? label : `${label} (${vehicle.gps_satellites} sats)`;
}

function routeWaypoints(vehicle) {
  return uploadedRoutes[vehicle.uav_id] ?? vehicle.waypoints ?? [];
}

function routePoints(waypoints) {
  return waypoints.map((waypoint) => ({
    lat: Number(waypoint.lat),
    lon: Number(waypoint.lon),
    alt: Number(waypoint.alt ?? MAP_CONFIG.defaultWaypointAltitudeM),
  }));
}

function formatDms(value, isLatitude) {
  const hemisphere = isLatitude ? (value < 0 ? 'S' : 'N') : (value < 0 ? 'W' : 'E');
  const absolute = Math.abs(value);
  const degrees = Math.floor(absolute);
  const minutesFloat = (absolute - degrees) * 60;
  const minutes = Math.floor(minutesFloat);
  const seconds = (minutesFloat - minutes) * 60;
  return `${degrees}\u00b0 ${minutes}' ${seconds.toFixed(1)}\" ${hemisphere}`;
}

function distanceMeters(first, second) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const dLat = radians(second.lat - first.lat);
  const dLon = radians(second.lon - first.lon);
  const lat1 = radians(first.lat);
  const lat2 = radians(second.lat);
  const haversine = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function segmentPopupContent(firstIndex, firstPoint, secondPoint) {
  return `
    <strong>WP ${firstIndex + 1}:</strong> ${formatDms(firstPoint.lat, true)}, ${formatDms(firstPoint.lon, false)}<br>
    <strong>WP ${firstIndex + 2}:</strong> ${formatDms(secondPoint.lat, true)}, ${formatDms(secondPoint.lon, false)}<br>
    <strong>Distance: ${distanceMeters(firstPoint, secondPoint).toFixed(1)} m</strong>`;
}

function routesForConflictCheck() {
  return state.vehicles.map((vehicle) => {
    const draft = state.draftRoutes[vehicle.uav_id] ?? [];
    const waypoints = draft.length ? draft : routeWaypoints(vehicle);
    return { uavId: vehicle.uav_id, points: routePoints(waypoints) };
  }).filter((route) => route.points.length > 0);
}

function getRouteSignature() {
  return JSON.stringify({
    activeUav: state.activeUav,
    routes: state.vehicles.map((vehicle) => ({
      uavId: vehicle.uav_id,
      uploaded: routeWaypoints(vehicle),
      draft: state.draftRoutes[vehicle.uav_id] ?? [],
    })),
  });
}

function renderMissionPlanning() {
  if (!map) return;
  const signature = getRouteSignature();
  if (signature !== routeRenderSignature) {
    routeRenderSignature = signature;
    renderRouteLayers();
    renderRouteList();
    renderCollisionAlerts();
  }
  renderWaypointList();
  const clearUploadedButton = document.getElementById('btn-clear-uploaded-mission');
  const activeVehicle = state.vehicles.find((vehicle) => vehicle.uav_id === state.activeUav);
  clearUploadedButton.disabled = !activeVehicle || routeWaypoints(activeVehicle).length === 0;
}

function renderRouteLayers() {
  routeLayers.clearLayers();
  state.vehicles.forEach((vehicle, index) => {
    const color = MAP_CONFIG.routeColors[index % MAP_CONFIG.routeColors.length];
    const uploaded = routeWaypoints(vehicle);
    const draft = state.draftRoutes[vehicle.uav_id] ?? [];
    const routes = [];
    if (uploaded.length) routes.push({ label: 'Uploaded', waypoints: uploaded, dashArray: null });
    if (draft.length) routes.push({ label: 'Draft', waypoints: draft, dashArray: '7 7' });

    routes.forEach((route) => {
      const points = routePoints(route.waypoints);
      if (points.length > 1) {
        const selectedRoute = selectedRouteSegment?.uavId === vehicle.uav_id
          && selectedRouteSegment?.routeLabel === route.label;
        points.slice(0, -1).forEach((firstPoint, segmentIndex) => {
          const secondPoint = points[segmentIndex + 1];
          const selected = selectedRoute && selectedRouteSegment.firstIndex === segmentIndex;
          const coordinates = [[firstPoint.lat, firstPoint.lon], [secondPoint.lat, secondPoint.lon]];
          const normalStyle = {
            color,
            weight: route.label === 'Draft' ? 3 : 4,
            opacity: route.label === 'Draft' ? 0.75 : 0.9,
            dashArray: route.dashArray,
          };
          const line = L.polyline(coordinates, {
            ...normalStyle,
            color: selected ? '#ffd166' : normalStyle.color,
            weight: selected ? 6 : normalStyle.weight,
            opacity: selected ? 1 : normalStyle.opacity,
            bubblingMouseEvents: false,
          });
          const popupContent = segmentPopupContent(segmentIndex, firstPoint, secondPoint);
          const selectSegment = (event) => {
            if (selectedSegmentLayer && selectedSegmentLayer !== line) {
              selectedSegmentLayer.layer.setStyle(selectedSegmentLayer.normalStyle);
            }
            selectedRouteSegment = { uavId: vehicle.uav_id, routeLabel: route.label, firstIndex: segmentIndex };
            selectedSegmentLayer = { layer: line, normalStyle };
            line.setStyle({ color: '#ffd166', weight: 6, opacity: 1 });
            L.popup()
              .setLatLng(event.latlng)
              .setContent(popupContent)
              .openOn(map);
          };
          line.on('click', selectSegment);
          routeLayers.addLayer(line);
          const hitTarget = L.polyline(coordinates, {
            color, weight: 18, opacity: 0.01, interactive: true, bubblingMouseEvents: false,
          });
          hitTarget.on('click', selectSegment);
          routeLayers.addLayer(hitTarget);
        });
      }

      route.waypoints.forEach((waypoint, waypointIndex) => {
        const marker = L.circleMarker([waypoint.lat, waypoint.lon], {
          radius: route.label === 'Draft' ? 5 : 4,
          color,
          fillColor: color,
          fillOpacity: 0.85,
          weight: 1,
          bubblingMouseEvents: false,
        });
        marker.bindPopup(
          `<strong>${escapeHtml(vehicle.uav_id)} ${route.label} &mdash; WP ${waypointIndex + 1}</strong><br>`
          + `Coordinates: ${formatDms(Number(waypoint.lat), true)}, ${formatDms(Number(waypoint.lon), false)}`,
        );
        routeLayers.addLayer(marker);
      });
    });
  });

  estimateRouteConflicts(routesForConflictCheck()).forEach((conflict) => {
    L.circleMarker([conflict.midpoint.lat, conflict.midpoint.lon], {
      radius: 9,
      color: '#e5484d',
      fillColor: '#e5484d',
      fillOpacity: 0.8,
      weight: 2,
      bubblingMouseEvents: false,
    }).bindPopup(
      `<strong>Potential route conflict</strong><br>${escapeHtml(conflict.firstUav)} / ${escapeHtml(conflict.secondUav)}`
      + `<br>Estimated risk: ${(conflict.probability * 100).toFixed(1)}%`
      + `<br>Horizontal clearance: ${conflict.horizontalDistance.toFixed(1)} m`
      + `<br>Vertical separation: ${conflict.verticalDistance.toFixed(1)} m`,
    ).addTo(routeLayers);
  });
}

function renderWaypointList() {
  const element = document.getElementById('wp-list');
  const waypoints = state.draftRoutes[state.activeUav] ?? [];
  element.innerHTML = waypoints.map((waypoint, index) =>
    `<div>#${index + 1}: ${waypoint.lat.toFixed(5)}, ${waypoint.lon.toFixed(5)} @${waypoint.alt}m</div>`,
  ).join('');
}

function renderRouteList() {
  const element = document.getElementById('route-list');
  element.innerHTML = state.vehicles.map((vehicle, index) => {
    const uploaded = routeWaypoints(vehicle);
    const draft = state.draftRoutes[vehicle.uav_id] ?? [];
    const waypoints = draft.length ? draft : uploaded;
    if (!waypoints.length) return '';
    const destination = waypoints[waypoints.length - 1];
    const routeType = draft.length ? 'Draft' : 'Uploaded';
    return `<button class="route-item ${state.activeUav === vehicle.uav_id ? 'active' : ''}" data-route-uav="${escapeHtml(vehicle.uav_id)}">
      <span class="route-color" style="background:${MAP_CONFIG.routeColors[index % MAP_CONFIG.routeColors.length]}"></span>
      <span><strong>${escapeHtml(vehicle.uav_id)} · ${routeType}</strong><small>${waypoints.length} waypoint(s) · destination ${destination.lat.toFixed(5)}, ${destination.lon.toFixed(5)}</small></span>
    </button>`;
  }).join('') || '<div class="hint">Uploaded and draft routes will appear here.</div>';

  element.querySelectorAll('[data-route-uav]').forEach((button) => {
    button.addEventListener('click', () => {
      const vehicle = state.vehicles.find((item) => item.uav_id === button.dataset.routeUav);
      if (!vehicle) return;
      selectUav(vehicle.uav_id);
      const draft = state.draftRoutes[vehicle.uav_id] ?? [];
      const waypoints = draft.length ? draft : routeWaypoints(vehicle);
      const points = routePoints(waypoints);
      if (points.length) map.fitBounds(L.latLngBounds(points.map((point) => [point.lat, point.lon])), { padding: [50, 50] });
      const destination = waypoints[waypoints.length - 1];
      if (destination) {
        L.popup()
          .setLatLng([destination.lat, destination.lon])
          .setContent(`<strong>${escapeHtml(vehicle.uav_id)} destination</strong><br>${destination.lat.toFixed(5)}, ${destination.lon.toFixed(5)} @ ${Number(destination.alt ?? MAP_CONFIG.defaultWaypointAltitudeM).toFixed(1)} m`)
          .openOn(map);
      }
    });
  });
}

function renderCollisionAlerts() {
  const element = document.getElementById('collision-alerts');
  const conflicts = estimateRouteConflicts(routesForConflictCheck());
  if (!conflicts.length) {
    element.innerHTML = '';
    return;
  }
  element.innerHTML = `<strong>Potential route conflicts</strong>
    ${conflicts.map((conflict) => `<div class="collision-item">
      ${escapeHtml(conflict.firstUav)} / ${escapeHtml(conflict.secondUav)}:
      ${(conflict.probability * 100).toFixed(1)}% estimated risk,
      ${conflict.horizontalDistance.toFixed(1)} m horizontal / ${conflict.verticalDistance.toFixed(1)} m vertical
    </div>`).join('')}
    <div class="collision-model-note">Estimated probability for simultaneous route operation, using ${COLLISION_MODEL.perVehicleHorizontalSigmaM.toFixed(1)} m horizontal and ${COLLISION_MODEL.perVehicleVerticalSigmaM.toFixed(1)} m vertical position uncertainty per UAV, with ${COLLISION_MODEL.horizontalProtectionM} m / ${COLLISION_MODEL.verticalProtectionM} m separation thresholds. This is not an operational collision-avoidance system.</div>`;
}

export function renderLandingStations(stations, vehicles = state.vehicles) {
  if (!map || !stationLayers) return;
  const signature = JSON.stringify(stations.map((station) => ({
    ...station,
    occupants: vehicles.filter((vehicle) =>
      vehicle.lat != null
      && vehicle.lon != null
      && map.distance([station.lat, station.lon], [vehicle.lat, vehicle.lon]) <= LANDING_STATION_CONFIG.occupancyRadiusM
      && (vehicle.is_landed === true || (
        String(vehicle.flight_mode ?? '').toUpperCase().includes('LAND')
        && vehicle.alt != null
        && vehicle.alt <= LANDING_STATION_CONFIG.landingAltitudeM
      )),
    ).map((vehicle) => `${vehicle.uav_id}:${vehicle.is_landed ? 'landed' : 'landing'}`),
  })));
  if (signature === stationRenderSignature) return;
  stationRenderSignature = signature;
  stationLayers.clearLayers();
  stations.forEach((station) => {
    const occupants = vehicles.filter((vehicle) =>
      vehicle.lat != null
      && vehicle.lon != null
      && map.distance([station.lat, station.lon], [vehicle.lat, vehicle.lon]) <= LANDING_STATION_CONFIG.occupancyRadiusM
      && (vehicle.is_landed === true || (
        String(vehicle.flight_mode ?? '').toUpperCase().includes('LAND')
        && vehicle.alt != null
        && vehicle.alt <= LANDING_STATION_CONFIG.landingAltitudeM
      )),
    );
    const occupancy = occupants.length
      ? occupants.map((vehicle) =>
        `${vehicle.is_landed ? 'Landed' : 'Landing'}: ${escapeHtml(vehicle.uav_id)}`,
      ).join(', ')
      : 'No UAV landed';
    L.circleMarker([station.lat, station.lon], {
      radius: 9,
      color: '#f5a524',
      fillColor: '#f5a524',
      fillOpacity: 0.85,
      weight: 2,
      bubblingMouseEvents: false,
    }).bindPopup(`<strong>${escapeHtml(station.name)}</strong><br>${occupancy}`)
      .addTo(stationLayers);
  });
}

function clearWaypoints() {
  if (!state.activeUav) return;
  state.draftRoutes[state.activeUav] = [];
  routeRenderSignature = '';
  renderMissionPlanning();
}

async function clearUploadedMission() {
  if (!state.activeUav) {
    alert('Select a UAV first.');
    return;
  }
  const vehicle = state.vehicles.find((item) => item.uav_id === state.activeUav);
  if (!vehicle || routeWaypoints(vehicle).length === 0) {
    alert('The selected UAV has no uploaded mission to clear.');
    return;
  }
  if (!confirm(`Clear the uploaded mission from ${state.activeUav}? Do not do this while the UAV is executing that mission.`)) return;

  const result = await clearMission(state.activeUav);
  if (!result.success) {
    alert(`Could not clear uploaded mission: ${result.message}`);
    return;
  }
  delete uploadedRoutes[state.activeUav];
  vehicle.waypoints = [];
  routeRenderSignature = '';
  renderMissionPlanning();
  alert(result.message);
}

function wireButtons() {
  document.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!state.activeUav) {
        alert('Select a UAV first.');
        return;
      }
      const actionParams = button.dataset.action === 'takeoff'
        ? { altitude: settingsFor(state.activeUav).altitudeM }
        : {};
      const result = await callAction(state.activeUav, button.dataset.action, actionParams);
      if (!result.success) alert(`Error: ${result.message}`);
    });
  });
  document.getElementById('target-speed').addEventListener('change', (event) => {
    updateFlightSetting(
      'speedMps', Number(event.target.value),
      FLIGHT_CONFIG.minimumSpeedMps, FLIGHT_CONFIG.maximumSpeedMps,
    );
  });
  document.getElementById('btn-save-takeoff-target').addEventListener('click', async () => {
    if (!state.activeUav) {
      alert('Select a UAV first.');
      return;
    }
    const altitude = Number(document.getElementById('target-altitude').value);
    if (!Number.isFinite(altitude)
      || altitude < FLIGHT_CONFIG.minimumAltitudeM
      || altitude > FLIGHT_CONFIG.maximumAltitudeM) {
      alert(`Enter a takeoff target between ${FLIGHT_CONFIG.minimumAltitudeM} and ${FLIGHT_CONFIG.maximumAltitudeM} m.`);
      renderTelemetry(state.vehicles);
      return;
    }
    const status = document.getElementById('map-takeoff-target-status');
    status.textContent = `Sending ${altitude} m takeoff target to ${state.activeUav}...`;
    const result = await setTakeoffAltitude(state.activeUav, altitude);
    if (!result.success) {
      status.textContent = `Autopilot did not confirm ${altitude} m: ${result.message}`;
      return;
    }
    const saved = updateFlightSetting(
      'altitudeM', altitude,
      FLIGHT_CONFIG.minimumAltitudeM, FLIGHT_CONFIG.maximumAltitudeM,
    );
    if (!saved) {
      status.textContent = `Autopilot confirmed ${altitude} m for ${state.activeUav}, but the browser could not save it.`;
      return;
    }
    status.textContent = result.message || `Autopilot confirmed takeoff target: ${altitude} m for ${state.activeUav}.`;
  });
  document.getElementById('btn-change-speed').addEventListener('click', async () => {
    if (!state.activeUav) {
      alert('Select a UAV first.');
      return;
    }
    const speed = settingsFor(state.activeUav).speedMps;
    if (!confirm(`Save target flight speed ${speed} m/s for ${state.activeUav}?`)) return;
    const result = await changeSpeed(state.activeUav, speed);
    if (!result.success) alert(`Speed change failed: ${result.message}`);
    else alert(result.message);
  });
  document.getElementById('btn-auto-mission').addEventListener('click', startSelectedMission);
  document.getElementById('flight-modes').addEventListener('click', (event) => {
    const button = event.target.closest('[data-flight-mode]');
    if (button && state.activeUav) changeFlightMode(state.activeUav, button.dataset.flightMode);
  });
  document.getElementById('btn-loiter').addEventListener('click', async () => {
    if (!state.activeUav) {
      alert('Select a UAV first.');
      return;
    }
    const result = await setFlightMode(state.activeUav, 'LOITER');
    if (!result.success) alert(`Loiter command failed: ${result.message}`);
  });
  document.getElementById('btn-pause-mission').addEventListener('click', async () => {
    if (!state.activeUav) {
      alert('Select a UAV first.');
      return;
    }
    const result = await pauseMission(state.activeUav);
    if (!result.success) alert(`Pause mission failed: ${result.message}`);
  });
  document.getElementById('btn-resume-mission').addEventListener('click', resumeSelectedMission);
  document.getElementById('btn-abort-landing').addEventListener('click', async () => {
    if (!state.activeUav) {
      alert('Select a UAV first.');
      return;
    }
    if (!confirm(`Abort landing for ${state.activeUav} by commanding Return to Launch (RTL)?`)) return;
    const result = await callAction(state.activeUav, 'rtl');
    if (!result.success) alert(`Abort landing failed: ${result.message}`);
  });
  document.getElementById('btn-upload-mission').addEventListener('click', async () => {
    if (!state.activeUav) {
      alert('Select a UAV first.');
      return;
    }
    const waypoints = state.draftRoutes[state.activeUav] ?? [];
    if (waypoints.length === 0) {
      alert('No draft waypoints for the selected UAV.');
      return;
    }

    const selectedConflicts = estimateRouteConflicts(routesForConflictCheck())
      .filter((conflict) => conflict.firstUav === state.activeUav || conflict.secondUav === state.activeUav);
    if (selectedConflicts.length) {
      const summary = selectedConflicts.map((conflict) =>
        `${conflict.firstUav} / ${conflict.secondUav}: ${(conflict.probability * 100).toFixed(1)}%`,
      ).join('\n');
      const confirmed = confirm(
        `Potential collision risk detected:\n${summary}\n\nUpload anyway? Check route separation and altitude before proceeding.`,
      );
      if (!confirmed) return;
    }

    const targetSpeed = settingsFor(state.activeUav).speedMps;
    const missionWaypoints = waypoints.map((waypoint) => ({ ...waypoint, speed_m_s: targetSpeed }));
    const result = await uploadMission(state.activeUav, missionWaypoints);
    if (!result.success) {
      alert(`Mission upload failed: ${result.message}`);
      return;
    }
    uploadedRoutes[state.activeUav] = missionWaypoints.map((waypoint) => ({ ...waypoint }));
    state.draftRoutes[state.activeUav] = [];
    routeRenderSignature = '';
    renderMissionPlanning();
    alert(result.message);
  });
  document.getElementById('btn-clear-waypoints').addEventListener('click', clearWaypoints);
  document.getElementById('btn-clear-uploaded-mission').addEventListener('click', clearUploadedMission);
  document.getElementById('btn-start-mission').addEventListener('click', async () => {
    await startSelectedMission();
  });
}

function updateFlightSetting(key, value, min, max) {
  if (!state.activeUav) {
    alert('Select a UAV first.');
    return;
  }
  if (!Number.isFinite(value) || value < min || value > max) {
    alert(`Enter a value between ${min} and ${max}.`);
    renderTelemetry(state.vehicles);
    return;
  }
  const settings = settingsFor(state.activeUav);
  const previous = settings[key];
  settings[key] = value;
  if (!saveFlightSettings()) {
    settings[key] = previous;
    return false;
  }
  return true;
}

async function startSelectedMission() {
  if (!state.activeUav) {
    alert('Select a UAV first.');
    return;
  }
  const result = await startMission(state.activeUav);
  if (!result.success) alert(`Mission start failed: ${result.message}`);
  // else alert(result.message);
}

async function resumeSelectedMission() {
  if (!state.activeUav) {
    alert('Select a UAV first.');
    return;
  }
  const result = await resumeMission(state.activeUav);
  if (!result.success) alert(`Mission resume failed: ${result.message}`);
  else alert(result.message);
}

function isModeActive(mode, activeMode) {
  if (mode === 'AUTO' && activeMode === 'MISSION') return true;
  if (mode === 'STABILIZE' && activeMode === 'STABILIZED') return true;
  if (mode === 'ALT_HOLD' && activeMode === 'HOLD') return true;
  return mode === activeMode;
}

function renderModeCommands(elementId, vehicle) {
  const element = document.getElementById(elementId);
  const modes = vehicle.autopilot === 'PX4'
    ? FLIGHT_MODE_OPTIONS.px4
    : vehicle.autopilot === 'ArduPilot'
      ? FLIGHT_MODE_OPTIONS.arducopter
      : [];
  if (!modes.length) {
    element.innerHTML = '<span class="mode-hint">Waiting for autopilot heartbeat</span>';
    return;
  }
  const activeMode = String(vehicle.flight_mode ?? '').toUpperCase().split('.').pop();
  element.innerHTML = modes.map((mode) => {
    const label = vehicle.autopilot === 'ArduPilot' && mode === 'ALT_HOLD'
      ? 'HOLD'
      : vehicle.autopilot === 'PX4' && mode === 'HOLD'
        ? 'HOLD / LOITER'
        : mode;
    const title = vehicle.autopilot === 'PX4' && mode === 'HOLD'
      ? 'PX4 Hold is the position-hold action; the Loiter button uses this same mode'
      : `Set ${label}`;
    return `<button type="button" class="mode-chip ${isModeActive(mode, activeMode) ? 'active' : ''}" data-flight-mode="${mode}" title="${title}">${label}</button>`;
  }).join('');
}

async function changeFlightMode(uavId, mode) {
  const result = await setFlightMode(uavId, mode);
  if (!result.success) alert(`${mode} mode failed for ${uavId}: ${result.message}`);
}

function renderFlightWarnings(elementId, warnings = []) {
  const element = document.getElementById(elementId);
  element.innerHTML = (warnings ?? []).map((warning) =>
    `<div class="flight-warning">${escapeHtml(warning)}</div>`,
  ).join('');
}
