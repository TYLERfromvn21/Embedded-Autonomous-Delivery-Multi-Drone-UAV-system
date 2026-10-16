"""
config.py
---------
Central configuration for the backend. Keeping this separate from main.py
means the fleet list, host and port can be changed in one place, or later
read from environment variables / a .env file without touching app logic.
"""

import os

# Fleet configuration: uav_id -> MAVLink connection URL.
# Listen for MAVLink UDP packets. PiKhawk setup sends to port 14550;
# additional SITL instances use ports 14541 and 14542.
# Real hardware: serial:///dev/ttyUSB0:57600
UAV_CONFIGS = {
    "uav1": os.environ.get("UAV1_URL", "udp://0.0.0.0:14550"),
    #"uav2": os.environ.get("UAV2_URL", "udp://:14541"),
    #"uav3": os.environ.get("UAV3_URL", "udp://:14542"),
}

HOST = os.environ.get("GCS_HOST", "0.0.0.0")
PORT = int(os.environ.get("GCS_PORT", "8000"))

# How often (seconds) the WebSocket broadcaster pushes fleet state to clients.
TELEMETRY_BROADCAST_INTERVAL_S = 0.5
# Mark a UAV offline when no MAVSDK telemetry has arrived for this long.
TELEMETRY_TIMEOUT_S = 5.0

# Alert thresholds based on NED velocity telemetry.
VERTICAL_DESCENT_WARNING_M_S = float(os.environ.get("VERTICAL_DESCENT_WARNING_M_S", "-10.0"))
HORIZONTAL_SPEED_WARNING_M_S = float(os.environ.get("HORIZONTAL_SPEED_WARNING_M_S", "20.0"))
