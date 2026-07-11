// Screenshot manifest for the documentation pipeline (docs-screenshot.mjs).
//
// Each entry: { route, persona, name, variants?, actions?, settleMs? }
//   route    – app route to capture
//   persona  – demo user to capture as ('sam' | 'riley' | 'jamie' | 'rose'), from
//              .demo-sessions.json (seeded by backend `bun run seed:demo`)
//   name     – output basename; files land at docs/src/assets/screenshots/<name>-<variant>.png
//   variants – ['desktop'] (default) and/or 'mobile'
//   actions  – optional pre-shot steps, run in order:
//                { type: 'click',   selector }
//                { type: 'waitFor', selector, timeout? }
//                { type: 'fill',    selector, value }
//                { type: 'wait',    ms }
//   settleMs – extra settle after load before actions/shot (default 2500)
//
// Persona guide: parental-control / admin shots come from sam; kid-view shots from
// jamie; teen surfaces from riley; news/radio/classics from rose.

export default [
  { route: '/', persona: 'sam', name: 'home', variants: ['desktop', 'mobile'] },
  { route: '/', persona: 'jamie', name: 'home-kid', variants: ['mobile'] },
  { route: '/music', persona: 'sam', name: 'music' },
  { route: '/videos', persona: 'riley', name: 'videos' },
  { route: '/news', persona: 'rose', name: 'news' },
  // Library (not the store): shows the seeded kid-appropriate collection. The store's
  // live discovery rails are source-driven and don't tell the kid-safe story.
  { route: '/books/library', persona: 'jamie', name: 'books-kid' },
  { route: '/companions', persona: 'riley', name: 'companions' },
  { route: '/shows', persona: 'sam', name: 'shows' },
  {
    // Content Profiles card only (element-scoped): the rest of /admin/users shows the
    // real household's accounts, which must never appear in docs screenshots.
    route: '/admin/users/profiles',
    persona: 'sam',
    name: 'admin-content-profiles',
    selector: '#profiles',
    actions: [{ type: 'waitFor', selector: 'text=Locked Down', timeout: 15000 }],
  },
]
