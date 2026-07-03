import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { zimArchives } from '@/db/schema'
import { ZIM_CATALOG } from '@/lib/zimCatalog'
import { kiwixUrl, getKiwixState, getKiwixError, isKiwixInstalled, kiwixContentBase, kiwixContentRelPrefix } from '@/lib/kiwix'
import { IS_WIN } from '@/lib/platform'
import { requireAuth } from '@/middleware/auth'
import type { AppEnv } from '@/types'

const archives = new Hono<AppEnv>()
archives.use('*', requireAuth)

// ── Status ────────────────────────────────────────────────────────────────────

archives.get('/status', async (c) => {
  const rows = await db.select().from(zimArchives)
  return c.json({
    kiwixInstalled: isKiwixInstalled(),
    kiwixState:     getKiwixState(),
    kiwixError:     getKiwixError() || null,
    kiwixUrl:       kiwixUrl(),
    installed:      rows.length,
  })
})

// ── Installed archives ────────────────────────────────────────────────────────

archives.get('/installed', async (c) => {
  const rows = await db.select().from(zimArchives)
  const enriched = rows.map((row) => {
    const source = ZIM_CATALOG.find((s) => s.sourceId === row.sourceId)
    const variant = source?.variants.find((v) => v.key === row.variantKey)
    return {
      ...row,
      label:          source?.label          ?? row.sourceId,
      description:    source?.description    ?? null,
      category:       source?.category       ?? 'Other',
      bookCategory:   source?.bookCategory   ?? null,
      faviconUrl:     source?.faviconUrl     ?? null,
      zimIconUrl:     row.kiwixBookName ? `/api/archives/favicon/${row.sourceId}` : null,
      variantLabel:   variant?.label         ?? row.variantKey,
    }
  })
  return c.json({ archives: enriched })
})

// ── ZIM favicon proxy ─────────────────────────────────────────────────────────
// Discovers and proxies the favicon embedded in the ZIM file itself.

const faviconCache = new Map<string, string>()

archives.get('/favicon/:sourceId', async (c) => {
  const sourceId = c.req.param('sourceId')

  if (getKiwixState() !== 'ready') return c.notFound()

  const row = await db.select().from(zimArchives)
    .where(eq(zimArchives.sourceId, sourceId))
    .then((r) => r[0])
  if (!row?.kiwixBookName) return c.notFound()

  const kiwixBase = kiwixContentBase(row.kiwixBookName)

  let faviconPath = faviconCache.get(sourceId)
  if (!faviconPath) {
    try {
      const html = await fetch(`${kiwixBase}/`, {
        redirect: 'follow',
        signal: AbortSignal.timeout(3_000),
      }).then((r) => r.text())
      const m = html.match(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]+href=["']([^"']+)["']/)
             ?? html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*icon[^"']*["']/)
      faviconPath = m?.[1] ?? 'favicon.png'
      faviconCache.set(sourceId, faviconPath)
    } catch {
      return c.notFound()
    }
  }

  const url = faviconPath.startsWith('http')
    ? faviconPath
    : `${kiwixBase}/${faviconPath.replace(/^\//, '')}`

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3_000) })
    if (!res.ok) return c.notFound()
    const ct = res.headers.get('content-type') ?? 'image/png'
    return new Response(res.body, {
      headers: { 'content-type': ct, 'cache-control': 'public, max-age=86400' },
    })
  } catch {
    return c.notFound()
  }
})

// A friendly placeholder rendered inside the reader iframe while the offline library
// is still setting up (archive downloading, or kiwix-serve restarting to pick it up).
// `retry` adds a meta-refresh so it loads the real content automatically once ready —
// no raw "kiwix-serve unreachable" JSON, no manual reload.
function libraryStatusPage(opts: { retry: boolean; title: string; body: string }): string {
  return `<!doctype html><html><head><meta charset="utf-8">${opts.retry ? '<meta http-equiv="refresh" content="4">' : ''}
<style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;background:#0a0a0f;color:#e5e7eb;font-family:-apple-system,system-ui,sans-serif}.w{text-align:center;max-width:30rem;padding:2rem}.s{width:34px;height:34px;margin:0 auto 1.25rem;border:3px solid rgba(139,92,246,.25);border-top-color:#8b5cf6;border-radius:50%;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}h1{font-size:1.05rem;font-weight:700;margin:0 0 .45rem}p{font-size:.85rem;color:#9ca3af;line-height:1.55;margin:0}</style>
</head><body><div class="w">${opts.retry ? '<div class="s"></div>' : ''}<h1>${opts.title}</h1><p>${opts.body}</p></div></body></html>`
}

