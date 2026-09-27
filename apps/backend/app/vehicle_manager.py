"""
vehicle_manager.py
-------------------
Manages multiple UAVs (SITL or real hardware) via MAVSDK-Python.
Each UAV is represented by a mavsdk.System instance, stored in a dict keyed by uav_id.

Default SITL UDP ports (ArduPilot, sim_vehicle.py):
  UAV instance 0 -> udp://:14540
  UAV instance 1 -> udp://:14541
  UAV instance 2 -> udp://:14542
Adjust these in config.py to match the actual ports your team uses.
"""

import asyncio
import time
from mavsdk import System


class Vehicle:
    """Wraps a single MAVSDK System and caches the latest telemetry for fast API/WebSocket access."""

    def __init__(self, uav_id: str, connection_url: str):
        self.uav_id = uav_id
        self.connection_url = connection_url
        self.system = System()
        self.connected = False
        self.state = {
            "uav_id": uav_id,
            "lat": None,
            "lon": None,
            "alt": None,
            "heading": None,
            "battery_percent": None,
            "flight_mode": None,
            "armed": False,
            "connected": False,
            # camera_url: set this once a companion camera (RPi cam / ESP32-CAM)
            # exposes an MJPEG/RTSP stream, e.g. "http://192.168.1.50:8080/stream".
            # Left as None until that integration is wired up.
            "camera_url": None,
            # waypoints: the last mission plan uploaded to this vehicle, kept here
            # purely for display in the Fleet tab (not re-read from the autopilot).
            "waypoints": [],
        }
        self._tasks = []

    async def connect(self):
        await self.system.connect(system_address=self.connection_url)
        async for state in self.system.core.connection_state():
            if state.is_connected:
                self.connected = True
                self.state["connected"] = True
                break
        self._tasks = [
            asyncio.create_task(self._watch_position()),
            asyncio.create_task(self._watch_battery()),
            asyncio.create_task(self._watch_flight_mode()),
            asyncio.create_task(self._watch_armed()),
            asyncio.create_task(self._watch_heading()),
        ]

    async def _watch_position(self):
        async for pos in self.system.telemetry.position():
            self.state["lat"] = pos.latitude_deg
            self.state["lon"] = pos.longitude_deg
            self.state["alt"] = pos.relative_altitude_m

    async def _watch_battery(self):
        async for battery in self.system.telemetry.battery():
            self.state["battery_percent"] = round(battery.remaining_percent, 1)

    async def _watch_flight_mode(self):
        async for mode in self.system.telemetry.flight_mode():
            self.state["flight_mode"] = str(mode)

    async def _watch_armed(self):
        async for armed in self.system.telemetry.armed():
            self.state["armed"] = armed

    async def _watch_heading(self):
        async for heading in self.system.telemetry.heading():
            self.state["heading"] = heading.heading_deg

    # ---------- Actions ----------
    # Each action returns elapsed_ms: the round-trip time from calling MAVSDK
    # to receiving the command result. This is what lets the frontend (and the
    # thesis defense) show a real, measured number instead of a claim.
    async def _timed(self, coro):
        start = time.perf_counter()
        await coro
        return round((time.perf_counter() - start) * 1000, 1)

    async def arm(self):
        return await self._timed(self.system.action.arm())

    async def disarm(self):
        return await self._timed(self.system.action.disarm())

    async def takeoff(self, altitude_m: float = 10.0):
        await self.system.action.set_takeoff_altitude(altitude_m)
        return await self._timed(self.system.action.takeoff())

    async def land(self):
        return await self._timed(self.system.action.land())

    async def rtl(self):
        return await self._timed(self.system.action.return_to_launch())

    async def hold(self):
        return await self._timed(self.system.action.hold())

    async def upload_mission(self, waypoints: list[dict]):
        from mavsdk.mission import MissionItem, MissionPlan

        mission_items = []
        for wp in waypoints:
            mission_items.append(
                MissionItem(
                    wp["lat"], wp["lon"], wp.get("alt", 10.0), wp.get("speed_m_s", 5.0),
                    True,
                    float("nan"), float("nan"), float("nan"),
                    MissionItem.CameraAction.NONE,
                    float("nan"), float("nan"),
                    float("nan"), float("nan"), float("nan"),
                    MissionItem.VehicleAction.NONE,
                )
            )
        mission_plan = MissionPlan(mission_items)
        await self.system.mission.set_return_to_launch_after_mission(True)
        elapsed = await self._timed(self.system.mission.upload_mission(mission_plan))
        # Cache the route so the Fleet tab can display it without re-querying MAVLink.
        self.state["waypoints"] = waypoints
        return elapsed

    async def start_mission(self):
        return await self._timed(self.system.mission.start_mission())

    async def pause_mission(self):
        return await self._timed(self.system.mission.pause_mission())


class VehicleManager:
    """Manages the full fleet of UAVs for the system."""

    def __init__(self, uav_configs: dict[str, str]):
        self.vehicles: dict[str, Vehicle] = {
            uid: Vehicle(uid, url) for uid, url in uav_configs.items()
        }

    async def connect_all(self):
        await asyncio.gather(*(v.connect() for v in self.vehicles.values()))

    def get(self, uav_id: str) -> Vehicle:
        if uav_id not in self.vehicles:
            raise KeyError(f"UAV '{uav_id}' not found")
        return self.vehicles[uav_id]

    def all_states(self) -> list[dict]:
        return [v.state for v in self.vehicles.values()]
