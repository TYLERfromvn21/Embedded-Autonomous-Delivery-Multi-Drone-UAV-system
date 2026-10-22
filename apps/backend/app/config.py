"""Backend configuration for vehicle connections and operational defaults.

Edit this file (or its documented environment overrides) to change backend
parameters. Consumers are noted beside each setting so values are not copied
into routers and vehicle-manager code. Frontend counterparts live in
apps/frontend/js/config.js.
"""

import os

# Fleet configuration: UAV ID -> MAVLink connection URL. Consumed by
# main.py and vehicle_manager/manager.py to construct per-UAV connections.
# Listen for MAVLink UDP packets. PiKhawk setup sends to port 14550;
# additional SITL instances use ports 14541 and 14542.
UAV_CONFIGS = {
    "uav1": os.environ.get("UAV1_URL", "udp://0.0.0.0:14550"),
    # "uav2": os.environ.get("UAV2_URL", "udp://:14541"),
    #"uav3": os.environ.get("UAV3_URL", "udp://:14542"),
}

# Browser-reachable camera URLs (for example, an MJPEG endpoint). Consumed by
# vehicle_manager/vehicle.py and sent with each vehicle state to the frontend.
UAV_CAMERA_URLS = {
    uav_id: os.environ.get(f"{uav_id.upper()}_CAMERA_URL", "").strip() or None
    for uav_id in UAV_CONFIGS
}

#host ip and port for the backend to listen on. Can be overridden with environment variables.
# Server bind defaults for the launcher/deployment configuration.
HOST = os.environ.get("GCS_HOST", "0.0.0.0")
PORT = int(os.environ.get("GCS_PORT", "8000"))

# WebSocket broadcast cadence in seconds. Consumed by main.py and routers/ws.py.
TELEMETRY_BROADCAST_INTERVAL_S = 0.5
# Mark a UAV offline after this many seconds without MAVSDK telemetry.
# Consumed by vehicle_manager/vehicle.py.
TELEMETRY_TIMEOUT_S = 5.0

# Flight-warning thresholds based on NED velocity telemetry. Consumed by
# vehicle_manager/vehicle.py; override with the corresponding environment vars.
VERTICAL_DESCENT_WARNING_M_S = float(os.environ.get("VERTICAL_DESCENT_WARNING_M_S", "-10.0"))
HORIZONTAL_SPEED_WARNING_M_S = float(os.environ.get("HORIZONTAL_SPEED_WARNING_M_S", "20.0"))

# Pilot and mission defaults/validation limits. Consumed by routers/vehicles.py,
# routers/missions.py, and vehicle_manager/actions.py, missions.py, sequences.py.
DEFAULT_TAKEOFF_ALTITUDE_M = 3.0
DEFAULT_WAYPOINT_ALTITUDE_M = 3.0
DEFAULT_FLIGHT_SPEED_M_S = 5.0
MIN_ALTITUDE_M = 1.0
MAX_ALTITUDE_M = 120.0
MIN_FLIGHT_SPEED_M_S = 0.5
MAX_FLIGHT_SPEED_M_S = 30.0

# Recent autopilot status text is appended to command errors for this duration.
# Consumed by vehicle_manager/actions.py.
AUTOPILOT_STATUS_MAX_AGE_S = 10.0
