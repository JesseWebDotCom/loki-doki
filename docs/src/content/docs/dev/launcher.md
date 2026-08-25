---
title: Launcher & Host Guards
description: What run.sh / run.ps1 do (modes, flags, the auto-restart supervise loop), plus the GPU brownout guard and eGPU (Thunderbolt) recovery notes for the host.
sidebar:
  order: 10
---

The whole stack starts from one script — `run.sh` (macOS/Linux) or `run.ps1`
(Windows). They are siblings with the same behavior. On the Windows host there is
also a persistent **GPU brownout guard** (`gpu-power-guard.ps1`) that has to be
installed once. This page documents both.

---

## The launcher: `run.sh` / `run.ps1`

### Two modes

- **Production (default)** — builds the frontend bundle (only when stale) and
  serves the whole app (API **and** bundled UI) from **one** backend process on
  **port 3000**. The bundle is a fraction of dev's unbundled modules, so remote /
  LAN loads are fast. No live reload; a rebuild happens on the next launch.
- **Dev** (`--dev` / `-Dev`, or `run-dev.sh` / `run-dev.ps1`) — Vite dev server on
  **5173** + a hot-reloading backend on **3000**, for local editing with instant
  HMR. Heavier to load over the LAN.

```sh
./run.sh                # macOS / Linux — production
./run.sh --dev          # dev servers + HMR
.\run.ps1               # Windows — production
.\run.ps1 -Dev          # dev servers + HMR
```

### What a launch does, in order

1. **Ensure Bun** — auto-installs the Bun runtime on first run (the only thing a
   fresh machine needs besides this script and Ollama).
2. **Stop any previous instance** — killing the dev servers is not enough: the
   backend spawns *detached sidecars* (ComfyUI, voice server, kiwix, GraphHopper,
   the Wyoming pod gateway) that outlive it and pile up. The launcher frees every
   known port and sweeps this project's runtimes by command line, then uses a
   `data/launcher.pid` file to displace the **previous launcher's supervise loop**
   so it can't restart its backend into the port we're taking. Scoped to the repo
   so unrelated work on the machine is never touched.
3. **Refresh dependencies** — `bun install` per workspace, but only when
   `node_modules` is missing or `bun.lock` / `package.json` changed since the last
   successful install (a stamp file gates this; `bun install` is a fast no-op
   otherwise).
4. **(Windows) Apply the launch-time GPU power cap** — best-effort only; the real
   protection is the guard task below.
5. **Production: build the frontend bundle** when `frontend/dist` is missing or any
   source under `src/` is newer than the last build. A failed build aborts the
   launch rather than serving a stale bundle.
6. **Start the servers**, wait for the web port to bind, and open Chrome (falling
   back to the default browser).
7. **Supervise** (see below).

On exit the launcher tears down the servers and sweeps the detached sidecars.
`ollama serve` (port 11434) is **deliberately left running** with its models
resident, so the next launch is instant instead of paying a multi-GB re-warm.

### Autoheal: the supervise loop

After the app is up, the launcher watches the backend (and, in dev, the frontend).
If one exits, it is **automatically restarted** — one crash no longer takes the
whole app down. Guards on the restart:

- **Rate cap:** 5 restarts per 5-minute window **per server**. A genuine
  crash-loop gives up (with a pointer to `data/logs/app.log`) instead of thrashing.
- **Port-clear wait:** a killed listener's socket can linger briefly, and
  `bun run` wrappers spawn grandchildren that hold the port; restarting into a
  still-bound 3000 crashes instantly with "Is port 3000 in use?". The loop waits
  for the port to actually free before restarting.
- **Clean shutdown sentinel:** the admin panel's *Shut down server* drops
  `data/shutdown-requested` before the backend exits; the loop sees it and tears
  down **without** restarting. `Ctrl+C` also exits cleanly.

### Flags

| | `run.ps1` (Windows) | `run.sh` (macOS/Linux) |
| --- | --- | --- |
| Dev mode | `-Dev` (or `run-dev.ps1`) | `--dev` (or `run-dev.sh`) |
| Uninstall | `-Uninstall` | `--uninstall` |
| GPU power cap | `-GpuPowerCap <W>` (default `150`, `0` disables) | — |

`--uninstall` / `-Uninstall` permanently deletes all app data, AI models, ComfyUI,
voice/map caches, and downloaded runtimes after a typed `UNINSTALL` confirmation.

### Ports touched by teardown

`5173` (Vite), `3000` (backend / production web), `8188` (ComfyUI), `8092` (voice),
`8091` (kiwix), `8090` (GraphHopper) + `8002` / `8003` (GraphHopper admin), `10700`
(Wyoming pod gateway). `ollama serve` on `11434` is intentionally **not** in this
set, so it survives restarts.

