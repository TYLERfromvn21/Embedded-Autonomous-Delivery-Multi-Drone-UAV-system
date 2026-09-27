"""
routers/ws.py
--------------
WebSocket endpoint that streams the full fleet state to every connected
frontend client at a fixed interval (see config.TELEMETRY_BROADCAST_INTERVAL_S).
"""

import asyncio
import json
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

active_websockets: list[WebSocket] = []


def register_routes(router: APIRouter, manager, interval_s: float):
    @router.websocket("/ws/telemetry")
    async def telemetry_ws(websocket: WebSocket):
        await websocket.accept()
        active_websockets.append(websocket)
        try:
            while True:
                await websocket.receive_text()
        except WebSocketDisconnect:
            active_websockets.remove(websocket)

    async def telemetry_broadcaster():
        while True:
            payload = json.dumps(manager.all_states())
            for ws in list(active_websockets):
                try:
                    await ws.send_text(payload)
                except Exception:
                    active_websockets.remove(ws)
            await asyncio.sleep(interval_s)

    return router, telemetry_broadcaster
