import { state, onStateUpdate } from './state.js';
import { estimateRouteConflicts, COLLISION_MODEL } from './collision-check.js';
import {
  uploadMission,
  startMission,
  pauseMission,
  clearMission,
  callAction,
  changeAltitude,
  changeSpeed,
} from './api.js';

const HCMUT_CENTER = [10.7721, 106.6578];
const DEFAULT_ALTITUDE_M = 5;
const DEFAULT_SPEED_M_S = 5;
const FLIGHT_SETTINGS_KEY = 'uav-web-gcs.flight-settings.v1';
const ARDUCOPTER_MODES = [
  'STABILIZE', 'ACRO', 'ALT_HOLD', 'AUTO', 'GUIDED', 'LOITER', 'RTL', 'CIRCLE',
  'LAND', 'DRIFT', 'SPORT', 'FLIP', 'AUTOTUNE', 'POSHOLD', 'BRAKE', 'THROW',
  'AVOID_ADSB', 'GUIDED_NOGPS', 'SMART_RTL', 'FLOWHOLD', 'FOLLOW', 'ZIGZAG',
  'SYSTEMID', 'AUTOROTATE', 'TURTLE', 'QSTABILIZE', 'QHOVER', 'QLOITER',
  'QLAND', 'QRTL', 'QAUTOTUNE', 'QACRO',
];
const ROUTE_COLORS = ['#2dd4bf', '#f5a524', '#8b8df7', '#f477a8', '#56a8ff', '#a3d977'];
const CLIMB_THRESHOLD_M_S = 0.2;

let map;
let vehicleMarkers = {};
let routeLayers;
let stationLayers;
let hasAutoFitted = false;
let uploadedRoutes = {};
let routeRenderSignature = '';
let stationRenderSignature = '';
let flightSettings = {};

function loadFlightSettings() {
  try {
    const saved = localStorage.getItem(FLIGHT_SETTINGS_KEY);
    flightSettings = saved ? JSON.parse(saved) : {};
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
    altitudeM: Number.isFinite(saved?.altitudeM) && saved.altitudeM >= 1 && saved.altitudeM <= 120
      ? saved.altitudeM
      : DEFAULT_ALTITUDE_M,
    speedMps: Number.isFinite(saved?.speedMps) && saved.speedMps >= 0.5 && saved.speedMps <= 30
      ? saved.speedMps
      : DEFAULT_SPEED_M_S,
  };
  flightSettings[uavId] = settings;
  return settings;
}

function saveFlightSettings() {
  try {
    localStorage.setItem(FLIGHT_SETTINGS_KEY, JSON.stringify(flightSettings));
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
  map = L.map('map', { zoomControl: true }).setView(HCMUT_CENTER, 16);
  L.marker(HCMUT_CENTER)
    .addTo(map)
    .bindPopup('Ho Chi Minh City University of Technology (HCMUT)');

  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles &copy; Esri &mdash; Source: Esri, DeLorme, NAVTEQ, USGS, Intermap, iPC, NRCAN, Esri Japan, METI, Esri China (Hong Kong), Esri (Thailand), TomTom, 2012',
    maxZoom: 20,
  }).addTo(map);
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

  onStateUpdate(handleUpdate);
  wireButtons();
}

