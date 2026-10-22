import { state, onStateUpdate } from './state.js?v=20261015-7';
import {
  callBatchAction,
  callAction,
  changeAltitude,
  changeSpeed,
  pauseMission,
  startMission,
  resumeMission,
  setFlightMode,
  setTakeoffAltitude,
  getAutoOptions,
  setAutoOptions,
} from './api.js?v=20261020-1';

import { FLIGHT_CONFIG, FLIGHT_MODE_OPTIONS, loadFlightSettings } from './config.js?v=20261019-3';

let selectedUavId = null;
let vehicles = [];
let renderedUavIds = '';
let autoOptionsCache = new Map();
let autoOptionsLoading = new Set();
let renderedAutoOptionsUavId = null;

function readFlightSettings() {
  return loadFlightSettings();
}

function settingsFor(uavId) {
  const allSettings = readFlightSettings();
  const saved = allSettings[uavId] ?? {};
  return {
    allSettings,
    altitudeM: Number.isFinite(saved.altitudeM)
      && saved.altitudeM >= FLIGHT_CONFIG.minimumAltitudeM
      && saved.altitudeM <= FLIGHT_CONFIG.maximumAltitudeM
      ? saved.altitudeM
      : FLIGHT_CONFIG.defaultAltitudeM,
    speedMps: Number.isFinite(saved.speedMps)
      && saved.speedMps >= FLIGHT_CONFIG.minimumSpeedMps
      && saved.speedMps <= FLIGHT_CONFIG.maximumSpeedMps
      ? saved.speedMps
      : FLIGHT_CONFIG.defaultSpeedMps,
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
    localStorage.setItem(FLIGHT_CONFIG.settingsStorageKey, JSON.stringify(settings.allSettings));
    return true;
  } catch (error) {
    alert(`Could not save flight settings: ${error.message}`);
    renderDetails();
    return false;
  }
}

export function initActionsView() {
  configureFlightInputs();
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
  document.getElementById('action-target-speed').addEventListener('change', (event) => {
    if (selectedUavId) persistFlightSetting(
      selectedUavId, 'speedMps', Number(event.target.value),
      FLIGHT_CONFIG.minimumSpeedMps, FLIGHT_CONFIG.maximumSpeedMps,
    );
  });
  document.getElementById('action-save-takeoff-target').addEventListener('click', saveTakeoffTarget);
  document.getElementById('action-change-altitude').addEventListener('click', () => runTargetChange('altitude'));
  document.getElementById('action-change-speed').addEventListener('click', () => runTargetChange('speed'));
  document.getElementById('auto-options-refresh').addEventListener('click', () => {
    if (selectedUavId) loadAutoOptions(selectedUavId, true);
  });
  document.getElementById('auto-options-apply').addEventListener('click', applyAutoOptions);
  document.getElementById('action-flight-modes').addEventListener('click', (event) => {
    const button = event.target.closest('[data-flight-mode]');
    if (button && selectedUavId) changeFlightMode(selectedUavId, button.dataset.flightMode);
  });
}

function configureFlightInputs() {
  const altitude = document.getElementById('action-target-altitude');
  altitude.min = FLIGHT_CONFIG.minimumAltitudeM;
  altitude.max = FLIGHT_CONFIG.maximumAltitudeM;
  altitude.step = FLIGHT_CONFIG.altitudeStepM;
  altitude.value = FLIGHT_CONFIG.defaultAltitudeM;

  const speed = document.getElementById('action-target-speed');
  speed.min = FLIGHT_CONFIG.minimumSpeedMps;
  speed.max = FLIGHT_CONFIG.maximumSpeedMps;
  speed.step = FLIGHT_CONFIG.speedStepMps;
  speed.value = FLIGHT_CONFIG.defaultSpeedMps;
}

