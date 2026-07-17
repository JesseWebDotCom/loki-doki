// One-time, admin-elevated setup that gives the coding sidecar a real OS-enforced
// sandbox: a restricted OS user with zero access to this app's own repo and data,
// instead of relying on `opencode-sandbox`'s Seatbelt/bubblewrap wrapping: verified
// live to fail open on this machine (sandbox-exec itself returns "Operation not
// permitted" here even for a trivial unrelated command; the plugin just runs commands
// unsandboxed when its wrapper fails, silently).
//
// Why a separate OS user works without any of that: `/Users/<you>` is `drwxr-x---`
// by default, zero access for any other Unix user, full stop, no code required.
// A process running as a different user can't even traverse into the home directory,
// so this app's repo (which lives inside it) is unreachable regardless of the repo's
// own more permissive mode bits. This also makes the fix tool-agnostic: it protects
// whatever gets spawned as this user, OpenCode today, anything else later, since
// it's a kernel-enforced boundary, not an app-specific plugin that can fail open.
//
// Windows (see CODING-SANDBOX-DESIGN-2026-07-16.md for the full rationale + the
// research behind it — OpenAI Codex and Anthropic's sandbox-runtime both converged on
// the same dedicated-local-user primitive): the app on Windows lives OUTSIDE any user
// profile (e.g. `D:\loki-doki`), so the home-directory wall Unix gets for free has to
// be built explicitly with deny ACEs for the sandbox user on the app + data dirs, plus
// a this-folder-only deny on each fixed drive root (fresh NTFS volume roots are
// writable by any authenticated user by default). Instead of dropping privileges
// per-pane (needs a native helper: node-pty cannot spawn as another user), the WHOLE
// PTY sidecar runs as `lokidoki-coding`, so every pty it spawns inherits the boundary.
// The sidecar is launched via scripts/win-sandbox-runner.ps1 (.NET Process.Start with
// UserName/Password → CreateProcessWithLogonW; no native binary of ours involved),
// using a random password generated INSIDE the elevated setup script and stored only
// as a DPAPI(LocalMachine) blob whose ACL grants read to the app user alone.
// LocalMachine (not CurrentUser) scope on purpose: the UAC consent may come from a
// different admin account than the one running the app, and the blob's NTFS ACL is
// what limits who can decrypt.
//
// The one consequence (all platforms): the coding workspace data has to live OUTSIDE
// the protected areas, at a real system data path, shared between the restricted user
// and this app's own runtime user so both sides can read/write it.

