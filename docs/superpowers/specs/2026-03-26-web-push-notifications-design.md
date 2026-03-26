# Web Push Pipeline Notifications

**Date:** 2026-03-26
**Status:** Approved

## Goal

Notify users when their pipeline batch completes or a track fails, even when the browser tab is closed. Includes an in-app notification history accessible from any page.

## Notification Types

| Type | Trigger | Title example | Body example |
|------|---------|---------------|--------------|
| `batch_complete` | All active pipeline jobs for a user finish (zero pending/claimed/running) | "Pipeline complete" | "12 tracks processed (11 succeeded, 1 failed)" |
| `track_failed` | A pipeline job fails (any job type) | "Track failed" | "Artist - Title: download failed after 3 retries" |

## Architecture

### Data Flow

```
pipeline_jobs UPDATE (status → done/failed)
  → chain_pipeline_job trigger (existing, extended)
    → Count remaining active jobs for user
    → If zero remaining: INSERT batch_complete into push_notifications
    → If job failed: INSERT track_failed into push_notifications

push_notifications INSERT
  → Supabase database webhook → Edge Function "push-send"
    → Read user's push_subscriptions
    → Send Web Push via VAPID to each subscription endpoint
    → Mark notification sent = true
    → Delete invalid subscriptions (410 Gone)

Browser service worker receives push event
  → Show system notification (title, body, icon, click URL)

Notification history UI (bell dropdown)
  → Supabase Realtime subscription on push_notifications
  → New notifications appear instantly
```

### Components

#### 1. Database: `push_subscriptions` table

Stores Web Push endpoints. One user can have multiple subscriptions (multiple browsers/devices).

```sql
CREATE TABLE push_subscriptions (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint   TEXT NOT NULL UNIQUE,
    keys_p256dh TEXT NOT NULL,
    keys_auth  TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(user_id);
```

RLS: user can only read/write their own subscriptions.

#### 2. Database: `push_notifications` table

Outbound notification queue and history.

```sql
CREATE TABLE push_notifications (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type       TEXT NOT NULL CHECK (type IN ('batch_complete', 'track_failed')),
    title      TEXT NOT NULL,
    body       TEXT NOT NULL,
    url        TEXT,          -- click target (e.g., /pipeline)
    data       JSONB,         -- extra context (track_id, counts, etc.)
    read       BOOLEAN DEFAULT FALSE,
    sent       BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_push_notifications_user ON push_notifications(user_id, created_at DESC);
CREATE INDEX idx_push_notifications_unsent ON push_notifications(user_id) WHERE sent = FALSE;
```

RLS: user can SELECT and UPDATE (read flag only) their own notifications. INSERT via service role / trigger only.

#### 3. Trigger extension: `chain_pipeline_job()`

Add to the existing trigger function, after the current chaining logic:

**Batch complete detection:**
```sql
-- After processing done/failed job, check if pipeline is idle
IF NEW.status IN ('done', 'failed') THEN
    SELECT count(*) INTO _active_count
    FROM pipeline_jobs
    WHERE user_id = NEW.user_id
      AND status IN ('pending', 'claimed', 'running');

    IF _active_count = 0 THEN
        -- Count results for summary
        SELECT
            count(*) FILTER (WHERE status = 'done'),
            count(*) FILTER (WHERE status = 'failed')
        INTO _done_count, _failed_count
        FROM pipeline_jobs
        WHERE user_id = NEW.user_id
          AND completed_at > NOW() - INTERVAL '24 hours';

        INSERT INTO push_notifications (user_id, type, title, body, url, data)
        VALUES (
            NEW.user_id,
            'batch_complete',
            'Pipeline complete',
            _done_count || ' tracks processed (' ||
                _done_count || ' succeeded, ' || _failed_count || ' failed)',
            '/pipeline',
            jsonb_build_object('done', _done_count, 'failed', _failed_count)
        );
    END IF;
END IF;
```

**Track failed detection:**
```sql
IF NEW.status = 'failed' THEN
    SELECT title, artist INTO _title, _artist
    FROM tracks WHERE id = NEW.track_id;

    INSERT INTO push_notifications (user_id, type, title, body, url, data)
    VALUES (
        NEW.user_id,
        'track_failed',
        'Track failed',
        coalesce(_artist, 'Unknown') || ' - ' || coalesce(_title, 'Unknown') ||
            ': ' || NEW.job_type || ' failed',
        '/pipeline',
        jsonb_build_object('track_id', NEW.track_id, 'job_type', NEW.job_type,
                           'error', NEW.error)
    );
END IF;
```

**Debounce guard:** The batch_complete check naturally debounces because it only fires when `_active_count = 0`. Rapid successive job completions won't produce duplicate notifications because intermediate completions still have remaining active jobs. No additional dedup needed.

#### 4. Edge Function: `push-send`

Triggered by a Supabase database webhook on `push_notifications` INSERT.

```
supabase/functions/push-send/index.ts
```

