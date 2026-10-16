"""Fleet-level vehicle construction and lifecycle."""

import asyncio

from app.vehicle_manager.vehicle import Vehicle

class VehicleManager:
    """Manages the full fleet of UAVs for the system."""

    def __init__(self, uav_configs: dict[str, str]):
        self.vehicles: dict[str, Vehicle] = {
            uid: Vehicle(uid, url, mavsdk_port=50051 + index)
            for index, (uid, url) in enumerate(uav_configs.items())
        }

    async def connect_all(self):
        await asyncio.gather(*(v.connect() for v in self.vehicles.values()))

    async def shutdown(self):
        await asyncio.gather(*(v.shutdown() for v in self.vehicles.values()))

    def get(self, uav_id: str) -> Vehicle:
        if uav_id not in self.vehicles:
            raise KeyError(f"UAV '{uav_id}' not found")
        return self.vehicles[uav_id]

    def all_states(self) -> list[dict]:
        return [v.state for v in self.vehicles.values()]