import { existsSync, mkdirSync, writeFileSync, rmSync, cpSync, readFileSync, copyFileSync } from 'node:fs'
import { execFileSync, execSync, execFile } from 'node:child_process'
import { userInfo, tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { promisify } from 'node:util'
import { dataDir } from '@/lib/download'
import { IS_MAC, IS_LINUX, IS_WIN } from '@/lib/platform'

const execFileAsync = promisify(execFile)

export const SANDBOX_USER = 'lokidoki-coding'
export const SANDBOX_GROUP = 'lokidoki-coding-grp'
export const SANDBOX_WORKSPACES_ROOT = IS_WIN
  ? join(process.env.ProgramData ?? 'C:\\ProgramData', 'lokidoki-coding')
  : IS_MAC
    ? '/usr/local/var/lokidoki-coding'
    : '/var/lib/lokidoki-coding'
const SUDOERS_FILE = '/etc/sudoers.d/lokidoki-coding'

// ── Windows-only paths ─────────────────────────────────────────────────────────
// DPAPI(LocalMachine)-encrypted sandbox-user password. Lives under the app data dir,
// which the elevated setup deny-ACEs for the sandbox user, and carries its own
// explicit ACL (SYSTEM/Administrators/app-user only) besides.
export const WIN_CRED_BLOB = join(dataDir, 'coding', 'sandbox-cred.dpapi')
// Spawn/probe helper — decrypts the blob and starts a process as the sandbox user via
// .NET Process.Start (CreateProcessWithLogonW under the hood). Static file, no secrets.
export const WIN_RUNNER_PS1 = join(import.meta.dir, '../../scripts/win-sandbox-runner.ps1')
// Scratch dir the sandbox user can write (its own %TEMP% points at the app user's
// profile, which it structurally cannot reach). Created by the elevated setup.
export const WIN_SANDBOX_TMP = join(SANDBOX_WORKSPACES_ROOT, 'tmp')
// The launch script and the mirrored OpenCode runtime (see codingServer.ts's
// ensureSandboxRuntimeMirror) both have to live under SANDBOX_WORKSPACES_ROOT, NOT
// under this repo: the repo lives inside a home directory, which the restricted
// sandbox user structurally cannot traverse into, including to reach an executable
// sudo would otherwise run on its behalf. Written directly to this path (as root) by
// the elevated setup script below, not copied from backend/scripts/ at runtime.
export const LAUNCH_SCRIPT = join(SANDBOX_WORKSPACES_ROOT, 'coding-sidecar-launch.sh')
export const SANDBOX_RUNTIME_DIR = join(SANDBOX_WORKSPACES_ROOT, 'runtime')
// OpenCode itself writes global config/state to $HOME/.local/share/opencode and reads
// its own config from $HOME/.config/opencode regardless of cwd. Per-user HOME (nested
// inside each user's own workspace dir) is computed in codingServer.ts, not here: it
// needs to be per-user, not shared across the whole sandbox the way this used to be.

// Kept in sync with backend/scripts/coding-sidecar-launch.sh (same content): that
// copy is for local dev/reference; this is the one actually installed and executed.
const LAUNCH_SCRIPT_CONTENT = 'exec "$@"\n'

function currentUser(): string {
  return userInfo().username
}

export function isSandboxUserInstalled(): boolean {
  if (IS_WIN) {
    // Cheap sync check (this sits on the workspace-path hot path — no process spawns):
    // both artifacts only ever exist together once the elevated setup has completed.
    // The honest "does the boundary actually hold" probe is verifyWindowsSandboxBoundary,
    // run at install time; runtime spawns fail closed on a stale/broken install anyway
    // (the runner can't log the user on without a valid blob).
    return existsSync(WIN_CRED_BLOB) && existsSync(SANDBOX_WORKSPACES_ROOT)
  }
  try {
    execFileSync('id', [SANDBOX_USER], { stdio: 'ignore' })
  } catch { return false }
  if (!existsSync(SANDBOX_WORKSPACES_ROOT)) return false
  try {
    // -n = never prompt; exits non-zero instead of hanging if the sudoers rule
    // is missing or requires a password, which is exactly what we're checking.
    // Must be the launch script itself, not an arbitrary command like `true`:
    // the sudoers rule only grants NOPASSWD for that one specific command
    // (confirmed live: testing against `true` fails even when the real rule works).
    execFileSync('sudo', ['-n', '-u', SANDBOX_USER, LAUNCH_SCRIPT, '/usr/bin/true'], { stdio: 'ignore', timeout: 5_000 })
    return true
  } catch { return false }
}

function macSetupScript(appUser: string): string {
  return `
set -e
GROUP_NAME="${SANDBOX_GROUP}"
USER_NAME="${SANDBOX_USER}"
WORKSPACES_ROOT="${SANDBOX_WORKSPACES_ROOT}"
LAUNCH_SCRIPT="${LAUNCH_SCRIPT}"
APP_USER="${appUser}"

find_free_id() {
  for id in $(seq 300 399); do
    if ! dscl . -search /Groups PrimaryGroupID "$id" 2>/dev/null | grep -q . && \\
       ! dscl . -search /Users UniqueID "$id" 2>/dev/null | grep -q .; then
      echo "$id"; return
    fi
  done
}

if ! dscl . -read "/Groups/$GROUP_NAME" >/dev/null 2>&1; then
  GID=$(find_free_id)
  dscl . -create "/Groups/$GROUP_NAME"
  dscl . -create "/Groups/$GROUP_NAME" PrimaryGroupID "$GID"
fi
GID=$(dscl . -read "/Groups/$GROUP_NAME" PrimaryGroupID | awk '{print $2}')

if ! dscl . -read "/Users/$USER_NAME" >/dev/null 2>&1; then
  UID_NUM=$(find_free_id)
  dscl . -create "/Users/$USER_NAME"
  dscl . -create "/Users/$USER_NAME" UserShell /usr/bin/false
  dscl . -create "/Users/$USER_NAME" UniqueID "$UID_NUM"
  dscl . -create "/Users/$USER_NAME" PrimaryGroupID "$GID"
  dscl . -create "/Users/$USER_NAME" NFSHomeDirectory /var/empty
  dscl . -create "/Users/$USER_NAME" IsHidden 1
  # Deliberately no password set at all (not even the classic '*' no-login marker:
  # macOS's own password-quality check rejects that as an actual attempted password,
  # confirmed live). No credential exists to authenticate with, and UserShell is
  # /usr/bin/false besides, so there is no interactive login path either way.
fi

mkdir -p "$WORKSPACES_ROOT"
chown -R "root:$GROUP_NAME" "$WORKSPACES_ROOT"
chmod -R 770 "$WORKSPACES_ROOT"
chmod g+s "$WORKSPACES_ROOT"

# World-readable/executable and root-owned: the sandbox user needs to be able to run
# this regardless of exactly when sudo drops privileges relative to the exec, and its
# content is fixed and harmless (just execs whatever args it's given).
cat > "$LAUNCH_SCRIPT" <<'LAUNCH_SCRIPT_EOF'
${LAUNCH_SCRIPT_CONTENT}LAUNCH_SCRIPT_EOF
chown root:wheel "$LAUNCH_SCRIPT"
chmod 755 "$LAUNCH_SCRIPT"

dseditgroup -o edit -a "$APP_USER" -t user "$GROUP_NAME" 2>/dev/null || true
dseditgroup -o edit -a "$USER_NAME" -t user "$GROUP_NAME" 2>/dev/null || true

RULE="$APP_USER ALL=($USER_NAME) NOPASSWD: $LAUNCH_SCRIPT *"
echo "$RULE" > /tmp/lokidoki-coding-sudoers
chmod 440 /tmp/lokidoki-coding-sudoers
visudo -c -f /tmp/lokidoki-coding-sudoers
cp /tmp/lokidoki-coding-sudoers "${SUDOERS_FILE}"
chmod 440 "${SUDOERS_FILE}"
rm -f /tmp/lokidoki-coding-sudoers
`.trim()
}

function linuxSetupScript(appUser: string): string {
  return `
set -e
GROUP_NAME="${SANDBOX_GROUP}"
USER_NAME="${SANDBOX_USER}"
WORKSPACES_ROOT="${SANDBOX_WORKSPACES_ROOT}"
LAUNCH_SCRIPT="${LAUNCH_SCRIPT}"
APP_USER="${appUser}"

getent group "$GROUP_NAME" >/dev/null || groupadd --system "$GROUP_NAME"
id -u "$USER_NAME" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin --gid "$GROUP_NAME" "$USER_NAME"

mkdir -p "$WORKSPACES_ROOT"
chown -R "root:$GROUP_NAME" "$WORKSPACES_ROOT"
chmod -R 770 "$WORKSPACES_ROOT"
chmod g+s "$WORKSPACES_ROOT"

# World-readable/executable and root-owned: the sandbox user needs to be able to run
# this regardless of exactly when sudo drops privileges relative to the exec, and its
# content is fixed and harmless (just execs whatever args it's given).
cat > "$LAUNCH_SCRIPT" <<'LAUNCH_SCRIPT_EOF'
${LAUNCH_SCRIPT_CONTENT}LAUNCH_SCRIPT_EOF
chown root:root "$LAUNCH_SCRIPT"
chmod 755 "$LAUNCH_SCRIPT"

usermod -aG "$GROUP_NAME" "$APP_USER"
usermod -aG "$GROUP_NAME" "$USER_NAME"

RULE="$APP_USER ALL=($USER_NAME) NOPASSWD: $LAUNCH_SCRIPT *"
echo "$RULE" > /tmp/lokidoki-coding-sudoers
chmod 440 /tmp/lokidoki-coding-sudoers
visudo -c -f /tmp/lokidoki-coding-sudoers
install -m 440 /tmp/lokidoki-coding-sudoers "${SUDOERS_FILE}"
rm -f /tmp/lokidoki-coding-sudoers
`.trim()
}

// ── Windows ────────────────────────────────────────────────────────────────────

// PowerShell single-quoted-string escape (' → ''). Local copy rather than importing
// platform.ts's psEscape: these scripts embed values at generation time and this file
// is imported by early-boot code where an import cycle through platform.ts's heavier
// dependencies isn't worth one line.
function psq(s: string): string { return s.replace(/'/g, "''") }

/** The app's own install dir (repo root) — on Windows it lives outside any user
 *  profile, so the elevated setup has to deny it to the sandbox user explicitly. */
const APP_ROOT_DIR = join(import.meta.dir, '../../..')

/**
 * Everything this script creates, for the uninstall script to reverse (kept in sync):
 *   local user lokidoki-coding (random pw, hidden from login UI) + group
 *   lokidoki-coding-grp; deny-network/RDP-logon rights entries for the user's SID;
 *   WORKSPACES_ROOT (+users/, tmp/) with reset ACL (SYSTEM/Admins F, group M,
 *   OWNER RIGHTS M inherit-only — no CREATOR OWNER, so a file's creator can't
 *   re-grant); deny ACEs for the user on the app dir + data dir (full) and each
 *   fixed drive root (this-folder-only create-file/create-folder); registry
 *   SpecialAccounts\UserList value; the DPAPI credential blob (written LAST — its
 *   existence is the "installed" marker, so a partial run never reads as installed).
 *
 * The password is generated inside this elevated script and never leaves it except
 * as the DPAPI(LocalMachine) blob; see the header comment for why LocalMachine scope.
 * Idempotent: re-runs rotate the password and rewrite the blob (repair is always safe).
 */
function windowsSetupScript(appUser: string): string {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

$UserName = '${SANDBOX_USER}'
$GroupName = '${SANDBOX_GROUP}'
$WorkspacesRoot = '${psq(SANDBOX_WORKSPACES_ROOT)}'
$AppUser = '${psq(appUser)}'
$AppDir = '${psq(APP_ROOT_DIR)}'
$DataDir = '${psq(dataDir)}'
$BlobPath = '${psq(WIN_CRED_BLOB)}'

# 1. Random password (44 chars base64 — satisfies any complexity policy), group, user.
$bytes = New-Object byte[] 33
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$pw = [Convert]::ToBase64String($bytes)
$secure = ConvertTo-SecureString $pw -AsPlainText -Force

if (-not (Get-LocalGroup -Name $GroupName -ErrorAction SilentlyContinue)) {
  New-LocalGroup -Name $GroupName -Description 'loki-doki coding sandbox' | Out-Null
}
if (Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue) {
  Set-LocalUser -Name $UserName -Password $secure
} else {
  New-LocalUser -Name $UserName -Password $secure -PasswordNeverExpires -AccountNeverExpires -UserMayNotChangePassword -Description 'loki-doki coding sandbox (restricted)' | Out-Null
}
Add-LocalGroupMember -Group $GroupName -Member $UserName -ErrorAction SilentlyContinue
Add-LocalGroupMember -Group $GroupName -Member $AppUser -ErrorAction SilentlyContinue

# Hide from the sign-in screen (srt does the same) — it is a machinery account.
$ul = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon\\SpecialAccounts\\UserList'
New-Item -Path $ul -Force | Out-Null
Set-ItemProperty -Path $ul -Name $UserName -Value 0 -Type DWord

# 2. Deny network + RDP logon (local CreateProcessWithLogonW spawns only). Merged into
# the existing holders — secedit /configure REPLACES a right's list, so a naive write
# would wipe e.g. Guest from the deny lists.
$sid = (Get-LocalUser -Name $UserName).SID.Value
$cur = Join-Path $env:TEMP 'lokidoki-rights-cur.inf'
$cfg = Join-Path $env:TEMP 'lokidoki-rights.inf'
$db  = Join-Path $env:TEMP 'lokidoki-rights.sdb'
secedit /export /cfg $cur /areas USER_RIGHTS | Out-Null
$existing = Get-Content $cur
$merged = @()
foreach ($right in @('SeDenyNetworkLogonRight','SeDenyRemoteInteractiveLogonRight')) {
  $line = $existing | Where-Object { $_ -match ('^' + $right + '\\s*=') } | Select-Object -First 1
  if ($line) { if ($line -notmatch [regex]::Escape($sid)) { $line = $line + ',*' + $sid } }
  else { $line = $right + ' = *' + $sid }
  $merged += $line
}
$inf = @('[Unicode]','Unicode=yes','[Version]','signature="$CHICAGO$"','Revision=1','[Privilege Rights]') + $merged
Set-Content -Path $cfg -Value $inf -Encoding Unicode
secedit /configure /db $db /cfg $cfg /areas USER_RIGHTS | Out-Null
Remove-Item $cur,$cfg,$db -Force -ErrorAction SilentlyContinue

# 3. Workspace root: reset inheritance, explicit grants only. SIDs for the well-knowns
# (locale-proof): S-1-5-18 SYSTEM, S-1-5-32-544 Administrators, S-1-3-4 OWNER RIGHTS.
# OWNER RIGHTS (inherit-only, Modify) replaces the implicit CREATOR OWNER full control:
# whoever creates a file inside can use it but cannot re-grant permissions on it.
# App user + sandbox user are granted DIRECTLY, not only via the group: a Windows
# process token snapshots group membership at logon, so the already-running backend
# would not see a fresh group grant until the user logged out and back in. (The
# sandbox user always gets a fresh logon per spawn, but direct is uniform + cheap.)
New-Item -ItemType Directory -Force -Path $WorkspacesRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $WorkspacesRoot 'users') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $WorkspacesRoot 'tmp') | Out-Null
icacls $WorkspacesRoot /inheritance:r /grant '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' ($GroupName + ':(OI)(CI)M') ($AppUser + ':(OI)(CI)M') ($UserName + ':(OI)(CI)M') '*S-1-3-4:(OI)(CI)(IO)M' | Out-Null

# 4. The explicit walls (the Unix home-directory boundary, built by hand):
#    app dir + data dir: deny everything to the sandbox user.
icacls $AppDir /deny ($UserName + ':(OI)(CI)F') | Out-Null
if (Test-Path $DataDir) { icacls $DataDir /deny ($UserName + ':(OI)(CI)F') | Out-Null }
#    every fixed drive root: this-folder-only deny of create-file/create-folder —
#    fresh NTFS volume roots grant Authenticated Users create by default.
Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
  try { icacls ($_.DeviceID + '\\') /deny ($UserName + ':(WD,AD)') | Out-Null } catch { }
}

# 5. Credential blob — LAST (its existence marks the install as complete).
$blobDir = Split-Path $BlobPath
New-Item -ItemType Directory -Force -Path $blobDir | Out-Null
$enc = [System.Security.Cryptography.ProtectedData]::Protect([System.Text.Encoding]::UTF8.GetBytes($pw), $null, [System.Security.Cryptography.DataProtectionScope]::LocalMachine)
[System.IO.File]::WriteAllBytes($BlobPath, $enc)
icacls $BlobPath /inheritance:r /grant '*S-1-5-18:F' '*S-1-5-32-544:F' ($AppUser + ':R') | Out-Null
`.trim()
}

/** Exact inverse of windowsSetupScript — every artifact it creates, removed. ACE
 *  removal runs while the user still exists (icacls resolves names to SIDs). The
 *  workspace DATA is preserved (it's the household's work); its ACL is handed to
 *  Administrators + the app user. */
export function windowsUninstallScript(appUser: string): string {
  return `
$ErrorActionPreference = 'Continue'
$UserName = '${SANDBOX_USER}'
$GroupName = '${SANDBOX_GROUP}'
$WorkspacesRoot = '${psq(SANDBOX_WORKSPACES_ROOT)}'
$AppUser = '${psq(appUser)}'
$AppDir = '${psq(APP_ROOT_DIR)}'
$DataDir = '${psq(dataDir)}'
$BlobPath = '${psq(WIN_CRED_BLOB)}'

taskkill /F /FI ('USERNAME eq ' + $UserName) 2>$null | Out-Null

icacls $AppDir /remove:d $UserName | Out-Null
if (Test-Path $DataDir) { icacls $DataDir /remove:d $UserName | Out-Null }
Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
  try { icacls ($_.DeviceID + '\\') /remove:d $UserName | Out-Null } catch { }
}
if (Test-Path $WorkspacesRoot) {
  icacls $WorkspacesRoot /remove:g $GroupName | Out-Null
  icacls $WorkspacesRoot /remove:g $UserName | Out-Null
  icacls $WorkspacesRoot /grant ($AppUser + ':(OI)(CI)M') | Out-Null
}

