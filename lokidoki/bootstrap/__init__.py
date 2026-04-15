"""Layer 1 bootstrap — a stdlib-only install wizard.

Runs on any Python 3.8+, imports only the stdlib, and drives the
install pipeline that stands up the embedded Python 3.12 runtime
the FastAPI app (Layer 2) then runs under. The bootstrap UI is
plain HTML/CSS/JS served by ``server.py`` on 127.0.0.1:7861.
"""
