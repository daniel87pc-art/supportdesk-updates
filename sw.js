// The app works without internet too: its files are kept on the phone. A new version (a different VERSION here,
// written by publish.py) is installed in the background and the app offers to refresh.
const VERSION = '3.52-4c6a1121';
const CACHE = 'supportdesk-' + VERSION;
const FILES = ['./', 'index.html', 'app.js', 'sdcrypto.js', 'config.js', 'manifest.json', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', e => {
  // straight from the server (not the browser's own short-term copy - it could still hold the previous version)
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(FILES.map(f =>
    fetch(new Request(f, { cache: 'reload' })).then(r => { if (!r.ok) throw new Error(f); return c.put(f, r); })))));
  self.skipWaiting();                                // the new version takes over at once (the app reloads)
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('supportdesk-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('message', e => { if (e.data === 'skip') self.skipWaiting(); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;     // Google Drive etc.: always online
  if (u.pathname.endsWith('/config.js')) {          // the settings of the published version: fresh when online
    e.respondWith(fetch(e.request, { cache: 'no-store' }).catch(() => caches.match(e.request, { ignoreSearch: true })));
    return;
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(r => r || fetch(e.request)));
});
