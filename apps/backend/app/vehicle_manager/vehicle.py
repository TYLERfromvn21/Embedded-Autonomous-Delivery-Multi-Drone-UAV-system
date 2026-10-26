"""Per-UAV connection lifecycle and telemetry cache."""

import asyncio
import json
import logging
import math
import time
from urllib.parse import urlsplit

from mavsdk import System
from app.config import (
    HORIZONTAL_SPEED_WARNING_M_S,
    TELEMETRY_TIMEOUT_S,
    UAV_CAMERA_URLS,
    VERTICAL_DESCENT_WARNING_M_S,
)
from app.vehicle_manager.actions import VehicleActions
from app.vehicle_manager.missions import VehicleMissions
from app.vehicle_manager.modes import VehicleModes
from app.vehicle_manager.parameters import VehicleParameters
from app.vehicle_manager.sequences import VehicleSequences

logger = logging.getLogger(__name__)

# ArduPilot Copter custom_mode values from the MAVLink HEARTBEAT message.
ARDUPILOT_MODE_NAMES = {
    0: "STABILIZE",
    1: "ACRO",
    2: "HOLD",
    3: "AUTO",
    4: "GUIDED",
    5: "LOITER",
    6: "RTL",
    7: "CIRCLE",
    9: "LAND",
    11: "DRIFT",
    13: "SPORT",
    14: "FLIP",
    15: "AUTOTUNE",
    16: "POSHOLD",
    17: "BRAKE",
    18: "THROW",
    19: "AVOID_ADSB",
    20: "GUIDED_NOGPS",
    21: "SMART_RTL",
    22: "FLOWHOLD",
    23: "FOLLOW",
    24: "ZIGZAG",
    25: "SYSTEMID",
    26: "AUTOROTATE",
    27: "AUTO_RTL",
    28: "TURTLE",
}

