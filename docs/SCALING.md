# Scaling beyond a handful of UAVs

This is the answer to: *"If there were 1000 (or 10,000) UAVs, does each one need its own
port? How would you manage that, and prove it stays stable?"*

## 1. The current demo setup does NOT scale by adding ports

At 3 UAVs, the demo config uses 3 fixed UDP ports (`14540`, `14541`, `14542`). That is fine
for a thesis demo but is explicitly **not** the scaling strategy — it does not extend to
1000 vehicles, and the report should say so directly rather than imply it does.

## 2. Addressing by identity, not by port

Two mechanisms make "one port per vehicle" unnecessary:

- **MAVLink's own multiplexing field.** Every MAVLink packet header carries a `system_id`
  (and `component_id`). A single transport can carry many vehicles' traffic; the receiving
  side demultiplexes by reading this field, not by which port the packet arrived on. This is
  exactly what ArduPilot's own `mavlink-router` tool does: one listening socket, many
  vehicles, packets routed by `system_id`.
- **IP-based addressing over an overlay network.** With the Tailscale/VPN plan already in
  the progress notes, each UAV's companion computer gets one fixed IP inside the mesh
  network. All vehicles can use the *same* well-known port (e.g. `14550`); what
  distinguishes them is the IP, not the port. This is the same principle the internet
  itself scales on — billions of hosts, not billions of ports.

## 3. Backend-side scaling strategy for large fleets

A single Python process is not the end state for 1000+ vehicles. The progression:

1. **Current**: one `VehicleManager` instance, one asyncio event loop, N `Vehicle` objects.
   Because MAVSDK/vehicle I/O is I/O-bound (waiting on network, not CPU), asyncio's
   cooperative concurrency handles far more concurrent connections per process than a
   thread-per-vehicle design would — no OS thread-context-switch overhead per vehicle.
2. **Sharding**: run multiple backend instances, each owning a subset of the fleet (e.g. by
   geographic zone or by UAV ID range), behind a load balancer.
3. **Decoupling telemetry fan-out from vehicle I/O**: instead of each backend instance
   holding the WebSocket connections to every frontend client, publish telemetry to a
   message broker (MQTT topic per UAV, or a Kafka topic) and let any number of frontend-
   facing services subscribe. This is the standard pattern large fleet-management platforms
   (logistics drones, DJI FlightHub-scale systems) use.
4. **Shared state store** (Redis) for fleet-wide queries ("show me all UAVs below 20%
   battery") so no single service needs to hold the entire fleet's state in memory.

## 4. How to actually prove it — methodology, not a claim

A verbal claim of "it scales" is not evidence. The methodology to present in the thesis:

- **Load generation**: spin up N ArduPilot SITL instances in Docker containers (scriptable —
  each container runs `sim_vehicle.py` with a unique instance/sysid), connecting to the
  backend the same way real UAVs would.
- **Metrics to capture** (e.g. with `psutil` on the backend process, or Prometheus +
  Grafana for a nicer chart in the report):
  - CPU and RAM usage of the backend process as N increases (10 → 50 → 200 → …)
  - WebSocket telemetry update latency as N increases (does update rate degrade?)
  - Command round-trip latency under load (see docs/COMMAND_FLOW.md)
  - Reconnection behavior when a fraction of vehicles drop and rejoin
- **Present results as a scaling curve** (a chart: connections on the x-axis vs. CPU/RAM/
  latency on the y-axis) — this is the actual proof, and it's honest about where the current
  implementation's ceiling is, which is more defensible in a defense than an unverified
  claim of arbitrary scale.
- Be upfront in the defense: the 3-UAV demo proves the *architecture is correct*; a scale
  claim beyond that requires the benchmark above, which is a natural "future work" item if
  time doesn't allow running it before the review.
