import { state, onStateUpdate } from './state.js';
import {
  callBatchAction,
  callAction,
  changeAltitude,
  changeSpeed,
  pauseMission,
  startMission,
} from './api.js';

const FLIGHT_SETTINGS_KEY = 'uav-web-gcs.flight-settings.v1';
const DEFAULT_ALTITUDE_M = 5;
const DEFAULT_SPEED_M_S = 5;
const CLIMB_THRESHOLD_M_S = 0.2;
const ARDUCOPTER_MODES = [
  'STABILIZE', 'ACRO', 'ALT_HOLD', 'AUTO', 'GUIDED', 'LOITER', 'RTL', 'CIRCLE',
  'LAND', 'DRIFT', 'SPORT', 'FLIP', 'AUTOTUNE', 'POSHOLD', 'BRAKE', 'THROW',
  'AVOID_ADSB', 'GUIDED_NOGPS', 'SMART_RTL', 'FLOWHOLD', 'FOLLOW', 'ZIGZAG',
  'SYSTEMID', 'AUTOROTATE', 'TURTLE', 'QSTABILIZE', 'QHOVER', 'QLOITER',
  'QLAND', 'QRTL', 'QAUTOTUNE', 'QACRO',
];

let selectedUavId = null;
let vehicles = [];
let renderedUavIds = '';

function readFlightSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(FLIGHT_SETTINGS_KEY) ?? '{}');
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  } catch {
    return {};
  }
}

function settingsFor(uavId) {
  const allSettings = readFlightSettings();
  const saved = allSettings[uavId] ?? {};
  return {
    allSettings,
    altitudeM: Number.isFinite(saved.altitudeM) && saved.altitudeM >= 1 && saved.altitudeM <= 120
      ? saved.altitudeM
      : DEFAULT_ALTITUDE_M,
    speedMps: Number.isFinite(saved.speedMps) && saved.speedMps >= 0.5 && saved.speedMps <= 30
      ? saved.speedMps
      : DEFAULT_SPEED_M_S,
  };
}

function persistFlightSetting(uavId, key, value, min, max) {
  if (!Number.isFinite(value) || value < min || value > max) {
    alert(`Enter a value between ${min} and ${max}.`);
    renderDetails();
    return false;
  }
  const settings = settingsFor(uavId);
  settings.allSettings[uavId] = {
    altitudeM: settings.altitudeM,
    speedMps: settings.speedMps,
    [key]: value,
  };
  try {
    localStorage.setItem(FLIGHT_SETTINGS_KEY, JSON.stringify(settings.allSettings));
    return true;
  } catch (error) {
    alert(`Could not save flight settings: ${error.message}`);
    renderDetails();
    return false;
  }
}

export function initActionsView() {
  onStateUpdate((updatedVehicles) => {
    vehicles = updatedVehicles;
    if (!vehicles.some((vehicle) => vehicle.uav_id === selectedUavId)) {
      selectedUavId = vehicles[0]?.uav_id ?? null;
    }
    renderSelectList();
    renderDetails();
  });

  document.querySelectorAll('.command-grid [data-batch-action]').forEach((button) => {
    button.addEventListener('click', () => runBatch(button.dataset.batchAction));
  });
  const list = document.getElementById('select-list');
  list.addEventListener('change', (event) => {
    const checkbox = event.target.closest('input[type="checkbox"][data-uav]');
    if (!checkbox) return;
    if (checkbox.checked) state.selectedForBatch.add(checkbox.dataset.uav);
    else state.selectedForBatch.delete(checkbox.dataset.uav);
    selectDetails(checkbox.dataset.uav);
  });
  list.addEventListener('click', (event) => {
    const inspectButton = event.target.closest('[data-inspect-uav]');
    if (inspectButton) {
      selectDetails(inspectButton.dataset.inspectUav);
      return;
    }
    const row = event.target.closest('[data-uav-row]');
    if (row && !event.target.closest('input')) selectDetails(row.dataset.uavRow);
  });
  list.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest('[data-uav-row]');
    if (!row || event.target.closest('input, button')) return;
    event.preventDefault();
    selectDetails(row.dataset.uavRow);
  });
  document.querySelectorAll('[data-detail-action]').forEach((button) => {
    button.addEventListener('click', () => runIndividual(button.dataset.detailAction));
  });
  document.getElementById('action-target-altitude').addEventListener('change', (event) => {
    if (selectedUavId) persistFlightSetting(selectedUavId, 'altitudeM', Number(event.target.value), 1, 120);
  });
  document.getElementById('action-target-speed').addEventListener('change', (event) => {
    if (selectedUavId) persistFlightSetting(selectedUavId, 'speedMps', Number(event.target.value), 0.5, 30);
  });
  document.getElementById('action-change-altitude').addEventListener('click', () => runTargetChange('altitude'));
  document.getElementById('action-change-speed').addEventListener('click', () => runTargetChange('speed'));
}

