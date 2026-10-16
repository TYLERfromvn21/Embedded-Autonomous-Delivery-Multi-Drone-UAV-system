# UAV Web GCS

A browser based ground control station for monitoring and controlling a small UAV fleet. The project contains a FastAPI/MAVSDK backend and a JavaScript frontend served as static files.

## Project structure

```text
apps/
  backend/
    app/
      main.py                 FastAPI application and startup/shutdown lifecycle
      config.py               UAV connection URLs and server settings
      vehicle_manager.py      MAVSDK connections, telemetry, and vehicle actions
      routers/                REST and WebSocket routes
    mock_server.py            Simulated backend for frontend previews
    requirements.txt
  frontend/
    index.html
    css/styles.css
    js/                       Frontend state, API client, map, and views
  dronekit/                   Standalone DroneKit example
docs/                         Architecture and design notes
how to run web.txt             Local SITL and web launch commands
```

## Requirements

- Python 3.10 or newer
- WSL/Linux is recommended for the ArduPilot SITL instructions below
- ArduPilot SITL, if you want to connect simulated vehicles

## Run with ArduPilot SITL

Open a WSL terminal and start each simulated UAV in its own terminal. If needed, enter the Ubuntu distribution first with `wsl -d ubuntu-22.04` from Windows PowerShell.

```bash
cd ~/ardupilot/ArduCopter
../Tools/autotest/sim_vehicle.py -v ArduCopter -I0 --sysid=1 --out=udp:127.0.0.1:14540
```

```bash
cd ~/ardupilot/ArduCopter
../Tools/autotest/sim_vehicle.py -v ArduCopter -I1 --sysid=2 --out=udp:127.0.0.1:14541
```

```bash
cd ~/ardupilot/ArduCopter
../Tools/autotest/sim_vehicle.py -v ArduCopter -I2 --sysid=3 --out=udp:127.0.0.1:14542
```

In another WSL terminal, configure the backend to listen on the same ports, then install and run it:

```bash
cd /path/to/uav-webgcs/apps/backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

export UAV1_URL="udpin://0.0.0.0:14540"
export UAV2_URL="udpin://0.0.0.0:14541"
export UAV3_URL="udpin://0.0.0.0:14542"
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Replace `/path/to/uav-webgcs` with the actual repository path. The backend can start before the SITL vehicles are ready; it connects in the background as heartbeats arrive. You can also configure the connection URLs in `apps/backend/app/config.py` instead of setting environment variables. The defaults in that file must match the ports used by your simulator or hardware.

## Run the frontend

In another terminal, serve the frontend over HTTP. Do not open `index.html` directly as a `file://` URL because the browser blocks its JavaScript modules.

```bash
cd /path/to/uav-webgcs/apps/frontend
python3 -m http.server 5500
```

Open [http://localhost:5500](http://localhost:5500). The frontend uses the backend at `http://localhost:8000`.

## Preview without SITL

The mock server provides sample telemetry for frontend development and does not require MAVSDK or a vehicle connection. Run it instead of the real backend:

```bash
cd /path/to/uav-webgcs/apps/backend
source venv/bin/activate
uvicorn mock_server:app --host 0.0.0.0 --port 8000 --reload
```

Then run the frontend using the static server command above. Do not run the mock and real backend on the same port at the same time.

## API and configuration

- Interactive REST API documentation: [http://localhost:8000/docs](http://localhost:8000/docs)
- Telemetry WebSocket: `ws://localhost:8000/ws/telemetry`
- UAV endpoints and server host/port are configured in `apps/backend/app/config.py`.
- `UAV1_URL`, `UAV2_URL`, and `UAV3_URL` environment variables override the configured connection URLs.
- For serial hardware, use a MAVSDK serial URL such as `serial:///dev/ttyUSB0:57600` and ensure the device and baud rate match your flight controller.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Scaling](docs/SCALING.md)
- [Command flow](docs/COMMAND_FLOW.md)
- [Route conflict model](docs/ROUTE_CONFLICT_MODEL.md)
