from dronekit import connect

connection_string = "udp:127.0.0.1:14540"

print("Connecting to vehicle on: %s" % connection_string)
vehicle = connect(connection_string, wait_ready=True)

print("GPS: %s" % vehicle.gps_0)
print("Battery: %s" % vehicle.battery)
print("Last Heartbeat: %s" % vehicle.last_heartbeat)
print("Is Armable?: %s" % vehicle.is_armable)
print("System status: %s" % vehicle.system_status.state)
print("Mode: %s" % vehicle.mode.name)

vehicle.close()
print("Completed")