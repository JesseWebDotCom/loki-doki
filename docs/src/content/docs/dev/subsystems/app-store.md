---
title: App Store & Notifications
description: The install model (enabled-tool config, no consent ledger), Apps vs Extensions, the merge of built-ins with backend tools, the notification system, and the customizable Home layout.
sidebar:
  order: 16
---

import { Aside } from '@astrojs/starlight/components';

## Overview

The App Store is the household's control surface for which apps and tools exist. There is no separate consent ledger or per-tool data-consent table: an app is "installed" when its backend tool is enabled, and the data-source disclosure that used to live in a consent flow is now shown inline at install time.

Three subsystems are documented together here because they share the same surface:

- **App Store**: browse, install, and remove apps (admin) or request them (everyone else).
- **Notifications**: install requests, completions, and system messages, with an admin-targeted channel.
- **Home layout**: the customizable Today/Home canvas, with a per-user lock and an admin default.

## Install model

"Installed" means `enabled === true` for the tool. Enabled state is stored as a single row per tool in `toolGlobalConfig` under the key `__enabled` with a JSON boolean value. There is no install/uninstall table; toggling that one row is the whole operation.

`GET /api/tools` (`backend/src/routes/tools.ts`) projects the in-memory `toolRegistry` and folds in the `__enabled` rows. The critical default is that a tool with no `__enabled` row is treated as enabled:

```ts
enabled: enabledMap[t.id] !== false
```

So tools are opt-out, not opt-in: a freshly registered tool is on until an admin disables it.

Each tool row also carries `offline`, `examples`, `configSchema`, and `dataSources`. `dataSources` is what powers the install-time disclosure.

### Routes

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/tools` | any user | List every tool with `enabled`, `offline`, `dataSources`, `examples`. |
| `PUT` | `/api/tools/:id/enabled` | admin | Install (`{enabled:true}`) or uninstall (`{enabled:false}`). 404 on unknown tool id. |
| `POST` | `/api/app-store/request` | any user | Non-admin request; creates an admin-targeted `install_request` notification. |

The enable/disable route is `requireAdmin`. Non-admins never call it; they go through the request flow.

## Apps vs Extensions

The store splits tools by their `offline` flag:

- **App** (`offline: false`): has a real page route, shown with an **Open** action once installed.
- **Extension** (`offline: true`): chat-only; the model can call it, but there is no page to visit.

This is surfaced as the `Extension` / `App` tag and the `Type` detail row in `StoreAppDetailPage.tsx`. Note the field name is inverted relative to its meaning: `offline: true` marks the chat-only Extension.

### Built-ins and the merge

Some full-page apps (Chat, Images/Imaging, Maps, Links, and other catalog entries) are not backend tools at all. They live in `APP_GROUPS` in `frontend/src/lib/appCategories.ts` as `AppItem`s. The store unifies both worlds in `useStoreApps.ts` via `mergeApps()`:

1. Map every `/api/tools` entry through `fromTool()` into a `StoreApp`, resolving icon/gradient/category from the catalog (`byId` / `byRoute` lookups) or a fallback table.
2. Walk `APP_GROUPS` and append (`fromBuiltin()`) any catalog app that is **not** tool-backed (`!item.toolId`) and whose route is not already taken.

Built-ins always report `enabled: true` and `builtIn: true`, so they can never be uninstalled; their kebab menu hides **Remove** (`canRemove = isAdmin && app.enabled && !app.builtIn`). The `StoreApp` record (icon, gradient, category, `offline`, `enabled`, `online`, `route`, `dataSources`, `examples`) is the single shape every store view renders.

`TOOL_ROUTES` in `useStoreApps.ts` maps tool ids to their page routes (e.g. `image_gen → /imaging`), since the tool id and the route are not the same string.

## Install flow

The action button is `PrimaryAction` in `frontend/src/components/store/StoreActions.tsx`, driven by `StoreActionsProvider`:

- **Installed + has route** → **Open** (navigate to `app.route`).
- **Installed Extension** (no route) → an inert **Installed** pill.
- **Not installed, admin** → **Get** → opens `InstallDisclosureModal`.
- **Not installed, non-admin** → **Request** → opens `RequestModal`.

### Admin install (the disclosure)

`InstallDisclosureModal` (`frontend/src/components/shared/InstallDisclosureModal.tsx`) is the replacement for the old consent step. It lists the tool's `dataSources` (each `type` of `api` / `rss` / `web` / `cdn`, with `domain` and `purpose`), or a "Fully local" panel when there are none. Confirming calls:

```
PUT /api/tools/:id/enabled  { enabled: true }
```

then invalidates the `['tools']` React Query key so every store view re-renders as installed.

Uninstall (`remove` in `StoreActions.tsx`, also the **Remove** kebab item) sends the same route with `{ enabled: false }`.

### Non-admin request

`RequestModal` posts an optional note to:

```
POST /api/app-store/request  { toolId, toolName, message? }
```

`backend/src/routes/appStore.ts` inserts a `notifications` row with `userId: null` (admin-targeted) and `type: 'install_request'`, whose payload carries `requestedBy`, `requestedByName`, `toolId`, `toolName`, and `message`. The modal then shows "Request sent."

## Visibility everywhere else

Uninstalled apps must disappear from nav, category pages, and the home canvas, not just the store. `frontend/src/hooks/useInstalledTools.ts` fetches `/api/tools` and exposes the set of enabled tool ids plus an `isAppVisible(toolId, enabledToolIds)` helper:

- No `toolId` (built-in/always-on) → always visible.
- Still loading (`enabledToolIds === null`) → visible optimistically (avoids a flash of empty content).
- Otherwise → visible only if the id is in the enabled set.

<Aside type="caution">
Do not use `useInstalledTools` inside `AdminFeaturesTab`, `AdminAppsTab`, or the store pages. Those surfaces must show every tool regardless of `enabled`, so they read the raw `/api/tools` list directly.
</Aside>

## Notifications

The `notifications` table (`backend/src/db/schema.ts`):

| Column | Notes |
| --- | --- |
| `id` | uuid |
| `user_id` | nullable; **`null` = admin-targeted** (visible to all admins) |
| `type` | `install_request` \| `install_complete` \| `download_complete` \| `system` |
| `payload` | JSON string, defaults to `{}` |
| `read_at` | timestamp, nullable |
| `created_at` | timestamp |

### Visibility rule

`backend/src/routes/notifications.ts` gates rows with `visibleTo(user)`: a user sees their own rows; an **admin additionally** sees the `user_id IS NULL` admin-targeted rows. Without the role gate every user would see (and could mark read) admin install-requests, so this gate is a privacy/integrity boundary, not a convenience.

### Routes

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/notifications` | Latest 50 visible rows + `unreadCount`. |
| `GET` | `/api/notifications/unread-count` | Just the unread count (cheap poll). |
| `PATCH` | `/api/notifications/:id/read` | Mark one read (scoped by `visibleTo`). |
| `POST` | `/api/notifications/read-all` | Mark all visible unread as read. |
| `POST` | `/api/notifications` | **Admin only.** Create a notification of any type; `userId` defaults to `null`. |

