import { cn } from '@/lib/cn'
import { proxyImg } from '@/lib/img'

// Route every <img> in the extracted article body through the image proxy, and drop
// `srcset` so the browser can't reach for an un-proxied responsive candidate instead.
function proxyHtmlImages(html: string): string {
  return html
    .replace(/(<img\b[^>]*?\bsrc=)(["'])(.*?)\2/gi, (_m, pre, q, src) => `${pre}${q}${proxyImg(src)}${q}`)
    .replace(/\ssrcset=(["'])[\s\S]*?\1/gi, '')
}

// Shared reading surface for extracted article content (Feeds + Reader).
// Renders the server-sanitized `contentHtml` (allowlist-sanitized in
// backend/src/lib/content/extract.ts) directly; no client-side sanitizer needed.
// Child element styling is applied via Tailwind arbitrary-variant selectors so the
// component is self-contained (this repo has no @tailwindcss/typography plugin).

export interface ArticleReaderProps {
  title?: string | null
  byline?: string | null
  siteName?: string | null
  faviconUrl?: string | null
  url?: string | null
  leadImage?: string | null
  contentHtml?: string | null
  readingMins?: number | null
  className?: string
  /** Ref to the rendered prose container; the highlights layer (Bookmarks reader)
   *  walks its text nodes to anchor/apply <mark> wrappers. */
  contentRef?: React.Ref<HTMLDivElement>
}

const PROSE = cn(
  'max-w-[44rem] mx-auto text-[15px] leading-[1.75] text-foreground/90',
  '[&_p]:mb-4',
  '[&_h1]:mt-8 [&_h1]:mb-3 [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:text-foreground',
  '[&_h2]:mt-7 [&_h2]:mb-3 [&_h2]:text-xl [&_h2]:font-bold [&_h2]:text-foreground',
  '[&_h3]:mt-6 [&_h3]:mb-2 [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:text-foreground',
  '[&_h4]:mt-5 [&_h4]:mb-2 [&_h4]:font-semibold [&_h4]:text-foreground',
  '[&_a]:text-brand [&_a]:underline [&_a]:underline-offset-2 hover:[&_a]:text-brand-hover',
  '[&_ul]:mb-4 [&_ul]:ml-5 [&_ul]:list-disc [&_ul]:space-y-1.5',
  '[&_ol]:mb-4 [&_ol]:ml-5 [&_ol]:list-decimal [&_ol]:space-y-1.5',
  '[&_li]:leading-relaxed',
  '[&_blockquote]:my-4 [&_blockquote]:border-l-2 [&_blockquote]:border-muted-foreground/40 [&_blockquote]:pl-4 [&_blockquote]:italic [&_blockquote]:text-muted-foreground',
  '[&_img]:my-5 [&_img]:rounded-card [&_img]:max-w-full [&_img]:h-auto [&_img]:mx-auto',
  '[&_figure]:my-5 [&_figcaption]:mt-2 [&_figcaption]:text-center [&_figcaption]:text-xs [&_figcaption]:text-muted-foreground',
  '[&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-card [&_pre]:bg-secondary [&_pre]:p-4 [&_pre]:text-[13px]',
  '[&_code]:rounded [&_code]:bg-muted/60 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]',
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
  '[&_hr]:my-6 [&_hr]:border-border/40',
  '[&_table]:my-4 [&_table]:w-full [&_table]:text-[13px] [&_th]:border [&_th]:border-border/40 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left',
  '[&_td]:border [&_td]:border-border/30 [&_td]:px-3 [&_td]:py-2',
)

export function ArticleReader({
  title,
  byline,
  siteName,
  faviconUrl,
  url,
  leadImage,
  contentHtml,
  readingMins,
  className,
  contentRef,
}: ArticleReaderProps) {
  const host = (() => {
    try {
      return url ? new URL(url).hostname.replace(/^www\./, '') : null
    } catch {
      return null
    }
  })()

  return (
    <article className={cn('px-5 py-8', className)}>
      <header className="max-w-[44rem] mx-auto mb-6">
        {title && <h1 className="text-3xl font-bold leading-tight text-foreground">{title}</h1>}
        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          {faviconUrl && (
            <img src={proxyImg(faviconUrl)} alt="" className="size-4 rounded object-contain"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
          )}
          {(siteName || host) && <span>{siteName || host}</span>}
          {byline && <span>· {byline}</span>}
          {!!readingMins && <span>· {readingMins} min read</span>}
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand hover:text-brand-hover underline underline-offset-2"
            >
              · Original
            </a>
          )}
        </div>
      </header>

      {leadImage && (
        <div className="max-w-[44rem] mx-auto mb-6">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={proxyImg(leadImage)} alt="" className="w-full rounded-card" loading="lazy" />
        </div>
      )}

      {contentHtml ? (
        <div ref={contentRef} className={PROSE} dangerouslySetInnerHTML={{ __html: proxyHtmlImages(contentHtml) }} />
      ) : (
        <div className="max-w-[44rem] mx-auto text-muted-foreground">
          No readable content was extracted.{' '}
          {url && (
            <a href={url} target="_blank" rel="noopener noreferrer" className="text-brand underline">
              Open the original
            </a>
          )}
          .
        </div>
      )}
    </article>
  )
}
