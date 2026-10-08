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
import json
import time
from mavsdk import System
from mavsdk.mavlink_direct import MavlinkMessage


class Vehicle:
    """Wraps a single MAVSDK System and caches the latest telemetry for fast API/WebSocket access."""

    def __init__(self, uav_id: str, connection_url: str, mavsdk_port: int):
        self.uav_id = uav_id
        self.connection_url = connection_url
        self.system = System(port=mavsdk_port)
        self.connected = False
        self.state = {
            "uav_id": uav_id,
            "lat": None,
            "lon": None,
            "alt": None,
            "absolute_alt": None,
            "heading": None,
            "pitch_deg": None,
            "roll_deg": None,
            "vertical_speed_m_s": None,
            "is_landed": None,
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
            asyncio.create_task(self._watch_attitude()),
            asyncio.create_task(self._watch_vertical_speed()),
            asyncio.create_task(self._watch_landed_state()),
        ]

    async def _watch_position(self):
        async for pos in self.system.telemetry.position():
            self.state["lat"] = pos.latitude_deg
            self.state["lon"] = pos.longitude_deg
            self.state["alt"] = pos.relative_altitude_m
            self.state["absolute_alt"] = pos.absolute_altitude_m

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

    async def _watch_attitude(self):
        async for attitude in self.system.telemetry.attitude_euler():
            self.state["pitch_deg"] = attitude.pitch_deg
            self.state["roll_deg"] = attitude.roll_deg

    async def _watch_vertical_speed(self):
        async for velocity in self.system.telemetry.position_velocity_ned():
            self.state["vertical_speed_m_s"] = -velocity.velocity.down_m_s

    async def _watch_landed_state(self):
        async for landed_state in self.system.telemetry.landed_state():
            self.state["is_landed"] = str(landed_state).split(".")[-1] == "ON_GROUND"

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

    async def takeoff(self, altitude_m: float = 5.0):
        # ArduCopter refuses takeoff while disarmed, but MAVSDK's generic error
        # ("FAILED: 'Failed'") doesn't say why. We check first and raise a
        # message that actually tells the operator what to do — deliberately
        # NOT auto-arming here, unlike start_mission(): arming before takeoff
        # should stay an explicit, separate action the operator confirms,
        # especially once this runs on real hardware.
        if not self.state["armed"]:
            raise RuntimeError("Vehicle is not armed. Press Arm first, then Takeoff.")
        await self.system.action.set_takeoff_altitude(altitude_m)
        return await self._timed(self.system.action.takeoff())

    async def land(self):
        return await self._timed(self.system.action.land())

    async def rtl(self):
        return await self._timed(self.system.action.return_to_launch())

    async def hold(self):
        return await self._timed(self.system.action.hold())

    async def change_altitude(self, altitude_m: float):
        if not self.state["armed"]:
            raise RuntimeError("Vehicle must be armed before changing altitude.")
        if self.state["lat"] is None or self.state["lon"] is None:
            raise RuntimeError("Vehicle has no valid GPS position.")
        if str(self.state["flight_mode"]).upper().split(".")[-1] != "GUIDED":
            raise RuntimeError("Change altitude requires GUIDED mode. Switch to GUIDED using the flight controller first.")
        current_altitude_msl = self.state["absolute_alt"]
        current_relative_altitude = self.state["alt"]
        if current_altitude_msl is None or current_relative_altitude is None:
            raise RuntimeError("Vehicle has no valid altitude telemetry.")
        target_altitude_msl = current_altitude_msl + (altitude_m - current_relative_altitude)
        return await self._timed(self.system.action.goto_location(
            self.state["lat"],
            self.state["lon"],
            target_altitude_msl,
            self.state["heading"] if self.state["heading"] is not None else float("nan"),
        ))

    async def change_speed(self, speed_m_s: float):
        if not self.state["armed"]:
            raise RuntimeError("Vehicle must be armed before changing flight speed.")
        return await self._timed(self.system.action.set_current_speed(speed_m_s))

    async def upload_mission(self, waypoints: list[dict]):
        from mavsdk.mission_raw import MissionItem

        if not waypoints:
            raise ValueError("Mission must contain at least one waypoint.")
        if self.state["lat"] is None or self.state["lon"] is None:
            raise RuntimeError("Vehicle has no valid GPS position for mission upload.")

        mission_items = [
            MissionItem(
                seq=0,
                frame=3,
                command=16,
                current=0,
                autocontinue=1,
                param1=0.0,
                param2=2.0,
                param3=0.0,
                param4=float("nan"),
                x=int(self.state["lat"] * 10000000),
                y=int(self.state["lon"] * 10000000),
                z=0.0,
                mission_type=0,
            ),
            MissionItem(
                seq=1,
                frame=3,
                command=22,  # MAV_CMD_NAV_TAKEOFF
                current=0,
                autocontinue=1,
                param1=0.0,
                param2=0.0,
                param3=0.0,
                param4=float("nan"),
                x=int(self.state["lat"] * 10000000),
                y=int(self.state["lon"] * 10000000),
                z=float(waypoints[0].get("alt", 10.0)),
                mission_type=0,
            ),
        ]
        for i, wp in enumerate(waypoints, start=2):
            mission_items.append(
                MissionItem(
                    seq=i,
                    frame=3,  # MAV_FRAME_GLOBAL_RELATIVE_ALT
                    command=16,  # MAV_CMD_NAV_WAYPOINT
                    current=0,
                    autocontinue=1,
                    param1=0.0,  # Hold time
                    param2=2.0,  # Acceptance radius in meters
                    param3=0.0,
                    param4=float("nan"),  # Yaw angle
                    x=int(wp["lat"] * 10000000),  # MAVLink coordinates are scaled by 10^7
                    y=int(wp["lon"] * 10000000),
                    z=float(wp.get("alt", 10.0)),
                    mission_type=0  # MAV_MISSION_TYPE_MISSION
                )
            )
            
        # Append a return-to-launch command after the route.
        mission_items.append(
            MissionItem(
                seq=len(mission_items),
                frame=2,  # MAV_FRAME_MISSION
                command=20,  # MAV_CMD_NAV_RETURN_TO_LAUNCH
                current=0,
                autocontinue=1,
                param1=0.0, param2=0.0, param3=0.0, param4=0.0,
                x=0, y=0, z=0.0,
                mission_type=0
            )
        )

        # Clear the previous mission before uploading the new one.
        await self.system.mission_raw.clear_mission()
        elapsed = await self._timed(self.system.mission_raw.upload_mission(mission_items))
        
        self.state["waypoints"] = waypoints
        return elapsed

    async def clear_mission(self):
        elapsed = await self._timed(self.system.mission_raw.clear_mission())
        self.state["waypoints"] = []
        return elapsed

    async def start_mission(self):
        if not self.state["armed"]:
            await self.system.action.arm()

        async def find_autopilot_system_id():
            async for message in self.system.mavlink_direct.message("HEARTBEAT"):
                try:
                    fields = json.loads(message.fields_json)
                except (TypeError, json.JSONDecodeError):
                    continue
                if message.component_id == 1 and fields.get("autopilot", 0) != 0:
                    return message.system_id
            raise RuntimeError("Could not identify the connected autopilot system ID.")

        try:
            target_system_id = await asyncio.wait_for(find_autopilot_system_id(), timeout=5)
        except asyncio.TimeoutError as error:
            raise RuntimeError("Timed out while identifying the connected autopilot.") from error

        start = time.perf_counter()
        await self.system.mavlink_direct.send_message(
            MavlinkMessage(
                message_name="SET_MODE",
                system_id=0,
                component_id=0,
                target_system_id=target_system_id,
                target_component_id=0,
                fields_json=json.dumps({
                    "target_system": target_system_id,
                    "base_mode": 1,
                    "custom_mode": 3,
                }),
            )
        )
        for _ in range(50):
            if str(self.state["flight_mode"]).upper().split(".")[-1] == "MISSION":
                return round((time.perf_counter() - start) * 1000, 1)
            await asyncio.sleep(0.1)
        raise RuntimeError("Autopilot did not enter mission mode after the start command.")

    async def pause_mission(self):
        # Pause the raw mission.
        return await self._timed(self.system.mission_raw.pause_mission())
    async def goto(self, lat: float, lon: float, alt: float, yaw_deg: float = float("nan")):
        """
        Fly directly to one lat/lon/alt point in GUIDED mode (no mission upload
        needed). This is the MAVSDK equivalent of DroneKit's simple_goto() and
        is what the command-sequence runner below uses for single-point moves.
        """
        return await self._timed(self.system.action.goto_location(lat, lon, alt, yaw_deg))

    # ---------- DroneKit-style command sequences ----------
    # A "sequence" is an ordered list of steps, e.g.:
    #   [{"action": "arm"}, {"action": "takeoff", "params": {"altitude_m": 10}},
    #    {"action": "goto", "params": {"lat": .., "lon": .., "alt": 10}},
    #    {"action": "wait", "params": {"seconds": 5}}, {"action": "land"}]
    # This is the "custom block of commands" pattern from DroneKit (connect,
    # then call methods in order) reimplemented as data the frontend/Aruco
    # script can POST, rather than a Python script the operator has to write
    # and run by hand. Execution stops at the first failed step — this is a
    # safety choice, not an oversight: continuing after a failed arm/takeoff
    # on real hardware is how "bay sai la chet" scenarios happen.
    async def run_sequence(self, steps: list[dict]) -> list[dict]:
        results = []
        for i, step in enumerate(steps):
            action = step.get("action")
            params = step.get("params", {})
            try:
                if action == "arm":
                    elapsed = await self.arm()
                elif action == "disarm":
                    elapsed = await self.disarm()
                elif action == "takeoff":
                    elapsed = await self.takeoff(params.get("altitude_m", 10.0))
                elif action == "goto":
                    elapsed = await self.goto(params["lat"], params["lon"], params.get("alt", 10.0))
                elif action == "land":
                    elapsed = await self.land()
                elif action == "rtl":
                    elapsed = await self.rtl()
                elif action == "hold":
                    elapsed = await self.hold()
                elif action == "wait":
                    start = time.perf_counter()
                    await asyncio.sleep(params.get("seconds", 1))
                    elapsed = round((time.perf_counter() - start) * 1000, 1)
                else:
                    results.append({"step": i, "action": action, "success": False, "message": "Unknown action"})
                    break
                results.append({"step": i, "action": action, "success": True, "latency_ms": elapsed})
            except Exception as e:
                results.append({"step": i, "action": action, "success": False, "message": str(e)})
                break  # stop the sequence on first failure — see docstring above
        return results


class VehicleManager:
    """Manages the full fleet of UAVs for the system."""

    def __init__(self, uav_configs: dict[str, str]):
        self.vehicles: dict[str, Vehicle] = {
            uid: Vehicle(uid, url, mavsdk_port=50051 + index)
            for index, (uid, url) in enumerate(uav_configs.items())
        }

    async def connect_all(self):
        await asyncio.gather(*(v.connect() for v in self.vehicles.values()))

    def get(self, uav_id: str) -> Vehicle:
        if uav_id not in self.vehicles:
            raise KeyError(f"UAV '{uav_id}' not found")
        return self.vehicles[uav_id]

    def all_states(self) -> list[dict]:
        return [v.state for v in self.vehicles.values()]