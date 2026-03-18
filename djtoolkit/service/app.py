"""FastAPI application factory."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from djtoolkit.service.config import get_settings
from djtoolkit.service.routes.health import router as health_router
from djtoolkit.service.routes.import_collection import router as import_router
from djtoolkit.service.routes.export_collection import router as export_router


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
        allow_credentials=True,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )

    app.include_router(health_router)
    app.include_router(import_router)
    app.include_router(export_router)

    return app
