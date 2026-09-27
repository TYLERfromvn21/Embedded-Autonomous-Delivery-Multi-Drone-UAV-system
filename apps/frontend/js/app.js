// app.js — entry point: wires up tab switching and initializes every view.

import { connectWebSocket } from './ws-client.js';
import { initMap } from './map-view.js';
import { initFleetView } from './fleet-view.js';
import { initActionsView } from './actions-view.js';
import { state, onStateUpdate } from './state.js';

function initTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.view).classList.add('active');
      // Leaflet needs an explicit resize nudge after being hidden with display:none.
      if (btn.dataset.view === 'map-view') {
        setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
      }
    });
  });
}

function initFleetSummary() {
  onStateUpdate((vehicles) => {
    const connected = vehicles.filter((v) => v.connected).length;
    const armed = vehicles.filter((v) => v.armed).length;
    document.getElementById('fleet-summary').innerHTML =
      `<span><b>${connected}</b>/${vehicles.length} connected</span><span><b>${armed}</b> armed</span>`;
  });
}

initTabs();
initFleetSummary();
initMap();
initFleetView();
initActionsView();
connectWebSocket();
