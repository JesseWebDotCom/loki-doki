<p align="center">
  <img src="assets/icons/brand.svg" width="72" alt="LokiDoki" />
</p>

# Agent Guidelines - loki-doki-v3

## Git & Pushing

**Never push to the remote (GitHub) without the user's explicit permission, every time.** Do not `git push` (or otherwise publish to the remote) unless the user asks for that specific push in that moment. Permission does not carry over: a "yes" or "do it" on one push never authorizes the next one, and the nature of the task (even if it obviously belongs on GitHub, like a README change) never implies permission. Local commits are allowed only when the user asks for them; pushing always requires a fresh, explicit go-ahead. When work is ready to publish, stop and ask.

## Context Rule

**Always interpret questions in the context of this app.** When the user asks about a feature, behavior, or concept without specifying a domain, assume they mean loki-doki-v3 - not a general knowledge question. If the question is genuinely ambiguous, ask for clarification before answering generically.

## Writing Style

**Never use em dashes (the long dash, Unicode U+2014) in any prose we write.** This covers documentation, UI copy, code comments, and commit messages. Use a comma, colon, parentheses, or a period instead, whichever fits the sentence. En dashes (`–`) are acceptable only for numeric ranges (for example, `2–8 users`). Em dashes are a strong "machine-generated" tell, so keep them out of everything user-facing.

## Model Strategy

`opusplan` is active - Opus in plan mode, Sonnet in execution.

Use `/plan` before starting:
- Architecture changes
- Large refactors
- New subsystems
- Database schema changes
- API redesigns

Stay in execution mode for:
- Bug fixes
- Small features
- Test fixes
- Documentation

## Minimum Testing Requirements

After writing or editing any frontend code, **always run `npx vite build` in `frontend/` before declaring done.** A successful Vite build (no errors, exit 0) is the minimum bar. `tsc --noEmit` passes but Vite's Babel transform catches additional errors (e.g. syntax errors in JSX/TSX that TypeScript misses). Never rely on `tsc` alone.

After writing or editing backend code, run `bun build --target=bun /path/to/src/index.ts` (no output = clean) to confirm the module graph resolves without errors.

If either build fails, fix the errors before reporting the task complete.

After touching any frontend UI file, also run `bun run check:design-contract` from `frontend/`.
It greps the diff's files for the mechanical Visual Language violations (em dashes, hardcoded
`violet-*`, `window.confirm`/`window.alert`) - see Visual Language below.

---

## Tech Stack

**Runtime & tooling**
- Bun (package manager and runtime - use `bun` not `npm`/`yarn`)
- Vite 6 + `@vitejs/plugin-react`
- TypeScript ~5.8

**UI layer**
- React 18
- Tailwind CSS v4 (CSS-first config via `src/index.css`, no `tailwind.config.js`)
- Design tokens (OKLCH) - `--brand`/`--brand-foreground` are the accent token; use `bg-brand`, `text-brand`, `border-brand`, `ring-brand` utilities. Never hardcode `violet-500` or the `primary` token for accent UI. Dark mode: `--brand: oklch(0.72 0.22 290)`. Light mode: `--brand: oklch(0.44 0.22 290)`.
- shadcn/ui - style: `new-york`, base color: `neutral`, CSS variables enabled
- Radix UI (via `radix-ui` package - primitives shadcn is built on)
- lucide-react (icon library - use these icons, do not add others). Exception: the Music app's
  station art (`components/music/StationArt.tsx`) uses **filled** `@tabler/icons-react` icons for
  silhouette covers, because lucide has no filled variants. Use lucide everywhere else.
- dnd-kit (`@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/modifiers`, `@dnd-kit/utilities`)
- react-router-dom v6

**Utility**
- `clsx` + `tailwind-merge` - always compose via `cn()` from `@/lib/cn`
- `class-variance-authority` for variant-based component APIs

**Backend**
- Hono - lightweight, Bun-native HTTP framework
- Database: SQLite via Bun's built-in `bun:sqlite` + Drizzle ORM
  - SQLite is the correct default for a local family app (2–8 users, single file, easy backup)
  - PostgreSQL supported as an optional override via `DATABASE_URL` env var
- TanStack Query - frontend data fetching, caching, background refetch
- Argon2id for PIN hashing - use `Bun.password.hash()` (built-in, no extra dep)
- Pepper via env var `PIN_PEPPER_SECRET` (256-bit hex, never stored in DB)
- Auth: HttpOnly session cookies (not JWT in localStorage - XSS-safe, simpler for single-instance)
- AI calls: always proxied through backend - API keys/Ollama URLs never reach the browser
- Streaming: Server-Sent Events (SSE) for LLM token streaming (`/api/chat/stream`)
- **Streaming render contract:** the SSE token handler replaces the entire `messages` array on every token. Any component rendered in that list **must** be wrapped in `React.memo` - without it, renders scale O(n²) with conversation length. Expensive derived values inside those components (markdown AST, citation transforms) must be `useMemo`'d for the same reason.

