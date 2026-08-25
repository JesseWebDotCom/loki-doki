// Who this hub is, independent of how you reached it.
//
// A client that keeps several addresses for the same server has to be able to tell
// "the hub, via the LAN IP" from "some other machine that happens to answer on
// 192.168.1.50:3000". Without that check, a laptop on a cafe network probes its
// cached LAN address, gets a 200 from a stranger's box, and posts credentials at it.
// So every address the client tries must prove the same instance id before the
// client will send anything.

import { hostname } from 'node:os'
import { getAppSetting, setAppSetting } from '@/lib/settings'

const INSTANCE_KEY = 'hub.instance_id'
const NAME_KEY = 'hub.name'

let cachedInstanceId: string | null = null

/** Stable id for this install, minted once and never rotated (rotating it would sign
 *  out every device that has us cached). */
export async function getHubInstanceId(): Promise<string> {
  if (cachedInstanceId) return cachedInstanceId
  const stored = await getAppSetting(INSTANCE_KEY)
  if (typeof stored === 'string' && stored.length > 0) {
    cachedInstanceId = stored
    return stored
  }
  const minted = crypto.randomUUID()
  await setAppSetting(INSTANCE_KEY, minted)
  cachedInstanceId = minted
  return minted
}

/** Display name clients show while connecting ("Connecting to Basement Hub"). */
export async function getHubName(): Promise<string> {
  const stored = await getAppSetting(NAME_KEY)
  if (typeof stored === 'string' && stored.trim()) return stored.trim()
  return hostname().replace(/\.local$/, '') || 'MaiPai Home'
}

export async function setHubName(name: string): Promise<void> {
  await setAppSetting(NAME_KEY, name.trim().slice(0, 60))
}
