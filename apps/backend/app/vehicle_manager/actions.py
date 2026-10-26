"""Flight actions exposed by a Vehicle."""

import time
from app.config import AUTOPILOT_STATUS_MAX_AGE_S, DEFAULT_TAKEOFF_ALTITUDE_M

class VehicleActions:
    """MAVSDK action commands and command timing."""

    async def _timed(self, coro):

        start = time.perf_counter()

        await coro

        return round((time.perf_counter() - start) * 1000, 1)

    async def arm(self):
        try:
            return await self._timed(self.system.action.arm())
        except Exception as error:
            raise RuntimeError(self._with_autopilot_status(str(error))) from error

    async def disarm(self):
        try:
            return await self._timed(self.system.action.disarm())
        except Exception as error:
            raise RuntimeError(self._with_autopilot_status(str(error))) from error

    def _with_autopilot_status(self, message: str) -> str:
        status = getattr(self, "_last_autopilot_status_text", None)
        received_at = getattr(self, "_last_autopilot_status_at", None)
        if status and received_at and time.monotonic() - received_at <= AUTOPILOT_STATUS_MAX_AGE_S:
            return f"{message}; autopilot: {status}"
        return message

    async def takeoff(self, altitude_m: float = DEFAULT_TAKEOFF_ALTITUDE_M):

        # ArduCopter refuses takeoff while disarmed, but MAVSDK's generic error

        # ("FAILED: 'Failed'") doesn't say why. We check first and raise a

        # message that actually tells the operator what to do — deliberately

        # NOT auto-arming here, unlike start_mission(): arming before takeoff

        # should stay an explicit, separate action the operator confirms,

        # especially once this runs on real hardware.

        if not self.state["armed"]:

            raise RuntimeError("Vehicle is not armed. Press Arm first, then Takeoff.")

        await self.set_takeoff_altitude(altitude_m)

        return await self._timed(self.system.action.takeoff())

    async def set_takeoff_altitude(self, altitude_m: float):
        """Set and read back the takeoff-altitude target without arming."""
        started = time.perf_counter()
        await self.system.action.set_takeoff_altitude(altitude_m)
        confirmed_altitude_m = await self.system.action.get_takeoff_altitude()
        if abs(float(confirmed_altitude_m) - altitude_m) > 0.05:
            raise RuntimeError(
                f"Autopilot reports takeoff altitude {float(confirmed_altitude_m):.2f} m; "
                f"requested {altitude_m:.2f} m"
            )
        if self.state.get("autopilot") == "ArduPilot":
            try:
                await self.set_rtl_altitude(altitude_m)
            except Exception as error:
                raise RuntimeError(
                    f"Takeoff altitude was set to {altitude_m:.2f} m, but RTL_ALT_M could not be synchronized: {error}"
                ) from error
        return round((time.perf_counter() - started) * 1000, 1)

    async def land(self):

        return await self._timed(self.system.action.land())

    async def rtl(self):

        return await self._timed(self.system.action.return_to_launch())

    async def hold(self):
        """Select ArduCopter AltHold; use PX4's firmware-aware hold action."""
        if self.state.get("autopilot") == "ArduPilot":
            return await self.set_flight_mode("ALT_HOLD")
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
        if self.state.get("autopilot") == "ArduPilot":
            await self.set_rtl_altitude(altitude_m)

        return await self._timed(self.system.action.goto_location(

            self.state["lat"],

            self.state["lon"],

            target_altitude_msl,

            self.state["heading"] if self.state["heading"] is not None else float("nan"),

        ))

    async def change_speed(self, speed_m_s: float):
        """Save a target speed independently of arm state or flight mode."""
        started = time.perf_counter()
        if self.state.get("autopilot") == "ArduPilot":
            await self.set_waypoint_speed(speed_m_s)
            await self.set_rtl_speed(speed_m_s)
        self.state["target_speed_m_s"] = float(speed_m_s)
        return round((time.perf_counter() - started) * 1000, 1)

    async def goto(self, lat: float, lon: float, alt: float, yaw_deg: float = float("nan")):

        """

        Fly directly to one lat/lon/alt point in GUIDED mode (no mission upload

        needed). This is the MAVSDK equivalent of DroneKit's simple_goto() and

        is what the command-sequence runner below uses for single-point moves.

        """

        return await self._timed(self.system.action.goto_location(lat, lon, alt, yaw_deg))