# Remove the user's SID from the two deny-logon rights (same merge dance, inverted).
$u = Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue
if ($u) {
  $sid = $u.SID.Value
  $cur = Join-Path $env:TEMP 'lokidoki-rights-cur.inf'
  $cfg = Join-Path $env:TEMP 'lokidoki-rights.inf'
  $db  = Join-Path $env:TEMP 'lokidoki-rights.sdb'
  secedit /export /cfg $cur /areas USER_RIGHTS | Out-Null
  $existing = Get-Content $cur
  $merged = @()
  foreach ($right in @('SeDenyNetworkLogonRight','SeDenyRemoteInteractiveLogonRight')) {
    $line = $existing | Where-Object { $_ -match ('^' + $right + '\\s*=') } | Select-Object -First 1
    if ($line -and $line -match [regex]::Escape($sid)) {
      $parts = ($line -split '=',2)[1].Trim() -split ',' | Where-Object { $_.Trim() -ne ('*' + $sid) }
      $merged += ($right + ' = ' + ($parts -join ','))
    }
  }
  if ($merged.Count -gt 0) {
    $inf = @('[Unicode]','Unicode=yes','[Version]','signature="$CHICAGO$"','Revision=1','[Privilege Rights]') + $merged
    Set-Content -Path $cfg -Value $inf -Encoding Unicode
    secedit /configure /db $db /cfg $cfg /areas USER_RIGHTS | Out-Null
  }
  Remove-Item $cur,$cfg,$db -Force -ErrorAction SilentlyContinue
  # Profile dir (created by LoadUserProfile on first spawn), then the account itself.
  Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid } | ForEach-Object { try { $_ | Remove-CimInstance } catch { } }
  Remove-LocalUser -Name $UserName -ErrorAction SilentlyContinue
}
Remove-LocalGroup -Name $GroupName -ErrorAction SilentlyContinue
Remove-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon\\SpecialAccounts\\UserList' -Name $UserName -ErrorAction SilentlyContinue
Remove-Item $BlobPath -Force -ErrorAction SilentlyContinue
`.trim()
}

export interface RunAsSandboxUserOptions {
  /** probe = run to completion, exit code returned; spawn = start detached, return immediately. */
  mode: 'probe' | 'spawn'
  exe: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
  /** Start from a minimal system env instead of inheriting the backend's (which
   *  carries real secrets a sandbox-user process could read out of its own block). */
  cleanEnv?: boolean
  timeoutMs?: number
}

/**
 * Run a command as the restricted Windows sandbox user via scripts/win-sandbox-runner.ps1
 * (which decrypts the DPAPI blob and calls .NET Process.Start with credentials —
 * CreateProcessWithLogonW under the hood; hidden window, no native helper of ours).
 * All parameters travel via environment variables, never the command line: env is
 * inherited privately by the child, argv is visible to other local processes.
 */
export async function runAsSandboxUser(opts: RunAsSandboxUserOptions): Promise<{ code: number; stdout: string; stderr: string }> {
  const timeoutMs = opts.timeoutMs ?? 30_000
  const env = {
    ...process.env,
    LOKIDOKI_SB_MODE: opts.mode,
    LOKIDOKI_SB_BLOB: WIN_CRED_BLOB,
    LOKIDOKI_SB_USER: SANDBOX_USER,
    LOKIDOKI_SB_EXE: opts.exe,
    LOKIDOKI_SB_ARGS: JSON.stringify(opts.args),
    LOKIDOKI_SB_CWD: opts.cwd ?? SANDBOX_WORKSPACES_ROOT,
    LOKIDOKI_SB_ENV: JSON.stringify(opts.env ?? {}),
    LOKIDOKI_SB_CLEAN: opts.cleanEnv ? '1' : '0',
    LOKIDOKI_SB_TIMEOUT_MS: String(timeoutMs),
  }
  try {
    const { stdout, stderr } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WIN_RUNNER_PS1],
      { env, timeout: timeoutMs + 15_000, windowsHide: true },
    )
    return { code: 0, stdout, stderr }
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string }
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? String(err) }
  }
}

/**
 * The honest "does the wall actually hold" check, run at install time (the
 * opencode-sandbox lesson: a sandbox that fails open is worse than none, because it
 * changes behavior — headless runs auto-approve — based on protection that isn't there).
 * 1. logon works; 2. the app data dir is UNREADABLE (probe the blob itself — it
 * always exists and must be denied); 3. the workspace root is writable.
 */
export async function verifyWindowsSandboxBoundary(): Promise<void> {
  const logon = await runAsSandboxUser({ mode: 'probe', exe: 'cmd.exe', args: ['/c', 'exit 0'] })
  if (logon.code !== 0) {
    throw new Error(`Sandbox user logon failed (exit ${logon.code}): ${logon.stderr.slice(0, 300)} — a policy may deny local logon (the Codex error-1385 analog), or the credential blob is stale. Re-run the sandbox setup.`)
  }
  const read = await runAsSandboxUser({ mode: 'probe', exe: 'cmd.exe', args: ['/c', `type "${WIN_CRED_BLOB}"`] })
  if (read.code === 0) {
    throw new Error('FAIL-OPEN: the sandbox user can read the app data directory. The deny ACEs did not take effect — coding isolation is NOT active. Re-run the sandbox setup and check icacls output on the data dir.')
  }
  const write = await runAsSandboxUser({
    mode: 'probe', exe: 'cmd.exe',
    args: ['/c', 'echo ok > .lokidoki-sandbox-probe && del .lokidoki-sandbox-probe'],
    cwd: join(SANDBOX_WORKSPACES_ROOT, 'users'),
  })
  if (write.code !== 0) {
    throw new Error(`Sandbox user cannot write the coding workspace root (exit ${write.code}) — the group ACL on ${SANDBOX_WORKSPACES_ROOT} is wrong. Re-run the sandbox setup.`)
  }
}

/**
 * One-time elevated setup. Prompts for OS admin consent exactly once (native dialog:
 * Touch ID/password on macOS via osascript, the desktop's own polkit agent on Linux
 * via pkexec, the UAC consent dialog on Windows via Start-Process -Verb RunAs — the
 * same pattern gpuTuning.ts already uses): every later coding-sidecar spawn is
 * silent, gated only by the scoped sudoers rule (Unix) / DPAPI credential blob
 * (Windows) this writes.
 *
 * IMPORTANT (Unix): the app's own backend process needs to be RESTARTED after this
 * completes. Supplementary group membership is read at process/session start, so
 * the already-running backend won't see its new write access to the workspaces
 * root until it restarts. (Windows needs no restart: access is granted to the app
 * user directly by ACL, not via group membership of the running process token.)
 */
export async function installSandboxUser(onStatus: (msg: string) => void): Promise<void> {
  if (IS_WIN) {
    await installWindowsSandboxUser(onStatus)
    return
  }

  const appUser = currentUser()
  const script = IS_MAC ? macSetupScript(appUser) : IS_LINUX ? linuxSetupScript(appUser) : null
  if (!script) throw new Error('Unsupported platform for coding sandbox isolation.')

  onStatus('Requesting one-time admin permission…')
  // Write the script to a temp file rather than inline-escaping it into an
  // AppleScript/shell one-liner: a multi-line script with its own quotes, heredocs,
  // and $-expansions doesn't survive being crammed through two more layers of string
  // escaping (confirmed live: it doesn't, in several different ways at once). A file
  // path is trivial to escape regardless of what's inside it.
  const scriptPath = '/tmp/lokidoki-coding-setup.sh'
  writeFileSync(scriptPath, `#!/bin/bash\n${script}\n`, { mode: 0o700 })
  try {
    if (IS_MAC) {
      // osascript's `with administrator privileges` shows the native macOS password/
      // Touch ID dialog and runs the given shell command as root just once.
      execSync(`osascript -e 'do shell script "bash ${scriptPath}" with administrator privileges'`, { timeout: 120_000 })
    } else {
      execFileSync('pkexec', ['bash', scriptPath], { timeout: 120_000, stdio: 'ignore' })
    }
  } finally {
    rmSync(scriptPath, { force: true })
  }

  onStatus('Verifying…')
  if (!isSandboxUserInstalled()) {
    throw new Error('Sandbox user setup ran but verification failed. Check that it completed correctly.')
  }
  // The fail-open assert (shared contract with Windows — see verifyWindowsSandboxBoundary):
  // the whole design rests on the app living inside a home directory the sandbox user
  // cannot traverse. If a deployment moves the app outside one, isolation silently
  // wouldn't isolate — refuse to report success instead.
  const probeFile = join(import.meta.dir, '../../package.json')
  let boundaryHolds = false
  try {
    execFileSync('sudo', ['-n', '-u', SANDBOX_USER, LAUNCH_SCRIPT, '/bin/cat', probeFile], { stdio: 'ignore', timeout: 5_000 })
  } catch { boundaryHolds = true }
  if (!boundaryHolds) {
    throw new Error(`FAIL-OPEN: the sandbox user can read the app's own files (${probeFile}). The app must be installed inside a home directory for coding isolation to protect it — isolation is NOT active.`)
  }
  onStatus('Coding sandbox ready. Restart the app for it to take effect.')
}

