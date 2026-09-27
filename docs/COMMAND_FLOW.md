# Command flow and latency

This is the answer to: *"How does a command reach a specific UAV and come back? Is it fast
enough for real control, and how do you prove that?"*

## 1. The path a command takes

```
Frontend button click
  → HTTP POST to backend (e.g. /vehicles/uav1/arm)
  → Backend calls MAVSDK System.action.arm()
  → MAVSDK encodes a MAVLink COMMAND_LONG message, sends it over the vehicle's
    connection (UDP for SITL, serial for real hardware)
  → Autopilot (ArduPilot) receives it, executes, replies with COMMAND_ACK
  → MAVSDK's coroutine resolves once the ACK arrives
  → Backend returns the HTTP response to the frontend
```

Two different transports are used for two different jobs, deliberately:

- **REST (HTTP POST)** for commands: a command needs a definite success/failure result
  (did the arm actually happen?), which maps naturally onto a request/response call
  that only fires once per user action.
- **WebSocket** for telemetry: continuous, one-directional, high-frequency data (position,
  battery, mode) with no per-message acknowledgement needed — a persistent push channel
  is the right fit, not a REST poll.

## 2. Latency is now measured, not assumed

`Vehicle._timed()` in `vehicle_manager.py` wraps every action call and measures the elapsed
time from calling MAVSDK to receiving the command's result. This number (`latency_ms`) is
returned in every action response and shown in the Actions tab's log. This turns "is it fast
enough" from a claim into something you can point at during the defense: run the command,
show the actual millisecond figure on screen.

## 3. What that number is actually measuring

The reported `latency_ms` covers: backend → MAVSDK → transport → autopilot → ACK → back to
the backend. It does **not** include the frontend → backend network hop (browser to
server), which matters when the person and the UAV are not on the same network — that hop
should be measured separately if the thesis wants an end-to-end number (e.g. time the
`fetch()` call itself in the frontend, from click to response).

## 4. Why this should be fast enough at SITL / LAN scale, and what changes over 4G

- On localhost/SITL or a LAN, the dominant cost is the MAVLink command round-trip itself
  (typically single-digit to low double-digit milliseconds), not network transport.
- Over 4G + Tailscale (per the team's connectivity plan), the dominant cost shifts to
  mobile network latency and jitter, commonly 30–150 ms round-trip depending on signal
  conditions. This is still acceptable for *supervisory* commands (arm, RTL, mission
  upload) where a person or the mission planner is not doing tight closed-loop manual
  control over the link. It is **not** suitable for direct manual stick input over 4G —
  that class of control should stay on a local RC link (as the team's FlySky setup
  already does), with the web system used for mission-level commands and monitoring.

## 5. How to prove it, concretely, for the report

- Log `latency_ms` for every command across a test session (SITL and, once available,
  real hardware over WiFi and over 4G+Tailscale) and report the distribution (min/median/
  p95), not just a single number — network latency varies, and a single sample is not
  evidence.
- Repeat the same test with N vehicles connected simultaneously (see docs/SCALING.md) to
  show whether concurrent load degrades individual command latency — this is what
  demonstrates the asyncio-based backend isn't serializing commands behind each other.
