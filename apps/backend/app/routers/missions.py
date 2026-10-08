"""
routers/missions.py
--------------------
Mission (waypoint route) upload and start/pause endpoints.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel


class Waypoint(BaseModel):
    lat: float
    lon: float
    alt: float = 5.0
    speed_m_s: float = 5.0


class MissionRequest(BaseModel):
    waypoints: list[Waypoint]


class ActionResponse(BaseModel):
    success: bool
    message: str = ""
    latency_ms: float | None = None


def register_routes(router: APIRouter, manager):
    @router.post("/vehicles/{uav_id}/mission", response_model=ActionResponse)
    async def upload_mission(uav_id: str, mission: MissionRequest):
        try:
            vehicle = manager.get(uav_id)
            wps = [wp.model_dump() for wp in mission.waypoints]
            latency_ms = await vehicle.upload_mission(wps)
            return ActionResponse(success=True, message=f"Uploaded {len(wps)} waypoint(s) to {uav_id}", latency_ms=latency_ms)
        except KeyError as e:
            raise HTTPException(status_code=404, detail=str(e))
        except Exception as e:
            return ActionResponse(success=False, message=str(e))

    @router.delete("/vehicles/{uav_id}/mission", response_model=ActionResponse)
    async def clear_mission(uav_id: str):
        try:
            vehicle = manager.get(uav_id)
        except KeyError as e:
            raise HTTPException(status_code=404, detail=str(e))
        try:
            latency_ms = await vehicle.clear_mission()
            return ActionResponse(success=True, message=f"Cleared uploaded mission for {uav_id}", latency_ms=latency_ms)
        except Exception as e:
            return ActionResponse(success=False, message=str(e))

    @router.post("/vehicles/{uav_id}/mission/start", response_model=ActionResponse)
    async def start_mission(uav_id: str):
        try:
            vehicle = manager.get(uav_id)
        except KeyError as e:
            raise HTTPException(status_code=404, detail=str(e))
        try:
            latency_ms = await vehicle.start_mission()
            return ActionResponse(success=True, message=f"Mission started for {uav_id}", latency_ms=latency_ms)
        except Exception as e:
            return ActionResponse(success=False, message=str(e))

    @router.post("/vehicles/{uav_id}/mission/pause", response_model=ActionResponse)
    async def pause_mission(uav_id: str):
        try:
            vehicle = manager.get(uav_id)
        except KeyError as e:
            raise HTTPException(status_code=404, detail=str(e))
        try:
            latency_ms = await vehicle.pause_mission()
            return ActionResponse(success=True, message=f"Mission paused for {uav_id}", latency_ms=latency_ms)
        except Exception as e:
            return ActionResponse(success=False, message=str(e))

    return router
