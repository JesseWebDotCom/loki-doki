import { createHmac, randomBytes } from 'node:crypto'
import { getAppSetting, setAppSetting } from '@/lib/settings'

const PEPPER_SETTING_KEY = 'security.pin_pepper'
let cachedPepper: Buffer | null = null

// Resolve the HMAC pepper. An operator-set PIN_PEPPER_SECRET (hex) takes precedence so
// existing hashes stay valid and the secret can live outside the DB; otherwise we
// generate one and persist it to app_settings on first use, so a fresh `git clone`
// install has working PIN login without manual .env setup (env + DB share the box here,
// so a stored pepper is no weaker than an env one). Previously this threw when unset,
// 500-ing PIN/adult-gate endpoints on a clean install.
async function getPepper(): Promise<Buffer> {
  if (cachedPepper) return cachedPepper
  const envSecret = process.env.PIN_PEPPER_SECRET
  if (envSecret && /^[0-9a-fA-F]{2,}$/.test(envSecret)) {
    const buf = Buffer.from(envSecret, 'hex')
    if (buf.byteLength > 0) { cachedPepper = buf; return buf }
  }
  let stored = (await getAppSetting(PEPPER_SETTING_KEY)) as string | null
  if (!stored) {
    stored = randomBytes(32).toString('hex')
    await setAppSetting(PEPPER_SETTING_KEY, stored)
  }
  cachedPepper = Buffer.from(stored, 'hex')
  return cachedPepper
}

async function applyPepper(pin: string): Promise<string> {
  const pepper = await getPepper()
  return createHmac('sha256', pepper).update(pin).digest('base64')
}

export async function hashPin(pin: string): Promise<string> {
  return Bun.password.hash(await applyPepper(pin), {
    algorithm: 'argon2id',
    memoryCost: 65536,
    timeCost: 3,
  })
}

export async function verifyPin(pin: string, hash: string): Promise<boolean> {
  return Bun.password.verify(await applyPepper(pin), hash)
}

// Exponential backoff after 5 failed attempts: 30s, 2m, 10m, 1h
export function lockoutDuration(failedAttempts: number): number {
  const backoffs = [30_000, 120_000, 600_000, 3_600_000]
  const index = Math.min(failedAttempts - 5, backoffs.length - 1)
  return backoffs[index] ?? 3_600_000
}
