# Coding Sandbox — Zero-Touch Design for Windows + macOS (2026-07-16)

Goal: the Coding feature's OS-level isolation is stood up and torn down entirely by the
install wizard and Admin → Features → Coding enablement. The only human interaction
permitted is the OS's own one-time elevation consent (UAC on Windows, password/Touch ID
on macOS) — the same `needsElevation` flow the install registry already uses. No manual
installs, no reboots, no configuration.

Design bar (from the mac/Linux mechanism that already ships): **kernel-enforced user
boundary, tool-agnostic, fails closed, cleanly reversible, near-zero new dependencies.**

---

## 1. Research summary — how shipped products do this (July 2026)

Three distinct native-Windows architectures exist in shipping coding agents:

| Product | Windows mechanism | Status |
|---|---|---|
| **OpenAI Codex CLI** | Dedicated local users (`CodexSandboxOffline/Online`) + write-restricted token (`CreateRestrictedToken` with `WRITE_RESTRICTED\|LUA_TOKEN\|DISABLE_MAX_PRIVILEGE`) + synthetic restricted SIDs + workspace NTFS ACLs + SID-scoped WFP/firewall rules. Spawn chain: unelevated CLI → named pipes → runner exe as sandbox user → `CreateProcessAsUserW` with restricted token. Credentials DPAPI-encrypted. They evaluated and **rejected AppContainer** as the wrong shape for open-ended dev tooling. | Shipped, graduated out of experimental flags, first-party docs |
| **Anthropic sandbox-runtime** (`@anthropic-ai/sandbox-runtime`, `srt`) | Dedicated `srt-sandbox` local user (their stated rationale: a distinct SID **structurally closes the surrogate-spawn escape class** — Task Scheduler, BITS, out-of-proc COM, parent-process spoofing — because any out-of-band spawn still carries the fenced SID) + restricted token + job object + SID-keyed WFP fence forcing egress through host-side filtering proxies + additive/reversible per-SID NTFS ACEs. Bundled Rust helper `srt-win.exe`; idempotent elevated installer. | Shipped in the library, explicitly **alpha**; not yet wired into Claude Code (whose docs still say "use WSL2") |
| **Microsoft MXC** (used by GitHub Copilot CLI) | AppContainer/LPAC + capability SIDs + Win32k lockdown + job-object UI limits + package-SID firewall rules; forward path to a first-class OS API (`Experimental_CreateProcessInSandbox`, Win11 24H2+). | Public preview; README states MXC profiles are **not security boundaries yet** |

