// djtoolkit push-only service worker
// No caching strategy — handles push events and notification clicks only.

self.addEventListener("push", (event) => {
  const data = event.data?.json() ?? {};
  event.waitUntil(
    self.registration.showNotification(data.title || "djtoolkit", {
      body: data.body || "",
      icon: "/icon-192.png",
      badge: "/badge-72.png",
      data: { url: data.url || "/pipeline" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/pipeline";
  event.waitUntil(
    clients.matchAll({ type: "window" }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(url) && "focus" in client) {
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
