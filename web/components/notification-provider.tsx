"use client";

import { useEffect } from "react";
import { isPushSupported, registerServiceWorker } from "@/lib/push-notifications";

/**
 * Registers the push service worker on mount.
 * Renders nothing — drop this anywhere inside the authenticated layout.
 */
export default function NotificationProvider() {
  useEffect(() => {
    if (isPushSupported()) {
      registerServiceWorker().catch(() => {});
    }
  }, []);

  return null;
}
