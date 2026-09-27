// api.js — thin wrapper around the backend's REST endpoints.

import { BACKEND_HTTP } from './state.js';

export async function callAction(uavId, action) {
  const res = await fetch(`${BACKEND_HTTP}/vehicles/${uavId}/${action}`, { method: 'POST' });
  return res.json();
}

export async function callBatchAction(uavIds, action) {
  const res = await fetch(`${BACKEND_HTTP}/vehicles/batch/${action}`, {
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

export async function startMission(uavId) {
  const res = await fetch(`${BACKEND_HTTP}/vehicles/${uavId}/mission/start`, { method: 'POST' });
  return res.json();
}
