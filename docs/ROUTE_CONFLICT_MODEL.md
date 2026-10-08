# Route conflict estimate

The map evaluates every pair of UAV routes while a draft waypoint is added and again
before mission upload. A warning is displayed from an estimated probability of at least
5%; upload then requires an explicit confirmation. The route is never silently rejected.

## Geometry and uncertainty

Route segments are projected from latitude/longitude into a local tangent plane and checked
for their closest horizontal points. Relative waypoint altitudes are interpolated at those
points. The displayed estimate treats horizontal error as independent, isotropic Gaussian
error for each UAV:

- GNSS position standard deviation: 5 m per axis
- path-following standard deviation: 3 m per axis
- map waypoint-entry standard deviation: 2 m per axis
- combined per-UAV horizontal standard deviation: `sqrt(5^2 + 3^2 + 2^2)` = 6.2 m
- combined two-UAV horizontal standard deviation: `sqrt(2) * 6.2` = 8.7 m
- vertical standard deviation: 2 m per UAV, combined as `sqrt(2) * 2` = 2.8 m

The horizontal probability uses the radial probability of the separation falling within
10 m for two normally distributed position errors (the non-central chi-square CDF).
The vertical probability uses the normal probability of altitude separation falling within
5 m. The reported estimate is the product of those probabilities at the closest points.

The map-entry assumption approximates a few metres of operator/map click uncertainty; actual
map scale, display density, GNSS quality, airframe dynamics, and autopilot tracking vary.
The system currently has no planned departure-time/speed model, so routes are conservatively
treated as if they can be flown simultaneously. The number is a planning estimate, not a
calibrated real-world collision probability or a safety guarantee. Verify the actual route,
altitudes, timing, and separation independently before flight.

## Live flight data

The attitude instrument uses MAVSDK pitch and roll telemetry. Climb/descent trend comes from
the NED vertical velocity (`-down_m_s`), with a 0.2 m/s deadband. Landing-station occupancy
requires the autopilot to report `ON_GROUND` within 15 m of the station, or a `LAND` mode,
relative altitude at or below 10 m, and position within 15 m.

Landing-station records are stored in the current browser's local storage. Device IDs are
placeholders for a future station-device integration; the current application does not
connect to or control landing-station hardware.

## Map and flight targets

Before live GPS telemetry arrives, the map starts centered on the Ho Chi Minh City
University of Technology campus (`10.7721, 106.6578`). Live fleet GPS positions
automatically take precedence and fit the map to the vehicles.

The per-UAV target altitude defaults to 5 m relative to the takeoff point and is saved in
browser local storage. Takeoff uses this target. Changing altitude commands require an armed
vehicle in GUIDED mode and convert the relative target to the absolute altitude expected by
MAVSDK. The speed target defaults to 5 m/s.

The added actions use supported MAVSDK commands: Auto starts the uploaded mission, Loiter /
Hold uses the autopilot hold action, Resume starts the mission again, Pause pauses it, and
Abort landing commands RTL. Raw sensor display, joystick control, and other Mission Planner
widgets are not exposed because this application does not implement those controls.
