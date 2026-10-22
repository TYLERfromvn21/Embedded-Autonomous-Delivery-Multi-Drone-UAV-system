import { BACKEND_HTTP, BACKEND_WS } from './config.js?v=20261019-3';
import { setVehicles } from './state.js?v=20261015-7';

let reconnectTimer;
let pollTimer;
let websocketOpen = false;

function setBackendStatus(message, kind) {
  const element = document.getElementById('backend-status');
  if (!element) return;
  element.textContent = message;
  element.dataset.state = kind;
}

async function pollVehicles() {
  if (websocketOpen) return;
  try {
    const response = await fetch(`${BACKEND_HTTP}/vehicles`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    setVehicles(await response.json());
    setBackendStatus('Backend connected', 'connected');
  } catch (error) {
    setBackendStatus('Backend unavailable - retrying', 'disconnected');
    console.debug('Vehicle status poll failed:', error);
  }
}

export function connectWebSocket() {
  clearTimeout(reconnectTimer);
  setBackendStatus('Connecting to backend...', 'connecting');
  let ws;
  try {
    ws = new WebSocket(BACKEND_WS);
  } catch (error) {
    console.error('Could not open telemetry WebSocket:', error);
    scheduleReconnect();
    return null;
  }
  ws.onopen = () => {
    websocketOpen = true;
    setBackendStatus('Backend connected', 'connected');
  };
  ws.onmessage = (event) => {
    try {
      setVehicles(JSON.parse(event.data));
    } catch (error) {
      console.error('Invalid telemetry message from backend:', error);
    }
  };
  ws.onerror = () => setBackendStatus('Backend unavailable - retrying', 'disconnected');
  ws.onclose = () => {
    websocketOpen = false;
    setBackendStatus('Backend unavailable - retrying', 'disconnected');
    scheduleReconnect();
  };
  if (!pollTimer) pollTimer = setInterval(pollVehicles, 1000);
  return ws;
}

function scheduleReconnect() {
  websocketOpen = false;
  if (!pollTimer) pollTimer = setInterval(pollVehicles, 1000);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectWebSocket, 2000);
}