// ── Title browse (individual entries within a ZIM, as a book-like list) ────────
// Only the custom zim-server.ts (macOS/Linux) implements /browse — real kiwix-serve
// (Windows) doesn't have an equivalent JSON listing API, so this reports
// unsupported there and the frontend falls back to the in-archive search box.

archives.get('/browse/:sourceId', async (c) => {
  const sourceId = c.req.param('sourceId')
  if (IS_WIN) return c.json({ unsupported: true, results: [], total: 0 })
  if (getKiwixState() !== 'ready') return c.json({ results: [], total: 0 })

  const row = await db.select().from(zimArchives)
    .where(eq(zimArchives.sourceId, sourceId))
    .then((r) => r[0])
  if (!row?.kiwixBookName) return c.json({ results: [], total: 0 })

  const start = c.req.query('start') ?? '0'
  const count = c.req.query('count') ?? '30'
  const q     = c.req.query('q') ?? ''

  try {
    const upstream = await fetch(
      `${kiwixContentBase(row.kiwixBookName)}/browse?start=${encodeURIComponent(start)}&count=${encodeURIComponent(count)}&q=${encodeURIComponent(q)}&format=json`,
      { signal: AbortSignal.timeout(10_000) },
    )
    if (!upstream.ok) return c.json({ results: [], total: 0 })
    return c.json(await upstream.json())
  } catch {
    return c.json({ results: [], total: 0 })
  }
})

// ── Content proxy → kiwix-serve ───────────────────────────────────────────────
// Forwards everything to kiwix-serve and rewrites absolute kiwix-serve paths
// so all links stay within our proxy and the iframe remains same-origin.

