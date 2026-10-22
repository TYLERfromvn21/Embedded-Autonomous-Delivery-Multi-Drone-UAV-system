"""Mission upload, validation, execution, and completion handling."""

import asyncio
import logging
import time

from app.config import DEFAULT_FLIGHT_SPEED_M_S, DEFAULT_WAYPOINT_ALTITUDE_M
from app.vehicle_manager.parameters import (
    AUTO_OPTIONS_ALLOW_ARM_IN_AUTO,
    AUTO_OPTIONS_TAKEOFF_WITHOUT_THROTTLE,
)

logger = logging.getLogger(__name__)

MAV_CMD_NAV_WAYPOINT = 16
MAV_CMD_NAV_TAKEOFF = 22
MAV_CMD_NAV_RETURN_TO_LAUNCH = 20
MISSION_LANDED_STATE_TIMEOUT_S = 60 * 60


class VehicleMissions:
    """Mission-related MAVSDK commands."""

    async def set_auto_options_parameters(self):
        auto_options = await self.get_auto_options()
        if auto_options & AUTO_OPTIONS_TAKEOFF_WITHOUT_THROTTLE:
            return True

        await self.update_auto_options(
            allow_arming_in_auto=bool(auto_options & AUTO_OPTIONS_ALLOW_ARM_IN_AUTO),
            takeoff_without_throttle=True,
        )
        await asyncio.sleep(1)
        auto_options = await self.get_auto_options()
        return bool(auto_options & AUTO_OPTIONS_TAKEOFF_WITHOUT_THROTTLE)


    async def upload_mission(self, waypoints: list[dict]):
        from mavsdk.mission_raw import MissionItem

        if not waypoints:
            raise ValueError("Mission must contain at least one waypoint.")
        if self.state["lat"] is None or self.state["lon"] is None:
            raise RuntimeError("Vehicle has no valid GPS position for mission upload.")
        if self.state["armed"] and self.state["is_landed"] is not True:
            raise RuntimeError("Cannot replace a mission while the UAV is armed in flight.")

        current_lat = int(self.state["lat"] * 10_000_000)
        current_lon = int(self.state["lon"] * 10_000_000)
        mission_items = []
        if self.state.get("autopilot") == "ArduPilot":
            # ArduPilot reserves sequence 0 for the home position.
            mission_items.append(
                MissionItem(
                    seq=0,
                    frame=0,
                    command=MAV_CMD_NAV_WAYPOINT,
                    current=1,
                    autocontinue=1,
                    param1=0.0,
                    param2=0.0,
                    param3=0.0,
                    param4=float("nan"),
                    x=current_lat,
                    y=current_lon,
                    z=float(self.state.get("absolute_alt") or 0.0),
                    mission_type=0,
                )
            )

        mission_items.append(
            MissionItem(
                seq=len(mission_items),
                frame=3,
                command=MAV_CMD_NAV_TAKEOFF,
                current=0 if mission_items else 1,
                autocontinue=1,
                param1=0.0,
                param2=0.0,
                param3=0.0,
                param4=float("nan"),
                x=current_lat,
                y=current_lon,
                z=float(waypoints[0].get("alt", DEFAULT_WAYPOINT_ALTITUDE_M)),
                mission_type=0,
            )
        )

        for waypoint in waypoints:
            mission_items.append(
                MissionItem(
                    seq=len(mission_items),
                    frame=3,
                    command=MAV_CMD_NAV_WAYPOINT,
                    current=0,
                    autocontinue=1,
                    param1=0.0,
                    param2=2.0,
                    param3=0.0,
                    param4=float("nan"),
                    x=int(waypoint["lat"] * 10_000_000),
                    y=int(waypoint["lon"] * 10_000_000),
                    z=float(waypoint.get("alt", DEFAULT_WAYPOINT_ALTITUDE_M)),
                    mission_type=0,
                )
            )

        mission_items.append(
            MissionItem(
                seq=len(mission_items),
                frame=2,
                command=MAV_CMD_NAV_RETURN_TO_LAUNCH,
                current=0,
                autocontinue=1,
                param1=0.0,
                param2=0.0,
                param3=0.0,
                param4=0.0,
                x=0,
                y=0,
                z=0.0,
                mission_type=0,
            )
        )

        self._stop_mission_completion_monitor()
        await self.system.mission_raw.clear_mission()
        elapsed = await self._timed(self.system.mission_raw.upload_mission(mission_items))
        try:
            stored_items = await self.system.mission_raw.download_mission()
        except Exception as error:
            raise RuntimeError(f"Upload was acknowledged, but the stored mission could not be verified: {error}") from error
        if not any(item.command == MAV_CMD_NAV_TAKEOFF for item in stored_items):
            stored_commands = ", ".join(str(item.command) for item in stored_items)
            raise RuntimeError(
                "Upload was acknowledged, but the autopilot did not retain the NAV_TAKEOFF command "
                f"(downloaded commands: {stored_commands or 'none'})."
            )
        self.state["waypoints"] = waypoints
        logger.info("[%s] Uploaded mission with %s waypoint(s)", self.uav_id, len(waypoints))
        return elapsed

    async def clear_mission(self):
        if self.state["armed"] and self.state["is_landed"] is not True:
            raise RuntimeError("Cannot clear the mission while the UAV is armed in flight.")
        self._stop_mission_completion_monitor()
        elapsed = await self._timed(self.system.mission_raw.clear_mission())
        self.state["waypoints"] = []
        logger.info("[%s] Cleared uploaded mission", self.uav_id)
        return elapsed

    async def start_mission(self):
        async with self._mission_start_lock:
            started = time.perf_counter()
            await self._validate_mission_start()

            if self.state["autopilot"] == "ArduPilot":
                await self._start_ardupilot_mission()
            elif self.state["autopilot"] == "PX4":
                await self._start_px4_mission()
            else:
                raise RuntimeError("Autopilot type is unknown; wait for its heartbeat before starting a mission.")

            self._start_mission_completion_monitor()
            return round((time.perf_counter() - started) * 1000, 1)

    async def _validate_mission_start(self):
        if not self.state.get("connected"):
            raise RuntimeError("UAV is not connected.")
        if self.state.get("is_landed") is not True:
            raise RuntimeError("Start Mission is available only while the UAV is confirmed on the ground.")
        if not self._has_valid_gps_position():
            raise RuntimeError("A valid GPS position is required before starting the mission.")
        if self.state.get("gps_fix_type") is not None and self.state["gps_fix_type"] < 3:
            raise RuntimeError("A 3D GPS fix is required before starting the mission.")

        try:
            mission_items = await self.system.mission_raw.download_mission()
        except Exception as error:
            raise RuntimeError(f"Could not verify the uploaded mission: {error}") from error

        takeoff_index = next(
            (index for index, item in enumerate(mission_items) if item.command == MAV_CMD_NAV_TAKEOFF),
            None,
        )
        if takeoff_index is None:
            raise RuntimeError("No mission with a NAV_TAKEOFF command is stored on the autopilot.")
        if not any(
            item.command == MAV_CMD_NAV_WAYPOINT
            for item in mission_items[takeoff_index + 1 :]
        ):
            raise RuntimeError("The stored mission has no waypoint after its takeoff command.")

        self.state["waypoints"] = [
            {
                "lat": item.x / 10_000_000,
                "lon": item.y / 10_000_000,
                "alt": float(item.z),
                "speed_m_s": DEFAULT_FLIGHT_SPEED_M_S,
            }
            for item in mission_items[takeoff_index + 1 :]
            if item.command == MAV_CMD_NAV_WAYPOINT
        ]

        if self.state["autopilot"] == "ArduPilot":
            # try:
            #     auto_options = await self.get_auto_options()
            # except Exception as error:
            #     raise RuntimeError(f"Could not read ArduPilot AUTO_OPTIONS: {error}") from error

            if not await self.set_auto_options_parameters():
                raise RuntimeError(
                "Could not enable AUTO_OPTIONS 'Takeoff without raising throttle'; "
                "the mission was not started."
                )
    
            # if not auto_options & AUTO_OPTIONS_TAKEOFF_WITHOUT_THROTTLE:
            #     raise RuntimeError(
            #         "AUTO_OPTIONS bit 1 is disabled. Enable 'Takeoff without raising throttle' "
            #         "in Actions before starting an automatic takeoff mission."
            #     )

    def _has_valid_gps_position(self) -> bool:
        lat = self.state.get("lat")
        lon = self.state.get("lon")
        return (
            lat is not None
            and lon is not None
            and -90 <= lat <= 90
            and -180 <= lon <= 180
            and (lat != 0 or lon != 0)
        )

    async def _start_ardupilot_mission(self):
        elapsed_ms = 0.0
        current_mode = str(self.state.get("flight_mode") or "").upper().split(".")[-1]
        if current_mode != "GUIDED":
            elapsed_ms += await self.set_flight_mode("GUIDED")

        if not self.state.get("armed"):
            elapsed_ms += await self._timed(self.system.action.arm())
            await self._wait_for_state("armed", True, timeout_s=5)
            await asyncio.sleep(2)
            if not self.state.get("armed"):
                raise RuntimeError("UAV did not remain armed after confirmation; mission was not started.")
            if self.state.get("is_landed") is not True:
                raise RuntimeError("UAV left the ground before AUTO mode was selected; mission was not started.")

        elapsed_ms += await self.set_flight_mode("AUTO")
        # logger.info("[%s] Mission start accepted: armed in GUIDED, then entered AUTO", self.uav_id)
        return elapsed_ms

    async def _start_px4_mission(self):
        if not self.state.get("armed"):
            await self._timed(self.system.action.arm())
            await self._wait_for_state("armed", True, timeout_s=5)
            await asyncio.sleep(2)
            if not self.state.get("armed"):
                raise RuntimeError("UAV did not remain armed after confirmation; mission was not started.")
        await self.set_flight_mode("AUTO")

    async def _wait_for_state(self, key: str, expected, timeout_s: float):
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            if self.state.get(key) == expected:
                return
            await asyncio.sleep(0.1)
        raise RuntimeError(f"Timed out waiting for autopilot state {key}={expected}.")

    def _start_mission_completion_monitor(self):
        task = getattr(self, "_mission_completion_task", None)
        if task is not None and not task.done():
            return
        task = asyncio.create_task(self._watch_mission_completion())
        self._mission_completion_task = task
        self._tasks.append(task)

    def _stop_mission_completion_monitor(self):
        task = getattr(self, "_mission_completion_task", None)
        if task is not None and task is not asyncio.current_task() and not task.done():
            task.cancel()
        self._mission_completion_task = None

    async def _watch_mission_completion(self):
        try:
            async for progress in self.system.mission_raw.mission_progress():
                if progress.total <= 0 or progress.current < progress.total:
                    continue

                logger.info("[%s] Autopilot reported mission completion; waiting for landing", self.uav_id)
                deadline = time.monotonic() + MISSION_LANDED_STATE_TIMEOUT_S
                while time.monotonic() < deadline and not self._shutting_down:
                    if self.state.get("is_landed") is True and not self.state.get("armed"):
                        await self.system.mission_raw.clear_mission()
                        self.state["waypoints"] = []
                        logger.info("[%s] Mission cleared after confirmed landing and disarm", self.uav_id)
                        return
                    await asyncio.sleep(1)
                if not self._shutting_down:
                    logger.warning("[%s] Mission completed but landing/disarm was not confirmed; mission retained", self.uav_id)
                return
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("[%s] Mission completion monitor failed; mission was retained", self.uav_id)

    async def pause_mission(self):
        return await self._timed(self.system.mission_raw.pause_mission())

    async def resume_mission(self):
        if not self.state.get("armed"):
            raise RuntimeError("Cannot resume a mission while the UAV is disarmed.")
        if not self.state.get("connected"):
            raise RuntimeError("UAV is not connected.")
        return await self.set_flight_mode("AUTO")
