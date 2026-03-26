/**
 * push-send — Supabase Edge Function (Deno runtime)
 *
 * Triggered by a Supabase database webhook on `push_notifications` INSERT.
 *
 * Receives the webhook payload containing the inserted row, then:
 *   1. Extracts user_id, title, body, url, data from the notification record
 *   2. Fetches all push_subscriptions for that user_id
 *   3. Sends a Web Push notification to each subscription using VAPID
 *   4. Marks the notification as sent = true
 *   5. Deletes expired subscriptions (410 Gone, 404, 403)
 *   6. Logs errors per subscription without failing the whole batch
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push";

// ─── Types ──────────────────────────────────────────────────────────────────

interface PushSubscriptionRow {
  id: string;
  user_id: string;
  endpoint: string;
  keys_p256dh: string;
  keys_auth: string;
}

interface NotificationRecord {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string;
  url: string | null;
  data: Record<string, unknown> | null;
}

interface WebhookPayload {
  type: "INSERT";
  table: string;
  schema: string;
  record: NotificationRecord;
  old_record: null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getSupabaseClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

function configureVapid(): void {
  const publicKey = Deno.env.get("VAPID_PUBLIC_KEY");
  const privateKey = Deno.env.get("VAPID_PRIVATE_KEY");
  const subject = Deno.env.get("VAPID_SUBJECT");

  if (!publicKey || !privateKey || !subject) {
    throw new Error(
      "Missing VAPID env vars: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT",
    );
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);
}

/** HTTP status codes that indicate the subscription is no longer valid. */
const GONE_STATUS_CODES = new Set([404, 403, 410]);

// ─── Main processing ───────────────────────────────────────────────────────

async function processNotification(
  notification: NotificationRecord,
): Promise<void> {
  const supabase = getSupabaseClient();
  configureVapid();

  const { user_id, id: notification_id, title, body, url, data } =
    notification;

  // ── Fetch all push subscriptions for the user ────────────────────────────

  const { data: subscriptions, error: fetchErr } = await supabase
    .from("push_subscriptions")
    .select("id, user_id, endpoint, keys_p256dh, keys_auth")
    .eq("user_id", user_id);

  if (fetchErr) {
    console.error(
      `[push-send] Failed to fetch subscriptions for user ${user_id}:`,
      fetchErr.message,
    );
    return;
  }

  const subs = (subscriptions ?? []) as PushSubscriptionRow[];

  if (subs.length === 0) {
    console.log(
      `[push-send] No subscriptions for user ${user_id}, marking notification ${notification_id} as sent`,
    );
    await supabase
      .from("push_notifications")
      .update({ sent: true })
      .eq("id", notification_id);
    return;
  }

  // ── Build the push payload ───────────────────────────────────────────────

  const payload = JSON.stringify({ title, body, url, data });

  // ── Send to each subscription ────────────────────────────────────────────

  let successCount = 0;

  for (const sub of subs) {
    const pushSubscription = {
      endpoint: sub.endpoint,
      keys: {
        p256dh: sub.keys_p256dh,
        auth: sub.keys_auth,
      },
    };

    try {
      await webpush.sendNotification(pushSubscription, payload);
      successCount++;
    } catch (err: unknown) {
      const statusCode =
        err && typeof err === "object" && "statusCode" in err
          ? (err as { statusCode: number }).statusCode
          : null;

      if (statusCode !== null && GONE_STATUS_CODES.has(statusCode)) {
        console.log(
          `[push-send] Subscription ${sub.id} returned ${statusCode}, deleting`,
        );
        const { error: deleteErr } = await supabase
          .from("push_subscriptions")
          .delete()
          .eq("id", sub.id);

        if (deleteErr) {
          console.error(
            `[push-send] Failed to delete subscription ${sub.id}:`,
            deleteErr.message,
          );
        }
      } else {
        console.error(
          `[push-send] Failed to send to subscription ${sub.id}:`,
          err,
        );
      }
    }
  }

  // ── Mark notification as sent ────────────────────────────────────────────

  const { error: updateErr } = await supabase
    .from("push_notifications")
    .update({ sent: true })
    .eq("id", notification_id);

  if (updateErr) {
    console.error(
      `[push-send] Failed to mark notification ${notification_id} as sent:`,
      updateErr.message,
    );
  }

  console.log(
    `[push-send] Notification ${notification_id} sent to ${successCount}/${subs.length} subscriptions`,
  );
}

// ─── Handler ────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  try {
    const webhookPayload: WebhookPayload = await req.json();
    const notification = webhookPayload.record;

    if (!notification || !notification.id || !notification.user_id) {
      return new Response(
        JSON.stringify({ error: "Invalid webhook payload: missing record" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // Process in the background so we respond immediately
    // deno-lint-ignore no-explicit-any
    (globalThis as any).EdgeRuntime.waitUntil(
      processNotification(notification),
    );

    return new Response(
      JSON.stringify({ ok: true, notification_id: notification.id }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[push-send] Handler error:", err);
    return new Response(
      JSON.stringify({ error: "Failed to process webhook" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