/** Windows branch of installSandboxUser: one UAC consent, then hard verification. */
async function installWindowsSandboxUser(onStatus: (msg: string) => void): Promise<void> {
  const appUser = currentUser()
  onStatus('Requesting one-time Windows admin permission (approve the UAC prompt)…')
  const scriptPath = join(tmpdir(), 'lokidoki-coding-setup.ps1')
  writeFileSync(scriptPath, windowsSetupScript(appUser))
  try {
    // Same elevation pattern as gpuTuning.ts: a plain spawn of elevated work fails
    // silently; Start-Process -Verb RunAs raises the UAC dialog, -Wait -PassThru
    // surfaces the real exit code. The inner path is double-quoted inside the
    // single-quoted PS string so a space-containing temp path survives.
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `$p = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','"${psq(scriptPath)}"' -Verb RunAs -Wait -PassThru; exit $p.ExitCode`,
    ], { timeout: 180_000, windowsHide: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.toLowerCase().includes('canceled')) {
      throw new Error('The Windows admin prompt was declined — coding sandbox isolation was not set up.')
    }
    throw new Error(`Coding sandbox setup failed: ${msg}`)
  } finally {
    rmSync(scriptPath, { force: true })
  }

  onStatus('Verifying the isolation boundary actually holds…')
  if (!isSandboxUserInstalled()) {
    throw new Error('Sandbox setup ran but its artifacts are missing (credential blob / workspace root). Check the elevated PowerShell output.')
  }
  await verifyWindowsSandboxBoundary()
  onStatus('Coding sandbox ready.')
}

