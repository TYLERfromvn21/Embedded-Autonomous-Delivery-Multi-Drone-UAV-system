// ws-client.js — opens the telemetry WebSocket and feeds updates into state.js.

import { BACKEND_WS, setVehicles } from './state.js';

export function connectWebSocket() {
  const ws = new WebSocket(BACKEND_WS);
  ws.onmessage = (event) => {
    setVehicles(JSON.parse(event.data));
  };
  ws.onclose = () => setTimeout(connectWebSocket, 2000); // auto-reconnect
  return ws;
}
