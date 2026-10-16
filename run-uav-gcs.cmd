@echo off
setlocal

REM Start backend in WSL and frontend with the Windows Python used in CMD.
start "UAV GCS Backend" wsl.exe -d Ubuntu-22.04 -- bash -lc "cd /mnt/d/A_uav-webgcs/uav-webgcs/uav-webgcs/apps/backend && source venv/bin/activate && uvicorn app.main:app --host 0.0.0.0 --port 8000"
start "UAV GCS Frontend" python3 -m http.server 5500 --directory "%~dp0apps\frontend"

timeout /t 3 /nobreak >nul
start "" "http://localhost:5500"

endlocal