/**
 * Elevated removal (Windows): kills sandbox-user processes, strips every ACE/right/
 * account the setup created, deletes the credential blob. Workspace data is kept.
 */
export async function uninstallWindowsSandboxUser(onStatus: (msg: string) => void): Promise<void> {
  if (!IS_WIN) throw new Error('uninstallWindowsSandboxUser is Windows-only.')
  const appUser = currentUser()
  onStatus('Requesting one-time Windows admin permission (approve the UAC prompt)…')
  const scriptPath = join(tmpdir(), 'lokidoki-coding-uninstall.ps1')
  writeFileSync(scriptPath, windowsUninstallScript(appUser))
  try {
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `$p = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','"${psq(scriptPath)}"' -Verb RunAs -Wait -PassThru; exit $p.ExitCode`,
    ], { timeout: 180_000, windowsHide: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.toLowerCase().includes('canceled')) {
      throw new Error('The Windows admin prompt was declined — coding sandbox isolation was not removed.')
    }
    throw new Error(`Coding sandbox removal failed: ${msg}`)
  } finally {
    rmSync(scriptPath, { force: true })
  }
  onStatus('Coding sandbox isolation removed (workspace data kept).')
}

/**
 * Mirrors the OpenCode runtime (installed under this app's own data/ dir, inside the
 * home directory) into SANDBOX_RUNTIME_DIR so the restricted sandbox user can
 * actually reach and execute it. Same reasoning as the launch script: anything the
 * sandbox user needs to run has to live outside any home directory, since it can't
 * traverse into one at all. No elevated privileges needed for the copy itself: the
 * destination is group-writable by this app's own runtime user once the group setup
 * above has run. Cheap no-op re-check on every call; only copies when missing.
 */
