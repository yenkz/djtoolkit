"""Tests for cover art sources, image utilities, and embedding detection."""

import struct
from pathlib import Path
from unittest.mock import patch

import pytest

from djtoolkit.coverart.art import (
    FetchArtResult,
    _fetch_art,
    _has_cover_art,
    _image_dimensions,
    _mime_type,
    _source_deezer,
    _source_itunes,
    _source_lastfm,
    _source_spotify,
)

_FAKE_IMG = b"\xff\xd8\xff" + b"\x00" * 200  # looks like JPEG header


# ─── Image utilities ──────────────────────────────────────────────────────────


def _make_png(width: int, height: int) -> bytes:
    """Minimal PNG bytes with correct dimensions at the right offsets."""
    return (
        b"\x89PNG\r\n\x1a\n"         # 8-byte PNG signature
        + b"\x00" * 8                 # chunk length + chunk type (positions 8-15)
        + struct.pack(">II", width, height)   # width (16-19), height (20-23)
        + b"\x00" * 20               # rest not needed for dim extraction
    )


def _make_jpeg(width: int, height: int) -> bytes:
    """Minimal JPEG bytes with a SOF0 marker at offset 2."""
    sof0 = (
        b"\xff\xc0"              # SOF0 marker
        + struct.pack(">H", 11)  # segment length (includes 2 length bytes)
        + b"\x08"                # precision (not used by dim parser)
        + struct.pack(">HH", height, width)  # JPEG stores height first
        + b"\x01"                # num components
        + b"\x01\x11\x00"        # component spec
    )
    return b"\xff\xd8" + sof0


def test_image_dimensions_jpeg():
    data = _make_jpeg(1200, 1200)
    w, h = _image_dimensions(data)
    assert w == 1200
    assert h == 1200


def test_image_dimensions_png():
    data = _make_png(800, 600)
    w, h = _image_dimensions(data)
    assert w == 800
    assert h == 600


def test_image_dimensions_raises_on_unknown():
    with pytest.raises(ValueError):
        _image_dimensions(b"\x00" * 50)


def test_mime_type_jpeg():
    assert _mime_type(b"\xff\xd8\xff" + b"\x00" * 10) == "image/jpeg"


def test_mime_type_png():
    assert _mime_type(b"\x89PNG\r\n\x1a\n" + b"\x00" * 10) == "image/png"


def test_mime_type_unknown_defaults_to_jpeg():
    assert _mime_type(b"\x00\x00\x00") == "image/jpeg"


# ─── _has_cover_art ───────────────────────────────────────────────────────────


def test_has_cover_art_mp3_tags_no_apic(tmp_path):
    """MP3 with ID3 tags but no APIC frame → False."""
    path = tmp_path / "noart.mp3"
    path.write_bytes(b"\xff\xfb\x90\x00" + b"\x00" * 512)
    from mutagen.id3 import ID3, TIT2
    tags = ID3()
    tags.add(TIT2(encoding=3, text=["Track"]))
    tags.save(str(path))
    assert _has_cover_art(path) is False


def test_has_cover_art_mp3_without_id3(tmp_path):
    path = tmp_path / "noheader.mp3"
    path.write_bytes(b"\xff\xfb\x90\x00" + b"\x00" * 512)
    assert _has_cover_art(path) is False


def test_has_cover_art_mp3_with_apic(tmp_path):
    path = tmp_path / "withcovr.mp3"
    path.write_bytes(b"\xff\xfb\x90\x00" + b"\x00" * 512)
    from mutagen.id3 import APIC, ID3
    tags = ID3()
    tags["APIC:Cover"] = APIC(
        encoding=3, mime="image/jpeg", type=3, desc="Cover", data=_FAKE_IMG
    )
    tags.save(str(path))
    assert _has_cover_art(path) is True


# ─── Source functions ─────────────────────────────────────────────────────────
# Sources now return (image_bytes, artwork_url) tuples.
# _source_spotify returns a _SpotifyResult object.


def test_source_itunes_returns_bytes_on_success():
    itunes_json = {
        "results": [{"artworkUrl100": "http://example.com/art100x100bb.jpg"}]
    }
    with patch("djtoolkit.coverart.art._http_get_json", return_value=itunes_json):
        with patch("djtoolkit.coverart.art._http_get_bytes", return_value=_FAKE_IMG):
            img, url = _source_itunes("Artist", "Album")
    assert img == _FAKE_IMG
    assert url is not None


