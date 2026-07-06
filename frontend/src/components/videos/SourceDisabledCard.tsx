import { Link } from 'react-router-dom'
import { EyeOff } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { useAuth } from '@/context/AuthContext'

/** Shown instead of a browse page when an admin has turned this source off in
 *  Videos → Settings → Sources. Already-followed/saved items and direct playback
 *  aren't affected: this only hides the discovery surface. */
export function SourceDisabledCard({ label }: { label: string }) {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  return (
    // design-ok(adhoc-container): one-off centered notice card, not page chrome
    <Card className="mx-auto max-w-xl p-6">
      <div className="flex items-start gap-3">
        <EyeOff className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{label} is turned off</p>
          <p className="mt-1 text-sm text-muted-foreground">
            An admin has hidden {label} from the Videos hub.
            {isAdmin ? ' You can turn it back on in Settings.' : ' Ask an admin to turn it back on if you need it.'}
          </p>
          {isAdmin && (
            <Link to="/videos/settings/sources" className="mt-3 inline-block text-sm font-medium text-foreground underline underline-offset-2">
              Go to Settings → Sources
            </Link>
          )}
        </div>
      </div>
    </Card>
  )
}