export function ensureSandboxRuntimeMirrored(sourceDir: string): void {
  if (existsSync(SANDBOX_RUNTIME_DIR)) return
  mkdirSync(SANDBOX_RUNTIME_DIR, { recursive: true })
  cpSync(sourceDir, SANDBOX_RUNTIME_DIR, { recursive: true })
}

// ── Windows runtime mirror ─────────────────────────────────────────────────────
// The restricted sidecar needs MORE mirrored than the mac pane does: the app dir and
// data dir are deny-ACE'd wholesale, so node.exe, the sidecar script + its packages
// (ws, node-pty and their prebuilds), and the Claude Code runtime all have to live
// under the workspace root. Layout: runtime\node\node.exe, runtime\sidecar\…,
// runtime\claude\… (mac keeps its flat runtime/ = claude layout untouched).

const WIN_MIRROR_NODE = join(SANDBOX_RUNTIME_DIR, 'node', 'node.exe')
const WIN_MIRROR_SIDECAR_DIR = join(SANDBOX_RUNTIME_DIR, 'sidecar')
export const WIN_MIRROR_CLAUDE_DIR = join(SANDBOX_RUNTIME_DIR, 'claude')

/** Copy a package and its transitive (optional)dependencies from backend/node_modules.
 *  dereference: bun links some packages; the sandbox user can't follow a symlink into
 *  the deny-ACE'd app dir, so the mirror must be real files. */
