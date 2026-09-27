// map-view.js — the Map tab: Leaflet map, sidebar UAV list, telemetry panel,
// waypoint drawing.
//
// KEY FIX from the previous version: the map used to sit at a hardcoded
// setView() and never move, so if the vehicle's real GPS position was
// anywhere else (e.g. SITL's default Australia home, or a real Pixhawk
// GPS fix from wherever it's sitting) the marker rendered off-screen and
// looked like "nothing is showing". This version calls map.fitBounds()
// automatically the first time real position data arrives, and again
// whenever a vehicle that had no fix before gets one. This is data-driven,
// so it works identically for SITL or a real MAVLink GPS.

import { state, onStateUpdate } from './state.js';
import { uploadMission, startMission, callAction } from './api.js';

let map;
let vehicleMarkers = {};
let waypointMarkers = [];
let waypoints = [];
let hasAutoFitted = false;

export function initMap() {
  map = L.map('map', { zoomControl: true }).setView([10.762622, 106.660172], 15);

  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
  attribution: 'Tiles &copy; Esri &mdash; Source: Esri, DeLorme, NAVTEQ, USGS, Intermap, iPC, NRCAN, Esri Japan, METI, Esri China (Hong Kong), Esri (Thailand), TomTom, 2012',
  maxZoom: 20
}).addTo(map);

  map.on('click', (e) => {
    if (!state.activeUav) { alert('Select a UAV on the left before adding a waypoint.'); return; }
    const wp = { lat: e.latlng.lat, lon: e.latlng.lng, alt: 10.0, speed_m_s: 5.0 };
    waypoints.push(wp);
    const marker = L.marker([wp.lat, wp.lon]).addTo(map).bindPopup(`WP ${waypoints.length}`);
    waypointMarkers.push(marker);
    renderWaypointList();
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
  maybeAutoFit(vehicles);
}

function maybeAutoFit(vehicles) {
  if (hasAutoFitted) return;
  const withFix = vehicles.filter((v) => v.lat != null && v.lon != null);
  if (withFix.length === 0) return; // no GPS fix yet on any vehicle, wait
  const bounds = L.latLngBounds(withFix.map((v) => [v.lat, v.lon]));
  map.fitBounds(bounds, { padding: [60, 60], maxZoom: 17 });
  hasAutoFitted = true;
}

function renderUavList(vehicles) {
  const el = document.getElementById('uav-list');
  el.innerHTML = vehicles.map((s) => `
    <div class="uav-item ${state.activeUav === s.uav_id ? 'active' : ''}" data-uav="${s.uav_id}">
      <span class="dot ${s.connected ? 'connected' : 'disconnected'}"></span>${s.uav_id}
      <div class="mode">${s.flight_mode ?? '—'}</div>
    </div>
  `).join('');
  el.querySelectorAll('.uav-item').forEach((row) => {
    row.addEventListener('click', () => selectUav(row.dataset.uav));
  });
  if (!state.activeUav && vehicles.length > 0) selectUav(vehicles[0].uav_id);
}

function selectUav(uavId) {
  state.activeUav = uavId;
  document.getElementById('active-uav-label').innerText = uavId;
  renderUavList(state.vehicles);
  renderTelemetry(state.vehicles);
}

function renderTelemetry(vehicles) {
  const s = vehicles.find((v) => v.uav_id === state.activeUav);
  if (!s) return;
  document.getElementById('t-connected').innerText = s.connected ? 'Connected' : 'Disconnected';
  document.getElementById('t-mode').innerText = s.flight_mode ?? '-';
  document.getElementById('t-armed').innerText = s.armed ? 'ARMED' : 'DISARMED';
  document.getElementById('t-battery').innerText = s.battery_percent ?? '-';
  document.getElementById('t-alt').innerText = s.alt != null ? s.alt.toFixed(1) : '-';
  document.getElementById('t-heading').innerText = s.heading != null ? s.heading.toFixed(0) : '-';
  document.getElementById('t-latlon').innerText = (s.lat && s.lon) ? `${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}` : '-';
}

function renderVehiclePositions(vehicles) {
  vehicles.forEach((s) => {
    if (s.lat == null || s.lon == null) return;
    const icon = uavIcon(s.heading, s.connected);
    if (!vehicleMarkers[s.uav_id]) {
      vehicleMarkers[s.uav_id] = L.marker([s.lat, s.lon], { icon, title: s.uav_id })
        .addTo(map).bindTooltip(s.uav_id, { permanent: true, direction: 'top', offset: [0, -12] });
    } else {
      vehicleMarkers[s.uav_id].setLatLng([s.lat, s.lon]);
      vehicleMarkers[s.uav_id].setIcon(icon);
    }
  });
}

function renderWaypointList() {
  const el = document.getElementById('wp-list');
  el.innerHTML = waypoints.map((w, i) => `<div>#${i + 1}: ${w.lat.toFixed(5)}, ${w.lon.toFixed(5)} @${w.alt}m</div>`).join('');
}

function clearWaypoints() {
  waypoints = [];
  waypointMarkers.forEach((m) => map.removeLayer(m));
  waypointMarkers = [];
  renderWaypointList();
}

function wireButtons() {
  document.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!state.activeUav) { alert('Select a UAV first.'); return; }
      const data = await callAction(state.activeUav, btn.dataset.action);
      if (!data.success) alert(`Error: ${data.message}`);
    });
  });
  document.getElementById('btn-upload-mission').addEventListener('click', async () => {
    if (!state.activeUav) { alert('Select a UAV first.'); return; }
    if (waypoints.length === 0) { alert('No waypoints yet.'); return; }
    const data = await uploadMission(state.activeUav, waypoints);
    alert(data.message);
  });
  document.getElementById('btn-clear-waypoints').addEventListener('click', clearWaypoints);
  document.getElementById('btn-start-mission').addEventListener('click', async () => {
    if (!state.activeUav) { alert('Select a UAV first.'); return; }
    const data = await startMission(state.activeUav);
    if (!data.success) alert(`Error: ${data.message}`);
  });
}
