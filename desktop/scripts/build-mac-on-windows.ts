// Build the Doki Dock macOS app entirely on Windows (no Mac needed).
// Pipeline: read the prebuilt Electron darwin zip (symlink entries and unix
// modes intact) -> extract with real NTFS symlinks (requires Windows Developer
// Mode for unprivileged symlink creation) -> electron-packager-style transform
// (rename app/executable/helpers, patch Info.plists, brand icon, inject app
// code) -> ad-hoc sign with rcodesign (the Rust apple-codesign tool, Windows
// binary) -> write the distributable zip ourselves, restoring the unix modes
// and symlink entries that NTFS cannot represent.
//
// Inputs:
//   - the Electron darwin zip for the version in desktop/package.json, from
//     https://github.com/electron/electron/releases (electron-v<V>-darwin-<arch>.zip)
//   - rcodesign.exe, from the apple-codesign releases on
//     https://github.com/indygreg/apple-platform-rs (path via RCODESIGN env var)
//
// Usage: RCODESIGN=path/to/rcodesign.exe bun run build-mac-on-windows.ts <electron-darwin-zip> <out-zip>

import { deflateRawSync, inflateRawSync } from 'node:zlib'
import * as fs from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const DESKTOP = resolve(dirname(Bun.main), '..')
const RCODESIGN = process.env['RCODESIGN'] ?? 'rcodesign.exe'

const [zipPath, outZip] = process.argv.slice(2)
if (!zipPath || !outZip) { console.error('usage: build-mac-on-windows.ts <electron.zip> <out.zip>'); process.exit(1) }

const pkg = JSON.parse(fs.readFileSync(join(DESKTOP, 'package.json'), 'utf8')) as {
  version: string; productName: string
}
const NAME = pkg.productName            // "Doki Dock"
const BUNDLE_ID = 'com.jessewebdotcom.dokidock'
const MIC_TEXT = 'Doki Dock listens so you can talk to your companion.'

// ── Minimal zip reader ─────────────────────────────────────────────────────────

interface ZipEntry { name: string; mode: number; isDir: boolean; isSymlink: boolean; data: () => Buffer }

