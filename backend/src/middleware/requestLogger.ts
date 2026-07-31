import { createMiddleware } from 'hono/factory'
import { logger } from '@/lib/logger'

// Image proxies are ~100-200 requests per home-screen render; logging each one drowns the
// log in noise that carries no signal. Failures still surface via each proxy's own warn.
const QUIET_PREFIXES = ['/api/youtube/img', '/api/youtube/dearrow-thumb']

export const requestLogger = createMiddleware(async (c, next) => {
  const start = Date.now()
  await next()
  const ms = Date.now() - start
  const status = c.res.status
  const method = c.req.method
  const path = c.req.path
  if (status < 400 && QUIET_PREFIXES.some(p => path.startsWith(p))) return

  const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info'
  logger[level]({ method, path, status, ms }, `${method} ${path} ${status} ${ms}ms`)
})
