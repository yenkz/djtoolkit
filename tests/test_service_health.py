import pytest
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient

from djtoolkit.service.app import create_app


@pytest.fixture
def client():
    app = create_app()
    return TestClient(app)


def test_health_ok(client):
    with patch("djtoolkit.service.routes.health._check_db", return_value="ok"):
        resp = client.get("/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert body["database"] == "ok"
        assert "version" in body


def test_health_db_down(client):
    with patch("djtoolkit.service.routes.health._check_db", return_value="error"):
        resp = client.get("/health")
        assert resp.status_code == 503
        body = resp.json()
        assert body["status"] == "degraded"
        assert body["database"] == "error"


def test_cors_headers(client):
    resp = client.options(
        "/health",
        headers={
            "Origin": "https://djtoolkit.net",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert "access-control-allow-origin" in resp.headers
