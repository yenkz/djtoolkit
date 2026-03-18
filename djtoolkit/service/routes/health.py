"""Health check endpoint."""

from fastapi import APIRouter

router = APIRouter()


def _check_db() -> str:
    """Ping Supabase with a lightweight query. Returns 'ok' or 'error'."""
    try:
        from djtoolkit.db.supabase_client import get_client

        get_client().table("tracks").select("id").limit(1).execute()
        return "ok"
    except Exception:
        return "error"


@router.get("/health")
async def health():
    db_status = _check_db()
    return {
        "status": "ok" if db_status == "ok" else "degraded",
        "service": "djtoolkit-api",
        "version": "0.1.0",
        "database": db_status,
    }