### Frontend

`frontend/src/hooks/useNotifications.ts` polls `/unread-count` every 30s and exposes `loadNotifications`, `markRead`, and `markAllRead`. The unread badge and the notifications panel live on the profile area of `frontend/src/components/shell/LeftSidebar.tsx`.

### Who emits what

In the current codebase only two backend paths insert notifications automatically:

- `install_request`: from `POST /api/app-store/request`.
- any type: from the admin-only `POST /api/notifications`.

`install_complete` and `download_complete` are defined in the enum/type and rendered by the UI (icons in `LeftSidebar.tsx`), but no automatic backend flow emits them yet; they are produced via the admin `POST` endpoint. Notably, approving a request in `AdminAppsTab` enables the tool and marks the request read, but does **not** create an `install_complete` notification.

### Admin request inbox

`frontend/src/components/admin/AdminAppsTab.tsx` reads `/api/notifications`, filters to unread `install_request` rows, and renders a "Requests" section. **Approve** does `PUT /api/tools/:id/enabled {enabled:true}` then marks the request read; **Dismiss** just marks it read.

## Home layout

The Home/Today canvas is per-user customizable with an admin-set default and an optional per-user lock. Backend: `backend/src/routes/homeLayout.ts`. Hook: `frontend/src/hooks/useHomeLayout.ts`. The editor is a dnd-kit canvas; widget metadata is registered on the Home page, and the admin default + lock controls live in `AdminAppsTab.tsx`.

### Shape

```ts
interface HomeLayout {
  header: { weather: boolean; jokes: boolean; sports: boolean; locked: boolean }
  canvas: { id: string; cols: { toolId: string; colSpan: 1 | 2 }[] }[]
}
```

### Storage

| Scope | Store | Key |
| --- | --- | --- |
| Per-user layout | `userPreferences` | `home.layout` |
| Per-user lock | `userPreferences` | `home.layout.locked` |
| System default | `appSettings` | `home.layout.default` |

### Routes

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/home-layout` | any user | Resolve the caller's layout (falling back to the system default) plus `locked`. |
| `PUT` | `/api/home-layout` | any user | Save the caller's layout. **403** if their layout is locked. Rejects payloads over 64 KB. |
| `GET` | `/api/home-layout/default` | admin | Read the system default. |
| `PUT` | `/api/home-layout/default` | admin | Write the system default. |
| `GET` | `/api/home-layout/users/:userId` | admin | Read a specific user's layout + lock. |
| `PUT` | `/api/home-layout/users/:userId` | admin | Set a user's layout and/or lock. Validates the user exists first (clean 404 over an FK 500). |

### Legacy migration

On `GET /api/home-layout`, if the user has no `home.layout` yet, the route looks for the legacy `home.highlights` preference and folds its `sports` / `jokes` booleans into the new header (over the system default) before returning. This is a read-time migration, so the legacy key is honored until the user saves a real layout.
