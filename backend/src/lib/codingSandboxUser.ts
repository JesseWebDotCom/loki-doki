// One-time, admin-elevated setup that gives the coding sidecar a real OS-enforced
// sandbox: a restricted system user with zero access to any home directory (so it
// structurally cannot read or write this app's own repo), instead of relying on
// `opencode-sandbox`'s Seatbelt/bubblewrap wrapping: verified live to fail open on
// this machine (sandbox-exec itself returns "Operation not permitted" here even for
// a trivial unrelated command; the plugin just runs commands unsandboxed when its
// wrapper fails, silently).
//
// Why a separate OS user works without any of that: `/Users/<you>` is `drwxr-x---`
// by default, zero access for any other Unix user, full stop, no code required.
// A process running as a different user can't even traverse into the home directory,
// so this app's repo (which lives inside it) is unreachable regardless of the repo's
// own more permissive mode bits. This also makes the fix tool-agnostic: it protects
// whatever gets spawned as this user, OpenCode today, anything else later, since
// it's a kernel-enforced boundary, not an app-specific plugin that can fail open.
//
// The one consequence: the coding workspace data has to live OUTSIDE any home
// directory (a restricted user can't reach one), at a real system data path, owned
// by a group shared between the restricted user and this app's own runtime user so
// both sides can read/write it.

import { existsSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { execFileSync, execSync } from 'node:child_process'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { IS_MAC, IS_LINUX, IS_WIN } from '@/lib/platform'

export const SANDBOX_USER = 'lokidoki-coding'
export const SANDBOX_GROUP = 'lokidoki-coding-grp'
export const SANDBOX_WORKSPACES_ROOT = IS_MAC
  ? '/usr/local/var/lokidoki-coding'
  : '/var/lib/lokidoki-coding'
const SUDOERS_FILE = '/etc/sudoers.d/lokidoki-coding'
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
  if (IS_WIN) return false
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

/**
 * One-time elevated setup. Prompts for the OS admin password exactly once (native
 * dialog: Touch ID/password on macOS via osascript, the desktop's own polkit agent
 * on Linux via pkexec): every later coding-sidecar spawn is silent, gated only by
 * the scoped sudoers rule this writes. Throws on Windows (unsupported; the caller
 * falls back to approval-gate-only, same precedent as Ollama's Windows install).
 *
 * IMPORTANT: the app's own backend process needs to be RESTARTED after this
 * completes. Supplementary group membership is read at process/session start, so
 * the already-running backend won't see its new write access to the workspaces
 * root until it restarts.
 */
export async function installSandboxUser(onStatus: (msg: string) => void): Promise<void> {
  if (IS_WIN) throw new Error('Coding sandbox isolation is not available on Windows. File edits/commands still pause for your approval, but there is no OS-level filesystem wall.')

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
  onStatus('Coding sandbox ready. Restart the app for it to take effect.')
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
 * every opencode process it's running is always safe. Best-effort: a clean box
 * with nothing to kill is the common case, not a failure.
 */
export function killSandboxedOrphans(): void {
  if (!isSandboxUserInstalled()) return
  try {
    execFileSync('sudo', ['-n', '-u', SANDBOX_USER, LAUNCH_SCRIPT, '/usr/bin/pkill', '-f', 'opencode web --port'], { stdio: 'ignore', timeout: 5_000 })
  } catch { /* nothing to kill, or already gone (pkill exits non-zero on no match) */ }
}
