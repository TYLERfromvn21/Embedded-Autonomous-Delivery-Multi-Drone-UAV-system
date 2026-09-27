"""
config.py
---------
Central configuration for the backend. Keeping this separate from main.py
means the fleet list, host and port can be changed in one place, or later
read from environment variables / a .env file without touching app logic.
"""

import os

# Fleet configuration: uav_id -> MAVLink connection URL.
# SITL default: udp://:<port>. Real hardware: serial:///dev/ttyUSB0:57600
UAV_CONFIGS = {
    "uav1": os.environ.get("UAV1_URL", "udp://:14540"),
    "uav2": os.environ.get("UAV2_URL", "udp://:14541"),
    "uav3": os.environ.get("UAV3_URL", "udp://:14542"),
}

HOST = os.environ.get("GCS_HOST", "0.0.0.0")
PORT = int(os.environ.get("GCS_PORT", "8000"))

# How often (seconds) the WebSocket broadcaster pushes fleet state to clients.
TELEMETRY_BROADCAST_INTERVAL_S = 0.5
