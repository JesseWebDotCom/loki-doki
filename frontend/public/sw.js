// Real service worker: runtime caching (stale-while-revalidate) so the app shell and a
// few key API responses survive a cold open on flaky Wi-Fi, plus Web Push display.
//
// No build-time precache manifest (that needs a bundler plugin — out of scope here):
// assets are cached as they're actually fetched, so this only helps once a page has
// been visited at least once online, not a true install-then-works-offline guarantee.
//
// CACHE_VERSION bump = every prior cache is dropped on activate. Bump this whenever the
// caching strategy itself changes (not on every app deploy — content stays fresh via
// stale-while-revalidate's background refetch).
// v2: the app shell (index.html / navigations) is now NETWORK-FIRST, not stale-while-
// revalidate. The old strategy served the cached index.html — which references the PREVIOUS
// build's hashed JS/CSS — so new deploys never took effect until several reloads (and a
// mid-deploy broken bundle could get stuck in cache). Content-hashed assets stay cache-first
// (their filenames change when content changes, so a cache hit is always correct).
const CACHE_VERSION = "v2";
const CACHE_NAME = `lokidoki-${CACHE_VERSION}`;

// API GETs worth serving stale-while-revalidate — small, frequently-polled, and useful
// the instant the app opens even before the network responds.
const CACHEABLE_API_PATHS = ["/api/briefing", "/api/home-layout"];

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isCacheableAsset(url) {
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith("/api/")) return CACHEABLE_API_PATHS.some((p) => url.pathname.startsWith(p));
  // Vite-built, content-hashed JS/CSS/font/image assets (immutable — filename changes with content).
  return /\.(js|css|woff2?|ttf|png|jpg|jpeg|svg|webp)$/.test(url.pathname);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // never cache mutations

  const url = new URL(req.url);

  // App shell: NETWORK-FIRST. Always try the live index.html so a new deploy's hashed chunk
  // references load immediately; fall back to the cached shell only when offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) caches.open(CACHE_NAME).then((c) => c.put("/", res.clone()));
          return res;
        })
        .catch(() => caches.open(CACHE_NAME).then((c) => c.match("/")).then((r) => r || Response.error()))
    );
    return;
  }

  if (!isCacheableAsset(url)) return; // everything else hits the network normally

  const isApi = url.pathname.startsWith("/api/");
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(req);
      // Hashed assets are immutable → cache-first (fast). API GETs → stale-while-revalidate.
      if (cached && !isApi) return cached;
      const network = fetch(req)
        .then((res) => { if (res.ok) cache.put(req, res.clone()); return res; })
        .catch(() => cached);
      return isApi ? (cached ?? network) : network;
    })
  );
});

self.addEventListener("push", (event) => {
  let payload = { title: "Loki Doki" };
  try { if (event.data) payload = { ...payload, ...event.data.json() }; } catch { /* not JSON */ }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: payload.url || "/" },
      // Urgent alerts (security cameras) stay on screen until dismissed.
      requireInteraction: payload.priority === "urgent",
      tag: payload.tag || undefined,
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data && event.notification.data.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(url) && "focus" in client) return client.focus();
      }
      const existing = clients.find((c) => "focus" in c);
      if (existing) { existing.focus(); return existing.navigate(url); }
      return self.clients.openWindow(url);
    })
  );
});
