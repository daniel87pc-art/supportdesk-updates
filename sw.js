// The app works without internet too: its files are kept on the phone. A new version (a different VERSION here,
// written by publish.py) is installed in the background and the app offers to refresh.
const VERSION = '3.48-8b37970d';
const CACHE = 'supportdesk-' + VERSION;
const FILES = ['./', 'index.html', 'app.js', 'sdcrypto.js', 'config.js', 'manifest.json', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('supportdesk-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('message', e => { if (e.data === 'skip') self.skipWaiting(); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;     // Google Drive etc.: always online
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(r => r || fetch(e.request)));
});
