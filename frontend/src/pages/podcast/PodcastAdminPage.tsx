import { AdminGate } from '@/components/shared/AdminGate'
import { AdminPodcastsTab } from '@/components/admin/AdminPodcastsTab'

// Admin-only section living inside the Podcasts app: manage shows & subscriptions.
export function PodcastAdminPage() {
  return (
    <AdminGate title="Manage podcasts" description="shows & subscriptions" redirect="/podcasts">
      <AdminPodcastsTab />
    </AdminGate>
  )
}