**Chat scroll contract (`MessageList.tsx`):**
- On generation start (`isGenerating` → `true`): scroll the user's prompt to the **very top** of the scroll container so only it (and the incoming response below) is visible. Use `getBoundingClientRect()` - not `el.offsetTop` - for the correct scroll offset: `container.scrollTop + elRect.top - containerRect.top - padding`.
- While streaming: auto-follow bottom (instant scroll) only if the user hasn't scrolled up.
- On generation end: smooth-scroll to bottom to reveal the full response.
- On conversation load: instant-jump to bottom.

**Voice / TTS** - see `docs/internal/subsystems.md`
- **Kokoro-82M TTS + Whisper STT**, both via ONE bundled Bun **voice-server sidecar** (`backend/scripts/voice-server.ts`). NOT XTTS/Piper/F5 (cloning deferred; Qwen3-TTS banned - Chinese-origin).
- Pluggable engine registry (`backend/src/lib/voice/`) - `kokoro` only for now.
- Streaming, sentence-chunked: `POST /api/tts/stream` emits one NDJSON PCM payload per sentence. Never batch the whole reply.
- **Bun WS requires `websocket` on the default export in `index.ts`** - load-bearing.

**Deployment**
- Bare Bun only - no Docker
- `bun run start` serves both the API and the built frontend from one process
- Data directory `data/` alongside the server: SQLite file, uploads, model cache, voice samples
- First-run setup wizard on empty DB (create admin account) - no default credentials

Do not introduce new dependencies without discussing first. If a need arises that shadcn, Radix, or the above libraries already cover, use what's there.

**Architecture reference docs** (open when working on those subsystems):
- `docs/internal/llm-architecture.md` - LLM/model catalog, prompt routing, structured output
- `docs/internal/app-structure.md` - routes table, iframe page pattern, auth flow, PIN security
- `docs/internal/subsystems.md` - character system, voice, memory, image gen API, maps, admin
- `docs/internal/image-stack.md` - ComfyUI runtime, model downloads, memory budgets
- `docs/internal/chat-latency.md` - chat pipeline, latency tuning

---

## Component Hierarchy

```
src/components/
  ui/         ← shadcn primitives (generated, do not hand-edit)
  shared/     ← reusable app-level components (centralized here)
  chat/       ← feature-scoped components
  shell/      ← AppShell, BottomNav, GlobalChatInput, LeftSidebar, SubtitleBar
  auth/       ← login, profile selection, PIN entry
  settings/   ← settings modal tabs
  admin/      ← admin panel tabs (admin-only)
  devtools/   ← developer tools tabs (admin-only)
  ...         ← other feature dirs
```

### Decision order when building UI

1. **Use a `ui/` primitive** - if shadcn already has it (Button, Badge, Dialog, Input, etc.), use it as-is.
2. **Use a `shared/` component** - if a richer/composed version already exists in `shared/`, use it. See catalog below.
3. **Add to `shared/`** - if you're building something that combines multiple primitives into a reusable pattern, put it in `shared/`, not inline.
4. **Add to the feature dir** - only if the component is genuinely specific to one feature and has no plausible reuse elsewhere.

**Never duplicate.** If `shared/` already has a component that does the job, use it. Do not recreate it inline or in a feature dir.

---

## Shared Component Catalog

### App Header Contract (read this first for any app page)

Every app shares ONE header system so they look and behave identically. Do not hand-roll a
header, a title row, or a background tint on an app page. The pieces:

**1. Breadcrumb (automatic).** `AppShell` renders the breadcrumb (`Home / Group / App`) for every
non-home app route from the `APP_GROUPS` registry (`src/lib/appCategories.ts`), icon, name, and
accent color all come from the registry. You get this for free; you do not render it.

**2. Reload-on-click (automatic).** The app crumb (icon + name) is a button that reloads the app:
it navigates to the app root and remounts the route (resetting tab/scroll/search/query state).
Layout apps with a persistent rail/player (YouTube, Bookmarks, Chat) keep that rail mounted during
normal internal navigation and only fully reload when the crumb is clicked, this works because the
`Outlet` is keyed by **app root**, not full pathname. Nothing to wire per page.

**3. Background tint (automatic).** The app's registry `color`/`gradient` tints the right panel
(corner fade + ghost-icon watermark), like Chat. `AppShell` paints it for standard scroller apps;
full-bleed / chat pages get it from `PageShell`. Keep your page root transparent and it shows
through. See `AppBackdrop` below, you rarely use it directly.

