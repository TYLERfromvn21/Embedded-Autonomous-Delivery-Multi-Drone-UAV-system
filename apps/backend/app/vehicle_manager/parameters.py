"""ArduPilot parameter access and verified AUTO_OPTIONS updates."""


AUTO_OPTIONS_PARAMETER = "AUTO_OPTIONS"
AUTO_OPTIONS_ALLOW_ARM_IN_AUTO = 1 << 0
AUTO_OPTIONS_TAKEOFF_WITHOUT_THROTTLE = 1 << 1


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
