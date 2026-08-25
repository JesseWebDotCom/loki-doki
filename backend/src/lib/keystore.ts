// Keeps at-rest encryption keys (the PIN pepper, the secrets AES key) OUT of the
// SQLite database. Historically an unset SECRETS_KEY / PIN_PEPPER_SECRET meant the
// key was generated and stored in app_settings - i.e. inside the very DB it protects,
// so a stolen app.db (or a scheduled backup, which snapshots the DB and can target a
// NAS) carried its own key. This module moves the fallback key to a file under
// data/keys/ instead, which is excluded from both the DB snapshot and the files
// mirror, so DB-only theft no longer exposes the key.
//
// Precedence is still: an operator-set env var (handled by the callers) wins; this
// module only owns the generated-fallback path. Storage per platform:
//   - macOS:   the login Keychain (via `security`), falling back to the key file.
//   - Windows: the key file, its contents DPAPI-protected (CurrentUser scope).
//   - Linux:   a 0600 hex key file (same trust boundary as the DB file itself).
// Existing installs are migrated: a legacy app_settings key is adopted into the new
// store and then deleted from the DB, so the hole closes without invalidating any
// existing PIN hashes or encrypted secrets.

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { dataDir } from '@/lib/download'
import { deleteAppSetting, getAppSetting } from '@/lib/settings'
import { logger } from '@/lib/logger'

const KEYS_DIR = join(dataDir, 'keys')
const KEYCHAIN_ACCOUNT = 'maipai-home'
const DPAPI_PREFIX = 'dpapi:'

interface KeyOptions {
  /** Where the key used to live in app_settings, to migrate it out of the DB. */
  legacyAppSettingKey?: string
  /** Key length in bytes when a fresh key is generated. Default 32. */
  bytes?: number
}

function keyFile(name: string): string {
  return join(KEYS_DIR, `${name}.key`)
}

function ensureKeysDir(): void {
  if (!existsSync(KEYS_DIR)) mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 })
  try { chmodSync(KEYS_DIR, 0o700) } catch { /* best-effort on non-POSIX */ }
}

// ── Windows DPAPI (CurrentUser) via PowerShell ──────────────────────────────────

function dpapiProtect(hex: string): string | null {
  try {
    const ps =
      'Add-Type -AssemblyName System.Security; ' +
      `$b=[System.Text.Encoding]::UTF8.GetBytes('${hex}'); ` +
      "$e=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'); " +
      '[Convert]::ToBase64String($e)'
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 8000 })
    return DPAPI_PREFIX + out.toString().trim()
  } catch {
    return null
  }
}

function dpapiUnprotect(blob: string): string | null {
  try {
    const b64 = blob.slice(DPAPI_PREFIX.length)
    const ps =
      'Add-Type -AssemblyName System.Security; ' +
      `$e=[Convert]::FromBase64String('${b64}'); ` +
      "$d=[System.Security.Cryptography.ProtectedData]::Unprotect($e,$null,'CurrentUser'); " +
      '[System.Text.Encoding]::UTF8.GetString($d)'
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 8000 })
    return out.toString().trim()
  } catch {
    return null
  }
}

// ── macOS Keychain via `security` ───────────────────────────────────────────────

function keychainService(name: string): string {
  return `com.maipai-home.keystore.${name}`
}

function keychainRead(name: string): string | null {
  try {
    const out = execFileSync(
      'security',
      ['find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', keychainService(name), '-w'],
      { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    const val = out.toString().trim()
    return val || null
  } catch {
    return null // not found, or the keychain is locked (headless) → caller falls back to file
  }
}

function keychainWrite(name: string, hex: string): boolean {
  try {
    execFileSync(
      'security',
      ['add-generic-password', '-U', '-a', KEYCHAIN_ACCOUNT, '-s', keychainService(name), '-w', hex],
      { timeout: 5000, stdio: 'ignore' },
    )
    return true
  } catch {
    return false
  }
}

// ── File store (universal fallback / primary off-macOS) ─────────────────────────

function fileRead(name: string): string | null {
  const path = keyFile(name)
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, 'utf8').trim()
    if (raw.startsWith(DPAPI_PREFIX)) {
      const dec = dpapiUnprotect(raw)
      return dec && /^[0-9a-fA-F]+$/.test(dec) ? dec : null
    }
    return /^[0-9a-fA-F]+$/.test(raw) ? raw : null
  } catch {
    return null
  }
}

function fileWrite(name: string, hex: string): void {
  ensureKeysDir()
  const path = keyFile(name)
  // On Windows, protect the contents with DPAPI when we can; elsewhere the 0600
  // perms are the protection (same boundary as the DB file's own perms).
  const body = process.platform === 'win32' ? (dpapiProtect(hex) ?? hex) : hex
  writeFileSync(path, body, { mode: 0o600 })
  try { chmodSync(path, 0o600) } catch { /* best-effort on non-POSIX */ }
}

// ── Platform-aware read/write ───────────────────────────────────────────────────

function readStored(name: string): string | null {
  if (process.platform === 'darwin') {
    const fromChain = keychainRead(name)
    if (fromChain && /^[0-9a-fA-F]+$/.test(fromChain)) return fromChain
  }
  return fileRead(name)
}

function writeStored(name: string, hex: string): void {
  if (process.platform === 'darwin' && keychainWrite(name, hex)) return
  fileWrite(name, hex)
}

// ── Public API ──────────────────────────────────────────────────────────────────

/** Resolve (or create) a hex key kept outside the database. Callers keep their own
 *  env-var precedence check; this owns only the generated-fallback store. */
export async function getOrCreateHexKey(name: string, opts: KeyOptions = {}): Promise<string> {
  const bytes = opts.bytes ?? 32

  const existing = readStored(name)
  if (existing) return existing

  // Migrate a legacy in-DB key out of the database, preserving existing data.
  if (opts.legacyAppSettingKey) {
    const legacy = (await getAppSetting(opts.legacyAppSettingKey)) as string | null
    if (legacy && /^[0-9a-fA-F]+$/.test(legacy)) {
      writeStored(name, legacy)
      await deleteAppSetting(opts.legacyAppSettingKey)
      logger.info(`[keystore] migrated ${name} out of the database into the key store`)
      return legacy
    }
  }

  const fresh = randomBytes(bytes).toString('hex')
  writeStored(name, fresh)
  return fresh
}
