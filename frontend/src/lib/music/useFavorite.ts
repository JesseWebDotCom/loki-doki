// The one hook behind every favorite heart. Reads the shared favorites cache so the
// icon can render filled, and toggles add/remove with an optimistic cache flip so the
// heart responds instantly (the invalidate afterwards reconciles with the server).
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { getFavorites, addFavorite, removeFavorite, type Favorite } from '@/lib/music/catalogApi'

export function useFavorite(kind: Favorite['kind'], refId: string | null | undefined) {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['music-favorites'], queryFn: () => getFavorites() })
  const isFavorite = !!refId && (data?.favorites ?? []).some(f => f.kind === kind && f.refId === refId)

  const toggle = async (meta?: { title?: string | null; artist?: string | null; mbid?: string | null }) => {
    if (!refId) return
    const adding = !isFavorite
    qc.setQueryData<{ favorites: Favorite[] }>(['music-favorites'], old => {
      const favs = old?.favorites ?? []
      return adding
        ? { favorites: [{ id: `pending-${kind}-${refId}`, kind, refId, title: meta?.title ?? null, artist: meta?.artist ?? null, mbid: meta?.mbid ?? null }, ...favs] }
        : { favorites: favs.filter(f => !(f.kind === kind && f.refId === refId)) }
    })
    try {
      if (adding) await addFavorite({ kind, refId, title: meta?.title ?? undefined, artist: meta?.artist ?? undefined, mbid: meta?.mbid ?? undefined })
      else await removeFavorite(kind, refId)
      toast.success(adding ? 'Added to favorites' : 'Removed from favorites')
    } catch {
      toast.error('Could not update favorites')
    } finally {
      void qc.invalidateQueries({ queryKey: ['music-favorites'] })
    }
  }

  return { isFavorite, toggle }
}
