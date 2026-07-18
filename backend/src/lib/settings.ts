import { db } from '@/db'
import { appSettings } from '@/db/schema'
import { eq } from 'drizzle-orm'

export async function getAppSetting(key: string): Promise<unknown | null> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, key)).limit(1)
  return row ? JSON.parse(row.value) : null
}

// Upsert — overwrites existing values (unlike hwfit's setSetting which is no-overwrite).
// Used by the wizard to persist admin-chosen model selections and first_run_complete.
export async function setAppSetting(key: string, value: unknown): Promise<void> {
  const now = new Date()
  const serialized = JSON.stringify(value)
  await db
    .insert(appSettings)
    .values({ id: crypto.randomUUID(), key, value: serialized, updatedAt: now })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: serialized, updatedAt: now } })
}

export async function deleteAppSetting(key: string): Promise<void> {
  await db.delete(appSettings).where(eq(appSettings.key, key))
}
