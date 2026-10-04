// VERSION is stamped by the server with a hash of the app files. A new hash
// means a new service worker: it caches the new files, takes over, and the page
// shows "Update ready". Writes never pass through here; they go through the
// IndexedDB outbox in app.js.
const VERSION = "__VERSION__";
const SHELL = `shell-${VERSION}`;
const FONTS = ["Barlow-400", "Barlow-500", "Barlow-600", "BarlowSemiCondensed-600", "BarlowSemiCondensed-700"].flatMap((f) => [`/fonts/${f}-latin.woff2`, `/fonts/${f}-latin-ext.woff2`]);
const FILES = ["/", "/index.html", "/app.js", "/app.css", "/fonts/fonts.css", ...FONTS, "/manifest.webmanifest", "/icon.svg", "/icon-180.png", "/icon-512.png"];
self.addEventListener("install", (e) => e.waitUntil(
  caches.open(SHELL).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: "reload" })))).then(() => self.skipWaiting())
));
self.addEventListener("activate", (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== SHELL && k !== "photos").map((k) => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;
  if (u.pathname.startsWith("/photos/")) {
    e.respondWith(caches.open("photos").then(async (c) => (await c.match(e.request)) || fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; })));
    return;
  }
  if (u.pathname.startsWith("/api/") || u.pathname === "/sw.js") return;
  e.respondWith(caches.open(SHELL).then(async (c) => (await c.match(e.request, { ignoreSearch: true })) || (await c.match("/index.html")) || fetch(e.request)));
});
