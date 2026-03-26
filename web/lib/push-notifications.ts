/**
 * Client-side push notification helpers.
 *
 * Handles service worker registration, push subscription lifecycle,
 * and communication with the /api/push/* endpoints.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a base64url-encoded VAPID public key to a Uint8Array
 * suitable for PushManager.subscribe({ applicationServerKey }).
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

// ---------------------------------------------------------------------------
// Feature detection
// ---------------------------------------------------------------------------

/** Returns true when the browser supports service workers and push. */
export function isPushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window;
}

/** Returns the current Notification permission state. */
export function getPushPermission(): NotificationPermission {
  return Notification.permission;
}

// ---------------------------------------------------------------------------
// Service worker registration
// ---------------------------------------------------------------------------

/** Register the push-only service worker at /sw.js. */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register("/sw.js");
}

// ---------------------------------------------------------------------------
// Subscribe / unsubscribe
// ---------------------------------------------------------------------------

/**
 * Request notification permission, create a PushSubscription, and POST
 * the subscription details to /api/push/subscribe.
 *
 * Returns the PushSubscription on success, or null if the user denied
 * permission or the subscription could not be created.
 */
export async function subscribeToPush(): Promise<PushSubscription | null> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return null;
  }

  const registration = await navigator.serviceWorker.ready;

  const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!vapidPublicKey) {
    console.error("NEXT_PUBLIC_VAPID_PUBLIC_KEY is not set");
    return null;
  }

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey).buffer as ArrayBuffer,
  });

  // Use dynamic import to avoid circular dependency at module scope
  const { apiClient } = await import("./api");
  const json = subscription.toJSON();
  const res = await apiClient("/push/subscribe", {
    method: "POST",
    body: JSON.stringify({
      endpoint: json.endpoint,
      keys: {
        p256dh: json.keys?.p256dh,
        auth: json.keys?.auth,
      },
    }),
  });

  if (!res.ok) {
    console.error("Failed to save push subscription:", res.status);
    await subscription.unsubscribe();
    return null;
  }

  return subscription;
}

/**
 * Unsubscribe from push notifications and notify the server so it can
 * remove the stored subscription.
 *
 * Returns true if the unsubscribe succeeded (or there was nothing to
 * unsubscribe), false on error.
 */
export async function unsubscribeFromPush(): Promise<boolean> {
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();

  if (!subscription) {
    return true;
  }

  const endpoint = subscription.endpoint;
  const ok = await subscription.unsubscribe();

  if (!ok) {
    return false;
  }

  const { apiClient } = await import("./api");
  await apiClient("/push/unsubscribe", {
    method: "DELETE",
    body: JSON.stringify({ endpoint }),
  });

  return true;
}
