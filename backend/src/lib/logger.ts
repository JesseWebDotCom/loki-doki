import pino from 'pino'
import { Writable } from 'node:stream'
import { mkdirSync, statSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Duplicated from download.ts's `dataDir` (not imported from there): download.ts
// imports this module, so importing back would be a circular dependency, and since
// this module eagerly builds its logger at load time (see makeLogger() call below),
// whichever of the two modules loaded first would crash with a TDZ ReferenceError.
const dataDir = resolve(process.cwd(), '../data')

const RING_SIZE = 500

export const logRing: string[] = []
export const logSubscribers = new Set<(line: string) => void>()

const ringSink = new Writable({
  write(chunk: Buffer, _enc, cb) {
    const line = chunk.toString().trim()
    if (line) {
      if (logRing.length >= RING_SIZE) logRing.shift()
      logRing.push(line)
      for (const sub of logSubscribers) sub(line)
    }
    cb()
  },
})

const isDev = process.env.NODE_ENV === 'development'

function makeLogger(): pino.Logger {
  const logDir = join(dataDir, 'logs')
  mkdirSync(logDir, { recursive: true })

  const logFile = join(logDir, 'app.log')
  try {
    if (statSync(logFile).size > 10 * 1024 * 1024) {
      renameSync(logFile, join(logDir, 'app.old.log'))
    }
  } catch { /* file doesn't exist yet */ }

  const fileSink = pino.destination({ dest: logFile, sync: false })
  const streams: pino.StreamEntry[] = [{ stream: fileSink }, { stream: ringSink }]

  if (isDev) {
    const pretty = pino.transport({
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
    })
    streams.push({ stream: pretty })
  }

  return pino({ level: isDev ? 'debug' : 'info' }, pino.multistream(streams))
}

export const logger = makeLogger()
