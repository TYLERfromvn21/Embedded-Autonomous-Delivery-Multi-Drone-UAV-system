// state.js — the single source of truth for fleet data, shared by every view.
// Keeping this in one place means map-view.js, fleet-view.js and actions-view.js
// all read the same data instead of each tab keeping its own stale copy.

export const BACKEND_HTTP = "http://localhost:8000";
export const BACKEND_WS = "ws://localhost:8000/ws/telemetry";

export const state = {
  vehicles: [],       // latest fleet snapshot from the WebSocket
  activeUav: null,     // uav_id selected in the Map tab's sidebar
  selectedForBatch: new Set(), // uav_ids checked in the Actions tab
  listeners: [],       // callbacks to notify when `vehicles` updates
};

export function onStateUpdate(fn) {
  state.listeners.push(fn);
}

export function setVehicles(vehicles) {
  state.vehicles = vehicles;
  state.listeners.forEach((fn) => fn(vehicles));
}
