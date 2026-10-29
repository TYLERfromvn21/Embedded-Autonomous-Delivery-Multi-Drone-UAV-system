/**
 * Frontend configuration shared by the map, Actions, landing-station,
 * collision-check, API, and WebSocket modules. Change operational defaults,
 * limits, service endpoints, or map settings here instead of duplicating them
 * across views. Keep these values aligned with apps/backend/app/config.py.
 */

// Backend endpoints used by api.js and ws-client.js. Keep localhost for
// Windows browser to WSL port forwarding; change both when hosting remotely.
export const BACKEND_HTTP = 'http://localhost:8000';
export const BACKEND_WS = `${BACKEND_HTTP.replace(/^http/, 'ws')}/ws/telemetry`;

// Pilot settings used by map-view.js and actions-view.js. Values persist per
// UAV in this browser. The backend validates the same altitude/speed ranges.
export const FLIGHT_CONFIG = Object.freeze({
  settingsStorageKey: 'uav-web-gcs.flight-settings.v2',
  previousSettingsStorageKey: 'uav-web-gcs.flight-settings.v1',
  defaultAltitudeM: 3,
  minimumAltitudeM: 1,
  maximumAltitudeM: 120,
  altitudeStepM: 0.1,
  defaultSpeedMps: 5,
  minimumSpeedMps: 0.5,
  maximumSpeedMps: 30,
  speedStepMps: 0.1,
  climbThresholdMps: 0.2,
});

// Migrate browser-saved settings once when the storage key changes. The old
// interface used 6 m as its default takeoff target; convert that legacy default
// to 3 m while preserving other per-UAV values such as speed.
export function loadFlightSettings() {
  try {
    const current = localStorage.getItem(FLIGHT_CONFIG.settingsStorageKey);
    if (current) return JSON.parse(current);

    const previous = localStorage.getItem(FLIGHT_CONFIG.previousSettingsStorageKey);
    const settings = previous ? JSON.parse(previous) : {};
    if (!settings || Array.isArray(settings) || typeof settings !== 'object') return {};

    for (const value of Object.values(settings)) {
      if (value && value.altitudeM === 6) value.altitudeM = FLIGHT_CONFIG.defaultAltitudeM;
    }
    localStorage.setItem(FLIGHT_CONFIG.settingsStorageKey, JSON.stringify(settings));
    return settings;
  } catch {
    return {};
  }
}

// Map display and mission-planning defaults used by map-view.js.
export const MAP_CONFIG = Object.freeze({
  initialCenter: [10.7721, 106.6578],
  initialZoom: 16,
  tileUrl: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  tileAttribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  streetTileUrl: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
  streetTileAttribution: 'Tiles &copy; Esri &mdash; Source: Esri, DeLorme, NAVTEQ, USGS, Intermap, iPC, NRCAN, Esri Japan, METI, Esri China (Hong Kong), Esri (Thailand), TomTom, 2012',
  maximumZoom: 23,
  maximumNativeZoom: 19,
  defaultWaypointAltitudeM: 3,
  routeColors: ['#2dd4bf', '#f5a524', '#8b8df7', '#f477a8', '#56a8ff', '#a3d977'],
});

// Flight-mode chips displayed in map-view.js and actions-view.js. These are
// UI options; backend support and firmware mode mappings are in vehicle_manager/modes.py.
export const FLIGHT_MODE_OPTIONS = Object.freeze({
  arducopter: [
    'STABILIZE', 'ACRO', 'ALT_HOLD', 'AUTO', 'GUIDED', 'LOITER', 'RTL', 'CIRCLE',
    'LAND', 'DRIFT', 'SPORT', 'FLIP', 'AUTOTUNE', 'POSHOLD', 'THROW', 'AVOID_ADSB',
    'GUIDED_NOGPS', 'SMART_RTL', 'FLOWHOLD', 'FOLLOW', 'ZIGZAG', 'SYSTEMID',
    'AUTOROTATE', 'AUTO_RTL', 'TURTLE',
  ],
  px4: ['HOLD', 'RTL', 'LAND'],
});

// Landing-station persistence and proximity display values used by station-view.js.
export const LANDING_STATION_CONFIG = Object.freeze({
  storageKey: 'uav-web-gcs.landing-stations.v1',
  occupancyRadiusM: 15,
  landingAltitudeM: 10,
});

// Collision-estimation model inputs used by collision-check.js and map-view.js.
export const COLLISION_CONFIG = Object.freeze({
  earthRadiusM: 6371000,
  horizontalProtectionM: 10,
  verticalProtectionM: 5,
  perVehicleHorizontalSigmaM: Math.sqrt(5 ** 2 + 3 ** 2 + 2 ** 2),
  perVehicleVerticalSigmaM: 2,
  minimumDisplayedProbability: 0.05,
});