**4. Header actions (opt in via `useAppHeader`).** To add a search box, external link, admin
settings gear, or global toggle buttons to the breadcrumb row, call **`useAppHeader(...)`** from
`src/context/BreadcrumbSearchContext.tsx` in your page. This is the ONLY sanctioned way to populate
the action row, never inject buttons into the breadcrumb yourself.

```ts
useAppHeader({
  query, setQuery,            // search box (required to render the input)
  onSubmit,                   // omit for live-filtering (no Search button)
  placeholder: 'Search…',
  loading,                    // spinner in the Search button
  externalHref: 'https://…',  // external-link icon (new tab)
  settingsHref: '/admin/…',   // admin-only gear (hidden for non-admins)
  leftSlot, rightSlot,        // global toggle buttons (e.g. YouTube online/offline)
})
```

The config auto-clears on unmount. `useAppHeader` (and `AppHeaderConfig`, `useAppHeaderConfig`) is
the current name; `useBreadcrumbSearch` is a back-compat alias, prefer `useAppHeader` in new code.

**5. Sub-tabs (use `AppTabBar`).** Tabbed apps keep their tab row in the page body (just under the
breadcrumb) but render it via `AppTabBar` so every tabbed app looks identical. See below.

**6. In-page app identity (icon tile + name).** Never hand-roll the app's icon tile with a hardcoded
color, it drifts from the registry and the breadcrumb. The app's icon must render in its **registry
gradient** (`app.gradient`) with the **registry icon** (`app.icon`):
- Layout apps with a left rail (YouTube, Bookmarks, Podcasts, Companions, App Store) use
  **`AppRailHeader`** (resolves icon+gradient from the registry by route).
