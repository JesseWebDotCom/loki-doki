# Application Structure

## Pages

| Route | Component | Access | Notes |
|---|---|---|---|
| `/` | `HomePage` | authenticated | |
| `/chat/:id?` | `ChatLayout` | authenticated | |
| `/apps` | `AllAppsPage` | authenticated | |
| `/categories` | `CategoriesPage` | authenticated | |
| `/category/:category` | `CategoryPage` | authenticated | |
| `/weather` | `WeatherPage` | authenticated | |
| `/maps` | `MapsPage` | authenticated | |
| `/imaging` | `ImagingPage` | authenticated | prompt → generate → gallery |
| `/video` | `VideoPage` | authenticated | |
| `/read/:sourceId` | `ReaderPage` | authenticated | ZIM iframe page |
| `/links` | `LinksPage` | authenticated | |
| `/links/:id` | `LinkViewPage` | authenticated | iframe page |
| `/companions` | `CompanionsPage` | authenticated | |
| `/bored` | `BoredPage` | authenticated | |
| `/home-inventory` | `HomeInventoryPage` | authenticated | |
| `/docs/user` | `DocsPage entry="user"` | authenticated | Starlight iframe page |
| `/docs/dev` | `DocsPage entry="dev"` | authenticated | Starlight iframe page |
| `/settings/:section?` | `SettingsPage` | authenticated | |
| `/admin/:section?` | `AdminPage` | admin only | |
| `/login` | `ProfilePickerPage` | setup complete | |
| `/setup` | `SetupWizard` | n/a | |

## Iframe Page Pattern

Some pages render backend-served content (ZIM archives, Starlight docs, bookmarked sites) in a full-screen `<iframe>` rather than building a React UI. All three use the same pattern: `AppBreadcrumb` header with back/forward/external buttons, `flex-1 overflow-hidden` container, `<iframe className="h-full w-full border-0">`.

**When adding a new iframe page, complete ALL four steps; missing any one causes a blank or wrong page in dev:**

1. **`App.tsx`**: add `<Route path="/your-path" element={<YourPage />} />` inside `<AuthGuard>`
2. **`appCategories.ts`**: add an `AppItem` with `to: "/your-path"` in the right `APP_GROUPS` entry
3. **`vite.config.ts` proxy**: add `'/your-path': { target: 'http://localhost:3000', changeOrigin: true }` to `server.proxy`. **This is the one that breaks silently**: Vite has no route for non-React paths, so without a proxy it serves the React SPA fallback (the home page) inside the iframe.
4. **`backend/src/index.ts`**: add `app.use('/your-path/*', serveStatic({ root: '../your-dist', rewriteRequestPath: ... }))` **before** the `NODE_ENV !== 'development'` block so it works in both dev and prod.

## Modal Sections (not separate routes)
Opened from the user profile context menu in the left sidebar / nav:

| Section | Access | Notes |
|---|---|---|
| **Settings** | all users | Personal preferences, appearance, notifications |
| **Admin Panel** | admin role only | User management, roles, app config; tabs: Tools, Install, LoRAs |
| **Developer Tools** | admin role only | API keys, feature flags, logs, diagnostics |

Implement as a tabbed modal (`Dialog` or `Sheet`). Admin-only tabs are hidden entirely for non-admin users, not just disabled. The backend enforces access; the frontend hides.

---

# Auth & Profile System

## Flow

1. **Login page** (`/login`): shown when no active session exists
2. **Profile selection**: shown after session established (Netflix-style, see below)
3. **PIN entry**: shown if selected profile has a PIN set
4. **App shell**: normal app, profile context loaded

## Netflix-style Profile Selection Page

- Full-screen dark background, centered grid of profile cards
- Each card: avatar/photo + display name (nickname)
- Up to ~6 profiles per account; overflow scrolls
- "Manage Profiles" link at the bottom (admin only)
- Clicking a card without a PIN → enters app immediately
- Clicking a card with a PIN → slides in a PIN entry overlay (4–6 digit numeric)
- Avatars: sample placeholders for now; avatar system to be added later

## User Schema

```ts
interface User {
  id: string              // UUID
  firstName: string
  lastName: string
  nickname: string        // defaults to firstName on creation
  birthdate: string       // ISO date YYYY-MM-DD
  role: "admin" | "user"
  avatarUrl: string | null
  createdAt: string
  updatedAt: string
}
```

## Database Tables (Drizzle schema targets)

```
users              id, first_name, last_name, nickname, birthdate, role, avatar_url, created_at, updated_at
sessions           id, user_id, token_hash, expires_at, created_at
profile_pins       id, user_id (unique), pin_hash, failed_attempts, locked_until, created_at, updated_at
app_settings       id, key, value (JSON), updated_at
user_preferences   id, user_id, key, value (JSON), updated_at
```

Presence of a row in `profile_pins` signals the profile is PIN-protected. The `profiles` / `users` table has no PIN column.

---

# PIN Security

PINs are profile-level access control (secondary to account auth), not primary credentials.
4–6 digits → ~13–20 bits of entropy. **Three mandatory layers:**

**Layer 1: Hashing: Argon2id**
- Use `Bun.password.hash(pepperedPin, { algorithm: "argon2id", memoryCost: 65536, timeCost: 3 })`
- Built-in to Bun; no additional dependency
- Unique salt is auto-embedded in the PHC output string

**Layer 2: Pepper (required, not optional)**
- HMAC-SHA256 the PIN with `PIN_PEPPER_SECRET` env var before hashing
- Store secret in environment / secrets manager, never in the database
- This defeats offline brute-force of a stolen DB even when the hash search space is small

```ts
import { createHmac } from "node:crypto";

function applyPepper(pin: string): string {
  return createHmac("sha256", Buffer.from(process.env.PIN_PEPPER_SECRET!, "hex"))
    .update(pin)
    .digest("base64");
}

// Hash
const hash = await Bun.password.hash(applyPepper(pin), { algorithm: "argon2id", memoryCost: 65536, timeCost: 3 });

// Verify
const valid = await Bun.password.verify(applyPepper(inputPin), storedHash);
```

**Layer 3: Rate limiting + lockout**
- Lock profile after **5 consecutive failed PIN attempts**
- Exponential backoff: 30s → 2min → 10min → 1hr
- `locked_until` timestamp persisted in `profile_pins` (survives server restarts)
- Rate-limit the PIN endpoint: 10 req/min per session, 20 req/min per IP
- Reset `failed_attempts` on successful verify
- Recovery: account owner re-authenticates to unlock/reset a profile PIN

**What NOT to do:**
- Do not store PINs in plaintext or with fast hashes (SHA-256, MD5, bcrypt alone)
- Do not skip pepper; rate limiting alone does not protect a stolen database
- Do not skip rate limiting; pepper alone does not stop online guessing
- Never return the PIN hash to the client
