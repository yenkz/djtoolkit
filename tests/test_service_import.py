import pytest
from pathlib import Path
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient

from djtoolkit.service.app import create_app

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def client():
    app = create_app()
    return TestClient(app)


@pytest.fixture
def auth_headers():
    return {"Authorization": "Bearer valid.jwt.token"}


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


def test_parse_traktor_nml(client, auth_headers):
    auth_patch = _patch_auth()
    with patch("djtoolkit.service.routes.import_collection.SupabaseAdapter") as mock_adapter_cls:
        mock_adapter_cls.return_value.save_tracks.return_value = {"imported": 2, "track_ids": [101, 102]}
        with patch("djtoolkit.service.routes.import_collection.get_client"):
            nml_data = (FIXTURES / "traktor_sample.nml").read_bytes()
            resp = client.post(
                "/parse",
                files={"file": ("collection.nml", nml_data, "application/xml")},
                headers=auth_headers,
            )
            assert resp.status_code == 200
            body = resp.json()
            assert body["format"] == "traktor"
            assert body["tracks_parsed"] > 0
            assert "warnings" in body
            assert "track_ids" in body
            assert isinstance(body["track_ids"], list)
    auth_patch.stop()


def test_parse_rekordbox_xml(client, auth_headers):
    auth_patch = _patch_auth()
    with patch("djtoolkit.service.routes.import_collection.SupabaseAdapter") as mock_adapter_cls:
        mock_adapter_cls.return_value.save_tracks.return_value = {"imported": 2}
        with patch("djtoolkit.service.routes.import_collection.get_client"):
            xml_data = (FIXTURES / "rekordbox_sample.xml").read_bytes()
            resp = client.post(
                "/parse",
                files={"file": ("rekordbox.xml", xml_data, "application/xml")},
                headers=auth_headers,
            )
            assert resp.status_code == 200
            body = resp.json()
            assert body["format"] == "rekordbox"
            assert body["tracks_parsed"] > 0
    auth_patch.stop()


def test_parse_unknown_format(client, auth_headers):
    auth_patch = _patch_auth()
    resp = client.post(
        "/parse",
        files={"file": ("random.txt", b"not xml at all", "text/plain")},
        headers=auth_headers,
    )
    assert resp.status_code == 400
    assert "format" in resp.json()["detail"].lower()
    auth_patch.stop()


def test_parse_no_auth(client):
    resp = client.post("/parse", files={"file": ("f.nml", b"<NML/>", "application/xml")})
    assert resp.status_code == 401
