"""Tests for djtoolkit/api/spotify_auth_routes.py — return_to validation."""

from __future__ import annotations

import pytest
from djtoolkit.api.spotify_auth_routes import _sanitize_return_to


def test_sanitize_relative_path_allowed():
    assert _sanitize_return_to("/catalog") == "/catalog"


def test_sanitize_root_allowed():
    assert _sanitize_return_to("/") == "/"


def test_sanitize_absolute_url_blocked():
    assert _sanitize_return_to("//evil.com/steal") == "/"


def test_sanitize_scheme_blocked():
    assert _sanitize_return_to("https://evil.com") == "/"


def test_sanitize_url_encoded_bypass_blocked():
    # %2F%2F decodes to // — must be rejected after URL-decoding
    assert _sanitize_return_to("%2F%2Fevil.com") == "/"


def test_sanitize_backslash_blocked():
    assert _sanitize_return_to("/\\evil.com") == "/"


def test_sanitize_empty_defaults_to_root():
    assert _sanitize_return_to("") == "/"


def test_sanitize_double_encoded_bypass_blocked():
    # %252F%252F double-encoded — decodes to %2F%2F on first pass, then // on second
    # urllib.parse.unquote only decodes one level, so this particular variant
    # decodes to %2F%2Fevil.com which starts with '%' not '/' — safe, but confirm
    # it doesn't produce a //-prefixed path
    result = _sanitize_return_to("%252F%252Fevil.com")
    assert not result.startswith("//"), f"Double-encoded path must not produce //-prefix: {result}"