function readZip(path: string): ZipEntry[] {
  const buf = fs.readFileSync(path)
  // Find EOCD (sig 0x06054b50) in the trailing 64KB.
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('EOCD not found (not a zip?)')
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  const entries: ZipEntry[] = []
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error(`bad central header at ${off}`)
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const externalAttrs = buf.readUInt32LE(off + 38)
    const localOff = buf.readUInt32LE(off + 42)
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8')
    const mode = externalAttrs >>> 16
    const isDir = name.endsWith('/')
    const isSymlink = (mode & 0xf000) === 0xa000
    entries.push({
      name, mode, isDir, isSymlink,
      data: () => {
        const nl = buf.readUInt16LE(localOff + 26)
        const el = buf.readUInt16LE(localOff + 28)
        const start = localOff + 30 + nl + el
        const raw = buf.subarray(start, start + compSize)
        return method === 8 ? inflateRawSync(raw) : Buffer.from(raw)
      },
    })
    off += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

// ── Extract with real symlinks; remember unix modes NTFS cannot keep ──────────

const modeManifest = new Map<string, number>()   // staging-relative posix path -> mode

function extract(entries: ZipEntry[], dest: string) {
  const symlinks: { name: string; target: string }[] = []
  for (const e of entries) {
    const out = join(dest, e.name)
    if (e.isDir) { fs.mkdirSync(out, { recursive: true }); continue }
    if (e.isSymlink) { symlinks.push({ name: e.name, target: e.data().toString('utf8') }); continue }
    fs.mkdirSync(dirname(out), { recursive: true })
    fs.writeFileSync(out, e.data())
    modeManifest.set(e.name, e.mode || 0o644)
  }
  // Symlink targets can pass through other symlinks (Versions/Current), so
  // create the ones whose targets already resolve first and loop until done.
  let pending = symlinks
  while (pending.length > 0) {
    const next: typeof pending = []
    let progressed = false
    for (const s of pending) {
      const linkPath = join(dest, s.name)
      const resolved = resolve(dirname(linkPath), s.target)
      let type: 'dir' | 'file' | null = null
      try { type = fs.statSync(resolved).isDirectory() ? 'dir' : 'file' } catch { /* not yet */ }
      if (type === null) { next.push(s); continue }
      fs.mkdirSync(dirname(linkPath), { recursive: true })
      fs.symlinkSync(s.target, linkPath, type)
      modeManifest.set(s.name, 0o755 | 0o120000)
      progressed = true
    }
    if (!progressed) {
      for (const s of next) {   // unresolvable: default to file links
        fs.symlinkSync(s.target, join(dest, s.name), 'file')
        modeManifest.set(s.name, 0o755 | 0o120000)
      }
      break
    }
    pending = next
  }
}

// ── Transform: Electron.app -> Doki Dock.app (electron-packager style) ────────

function plistSet(xml: string, key: string, value: string): string {
  const re = new RegExp(`(<key>${key.replace(/[()]/g, '\\$&')}</key>\\s*<string>)[^<]*(</string>)`)
  if (re.test(xml)) return xml.replace(re, `$1${value}$2`)
  return xml.replace(/<\/dict>\s*<\/plist>\s*$/, `\t<key>${key}</key>\n\t<string>${value}</string>\n</dict>\n</plist>\n`)
}

function renameInManifest(fromPrefix: string, toPrefix: string) {
  for (const [k, v] of [...modeManifest]) {
    if (k === fromPrefix || k.startsWith(`${fromPrefix}/`)) {
      modeManifest.delete(k)
      modeManifest.set(toPrefix + k.slice(fromPrefix.length), v)
    }
  }
}

function transform(stage: string) {
  const appFrom = join(stage, 'Electron.app')
  const appTo = join(stage, `${NAME}.app`)
  fs.renameSync(appFrom, appTo)
  renameInManifest('Electron.app', `${NAME}.app`)

  // Main executable
  fs.renameSync(join(appTo, 'Contents/MacOS/Electron'), join(appTo, `Contents/MacOS/${NAME}`))
  renameInManifest(`${NAME}.app/Contents/MacOS/Electron`, `${NAME}.app/Contents/MacOS/${NAME}`)

  // Main Info.plist
  const plistPath = join(appTo, 'Contents/Info.plist')
  let plist = fs.readFileSync(plistPath, 'utf8')
  plist = plistSet(plist, 'CFBundleDisplayName', NAME)
  plist = plistSet(plist, 'CFBundleName', NAME)
  plist = plistSet(plist, 'CFBundleExecutable', NAME)
  plist = plistSet(plist, 'CFBundleIdentifier', BUNDLE_ID)
  plist = plistSet(plist, 'CFBundleVersion', pkg.version)
  plist = plistSet(plist, 'CFBundleShortVersionString', pkg.version)
  plist = plistSet(plist, 'NSMicrophoneUsageDescription', MIC_TEXT)
  fs.writeFileSync(plistPath, plist)

  // Helper apps: rename bundle dir + inner binary, patch their plists.
  const fwDir = join(appTo, 'Contents/Frameworks')
  for (const d of fs.readdirSync(fwDir)) {
    const m = /^Electron (Helper.*)\.app$/.exec(d)
    if (!m) continue
    const suffix = m[1]!                        // "Helper", "Helper (Renderer)", ...
    const newDir = `${NAME} ${suffix}.app`
    fs.renameSync(join(fwDir, d), join(fwDir, newDir))
    renameInManifest(`${NAME}.app/Contents/Frameworks/${d}`, `${NAME}.app/Contents/Frameworks/${newDir}`)
    const macosDir = join(fwDir, newDir, 'Contents/MacOS')
    const oldBin = `Electron ${suffix}`
    const newBin = `${NAME} ${suffix}`
    fs.renameSync(join(macosDir, oldBin), join(macosDir, newBin))
    renameInManifest(
      `${NAME}.app/Contents/Frameworks/${newDir}/Contents/MacOS/${oldBin}`,
      `${NAME}.app/Contents/Frameworks/${newDir}/Contents/MacOS/${newBin}`,
    )
    const helperIdSuffix = /\((.*)\)/.exec(suffix)?.[1]?.toLowerCase()
    const helperPlistPath = join(fwDir, newDir, 'Contents/Info.plist')
    let hp = fs.readFileSync(helperPlistPath, 'utf8')
    hp = plistSet(hp, 'CFBundleDisplayName', newBin)
    hp = plistSet(hp, 'CFBundleName', newBin)
    hp = plistSet(hp, 'CFBundleExecutable', newBin)
    hp = plistSet(hp, 'CFBundleIdentifier', `${BUNDLE_ID}.helper${helperIdSuffix ? `.${helperIdSuffix}` : ''}`)
    fs.writeFileSync(helperPlistPath, hp)
  }

  // App payload: what electron-builder.yml lists (src/**, tray pngs, package.json).
  const resDir = join(appTo, 'Contents/Resources')
  // Brand icon: overwrite Electron's own icns under its original name, so
  // CFBundleIconFile in the plist stays valid without another edit.
  const brandIcns = join(DESKTOP, 'build', 'icon.icns')
  if (fs.existsSync(brandIcns)) fs.copyFileSync(brandIcns, join(resDir, 'electron.icns'))
  fs.rmSync(join(resDir, 'default_app.asar'), { force: true })
  const appDir = join(resDir, 'app')
  fs.mkdirSync(join(appDir, 'build'), { recursive: true })
  fs.cpSync(join(DESKTOP, 'src'), join(appDir, 'src'), { recursive: true })
  fs.copyFileSync(join(DESKTOP, 'package.json'), join(appDir, 'package.json'))
  for (const f of fs.readdirSync(join(DESKTOP, 'build'))) {
    if (/^tray.*\.png$/.test(f)) fs.copyFileSync(join(DESKTOP, 'build', f), join(appDir, 'build', f))
  }
}

// ── Zip writer: unix modes + symlink entries ──────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

interface OutEntry { name: string; mode: number; isDir: boolean; data: Buffer }

function walkStage(stage: string, prefix = ''): OutEntry[] {
  const out: OutEntry[] = []
  for (const name of fs.readdirSync(join(stage, prefix))) {
    const rel = prefix ? `${prefix}/${name}` : name
    const full = join(stage, rel)
    const st = fs.lstatSync(full)
    if (st.isSymbolicLink()) {
      out.push({ name: rel, mode: 0o120755, isDir: false, data: Buffer.from(fs.readlinkSync(full).replace(/\\/g, '/')) })
    } else if (st.isDirectory()) {
      out.push({ name: `${rel}/`, mode: 0o40755, isDir: true, data: Buffer.alloc(0) })
      out.push(...walkStage(stage, rel))
    } else {
      const known = modeManifest.get(rel)
      // NTFS lost the exec bits: restore from the source zip's manifest; new
      // files (signature data, app payload) get exec only in MacOS dirs.
      const mode = known ?? (/\/(MacOS)\//.test(rel) ? 0o755 : 0o644)
      out.push({ name: rel, mode: mode & 0o7777 | 0o100000, isDir: false, data: fs.readFileSync(full) })
    }
  }
  return out
}

function writeZip(entries: OutEntry[], outPath: string) {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const isLink = (e.mode & 0xf000) === 0xa000
    const deflated = e.data.length > 0 && !isLink ? deflateRawSync(e.data, { level: 6 }) : e.data
    const useDeflate = deflated.length < e.data.length
    const payload = useDeflate ? deflated : e.data
    const method = useDeflate ? 8 : 0
    const crc = crc32(e.data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)                    // version needed
    local.writeUInt16LE(0x800, 6)                 // utf-8 names
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(0, 12)                    // dos time/date (zeroed)
    local.writeUInt32LE(crc, 16)
    local.writeUInt32LE(payload.length, 20)
    local.writeUInt32LE(e.data.length, 24)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)

    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(0x031e, 4)                  // made by: unix / 3.0
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0x800, 8)
    cen.writeUInt16LE(method, 10)
    cen.writeUInt32LE(0, 12)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(payload.length, 20)
    cen.writeUInt32LE(e.data.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt32LE(((e.mode << 16) | (e.isDir ? 0x10 : 0)) >>> 0, 38)
    cen.writeUInt32LE(offset, 42)

    chunks.push(local, nameBuf, payload)
    central.push(cen, nameBuf)
    offset += 30 + nameBuf.length + payload.length
  }
  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  fs.writeFileSync(outPath, Buffer.concat([...chunks, centralBuf, eocd]))
}

