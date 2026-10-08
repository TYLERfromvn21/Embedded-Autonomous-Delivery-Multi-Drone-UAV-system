"""
mock_server.py
---------------
Standalone mock backend for previewing the frontend without SITL/MAVSDK.
3 fake UAVs orbit a center point with changing battery/mode/heading, plus
fake camera_url and waypoints so the Fleet tab has something to show.

Run from apps/backend/:
    uvicorn mock_server:app --reload --host 0.0.0.0 --port 8000
"""

import asyncio
import json
import math
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

CENTER_LAT = 10.7721
CENTER_LON = 106.6578

active_websockets: list[WebSocket] = []

fake_state = {
    "uav1": {"radius": 0.0015, "speed": 0.4, "phase": 0.0, "alt": 15, "battery": 88, "mode": "AUTO", "armed": True,
             "camera_url": "http://192.168.1.51:8080/stream",
             "waypoints": [{"lat": CENTER_LAT + 0.001, "lon": CENTER_LON + 0.001, "alt": 15}, {"lat": CENTER_LAT - 0.001, "lon": CENTER_LON + 0.002, "alt": 15}]},
    "uav2": {"radius": 0.0025, "speed": 0.25, "phase": 2.0, "alt": 20, "battery": 73, "mode": "GUIDED", "armed": True,
             "camera_url": None, "waypoints": []},
    "uav3": {"radius": 0.0010, "speed": 0.6, "phase": 4.0, "alt": 10, "battery": 45, "mode": "LOITER", "armed": False,
             "camera_url": "http://192.168.1.53:8080/stream", "waypoints": []},
}


def compute_states():
    t = time.time()
    states = []
    for uav_id, cfg in fake_state.items():
        angle = cfg["phase"] + t * cfg["speed"]
        lat = CENTER_LAT + cfg["radius"] * math.sin(angle)
        lon = CENTER_LON + cfg["radius"] * math.cos(angle)
        heading = (math.degrees(angle) + 90) % 360
        altitude_phase = t * 0.4 + cfg["phase"]
        altitude = cfg["alt"] + 2 * math.sin(altitude_phase)
        cfg["battery"] = max(0, cfg["battery"] - 0.01)
        states.append({
            "uav_id": uav_id, "lat": lat, "lon": lon, "alt": altitude,
            "absolute_alt": altitude + 30, "heading": heading,
            "pitch_deg": 7 * math.cos(altitude_phase), "roll_deg": 8 * math.cos(angle),
            "vertical_speed_m_s": 0.8 * math.cos(altitude_phase),
            "is_landed": False,
            "battery_percent": round(cfg["battery"], 1), "flight_mode": cfg["mode"], "armed": cfg["armed"],
            "connected": True, "camera_url": cfg["camera_url"], "waypoints": cfg["waypoints"],
        })
    return states


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(broadcaster())
    yield
    task.cancel()


app = FastAPI(title="UAV Web GCS - MOCK MODE", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/vehicles")
def list_vehicles():
    return compute_states()


class ActionResponse(BaseModel):
    success: bool
    message: str = ""
    latency_ms: float | None = None


class AltitudeRequest(BaseModel):
    altitude_m: float = Field(ge=1, le=120)


class SpeedRequest(BaseModel):
    speed_m_s: float = Field(ge=0.5, le=30)


@app.post("/vehicles/{uav_id}/altitude", response_model=ActionResponse)
async def fake_change_altitude(uav_id: str, payload: AltitudeRequest):
    if uav_id not in fake_state:
        return ActionResponse(success=False, message=f"Unknown UAV: {uav_id}")
    if not fake_state[uav_id]["armed"]:
        return ActionResponse(success=False, message="Vehicle must be armed before changing altitude.")
    fake_state[uav_id]["alt"] = payload.altitude_m
    return ActionResponse(success=True, message=f"[MOCK] Altitude target set for {uav_id}", latency_ms=12.3)


@app.post("/vehicles/{uav_id}/speed", response_model=ActionResponse)
async def fake_change_speed(uav_id: str, payload: SpeedRequest):
    if uav_id not in fake_state:
        return ActionResponse(success=False, message=f"Unknown UAV: {uav_id}")
    if not fake_state[uav_id]["armed"]:
        return ActionResponse(success=False, message="Vehicle must be armed before changing flight speed.")
    fake_state[uav_id]["speed_m_s"] = payload.speed_m_s
    return ActionResponse(success=True, message=f"[MOCK] Speed target set for {uav_id}", latency_ms=12.3)


@app.post("/vehicles/batch/{action_name}")
async def fake_batch(action_name: str, body: dict):
    results = []
    for uid in body.get("uav_ids", []):
        if uid in fake_state and action_name == "arm":
            fake_state[uid]["armed"] = True
        if uid in fake_state and action_name == "disarm":
            fake_state[uid]["armed"] = False
        results.append({"uav_id": uid, "success": True, "latency_ms": 12.3})
    return results


@app.post("/vehicles/{uav_id}/mission", response_model=ActionResponse)
async def fake_mission(uav_id: str, payload: dict):
    wps = payload.get("waypoints", [])
    if uav_id in fake_state:
        fake_state[uav_id]["waypoints"] = wps
    return ActionResponse(success=True, message=f"[MOCK] Received {len(wps)} waypoint(s)", latency_ms=8.1)


@app.post("/vehicles/{uav_id}/mission/start", response_model=ActionResponse)
async def fake_start_mission(uav_id: str):
    return ActionResponse(success=True, message=f"[MOCK] {uav_id} started mission", latency_ms=9.4)


@app.post("/vehicles/{uav_id}/mission/pause", response_model=ActionResponse)
async def fake_pause_mission(uav_id: str):
    if uav_id not in fake_state:
        return ActionResponse(success=False, message=f"Unknown UAV: {uav_id}")
    return ActionResponse(success=True, message=f"[MOCK] {uav_id} paused mission", latency_ms=9.4)


@app.post("/vehicles/{uav_id}/{action}", response_model=ActionResponse)
async def fake_action(uav_id: str, action: str):
    if uav_id not in fake_state:
        return ActionResponse(success=False, message=f"Unknown UAV: {uav_id}")
    if action == "arm":
        fake_state[uav_id]["armed"] = True
    if action == "disarm":
        fake_state[uav_id]["armed"] = False
    if action == "hold":
        fake_state[uav_id]["mode"] = "LOITER"
    if action == "rtl":
        fake_state[uav_id]["mode"] = "RTL"
    return ActionResponse(success=True, message=f"[MOCK] {action} for {uav_id}", latency_ms=12.3)


@app.websocket("/ws/telemetry")
async def telemetry_ws(websocket: WebSocket):
    await websocket.accept()
    active_websockets.append(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        active_websockets.remove(websocket)


async def broadcaster():
    while True:
        payload = json.dumps(compute_states())
        for ws in list(active_websockets):
            try:
                await ws.send_text(payload)
            except Exception:
                active_websockets.remove(ws)
        await asyncio.sleep(0.3)
