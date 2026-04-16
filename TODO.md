# LokiDoki TODO

## 1. Fix existing mac install issues
- Audit bootstrap installer flow on macOS and resolve current failure modes.
- Verify `run.py` → bootstrap → FastAPI handoff on a clean mac environment.

## 2. Create installers for Pi and Windows
- **Pi**: installer covering `pi_cpu` and `pi_hailo` profiles (Hailo detection, `hailo_pci` blacklist, HEF checks, graceful fallback).
- **Windows**: bootstrap installer parity with mac/Pi (plain HTML/CSS/JS UI, no framework).
- Keep all three installers driven by the same browser bootstrap — no `setup.sh`, no systemd/launchd during development.

## 3. Multi-user presence & cross-session interaction
Allow users to see other members' characters, whether they are active, and interact with them.

**Example:** You see Daisy's character is awake (she's using LokiDoki). You can either:
- Direct message her — your character appears on her screen, or
- Instruct her character to speak something without her prompting it.

**Privacy rules (required before build):**
- Per-user policy for inbound interactions:
  - *Open*: anyone approved can "hop in" without prompt (e.g., Daisy → open to close contacts).
  - *Approval required*: each inbound interaction prompts the recipient, similar to screen-control approval.
- Presence visibility is itself opt-in (awake/asleep/invisible).
- Audit log of who spoke through whose character and when.
- Scope decisions: does this live in core, a plugin, or a new shared-presence service? (TBD — likely plugin + core presence hooks.)
