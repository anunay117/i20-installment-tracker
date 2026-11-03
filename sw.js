const CACHE_NAME = "autopay-shell-v1";
const BASE = "/i20-installment-tracker/";
const SHELL = [BASE, `${BASE}manifest.webmanifest`, `${BASE}assets/icon.svg`];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(Promise.all([
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))),
    self.clients.claim()
  ]));
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || !url.pathname.startsWith(BASE)) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok && (url.pathname === BASE || /\.(?:svg|webmanifest)$/.test(url.pathname))) {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
    }
    return response;
  }).catch(() => caches.match(event.request).then(cached => cached || caches.match(BASE))));
});

self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data?.text() || "Open AutoPay for an update." }; }
  event.waitUntil(self.registration.showNotification(data.title || "AutoPay update", {
    body: data.body || "Open AutoPay to review the latest update.",
    icon: `${BASE}assets/icon.svg`,
    badge: `${BASE}assets/icon.svg`,
    tag: data.tag || "autopay-update",
    renotify: true,
    data: { url: `${BASE}` }
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const destination = new URL(event.notification.data?.url || BASE, self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(clients => {
    const existing = clients.find(client => client.url.startsWith(`${self.location.origin}${BASE}`));
    return existing ? existing.focus() : self.clients.openWindow(destination);
  }));
});