function mirrorPackageWithDeps(backendNodeModules: string, destModules: string, pkg: string, seen: Set<string>): void {
  if (seen.has(pkg)) return
  seen.add(pkg)
  const src = join(backendNodeModules, pkg)
  if (!existsSync(src)) return
  cpSync(src, join(destModules, pkg), { recursive: true, dereference: true })
  try {
    const meta = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    }
    for (const dep of [...Object.keys(meta.dependencies ?? {}), ...Object.keys(meta.optionalDependencies ?? {})]) {
      mirrorPackageWithDeps(backendNodeModules, destModules, dep, seen)
    }
  } catch { /* package without a readable manifest — nothing more to walk */ }
}

/**
 * Ensure the sandbox-reachable mirror of everything the restricted sidecar executes.
 * Same freshness policy as the mac mirror: presence-checked per piece, re-copied only
 * when missing (a claude/node version bump repairs itself because the caller wipes
 * the mirror when the mirrored binary vanishes — see ensureFreshSandboxRuntimeMirror).
 * Returns the paths the spawner needs. `nodeExe === 'node'` (system PATH install,
 * world-readable) is passed through un-mirrored.
 */
export function ensureWindowsSandboxMirror(nodeExe: string, claudeCodeDir: string, backendDir: string): { nodeExe: string; sidecarScript: string; claudeDir: string } {
  const sidecarScript = join(WIN_MIRROR_SIDECAR_DIR, 'coding-pty-sidecar.ts')

  let mirroredNode = nodeExe
  if (nodeExe !== 'node') {
    if (!existsSync(WIN_MIRROR_NODE)) {
      mkdirSync(dirname(WIN_MIRROR_NODE), { recursive: true })
      copyFileSync(nodeExe, WIN_MIRROR_NODE)
    }
    mirroredNode = WIN_MIRROR_NODE
  }

  if (!existsSync(sidecarScript) || !existsSync(join(WIN_MIRROR_SIDECAR_DIR, 'node_modules', 'node-pty'))) {
    rmSync(WIN_MIRROR_SIDECAR_DIR, { recursive: true, force: true })
    const destModules = join(WIN_MIRROR_SIDECAR_DIR, 'node_modules')
    mkdirSync(destModules, { recursive: true })
    copyFileSync(join(backendDir, 'scripts', 'coding-pty-sidecar.ts'), sidecarScript)
    const seen = new Set<string>()
    for (const pkg of ['ws', 'node-pty']) mirrorPackageWithDeps(join(backendDir, 'node_modules'), destModules, pkg, seen)
  }

  if (!existsSync(join(WIN_MIRROR_CLAUDE_DIR, 'node_modules', '.bin', 'claude.exe'))) {
    rmSync(WIN_MIRROR_CLAUDE_DIR, { recursive: true, force: true })
    mkdirSync(WIN_MIRROR_CLAUDE_DIR, { recursive: true })
    cpSync(claudeCodeDir, WIN_MIRROR_CLAUDE_DIR, { recursive: true, dereference: true })
  }

  return { nodeExe: mirroredNode, sidecarScript, claudeDir: WIN_MIRROR_CLAUDE_DIR }
}

