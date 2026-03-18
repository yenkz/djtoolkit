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
def health():
    db_status = _check_db()
    status_code = 200 if db_status == "ok" else 503
    from fastapi.responses import JSONResponse

    return JSONResponse(
        content={
            "status": "ok" if db_status == "ok" else "degraded",
            "service": "djtoolkit-api",
            "version": "0.1.0",
            "database": db_status,
        },
        status_code=status_code,
    )
