# MaiPai Desktop

The MaiPai Home desktop app: a thin Electron shell around the web app served by your home server. It adds
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

Requires a running MaiPai Home server (see the repo root `run.sh`).

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
Release with the artifacts). The macOS job runs on a real macOS runner, so its `.dmg`
is the styled, verified install image.

### The styled DMG (drag-to-Applications window)

Opening the `.dmg` shows a branded window: the app on the left, an arrow, and the
Applications folder on the right, with a short note along the bottom about the
first-open Gatekeeper step. The look is defined by committed assets under `build/`,
shared by **both** build paths:

- `build/dmg-background.png` (+`@2x`): the window artwork.
- `build/dmg/DS_Store`: the Finder layout (window size, icon positions, background).

electron-builder consumes them via the `dmg:` block in `electron-builder.yml`. Only
regenerate when the layout changes (macOS, ImageMagick required):

```sh
scripts/make-dmg-background.sh   # rebuild the artwork from the brand palette
scripts/make-dsstore.sh          # re-bake the Finder layout (needs Finder Automation)
```

Keep the window size and icon centers in those two scripts in sync with the `dmg`
block in `electron-builder.yml`; that trio is the single source of truth for the layout.

### Building the Mac app (and DMG) on Windows, no Mac

`scripts/build-mac-on-windows.ts` assembles, brands, and ad-hoc signs `MaiPai Desktop.app`
from a prebuilt Electron darwin zip (see its header for inputs and `rcodesign`). It
always writes the `.zip`, and also writes the styled `.dmg` when an HFS+ sealer is
available, reusing the committed layout above. Sealing a folder into a UDIF image needs
a tool Windows lacks natively, so point `DMGTOOL` at one:

```sh
# under WSL, using the libdmg-hfsplus reference sealer:
DMGTOOL="wsl scripts/seal-dmg.sh" RCODESIGN=... \
  bun run scripts/build-mac-on-windows.ts electron-*-darwin-arm64.zip MaiPaiDesktop-arm64.zip
```

`scripts/seal-dmg.sh` needs `hfsprogs` (`mkfs.hfsplus`) plus libdmg-hfsplus's `hfsplus`
and `dmg` tools. It is the one step that cannot be exercised on macOS, so validate its
output once (mount the DMG, confirm the styled window). Without `DMGTOOL` the script
skips the DMG and emits the zip exactly as before. On macOS the same script seals via
`hdiutil` automatically.

### macOS Screen Recording permission (screen awareness)

macOS has no permission prompt API for screen capture — the app only **appears** in
System Settings → Privacy & Security → Screen Recording after its first capture
attempt. Ask the companion about your screen once, flip the toggle, then **fully quit
and relaunch** (the grant doesn't apply to a running process). Dev gotchas:

- In dev the grant attaches to the **Electron binary** (`desktop/node_modules/electron/...`),
  listed as **"Electron"** — not "MaiPai Desktop".
- Upgrading the `electron` dependency replaces that binary, so expect to re-grant
  (remove the stale "Electron" row and re-add if captures come back black).
- Terminal-launched dev runs can inherit the terminal's grant on some macOS versions —
  verify the packaged build separately.

### Unsigned builds

Phase 1 builds are not code-signed:

- **macOS**: Gatekeeper blocks the first launch. On macOS 15+ the old right-click → Open
  bypass is gone: open the app once (it gets blocked), then go to
  System Settings → Privacy & Security and click **Open Anyway** (or, from a terminal,
  `xattr -dr com.apple.quarantine "/Applications/MaiPai Desktop.app"`). The DMG window and
  the app's first-run primer both spell this out. The only way to remove the prompt is
  Developer ID signing + notarization (rcodesign can do both from Windows), not done in
  Phase 1.
- **Windows**: SmartScreen will warn. Click **More info → Run anyway**.

### First-run permission primer (macOS)

After the packaged app is connected to a server for the first time, it shows a short
primer (a second panel in the setup window) that requests **Microphone** access and
explains the **Screen Recording** quirk (see above) before the app opens. It's macOS
only and first-run only; changing the server later skips straight to a relaunch. The
handlers live in `src/main.js` (`setup:request-mic` / `setup:screen-status` /
`setup:finish`) and the UI in `src/setup.html`.

## Architecture notes

- The renderer is the server's web app; the shell exposes a tiny bridge
  (`window.maipaiDesktop`, see `src/preload.js` and `frontend/src/types/desktop.d.ts`)
  for listen toggling, HUD resize requests, and opening the main window. All IPC
  handlers validate the sender frame's origin against the configured server.
- The HUD page is `frontend/src/pages/HudPage.tsx` (route `/hud`).
- Voice ownership across windows follows the web app's existing rules
  (`voiceOwnership.ts`): only a visible surface holds the mic, which is why the idle
  HUD becomes a small pill instead of hiding while hands-free is armed.
- If `bun install` ever fails on the Windows CI runner around Electron's postinstall,
  swap that step to `npm install` (documented pragmatic exception).