---

## The GPU brownout guard: `gpu-power-guard.ps1` (Windows host)

### Why it exists

The host hard power-offs under load (Kernel-Power 41, bugcheck 0, no WHEA — raw
power loss). The desktop RTX 3070 in the Thunderbolt enclosure spikes well above
its sustained limit for **milliseconds**, and a plain `nvidia-smi -pl` cap cannot
catch those transients (the power limiter is an averaging controller that reacts
slower than the spike). What *does* bound instantaneous draw is **locking the max
graphics clock** (`-lgc`): the high-voltage boost bins are never requested, so peak
power is capped by physics rather than a lagging control loop. NVENC and LLM
inference are barely affected (separate clock domain / memory-bound on 8 GB).

It also clamps the CPU **maximum processor state to 99%** (no Turbo Boost): this
laptop's Hybrid Power design pulls from AC + battery together under peak load, and
a worn battery hard-cuts the machine — killing turbo removes most of that peak.

### Usage

```powershell
.\gpu-power-guard.ps1 -Once        # apply now, exit
.\gpu-power-guard.ps1              # apply + keep watching (foreground)
.\gpu-power-guard.ps1 -Install     # SYSTEM scheduled task (needs an elevated shell)
.\gpu-power-guard.ps1 -Uninstall
```

Defaults: `-PowerLimit 150` W, `-MaxClock 1400` / `-MinClock 210` MHz (max snapped
to the nearest supported bin), `-CpuMaxPct 99` (pass `0` to skip the CPU clamp).
Log: `data/logs/gpu-power-guard.log`.

### The `MaiPaiHome-GpuPowerGuard` SYSTEM task

`-Install` (from an **elevated** shell) registers a SYSTEM scheduled task that:

- applies the limits **at boot and logon**, retrying until the driver enumerates
  (the Thunderbolt GPU especially may not be present yet);
- **reapplies on device arrival** — an eGPU replug re-initializes the card with
  factory defaults, and `-pl` / `-lgc` reset on reboot, driver restart (TDR), and
  every Thunderbolt replug;
- **re-asserts hourly** to cover TDR driver resets (which fire no arrival event)
  and power-scheme switches that undo the CPU clamp.

:::caution[Reinstall after an OS reset]
The launch-time cap in `run.ps1` needs an elevated shell and only catches
*sustained* draw, so it is defense-in-depth, **not** the fix. The durable
protection is the SYSTEM task. If Windows is reinstalled or the task is otherwise
wiped, brownout protection is **inactive until you reinstall it**:

```powershell
# From an Administrator PowerShell, in the repo root:
.\gpu-power-guard.ps1 -Install
# verify:
Get-ScheduledTask -TaskName MaiPaiHome-GpuPowerGuard
```
:::

---

## eGPU (Thunderbolt RTX 3070) recovery

This deployment splits work across two cards: **chat / LLM → RTX 2070 (GPU 0)**,
**imaging / ComfyUI → RTX 3070 (GPU 1)**. The 3070 lives in a Thunderbolt
enclosure, which introduces one recurring failure mode.

### Symptom: code 47

After an unclean shutdown (a brownout crash, or historically a forced OS-upgrade
reboot), the 3070 can come back stuck at **Device Manager problem code 47**
("prepared for eject"). It then disappears from `nvidia-smi` / CUDA, so anything
pinned to GPU 1 (image generation) silently breaks while the rest of the app runs
fine.

```powershell
# Is the 3070 healthy?
nvidia-smi --query-gpu=index,name --format=csv,noheader
Get-PnpDevice -Class Display | Where-Object FriendlyName -like '*3070*' |
  ForEach-Object { "$($_.Status) problem=$(($_ | Get-PnpDeviceProperty -KeyName DEVPKEY_Device_ProblemCode).Data)" }
# Status=OK, problem=0  → fine.  Error / problem=47 → ejected.
```

### Recovery, in order of preference

1. **Wait ~1–2 minutes after boot** — the device often self-clears once the
   Thunderbolt stack and driver settle.
2. **Physically replug** the Thunderbolt cable (or power-cycle the enclosure).
3. **Cold boot** (full power off, not a warm restart) — the enclosure retains
   state across warm reboots, so this is the reliable clear when a replug doesn't
   take.

Software disable/enable of the devnode has been **unreliable** for code 47 —
don't count on it as the fix.

### What the app does about it

The backend (`backend/src/lib/gpuMonitor.ts`) keeps a growing baseline of GPUs it
has seen and **flags** a card that has gone missing, plus driver-down / overheat /
VRAM-near-full — surfaced in **Admin → System → GPU health** (alerts are opt-in).
This is **detection only**: it tells you a card is gone, it does not recover it.
Recovery is the manual sequence above; prevention is the brownout guard task.
