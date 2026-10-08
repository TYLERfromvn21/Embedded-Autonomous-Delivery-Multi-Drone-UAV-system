# Architecture

## Current setup (3 UAVs, thesis demo scale)

```
UAV 1 ──┐
UAV 2 ──┼── MAVLink (UDP/serial) ── Backend (FastAPI + MAVSDK VehicleManager) ── WebSocket ── Frontend
UAV 3 ──┘                                                                    └── REST API ──┘
```

- Each UAV is one `Vehicle` object (wraps one `mavsdk.System`) inside `VehicleManager`.
- The backend is a single asyncio event loop: every vehicle's telemetry stream and every
  command runs as a concurrent coroutine, not a dedicated OS thread. This is why the same
  process can hold 3 (or, per docs/SCALING.md, far more) live connections without the
  per-connection overhead a thread-per-vehicle model would have.
- The frontend tabs share one WebSocket-fed state object (`state.js`):
  - **Map** — position, attitude/climb telemetry, per-UAV missions and route-conflict estimates
  - **Fleet** — table view: status, position, battery, camera link, current route
  - **Actions** — multi-select + batch command dispatch (`/vehicles/batch/{action}`)
  - **Landing stations** — browser-persisted pad locations and landed-UAV occupancy

Attitude, vertical speed and landed-state fields come from MAVSDK telemetry. Landing station
records are stored in browser local storage and are not connected to station hardware.
Route-conflict assumptions and limitations are documented in
[ROUTE_CONFLICT_MODEL.md](ROUTE_CONFLICT_MODEL.md).

## Why the map previously showed nothing

The map used a fixed `setView()` at a hardcoded coordinate and never moved. If the vehicle's
real GPS position was anywhere else (SITL's default Australia home, or a real Pixhawk's
actual location), the marker rendered far outside the visible viewport — it looked like
"no data", but the data was there.

**Fix**: `map-view.js` now calls `map.fitBounds()` automatically the first time any vehicle
reports a real `lat`/`lon`, framing the whole fleet regardless of where it actually is. This
is driven entirely by the telemetry data, so it works identically for SITL and for a real
MAVLink GPS fix — there is nothing hardcoded to change when you move from simulation to
real hardware.

See docs/SCALING.md and docs/COMMAND_FLOW.md for the fleet-scale and command-latency
questions raised in the progress review.
