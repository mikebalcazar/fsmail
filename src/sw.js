/* Service worker de FSMAIL: sólo notificaciones push. No cachea nada. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { titulo: 'FSMAIL', cuerpo: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.titulo || 'FSMAIL', {
    body: d.cuerpo || '', tag: d.id || undefined, renotify: !!d.id, icon: '/icono-192.png', badge: '/badge-96.png',
    data: { url: d.url || '/' }, timestamp: d.cuando ? Date.parse(d.cuando) : Date.now(),
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ventanas) => {
    for (const v of ventanas) {
      if (new URL(v.url).origin === self.location.origin) { v.focus(); v.postMessage({ fsmail: 'abrir', url }); return; }
    }
    return self.clients.openWindow(url);
  }));
});