function renderSelectList() {
  const element = document.getElementById('select-list');
  const nextUavIds = vehicles.map((vehicle) => vehicle.uav_id).join('|');
  if (nextUavIds !== renderedUavIds) {
    renderedUavIds = nextUavIds;
    element.innerHTML = vehicles.map((vehicle) => `
      <div class="select-row" data-uav-row="${escapeHtml(vehicle.uav_id)}" tabindex="0">
        <input type="checkbox" aria-label="Select ${escapeHtml(vehicle.uav_id)} for fleet commands"
          data-uav="${escapeHtml(vehicle.uav_id)}">
        <span class="uid">${escapeHtml(vehicle.uav_id)}</span>
        <span class="status"></span>
        <button class="act inspect-button" type="button" data-inspect-uav="${escapeHtml(vehicle.uav_id)}">Details</button>
      </div>
    `).join('') || '<div class="hint">No UAVs are currently configured.</div>';
  }

  vehicles.forEach((vehicle) => {
    const row = Array.from(element.querySelectorAll('[data-uav-row]'))
      .find((item) => item.dataset.uavRow === vehicle.uav_id);
    if (!row) return;
    row.classList.toggle('active', vehicle.uav_id === selectedUavId);
    row.querySelector('.status').textContent =
      `${vehicle.connected ? 'connected' : 'offline'} · ${vehicle.flight_mode ?? '—'} · ${vehicle.armed ? 'ARMED' : 'DISARMED'}`;
    const checkbox = row.querySelector('input[type="checkbox"]');
    checkbox.checked = state.selectedForBatch.has(vehicle.uav_id);
  });
}

function selectDetails(uavId) {
  selectedUavId = uavId;
  renderSelectList();
  renderDetails();
}