// ── Run ────────────────────────────────────────────────────────────────────────

const stage = join(DESKTOP, 'release', 'mac-stage-' + (/arm64/.test(zipPath) ? 'arm64' : 'x64'))
fs.rmSync(stage, { recursive: true, force: true })
fs.mkdirSync(stage, { recursive: true })

console.log('1/5 reading', zipPath)
const entries = readZip(resolve(zipPath))
console.log(`    ${entries.length} entries, ${entries.filter((e) => e.isSymlink).length} symlinks`)

console.log('2/5 extracting with symlinks ->', stage)
extract(entries, stage)

console.log('3/5 transforming Electron.app ->', `${NAME}.app`)
transform(stage)

console.log('4/5 ad-hoc signing with rcodesign')
const sign = spawnSync(RCODESIGN, ['sign', join(stage, `${NAME}.app`)], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
if (sign.status !== 0) {
  console.error(sign.stdout, sign.stderr)
  throw new Error(`rcodesign exited ${sign.status}`)
}
console.log((sign.stderr + sign.stdout).trim().split('\n').map((l) => '    ' + l).join('\n'))

console.log('5/5 writing', outZip)
writeZip(walkStage(stage), resolve(outZip))
console.log('done:', fs.statSync(resolve(outZip)).size, 'bytes')
