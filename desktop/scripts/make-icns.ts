// Assemble desktop/build/icon.icns from resized brand PNGs (icon-16.png ...
// icon-512.png in the directory given as argv[2]; generate them from
// desktop/build/icon.png with any resizer, e.g. PowerShell System.Drawing).
// icns = 'icns' magic + u32BE total, then chunks of 4-char type + u32BE(8+len) + PNG bytes.
import * as fs from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] ?? join(process.env.TEMP ?? '', 'claude', 'icns-work')
const entries: [string, number][] = [
  ['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512],
  ['ic11', 32], ['ic12', 64], ['ic13', 512],
]
const chunks: Buffer[] = []
let total = 8
for (const [type, px] of entries) {
  const data = fs.readFileSync(join(dir, `icon-${px}.png`))
  const header = Buffer.alloc(8)
  header.write(type, 0, 'ascii')
  header.writeUInt32BE(8 + data.length, 4)
  chunks.push(header, data)
  total += 8 + data.length
}
const magic = Buffer.alloc(8)
magic.write('icns', 0, 'ascii')
magic.writeUInt32BE(total, 4)
fs.writeFileSync(join(import.meta.dir, '..', 'build', 'icon.icns'), Buffer.concat([magic, ...chunks]))
console.log('icon.icns written:', total, 'bytes')
