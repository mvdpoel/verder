self.addEventListener("push", (e) => {
  const d = e.data.json();
  e.waitUntil(self.registration.showNotification(d.title, { body: d.body }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(clients.openWindow("/queue"));
});