Everyone else: Gemini CLI (Docker or nothing on Windows), Cursor (WSL2 interim, publicly
waiting on Microsoft's primitives), VS Code agent mode (no native Windows), OpenHands
(Docker), Aider (none).

Cross-cutting facts that shaped this design:

- **node-pty cannot spawn a process as a different user** (documented upstream), and a
  process started as another user gets a console ConPTY can't attach across. Every
  shipped solution needed a helper process running *as* the sandbox identity.
- **A write-restricted token alone leaves reads wide open** by design; Codex accepts
  this. Read-blocking needs ACLs (deny ACEs) or AppContainer (heavy compat cost).
- **Fresh non-system NTFS volume roots (`D:\`) are writable by Authenticated Users by
  default** — a restricted identity can create files at `D:\` unless explicitly denied.
- **WSL2 cannot be stood up zero-touch**: enabling `VirtualMachinePlatform` requires a
  reboot on first install, and unattended enablement has recurring 2026 failure reports.
  This eliminates WSL2 as the *default* path (fine as a power-user option, never the
  wizard's).
- **Windows Sandbox (WSB)** is non-persistent by design and Pro/Enterprise-only. **Dev
  Drive** is a performance feature, not a boundary. **Job objects** have no filesystem
  control (useful only as a complement).
- Codex's uninstall leaves residue (users, ACLs, WFP filters). Ours must not — clean
  reversal is a first-class requirement below.

---

## 2. Decision

**Windows gets the same architecture macOS/Linux already has — a restricted OS user —
with the one Windows-specific twist that the *entire PTY sidecar* runs as that user,
instead of per-pane privilege drops.**

Why this shape wins on "minimal components, dependencies, risk":

1. **It reuses the proven design.** The mac/Linux `lokidoki-coding` restricted-user
   boundary is already the app's post-mortem answer to a sandbox that failed open
   (`opencode-sandbox`). Anthropic's srt independently arrived at the same primitive on
   Windows and documented why the distinct SID matters. We're not inventing anything.
2. **It sidesteps the entire native-helper problem.** Codex and srt need a Rust runner
   exe because they spawn *each command* across a user boundary with a PTY. We don't:
   our sidecar (`coding-pty-sidecar.ts`) is already a separate Node process that talks
   to the backend over loopback HTTP/WS. If the *sidecar itself* runs as
   `lokidoki-coding`, then node-pty inside it spawns `claude.exe` as its **own** user —
   no cross-user PTY, no `CreateProcessAsUser`, no runner exe, no native addon. One
   process changes identity; everything downstream is unchanged.
3. **Zero new dependencies.** Setup is `net user` + `icacls` + DPAPI via PowerShell —
   all built into every Windows edition including Home. No WinSW/NSSM service wrapper,
   no scheduled tasks, no npm additions.
4. **Alternatives rejected:**
   - *Adopt `@anthropic-ai/sandbox-runtime` now* — alpha; its WFP fence forces egress
     through MITM proxies (fights our loopback/LAN Ollama coding engine); per-exec PTY
     model doesn't match our persistent-session sidecar. **Revisit when it exits alpha**
     (§7) — it's the natural upgrade for token- and network-level hardening.
   - *Write our own restricted-token runner (Codex-style)* — highest-assurance native
     option, but hand-rolled security-critical Win32 code is exactly the risk profile
     this app avoids.
   - *AppContainer / MXC* — default-deny breaks arbitrary dev tooling (Codex rejected it
     for this reason); MXC says itself it's not a boundary yet. Watch it (§7).
   - *WSL2 / Windows Sandbox* — fail the zero-touch and/or persistence requirements
     (reboot; non-persistent; edition gates).

**macOS (and Linux) stay exactly as shipped.** The restricted-user + scoped-sudoers +
tmux design already meets every requirement; the wizard's one Touch ID/password dialog
is the platform analog of the UAC consent. No changes.

---

## 3. Windows design

### 3.1 Components (all new code in the two files that already own this domain)

| # | Component | Lives in |
|---|---|---|
| 1 | Elevated one-time setup script (PowerShell, run via the existing `Start-Process -Verb RunAs` pattern from `gpuTuning.ts`) | `codingSandboxUser.ts` → `windowsSetupScript()` |
| 2 | Restricted local user `lokidoki-coding` + local group `lokidoki-coding-grp` | created by #1 |
| 3 | ACL plan (workspace grant + targeted denies) | applied by #1 |
| 4 | DPAPI-encrypted credential blob | written by #1, read by #5 |
| 5 | Spawn-as-user path for the coding sidecar (`CreateProcessWithLogonW` via PowerShell `Add-Type` P/Invoke, `CREATE_NO_WINDOW`) | `codingPtySidecar.ts` |
| 6 | Second sidecar instance split (restricted coding sidecar :8094 / app-user admin-shell sidecar :8095) | `codingPtySidecar.ts` + `codingServer.ts` |
| 7 | Runtime mirror of Claude Code + Node into the workspace root (existing `ensureSandboxRuntimeMirrored`, now also used on Windows) | `codingSandboxUser.ts` |
| 8 | Uninstall script (exact inverse of #1) | `codingSandboxUser.ts` |

### 3.2 Elevated setup (one UAC consent, fully scripted, idempotent)

Triggered by the existing `coding-sandbox-user` install-registry component
(`needsElevation: true`) from the wizard or Admin → Features → Coding — the same entry
macOS uses; only the platform branch differs.

```
WORKSPACES_ROOT = C:\ProgramData\lokidoki-coding      (analog of /var/lib/lokidoki-coding)
```

1. **Identity.** `net localgroup lokidoki-coding-grp /add`; `net user lokidoki-coding
   <random 32-char pw> /add /passwordchg:no /expires:never`; add the sandbox user AND
   the app's own user to the group. Hide from the login screen
   (`SpecialAccounts\UserList` registry value — same trick srt uses). Re-runs rotate the
   password (srt precedent) — repair is always safe.
2. **Logon rights** (via `secedit` export→merge→import, all built-in): grant
   `SeInteractiveLogonRight` is left as-is (needed by `CreateProcessWithLogonW`'s
   `LOGON_WITH_PROFILE`), add the user to **Deny log on through Remote Desktop** and
   **Deny access from the network** — local spawn only.
3. **Workspace root.** Create `WORKSPACES_ROOT`; `icacls` reset inheritance; explicit
   grants only: SYSTEM + Administrators Full, `lokidoki-coding-grp` Modify. Remove
   `CREATOR OWNER`; add `OWNER RIGHTS:(M)` so a file's creator can't re-grant
   permissions (closes the NTFS owner-escalation gap the research flagged).
4. **Targeted deny ACEs** for the `lokidoki-coding` SID (additive, non-inherited where
   noted, trivially reversible — the srt pattern):
   - App install dir + app data dir (e.g. `D:\loki-doki`): **deny all access.** This is
     the Windows substitute for the home-directory wall macOS gets for free — the
     app's repo, DB, and secrets live outside any user profile on Windows.
   - Each fixed drive root: **this-folder-only** deny for *create file / create folder*
     (closes the writable-`D:\`-root default without touching any subdirectory ACLs).
   - The credential blob (4 below) and setup artifacts: deny read.
5. **Credential blob.** The random password, DPAPI-encrypted **scoped to the app's own
   user** (`ProtectedData.Protect`, CurrentUser), written under the app data dir
   (already deny-ACE'd from the sandbox user). Never touches the DB, never leaves the
   machine. Codex and srt store credentials the same way.
6. **Verify** (the `isSandboxUserInstalled()` analog, and the honest fail-open check the
   opencode-sandbox incident taught us): spawn `cmd /c exit 0` as `lokidoki-coding`
   using the blob; then **assert the boundary is real** — attempt to read a file inside
   the app data dir as the sandbox user and require *failure*. Setup only reports
   success if the wall actually holds.

### 3.3 Runtime spawn path

- `maybeSpawnCodingPtySidecar()` on Windows, when the sandbox component is installed:
  spawn the coding sidecar via `CreateProcessWithLogonW` (PowerShell `Add-Type` P/Invoke;
  `CREATE_NO_WINDOW`; env limited to the curated set it gets today) as
  `lokidoki-coding`, cwd = `WORKSPACES_ROOT`. Existing health-probe/adopt/respawn logic
  is unchanged — the sidecar is the same script, same port, same protocol.
- Because the sidecar **is** the sandbox user, every pty it spawns (`claude.exe`,
  PowerShell, anything Claude runs) inherits the boundary with zero per-spawn work, and
  any surrogate spawn (Task Scheduler, COM, etc.) still carries the fenced SID — the
  exact property srt calls out.
- The sidecar runs the **mirrored** Claude Code + Node from
  `WORKSPACES_ROOT\runtime` (existing `ensureSandboxRuntimeMirrored`, pointed at the
  Windows root) since the real install under the app data dir is deny-ACE'd.
- `workspaceDirFor()` on Windows returns `WORKSPACES_ROOT\users\<id>` when installed
  (falls back to the current app-data path when not, unchanged).
- **Admin host shell** (`buildHostShellSpawnParams`) must keep full host access, so it
  no longer shares the coding sidecar: a second app-user sidecar instance on :8095
  (same script, different port env) serves only that route. Two instances of one
  stateless script — not a new component.
- **Headless companion runs** (`tools/coding.ts`): `buildHeadlessClaudeCommand`'s
  `env`-prefix form never worked on Windows. Route headless `claude -p` through the
  restricted sidecar instead — add a tiny `POST /run` (spawn, buffer, return) to the
  sidecar script. This is required, not optional: headless runs use
  `--permission-mode bypassPermissions` and must never execute outside the boundary.
  macOS keeps its `sudo -u` path.

### 3.4 Enable / disable / uninstall semantics

| Action | What happens |
|---|---|
| Wizard or Admin enables Coding | Install registry runs `claude-code` (unchanged) + `coding-sandbox-user` (elevated setup above; surfaced as the standard attention item, one UAC click) |
| Admin disables Coding | Backend calls sidecar `/shutdown` (new sibling of `/session/kill` — cooperative, kills all ptys, exits); feature-gate already blocks routes. No elevation needed |
| Component uninstall (Admin → remove) | Elevated inverse script: `/shutdown` + `taskkill /F /FI "USERNAME eq lokidoki-coding"` (belt-and-braces, now-elevated), remove every deny/grant ACE by SID, delete user + group + registry hide entry + credential blob. Workspace *data* is preserved (it's the household's work); `WORKSPACES_ROOT` ownership flips to Administrators. **Every artifact the setup creates is enumerated in the script header** — the explicit answer to Codex's leftover-residue problem |
| Sandbox installed but spawn-as-user fails at runtime | **Fail closed**: coding sessions error with a repair hint. Never silently fall back to an unsandboxed spawn — that is precisely how `opencode-sandbox` burned us |

### 3.5 What the boundary does and does not give (stated honestly)

Holds (kernel-enforced): no access to the app's repo, data dir, DB, or secrets; no
access to any Windows user profile (default `C:\Users\<x>` ACLs); no creating files at
drive roots; no RDP/network logon; boundary survives any spawn trick that changes
parentage but not identity.

Does not hold (same tradeoffs as the shipped macOS design): world-readable paths are
readable and world-writable paths (e.g. `C:\Users\Public`, permissive shares) are
writable — the sandbox user is still an Authenticated User; no network fence — the
coding engine (Ollama), LAN, and internet are reachable exactly as on macOS today; all
household members share one sandbox identity (per-user *directories*, one OS user —
also parity with macOS).

---

## 4. macOS design (unchanged, restated as the contract)

- Restricted hidden system user `lokidoki-coding` (no password, no shell, no home) +
  `lokidoki-coding-grp`; workspaces at `/usr/local/var/lokidoki-coding` (root-owned,
  2770 g+s).
- Per-user tmux server runs as the app user; sandboxed panes drop via
  `sudo -u lokidoki-coding` through the one root-owned launch script the scoped
  NOPASSWD sudoers rule permits.
- One-time elevation via the native `osascript … with administrator privileges` dialog
  (wizard/admin attention item). Linux: identical via `pkexec`.
- Uninstall: delete sudoers file, user, group, launch script; keep workspace data.

The only mac work item in this design: **port the §3.2-step-6 "assert the boundary is
real" verification into `isSandboxUserInstalled()`'s install-time check** (attempt to
read a file inside the app's home as the sandbox user and require failure), so both
platforms share the fail-open-detection contract.

---

## 5. Implementation plan

1. `codingSandboxUser.ts` — add `windowsSetupScript()` / `windowsUninstallScript()`,
   Windows branches for `SANDBOX_WORKSPACES_ROOT`, `isSandboxUserInstalled()` (spawn
   probe + boundary assert via credential blob), `installSandboxUser()` (RunAs pattern
   from `gpuTuning.ts:102-109`), credential blob read/write helpers.
2. `codingPtySidecar.ts` — spawn-as-user path (P/Invoke `CreateProcessWithLogonW`);
   second instance wiring for :8095; `/shutdown` handling.
3. `coding-pty-sidecar.ts` — add `POST /run` (headless one-shot) and `POST /shutdown`.
   No other changes; it stays sandbox-ignorant.
4. `codingServer.ts` — Windows: `workspaceDirFor()` root switch, headless command via
   sidecar `/run`, admin-shell params point at :8095, drop the `env`-prefix launch on
   Windows.
5. `installRegistry.ts` — remove the `IS_WIN → false/throw` guards on
   `coding-sandbox-user`; the component becomes cross-platform with per-OS branches.
6. Docs + Admin UI copy: Coding feature card describes the isolation per platform.

Test plan (Windows box): setup idempotency (run twice, rotate password); boundary
asserts (read app data dir → denied; write `D:\` root → denied; write own workspace →
allowed); interactive session via web terminal; reload-reattach persistence; headless
`/run`; admin host shell still full-access on :8095; disable → `/shutdown` kills tree;
uninstall → zero residue (`net user`, `icacls` spot-checks); fail-closed check (delete
credential blob, confirm sessions error rather than spawn unsandboxed).

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| AV/EDR interferes with `CreateProcessWithLogonW` (Codex sees this in enterprise) | Home-lab primary audience; fail-closed error surfaces a clear repair hint |
| GPO denies the sandbox user interactive logon (Codex error 1385 analog) | Setup verify (§3.2.6) catches it at install time, inside the wizard, not at first use |
| ConPTY under a non-interactive logon session | Precedented (Windows OpenSSH serves ConPTY from a service); verify explicitly in the test plan before shipping |
| Password/blob theft by another *admin* on the box | Out of scope — an admin owns the machine on every platform |
| Loopback sidecar has no auth (any local process can drive it) | True today too; it can only spawn *as the sandbox user* — strictly better than the status quo. Optional hardening: shared-secret header from the DB |

## 7. Future hardening (explicitly not now)

- **Adopt `@anthropic-ai/sandbox-runtime` when its Windows support exits alpha** — adds
  the write-restricted token, job-object tree-kill, and the WFP network fence on top of
  the same user boundary; our workspace layout and sidecar split are already shaped for
  it.
- **MXC / `CreateProcessInSandbox`** — when Microsoft declares it a security boundary,
  it becomes the platform-native answer; Cursor and Copilot are already betting on it.
- Per-household-member OS users (currently one shared sandbox identity, per-user dirs).
- SID-scoped outbound firewall rules (allow coding-engine + loopback, block the rest) —
  cheap subset of the srt fence, applies equally to a future mac egress story.
