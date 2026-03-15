/**
 * Fire-and-forget audit logging for sensitive API operations.
 *
 * Usage:
 *
 *   import { auditLog, getClientIp } from "@/lib/api-server/audit";
 *
 *   await auditLog(userId, "track.import.csv", {
 *     resourceType: "track",
 *     details: { imported: 42 },
 *     ipAddress: getClientIp(request),
 *   });
 *
 * Inserts via the service-role Supabase client (bypasses RLS).
 * Failures are swallowed and never block the calling request.
 */

import { createServiceClient } from "@/lib/supabase/service";

export interface AuditLogOptions {
  resourceType?: string;
  resourceId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string | null;
}

/**
 * Insert an audit log row. Fire-and-forget — never throws.
 */
export async function auditLog(
  userId: string,
  action: string,
  opts: AuditLogOptions = {}
): Promise<void> {
  try {
    const supabase = createServiceClient();
    const { error } = await supabase.from("audit_logs").insert({
      user_id: userId,
      action,
      resource_type: opts.resourceType ?? null,
      resource_id: opts.resourceId ?? null,
      details: opts.details ?? null,
      ip_address: opts.ipAddress ?? null,
    });
    if (error) {
      console.warn(
        `audit_log failed for action=${action} user=${userId}:`,
        error.message
      );
    }
  } catch (err) {
    console.warn(
      `audit_log threw for action=${action} user=${userId}:`,
      err
    );
  }
}

/**
 * Extract the client IP address from incoming request headers.
 * Respects x-forwarded-for (Vercel/proxy) and x-real-ip, falling back to null.
 */
export function getClientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    // x-forwarded-for may be a comma-separated list; first entry is the client
    return forwarded.split(",")[0].trim();
  }
  return request.headers.get("x-real-ip");
}