def test_source_itunes_returns_none_on_empty_results():
    with patch("djtoolkit.coverart.art._http_get_json", return_value={"results": []}):
        img, url = _source_itunes("Artist", "Album")
    assert img is None
    assert url is None


def test_source_itunes_returns_none_on_no_artwork_url():
    with patch(
        "djtoolkit.coverart.art._http_get_json",
        return_value={"results": [{"otherKey": "value"}]},
    ):
        img, url = _source_itunes("Artist", "Album")
    assert img is None
    assert url is None


def test_source_deezer_returns_bytes_on_success():
    deezer_json = {"data": [{"album": {"cover_xl": "http://example.com/cover.jpg"}}]}
    with patch("djtoolkit.coverart.art._http_get_json", return_value=deezer_json):
        with patch("djtoolkit.coverart.art._http_get_bytes", return_value=_FAKE_IMG):
            img, url = _source_deezer("Artist", "Title")
    assert img == _FAKE_IMG
    assert url is not None


def test_source_deezer_returns_none_on_empty_data():
    with patch("djtoolkit.coverart.art._http_get_json", return_value={"data": []}):
        img, url = _source_deezer("Artist", "Title")
    assert img is None
    assert url is None


def test_source_deezer_returns_none_on_missing_cover_xl():
    with patch(
        "djtoolkit.coverart.art._http_get_json",
        return_value={"data": [{"album": {}}]},
    ):
        img, url = _source_deezer("Artist", "Title")
    assert img is None
    assert url is None


def test_source_lastfm_returns_bytes_on_success():
    lastfm_json = {
        "album": {
            "image": [
                {"size": "small", "#text": "http://example.com/small.jpg"},
                {"size": "extralarge", "#text": "http://example.com/large.jpg"},
            ]
        }
    }
    with patch("djtoolkit.coverart.art._http_get_json", return_value=lastfm_json):
        with patch("djtoolkit.coverart.art._http_get_bytes", return_value=_FAKE_IMG):
            img, url = _source_lastfm("Artist", "Album", "fakekey")
    assert img == _FAKE_IMG
    assert url is not None


def test_source_lastfm_returns_none_on_no_album_key():
    with patch("djtoolkit.coverart.art._http_get_json", return_value={"error": 6}):
        img, url = _source_lastfm("Artist", "Album", "fakekey")
    assert img is None
    assert url is None


def test_source_spotify_returns_none_without_client_id():
    result = _source_spotify("", "some-secret", spotify_uri="spotify:track:abc")
    assert result.image is None
    assert result.spotify_uri is None


def test_source_spotify_returns_none_without_client_secret():
    result = _source_spotify("some-id", "", spotify_uri="spotify:track:abc")
    assert result.image is None
    assert result.spotify_uri is None


def test_source_spotify_returns_bytes_on_success():
    mock_track = {
        "album": {"images": [{"url": "http://example.com/img.jpg", "width": 640}]}
    }
    with patch("spotipy.Spotify") as mock_sp_cls:
        mock_sp = mock_sp_cls.return_value
        mock_sp.track.return_value = mock_track
        with patch("djtoolkit.coverart.art._http_get_bytes", return_value=_FAKE_IMG):
            with patch("spotipy.oauth2.SpotifyClientCredentials"):
                result = _source_spotify("client-id", "client-secret", spotify_uri="spotify:track:abc")
    assert result.spotify_uri == "spotify:track:abc"


def test_source_spotify_searches_by_name_when_no_uri():
    mock_search_result = {
        "tracks": {"items": [{"uri": "spotify:track:found123"}]}
    }
    mock_track = {
        "album": {"images": [{"url": "http://example.com/img.jpg", "width": 640}]}
    }
    with patch("spotipy.Spotify") as mock_sp_cls:
        mock_sp = mock_sp_cls.return_value
        mock_sp.search.return_value = mock_search_result
        mock_sp.track.return_value = mock_track
        with patch("djtoolkit.coverart.art._http_get_bytes", return_value=_FAKE_IMG):
            with patch("spotipy.oauth2.SpotifyClientCredentials"):
                result = _source_spotify(
                    "client-id", "client-secret",
                    artist="Daft Punk", title="Around the World",
                )
    assert result.image == _FAKE_IMG
    assert result.spotify_uri == "spotify:track:found123"
    mock_sp.search.assert_called_once()
    mock_sp.track.assert_called_once_with("spotify:track:found123")