async function saveTakeoffTarget() {
  if (!selectedUavId) {
    alert('Select a UAV first.');
    return;
  }
  const input = document.getElementById('action-target-altitude');
  const altitude = Number(input.value);
  if (!Number.isFinite(altitude)
    || altitude < FLIGHT_CONFIG.minimumAltitudeM
    || altitude > FLIGHT_CONFIG.maximumAltitudeM) {
    alert(`Enter a takeoff target between ${FLIGHT_CONFIG.minimumAltitudeM} and ${FLIGHT_CONFIG.maximumAltitudeM} m.`);
    return;
  }
  const status = document.getElementById('action-takeoff-target-status');
  status.textContent = `Sending ${altitude} m takeoff target to ${selectedUavId}...`;
  const result = await setTakeoffAltitude(selectedUavId, altitude);
  if (!result.success) {
    status.textContent = `Autopilot did not confirm ${altitude} m: ${result.message}`;
    return;
  }
  if (!persistFlightSetting(
    selectedUavId, 'altitudeM', altitude,
    FLIGHT_CONFIG.minimumAltitudeM, FLIGHT_CONFIG.maximumAltitudeM,
  )) {
    status.textContent = `Autopilot confirmed ${altitude} m for ${selectedUavId}, but the browser could not save it.`;
    return;
  }
  status.textContent = result.message || `Autopilot confirmed takeoff target: ${altitude} m for ${selectedUavId}.`;
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
  document.getElementById('action-autopilot').textContent = vehicle.autopilot ?? 'Waiting for heartbeat';
  document.getElementById('action-mode').textContent = vehicle.flight_mode ?? '-';
  document.getElementById('action-ground-speed').textContent = Number.isFinite(vehicle.ground_speed_m_s)
    ? `${vehicle.ground_speed_m_s.toFixed(1)} m/s`
    : '-';
  renderFlightWarnings('action-flight-warnings', vehicle.flight_warnings);
  document.getElementById('action-armed').textContent = vehicle.armed ? 'ARMED' : 'DISARMED';
  document.getElementById('action-battery').textContent = vehicle.battery_percent ?? '-';
  document.getElementById('action-altitude').textContent = vehicle.alt == null ? '-' : `${vehicle.alt.toFixed(1)} m`;
  document.getElementById('action-heading').textContent = vehicle.heading == null ? '-' : `${vehicle.heading.toFixed(0)}°`;
  document.getElementById('action-vertical-speed').textContent = vehicle.vertical_speed_m_s == null
    ? '-'
    : `${vehicle.vertical_speed_m_s >= 0 ? '+' : ''}${vehicle.vertical_speed_m_s.toFixed(2)} m/s`;
  document.getElementById('action-position').textContent = hasValidGpsPosition(vehicle)
    ? `${vehicle.lat.toFixed(5)}, ${vehicle.lon.toFixed(5)}`
    : '-';
  document.getElementById('action-gps-fix').textContent = formatGpsFix(vehicle);
  document.getElementById('action-telemetry-streams').textContent = Array.isArray(vehicle.telemetry_streams)
    ? (vehicle.telemetry_streams.join(', ') || 'Waiting for telemetry')
    : 'Not reported';

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
  else if (vehicle.vertical_speed_m_s > FLIGHT_CONFIG.climbThresholdMps) trend = 'CLIMBING';
  else if (vehicle.vertical_speed_m_s < -FLIGHT_CONFIG.climbThresholdMps) trend = 'DESCENDING';
  else if (vehicle.is_landed) trend = 'ON GROUND';
  const trendElement = document.getElementById('action-flight-trend');
  trendElement.textContent = trend;
  trendElement.className = vehicle.vertical_speed_m_s == null
    ? 'unknown'
    : vehicle.vertical_speed_m_s > FLIGHT_CONFIG.climbThresholdMps
      ? 'climbing'
      : vehicle.vertical_speed_m_s < -FLIGHT_CONFIG.climbThresholdMps
        ? 'descending'
        : 'steady';

  renderModeCommands('action-flight-modes', vehicle);
  renderAutoOptions(vehicle);
}

function renderAutoOptions(vehicle) {
  const panel = document.getElementById('auto-options-panel');
  panel.hidden = vehicle.autopilot !== 'ArduPilot';
  if (panel.hidden) {
    renderedAutoOptionsUavId = null;
    return;
  }

  const cached = autoOptionsCache.get(vehicle.uav_id);
  if (cached && !cached.success) {
    if (renderedAutoOptionsUavId !== vehicle.uav_id) {
      document.getElementById('auto-options-status').textContent =
        `Could not read AUTO_OPTIONS: ${cached.message}`;
      renderedAutoOptionsUavId = vehicle.uav_id;
    }
    return;
  }
  if (cached && renderedAutoOptionsUavId !== vehicle.uav_id) {
    renderAutoOptionsValue(cached);
    document.getElementById('auto-options-status').textContent = 'Values read from the autopilot.';
    renderedAutoOptionsUavId = vehicle.uav_id;
  }
  if (!cached && !autoOptionsLoading.has(vehicle.uav_id)) loadAutoOptions(vehicle.uav_id);
}

