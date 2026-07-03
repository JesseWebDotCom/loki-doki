import { Navigate } from 'react-router-dom'
import { Lock } from 'lucide-react'
import { useAuth } from '@/context/AuthContext'

// Standard wrapper for an admin-only section that lives inside a normal app (the
// "administer where the app lives" pattern). Bounces non-admins and renders a
// consistent lock banner + accent frame so these sections are visually unmistakable.
export function AdminGate({
  title,
  description,
  redirect = '/',
  children,
}: {
  title?: string
  description?: string
  redirect?: string
  children: React.ReactNode
}) {
  const { user } = useAuth()
  if (user?.role !== 'admin') return <Navigate to={redirect} replace />

  return (
    <div className="flex h-full min-h-0 flex-col ring-1 ring-inset ring-warning/40">
      <div className="flex items-center gap-2 border-b border-warning/40 bg-warning/10 px-4 py-2 text-xs font-medium text-warning">
        <Lock className="size-3.5 shrink-0" />
        <span className="uppercase tracking-wide">Admin only</span>
        {title && <span className="text-foreground/70">· {title}</span>}
        {description && <span className="text-warning/70">· {description}</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  )
}

// Inline admin-only block for a page shared by all users (e.g. an app Settings panel
// with a user section + an admin section). Renders nothing for non-admins (no redirect),
// and frames the section with the same lock banner + warning accent as AdminGate.
export function AdminSection({
  title,
  description,
  children,
}: {
  title?: string
  description?: string
  children: React.ReactNode
}) {
  const { user } = useAuth()
  if (user?.role !== 'admin') return null

  return (
    <div className="overflow-hidden rounded-card ring-1 ring-inset ring-warning/40">
      <div className="flex items-center gap-2 border-b border-warning/40 bg-warning/10 px-4 py-2 text-xs font-medium text-warning">
        <Lock className="size-3.5 shrink-0" />
        <span className="uppercase tracking-wide">Admin only</span>
        {title && <span className="text-foreground/70">· {title}</span>}
        {description && <span className="text-warning/70">· {description}</span>}
      </div>
      <div>{children}</div>
    </div>
  )
}
