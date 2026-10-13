// Service Worker for Space Connect PWA — offline-first app shell.
//
// Goals:
// - The app OPENS offline (web + installed PWA): navigations fall back to the
//   cached app shell instead of the browser's "no internet" page.
// - Hashed JS/CSS assets keep working across deploys (stale-while-revalidate).
// - Chat DATA offline is handled by the app's localStorage snapshot (see
//   heymama.ts); the SW never caches Supabase API responses.

const CACHE_NAME = "space-connect-v2";
const SHELL_URL = "/";
const PRECACHE_URLS = ["/", "/manifest.json", "/heymama.jpeg", "/favicon.ico"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // Cache each shell file independently: one failure (e.g. offline during
      // install) must not abort the whole install.
      await Promise.all(
        PRECACHE_URLS.map(async (url) => {
          try {
            await cache.add(url);
          } catch {
            /* best-effort — runtime caching fills gaps later */
          }
        }),
      );
    })(),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) return caches.delete(key);
          return undefined;
        }),
      );
      await self.clients.claim();
    })(),
  );
});

// Let the page trigger immediate activation after an update.
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

function isSupabaseRequest(url) {
  return (
    url.includes("/rest/v1") ||
    url.includes("/auth/v1") ||
    url.includes("/realtime/v1") ||
    url.includes("/storage/v1") ||
    url.includes("supabase.co")
  );
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  // Only handle same-origin http(s). Supabase RPC/storage/realtime always
  // hits the network (and fails offline, where the app shows saved data).
  if (url.origin !== self.location.origin) return;
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  if (isSupabaseRequest(request.url)) return;

  // Navigations (/, /?space=CODE, deep links): network-first, then cached
  // page, then the cached app shell — so the app always opens offline.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          if (cached) return cached;
          const shell = await caches.match(SHELL_URL);
          if (shell) return shell;
          return new Response("Offline — reconnect to load Space Connect.", {
            status: 503,
            headers: { "Content-Type": "text/plain" },
          });
        }),
    );
    return;
  }

  // Static assets (hashed JS/CSS/images/fonts): stale-while-revalidate so a
  // previously visited version keeps rendering offline after a new deploy.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => undefined);
      // Return cache immediately; update it in the background.
      if (cached) return cached;
      return network.then(
        (response) =>
          response ||
          new Response("Offline", {
            status: 503,
            headers: { "Content-Type": "text/plain" },
          }),
      );
    }),
  );
});
