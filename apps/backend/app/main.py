"""
main.py
-------
Application entry point. Wires config, the vehicle manager, and the three
routers (vehicles, missions, websocket) together. Business logic lives in
vehicle_manager.py and routers/ — this file stays thin on purpose so it's
easy to see the whole app's shape at a glance.

Run from apps/backend/:
    pip install -r requirements.txt
    uvicorn app.main:app --host 0.0.0.0 --port 8000
"""

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI, APIRouter
from fastapi.middleware.cors import CORSMiddleware

from app.config import UAV_CONFIGS, TELEMETRY_BROADCAST_INTERVAL_S
from app.vehicle_manager import VehicleManager
from app.routers import vehicles, missions, ws

manager = VehicleManager(UAV_CONFIGS)
router = APIRouter()
vehicles.register_routes(router, manager)
missions.register_routes(router, manager)
router, telemetry_broadcaster = ws.register_routes(router, manager, TELEMETRY_BROADCAST_INTERVAL_S)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await manager.connect_all()
    task = asyncio.create_task(telemetry_broadcaster())
    yield
    task.cancel()


app = FastAPI(title="UAV Web GCS Backend", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.include_router(router)
