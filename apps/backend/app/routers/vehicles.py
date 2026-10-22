"""
routers/vehicles.py
--------------------
REST endpoints for fleet status, single-vehicle actions, and batch actions
(sending one command to an arbitrary set of UAVs at once).
"""

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from app.config import (
    DEFAULT_TAKEOFF_ALTITUDE_M,
    MAX_ALTITUDE_M,
    MAX_FLIGHT_SPEED_M_S,
    MIN_ALTITUDE_M,
    MIN_FLIGHT_SPEED_M_S,
)
from app.vehicle_manager.parameters import (
    AUTO_OPTIONS_ALLOW_ARM_IN_AUTO,
    AUTO_OPTIONS_TAKEOFF_WITHOUT_THROTTLE,
)

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


class AutoOptionsRequest(BaseModel):
    allow_arming_in_auto: bool
    takeoff_without_throttle: bool


class AutoOptionsResponse(BaseModel):
    success: bool
    value: int | None = None
    allow_arming_in_auto: bool | None = None
    takeoff_without_throttle: bool | None = None
    message: str = ""


def register_routes(router: APIRouter, manager):
    @router.get("/vehicles")
    def list_vehicles():
        return manager.all_states()

    @router.get("/vehicles/{uav_id}/parameters/auto-options", response_model=AutoOptionsResponse)
    async def get_auto_options(uav_id: str):
        try:
            vehicle = manager.get(uav_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error))
        try:
            value = await vehicle.get_auto_options()
            return AutoOptionsResponse(
                success=True,
                value=value,
                allow_arming_in_auto=bool(value & AUTO_OPTIONS_ALLOW_ARM_IN_AUTO),
                takeoff_without_throttle=bool(value & AUTO_OPTIONS_TAKEOFF_WITHOUT_THROTTLE),
            )
        except Exception as error:
            return AutoOptionsResponse(success=False, message=str(error))

    @router.put("/vehicles/{uav_id}/parameters/auto-options", response_model=AutoOptionsResponse)
    async def update_auto_options(uav_id: str, request: AutoOptionsRequest):
        try:
            vehicle = manager.get(uav_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error))
        try:
            value = await vehicle.update_auto_options(
                request.allow_arming_in_auto,
                request.takeoff_without_throttle,
            )
            return AutoOptionsResponse(
                success=True,
                value=value,
                allow_arming_in_auto=bool(value & AUTO_OPTIONS_ALLOW_ARM_IN_AUTO),
                takeoff_without_throttle=bool(value & AUTO_OPTIONS_TAKEOFF_WITHOUT_THROTTLE),
                message=f"Autopilot confirmed AUTO_OPTIONS = {value}",
            )
        except Exception as error:
            return AutoOptionsResponse(success=False, message=str(error))

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
    async def takeoff(
        uav_id: str,
        altitude: float = Query(
            default=DEFAULT_TAKEOFF_ALTITUDE_M,
            ge=MIN_ALTITUDE_M,
            le=MAX_ALTITUDE_M,
        ),
    ):
        return await _run_action(uav_id, "takeoff", altitude)

    @router.post("/vehicles/{uav_id}/takeoff-altitude", response_model=ActionResponse)
    async def set_takeoff_altitude(uav_id: str, request: AltitudeRequest):
        if not MIN_ALTITUDE_M <= request.altitude_m <= MAX_ALTITUDE_M:
            raise HTTPException(
                status_code=422,
                detail=f"Takeoff altitude must be between {MIN_ALTITUDE_M:g} and {MAX_ALTITUDE_M:g} m",
            )
        response = await _run_action(uav_id, "set_takeoff_altitude", request.altitude_m)
        if response.success:
            response.message = f"Autopilot confirmed takeoff altitude {request.altitude_m:.2f} m for {uav_id}"
        return response

    @router.post("/vehicles/{uav_id}/altitude", response_model=ActionResponse)
    async def change_altitude(uav_id: str, request: AltitudeRequest):
        if not MIN_ALTITUDE_M <= request.altitude_m <= MAX_ALTITUDE_M:
            raise HTTPException(
                status_code=422,
                detail=f"Altitude must be between {MIN_ALTITUDE_M:g} and {MAX_ALTITUDE_M:g} m",
            )
        return await _run_action(uav_id, "change_altitude", request.altitude_m)

    @router.post("/vehicles/{uav_id}/speed", response_model=ActionResponse)
    async def change_speed(uav_id: str, request: SpeedRequest):
        if not MIN_FLIGHT_SPEED_M_S <= request.speed_m_s <= MAX_FLIGHT_SPEED_M_S:
            raise HTTPException(
                status_code=422,
                detail=f"Speed must be between {MIN_FLIGHT_SPEED_M_S:g} and {MAX_FLIGHT_SPEED_M_S:g} m/s",
            )
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

    @router.post("/vehicles/{uav_id}/mode/{mode}", response_model=ActionResponse)
    async def set_flight_mode(uav_id: str, mode: str):
        return await _run_action(uav_id, "set_flight_mode", mode)

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