Responsibilities:
- Read the inserted notification row
- Fetch all `push_subscriptions` for that `user_id`
- For each subscription: send Web Push using VAPID credentials
- On success: mark `sent = true`
- On 410 Gone (expired subscription): delete the subscription row
- On other errors: log and continue (don't block other subscriptions)

Dependencies: Uses `web-push` via Deno npm compat (`import webpush from "npm:web-push"`). VAPID keys from env vars: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.

#### 5. Service Worker: `web/public/sw.js`

Minimal service worker handling push events and notification clicks.

```javascript
self.addEventListener('push', (event) => {
    const data = event.data?.json() ?? {};
    event.waitUntil(
        self.registration.showNotification(data.title || 'djtoolkit', {
            body: data.body || '',
            icon: '/icon-192.png',
            badge: '/badge-72.png',
            data: { url: data.url || '/pipeline' },
        })
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = event.notification.data?.url || '/pipeline';
    event.waitUntil(
        clients.matchAll({ type: 'window' }).then((windowClients) => {
            // Focus existing tab if open, otherwise open new
            for (const client of windowClients) {
                if (client.url.includes(url) && 'focus' in client) {
                    return client.focus();
                }
            }
            return clients.openWindow(url);
        })
    );
});
```

No caching strategy — this service worker is push-only. No offline support needed.

#### 6. Client Library: `web/lib/push-notifications.ts`

Handles service worker registration and push subscription management.

**Exports:**
- `registerServiceWorker()` — registers `/sw.js`, called once on app load
- `subscribeToPush(userId)` — requests notification permission, creates PushSubscription, POSTs to `/api/push/subscribe`
- `unsubscribeFromPush()` — unsubscribes and DELETEs via `/api/push/unsubscribe`
- `isPushSupported()` — feature detection (`'serviceWorker' in navigator && 'PushManager' in window`)
- `getPushPermission()` — returns current `Notification.permission` state

#### 7. API Routes

**`POST /api/push/subscribe`**
- Auth: requires authenticated user (Supabase JWT)
- Body: `{ endpoint, keys: { p256dh, auth } }`
- Upserts into `push_subscriptions` (ON CONFLICT endpoint DO UPDATE)
- Returns 201

**`DELETE /api/push/unsubscribe`**
- Auth: requires authenticated user
- Body: `{ endpoint }`
- Deletes matching row from `push_subscriptions`
- Returns 204

**`GET /api/notifications`**
- Auth: requires authenticated user
- Query params: `limit` (default 20, max 50)
- Returns notifications ordered by `created_at DESC`

**`PATCH /api/notifications/read`**
- Auth: requires authenticated user
- Body: `{ id }` (single notification) or `{ all: true }` (mark all as read)
- Updates `read = true`
- Returns 204

#### 8. Notification History UI: Bell Icon Dropdown

**Location:** Top navigation bar, visible on all authenticated pages.

**Component:** `web/components/notification-bell.tsx`

**Behavior:**
- Bell icon with unread count badge (red dot + number if > 0)
- Click opens dropdown panel (max-height scrollable)
- Shows last 20 notifications, newest first
- Each notification row:
  - Icon: green checkmark (batch_complete) or red X (track_failed)
  - Title (bold) + body (muted text)
  - Relative timestamp ("2m ago", "1h ago")
  - Unread indicator (blue dot on left edge)
- Click notification: navigate to `url` field (e.g., `/pipeline`), mark as read
- "Mark all as read" button at top of dropdown
- Empty state: "No notifications yet"

**Data source:**
- Initial load: `GET /api/notifications?limit=20`
- Real-time updates: Supabase Realtime subscription on `push_notifications` table filtered by `user_id`
- New notification INSERT → prepend to list, increment unread badge

**Unread count:** Derived client-side from notifications where `read = false`. No separate counter needed.

#### 9. Settings: Notification Toggle

**Location:** Settings page, new "Notifications" section.

**Controls:**
- "Enable push notifications" toggle
  - When toggled ON: calls `subscribeToPush()`, which triggers browser permission prompt
  - When toggled OFF: calls `unsubscribeFromPush()`
  - Disabled with tooltip if `!isPushSupported()` ("Your browser doesn't support push notifications")
  - If browser permission is `denied`: toggle disabled with message "Notifications blocked by your browser. Allow notifications in browser settings to enable."
- State stored in `user_settings` JSONB under key `push_notifications_enabled`

No per-type toggle (batch_complete vs track_failed) — both are always on when push is enabled. This avoids overcomplicating the UI for two notification types.

## Environment Variables

Add to `.env.local.example` and Vercel project settings:

```
# Web Push (VAPID)
NEXT_PUBLIC_VAPID_PUBLIC_KEY=    # generated via web-push generate-vapid-keys
VAPID_PRIVATE_KEY=               # server-side only
VAPID_SUBJECT=mailto:push@djtoolkit.net
```

The same `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` must be set as secrets in the Supabase Edge Function environment.

## NPM Dependencies

- `web-push` — added to `web/package.json` (only used server-side in API routes, but also needed by Edge Function as a Deno import)

## Migration

Single migration file creates both tables, extends the trigger, and sets up the database webhook.

## Out of Scope

- Email notifications
- Webhook/Slack/Discord integration
- Per-track completion notifications (only batch complete + failures)
- Offline caching / PWA features (service worker is push-only)
- Notification preferences per type (both types always enabled when push is on)