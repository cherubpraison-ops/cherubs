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
// Action buttons on notifications (Visited / Cancelled). Registered before Firebase's handler.
self.addEventListener('notificationclick', e => {
  if (e.action !== 'done' && e.action !== 'skip') return;
  e.stopImmediatePropagation();
  e.notification.close();
  const n = e.notification.data || {}, d = (n.FCM_MSG && n.FCM_MSG.data) || n;
  const msg = { cherubDo: e.action, sid: d.sid, c: d.c, d: d.d };
  const url = './?do=' + e.action + '&sid=' + encodeURIComponent(d.sid || '') + '&c=' + encodeURIComponent(d.c || '') + '&d=' + encodeURIComponent(d.d || '');
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const w = list[0];
    if (w) { w.postMessage(msg); return w.focus ? w.focus() : null; }
    return self.clients.openWindow(url);
  }));
});
// Notifications sent with a "notification" payload are shown automatically.
firebase.messaging();

const CACHE = 'cherub-v20';
const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';
const SHELL = ['./', 'index.html', 'assessment.html', 'pay.html', 'manifest.json', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png',
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
  if (url.pathname.endsWith('/pay.html')) { e.respondWith(fetch(req).catch(() => caches.match('pay.html'))); return; }
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
  const nd = e.notification.data || {};
  if (nd.FCM_MSG) return; // Firebase opens the link for pushed notifications
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow('./');
  }));
});
