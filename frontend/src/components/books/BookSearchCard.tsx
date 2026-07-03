import { ExternalLink, Headphones, Library } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { BookCover } from './BookCover'
import { LibraryActionButton } from './LibraryActionButton'
import { persistBookPreviewState } from '@/lib/books/previewState'
import type { BookSearchResult } from '@/lib/books/api'

interface BookSearchCardProps {
  id: string
  title: string
  author: string | null
  description: string | null
  coverSrc: string | null
  mediaType: 'ebook' | 'audiobook'
  sourceLabel: string
  formats: string[]
  sizeBytes: number | null
  publishedYear?: number | null
  contentLabel?: string | null
  to?: string
  state?: unknown
  externalUrl?: string
  // A downloadable ebook/magazine result — enables the inline Save/Download row.
  result?: BookSearchResult
}

function formatBytes(bytes: number | null): string | null {
  if (!bytes || bytes <= 0) return null
  const units = ['B', 'KB', 'MB', 'GB']
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** power).toFixed(power === 0 ? 0 : 1)} ${units[power]}`
}

export function BookSearchCard({
  id, title, author, description, coverSrc, mediaType, sourceLabel, formats,
  sizeBytes, publishedYear, contentLabel, to, state, externalUrl, result,
}: BookSearchCardProps) {
  function handleClick() {
    persistBookPreviewState(to ?? '', state)
  }

  const body = (
    <Card variant="interactive" className="h-full overflow-hidden">
      <CardContent className="flex h-full gap-4 p-4">
        <div className="aspect-[2/3] w-24 shrink-0 overflow-hidden rounded-card shadow-sm sm:w-28">
          <BookCover bookId={id} title={title} author={author} coverSrc={coverSrc} fill size={180} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex flex-wrap gap-1.5">
            <Badge variant="secondary">
              {mediaType === 'audiobook' ? <Headphones className="mr-1 size-3" /> : <Library className="mr-1 size-3" />}
              {mediaType === 'audiobook' ? 'Audiobook' : 'Ebook'}
            </Badge>
            <Badge variant="outline">{sourceLabel}</Badge>
            {contentLabel && <Badge variant="info">{contentLabel}</Badge>}
            {formats.map((format) => <Badge key={format} variant="outline">{format}</Badge>)}
            {formatBytes(sizeBytes) && <Badge variant="outline">{formatBytes(sizeBytes)}</Badge>}
            {publishedYear && <Badge variant="outline">{publishedYear}</Badge>}
          </div>
          <h2 className="line-clamp-2 text-base font-bold leading-tight">{title}</h2>
          {author && <p className="mt-1 truncate text-sm text-muted-foreground">{author}</p>}
          {description && <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-muted-foreground">{description}</p>}
          {result && (
            <div className="mt-3" onClick={(e) => { e.preventDefault(); e.stopPropagation() }}>
              <LibraryActionButton result={result} variant="inline" />
            </div>
          )}
          {externalUrl && (
            <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-brand">
              Open source page <ExternalLink className="size-3" />
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  )

  if (externalUrl) return <a href={externalUrl} target="_blank" rel="noreferrer" className="block h-full">{body}</a>
  return <Link to={to ?? '#'} state={state} onClick={handleClick} className="block h-full">{body}</Link>
}
