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
- lucide-react (icon library - use these icons, do not add others)
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

Full-page tinted background for app pages. Wraps the page's outer container with a subtle gradient tint (12% opacity) and a ghost-icon watermark in the bottom-right corner. Replaces hand-rolled `min-h-full bg-background` outer divs for any app that has its own color identity.

```ts
{ gradient: string; GhostIcon?: LucideIcon; children: ReactNode; className?: string }
```

Example: `<PageShell gradient="linear-gradient(135deg,#6366f1,#ec4899)" GhostIcon={Camera}>`

Currently used by: ImagingPage, VideoPage, BoredPage, CategoryPage, HomeInventoryPage.

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

Variant picker grid with a shared audio player — the audio sibling of the cover-art grid. Used by the podcast `StingerPicker` (intro/outro) and the Music app's Generate/Remix tabs. Generic over any item with `{ key, label, previewUrl }`; renders play/pause + select, with optional `sublabel`, `selectedKey`, `pickingKey`, `loading`, `error`, and `columns` (1/2/3).

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

The LokiDoki app logo. Renders the canonical brand mark from `/favicon.svg` (single source of truth — update that SVG and every surface follows: browser tab, sidebar, setup wizard, boot screen). Never re-create the logo inline; always use this component.

**Props:**
```ts
className?: string   // size via `size-*` (the SVG carries its own rounded tile + gradient)
glow?: boolean       // soft violet bloom hugging the squircle — for hero placements (boot/setup)
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

Toasts are mounted globally via `AppToaster` (`src/components/shared/AppToaster.tsx`, rendered once in `App.tsx`, theme-synced to light/dark). To show transient feedback after a save or destructive action, call `toast.success(...)` / `toast.error(...)` from `sonner` anywhere — do **not** build inline "Saving…/Saved" text for new code. Prefer toasts for success/error confirmation; keep optimistic UI updates as-is.

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

## Consent System - REMOVED

The prior `hasFeatureConsent` / `hasToolConsent` system has been fully removed. Do not reference:
- `backend/src/lib/consent.ts` (deleted)
- `backend/src/routes/adminConsent.ts` (deleted)
- `GET/POST/DELETE /api/admin/consent` (routes gone)
- `ConsentModal.tsx` (deleted)
- `AdminDataAccessTab.tsx` (deleted)
- `ServiceConsentCard.tsx` still exists but only exports the `DataSource` type; `ConsentWarningFooter` is dead code

All tools and briefing run unconditionally. Install-time disclosure in `InstallDisclosureModal` replaces consent gating.
