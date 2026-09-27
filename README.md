# UAV Web GCS

## Project layout

```
uav-webgcs/
├── apps/
│   ├── backend/
│   │   ├── app/
│   │   │   ├── main.py            # FastAPI app, wires everything together
│   │   │   ├── config.py          # fleet config, host/port — edit ports here
│   │   │   ├── vehicle_manager.py # per-UAV MAVSDK connection + telemetry cache
│   │   │   └── routers/
│   │   │       ├── vehicles.py    # /vehicles, single + batch actions
│   │   │       ├── missions.py    # waypoint upload/start
│   │   │       └── ws.py          # /ws/telemetry
│   │   ├── mock_server.py         # standalone fake backend, no SITL needed
│   │   └── requirements.txt
│   └── frontend/
│       ├── index.html
│       ├── css/styles.css
│       └── js/
│           ├── state.js           # shared fleet state
│           ├── api.js             # REST calls
│           ├── ws-client.js       # WebSocket client
│           ├── map-view.js        # Map tab
│           ├── fleet-view.js      # Fleet tab (table)
│           ├── actions-view.js    # Actions tab (batch commands)
│           └── app.js             # entry point, tab switching
└── docs/
    ├── ARCHITECTURE.md
    ├── SCALING.md                 # answers "what about 1000+ UAVs"
    └── COMMAND_FLOW.md            # answers "how fast is a command, prove it"
```

Why this structure instead of one `main.py`/`index.html`: each router and each frontend
view is now a separate file with one job, so multiple people on the team can edit different
parts (e.g. one person on `actions-view.js`, another on `missions.py`) without touching the
same file. This is *not* a full monorepo toolchain (no Turborepo/Nx/pnpm workspaces) — for
a two-app project like this, that tooling adds complexity without adding value. Plain
folders with a clear boundary between `apps/backend` and `apps/frontend` gets the same
maintainability benefit.

## 1. Backend

```bash
cd apps/backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

Edit `app/config.py` to match your SITL/hardware ports, then:

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

(No `--reload` when connected to real SITL/hardware — see the note on UDP port conflicts
in earlier setup notes. `--reload` is fine with `mock_server.py`.)

## 2. Frontend — IMPORTANT: must be served, not opened as a file

The frontend now uses JS modules (`import`/`export`), which browsers block when loaded via
`file://`. You must serve it over HTTP:

```bash
cd apps/frontend
python3 -m http.server 5500
```

Then open `http://localhost:5500` in the browser. Double-clicking `index.html` will show a
blank page with console errors — that's expected, use the server.

## 3. Previewing without SITL

```bash
cd apps/backend
uvicorn mock_server:app --reload --host 0.0.0.0 --port 8000
```

Simulates 3 UAVs flying in circles, with fake camera links and a sample route on `uav1`, so
the Fleet tab has something to show.

## 4. Moving to real hardware

In `app/config.py`, change a UAV's URL from `udp://:14540` to something like
`serial:///dev/ttyUSB0:57600` — no other code changes needed, MAVSDK abstracts the
transport.
