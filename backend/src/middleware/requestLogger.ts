import { createMiddleware } from 'hono/factory'
import { logger } from '@/lib/logger'

export const requestLogger = createMiddleware(async (c, next) => {
  const start = Date.now()
  await next()
  const ms = Date.now() - start
  const status = c.res.status
  const method = c.req.method
  const path = c.req.path

  const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info'
  logger[level]({ method, path, status, ms }, `${method} ${path} ${status} ${ms}ms`)
})
