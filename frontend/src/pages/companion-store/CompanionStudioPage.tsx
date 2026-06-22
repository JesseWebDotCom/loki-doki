import { AdminGate } from '@/components/shared/AdminGate'
import { AdminCompanionsTab } from '@/components/admin/AdminCompanionsTab'

// Admin-only section living inside the Companions app: the character studio
// (create / edit companions). Instance-wide voice & briefing defaults stay in the
// central admin panel, since those are system-scoped, not app-scoped.
export function CompanionStudioPage() {
  return (
    <AdminGate title="Companion studio" description="create & edit characters" redirect="/companions">
      <AdminCompanionsTab view="characters" />
    </AdminGate>
  )
}
