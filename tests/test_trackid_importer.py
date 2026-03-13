"""Tests for TrackID.dev importer."""

import pytest
from djtoolkit.importers.trackid import validate_url


# ─── validate_url ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("url,expected", [
    # Standard watch URL
    ("https://www.youtube.com/watch?v=dQw4w9WgXcQ",
     "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    # Without www
    ("https://youtube.com/watch?v=dQw4w9WgXcQ",
     "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    # Short URL
    ("https://youtu.be/dQw4w9WgXcQ",
     "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    # Embed URL
    ("https://www.youtube.com/embed/dQw4w9WgXcQ",
     "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    # Strips tracking params
    ("https://youtu.be/dQw4w9WgXcQ?si=abc123",
     "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    # Strips extra params, keeps video ID
    ("https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=share&t=42",
     "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
])
def test_validate_url_normalizes(url, expected):
    assert validate_url(url) == expected


@pytest.mark.parametrize("bad_url", [
    "https://vimeo.com/123456",
    "https://soundcloud.com/artist/track",
    "not-a-url",
    "",
    "https://youtube.com/",           # no video ID
    "https://youtube.com/watch",      # no v= param
])
def test_validate_url_rejects_invalid(bad_url):
    with pytest.raises(ValueError):
        validate_url(bad_url)
