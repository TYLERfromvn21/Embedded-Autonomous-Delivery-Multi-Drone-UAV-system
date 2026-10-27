"""Backend configuration for UAV links, cameras, and operational defaults.

Edit UAV_NETWORK_CONFIGS to change a vehicle's IP, MAVLink listen port, or
MediaMTX camera endpoint. The URL dictionaries below are derived from it.
"""

import os


# Per-UAV network endpoints. Update each IP to the address reachable from the
# browser; camera ports and paths can differ between vehicles.
UAV_NETWORK_CONFIGS = {
    "uav1": {
        "ip": "172.20.10.4",
        "mavlink_listen_port": 14550,
        "camera_port": 8889,
        "camera_path": "/cam/",
    },
    "uav2": {
        "ip": "172.20.10.5",  # Replace with UAV2's actual address.
        "mavlink_listen_port": 14541,
        "camera_port": 8889,
        "camera_path": "/cam/",
    },
    "uav3": {
        "ip": "172.20.10.4",  # Replace with UAV3's actual address.
        "mavlink_listen_port": 14542,
        "camera_port": 8889,
        "camera_path": "/cam/",
    },
}

# MAVSDK listens on UDP ports belonging to the backend host. The UAV IP above
# is for its camera URL; it must not replace 0.0.0.0, which is the local bind
# address receiving MAVLink packets. UAV*_URL can override a vehicle link.
UAV_CONFIGS = {
    uav_id: os.environ.get(
        f"{uav_id.upper()}_URL",
        f"udp://{settings['ip']}:{settings['mavlink_listen_port']}",
    )
    for uav_id, settings in UAV_NETWORK_CONFIGS.items()
}

# Browser camera URLs are generated automatically from the settings above.
UAV_CAMERA_URLS = {
    uav_id: f"http://{settings['ip']}:{settings['camera_port']}{settings['camera_path']}"
    for uav_id, settings in UAV_NETWORK_CONFIGS.items()
}

# Server bind defaults for the launcher/deployment configuration.
HOST = os.environ.get("GCS_HOST", "0.0.0.0")
PORT = int(os.environ.get("GCS_PORT", "8000"))

# WebSocket broadcast cadence in seconds. Consumed by main.py and routers/ws.py.
TELEMETRY_BROADCAST_INTERVAL_S = 0.5
# Mark a UAV offline after this many seconds without MAVSDK telemetry.
TELEMETRY_TIMEOUT_S = 5.0

# Flight-warning thresholds based on NED velocity telemetry.
VERTICAL_DESCENT_WARNING_M_S = float(os.environ.get("VERTICAL_DESCENT_WARNING_M_S", "-10.0"))
HORIZONTAL_SPEED_WARNING_M_S = float(os.environ.get("HORIZONTAL_SPEED_WARNING_M_S", "20.0"))

# Pilot and mission defaults/validation limits.
DEFAULT_TAKEOFF_ALTITUDE_M = 3.0
DEFAULT_WAYPOINT_ALTITUDE_M = 3.0
DEFAULT_FLIGHT_SPEED_M_S = 4.0
MIN_ALTITUDE_M = 1.0
MAX_ALTITUDE_M = 120.0
MIN_FLIGHT_SPEED_M_S = 0.5
MAX_FLIGHT_SPEED_M_S = 30.0

# Recent autopilot status text is appended to command errors for this duration.
AUTOPILOT_STATUS_MAX_AGE_S = 10.0
