"""Ordered flight command sequence execution."""

import asyncio
import time
from app.config import DEFAULT_TAKEOFF_ALTITUDE_M, DEFAULT_WAYPOINT_ALTITUDE_M

class VehicleSequences:
    """Execute ordered actions and stop after the first failed step."""

    async def run_sequence(self, steps: list[dict]) -> list[dict]:

        results = []

        for i, step in enumerate(steps):

            action = step.get("action")

            params = step.get("params", {})

            try:

                if action == "arm":

                    elapsed = await self.arm()

                elif action == "disarm":

                    elapsed = await self.disarm()

                elif action == "takeoff":

                    elapsed = await self.takeoff(params.get("altitude_m", DEFAULT_TAKEOFF_ALTITUDE_M))

                elif action == "goto":

                    elapsed = await self.goto(
                        params["lat"], params["lon"], params.get("alt", DEFAULT_WAYPOINT_ALTITUDE_M)
                    )

                elif action == "land":

                    elapsed = await self.land()

                elif action == "rtl":

                    elapsed = await self.rtl()

                elif action == "hold":

                    elapsed = await self.hold()

                elif action == "wait":

                    start = time.perf_counter()

                    await asyncio.sleep(params.get("seconds", 1))

                    elapsed = round((time.perf_counter() - start) * 1000, 1)

                else:

                    results.append({"step": i, "action": action, "success": False, "message": "Unknown action"})

                    break

                results.append({"step": i, "action": action, "success": True, "latency_ms": elapsed})

            except Exception as e:

                results.append({"step": i, "action": action, "success": False, "message": str(e)})

                break  # stop the sequence on first failure — see docstring above

        return results