function renderDetails() {
  const vehicle = vehicles.find((item) => item.uav_id === selectedUavId);
  const title = document.getElementById('action-uav-label');
  const emptyState = document.getElementById('action-uav-empty');
  const details = document.getElementById('action-uav-details');
  if (!vehicle) {
    title.textContent = 'Select a UAV';
    emptyState.hidden = false;
    details.hidden = true;
    return;
  }

  title.textContent = vehicle.uav_id;
  emptyState.hidden = true;
  details.hidden = false;
  document.getElementById('action-connected').textContent = vehicle.connected ? 'Connected' : 'Disconnected';
  document.getElementById('action-mode').textContent = vehicle.flight_mode ?? '-';
  document.getElementById('action-armed').textContent = vehicle.armed ? 'ARMED' : 'DISARMED';
  document.getElementById('action-battery').textContent = vehicle.battery_percent ?? '-';
  document.getElementById('action-altitude').textContent = vehicle.alt == null ? '-' : `${vehicle.alt.toFixed(1)} m`;
  document.getElementById('action-heading').textContent = vehicle.heading == null ? '-' : `${vehicle.heading.toFixed(0)}°`;
  document.getElementById('action-vertical-speed').textContent = vehicle.vertical_speed_m_s == null
    ? '-'
    : `${vehicle.vertical_speed_m_s >= 0 ? '+' : ''}${vehicle.vertical_speed_m_s.toFixed(2)} m/s`;
  document.getElementById('action-position').textContent = vehicle.lat != null && vehicle.lon != null
    ? `${vehicle.lat.toFixed(5)}, ${vehicle.lon.toFixed(5)}`
    : '-';

  const settings = settingsFor(vehicle.uav_id);
  const altitudeInput = document.getElementById('action-target-altitude');
  const speedInput = document.getElementById('action-target-speed');
  if (document.activeElement !== altitudeInput) altitudeInput.value = settings.altitudeM;
  if (document.activeElement !== speedInput) speedInput.value = settings.speedMps;

  const horizon = document.getElementById('action-attitude-horizon');
  if (vehicle.pitch_deg != null && vehicle.roll_deg != null) {
    horizon.style.transform = `translateY(${Math.max(-30, Math.min(30, vehicle.pitch_deg)) * 1.2}px) rotate(${-vehicle.roll_deg}deg)`;
    document.getElementById('action-attitude').textContent =
      `Pitch / roll: ${vehicle.pitch_deg.toFixed(1)}° / ${vehicle.roll_deg.toFixed(1)}°`;
  } else {
    horizon.style.transform = 'none';
    document.getElementById('action-attitude').textContent = 'Pitch / roll: waiting for telemetry';
  }

  let trend = 'HOLDING ALTITUDE';
  if (vehicle.vertical_speed_m_s == null) trend = 'WAITING FOR FLIGHT DATA';
  else if (vehicle.vertical_speed_m_s > CLIMB_THRESHOLD_M_S) trend = 'CLIMBING';
  else if (vehicle.vertical_speed_m_s < -CLIMB_THRESHOLD_M_S) trend = 'DESCENDING';
  else if (vehicle.is_landed) trend = 'ON GROUND';
  const trendElement = document.getElementById('action-flight-trend');
  trendElement.textContent = trend;
  trendElement.className = vehicle.vertical_speed_m_s == null
    ? 'unknown'
    : vehicle.vertical_speed_m_s > CLIMB_THRESHOLD_M_S
      ? 'climbing'
      : vehicle.vertical_speed_m_s < -CLIMB_THRESHOLD_M_S
        ? 'descending'
        : 'steady';

  const activeMode = String(vehicle.flight_mode ?? '').toUpperCase().split('.').pop();
  document.getElementById('action-flight-modes').innerHTML = ARDUCOPTER_MODES.map((mode) =>
    `<span class="mode-chip ${mode === activeMode ? 'active' : ''}">${mode}</span>`,
  ).join('');
}

async function runBatch(action) {
  const ids = Array.from(state.selectedForBatch);
  if (ids.length === 0) {
    alert('Select at least one UAV for fleet commands.');
    return;
  }
  const log = document.getElementById('batch-log');
  log.innerHTML = `<div>Sending "${escapeHtml(action)}" to ${ids.length} UAV(s)…</div>` + log.innerHTML;
  const results = await callBatchAction(ids, action);
  const lines = results.map((result) =>
    `<div class="${result.success ? 'ok' : 'fail'}">${escapeHtml(result.uav_id)}: ${result.success ? `ok (${result.latency_ms} ms)` : escapeHtml(result.message)}</div>`,
  ).join('');
  log.innerHTML = lines + log.innerHTML;
}

async function runIndividual(action) {
  const vehicle = vehicles.find((item) => item.uav_id === selectedUavId);
  if (!vehicle) {
    alert('Select a UAV first.');
    return;
  }
  if (action === 'abort' && !confirm(`Abort landing for ${vehicle.uav_id} by commanding Return to Launch (RTL)?`)) return;
  const settings = settingsFor(vehicle.uav_id);
  let result;
  if (action === 'auto' || action === 'resume') result = await startMission(vehicle.uav_id);
  else if (action === 'pause') result = await pauseMission(vehicle.uav_id);
  else {
    const command = action === 'abort' ? 'rtl' : action === 'hold' ? 'hold' : action;
    const params = command === 'takeoff' ? { altitude: settings.altitudeM } : {};
    result = await callAction(vehicle.uav_id, command, params);
  }
  if (!result.success) alert(`${action} failed for ${vehicle.uav_id}: ${result.message}`);
}

async function runTargetChange(target) {
  if (!selectedUavId) {
    alert('Select a UAV first.');
    return;
  }
  const settings = settingsFor(selectedUavId);
  const value = target === 'altitude' ? settings.altitudeM : settings.speedMps;
  if (!confirm(`Command ${selectedUavId} to change ${target} to ${value} ${target === 'altitude' ? 'm' : 'm/s'}?`)) return;
  const result = target === 'altitude'
    ? await changeAltitude(selectedUavId, value)
    : await changeSpeed(selectedUavId, value);
  if (!result.success) alert(`${target} change failed: ${result.message}`);
  else alert(result.message);
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
