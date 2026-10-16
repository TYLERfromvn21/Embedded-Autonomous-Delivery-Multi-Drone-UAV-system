"""Firmware-aware flight mode commands for ArduPilot and PX4."""

import asyncio
import json
import time

from mavsdk.mavlink_direct import MavlinkMessage


# ArduCopter custom_mode values. HOLD is a user-friendly alias for BRAKE:
# Copter has no flight mode literally named HOLD.
ARDUCOPTER_MODES = {
    "STABILIZE": 0,
    "ACRO": 1,
    "ALT_HOLD": 2,
    "HOLD": 2,
    "AUTO": 3,
    "GUIDED": 4,
    "LOITER": 5,
    "RTL": 6,
    "CIRCLE": 7,
    "LAND": 9,
    "DRIFT": 11,
    "SPORT": 13,
    "FLIP": 14,
    "AUTOTUNE": 15,
    "POSHOLD": 16,
    "BRAKE": 17,
    "THROW": 18,
    "AVOID_ADSB": 19,
    "GUIDED_NOGPS": 20,
    "SMART_RTL": 21,
    "FLOWHOLD": 22,
    "FOLLOW": 23,
    "ZIGZAG": 24,
    "SYSTEMID": 25,
    "AUTOROTATE": 26,
    "AUTO_RTL": 27,
    "TURTLE": 28,
}


class VehicleModes:
    """Set supported ArduCopter modes through MAVLink SET_MODE."""

    async def _autopilot_system_id(self) -> int:
        async for message in self.system.mavlink_direct.message("HEARTBEAT"):
            try:
                fields = json.loads(message.fields_json)
            except (TypeError, json.JSONDecodeError):
                continue
            if message.component_id == 1 and fields.get("autopilot", 0) != 0:
                return message.system_id
        raise RuntimeError("Could not identify the connected autopilot system ID.")

    @staticmethod
    def _mode_matches(requested: str, current: str) -> bool:
        current = current.upper().split(".")[-1]
        if requested in {"AUTO", "MISSION"} and current == "MISSION":
            return True
        if requested == "ALT_HOLD" and current == "HOLD":
            return True
        if requested == "HOLD" and current == "ALT_HOLD":
            return True
        return requested == current

    async def set_flight_mode(self, mode: str) -> float:
        async with self._mode_change_lock:
            return await self._set_flight_mode_locked(mode)

    async def _set_flight_mode_locked(self, mode: str) -> float:
        requested = mode.strip().upper().replace("-", "_")

        autopilot = self.state.get("autopilot")
        if autopilot == "PX4":
            start = time.perf_counter()
            if requested in {"HOLD", "LOITER"}:
                # PX4 exposes one position-hold action; LOITER is an ArduPilot name.
                await self.system.action.hold()
                return round((time.perf_counter() - start) * 1000, 1)
            if requested == "RTL":
                await self.system.action.return_to_launch()
                return round((time.perf_counter() - start) * 1000, 1)
            if requested == "LAND":
                await self.system.action.land()
                return round((time.perf_counter() - start) * 1000, 1)
            if requested in {"AUTO", "MISSION"}:
                await self.system.mission.start_mission()
                return round((time.perf_counter() - start) * 1000, 1)
            raise ValueError(
                f"Mode '{requested}' is not exposed as a safe PX4 mode command. "
                "Supported commands: HOLD, LOITER (PX4 Hold), RTL, LAND."
            )

        if autopilot != "ArduPilot":
            raise RuntimeError("Autopilot type is not known yet; wait for its heartbeat before changing mode.")

        if requested not in ARDUCOPTER_MODES:
            supported = ", ".join(ARDUCOPTER_MODES)
            raise ValueError(f"Unsupported ArduCopter mode '{mode}'. Supported modes: {supported}")

        try:
            system_id = await asyncio.wait_for(self._autopilot_system_id(), timeout=5)
        except asyncio.TimeoutError as error:
            raise RuntimeError("Timed out while identifying the connected autopilot.") from error

        start = time.perf_counter()
        await self.system.mavlink_direct.send_message(
            MavlinkMessage(
                message_name="SET_MODE",
                system_id=0,
                component_id=0,
                target_system_id=system_id,
                target_component_id=0,
                fields_json=json.dumps({
                    "target_system": system_id,
                    "base_mode": 1,  # MAV_MODE_FLAG_CUSTOM_MODE_ENABLED
                    "custom_mode": ARDUCOPTER_MODES[requested],
                }),
            )
        )

        for _ in range(50):
            if self._mode_matches(requested, str(self.state["flight_mode"] or "")):
                return round((time.perf_counter() - start) * 1000, 1)
            await asyncio.sleep(0.1)
        current = self.state["flight_mode"] or "unknown"
        raise RuntimeError(f"Autopilot did not enter {requested} mode (current mode: {current}). Check GPS/sensor requirements and autopilot mode support.")
