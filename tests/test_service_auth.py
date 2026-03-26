import pytest
from unittest.mock import MagicMock, patch
from fastapi import FastAPI, Depends
from fastapi.testclient import TestClient

from djtoolkit.service.auth import get_current_user


@pytest.fixture
def app():
    app = FastAPI()

    @app.get("/test")
    async def test_route(user_id: str = Depends(get_current_user)):
        return {"user_id": user_id}

    return app


@pytest.fixture
def client(app):
    return TestClient(app)


def test_missing_auth_header(client):
    resp = client.get("/test")
    assert resp.status_code == 401
    assert "Authorization" in resp.json()["detail"]


def test_invalid_scheme(client):
    resp = client.get("/test", headers={"Authorization": "Basic abc"})
    assert resp.status_code == 401


def test_valid_jwt(client):
    mock_user = MagicMock()
    mock_user.id = "user-123"
    mock_response = MagicMock()
    mock_response.user = mock_user

    with patch("djtoolkit.service.auth._get_supabase_client") as mock_client:
        mock_client.return_value.auth.get_user.return_value = mock_response
        resp = client.get(
            "/test", headers={"Authorization": "Bearer valid.jwt.token"}
        )
        assert resp.status_code == 200
        assert resp.json()["user_id"] == "user-123"


def test_invalid_jwt(client):
    mock_response = MagicMock()
    mock_response.user = None

    with patch("djtoolkit.service.auth._get_supabase_client") as mock_client:
        mock_client.return_value.auth.get_user.return_value = mock_response
        resp = client.get(
            "/test", headers={"Authorization": "Bearer bad.jwt.token"}
        )
        assert resp.status_code == 401
