// Cherub's OS service worker: works offline + receives push notifications.
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyA-wcFxUbduNHkxC2T63uk17_0fk4NLCzA",
  authDomain: "cherubs-61a33.firebaseapp.com",
  projectId: "cherubs-61a33",
  storageBucket: "cherubs-61a33.firebasestorage.app",
  messagingSenderId: "177104720359",
  appId: "1:177104720359:web:ee06a1e2281c7487f56d42"
});
// Notifications sent with a "notification" payload are shown automatically.
firebase.messaging();

const CACHE = 'cherub-v3';
const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';
const SHELL = ['./', 'index.html', 'manifest.json', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png',
  FB + 'firebase-app-compat.js', FB + 'firebase-auth-compat.js', FB + 'firebase-firestore-compat.js', FB + 'firebase-messaging-compat.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.allSettled(SHELL.map(u => c.add(u)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Never cache the database or sign-in traffic.
  if (/firestore\.googleapis|identitytoolkit|securetoken|fcmregistrations|firebaseinstallations|googleapis\.com\/v1/.test(url.href)) return;
  const appPage = req.mode === 'navigate' || url.pathname.endsWith('/index.html');
  if (appPage) {
    // Network first so updates arrive; fall back to the saved copy when offline.
    e.respondWith(fetch(req).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put('index.html', c)); return r; })
      .catch(() => caches.match('index.html').then(r => r || caches.match('./'))));
    return;
  }
  // Everything else: saved copy first, refresh in the background.
  e.respondWith(caches.match(req).then(hit => {
    const net = fetch(req).then(r => { if (r && (r.ok || r.type === 'opaque')) { const c = r.clone(); caches.open(CACHE).then(x => x.put(req, c)); } return r; }).catch(() => hit);
    return hit || net;
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow('./');
  }));
});
