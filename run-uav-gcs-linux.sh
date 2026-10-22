# Open first terminal: launch backend
gnome-terminal -- bash -c "
    cd apps/backend;
    uvicorn app.main:app --host 0.0.0.0 --port 8000;
    exec bash
"

sleep 5 # Wait 5 seconds for backend to run

# Open second terminal: launch frontend
gnome-terminal -- bash -c "
    cd apps/frontend
    python3 -m http.server 5500;
    exec bash
"