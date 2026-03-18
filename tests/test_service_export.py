import pytest
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient

from djtoolkit.service.app import create_app
from djtoolkit.models.track import Track


@pytest.fixture
def client():
    app = create_app()
    return TestClient(app)


@pytest.fixture
def auth_headers():
    return {"Authorization": "Bearer valid.jwt.token"}


def _sample_tracks():
    return [
        Track(title="Test Track", artist="DJ Test", bpm=128.0, key="C minor", camelot="5A"),
        Track(title="Another", artist="Producer", bpm=130.0, key="A minor", camelot="8A"),
    ]


def _patch_auth():
    """Return a patch that makes auth return user-123."""
    mock_user = MagicMock()
    mock_user.id = "user-123"
    mock_response = MagicMock()
    mock_response.user = mock_user
    p = patch("djtoolkit.service.auth._get_supabase_client")
    mock_client = p.start()
    mock_client.return_value.auth.get_user.return_value = mock_response
    return p


def test_export_traktor(client, auth_headers):
    auth_patch = _patch_auth()
    with patch("djtoolkit.service.routes.export_collection.SupabaseAdapter") as mock_cls:
        mock_cls.return_value.load_tracks.return_value = _sample_tracks()
        with patch("djtoolkit.service.routes.export_collection.get_client"):
            resp = client.get("/export/traktor", headers=auth_headers)
            assert resp.status_code == 200
            assert "attachment" in resp.headers.get("content-disposition", "")
            assert "xml" in resp.headers["content-type"]
    auth_patch.stop()


def test_export_rekordbox(client, auth_headers):
    auth_patch = _patch_auth()
    with patch("djtoolkit.service.routes.export_collection.SupabaseAdapter") as mock_cls:
        mock_cls.return_value.load_tracks.return_value = _sample_tracks()
        with patch("djtoolkit.service.routes.export_collection.get_client"):
            resp = client.get("/export/rekordbox", headers=auth_headers)
            assert resp.status_code == 200
            assert "attachment" in resp.headers.get("content-disposition", "")
            assert b"DJ_PLAYLISTS" in resp.content
    auth_patch.stop()


def test_export_csv(client, auth_headers):
    auth_patch = _patch_auth()
    with patch("djtoolkit.service.routes.export_collection.SupabaseAdapter") as mock_cls:
        mock_cls.return_value.load_tracks.return_value = _sample_tracks()
        with patch("djtoolkit.service.routes.export_collection.get_client"):
            resp = client.get("/export/csv", headers=auth_headers)
            assert resp.status_code == 200
            assert "text/csv" in resp.headers["content-type"]
            lines = resp.text.strip().split("\n")
            assert len(lines) == 3  # header + 2 tracks
    auth_patch.stop()


def test_export_invalid_format(client, auth_headers):
    auth_patch = _patch_auth()
    resp = client.get("/export/serato", headers=auth_headers)
    assert resp.status_code == 400
    auth_patch.stop()


def test_export_no_auth(client):
    resp = client.get("/export/traktor")
    assert resp.status_code == 401
