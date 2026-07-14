import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { getAppSetting, setAppSetting } from '@/lib/settings'

// Reversible at-rest encryption for admin-managed secrets (homelab SSH/VNC/RDP
// passwords and private keys). Unlike pin.ts, which HMAC-hashes a PIN one-way, these
// values must be decryptable to actually open a connection, so this uses AES-256-GCM.
//
// Key management mirrors pin.ts exactly: an operator-set SECRETS_KEY (hex, 32 bytes)
// takes precedence so the key can live outside the DB and survive a DB reset; otherwise
// a random key is generated and persisted to app_settings on first use, so a fresh
// install just works (env + DB share the box here, so a stored key is no weaker than an
// env one). NEVER log or return the plaintext to a client.

const KEY_SETTING_KEY = 'security.secrets_key'
let cachedKey: Buffer | null = null

async function getKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey
  const envKey = process.env.SECRETS_KEY
  if (envKey && /^[0-9a-fA-F]{64}$/.test(envKey)) {
    cachedKey = Buffer.from(envKey, 'hex')
    return cachedKey
  }
  let stored = (await getAppSetting(KEY_SETTING_KEY)) as string | null
  if (!stored || !/^[0-9a-fA-F]{64}$/.test(stored)) {
    stored = randomBytes(32).toString('hex')
    await setAppSetting(KEY_SETTING_KEY, stored)
  }
  cachedKey = Buffer.from(stored, 'hex')
  return cachedKey
}

// Serialized as base64 iv:authTag:ciphertext, three fixed-shape parts so decrypt can
// split unambiguously (the first two are constant length; only the payload varies).
export async function encryptSecret(plain: string): Promise<string> {
  const key = await getKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`
}

export async function decryptSecret(blob: string): Promise<string> {
  const key = await getKey()
  const [ivB64, tagB64, dataB64] = blob.split(':')
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('decryptSecret: malformed ciphertext')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8')
}
