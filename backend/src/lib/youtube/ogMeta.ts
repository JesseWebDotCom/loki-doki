// Open Graph HTML for shared /youtube/watch/:videoId links. The SPA is client-rendered, so a
// shared link's og:* tags can't come from the static index.html — link-unfurlers
// (Telegram/iMessage/Slack) don't execute JS. This renders a tiny standalone document
// with the meta tags plus an instant redirect, so crawlers read the tags and real
// browsers land on the normal SPA with no visible flash.
import type { Context, Next } from 'hono'
import { innertubePlayerMeta } from '@/lib/youtube/innertube'
import { isValidVideoId } from '@/lib/youtube/stream'

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Builds the OG-tag HTML for a watch page, or null if metadata couldn't be fetched
 *  (deleted video, network issue) — callers should fall back to the plain SPA in that case. */
export async function renderWatchPageOg(videoId: string, requestUrl: string): Promise<string | null> {
  const meta = await innertubePlayerMeta(videoId).catch(() => null)
  if (!meta?.title) return null

  const title = escapeAttr(meta.title)
  const image = escapeAttr(`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`)
  const url = escapeAttr(requestUrl)
  const spaPath = `/youtube/watch/${encodeURIComponent(videoId)}`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<meta property="og:title" content="${title}">
<meta property="og:image" content="${image}">
<meta property="og:type" content="video.other">
<meta property="og:url" content="${url}">
<meta http-equiv="refresh" content="0; url=${escapeAttr(spaPath)}">
<script>window.location.replace(${JSON.stringify(spaPath)})</script>
</head>
<body></body>
</html>`
}

/** Route handler for `GET /youtube/watch/:videoId`. Serves the OG-tag HTML when it can
 *  build one; otherwise falls through (`next()`) to the normal SPA static/catch-all handler. */
export async function ogMetaMiddleware(c: Context, next: Next): Promise<Response | void> {
  const videoId = c.req.param('videoId') ?? ''
  if (!isValidVideoId(videoId)) return next()

  const html = await renderWatchPageOg(videoId, c.req.url)
  if (!html) return next()

  return c.html(html)
}