function uavIcon(heading, connected) {
  const color = connected ? '#2dd4bf' : '#e5484d';
  const rotation = heading ?? 0;
  return L.divIcon({
    className: '',
    html: `<div style="transform: rotate(${rotation}deg); width:22px; height:22px; display:flex; align-items:center; justify-content:center;">
             <svg width="18" height="18" viewBox="0 0 24 24" fill="${color}"><path d="M12 2 L20 20 L12 16 L4 20 Z"/></svg>
           </div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

function handleUpdate(vehicles) {
  renderUavList(vehicles);
  renderTelemetry(vehicles);
  renderVehiclePositions(vehicles);
  renderMissionPlanning();
  maybeAutoFit(vehicles);
}

function maybeAutoFit(vehicles) {
  if (hasAutoFitted) return;
  const withFix = vehicles.filter((vehicle) => vehicle.lat != null && vehicle.lon != null);
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
  document.getElementById('t-mode').innerText = vehicle.flight_mode ?? '-';
  document.getElementById('t-armed').innerText = vehicle.armed ? 'ARMED' : 'DISARMED';
  document.getElementById('t-battery').innerText = vehicle.battery_percent ?? '-';
  document.getElementById('t-alt').innerText = vehicle.alt != null ? vehicle.alt.toFixed(1) : '-';
  document.getElementById('t-heading').innerText = vehicle.heading != null ? vehicle.heading.toFixed(0) : '-';
  document.getElementById('t-latlon').innerText = vehicle.lat != null && vehicle.lon != null
    ? `${vehicle.lat.toFixed(5)}, ${vehicle.lon.toFixed(5)}`
    : '-';
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
  } else if (verticalSpeed > CLIMB_THRESHOLD_M_S) {
    trend = 'CLIMBING';
    trendClass = 'climbing';
  } else if (verticalSpeed < -CLIMB_THRESHOLD_M_S) {
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

  const activeMode = String(vehicle.flight_mode ?? '').toUpperCase().split('.').pop();
  document.getElementById('flight-modes').innerHTML = ARDUCOPTER_MODES.map((mode) =>
    `<span class="mode-chip ${mode === activeMode ? 'active' : ''}">${mode}</span>`,
  ).join('');
}

function renderVehiclePositions(vehicles) {
  vehicles.forEach((vehicle) => {
    if (vehicle.lat == null || vehicle.lon == null) return;
    const icon = uavIcon(vehicle.heading, vehicle.connected);
    if (!vehicleMarkers[vehicle.uav_id]) {
      vehicleMarkers[vehicle.uav_id] = L.marker([vehicle.lat, vehicle.lon], { icon, title: vehicle.uav_id })
        .addTo(map).bindTooltip(vehicle.uav_id, { permanent: true, direction: 'top', offset: [0, -12] });
    } else {
      vehicleMarkers[vehicle.uav_id].setLatLng([vehicle.lat, vehicle.lon]);
      vehicleMarkers[vehicle.uav_id].setIcon(icon);
    }
  });
}

function routeWaypoints(vehicle) {
  return uploadedRoutes[vehicle.uav_id] ?? vehicle.waypoints ?? [];
}

function routePoints(waypoints) {
  return waypoints.map((waypoint) => ({
    lat: Number(waypoint.lat),
    lon: Number(waypoint.lon),
    alt: Number(waypoint.alt ?? 10),
  }));
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
    const color = ROUTE_COLORS[index % ROUTE_COLORS.length];
    const uploaded = routeWaypoints(vehicle);
    const draft = state.draftRoutes[vehicle.uav_id] ?? [];
    const routes = [];
    if (uploaded.length) routes.push({ label: 'Uploaded', waypoints: uploaded, dashArray: null });
    if (draft.length) routes.push({ label: 'Draft', waypoints: draft, dashArray: '7 7' });

    routes.forEach((route) => {
      const points = routePoints(route.waypoints);
      if (points.length > 1) {
        const line = L.polyline(points.map((point) => [point.lat, point.lon]), {
          color,
          weight: route.label === 'Draft' ? 3 : 4,
          opacity: route.label === 'Draft' ? 0.75 : 0.9,
          dashArray: route.dashArray,
          bubblingMouseEvents: false,
        });
        const destination = route.waypoints[route.waypoints.length - 1];
        const waypointDetails = route.waypoints.map((point, waypointIndex) =>
          `WP ${waypointIndex + 1}: ${point.lat.toFixed(5)}, ${point.lon.toFixed(5)} @ ${Number(point.alt ?? 10).toFixed(1)} m`,
        ).join('<br>');
        line.bindPopup(
          `<strong>${escapeHtml(vehicle.uav_id)} — ${route.label} route</strong><br>`
          + `Destination: ${destination.lat.toFixed(5)}, ${destination.lon.toFixed(5)}<br>${waypointDetails}`,
        );
        routeLayers.addLayer(line);
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
          `<strong>${escapeHtml(vehicle.uav_id)} ${route.label} — WP ${waypointIndex + 1}</strong><br>`
          + `Destination: ${waypoint.lat.toFixed(5)}, ${waypoint.lon.toFixed(5)}<br>`
          + `Altitude: ${Number(waypoint.alt ?? 10).toFixed(1)} m`,
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
      <span class="route-color" style="background:${ROUTE_COLORS[index % ROUTE_COLORS.length]}"></span>
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
          .setContent(`<strong>${escapeHtml(vehicle.uav_id)} destination</strong><br>${destination.lat.toFixed(5)}, ${destination.lon.toFixed(5)} @ ${Number(destination.alt ?? 10).toFixed(1)} m`)
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
      && map.distance([station.lat, station.lon], [vehicle.lat, vehicle.lon]) <= 15
      && (vehicle.is_landed === true || (
        String(vehicle.flight_mode ?? '').toUpperCase().includes('LAND')
        && vehicle.alt != null
        && vehicle.alt <= 10
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
      && map.distance([station.lat, station.lon], [vehicle.lat, vehicle.lon]) <= 15
      && (vehicle.is_landed === true || (
        String(vehicle.flight_mode ?? '').toUpperCase().includes('LAND')
        && vehicle.alt != null
        && vehicle.alt <= 10
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
  document.getElementById('target-altitude').addEventListener('change', (event) => {
    updateFlightSetting('altitudeM', Number(event.target.value), 1, 120);
  });
  document.getElementById('target-speed').addEventListener('change', (event) => {
    updateFlightSetting('speedMps', Number(event.target.value), 0.5, 30);
  });
  document.getElementById('btn-change-altitude').addEventListener('click', async () => {
    if (!state.activeUav) {
      alert('Select a UAV first.');
      return;
    }
    const altitude = settingsFor(state.activeUav).altitudeM;
    if (!confirm(`Command ${state.activeUav} to change altitude to ${altitude} m? The UAV must be armed and in GUIDED mode.`)) return;
    const result = await changeAltitude(state.activeUav, altitude);
    if (!result.success) alert(`Altitude change failed: ${result.message}`);
    else alert(result.message);
  });
  document.getElementById('btn-change-speed').addEventListener('click', async () => {
    if (!state.activeUav) {
      alert('Select a UAV first.');
      return;
    }
    const speed = settingsFor(state.activeUav).speedMps;
    if (!confirm(`Command ${state.activeUav} to change flight speed to ${speed} m/s?`)) return;
    const result = await changeSpeed(state.activeUav, speed);
    if (!result.success) alert(`Speed change failed: ${result.message}`);
    else alert(result.message);
  });
  document.getElementById('btn-auto-mission').addEventListener('click', startSelectedMission);
  document.getElementById('btn-loiter').addEventListener('click', async () => {
    if (!state.activeUav) {
      alert('Select a UAV first.');
      return;
    }
    const result = await callAction(state.activeUav, 'hold');
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
  document.getElementById('btn-resume-mission').addEventListener('click', startSelectedMission);
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

    const result = await uploadMission(state.activeUav, waypoints);
    if (!result.success) {
      alert(`Mission upload failed: ${result.message}`);
      return;
    }
    uploadedRoutes[state.activeUav] = waypoints.map((waypoint) => ({ ...waypoint }));
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
  if (!saveFlightSettings()) settings[key] = previous;
}

async function startSelectedMission() {
  if (!state.activeUav) {
    alert('Select a UAV first.');
    return;
  }
  const result = await startMission(state.activeUav);
  if (!result.success) alert(`Mission start failed: ${result.message}`);
}
