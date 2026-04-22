---
paths:
  - "frontend/**/*.{ts,tsx,js,jsx,css}"
  - "frontend/index.html"
  - "frontend/public/**/*"
---

# Frontend Rules

- Use shadcn/ui primitives and keep the Onyx Material direction intact.
- Preserve the existing visual language unless the task explicitly asks for a redesign.
- Do not use `window.confirm`, `window.alert`, or `window.prompt`; use dialog components instead.
- Keep the frontend offline-first. No CDN assets, remote fonts, or runtime network fetches for required UI assets.
- When fixing UI behavior, compare against a nearby working component in the same subsystem before inventing a new interaction pattern.
- Keep mobile and desktop behavior both working after layout changes.
