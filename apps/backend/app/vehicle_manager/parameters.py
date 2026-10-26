"""ArduPilot parameter access and verified AUTO_OPTIONS updates."""


AUTO_OPTIONS_PARAMETER = "AUTO_OPTIONS"
AUTO_OPTIONS_ALLOW_ARM_IN_AUTO = 1 << 0
AUTO_OPTIONS_TAKEOFF_WITHOUT_THROTTLE = 1 << 1


def _snap_rtl_step(value: float) -> float:
    """Snap tenths down through .3 and up from .4 to a 0.5 step."""
    tenths = round(float(value) * 10)
    return ((tenths + 1) // 5) * 0.5


class VehicleParameters:
    """Read and update autopilot parameters without overwriting unrelated bits."""

    def _require_ardupilot(self):
        if self.state.get("autopilot") != "ArduPilot":
            raise RuntimeError("AUTO_OPTIONS is only available for ArduPilot vehicles.")

    async def get_auto_options(self) -> int:
        self._require_ardupilot()
        return int(await self.system.param.get_param_int(AUTO_OPTIONS_PARAMETER))

    async def update_auto_options(
        self,
        allow_arming_in_auto: bool,
        takeoff_without_throttle: bool,
    ) -> int:
        self._require_ardupilot()
        async with self._auto_options_lock:
            current = await self.get_auto_options()
            desired = current
            for bit, enabled in (
                (AUTO_OPTIONS_ALLOW_ARM_IN_AUTO, allow_arming_in_auto),
                (AUTO_OPTIONS_TAKEOFF_WITHOUT_THROTTLE, takeoff_without_throttle),
            ):
                desired = desired | bit if enabled else desired & ~bit

            await self.system.param.set_param_int(AUTO_OPTIONS_PARAMETER, desired)
            confirmed = await self.get_auto_options()
            if confirmed != desired:
                raise RuntimeError(
                    f"AUTO_OPTIONS read-back was {confirmed}; requested {desired}."
                )
            return confirmed


    async def set_rtl_altitude(self, altitude_m: float) -> float:
        """Snap RTL_ALT_M by the configured tenth-to-half-meter policy and verify it."""
        self._require_ardupilot()
        parameter = "RTL_ALT_M"
        rtl_altitude_m = _snap_rtl_step(altitude_m)
        await self.system.param.set_param_float(parameter, rtl_altitude_m)
        confirmed = float(await self.system.param.get_param_float(parameter))
        if abs(confirmed - rtl_altitude_m) > 0.05:
            raise RuntimeError(
                f"Autopilot reports {parameter}={confirmed:.2f} m; requested snapped value {rtl_altitude_m:.2f} m."
            )
        self.state["rtl_altitude_m"] = confirmed
        return confirmed

    async def set_rtl_speed(self, speed_m_s: float) -> float:
        """Snap RTL_SPEED_MS by the configured tenth-to-half-step policy and verify it."""
        self._require_ardupilot()
        parameter = "RTL_SPEED_MS"
        rtl_speed_m_s = _snap_rtl_step(speed_m_s)
        await self.system.param.set_param_float(parameter, rtl_speed_m_s)
        confirmed = float(await self.system.param.get_param_float(parameter))
        if abs(confirmed - rtl_speed_m_s) > 0.05:
            raise RuntimeError(
                f"Autopilot reports {parameter}={confirmed:.2f} m/s; requested snapped value {rtl_speed_m_s:.2f} m/s."
            )
        self.state["rtl_speed_m_s"] = confirmed
        return confirmed


    async def set_waypoint_speed(self, speed_m_s: float) -> float:
        """Set ArduPilot's mission speed target in meters per second."""
        self._require_ardupilot()
        parameter = "WP_SPD"
        await self.system.param.set_param_float(parameter, float(speed_m_s))
        confirmed = float(await self.system.param.get_param_float(parameter))
        if abs(confirmed - speed_m_s) > 0.05:
            raise RuntimeError(
                f"Autopilot reports {parameter}={confirmed:.2f} m/s; requested {speed_m_s:.2f} m/s."
            )
        self.state["waypoint_speed_m_s"] = confirmed
        return confirmed
