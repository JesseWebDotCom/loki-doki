# Doki Dock

The Loki Doki desktop app: a thin Electron shell around the web app served by your home server. It adds
what a browser tab can't: an always-on-top voice HUD near the notch, a global hotkey,
a tray icon, and launch-at-login. Every feature (chat, music, videos, ...) loads live
from the server, so server updates reach the desktop app automatically — the shell
itself rarely needs a new release.

## What it does

- **Dynamic Island HUD** — a dark capsule flush against the notch hosting the
  companion: avatar, wake-word listening, streamed replies, and a typed composer. By
  default it's there from launch with the wake word armed — just start talking. It
  morphs in place while listening/replying and settles back to your chosen base size:
  **Mini** (avatar puck), **Docked** (avatar + input), or **Max** (full bar), picked
  from the companion menu (right-click the avatar or the chevron). The window is
  click-through outside the capsule, so it never blocks the apps behind it. While the
  mic is armed the capsule always stays visible; turn the posture off via
  tray → Always Listening.
- **Screen awareness** — ask "what am I looking at?", "what's this error?", or use the
  composer's attach → My screen. The shell captures a downscaled screenshot of the
  display your cursor is on and the companion answers about it via the server's vision
  model. Requires the macOS Screen Recording permission (see below) and an installed
  vision model.
- **Global hotkey** — `Cmd/Ctrl+Shift+Space` flips the docked pill open to the composer
  (and summons the HUD if it was hidden). Change it via the tray:
  Open Settings File → edit `hotkey` (any [Electron accelerator](https://www.electronjs.org/docs/latest/api/accelerator)) → restart.
- **Background presence** — on a normal boot only the pill and tray icon appear; the
  full app window opens on demand (tray, avatar click, or dock icon). The packaged app
  enables launch-at-login on first setup.
- **Main window** — the full web app. Closing it hides it to the tray; Quit lives in
  the tray menu. Sign in once via the profile picker; the session persists (7 days).

## Development

Requires a running Loki Doki server (see the repo root `run.sh`).

```sh
cd desktop
bun install
bun run dev
```

First run asks for the server address (e.g. `http://192.168.1.10:3000`) and validates
it against `/api/health`. Settings live in Electron's `userData` dir as `settings.json`.

## Building installers

```sh
bun run dist:mac   # .dmg + .zip (arm64 + x64), from a Mac
bun run dist:win   # NSIS .exe (x64), from Windows
```

CI does the same for both platforms: the `Desktop Build` GitHub Actions workflow runs
on `workflow_dispatch` and on tags matching `desktop-v*` (tags also publish a GitHub
Release with the artifacts).

### macOS Screen Recording permission (screen awareness)

macOS has no permission prompt API for screen capture — the app only **appears** in
System Settings → Privacy & Security → Screen Recording after its first capture
attempt. Ask the companion about your screen once, flip the toggle, then **fully quit
and relaunch** (the grant doesn't apply to a running process). Dev gotchas:

- In dev the grant attaches to the **Electron binary** (`desktop/node_modules/electron/...`),
  listed as **"Electron"** — not "Doki Dock".
- Upgrading the `electron` dependency replaces that binary, so expect to re-grant
  (remove the stale "Electron" row and re-add if captures come back black).
- Terminal-launched dev runs can inherit the terminal's grant on some macOS versions —
  verify the packaged build separately.

### Unsigned builds

Phase 1 builds are not code-signed:

- **macOS**: Gatekeeper will block the first launch. Right-click the app → Open → Open,
  or run `xattr -dr com.apple.quarantine "/Applications/Doki Dock.app"`.
- **Windows**: SmartScreen will warn. Click **More info → Run anyway**.

## Architecture notes

- The renderer is the server's web app; the shell exposes a tiny bridge
  (`window.lokiDesktop`, see `src/preload.js` and `frontend/src/types/desktop.d.ts`)
  for listen toggling, HUD resize requests, and opening the main window. All IPC
  handlers validate the sender frame's origin against the configured server.
- The HUD page is `frontend/src/pages/HudPage.tsx` (route `/hud`).
- Voice ownership across windows follows the web app's existing rules
  (`voiceOwnership.ts`): only a visible surface holds the mic, which is why the idle
  HUD becomes a small pill instead of hiding while hands-free is armed.
- If `bun install` ever fails on the Windows CI runner around Electron's postinstall,
  swap that step to `npm install` (documented pragmatic exception).
