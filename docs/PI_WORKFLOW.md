# Pi Workflow

LokiDoki uses repo-local scripts for Pi development. Do not manually copy files.

## Setup

1. Copy `.pi.env.example` to `.pi.env`
2. Fill in `PI_USER`, `PI_HOST`, and any SSH key/port overrides

## Commands

Sync the repo:

```bash
./scripts/sync_to_pi.sh
```

Sync and restart in one step:

```bash
./scripts/sync_and_restart_pi.sh
```

Start LokiDoki on the Pi:

```bash
./scripts/run_on_pi.sh start
```

Force reinstall on the Pi:

```bash
./scripts/run_on_pi.sh reinstall
```

Stop or restart:

```bash
./scripts/run_on_pi.sh stop
./scripts/run_on_pi.sh restart
```

Check status and validate endpoints:

```bash
./scripts/run_on_pi.sh status
./scripts/run_on_pi.sh validate
./scripts/run_on_pi.sh doctor
```

Read logs:

```bash
./scripts/pi_log.sh
./scripts/pi_log.sh --follow
```

## Notes

- `validate` probes `:7860` for bootstrap status, bootstrap health, provider selection, and Hailo status
- `doctor` checks common Pi prerequisites like `python3`, `npm`, `ollama`, `hailortcli`, `/dev/hailo0`, and the Hailo driver blacklist file
- `run_on_pi.sh shell '<command>'` can execute an arbitrary remote command in the repo directory
- `sync_and_restart_pi.sh` is the normal deploy loop during development. It syncs the repo, restarts LokiDoki, and runs `validate`. If `requirements-app.txt` changed, the bootstrap repair path will refresh backend dependencies on the Pi during startup.