class Vehicle(VehicleActions, VehicleMissions, VehicleModes, VehicleParameters, VehicleSequences):
    """Wrap one MAVSDK System and cache its latest telemetry."""

    def __init__(self, uav_id: str, connection_url: str, mavsdk_port: int):

        self.uav_id = uav_id

        self.connection_url = connection_url

        self.system = System(port=mavsdk_port)

        self._mode_change_lock = asyncio.Lock()
        self._mission_start_lock = asyncio.Lock()
        self._auto_options_lock = asyncio.Lock()
        self._mission_completion_task: asyncio.Task | None = None
        self._mission_sync_lock = asyncio.Lock()
        self._mission_sync_task: asyncio.Task | None = None

        self.connected = False

        self._last_telemetry_at: float | None = None
        self._active_flight_warning_keys: set[str] = set()
        self._seen_telemetry_streams: set[str] = set()
        self._last_autopilot_status_text: str | None = None
        self._last_autopilot_status_at: float | None = None
        self._last_health_signature: tuple | None = None
        self._last_sys_status_signature: tuple | None = None

        self.state = {

            "uav_id": uav_id,

            "lat": None,

            "lon": None,

            "gps_fix_type": None,

            "gps_satellites": None,

            "alt": None,

            "absolute_alt": None,

            "heading": None,

            "pitch_deg": None,

            "roll_deg": None,

            "vertical_speed_m_s": None,
            "ground_speed_m_s": None,
            "flight_warnings": [],
            "telemetry_streams": [],

            "is_landed": None,

            "battery_percent": None,

            "flight_mode": None,

            "armed": False,

            "connected": False,

            "autopilot": None,

            # camera_url: set this once a companion camera (RPi cam / ESP32-CAM)

            # exposes an MJPEG/RTSP stream, e.g. "http://192.168.1.50:8080/stream".

            # Left as None until that integration is wired up.

            "camera_url": UAV_CAMERA_URLS.get(uav_id),

            # waypoints: restored from the autopilot on connection/reconnection and

            # refreshed after mission upload or clear for display in the Fleet tab.

            "waypoints": [],

        }

        self._tasks = []
        self._shutting_down = False

    async def shutdown(self):

        """Stop telemetry subscriptions and the MAVSDK server process."""

        self._shutting_down = True
        tasks, self._tasks = self._tasks, []

        for task in tasks:

            task.cancel()

        if tasks:

            await asyncio.gather(*tasks, return_exceptions=True)

        # MAVSDK-Python currently has no public async close method. Its System

        # implementation exposes this cleanup method for its child process.

        stop_server = getattr(self.system, "_stop_mavsdk_server", None)

        if stop_server is not None:

            stop_server()

    async def connect(self):

        logger.warning("[%s] Not connected yet; waiting for heartbeat at %s", self.uav_id, self.connection_url)

        await self.system.connect(system_address=self.connection_url)

        async for state in self.system.core.connection_state():

            if state.is_connected:

                self.connected = True

                self.state["connected"] = True

                # Start a grace period at first heartbeat, then refresh it for

                # every value received from any telemetry stream.

                self._last_telemetry_at = time.monotonic()

                parsed_connection = urlsplit(self.connection_url)
                try:
                    local_port = parsed_connection.port
                except ValueError:
                    local_port = None
                endpoint = (
                    f"UDP port {local_port}"
                    if parsed_connection.scheme in {"udp", "udpin", "udpout"} and local_port
                    else f"{parsed_connection.scheme or 'MAVLink'} endpoint"
                )
                logger.warning(
                    "[%s] CONNECTED: heartbeat received via %s (%s)",
                    self.uav_id,
                    self.connection_url,
                    endpoint,
                )

                # Some ArduPilot builds do not stream these messages until the
                # GCS requests rates. Ask for the data used by the dashboard.
                try:
                    system_id = await asyncio.wait_for(self._autopilot_system_id(), timeout=5)
                    await self._request_telemetry_rates(system_id)
                except (asyncio.TimeoutError, RuntimeError):
                    logger.exception("[%s] Could not identify autopilot to request telemetry rates", self.uav_id)

                break

        watchers = [
            ("POSITION", self._watch_position),
            ("BATTERY", self._watch_battery),
            ("FLIGHT_MODE", self._watch_flight_mode),
            ("ARMED", self._watch_armed),
            ("HEADING", self._watch_heading),
            ("ATTITUDE", self._watch_attitude),
            ("VELOCITY", self._watch_vertical_speed),
            ("LANDED_STATE", self._watch_landed_state),
            ("HEARTBEAT", self._watch_autopilot),
            ("RAW_GLOBAL_POSITION_INT", self._watch_raw_position),
            ("RAW_GPS_RAW_INT", self._watch_raw_gps),
            ("RAW_BATTERY_STATUS", self._watch_raw_battery_status),
            ("RAW_SYS_STATUS", self._watch_raw_sys_status),
            ("HEALTH", self._watch_health),
            ("RAW_ATTITUDE", self._watch_raw_attitude),
            ("RAW_VFR_HUD", self._watch_raw_vfr_hud),
            ("STATUSTEXT", self._watch_status_text),
        ]
        self._tasks = [
            asyncio.create_task(self._run_watcher(name, watcher))
            for name, watcher in watchers
        ]
        self._tasks.append(asyncio.create_task(self._watch_telemetry_timeout()))
        self._schedule_mission_sync("initial connection")

    async def _run_watcher(self, name, watcher):
        while not self._shutting_down:
            try:
                await watcher()
                if self._shutting_down:
                    return
                logger.warning("[%s] Telemetry watcher %s ended; restarting", self.uav_id, name)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                if self._shutting_down:
                    return
                rpc_code = getattr(error, "code", None)
                if callable(rpc_code):
                    try:
                        if getattr(rpc_code(), "name", "") == "UNAVAILABLE":
                            logger.warning(
                                "[%s] MAVSDK stream %s closed; retrying its watcher",
                                self.uav_id,
                                name,
                            )
                            await asyncio.sleep(1)
                            continue
                    except Exception:
                        pass
                logger.exception("[%s] Telemetry watcher %s failed; restarting", self.uav_id, name)
            if self._shutting_down:
                return
            await asyncio.sleep(1)

    async def _watch_autopilot(self):

        async for message in self.system.mavlink_direct.message("HEARTBEAT"):

            if message.component_id != 1:
                continue

            try:
                fields = json.loads(message.fields_json)
            except (TypeError, json.JSONDecodeError):
                continue

            autopilot_id = fields.get("autopilot", 0)
            if not autopilot_id:
                continue

            autopilot_value = str(autopilot_id).upper()
            if autopilot_id == 3 or "ARDUPILOT" in autopilot_value:
                autopilot_name = "ArduPilot"
            elif autopilot_id == 12 or "PX4" in autopilot_value:
                autopilot_name = "PX4"
            else:
                autopilot_name = f"MAV_AUTOPILOT_{autopilot_id}"
            if self.state["autopilot"] != autopilot_name:
                self.state["autopilot"] = autopilot_name
                logger.warning(
                    "[%s] AUTOPILOT: %s (system ID %s)",
                    self.uav_id,
                    autopilot_name,
                    message.system_id,
                )
            if autopilot_id == 3:
                try:
                    custom_mode = int(fields.get("custom_mode", -1))
                except (TypeError, ValueError):
                    custom_mode = -1
                mode_name = ARDUPILOT_MODE_NAMES.get(custom_mode)
                if mode_name:
                    self.state["flight_mode"] = mode_name
            self._record_telemetry("HEARTBEAT")

    def _record_telemetry(self, stream: str):
        was_disconnected = not self.connected
        self._last_telemetry_at = time.monotonic()

        if stream not in self._seen_telemetry_streams:
            self._seen_telemetry_streams.add(stream)
            self.state["telemetry_streams"] = sorted(self._seen_telemetry_streams)
            logger.warning(
                "[%s] TELEMETRY: first %s sample received via %s",
                self.uav_id,
                stream,
                self.connection_url,
            )

        if was_disconnected:
            logger.warning("[%s] TELEMETRY: data resumed on %s", self.uav_id, self.connection_url)

        self.connected = True
        self.state["connected"] = True
        if was_disconnected:
            self._schedule_mission_sync("telemetry resumed")

    def _schedule_mission_sync(self, reason: str):
        task = self._mission_sync_task
        if task is not None and not task.done():
            return
        task = asyncio.create_task(self._refresh_mission_from_autopilot(reason))
        self._mission_sync_task = task
        self._tasks.append(task)

    async def _refresh_mission_from_autopilot(self, reason: str):
        for attempt in range(3):
            try:
                async with self._mission_sync_lock:
                    await self.sync_mission_from_autopilot()
                return
            except asyncio.CancelledError:
                raise
            except Exception:
                if attempt == 2:
                    logger.warning(
                        "[%s] Could not sync stored mission after %s; keeping the last known waypoint list",
                        self.uav_id,
                        reason,
                        exc_info=True,
                    )
                    return
                logger.info(
                    "[%s] Mission sync after %s failed; retrying (%s/3)",
                    self.uav_id,
                    reason,
                    attempt + 2,
                )
                await asyncio.sleep(1)

    async def _watch_telemetry_timeout(self):

        while True:

            await asyncio.sleep(min(TELEMETRY_TIMEOUT_S / 5, 1.0))

            last = self._last_telemetry_at

            if self.connected and last is not None and time.monotonic() - last > TELEMETRY_TIMEOUT_S:

                self.connected = False

                self.state["connected"] = False

                logger.error("[%s] DISCONNECTED: no telemetry for %.1f seconds", self.uav_id, TELEMETRY_TIMEOUT_S)
                self.state["flight_warnings"] = []
                self._active_flight_warning_keys.clear()

    async def _watch_position(self):

        async for pos in self.system.telemetry.position():

            self._record_telemetry("POSITION")

            self._set_position(pos.latitude_deg, pos.longitude_deg)

            self._set_relative_altitude(pos.relative_altitude_m)

            self.state["absolute_alt"] = pos.absolute_altitude_m

    async def _watch_battery(self):

        async for battery in self.system.telemetry.battery():

            self._record_telemetry("BATTERY")

            remaining = float(battery.remaining_percent)
            if math.isfinite(remaining) and 0 <= remaining <= 100:
                self.state["battery_percent"] = round(remaining, 1)

    async def _watch_flight_mode(self):

        async for mode in self.system.telemetry.flight_mode():

            self._record_telemetry("FLIGHT_MODE")

            mode_name = str(mode).split(".")[-1].upper()
            # MAVSDK may report UNKNOWN for ArduPilot custom modes. The raw
            # HEARTBEAT watcher supplies the actual ArduCopter mode instead.
            if mode_name != "UNKNOWN":
                self.state["flight_mode"] = mode_name

    async def _watch_armed(self):

        async for armed in self.system.telemetry.armed():

            self._record_telemetry("ARMED")

            self.state["armed"] = armed

    async def _watch_heading(self):

        async for heading in self.system.telemetry.heading():

            self._record_telemetry("HEADING")

            self.state["heading"] = heading.heading_deg

    async def _watch_attitude(self):

        async for attitude in self.system.telemetry.attitude_euler():

            self._record_telemetry("ATTITUDE")

            self.state["pitch_deg"] = attitude.pitch_deg

            self.state["roll_deg"] = attitude.roll_deg

    async def _watch_vertical_speed(self):

        async for velocity in self.system.telemetry.position_velocity_ned():

            self._record_telemetry("VELOCITY")

            vertical_speed = -velocity.velocity.down_m_s
            ground_speed = math.hypot(velocity.velocity.north_m_s, velocity.velocity.east_m_s)
            self.state["vertical_speed_m_s"] = vertical_speed
            self.state["ground_speed_m_s"] = ground_speed
            self._update_flight_warnings(vertical_speed, ground_speed)


    def _update_flight_warnings(self, vertical_speed: float, ground_speed: float):
        warning_messages = {}
        if math.isfinite(vertical_speed) and vertical_speed <= VERTICAL_DESCENT_WARNING_M_S:
            warning_messages["rapid_descent"] = (
                f"Severe descent detected: {vertical_speed:.1f} m/s vertical speed. "
                "The aircraft may be falling."
            )
        if math.isfinite(ground_speed) and ground_speed >= HORIZONTAL_SPEED_WARNING_M_S:
            warning_messages["high_speed"] = (
                f"High ground speed detected: {ground_speed:.1f} m/s "
                f"(limit: {HORIZONTAL_SPEED_WARNING_M_S:.1f} m/s)."
            )

        current_keys = set(warning_messages)
        for key in current_keys - self._active_flight_warning_keys:
            logger.error("[%s] FLIGHT WARNING: %s", self.uav_id, warning_messages[key])
        for key in self._active_flight_warning_keys - current_keys:
            logger.info("[%s] FLIGHT WARNING CLEARED: %s", self.uav_id, key)

        self._active_flight_warning_keys = current_keys
        self.state["flight_warnings"] = list(warning_messages.values())

    async def _watch_landed_state(self):
        async for landed_state in self.system.telemetry.landed_state():

            self._record_telemetry("LANDED_STATE")

            self.state["is_landed"] = str(landed_state).split(".")[-1] == "ON_GROUND"
        
            if self.state["is_landed"] and self.state["alt"] is not None and self.state["alt"] < 0:
                self.state["alt"] = 0.0

    async def _watch_raw_position(self):
        async for message in self.system.mavlink_direct.message("GLOBAL_POSITION_INT"):
            fields = self._message_fields(message)
            if fields is None:
                continue
            try:
                latitude = float(fields["lat"]) / 1e7
                longitude = float(fields["lon"]) / 1e7
                self._set_position(latitude, longitude)
                self.state["absolute_alt"] = float(fields["alt"]) / 1000
                self._set_relative_altitude(float(fields["relative_alt"]) / 1000)
                heading = int(fields.get("hdg", 65535))
                if heading != 65535:
                    self.state["heading"] = heading / 100
                self._record_telemetry("RAW_GLOBAL_POSITION_INT")
            except (KeyError, TypeError, ValueError):
                logger.debug("[%s] Invalid GLOBAL_POSITION_INT fields: %s", self.uav_id, fields)

    def _set_position(self, latitude: float, longitude: float):
        if (
            math.isfinite(latitude)
            and math.isfinite(longitude)
            and -90 <= latitude <= 90
            and -180 <= longitude <= 180
            and (latitude != 0 or longitude != 0)
        ):
            self.state["lat"] = latitude
            self.state["lon"] = longitude
        else:
            # ArduPilot reports 0,0 while GPS has no usable position. Do not
            # display that as a real location or move the map to the equator.
            self.state["lat"] = None
            self.state["lon"] = None

    def _set_relative_altitude(self, altitude: float):
        if not math.isfinite(altitude):
            return
        # Relative altitude can fluctuate slightly below home while on the
        # ground. Show ground level instead of a misleading negative value.
        if altitude < 0 and (self.state["is_landed"] is True or not self.state["armed"]):
            altitude = 0.0
        self.state["alt"] = altitude

    async def _watch_raw_gps(self):
        async for message in self.system.mavlink_direct.message("GPS_RAW_INT"):
            fields = self._message_fields(message)
            if fields is None:
                continue
            try:
                self.state["gps_fix_type"] = int(fields.get("fix_type", 0))
                self.state["gps_satellites"] = int(fields.get("satellites_visible", 0))
                self._record_telemetry("RAW_GPS_RAW_INT")
            except (TypeError, ValueError):
                logger.debug("[%s] Invalid GPS_RAW_INT fields: %s", self.uav_id, fields)

    async def _watch_raw_battery_status(self):
        async for message in self.system.mavlink_direct.message("BATTERY_STATUS"):
            fields = self._message_fields(message)
            if fields is None:
                continue
            try:
                remaining = int(fields.get("battery_remaining", -1))
            except (TypeError, ValueError):
                continue
            if 0 <= remaining <= 100:
                self.state["battery_percent"] = remaining
                self._record_telemetry("RAW_BATTERY_STATUS")

    async def _watch_raw_sys_status(self):
        async for message in self.system.mavlink_direct.message("SYS_STATUS"):
            fields = self._message_fields(message)
            if fields is None:
                continue
            try:
                remaining = int(fields.get("battery_remaining", -1))
                voltage_mv = int(fields.get("voltage_battery", 65535))
                current_cA = int(fields.get("current_battery", -1))
                sensors_present = int(fields.get("onboard_control_sensors_present", 0))
                sensors_enabled = int(fields.get("onboard_control_sensors_enabled", 0))
                sensors_health = int(fields.get("onboard_control_sensors_health", 0))
            except (TypeError, ValueError):
                continue
            if 0 <= remaining <= 100:
                self.state["battery_percent"] = remaining
            self._record_telemetry("RAW_SYS_STATUS")

            signature = (voltage_mv, current_cA, remaining, sensors_present, sensors_enabled, sensors_health)
            if signature != self._last_sys_status_signature:
                self._last_sys_status_signature = signature
                voltage = f"{voltage_mv / 1000:.2f} V" if voltage_mv != 65535 else "unknown"
                current = f"{current_cA / 100:.2f} A" if current_cA >= 0 else "unknown"
                battery = f"{remaining}%" if 0 <= remaining <= 100 else "unknown"
                logger.warning(
                    "[%s] SYS_STATUS: battery=%s, voltage=%s, current=%s, "
                    "sensors present/enabled/healthy=0x%08x/0x%08x/0x%08x",
                    self.uav_id,
                    battery,
                    voltage,
                    current,
                    sensors_present,
                    sensors_enabled,
                    sensors_health,
                )

    async def _watch_health(self):
        """Log MAVSDK's arming readiness and health checks when they change."""
        async for health in self.system.telemetry.health():
            self._record_telemetry("HEALTH")
            checks = {
                "gyrometer calibration": health.is_gyrometer_calibration_ok,
                "accelerometer calibration": health.is_accelerometer_calibration_ok,
                "magnetometer calibration": health.is_magnetometer_calibration_ok,
                "local position": health.is_local_position_ok,
                "global position": health.is_global_position_ok,
                "home position": health.is_home_position_ok,
            }
            armable = bool(health.is_armable)
            signature = (armable, *(bool(value) for value in checks.values()))
            if signature == self._last_health_signature:
                continue
            self._last_health_signature = signature
            not_ready = [name for name, ready in checks.items() if not ready]
            if armable:
                logger.warning("[%s] ARM CHECK: READY (MAVSDK health reports armable)", self.uav_id)
            else:
                reason = ", ".join(not_ready) if not_ready else "autopilot reports not armable"
                logger.warning("[%s] ARM CHECK: NOT READY (%s)", self.uav_id, reason)

    async def _watch_raw_attitude(self):
        async for message in self.system.mavlink_direct.message("ATTITUDE"):
            fields = self._message_fields(message)
            if fields is None:
                continue
            try:
                self.state["roll_deg"] = math.degrees(float(fields["roll"]))
                self.state["pitch_deg"] = math.degrees(float(fields["pitch"]))
                yaw_deg = math.degrees(float(fields["yaw"])) % 360
                self.state["heading"] = yaw_deg
                self._record_telemetry("RAW_ATTITUDE")
            except (KeyError, TypeError, ValueError):
                logger.debug("[%s] Invalid ATTITUDE fields: %s", self.uav_id, fields)

    async def _watch_raw_vfr_hud(self):
        async for message in self.system.mavlink_direct.message("VFR_HUD"):
            fields = self._message_fields(message)
            if fields is None:
                continue
            try:
                self.state["ground_speed_m_s"] = float(fields["groundspeed"])
                if self.state["alt"] is None:
                    self._set_relative_altitude(float(fields["alt"]))
                self.state["vertical_speed_m_s"] = float(fields["climb"])
                self.state["heading"] = float(fields["heading"])
                self._record_telemetry("RAW_VFR_HUD")
            except (KeyError, TypeError, ValueError):
                logger.debug("[%s] Invalid VFR_HUD fields: %s", self.uav_id, fields)

    async def _request_telemetry_rates(self, system_id: int):
        """Request 2 Hz for dashboard MAVLink messages from the autopilot."""
        from mavsdk.mavlink_direct import MavlinkMessage

        # MAV_CMD_SET_MESSAGE_INTERVAL (511), message IDs defined by MAVLink.
        for message_id in (1, 24, 30, 33, 74, 147, 245):
            try:
                await self.system.mavlink_direct.send_message(
                    MavlinkMessage(
                        message_name="COMMAND_LONG",
                        system_id=0,
                        component_id=0,
                        target_system_id=system_id,
                        target_component_id=1,
                        fields_json=json.dumps({
                            "target_system": system_id,
                            "target_component": 1,
                            "command": 511,
                            "confirmation": 0,
                            "param1": message_id,
                            "param2": 500000,
                            "param3": 0,
                            "param4": 0,
                            "param5": 0,
                            "param6": 0,
                            "param7": 0,
                        }),
                    )
                )
            except Exception:
                logger.exception(
                    "[%s] Could not request MAVLink message %s at 2 Hz",
                    self.uav_id,
                    message_id,
                )

    async def _autopilot_system_id(self) -> int:
        async for message in self.system.mavlink_direct.message("HEARTBEAT"):
            fields = self._message_fields(message)
            try:
                autopilot_id = int(fields.get("autopilot", 0)) if fields else 0
            except (TypeError, ValueError):
                continue
            if message.component_id == 1 and autopilot_id != 0:
                return message.system_id
        raise RuntimeError("No autopilot heartbeat received")

    async def _watch_status_text(self):
        async for message in self.system.mavlink_direct.message("STATUSTEXT"):
            fields = self._message_fields(message)
            if fields is None:
                continue
            text = str(fields.get("text", "")).strip("\x00 \t\r\n")
            if text:
                if text != self._last_autopilot_status_text:
                    logger.warning("[%s] AUTOPILOT STATUS: %s", self.uav_id, text)
                self._last_autopilot_status_text = text
                self._last_autopilot_status_at = time.monotonic()
                self._record_telemetry("STATUSTEXT")

    @staticmethod
    def _message_fields(message):
        try:
            return json.loads(message.fields_json)
        except (TypeError, json.JSONDecodeError):
            return None
