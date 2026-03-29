"""FastAPI application factory."""

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from djtoolkit.service.config import get_settings
from djtoolkit.service.routes.health import router as health_router
from djtoolkit.service.routes.import_collection import router as import_router
from djtoolkit.service.routes.export_collection import router as export_router
from djtoolkit.service.routes.trackid import router as trackid_router

VERCEL_ORIGIN_REGEX = r"https://djtoolkit(-[a-z0-9]+)?-yenkzs-projects\.vercel\.app"


def create_app() -> FastAPI:
    settings = get_settings()

    app = FastAPI(
        title="djtoolkit API",
        version="0.1.0",
        docs_url="/docs",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_origin_regex=VERCEL_ORIGIN_REGEX,
        allow_credentials=True,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception):
        """Catch-all so unhandled errors still get CORS headers
        (CORSMiddleware wraps the response, but only if one is returned)."""
        return JSONResponse(
            status_code=500,
            content={"detail": f"Internal server error: {exc}"},
        )

    @app.on_event("startup")
    async def reset_stuck_jobs():
        """Reset any jobs left in 'analyzing' state from a previous container."""
        try:
            from djtoolkit.db.supabase_client import get_client
            client = get_client()
            result = client.table("trackid_import_jobs").update({
                "status": "failed",
                "error": "Interrupted by server restart. Please retry.",
                "step": "Interrupted",
            }).eq("status", "analyzing").execute()
            if result.data:
                print(f"[startup] Reset {len(result.data)} stuck analyzing jobs", flush=True)
        except Exception as e:
            print(f"[startup] Failed to reset stuck jobs: {e}", flush=True)

    app.include_router(health_router)
    app.include_router(import_router)
    app.include_router(export_router)
    app.include_router(trackid_router)

    return app
