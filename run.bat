@echo off
REM LokiDoki Layer 0 (Windows) — thin interpreter probe. The real
REM installer is the stdlib wizard at ``python -m lokidoki.bootstrap``;
REM this script just ensures a Python 3.8+ interpreter is available so
REM Layer 1 can start.
setlocal enabledelayedexpansion
cd /d "%~dp0"

set PY=
if exist ".lokidoki\python\python.exe" (
    set "PY=.lokidoki\python\python.exe"
) else (
    where py >nul 2>nul && set "PY=py -3"
    if "!PY!"=="" (
        where python >nul 2>nul && set "PY=python"
    )
)
if "!PY!"=="" (
    echo LokiDoki needs Python to start.
    echo Install Python 3.11+ from https://www.python.org/downloads/windows/
    echo ^(tick "Add Python to PATH" during install^), then rerun run.bat.
    choice /c YN /m "Open the download page now"
    if not errorlevel 2 start https://www.python.org/downloads/windows/
    exit /b 1
)

!PY! -c "import sys; sys.exit(0 if sys.version_info >= (3,8) else 1)"
if errorlevel 1 (
    echo Python 3.8+ required.
    !PY! --version
    exit /b 1
)

set VIRTUAL_ENV=

REM Clear any stale Layer 1 server and anything holding :8000.
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8000 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>nul
taskkill /F /FI "WINDOWTITLE eq lokidoki-bootstrap" >nul 2>nul
timeout /t 1 /nobreak >nul

title lokidoki-bootstrap
!PY! -m lokidoki.bootstrap %*
