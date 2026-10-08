// api.js — thin wrapper around the backend's REST endpoints.

import { BACKEND_HTTP } from './state.js';

export async function callAction(uavId, action, params = {}) {
  const query = new URLSearchParams(params);
  const serializedParams = query.toString();
  const suffix = serializedParams ? `?${serializedParams}` : '';
  const res = await fetch(`${BACKEND_HTTP}/vehicles/${uavId}/${action}${suffix}`, { method: 'POST' });
  return res.json();
}

export async function changeAltitude(uavId, altitude) {
  const res = await fetch(`${BACKEND_HTTP}/vehicles/${uavId}/altitude`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ altitude_m: altitude }),
  });
  return res.json();
}

export async function changeSpeed(uavId, speed) {
  const res = await fetch(`${BACKEND_HTTP}/vehicles/${uavId}/speed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ speed_m_s: speed }),
  });
  return res.json();
}

export async function pauseMission(uavId) {
  const res = await fetch(`${BACKEND_HTTP}/vehicles/${uavId}/mission/pause`, { method: 'POST' });
  return res.json();
}

export async function callBatchAction(uavIds, action) {
  const res = await fetch(`${BACKEND_HTTP}/fleet/batch/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uav_ids: uavIds }),
  });
  return res.json();
}

export async function uploadMission(uavId, waypoints) {
  const res = await fetch(`${BACKEND_HTTP}/vehicles/${uavId}/mission`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ waypoints }),
  });
  return res.json();
}

export async function clearMission(uavId) {
  const res = await fetch(`${BACKEND_HTTP}/vehicles/${uavId}/mission`, { method: 'DELETE' });
  return res.json();
}

export async function startMission(uavId) {
  const res = await fetch(`${BACKEND_HTTP}/vehicles/${uavId}/mission/start`, { method: 'POST' });
  return res.json();
}