/**
 * Kills any leftover sandboxed sidecar processes from before a backend restart.
 * Real gap this closes (found live): the sandboxed opencode process's actual PID
 * belongs to `sudo`'s forked child, not the `sudo` invocation Node's own spawn()
 * returns a handle to, and jessetorres cannot signal a lokidoki-coding-owned
 * process directly regardless (confirmed live: EPERM), so a plain restart orphans
 * it permanently, invisible to and unmanageable by the backend's in-memory state
 * (which resets on every restart), silently squatting on its port forever.
 *
 * Deliberately a broad `pkill -f` sweep, not a specific-PID kill: it runs AS
 * lokidoki-coding via the same sudoers-permitted launch script already used to
 * spawn (no new sudoers grant needed), so it can only ever match/kill processes
 * that user itself owns, and that user exists for no other purpose, so killing
 * every tmux/claude process it's running is always safe. Best-effort: a clean box
 * with nothing to kill is the common case, not a failure.
 */
export function killSandboxedOrphans(): void {
  // Windows: no sudo/pkill — orphan cleanup is cooperative (sidecar /shutdown) plus
  // the taskkill in the elevated uninstall script; a still-listening sidecar is
  // deliberately ADOPTED across backend restarts, not killed (sessions survive).
  if (IS_WIN || !isSandboxUserInstalled()) return
  try {
    // Matches the per-user tmux server sockets codingServer.ts creates (`-S
    // <workspace>/.tmux.sock`) — killing the tmux server also takes down the
    // `claude` process running inside it, and any attach-client PTYs.
    execFileSync('sudo', ['-n', '-u', SANDBOX_USER, LAUNCH_SCRIPT, '/usr/bin/pkill', '-f', 'tmux -S .*\\.tmux\\.sock'], { stdio: 'ignore', timeout: 5_000 })
  } catch { /* nothing to kill, or already gone (pkill exits non-zero on no match) */ }
}