function renderAutoOptionsValue(options) {
  document.getElementById('auto-options-value').textContent = String(options.value);
  document.getElementById('auto-options-decoded').textContent =
    `Decoded bits: bit 0 = ${options.allow_arming_in_auto ? '1 (arming in AUTO allowed)' : '0 (arming in AUTO disabled)'}; `
    + `bit 1 = ${options.takeoff_without_throttle ? '1 (AUTO takeoff without raising throttle)' : '0 (normal throttle requirement)'}.`;
  document.getElementById('auto-allow-arm-in-auto').value = options.allow_arming_in_auto ? '1' : '0';
  document.getElementById('auto-takeoff-without-throttle').value = options.takeoff_without_throttle ? '1' : '0';
}

async function loadAutoOptions(uavId, refresh = false) {
  if (refresh) autoOptionsCache.delete(uavId);
  if (!refresh && autoOptionsCache.has(uavId)) return;
  if (autoOptionsLoading.has(uavId)) return;
  autoOptionsLoading.add(uavId);
  const status = document.getElementById('auto-options-status');
  status.textContent = `Reading AUTO_OPTIONS from ${uavId}...`;
  try {
    const result = await getAutoOptions(uavId);
    if (!result.success) {
      autoOptionsCache.set(uavId, result);
      renderedAutoOptionsUavId = uavId;
      status.textContent = `Could not read AUTO_OPTIONS: ${result.message}`;
      return;
    }
    autoOptionsCache.set(uavId, result);
    if (selectedUavId === uavId) {
      renderedAutoOptionsUavId = null;
      const vehicle = vehicles.find((item) => item.uav_id === uavId);
      if (vehicle) renderAutoOptions(vehicle);
    }
  } catch (error) {
    autoOptionsCache.set(uavId, { success: false, message: error.message });
    renderedAutoOptionsUavId = uavId;
    status.textContent = `Could not read AUTO_OPTIONS: ${error.message}`;
  } finally {
    autoOptionsLoading.delete(uavId);
  }
}

async function applyAutoOptions() {
  const uavId = selectedUavId;
  if (!uavId) return;
  const button = document.getElementById('auto-options-apply');
  const status = document.getElementById('auto-options-status');
  const armInAutoInput = document.getElementById('auto-allow-arm-in-auto');
  const takeoffInput = document.getElementById('auto-takeoff-without-throttle');
  const armInAutoValue = armInAutoInput.value.trim();
  const takeoffValue = takeoffInput.value.trim();
  if (![armInAutoValue, takeoffValue].every((value) => value === '0' || value === '1')) {
    status.textContent = 'Enter only 0 or 1 for each AUTO_OPTIONS bit. No changes were sent.';
    status.classList.add('is-error');
    return;
  }
  status.classList.remove('is-error');
  button.disabled = true;
  status.textContent = `Updating AUTO_OPTIONS on ${uavId}...`;
  try {
    const result = await setAutoOptions(uavId, {
      allow_arming_in_auto: armInAutoValue === '1',
      takeoff_without_throttle: takeoffValue === '1',
    });
    if (!result.success) {
      status.textContent = `Autopilot did not confirm AUTO_OPTIONS: ${result.message}`;
      status.classList.add('is-error');
      return;
    }
    autoOptionsCache.set(uavId, result);
    renderedAutoOptionsUavId = null;
    renderAutoOptionsValue(result);
    status.textContent = `${result.message}. Other AUTO_OPTIONS bits were preserved.`;
    status.classList.remove('is-error');
  } catch (error) {
    status.textContent = `AUTO_OPTIONS update failed: ${error.message}`;
    status.classList.add('is-error');
  } finally {
    button.disabled = false;
  }
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
  if (fixType == null) return hasValidGpsPosition(vehicle) ? 'Position available' : 'Waiting for GPS';
  const label = labels[fixType] ?? `Fix type ${fixType}`;
  return vehicle.gps_satellites == null ? label : `${label} (${vehicle.gps_satellites} sats)`;
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
  if (action === 'auto') result = await startMission(vehicle.uav_id);
  else if (action === 'resume') result = await resumeMission(vehicle.uav_id);
  else if (action === 'pause') result = await pauseMission(vehicle.uav_id);
  else if (action === 'loiter') result = await setFlightMode(vehicle.uav_id, 'LOITER');
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
