import { onStateUpdate } from './state.js';
import { renderLandingStations } from './map-view.js';

const STORAGE_KEY = 'uav-web-gcs.landing-stations.v1';
const OCCUPANCY_RADIUS_M = 15;
const LANDING_ALTITUDE_M = 10;
let stations = [];
let latestVehicles = [];

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function distanceMeters(first, second) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const latitudeDelta = radians(second.lat - first.lat);
  const longitudeDelta = radians(second.lon - first.lon);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(first.lat)) * Math.cos(radians(second.lat))
    * Math.sin(longitudeDelta / 2) ** 2;
  const boundedA = Math.max(0, Math.min(1, a));
  return 6371000 * 2 * Math.atan2(Math.sqrt(boundedA), Math.sqrt(1 - boundedA));
}

function readStations() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return [];
    const parsed = JSON.parse(saved);
    if (!Array.isArray(parsed)) throw new Error('Saved station data must be a list.');
    const valid = parsed.every((station) =>
      typeof station.id === 'string'
      && typeof station.name === 'string'
      && Number.isFinite(station.lat)
      && Number.isFinite(station.lon),
    );
    if (!valid) throw new Error('Saved station data contains an invalid station.');
    return parsed;
  } catch (error) {
    document.getElementById('station-message').textContent =
      `Could not load saved stations: ${error.message}`;
    return [];
  }
}

function saveStations() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stations));
    document.getElementById('station-message').textContent =
      'Station list saved in this browser. Hardware integration is not connected yet.';
    return true;
  } catch (error) {
    document.getElementById('station-message').textContent =
      `Could not save stations: ${error.message}`;
    return false;
  }
}

function occupantsFor(station, vehicles) {
  return vehicles.filter((vehicle) => {
    const inStationArea = vehicle.lat != null
      && vehicle.lon != null
      && distanceMeters(station, vehicle) <= OCCUPANCY_RADIUS_M;
    const landingMode = String(vehicle.flight_mode ?? '').toUpperCase().includes('LAND');
    return inStationArea && (
      vehicle.is_landed === true
      || (landingMode && vehicle.alt != null && vehicle.alt <= LANDING_ALTITUDE_M)
    );
  });
}

function render(vehicles) {
  const list = document.getElementById('station-list');
  list.innerHTML = stations.map((station) => {
    const occupants = occupantsFor(station, vehicles);
    const occupancy = occupants.length
      ? occupants.map((vehicle) =>
        `${vehicle.is_landed ? 'Landed' : 'Landing'}: ${escapeHtml(vehicle.uav_id)}`,
      ).join(', ')
      : 'No UAV landed';
    const device = station.deviceId
      ? escapeHtml(station.deviceId)
      : 'Not registered';
    return `
      <article class="station-card">
        <div class="station-card-heading">
          <div>
            <h3>${escapeHtml(station.name)}</h3>
            <span class="station-device">Device: ${device}</span>
          </div>
          <button class="act danger station-remove" type="button" data-station-id="${escapeHtml(station.id)}">Remove</button>
        </div>
        <div class="station-detail">Location <span>${station.lat.toFixed(6)}, ${station.lon.toFixed(6)}</span></div>
        <div class="station-detail">Occupancy <span class="${occupants.length ? 'occupied' : 'available'}">${occupancy}</span></div>
        <div class="station-detail">Device connection <span class="station-pending">Not connected</span></div>
      </article>`;
  }).join('') || '<div class="hint">No landing stations configured yet.</div>';

  list.querySelectorAll('[data-station-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const previousStations = stations;
      stations = stations.filter((station) => station.id !== button.dataset.stationId);
      if (!saveStations()) {
        stations = previousStations;
        render(vehicles);
        return;
      }
      render(vehicles);
    });
  });
  renderLandingStations(stations, vehicles);
}

function wireForm() {
  const form = document.getElementById('station-form');
  document.getElementById('btn-add-station').addEventListener('click', () => {
    form.hidden = !form.hidden;
    if (!form.hidden) form.elements.name.focus();
  });
  document.getElementById('btn-cancel-station').addEventListener('click', () => {
    form.reset();
    form.hidden = true;
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const name = String(formData.get('name')).trim();
    const lat = Number(formData.get('lat'));
    const lon = Number(formData.get('lon'));
    const deviceId = String(formData.get('deviceId')).trim();
    if (!name || !Number.isFinite(lat) || lat < -90 || lat > 90
      || !Number.isFinite(lon) || lon < -180 || lon > 180) {
      document.getElementById('station-message').textContent =
        'Enter a station name and valid latitude/longitude coordinates.';
      return;
    }

    stations.push({
      id: crypto.randomUUID(),
      name,
      lat,
      lon,
      deviceId,
    });
    if (!saveStations()) {
      stations.pop();
      return;
    }
    form.reset();
    form.hidden = true;
    render(latestVehicles);
  });
}

export function initStationsView() {
  stations = readStations();
  wireForm();
  onStateUpdate((vehicles) => {
    latestVehicles = vehicles;
    render(vehicles);
  });
}
