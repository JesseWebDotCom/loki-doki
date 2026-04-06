import os
import subprocess
import webbrowser
import time
import sys

def bootstrap():
    """
    Bootstrap the LokiDoki backend and open the browser interface.
    """
    print("💎 Loading LokiDoki Core Services...")
    
    # 1. Dependency Check (uv handle most via 'uv run', but we ensure sync here)
    # Actually, when invoked as 'uv run run.py', uv ensures dependencies are synchronized.
    
    # 2. Start the backend in a separate process
    # We use uvicorn to serve the FastAPI app
    backend_cmd = [
        "python3", "-m", "uvicorn", "lokidoki.main:app", 
        "--host", "127.0.0.1", "--port", "8000", "--reload"
    ]
    
    print("📡 Starting Backend Orchestrator (127.0.0.1:8000)...")
    backend_process = subprocess.Popen(
        backend_cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        env=os.environ.copy()
    )

    # 3. Wait for the server to start (simple polling)
    time.sleep(2) 
    
    # 4. Open the UI (Bootstrap Wizard first)
    ui_url = "http://127.0.0.1:8000/bootstrap"
    print(f"🌐 Launching Bootstrap Wizard: {ui_url}")
    webbrowser.open(ui_url)

    # 5. Keep the main process alive and stream backend logs
    try:
        while True:
            line = backend_process.stdout.readline()
            if not line and backend_process.poll() is not None:
                break
            if line:
                print(f"[API] {line.strip()}")
                
    except KeyboardInterrupt:
        print("\n🛑 Shutting down LokiDoki...")
        backend_process.terminate()
        sys.exit(0)

if __name__ == "__main__":
    bootstrap()
