import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { LucideIcon } from 'lucide-react'
import { ArrowLeft, Lock, ShieldCheck } from 'lucide-react'
import { PageHeader } from '@/components/shared/PageHeader'
import { useAuth } from '@/context/AuthContext'

// The one settings-page shell every app with user-adjustable preferences builds on,
// reached via the breadcrumb gear (useAppHeader's settingsHref). User content is always
// visible; adminSection (if provided) is shown in full to admins and replaced with a
// plain locked notice for everyone else, instead of being hidden behind a separate
// admin-only page. Apps with nothing to configure just don't set a settingsHref at all.

interface AppSettingsPageProps {
  title?: string
  backTo: string
  backLabel: string
  icon: LucideIcon
  gradient: string
  children: ReactNode
  adminSection?: ReactNode
  adminNotice?: string
}

export function AppSettingsPage({
  title = 'Settings',
  backTo,
  backLabel,
  icon: Icon,
  gradient,
  children,
  adminSection,
  adminNotice = 'Some options here are managed by an admin.',
}: AppSettingsPageProps) {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'

  return (
    <div className="flex flex-1 flex-col">
      <PageHeader
        title={title}
        gradient={gradient}
        icon={Icon}
        actions={
          <Link
            to={backTo}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-4" /> {backLabel}
          </Link>
        }
      />

      <div className="mx-auto w-full max-w-2xl space-y-6 px-5 pb-16">
        {children}

        {adminSection && (
          isAdmin ? (
            <section className="space-y-3 border-t border-border pt-5">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <ShieldCheck className="size-4 text-brand" /> Admin
              </h2>
              {adminSection}
            </section>
          ) : (
            <section className="space-y-2 border-t border-border pt-5">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
                <Lock className="size-4" /> Admin
              </h2>
              <p className="text-sm text-muted-foreground">{adminNotice}</p>
            </section>
          )
        )}
      </div>
    </div>
  )
}
