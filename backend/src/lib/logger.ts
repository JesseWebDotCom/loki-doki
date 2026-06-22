import pino from 'pino'
import { Writable } from 'node:stream'
import { mkdirSync, statSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '@/lib/download'

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
  if (isDev) {
    const pretty = pino.transport({
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
    })
    return pino({ level: 'debug' }, pino.multistream([pretty, ringSink]))
  }

  const logDir = join(dataDir, 'logs')
  mkdirSync(logDir, { recursive: true })

  const logFile = join(logDir, 'app.log')
  try {
    if (statSync(logFile).size > 10 * 1024 * 1024) {
      renameSync(logFile, join(logDir, 'app.old.log'))
    }
  } catch { /* file doesn't exist yet */ }

  const fileSink = pino.destination({ dest: logFile, sync: false })
  return pino({ level: 'info' }, pino.multistream([fileSink, ringSink]))
}

export const logger = makeLogger()
