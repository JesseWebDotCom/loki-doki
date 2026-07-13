// Personal reading stats: finished count, time read, books this year, and recent
// finishes. Read-only summary from /api/books/stats.

import { useEffect, useState } from 'react'
import { BookCheck, Clock, CalendarCheck, BookOpen } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { proxyImg } from '@/lib/img'
import { getReadingStats, type ReadingStats as Stats } from '@/lib/books/api'

function Tile({ icon: Icon, value, label }: { icon: typeof Clock; value: string | number; label: string }) {
  return (
    <div className="rounded-card border border-border p-3">
      <Icon className="size-4 text-muted-foreground" />
      <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  )
}

function fmtTime(min: number): string {
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  return `${h}h ${min % 60}m`
}

export function ReadingStats() {
  const [stats, setStats] = useState<Stats | null>(null)
  useEffect(() => { void getReadingStats().then(setStats) }, [])
  if (!stats) return <div className="flex justify-center py-6"><Spinner /></div>

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold">Reading stats</h2>
        <p className="mt-1 text-sm text-muted-foreground">Your own reading activity across the library.</p>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile icon={BookCheck} value={stats.finishedCount} label="Books finished" />
        <Tile icon={CalendarCheck} value={stats.finishedThisYear} label="Finished this year" />
        <Tile icon={BookOpen} value={stats.inProgressCount} label="In progress" />
        <Tile icon={Clock} value={fmtTime(stats.totalMinutes)} label="Time read" />
      </div>
      {stats.recentFinished.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-semibold text-muted-foreground">Recently finished</p>
          <div className="flex gap-3 overflow-x-auto pb-2">
            {stats.recentFinished.map((b) => (
              <div key={b.bookId} className="w-20 shrink-0">
                <div className="aspect-[2/3] overflow-hidden rounded bg-secondary">
                  {b.coverUrl
                    ? <img src={proxyImg(b.coverUrl)} alt="" className="size-full object-cover" />
                    : <span className="flex size-full items-center justify-center text-muted-foreground"><BookOpen className="size-5" /></span>}
                </div>
                <p className="mt-1 truncate text-xs" title={b.title}>{b.title}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
