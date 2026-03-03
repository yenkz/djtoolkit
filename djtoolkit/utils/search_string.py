"""Build a slskd-friendly search string from track metadata."""

import re


# Patterns to strip from artist names (feat./vs. noise)
_FEAT_RE = re.compile(
    r"\s*(feat\.?|ft\.?|featuring|vs\.?|versus|x\b|&)\s+.+",
    re.IGNORECASE,
)

# Parenthetical/bracketed content that adds noise in artist field
_PARENS_RE = re.compile(r"\s*[\(\[].*?[\)\]]", re.IGNORECASE)

# Characters to strip (keep letters, digits, spaces, hyphens)
_STRIP_RE = re.compile(r"[^\w\s\-]", re.UNICODE)

# Collapse multiple spaces
_SPACES_RE = re.compile(r"\s+")


def _clean(text: str) -> str:
    text = _PARENS_RE.sub("", text)
    text = _FEAT_RE.sub("", text)
    text = _STRIP_RE.sub("", text)
    text = _SPACES_RE.sub(" ", text)
    return text.strip().lower()


def build(artist: str, title: str) -> str:
    """
    Build a slskd search string.

    Uses the primary artist (first before any ';') + full title.
    Remix info in the title is intentionally kept — it helps match
    the specific version on Soulseek.

    Examples:
        "Fred Falke;Elohim;Oliver", "It's A Memory - Oliver Remix"
        → "fred falke its a memory oliver remix"

        "Big Wild", "City of Sound"
        → "big wild city of sound"
    """
    primary_artist = artist.split(";")[0].strip()
    cleaned_artist = _clean(primary_artist)
    cleaned_title = _clean(title)
    return f"{cleaned_artist} {cleaned_title}".strip()
