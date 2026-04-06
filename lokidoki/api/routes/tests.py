from fastapi import APIRouter, HTTPException
import subprocess
import os
import json
from typing import Dict, Any, Optional
from pydantic import BaseModel

router = APIRouter()

# In-memory storage for the last test run (Phase 1 simplicity)
last_run_results: Dict[str, Any] = {
    "status": "idle",
    "output": "",
    "summary": {},
    "timestamp": None
}

class TestRunResponse(BaseModel):
    status: str
    output: str
    summary: Dict[str, Any]
    timestamp: Optional[str]

class TestRunRequest(BaseModel):
    target: str = "tests"

@router.post("/run", response_model=TestRunResponse)
async def run_tests(request: TestRunRequest = TestRunRequest()):
    """
    Triggers a pytest execution on the codebase and returns the results.
    """
    try:
        # Validate target to prevent arbitrary command injection
        if not request.target.startswith("tests"):
             request.target = "tests"

        process = subprocess.run(
            ["python3", "-m", "pytest", request.target, "-v"],
            capture_output=True,
            text=True,
            cwd=os.getcwd()
        )
        
        status = "passed" if process.returncode == 0 else "failed"
        output = process.stdout + process.stderr
        
        # Simple extraction of summary stats (e.g., "6 passed, 0 failed")
        summary = {"exit_code": process.returncode}
        if "passed" in output:
            summary["details"] = output.split("short test summary info")[-1].strip()
            
        last_run_results.update({
            "status": status,
            "output": output,
            "summary": summary,
            "timestamp": "2026-04-06T11:37:00Z"  # Mock timestamp for now
        })
        
        return last_run_results
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/status")
async def get_test_status():
    """Returns the results of the most recent test run."""
    return {"last_run": last_run_results}
