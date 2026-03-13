"""Fire-and-forget audit logging for sensitive API operations.

Usage::

    from djtoolkit.api.audit import audit_log

    await audit_log(
        user_id=user.user_id,
        action="track.import.csv",
        resource_type="track",
        details={"imported": 42},
        ip_address=request.client.host,
    )

Inserts are performed directly via the pool (service role, bypasses RLS).
Failures are logged as warnings and never block the calling request.
"""

from __future__ import annotations

import json
import logging
from typing import Any

log = logging.getLogger(__name__)


async def audit_log(
    user_id: str,
    action: str,
    *,
    resource_type: str | None = None,
    resource_id: str | None = None,
    details: dict[str, Any] | None = None,
    ip_address: str | None = None,
) -> None:
    """Insert an audit log row.  Fire-and-forget — never raises."""
    try:
        from djtoolkit.db.postgres import get_pool

        pool = await get_pool()
        await pool.execute(
            """
            INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details, ip_address)
            VALUES ($1, $2, $3, $4, $5::jsonb, $6)
            """,
            user_id,
            action,
            resource_type,
            resource_id,
            json.dumps(details) if details else None,
            ip_address,
        )
    except Exception:
        log.warning("audit_log failed for action=%s user=%s", action, user_id, exc_info=True)
