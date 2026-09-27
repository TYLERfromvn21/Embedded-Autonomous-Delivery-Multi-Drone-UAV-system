// fleet-view.js — the Fleet tab: a table of every UAV with its position,
// camera link (if the vehicle exposes one) and current uploaded route.

import { onStateUpdate } from './state.js';

export function initFleetView() {
  onStateUpdate(render);
}

function render(vehicles) {
  const tbody = document.getElementById('fleet-tbody');
  tbody.innerHTML = vehicles.map((v) => `
    <tr>
      <td>${v.uav_id}</td>
      <td><span class="badge ${v.connected ? 'connected' : 'disconnected'}">${v.connected ? 'connected' : 'offline'}</span></td>
      <td class="mono">${v.flight_mode ?? '—'}</td>
      <td class="mono">${v.lat != null ? v.lat.toFixed(5) + ', ' + v.lon.toFixed(5) : '—'}</td>
      <td class="mono">${v.alt != null ? v.alt.toFixed(1) + ' m' : '—'}</td>
      <td class="mono">${v.battery_percent != null ? v.battery_percent + '%' : '—'}</td>
      <td>${v.camera_url ? `<a class="cam-link" href="${v.camera_url}" target="_blank">open stream</a>` : '<span class="no-cam">not configured</span>'}</td>
      <td class="mono">${v.waypoints && v.waypoints.length ? `${v.waypoints.length} waypoint(s)` : '—'}</td>
    </tr>
  `).join('');
}