- Standard scroller apps use `PageHeader variant="compact"`, whose icon tile is painted with the
  `gradient` you pass (use the app's registry gradient).

---

### `AppBackdrop` - `src/components/shared/AppBackdrop.tsx`

The app color-identity layer: a corner-fade tint (from the app gradient) + a faint ghost-icon
watermark. Render as an `absolute inset-0` sibling behind `relative z-10` content. Usually applied
for you by `AppShell` / `PageShell`, only reach for it directly on a custom full-bleed surface.

```ts
{ gradient?: string; GhostIcon?: LucideIcon }
```

---

### `AppTabBar` - `src/components/shared/AppTabBar.tsx`

The standardized in-body sub-navigation pill row for tabbed apps (Music, etc.). Use it instead of
hand-rolling a tab row.

```ts
{ tabs: AppTab<T>[]; value: T; onChange: (id: T) => void; className?: string }
// AppTab: { id: T; label: string; icon?: LucideIcon; shortLabel?: string }
```

`shortLabel` (defaults to the first word of `label`) is shown on narrow screens.

---

### `AppRailHeader` - `src/components/shared/AppRailHeader.tsx`

The standardized app-identity header for layout apps with a left rail. Renders the app's registry
icon in its registry gradient tile (matching the breadcrumb tile) + name + description. Icon and
gradient resolve from the registry by route; pass `icon`/`gradient` explicitly only for routes not
in `APP_GROUPS` (e.g. App Store).

```ts
{ title: string; description: string; icon?: LucideIcon; gradient?: string; className?: string }
```

---

### `RichOptionSelect` - `src/components/shared/RichOptionSelect.tsx`

A searchable dropdown/combobox with rich per-option content: title, subtitle/description, and badges. Built on `Radix Popover` + `Badge`.

**Use this whenever you need:**
- A `<select>`-like picker with more than plain text per option
- Options with descriptions, status badges, or a "Recommended" flag
- Search/filter across options (auto-shown when > 5 options)
- Grouped options with section headers

**Props:**
```ts
groups: RichOptionGroup[]   // { label?: string; options: RichOption[] }
value: string
onChange: (value: string) => void
placeholder?: string
triggerClassName?: string
disabled?: boolean
```

**`RichOption` shape:**
```ts
{
  value: string
  label: string
  description?: string       // subtitle shown below label
  badges?: { text: string; variant?: BadgeProps["variant"] }[]
  recommended?: boolean      // auto-adds a "Recommended" info badge
  disabled?: boolean
}
```

---

### `ModelCard` / `ModelCardGroup` - `src/components/shared/ModelCard.tsx`

Card-based model selector matching the old-app screenshot pattern: name, active/not-installed badge, tag chips (fast/quality/recommended/fallback/uncensored/accurate), size label, format, backend, description line. `ModelCardGroup` renders a list and manages single-selection.

**Props (`ModelCard`):**
```ts
option: ModelCardOption   // { id, label, description, sizeLabel, format?, backend?, tags?, installStatus }
selected: boolean
onClick: () => void
```

**Props (`ModelCardGroup`):**
```ts
options: ModelCardOption[]
value: string             // selected id
onChange: (id: string) => void
```

**`installStatus`:** `'active'` | `'installed'` | `'not_installed'`

Use in the Admin Panel model selection tabs - one `ModelCardGroup` per role (llm, uncensored_llm, vision, image_gen).

---

### `SpotlightSearch` - `src/components/shared/SpotlightSearch.tsx`

A spotlight-style search modal (think macOS Spotlight). Renders both the sidebar trigger button (Search icon + label + ⌘K/Ctrl K badge) and the Dialog. Opens via button click or Ctrl/⌘+K. Supports arrow-key navigation and Enter to navigate. Uses `Dialog` root + raw `RadixDialog.Content` (no built-in close button) from Radix.

**Use this for** the global search trigger in the left sidebar - do not recreate inline.

No props - self-contained with internal open state.

---

### `DownloadProgress` - `src/components/shared/DownloadProgress.tsx`

Animated download card with progress bar, stats, and controls. Supports pause/resume/cancel/retry.

**Status values:** `idle` | `pending` | `downloading` | `paused` | `completed` | `error` | `cancelled`

**Props:**
```ts
label: string
description?: string
status: DownloadStatus
progress?: number          // 0–100 (auto-computed from bytes if omitted)
downloadedBytes?: number
totalBytes?: number
speedBps?: number          // bytes/sec - shown as "X MB/s" while downloading
etaSeconds?: number        // shown as "Xm Ys remaining" while downloading
error?: string
onStart?: () => void
onPause?: () => void
onResume?: () => void
onCancel?: () => void
onRetry?: () => void
```

**Visual:** animated blue→violet gradient bar while downloading, amber when paused, emerald on completion, red on error. Shimmer overlay animates across the fill. Card border tints to match status.

---

### `PageShell` - `src/components/shared/PageShell.tsx`

Transparent page wrapper that carries the app's color identity. Delegates the tint to `AppBackdrop`
and, importantly, only self-tints on full-bleed / chat routes that `AppShell` does NOT cover, on
standard scroller apps the shell already paints the backdrop, so `PageShell` stays a transparent
pass-through and the tint is applied exactly once. Existing pages can keep wrapping in `PageShell`
unchanged; new standard apps don't need it at all (the shell tints them regardless).

```ts
{ gradient?: string; GhostIcon?: LucideIcon; children: ReactNode; className?: string }
```

The gradient/icon default to the current app's registry entry when omitted. Pass them explicitly
only for a custom full-bleed surface.

---

### `PageHeader` - `src/components/shared/PageHeader.tsx`

Standard page header for scroll pages that need a plain or hero header. Do not use for pages that already use `PageShell`.

**`variant="plain"` (default):** `text-3xl sm:text-4xl font-black tracking-tight`, optional uppercase eyebrow and muted subtitle. Standard padding `px-5 pt-10 pb-6`.

**`variant="hero"`:** Full-bleed gradient banner with icon tile + eyebrow + title + optional CTA.

```ts
// plain
{ variant?: "plain"; eyebrow?: string; title: string; subtitle?: string; actions?: ReactNode; className?: string }
// hero
{ variant: "hero"; eyebrow?: string; title: string; subtitle?: string; gradient: string; icon?: ReactNode; cta?: ReactNode; className?: string }
```

---

### `SectionHeader` - `src/components/shared/SectionHeader.tsx`

Bold section title with optional "See all" link. Replaces all hand-rolled section-label patterns (`text-lg font-bold tracking-tight`, optional `ChevronRight`).

```ts
{ title: string; to?: string; lead?: string; className?: string }
```

---

### `ChipRow` / `Chip` - `src/components/shared/ChipRow.tsx`

TikTok-style horizontally-scrollable pill filter row. `Chip` active state uses `bg-brand text-brand-foreground`; inactive uses `bg-foreground/8`. `ChipRow` is a `no-scrollbar flex gap-2 overflow-x-auto` wrapper.

```ts
// Chip
{ label: string; active?: boolean; onClick?: () => void; className?: string }
// ChipRow
{ children: ReactNode; className?: string }
```

---

### `TrackVariantGrid` - `src/components/shared/TrackVariantGrid.tsx`

Variant picker grid with a shared audio player, the audio sibling of the cover-art grid. Used by the podcast `StingerPicker` (intro/outro) and the Music app's Generate/Remix tabs. Generic over any item with `{ key, label, previewUrl }`; renders play/pause + select, with optional `sublabel`, `selectedKey`, `pickingKey`, `loading`, `error`, and `columns` (1/2/3).

```ts
{ variants: T[]; loading?: boolean; error?: string | null; selectedKey?; pickingKey?;
  onSelect: (v: T) => void; columns?: 1 | 2 | 3; sublabel?: (v: T) => string | null }
```

---

### `Card` variants - `src/components/ui/card.tsx`

The shadcn `Card` now exports a `cardVariants` CVA export with four variants. Prefer these over hand-rolled card divs:
- `surface` (default) - `rounded-2xl border border-border/60 bg-card`
- `interactive` - surface + `cursor-pointer hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-lg active:scale-[0.99]`
- `gradient` - `rounded-2xl text-white` (add your own gradient via `style` or `className`)
- `dashed` - `rounded-2xl border-2 border-dashed border-border/60 bg-card/40` (empty-state prompt cards)

---

### `AppSettingsPage` - `src/components/shared/AppSettingsPage.tsx`

The shell for every app's own settings page, reached via the breadcrumb gear
(`useAppHeader({ settingsHref: '/{app-route}/settings' })`). Never point `settingsHref` at
Admin - a per-app settings page is reachable by every user, not just admins, and shows only
that app's own preferences. User content is always visible; `adminSection` (if the app has
admin-only config) is shown in full to admins and replaced with a plain locked notice for
everyone else. Apps with nothing to configure simply don't set a `settingsHref` - no gear
button renders.

