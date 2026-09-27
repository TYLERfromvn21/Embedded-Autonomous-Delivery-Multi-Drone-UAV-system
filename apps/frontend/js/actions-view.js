// actions-view.js — the Actions tab: pick any subset of the fleet, send one
// command to all of them at once. Uses the backend's /vehicles/batch/{action}
// endpoint, which runs the commands concurrently (asyncio.gather) rather than
// one-by-one, so selecting 50 UAVs doesn't take 50x as long as selecting 1.

import { state, onStateUpdate } from './state.js';
import { callBatchAction } from './api.js';

export function initActionsView() {
  onStateUpdate(renderSelectList);

  document.querySelectorAll('.command-grid [data-batch-action]').forEach((btn) => {
    btn.addEventListener('click', () => runBatch(btn.dataset.batchAction));
  });
}

function renderSelectList(vehicles) {
  const el = document.getElementById('select-list');
  el.innerHTML = vehicles.map((v) => `
    <label class="select-row">
      <input type="checkbox" data-uav="${v.uav_id}" ${state.selectedForBatch.has(v.uav_id) ? 'checked' : ''}>
      <span class="uid">${v.uav_id}</span>
      <span class="status">${v.connected ? 'connected' : 'offline'} · ${v.flight_mode ?? '—'}</span>
    </label>
  `).join('');
  el.querySelectorAll('input[type=checkbox]').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) state.selectedForBatch.add(cb.dataset.uav);
      else state.selectedForBatch.delete(cb.dataset.uav);
    });
  });
}

async function runBatch(action) {
  const ids = Array.from(state.selectedForBatch);
  if (ids.length === 0) { alert('Select at least one UAV first.'); return; }
  const log = document.getElementById('batch-log');
  log.innerHTML = `<div>Sending "${action}" to ${ids.length} UAV(s)…</div>` + log.innerHTML;
  const results = await callBatchAction(ids, action);
  const lines = results.map((r) =>
    `<div class="${r.success ? 'ok' : 'fail'}">${r.uav_id}: ${r.success ? `ok (${r.latency_ms} ms)` : r.message}</div>`
  ).join('');
  log.innerHTML = lines + log.innerHTML;
}
