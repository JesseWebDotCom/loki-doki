// Read-only file access for the companion — the TRUST BOUNDARY lives here, in
// the main process. The pages this shell loads are server-controlled code, so
// nothing they send is trusted: every call re-reads the enable flag from
// settings, resolves the real path (realpath kills ../ traversal AND symlink
// escape), requires it to sit inside a user-picked allowed root, and refuses a
// denylist of credential/secret paths even inside allowed roots.
//
// This module deliberately contains NO write operations of any kind — the only
// fs calls are realpath/stat/readdir/readFile/open-for-read. Allowed roots are
// granted exclusively through the native folder picker (pickFolder below); the
// page can only flip the on/off boolean.

const fs = require('node:fs')
const path = require('node:path')
const { dialog } = require('electron')

const MAX_READ_BYTES = 1024 * 1024 // 1 MB text cap
const MAX_LIST_ENTRIES = 500
const MAX_RECENT = 50

// Refused even inside an allowed root: keys, credentials, tokens, password
// stores, browser profiles. Matched against every path segment (lowercased).
const DENY_SEGMENTS = new Set([
  '.ssh', '.aws', '.gnupg', '.kube', '.docker', '.netrc', '.git-credentials',
  '.password-store', 'keychains', 'cookies',
  // Browser profile dirs (session cookies, saved passwords).
  'chrome', 'chromium', 'brave-browser', 'microsoft edge', 'firefox', 'safari',
])
const DENY_FILE_PATTERNS = [
  /^\.env(\.|$)/i,      // .env, .env.local, …
  /^id_(rsa|ed25519|ecdsa|dsa)(\.|$)/i,
  /\.(pem|key|p12|pfx|keychain(-db)?)$/i,
  /^\.htpasswd$/i,
]

const recent = [] // audit ring: what the companion actually read

function record(action, p, ok) {
  recent.unshift({ action, path: p, ok, at: Date.now() })
  if (recent.length > MAX_RECENT) recent.length = MAX_RECENT
}

function deniedSegment(realPath) {
  const segs = realPath.split(path.sep)
  const last = segs[segs.length - 1] ?? ''
  if (segs.some((s) => DENY_SEGMENTS.has(s.toLowerCase()))) return true
  return DENY_FILE_PATTERNS.some((re) => re.test(last))
}

/** Resolve + authorize a requested path. Returns { real } or { error }. */
function authorize(settings, requested) {
  if (settings.fileAccessEnabled !== true) return { error: 'permission_off' }
  const roots = Array.isArray(settings.fileAccessRoots) ? settings.fileAccessRoots : []
  if (roots.length === 0) return { error: 'no_roots' }
  if (typeof requested !== 'string' || !requested.trim()) return { error: 'bad_path' }
  let real
  try {
    // realpath resolves .. and every symlink in the chain — the prefix check
    // below therefore holds for the actual on-disk location, not the spelling.
    real = fs.realpathSync(path.resolve(requested.trim()))
  } catch {
    return { error: 'not_found' }
  }
  const inRoot = roots.some((root) => {
    let realRoot
    try { realRoot = fs.realpathSync(root) } catch { return false }
    return real === realRoot || real.startsWith(realRoot + path.sep)
  })
  if (!inRoot) return { error: 'outside_roots' }
  if (deniedSegment(real)) return { error: 'denied_path' }
  return { real }
}

function statEntry(p) {
  const st = fs.statSync(p)
  return {
    name: path.basename(p),
    path: p,
    kind: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other',
    size: st.size,
    modifiedAt: st.mtimeMs,
  }
}

function listDir(real) {
  const names = fs.readdirSync(real)
  const truncated = names.length > MAX_LIST_ENTRIES
  const entries = []
  for (const name of names.slice(0, MAX_LIST_ENTRIES)) {
    const p = path.join(real, name)
    // Hide denylisted children from listings so their names don't leak either.
    if (deniedSegment(p)) continue
    try { entries.push(statEntry(p)) } catch { /* raced deletion / no access */ }
  }
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
  return { entries, truncated }
}

function readFileBounded(real) {
  const st = fs.statSync(real)
  if (!st.isFile()) return { error: 'not_a_file' }
  const size = st.size
  const fd = fs.openSync(real, 'r') // read-only descriptor
  try {
    const len = Math.min(size, MAX_READ_BYTES)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, 0)
    // NUL-byte sniff: binaries get metadata only, never raw bytes.
    if (buf.subarray(0, Math.min(len, 8192)).includes(0)) {
      return { data: { binary: true, size, name: path.basename(real) } }
    }
    return {
      data: {
        binary: false,
        size,
        name: path.basename(real),
        truncated: size > MAX_READ_BYTES,
        content: buf.toString('utf8'),
      },
    }
  } finally {
    fs.closeSync(fd)
  }
}

/** Entry point for fs:request IPC and the server→dock relay: {action, path}. */
function handleRequest(settings, req) {
  const action = req && typeof req === 'object' ? String(req.action ?? '') : ''
  const requested = req && typeof req === 'object' ? req.path : ''
  if (!['list', 'stat', 'read'].includes(action)) return { ok: false, error: 'bad_action' }
  const auth = authorize(settings, requested)
  if (auth.error) {
    record(action, String(requested ?? ''), false)
    return { ok: false, error: auth.error }
  }
  try {
    let data
    if (action === 'list') data = listDir(auth.real)
    else if (action === 'stat') data = statEntry(auth.real)
    else {
      const r = readFileBounded(auth.real)
      if (r.error) { record(action, auth.real, false); return { ok: false, error: r.error } }
      data = r.data
    }
    record(action, auth.real, true)
    return { ok: true, data }
  } catch {
    record(action, auth.real, false)
    return { ok: false, error: 'read_failed' }
  }
}

/** Native directory picker — the ONLY way an allowed root is granted. */
async function pickFolder(getSettings, persistRoots) {
  const res = await dialog.showOpenDialog({
    title: 'Allow read-only access to a folder',
    buttonLabel: 'Allow folder',
    properties: ['openDirectory'],
  })
  const roots = Array.isArray(getSettings().fileAccessRoots) ? [...getSettings().fileAccessRoots] : []
  const picked = res.canceled ? null : res.filePaths[0]
  if (picked && !roots.includes(picked)) {
    roots.push(picked)
    persistRoots(roots)
  }
  return roots
}

function recentAccesses() {
  return [...recent]
}

module.exports = { handleRequest, pickFolder, recentAccesses }