```ts
{
  title?: string            // default "Settings"
  backTo: string             // the app's root route
  backLabel: string
  icon: LucideIcon           // the app's registry icon
  gradient: string           // the app's registry gradient
  children: ReactNode        // user-facing settings content
  adminSection?: ReactNode   // admin-only config; omit entirely if the app has none
  adminNotice?: string       // shown to non-admins in place of adminSection
}
```

---

### `WidgetErrorBoundary` - `src/components/shared/WidgetErrorBoundary.tsx`

Per-tile error boundary for dashboard-style widgets (used by the Home canvas around every widget renderer). Catches a render throw inside one widget and shows a compact muted card ("This widget hit an error") with a Retry (remount) button, instead of letting the error bubble to the app-wide `ErrorBoundary` and blank the page. Wrap once at the lowest common render point of each tile.

---

### `ConfirmDialog` - `src/components/shared/ConfirmDialog.tsx`

Reusable confirmation modal. Use this for every destructive action (delete, reset, etc.) - do not build inline confirmation UI.

**Rule: every delete action must use `ConfirmDialog`. Never use `window.confirm()`. Always set `destructive` for irreversible actions.**

Pattern:
```tsx
const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

// In the button:
onClick={() => setConfirmDeleteId(item.id)}

// After the return:
<ConfirmDialog
  open={confirmDeleteId !== null}
  onOpenChange={open => !open && setConfirmDeleteId(null)}
  title="Delete this item?"
  description="This will permanently remove the item. This action cannot be undone."
  confirmLabel="Delete"
  destructive
  onConfirm={() => { if (confirmDeleteId) { void handleDelete(confirmDeleteId); setConfirmDeleteId(null) } }}
/>
```

**Props:**
```ts
open: boolean
onOpenChange: (open: boolean) => void
title: string
description?: string
confirmLabel?: string   // default: "Confirm"
cancelLabel?: string    // default: "Cancel"
destructive?: boolean   // default: false - uses destructive variant on confirm button
onConfirm: () => void
```

---

### `ColorPicker` - `src/components/shared/ColorPicker.tsx`

Dropdown color swatch picker with 8 named color choices. Also exports `resolveProjectColor(slug)` for converting a color slug to a concrete CSS value (used with `color-mix` for tinted icon backgrounds).

**Props:**
```ts
value: string | null
onChange: (slug: string | null) => void
```

**Exports:** `ColorChoice`, `COLOR_CHOICES`, `resolveProjectColor`

---

### `IconPicker` - `src/components/shared/IconPicker.tsx`

Searchable grid icon picker with 52 lucide icons. Also exports `getIconChoice(slug)` to resolve a slug to its `{ slug, label, Icon }` object.

**Props:**
```ts
value: string | null
onChange: (slug: string | null) => void
```

**Exports:** `IconChoice`, `ICON_CHOICES`, `getIconChoice`

---

### `BrandMark` - `src/components/shared/BrandMark.tsx`

The LokiDoki app logo. Renders the canonical brand mark from `/favicon.svg` (single source of truth, update that SVG and every surface follows: browser tab, sidebar, setup wizard, boot screen). Never re-create the logo inline; always use this component.

**Props:**
```ts
className?: string   // size via `size-*` (the SVG carries its own rounded tile + gradient)
glow?: boolean       // soft violet bloom hugging the squircle, for hero placements (boot/setup)
```

### `SpaceBackdrop` - `src/components/shared/SpaceBackdrop.tsx`

Decorative deep-space scene: twinkling starfield, occasional shooting stars, and a slowly drifting UFO over a deep-space radial gradient. `pointer-events-none` (never captures input). Designed to sit **behind** a transparent globe/planet canvas. Used by the Maps globe view (`MapsPage`, mounted only at globe zoom) and the Moon Phase app (`MoonPhasePage`).

