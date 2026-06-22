import type { users } from '@/db/schema'

export type User = typeof users.$inferSelect

export type AppEnv = {
  Variables: {
    user: User
  }
}
