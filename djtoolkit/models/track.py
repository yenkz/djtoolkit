"""Unified Track Model — core domain dataclasses.

CuePoint positions are always in milliseconds. Adapters convert to/from
source-specific units (e.g. Rekordbox uses seconds).
"""

from dataclasses import dataclass, field
from enum import Enum

from djtoolkit.models.camelot import (
    SPOTIFY_KEY_MAP,
    key_to_camelot,
)


class CueType(Enum):
    CUE = "cue"
    LOOP = "loop"
    GRID = "grid"
    FADE_IN = "fade_in"
    FADE_OUT = "fade_out"
    LOAD = "load"


@dataclass
class CuePoint:
    name: str = ""
    position_ms: float = 0.0
    type: CueType = CueType.CUE
    hotcue_index: int = -1
    loop_end_ms: float = 0.0
    color: tuple[int, int, int] | None = None


@dataclass
class BeatGridMarker:
    position_ms: float = 0.0
    bpm: float = 0.0
    beats_per_bar: int = 4
    beat_number: int = 1


@dataclass
class Track:
    # Identity
    title: str = ""
    artist: str = ""
    artists: list[str] = field(default_factory=list)
    album: str = ""
    file_path: str | None = None

    # Musical properties
    bpm: float = 0.0
    key: str = ""
    camelot: str = ""
    energy: float = 0.0
    danceability: float = 0.0

    # Metadata
    genres: str = ""
    label: str = ""
    year: int | None = None
    duration_ms: int = 0
    isrc: str | None = None
    comments: str = ""
    rating: int = 0
    play_count: int = 0
    file_size: int | None = None
    sample_rate: int | None = None
    bitrate: int | None = None

    # DJ data
    cue_points: list[CuePoint] = field(default_factory=list)
    beatgrid: list[BeatGridMarker] = field(default_factory=list)

    # Source tracking
    source: str = ""
    source_id: str | None = None

    # Spotify audio features
    spotify_uri: str | None = None
    loudness: float | None = None
    speechiness: float | None = None
    acousticness: float | None = None
    instrumentalness: float | None = None
    liveness: float | None = None
    valence: float | None = None
    tempo: float | None = None

    def hot_cues(self) -> list[CuePoint]:
        return [c for c in self.cue_points if c.hotcue_index >= 0 and c.type == CueType.CUE]

    def memory_cues(self) -> list[CuePoint]:
        return [c for c in self.cue_points if c.hotcue_index == -1 and c.type == CueType.CUE]

    def loops(self) -> list[CuePoint]:
        return [c for c in self.cue_points if c.type == CueType.LOOP]

    def to_db_row(self) -> dict:
        camelot = self.camelot or key_to_camelot(self.key)
        row = {
            "title": self.title,
            "artist": self.artist,
            "artists": "|".join(self.artists) if self.artists else None,
            "album": self.album,
            "local_path": self.file_path,
            "bpm": self.bpm,
            "key_normalized": self.key or None,
            "camelot": camelot or None,
            "energy": self.energy,
            "danceability": self.danceability,
            "genres": self.genres or None,
            "record_label": self.label or None,
            "year": self.year,
            "duration_ms": self.duration_ms,
            "isrc": self.isrc,
            "comments": self.comments or None,
            "rating": self.rating,
            "play_count": self.play_count,
            "cue_points": [self._cue_to_dict(c) for c in self.cue_points],
            "beatgrid": [self._bg_to_dict(b) for b in self.beatgrid],
            "source": self.source or None,
            "source_id": self.source_id,
            "spotify_uri": self.spotify_uri,
            "loudness": self.loudness,
            "speechiness": self.speechiness,
            "acousticness": self.acousticness,
            "instrumentalness": self.instrumentalness,
            "liveness": self.liveness,
            "valence": self.valence,
            "tempo": self.tempo,
            "file_size": self.file_size,
            "sample_rate": self.sample_rate,
            "bitrate": self.bitrate,
        }
        return row

    @classmethod
    def from_db_row(cls, row: dict) -> "Track":
        key = row.get("key_normalized") or ""
        if not key:
            raw_key = row.get("key")
            raw_mode = row.get("mode")
            if raw_key is not None and raw_mode is not None:
                key = SPOTIFY_KEY_MAP.get((int(raw_key), int(raw_mode)), "")
            elif raw_key is not None:
                key = SPOTIFY_KEY_MAP.get((int(raw_key), 0), "")

        artists_raw = row.get("artists") or ""
        artists = artists_raw.split("|") if artists_raw else []

        cue_dicts = row.get("cue_points") or []
        cue_points = [cls._cue_from_dict(d) for d in cue_dicts]

        bg_dicts = row.get("beatgrid") or []
        beatgrid = [cls._bg_from_dict(d) for d in bg_dicts]

        return cls(
            title=row.get("title") or "",
            artist=row.get("artist") or "",
            artists=artists,
            album=row.get("album") or "",
            file_path=row.get("local_path"),
            bpm=float(row.get("bpm") or 0),
            key=key,
            camelot=row.get("camelot") or key_to_camelot(key),
            energy=float(row.get("energy") or 0),
            danceability=float(row.get("danceability") or 0),
            genres=row.get("genres") or "",
            label=row.get("record_label") or "",
            year=row.get("year"),
            duration_ms=int(row.get("duration_ms") or 0),
            isrc=row.get("isrc"),
            comments=row.get("comments") or "",
            rating=int(row.get("rating") or 0),
            play_count=int(row.get("play_count") or 0),
            cue_points=cue_points,
            beatgrid=beatgrid,
            source=row.get("source") or "",
            source_id=row.get("source_id"),
            spotify_uri=row.get("spotify_uri"),
            loudness=row.get("loudness"),
            speechiness=row.get("speechiness"),
            acousticness=row.get("acousticness"),
            instrumentalness=row.get("instrumentalness"),
            liveness=row.get("liveness"),
            valence=row.get("valence"),
            tempo=row.get("tempo"),
            file_size=row.get("file_size"),
            sample_rate=row.get("sample_rate"),
            bitrate=row.get("bitrate"),
        )

    @staticmethod
    def _cue_to_dict(c: CuePoint) -> dict:
        return {
            "name": c.name,
            "position_ms": c.position_ms,
            "type": c.type.value,
            "hotcue_index": c.hotcue_index,
            "loop_end_ms": c.loop_end_ms,
            "color": {"r": c.color[0], "g": c.color[1], "b": c.color[2]} if c.color else None,
        }

    @staticmethod
    def _cue_from_dict(d: dict) -> CuePoint:
        color_d = d.get("color")
        color = (color_d["r"], color_d["g"], color_d["b"]) if color_d else None
        return CuePoint(
            name=d.get("name", ""),
            position_ms=float(d.get("position_ms", 0)),
            type=CueType(d.get("type", "cue")),
            hotcue_index=int(d.get("hotcue_index", -1)),
            loop_end_ms=float(d.get("loop_end_ms", 0)),
            color=color,
        )

    @staticmethod
    def _bg_to_dict(b: BeatGridMarker) -> dict:
        return {
            "position_ms": b.position_ms,
            "bpm": b.bpm,
            "beats_per_bar": b.beats_per_bar,
            "beat_number": b.beat_number,
        }

    @staticmethod
    def _bg_from_dict(d: dict) -> BeatGridMarker:
        return BeatGridMarker(
            position_ms=float(d.get("position_ms", 0)),
            bpm=float(d.get("bpm", 0)),
            beats_per_bar=int(d.get("beats_per_bar", 4)),
            beat_number=int(d.get("beat_number", 1)),
        )