```ts
{ starCount?: number; shootingStars?: boolean; ufo?: boolean; className?: string }
```

Notes:
- Keyframes live in `index.css` (`star-twinkle` reused; `space-shoot`, `ufo-drift` added). Per-star randomized values are inline styles (genuinely dynamic).
- Place it as an `absolute inset-0 z-0` layer with the real content in a `relative z-10` sibling. Over a dark space backdrop, wrap content in `data-theme="dark"` so themed tokens (foreground/card) stay readable regardless of the app's active theme.

### Toasts (app-wide) - `sonner`

Toasts are mounted globally via `AppToaster` (`src/components/shared/AppToaster.tsx`, rendered once in `App.tsx`, theme-synced to light/dark). To show transient feedback after a save or destructive action, call `toast.success(...)` / `toast.error(...)` from `sonner` anywhere. Do **not** build inline "Saving…/Saved" text for new code. Prefer toasts for success/error confirmation; keep optimistic UI updates as-is.

---

## Visual Language

The reference for "does this look right" is the app's own brand mark (`public/favicon.svg`,
rendered via `BrandMark`): a near-black rounded tile with ONE restrained diagonal accent
gradient on a precise mark. Build the rest of the UI toward that, not toward "more color."

- **Accent discipline.** `bg-brand`/`text-brand`/`border-brand`/`ring-brand` is the only accent
  for interactive UI - buttons, active states, focus rings, links. The brand mark's multi-stop
  gradient is for brand/hero moments only (`BrandMark`, onboarding hero panels). Never copy it
  onto a generic button or badge. Per-app registry gradients (`appCategories.ts`) are fine for
  sparse, larger identity moments (a breadcrumb crumb, one `PageHeader`/`AppRailHeader` tile, a
  hero banner), but in dense, repeated contexts (a stacked nav list, a grid of category cards)
  use `AppIconTile`'s `variant="flat"` (the app's single solid `color`) instead. A wall of
  differently-hued multi-stop gradients reads as a sticker sheet, not a curated nav rail.
- **Calm surfaces.** Default to `bg-card`/`bg-background`. Color is an accent, not wallpaper.
- **No emoji as UI.** Icons are lucide-react only, full stop. This includes status glyphs,
  presence indicators, and category icons, not just decorative icons. Emoji are fine inside
  natural-language body copy (e.g. a generated advice string) but never stand in for an icon
  component.
- **One state-handling idiom per concept.** `EmptyAppState` for empty states, `sonner`
  (`toast.success`/`toast.error`) for save/error feedback, `ConfirmDialog` for every destructive
  action, `cardVariants` (`surface`/`interactive`/`gradient`/`dashed`) for cards. These are not
  optional patterns among several, they are the only pattern. Do not hand-roll a "Saving.../
  Saved" label, a second confirm-button component, or a bespoke "nothing here" block.
- **No floating UI parked on top of content.** A persistent overlay (the companion, a mini
  player) defaults to a corner dock, not dead-center, so it never guarantees an overlap with
  whatever the page happens to render there.
- **No em dashes** in documentation, UI copy, code comments, or commit messages (see Writing
  Style above). This is the single most common violation found in an app-wide audit, more than
  any other rule here, so treat it as the canonical thing to check a diff against.

**Checking a diff against this:** run `bun run check:design-contract` (frontend/scripts, see
Minimum Testing Requirements) before calling frontend work done. It greps for the mechanical
violations (em dashes, hardcoded `violet-*`, `window.confirm`/`window.alert`) and is not a full
substitute for reading the diff against the rules above, but it catches regressions on exactly
the patterns that recur most.

---

## Code Conventions