# ─── _fetch_art dispatch ──────────────────────────────────────────────────────
# _fetch_art now returns a FetchArtResult object.


def test_fetch_art_returns_first_successful_source():
    with patch("djtoolkit.coverart.art._source_itunes", return_value=(_FAKE_IMG, "http://example.com/art.jpg")):
        with patch("djtoolkit.coverart.art.time.sleep"):
            result = _fetch_art("Artist", "Album", "Title", ["itunes"])
    assert result.image == _FAKE_IMG
    assert result.spotify_uri is None


def test_fetch_art_tries_next_source_on_failure():
    with patch("djtoolkit.coverart.art._source_itunes", return_value=(None, None)):
        with patch("djtoolkit.coverart.art._source_deezer", return_value=(_FAKE_IMG, "http://example.com/cover.jpg")):
            with patch("djtoolkit.coverart.art.time.sleep"):
                result = _fetch_art("Artist", "Album", "Title", ["itunes", "deezer"])
    assert result.image == _FAKE_IMG
    assert result.spotify_uri is None


def test_fetch_art_returns_none_when_all_sources_fail():
    with patch("djtoolkit.coverart.art._source_itunes", return_value=(None, None)):
        with patch("djtoolkit.coverart.art._source_deezer", return_value=(None, None)):
            with patch("djtoolkit.coverart.art.time.sleep"):
                result = _fetch_art("Artist", "Album", "Title", ["itunes", "deezer"])
    assert result.image is None


def test_fetch_art_spotify_searches_when_no_uri():
    """When spotify_uri is None, _source_spotify is called with artist+title for search."""
    from djtoolkit.coverart.art import _SpotifyResult
    mock_sr = _SpotifyResult(image=_FAKE_IMG, artwork_url="http://example.com/img.jpg", spotify_uri="spotify:track:abc123")
    with patch("djtoolkit.coverart.art._source_spotify", return_value=mock_sr) as mock_spotify:
        with patch("djtoolkit.coverart.art.time.sleep"):
            result = _fetch_art(
                "Artist", "Album", "Title", ["spotify"],
                spotify_uri=None, spotify_client_id="id", spotify_client_secret="secret",
            )
    mock_spotify.assert_called_once()
    assert result.image == _FAKE_IMG
    assert result.spotify_uri == "spotify:track:abc123"


def test_fetch_art_spotify_passes_existing_uri():
    """When spotify_uri is provided, it's forwarded to _source_spotify."""
    from djtoolkit.coverart.art import _SpotifyResult
    mock_sr = _SpotifyResult(image=_FAKE_IMG, artwork_url="http://example.com/img.jpg", spotify_uri="spotify:track:existing")
    with patch("djtoolkit.coverart.art._source_spotify", return_value=mock_sr) as mock_spotify:
        with patch("djtoolkit.coverart.art.time.sleep"):
            result = _fetch_art(
                "Artist", "Album", "Title", ["spotify"],
                spotify_uri="spotify:track:existing", spotify_client_id="id", spotify_client_secret="secret",
            )
    mock_spotify.assert_called_once()
    assert result.image == _FAKE_IMG
    # URI unchanged → found_uri should be None (no new discovery)
    assert result.spotify_uri is None


def test_fetch_art_skips_lastfm_without_api_key():
    with patch("djtoolkit.coverart.art._source_lastfm") as mock_lastfm:
        with patch("djtoolkit.coverart.art.time.sleep"):
            _fetch_art("Artist", "Album", "Title", ["lastfm"], lastfm_api_key="")
    mock_lastfm.assert_not_called()


def test_fetch_art_skips_unknown_source():
    with patch("djtoolkit.coverart.art.time.sleep"):
        result = _fetch_art("Artist", "Album", "Title", ["unknown_source"])
    assert result.image is None
