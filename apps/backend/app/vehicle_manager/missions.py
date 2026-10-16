"""Mission upload and execution commands."""



class VehicleMissions:
    """Mission-related MAVSDK commands."""

    async def upload_mission(self, waypoints: list[dict]):

        from mavsdk.mission_raw import MissionItem

        if not waypoints:

            raise ValueError("Mission must contain at least one waypoint.")

        if self.state["lat"] is None or self.state["lon"] is None:

            raise RuntimeError("Vehicle has no valid GPS position for mission upload.")

        mission_items = [

            MissionItem(

                seq=0,

                frame=3,

                command=16,

                current=0,

                autocontinue=1,

                param1=0.0,

                param2=2.0,

                param3=0.0,

                param4=float("nan"),

                x=int(self.state["lat"] * 10000000),

                y=int(self.state["lon"] * 10000000),

                z=0.0,

                mission_type=0,

            ),

            MissionItem(

                seq=1,

                frame=3,

                command=22,  # MAV_CMD_NAV_TAKEOFF

                current=0,

                autocontinue=1,

                param1=0.0,

                param2=0.0,

                param3=0.0,

                param4=float("nan"),

                x=int(self.state["lat"] * 10000000),

                y=int(self.state["lon"] * 10000000),

                z=float(waypoints[0].get("alt", 10.0)),

                mission_type=0,

            ),

        ]

        for i, wp in enumerate(waypoints, start=2):

            mission_items.append(

                MissionItem(

                    seq=i,

                    frame=3,  # MAV_FRAME_GLOBAL_RELATIVE_ALT

                    command=16,  # MAV_CMD_NAV_WAYPOINT

                    current=0,

                    autocontinue=1,

                    param1=0.0,  # Hold time

                    param2=2.0,  # Acceptance radius in meters

                    param3=0.0,

                    param4=float("nan"),  # Yaw angle

                    x=int(wp["lat"] * 10000000),  # MAVLink coordinates are scaled by 10^7

                    y=int(wp["lon"] * 10000000),

                    z=float(wp.get("alt", 10.0)),

                    mission_type=0  # MAV_MISSION_TYPE_MISSION

                )

            )

            

        # Append a return-to-launch command after the route.

        mission_items.append(

            MissionItem(

                seq=len(mission_items),

                frame=2,  # MAV_FRAME_MISSION

                command=20,  # MAV_CMD_NAV_RETURN_TO_LAUNCH

                current=0,

                autocontinue=1,

                param1=0.0, param2=0.0, param3=0.0, param4=0.0,

                x=0, y=0, z=0.0,

                mission_type=0

            )

        )

        # Clear the previous mission before uploading the new one.

        await self.system.mission_raw.clear_mission()

        elapsed = await self._timed(self.system.mission_raw.upload_mission(mission_items))

        

        self.state["waypoints"] = waypoints

        return elapsed

    async def clear_mission(self):

        elapsed = await self._timed(self.system.mission_raw.clear_mission())

        self.state["waypoints"] = []

        return elapsed

    async def start_mission(self):
        if not self.state["armed"]:
            await self.system.action.arm()
        return await self.set_flight_mode("AUTO")

    async def pause_mission(self):

        # Pause the raw mission.

        return await self._timed(self.system.mission_raw.pause_mission())