- All styling via Tailwind utility classes - no CSS modules, no inline `style` props (except when a value is truly dynamic and can't be expressed as a class).
- Compose class names with `cn()` from `@/lib/cn`. Never concatenate class strings manually.
- TypeScript strict mode - no `any`, no type assertions without a comment explaining why.
- Component files export a single named export matching the filename (e.g. `RichOptionSelect.tsx` → `export function RichOptionSelect`).
- Use shadcn's `Badge` variants (`default`, `secondary`, `destructive`, `outline`, `info`) for status/label chips - do not build custom badge-like UI.
- Icons come from `lucide-react` only. Use the `size-*` Tailwind class (`size-4`, `size-5`) not `w-* h-*` pairs.

---

## Adding to `shared/`

Before adding a new shared component, check whether an existing one can be extended. When you do add one:
- Put it in `src/components/shared/`
- Export types alongside the component (e.g. `RichOption`, `RichOptionGroup`)
- Document it in this file under **Shared Component Catalog**

---

## App Store System

Apps and Extensions are surfaced in a single App Store (`/app-store`, `AppStorePage.tsx`). "Installed" means `enabled === true` in `toolGlobalConfig` (key `__enabled`). No separate consent ledger exists - install-time disclosure replaces it.

**Key concepts:**
- **Apps** (`offline: false`) - tools with dedicated page routes (weather, news, etc.)
- **Extensions** (`offline: true`) - chat-only tools with no page (calculator, datetime, etc.)
- **Built-ins** - page-only apps with no backend tool (Chat, Maps, Links, Images) - synthesized from `APP_GROUPS` in `appCategories.ts` and merged via `mergeApps()` in AppStorePage
- **Install flow (admin):** clicking "Get" opens `InstallDisclosureModal` which shows data sources, then calls `PUT /api/tools/:id/enabled { enabled: true }`
- **Uninstall flow (admin):** "Remove" calls `PUT /api/tools/:id/enabled { enabled: false }`
- **Request flow (non-admin):** "Request" posts to `POST /api/app-store/request` which creates an `install_request` notification targeting admins (`userId: null`)

**Routes:**
- `GET /api/tools` - list all tools with `enabled`, `offline`, `dataSources`
- `PUT /api/tools/:id/enabled` - admin toggle
- `POST /api/app-store/request` - non-admin install request

**Frontend:**
- `AppStorePage.tsx` - grid of cards, filter tabs (All/Installed/Apps/Extensions), search
- `InstallDisclosureModal.tsx` - data source disclosure before admin installs
- `TOOL_ROUTES` constant in AppStorePage maps tool IDs to page routes for "Open" button

**Uninstalled apps hidden everywhere:** `useInstalledTools.ts` hook + `isAppVisible()` helper used in `AllAppsPage`, `CategoriesPage`, `CategoryPage`, `HomePage` categories, and LeftSidebar pinned/recent.

---

## Notification System

**DB table:** `notifications` (migration 0017)
- `id`, `user_id` (nullable = admin-only), `type`, `payload` (JSON text), `read_at`, `created_at`
- Types: `install_request` | `install_complete` | `download_complete` | `system`
- `userId: null` = visible to all admins; `userId: <id>` = visible only to that user

**Routes:** `GET/PATCH/POST /api/notifications`, `GET /api/notifications/unread-count`, `POST /api/notifications/read-all`

**Frontend:**
- `useNotifications.ts` hook polls `/api/notifications/unread-count` every 30s
- Unread badge (red) on the user profile area in LeftSidebar
- Clicking the profile opens a dropdown showing recent notifications with mark-read and mark-all-read

---

## Home Layout System

Users can customize the home page canvas with widgets. Admins can set defaults and lock individual users.

**DB storage:** `userPreferences` table with keys:
- `home.layout` - per-user `HomeLayout` JSON
- `home.layout.locked` - boolean, prevents user from editing
- `app_settings` key `home.layout.default` - system-wide default

**Types:**
```ts
interface HomeWidget    { toolId: string; colSpan: 1 | 2 }
interface HomeRow       { id: string; cols: HomeWidget[] }
interface HomeLayoutHeader { weather: boolean; jokes: boolean; sports: boolean; locked: boolean }
interface HomeLayout    { header: HomeLayoutHeader; canvas: HomeRow[] }
```

**Routes:**
- `GET/PUT /api/home-layout` - current user's layout (GET migrates legacy `home.highlights` pref)
- `GET/PUT /api/home-layout/default` - admin: system default
- `GET/PUT /api/home-layout/users/:id` - admin: per-user layout + lock flag

**Frontend:**
- `useHomeLayout.ts` hook - fetches layout, exposes `save(layout)` and `locked`
- `HomePage.tsx` - header zone gated on `layout.header.*` flags; canvas zone below with dnd-kit row sorting in edit mode; widget picker modal
- Widget registry in `HomePage.tsx`: `weather`, `news`, `jokes`, `sports`, `on-this-day`, plus placeholder for any other tool
- Edit mode: pencil button (hidden when locked), drag handles, row remove, "Add widget" dashed button
- `AdminAppsTab.tsx` (Admin > Apps): install requests panel, app install toggles, default layout editor, per-user layout + lock editor

**Legacy migration:** On first `GET /api/home-layout` with no existing layout, the API reads `home.highlights` preferences (sports/jokes booleans) and seeds `header` from them.

---

## Coding System

`/coding` (`CodingPage.tsx`) is a real terminal (xterm.js) attached to a persistent
**tmux session per user**, wrapping a single managed **Claude Code CLI** (`claude`)
process, replaces the old OpenCode integration.

**Key files:**
- `backend/src/lib/claudeCode.ts` - installs `@anthropic-ai/claude-code` as a pinned
  npm dependency into its own managed runtime dir (`data/coding/claude-runtime`),
  version bumped deliberately, not on every install
- `backend/src/lib/codingSandboxUser.ts` - OS-level sandbox: a dedicated unprivileged
  OS user per household when supported (real filesystem/process isolation, not just
  app-level checks); unsupported on Windows or before install, falls back to a plain
  directory under `data/coding/users/<userId>` with no OS isolation (Claude Code's own
  interactive approval prompts are the only guard in that case)
- `backend/src/lib/codingServer.ts` - session/pane management: one `tmux` session named
  `coding` per user, spawns `claude` inside it; per-user `HOME` nested inside the
  workspace dir (`.home`) so config/skills/credentials never leak across household
  members; tmux split/kill for panes
- `backend/src/lib/codingPtySidecar.ts` + `backend/scripts/coding-pty-sidecar.ts` - the
  actual PTY attach runs in a small **Node sidecar** process, not the main Bun process
  (`node-pty`'s data-callback delivery is unreliable under Bun)
- `backend/src/routes/coding.ts` - `GET /terminal` (WebSocket) relays the browser's
  socket to the PTY sidecar's socket verbatim in both directions; `POST /pane/:action`
  issues tmux split/kill commands

**Model:** the `coding` catalog role resolves an Ollama-served local model (falls back
to `ornith:9b`), configurable via the `coding_model` app setting.

**Persistence is the point:** closing the browser tab or reloading only kills the
attach client, tmux (and `claude` inside it) keeps running server-side, so a project
picks back up exactly where it left off.

---

## Books & Reference System

Two plain homes for all offline/discoverable reading content, split by artifact type:
a book/textbook/manual is a **Book** (`/books`), a living wiki/encyclopedia/Q&A/video/
doc-site is **Reference** (`/reference`). No "ZIM"/"archive"/"content pack" jargon
surfaces to users; that's still the underlying kiwix mechanism for Reference.

**Books** (`backend/src/routes/books.ts`, `frontend/src/pages/books/`):
- Storefront across 4+ sources: Project Gutenberg, Standard Ebooks, Internet Archive,
  LibriVox (audiobooks), Open Library/Google Books metadata, custom self-hosted OPDS
  indexers (Calibre-Web, Kavita, COPS, etc. - `bookIndexers` table, admin-managed), plus
  user uploads and magazines
- Two-tier per-user library state on `bookLibrary.status`: `'saved'` (metadata only,
  no bytes on disk) vs the offline-download lifecycle `'pending' → 'downloading' →
  'ready'` (only `'ready'` has a local copy)
- `bookProgress` tracks per-user reading (`epubCfi`) or listening
  (`audioPositionSec`/`audioChapterIdx`) position; switching modes doesn't align position
- TTS-to-audiobook for any text book without a narrated source; multi-track
  (LibriVox-style) audiobooks stream per-chapter from `externalAudioUrl` instead of
  seeking a single shared file
- **AI book authoring** (`backend/src/routes/booksGenerate.ts`, `bookProjects` +
  `bookProjectChapters` tables): draft an original book from a premise (or continue/
  reshape an existing one) through a reviewed pipeline - story bible → sample chapter →
  per-chapter generation, with user approval gates at each stage. Kept out of the shared
  `books` catalog until approved end to end; `commitProjectToBook()` then materializes a
  real `books` row (`sourceType='ai-generated'`)

**Reference** (`frontend/src/pages/reference/ReferencePage.tsx`,
`backend/src/routes/archives.ts` / `adminArchives.ts`): all installed kiwix/ZIM
reference archives (Wikipedia, repair guides, medical references, etc.) plus the
Dictionary and Medical lookup tools (their pages reused as-is; `/medical` and
`/dictionary` redirect here). `ZimSource.bookCategory` (in `zimCatalog.ts`) is what
drives the Books/Reference split for admin-added packs; the underlying kiwix
download/serve plumbing is unchanged, only the tag and presentation moved.

---

## Canvas / Artifacts System

`/canvas` (and the in-chat canvas tray) is an editable side pane the companion writes
code, documents, or HTML into live, backed by `backend/src/routes/artifacts.ts` +
`backend/src/lib/artifacts/store.ts` + the `tools/canvas.ts` chat tool.

**DB tables:** `artifacts` (`type`: `'code' | 'document' | 'html'`, `currentContent`,
`pinned`, `archivedAt`) and `artifactVersions` (one immutable row per revision,
`author`: `'assistant' | 'user'`, optional human-readable `summary`).

**How it streams:** the companion opens a canvas via an `open_artifact` directive in
its turn, content streams into the pane token-by-token via an `artifact_token` SSE
event (same transport as chat streaming). A chat message can target an already-open
artifact for an edit-style follow-up (`chat.ts` tracks the open artifact per
conversation) - see `POST /api/artifacts/:id/edit` for the LLM edit pass over current
content.

**Export:** PDF export goes through the same headless Chromium instance that powers
the Reader archive engine (`system.ts` - install-heals if Chromium is missing).

---