archives.get('/view/:sourceId/*', async (c) => {
  const sourceId    = c.req.param('sourceId')
  const queryString = new URL(c.req.url).search ?? ''

  // c.req.param('*') is always undefined in Hono v4 sub-app routes — extract from
  // the full path directly. Also decode percent-encoding (e.g. %3A→:) because
  // Bun's URL.pathname preserves encoded chars and the ZIM server looks up paths
  // with literal characters.
  const prefix = `/api/archives/view/${sourceId}/`
  const rest   = c.req.path.startsWith(prefix)
    ? decodeURIComponent(c.req.path.slice(prefix.length))
    : ''

  const row = await db.select().from(zimArchives)
    .where(eq(zimArchives.sourceId, sourceId))
    .then((r) => r[0])

  if (!row) {
    return c.html(libraryStatusPage({ retry: false, title: 'Archive not available', body: 'This library item isn’t installed.' }), 404)
  }
  if (!row.kiwixBookName || getKiwixState() !== 'ready') {
    // Still downloading/indexing, or kiwix-serve is restarting to include it.
    return c.html(libraryStatusPage({
      retry: true,
      title: 'Setting up this archive…',
      body: 'The offline library is finishing its setup. This page will open automatically when it’s ready.',
    }))
  }

  const kiwixBase      = kiwixContentBase(row.kiwixBookName)
  const kiwixAbsPrefix = kiwixContentRelPrefix(row.kiwixBookName)

  // Follow the ZIM's redirect chain internally (up to 10 hops) so the browser
  // never sees more than one HTTP response — avoids Chrome's too-many-redirects
  // limit on archives like Wikipedia with deep in-ZIM redirect chains.
  // We track effectivePath ourselves instead of relying on response.url (unreliable
  // in Bun for local redirects) so the <base> tag and relative asset resolution
  // (e.g. PDF links in USDA) stay correct.
  let upstream: Response
  let effectivePath = rest
  try {
    const absBookPrefix = `${kiwixBase}/`
    const relBookPrefix = kiwixAbsPrefix
    let currentTarget   = `${kiwixBase}/${rest}${queryString}`

    for (let hop = 0; hop < 10; hop++) {
      upstream = await fetch(currentTarget, {
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      })
      if (upstream.status < 300 || upstream.status >= 400) break

      const loc = upstream.headers.get('location') ?? ''
      if (loc.startsWith(absBookPrefix)) {
        // Drain the intermediate redirect body so the connection can be reused.
        upstream.body?.cancel()
        effectivePath = decodeURIComponent(new URL(loc).pathname.slice(relBookPrefix.length))
        currentTarget = loc
      } else if (loc.startsWith(relBookPrefix)) {
        upstream.body?.cancel()
        effectivePath = decodeURIComponent(loc.split('?')[0].slice(relBookPrefix.length))
        currentTarget = `${kiwixUrl()}${loc}`
      } else {
        // Redirect outside the archive or a relative URL — stop following
        break
      }
    }
  } catch (err) {
    // kiwix-serve unreachable (starting/restarting) — show the auto-retrying placeholder
    // instead of a raw error; it'll load the content as soon as the server is back.
    // Log the underlying cause so a genuine 500/timeout isn't masked as a perpetual
    // "Setting up" page with no trace.
    console.warn(`[archives] kiwix proxy fetch failed for ${sourceId}/${rest}: ${(err as Error).message}`)
    return c.html(libraryStatusPage({
      retry: true,
      title: 'Starting the offline library…',
      body: 'The library server is starting up. This page will load automatically in a moment.',
    }))
  }

  const contentType = upstream!.headers.get('content-type') ?? 'application/octet-stream'

  // For HTML: rewrite absolute kiwix-serve paths and inject hide-kiwix-bar CSS
  if (contentType.includes('text/html')) {
    const html = await upstream!.text()
    const proxyBase = `/api/archives/view/${sourceId}/`

    // Inject dark-mode theming when the app is in dark theme.
    // Strategy:
    //   1. matchMedia patch – activates JS-driven dark mode in archives that support it
    //   2. CSS injection – covers MediaWiki + common structural patterns
    //   3. Filter fallback – script checks luminance after load; if still light, applies
    //      invert filter as a last resort (handles arbitrary archives like Stack Exchange)
    const isDark = (getCookie(c, 'ld-theme') ?? 'dark') !== 'light'
    const darkStyle = isDark ? `
<meta name="color-scheme" content="dark">
<script>
(function(){
  /* 1. Patch matchMedia so JS dark-mode checks see prefers-color-scheme:dark */
  var o=window.matchMedia.bind(window);
  window.matchMedia=function(q){
    if(q==='(prefers-color-scheme: dark)')
      return{matches:true,media:q,onchange:null,
        addEventListener:function(){},removeEventListener:function(){},dispatchEvent:function(){}};
    if(q==='(prefers-color-scheme: light)')
      return{matches:false,media:q,onchange:null,
        addEventListener:function(){},removeEventListener:function(){},dispatchEvent:function(){}};
    return o(q);
  };
  /* 3. Filter fallback: check body + 2 levels of children for light backgrounds.
     html is dark from our CSS. body > div is also dark from our CSS (specificity 0,0,2).
     But if the archive uses ID selectors with !important (e.g. #globalWrapper {!important},
     specificity 0,1,0) they beat our type-selector !important → element stays light.
     Checking 2 levels deep catches those cases. */
  function ldIsLight(el){
    var bg=getComputedStyle(el).backgroundColor;
    var m=bg.match(/[\d.]+/g);
    if(!m||m.length<3)return false;
    var a=m.length>3?parseFloat(m[3]):1;
    if(a<0.1)return false;
    return(0.299*+m[0]+0.587*+m[1]+0.114*+m[2])/255>0.4;
  }
  function ldFallback(){
    var candidates=[document.body];
    [].slice.call(document.body.children).slice(0,5).forEach(function(c){
      candidates.push(c);
      [].slice.call(c.children).slice(0,4).forEach(function(gc){candidates.push(gc);});
    });
    for(var i=0;i<candidates.length;i++){
      if(ldIsLight(candidates[i])){
        var s=document.createElement('style');
        s.id='ld-filter-fallback';
        s.textContent='html{filter:invert(1) hue-rotate(180deg)!important;background:#fff!important}img,video,canvas,svg[role=img]{filter:invert(1) hue-rotate(180deg)!important}';
        document.head.appendChild(s);
        return;
      }
    }
  }
  if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',ldFallback);}
  else{ldFallback();}
})();
</script>
<style id="ld-theme">
  /* 2a. CSS custom properties – MediaWiki Vector skin and similar frameworks */
  :root {
    --background-color-base:#121212!important;
    --background-color-interactive:#1e1e1e!important;
    --background-color-interactive-subtle:#1a1a1a!important;
    --background-color-neutral:#1e1e1e!important;
    --background-color-neutral-subtle:#181818!important;
    --color-base:#e8e8e8!important;
    --color-subtle:#b0b0b0!important;
    --color-link:#90bdf0!important;
    --color-link-visited:#c8a0f0!important;
    --border-color-base:#333!important;
    --border-color-muted:#2a2a2a!important;
    color-scheme:dark;
  }
  /* 2b. Base – html body raises specificity above bare body rules in skin stylesheets
     (e.g. .skin-monobook body has 0,1,1; html body also has 0,0,2 which doesn't beat it,
     so we also add explicit skin-class body overrides below) */
  html,body,html body{background-color:#121212!important;color:#e8e8e8!important}
  /* MediaWiki skin body classes – match the skins' own specificity level */
  body.skin-vector,body.skin-vector-2022,body.skin-monobook,body.skin-timeless,
  body.skin-minerva,.skin-vector body,.skin-vector-2022 body,
  .skin-monobook body,.skin-timeless body,.skin-minerva body{
    background-color:#121212!important;color:#e8e8e8!important
  }
  a{color:#90bdf0!important}
  a:visited{color:#c8a0f0!important}
  h1,h2,h3,h4,h5,h6{color:#f0f0f0!important;border-color:#333!important}
  table{border-color:#333!important}
  th{background-color:#1e1e1e!important;color:#e8e8e8!important;border-color:#333!important}
  td{border-color:#2e2e2e!important}
  li,dt,dd{background-color:#1a1a1a!important;color:#e8e8e8!important;border-color:#2e2e2e!important}
  pre,code,.mw-highlight,.highlight{background-color:#1a1a1a!important;color:#e0e0e0!important;border-color:#333!important}
  blockquote{border-color:#444!important;background-color:#1a1a1a!important;color:#ccc!important}
  input,select,textarea{background-color:#1e1e1e!important;color:#e8e8e8!important;border-color:#444!important}
  /* 2c. Structural catch-all: direct body children + named containers */
  body>div,body>section,body>main,body>article,body>aside,body>nav,body>header,body>footer{
    background-color:#1a1a1a!important;color:#e8e8e8!important
  }
  main,article,aside,dialog,details,section,
  .container,.content,.wrapper,.inner,.outer,.main,.page,.layout,.body,
  .post,.entry,.card,.panel,.box,.module,.widget,.block,.row,
  .question,.answer,.comment,.reply,.thread,.item,.result,
  .post-body,.post-content,.entry-content,.page-content,.main-content,.site-content,
  [class*="-container"],[class*="-content"],[class*="-wrapper"],[class*="-inner"],
  [class*="-body"],[class*="-main"],[class*="-page"],[class*="-layout"],
  [class*="__container"],[class*="__content"],[class*="__wrapper"],[class*="__body"]{
    background-color:#1a1a1a!important;color:#e8e8e8!important;border-color:#333!important
  }
  /* 2d. MediaWiki / Wikipedia / Wikibooks specific */
  #column-content,#content,#bodyContent,#mw-content-text,
  .mw-body,.mw-body-content,.mw-content-ltr{background-color:#121212!important;color:#e8e8e8!important}
  #mw-head,.mw-header,.vector-header,.skin-vector-2022 .mw-header{background-color:#1a1a1a!important;border-color:#333!important}
  #mw-panel,.vector-menu-portal,.mw-portlet,.pBody{background-color:#1a1a1a!important}
  .infobox,.wikitable{background-color:#1a1a1a!important;border-color:#333!important;color:#e8e8e8!important}
  .navbox{background-color:#1a1a1a!important;border-color:#333!important}
  .navbox-title,.navbox-group{background-color:#252525!important;color:#e8e8e8!important}
  .toc,.mw-toc{background-color:#1a1a1a!important;border-color:#333!important}
  .toc a{color:#90bdf0!important}
  .catlinks{background-color:#1a1a1a!important;border-color:#333!important}
  .ambox,.tmbox,.ombox,.fmbox,.cmbox,.imbox{background-color:#1a1a1a!important;border-color:#444!important}
  /* Soften images rather than inverting them */
  img{filter:brightness(0.9)}
  video,canvas{filter:brightness(0.9)}
</style>` : ''

    // ZIM article paths like "NS:Title/Subtitle" are served 2 URL segments deep.
    // Their HTML uses "../" links that expect ONE level of namespace, so "../"
    // should resolve to the ZIM root (/api/archives/view/{sourceId}/).
    // Without a <base> tag, "../" resolves to the intermediate namespace dir
    // (e.g. "NS:Title/"), making all CSS and asset requests 404.
    // Use effectivePath (post-redirect) so the base is correct after redirect chains.
    const slashIdx = effectivePath.lastIndexOf('/')
    const baseTag  = slashIdx !== -1
      ? `<base href="${proxyBase}${effectivePath.slice(0, slashIdx + 1)}">`
      : ''

    const kiwixBarStyle = `<style>
      #kiwix-navigation,.kiwix-bar,#kiwix-bar,.kiwix-top-navigation,
      #kiwix-top-nav,#kiwix-bottom-nav,.kiwix-footer{display:none!important}
      body{padding-top:0!important;margin-top:0!important}
    </style>`
    const allInjection = `${kiwixBarStyle}${darkStyle}`

    let rewritten = html
      // Anchor <base> before any relative URLs are resolved
      .replace(/(<head[^>]*>)/i, `$1${baseTag}`)
      // Rewrite absolute href/src/action attributes
      .replace(
        new RegExp(`((?:href|src|action)=["'])${escapeReg(kiwixAbsPrefix)}`, 'g'),
        `$1${proxyBase}`,
      )
      // Rewrite CSS url() references
      .replace(
        new RegExp(`url\\(['"]?${escapeReg(kiwixAbsPrefix)}`, 'g'),
        `url('${proxyBase}`,
      )

    // Inject kiwix-bar hide + dark-mode payload.
    // /<\/head\s*>/ handles optional whitespace before > (e.g. </head >).
    // Fall back to </body> if </head> is absent (some ZIM HTML omits optional close tags).
    // Last resort: prepend to the whole document.
    if (/<\/head\s*>/i.test(rewritten)) {
      rewritten = rewritten.replace(/<\/head\s*>/i, `${allInjection}</head>`)
    } else if (/<\/body\s*>/i.test(rewritten)) {
      rewritten = rewritten.replace(/<\/body\s*>/i, `${allInjection}</body>`)
    } else {
      rewritten = allInjection + rewritten
    }

    return c.html(rewritten, upstream!.status as 200)
  }

  // Pass through all other content (CSS, JS, images, fonts, etc.)
  const headers = new Headers()
  const forward = ['content-type', 'content-length', 'cache-control', 'etag', 'last-modified']
  for (const h of forward) {
    const v = upstream!.headers.get(h)
    if (v) headers.set(h, v)
  }
  return new Response(upstream!.body, { status: upstream!.status, headers })
})

function escapeReg(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export { archives }
