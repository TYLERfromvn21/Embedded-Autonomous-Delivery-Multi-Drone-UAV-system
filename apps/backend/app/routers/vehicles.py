"""
routers/vehicles.py
--------------------
REST endpoints for fleet status, single-vehicle actions, and batch actions
(sending one command to an arbitrary set of UAVs at once).
"""

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

router = APIRouter()


class ActionResponse(BaseModel):
    success: bool
    message: str = ""
    latency_ms: float | None = None


class BatchActionRequest(BaseModel):
    uav_ids: list[str]


class BatchActionResult(BaseModel):
    uav_id: str
    success: bool
    message: str = ""
    latency_ms: float | None = None


class AltitudeRequest(BaseModel):
    altitude_m: float


class SpeedRequest(BaseModel):
    speed_m_s: float


def register_routes(router: APIRouter, manager):
    @router.get("/vehicles")
    def list_vehicles():
        return manager.all_states()

    async def _run_action(uav_id: str, action_name: str, *args) -> ActionResponse:
        try:
            vehicle = manager.get(uav_id)
        except KeyError as e:
            raise HTTPException(status_code=404, detail=str(e))
        try:
            latency_ms = await getattr(vehicle, action_name)(*args)
            return ActionResponse(success=True, message=f"{action_name} OK for {uav_id}", latency_ms=latency_ms)
        except Exception as e:
            return ActionResponse(success=False, message=str(e))

    @router.post("/vehicles/{uav_id}/arm", response_model=ActionResponse)
    async def arm(uav_id: str):
        return await _run_action(uav_id, "arm")

    @router.post("/vehicles/{uav_id}/disarm", response_model=ActionResponse)
    async def disarm(uav_id: str):
        return await _run_action(uav_id, "disarm")

    @router.post("/vehicles/{uav_id}/takeoff", response_model=ActionResponse)
    async def takeoff(uav_id: str, altitude: float = Query(default=5.0, ge=1, le=120)):
        return await _run_action(uav_id, "takeoff", altitude)

    @router.post("/vehicles/{uav_id}/altitude", response_model=ActionResponse)
    async def change_altitude(uav_id: str, request: AltitudeRequest):
        if not 1.0 <= request.altitude_m <= 120.0:
            raise HTTPException(status_code=422, detail="Altitude must be between 1 and 120 m")
        return await _run_action(uav_id, "change_altitude", request.altitude_m)

    @router.post("/vehicles/{uav_id}/speed", response_model=ActionResponse)
    async def change_speed(uav_id: str, request: SpeedRequest):
        if not 0.5 <= request.speed_m_s <= 30.0:
            raise HTTPException(status_code=422, detail="Speed must be between 0.5 and 30 m/s")
        return await _run_action(uav_id, "change_speed", request.speed_m_s)

    @router.post("/vehicles/{uav_id}/land", response_model=ActionResponse)
    async def land(uav_id: str):
        return await _run_action(uav_id, "land")

    @router.post("/vehicles/{uav_id}/rtl", response_model=ActionResponse)
    async def rtl(uav_id: str):
        return await _run_action(uav_id, "rtl")

    @router.post("/vehicles/{uav_id}/hold", response_model=ActionResponse)
    async def hold(uav_id: str):
        return await _run_action(uav_id, "hold")

    # ---- Batch: send the same action to an arbitrary set of UAVs ----
    # This is what backs the Actions tab's "select N vehicles, pick a command" flow.
    # Commands run concurrently (asyncio.gather), not one-by-one, so sending
    # RTL to 50 selected UAVs takes roughly as long as sending it to 1.
    @router.post("/fleet/batch/{action_name}", response_model=list[BatchActionResult])
    async def batch_action(action_name: str, body: BatchActionRequest):
        import asyncio

        allowed = {"arm", "disarm", "land", "rtl", "hold"}
        if action_name not in allowed:
            raise HTTPException(status_code=400, detail=f"Unsupported batch action '{action_name}'")

        async def run_one(uav_id: str) -> BatchActionResult:
            try:
                vehicle = manager.get(uav_id)
            except KeyError:
                return BatchActionResult(uav_id=uav_id, success=False, message="UAV not found")
            try:
                latency_ms = await getattr(vehicle, action_name)()
                return BatchActionResult(uav_id=uav_id, success=True, latency_ms=latency_ms)
            except Exception as e:
                return BatchActionResult(uav_id=uav_id, success=False, message=str(e))

        return await asyncio.gather(*(run_one(uid) for uid in body.uav_ids))

    return router