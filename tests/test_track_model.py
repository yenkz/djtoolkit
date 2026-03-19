"""Tests for Track dataclass and serialization."""

from djtoolkit.models.track import Track, CuePoint, BeatGridMarker, CueType


class TestCuePoint:
    def test_defaults(self):
        c = CuePoint()
        assert c.name == ""
        assert c.position_ms == 0.0
        assert c.type == CueType.CUE
        assert c.hotcue_index == -1
        assert c.color is None

    def test_loop(self):
        c = CuePoint(type=CueType.LOOP, position_ms=1000.0, loop_end_ms=5000.0, hotcue_index=2)
        assert c.type == CueType.LOOP
        assert c.loop_end_ms == 5000.0


class TestTrack:
    def test_defaults(self):
        t = Track()
        assert t.title == ""
        assert t.artists == []
        assert t.cue_points == []
        assert t.beatgrid == []
        assert t.file_path is None

    def test_hot_cues(self):
        t = Track(cue_points=[
            CuePoint(name="A", hotcue_index=0),
            CuePoint(name="B", hotcue_index=-1),
            CuePoint(name="C", hotcue_index=1),
            CuePoint(name="Loop", type=CueType.LOOP, hotcue_index=2),
        ])
        assert len(t.hot_cues()) == 2
        assert t.hot_cues()[0].name == "A"
        assert t.hot_cues()[1].name == "C"

    def test_memory_cues(self):
        t = Track(cue_points=[
            CuePoint(name="A", hotcue_index=0),
            CuePoint(name="Mem1", hotcue_index=-1),
            CuePoint(name="Mem2", hotcue_index=-1),
        ])
        assert len(t.memory_cues()) == 2

    def test_loops(self):
        t = Track(cue_points=[
            CuePoint(name="A", hotcue_index=0),
            CuePoint(name="Loop", type=CueType.LOOP, hotcue_index=2, loop_end_ms=8000.0),
        ])
        assert len(t.loops()) == 1
        assert t.loops()[0].loop_end_ms == 8000.0


class TestTrackToDbRow:
    def test_flat_fields(self):
        t = Track(title="Test", artist="Artist", bpm=128.0, year=2024)
        row = t.to_db_row()
        assert row["title"] == "Test"
        assert row["artist"] == "Artist"
        assert row["tempo"] == 128.0  # Track.bpm maps to DB tempo column
        assert "bpm" not in row
        assert row["year"] == 2024

    def test_artists_pipe_separated(self):
        t = Track(artists=["Artist1", "Artist2", "Artist3"])
        row = t.to_db_row()
        assert row["artists"] == "Artist1|Artist2|Artist3"

    def test_key_maps_to_key_normalized(self):
        t = Track(key="C minor")
        row = t.to_db_row()
        assert row["key_normalized"] == "C minor"
        assert "key" not in row  # Track.key maps to key_normalized column

    def test_camelot_auto_computed(self):
        t = Track(key="C minor")
        row = t.to_db_row()
        assert row["camelot"] == "5A"

    def test_camelot_explicit(self):
        t = Track(key="C minor", camelot="5A")
        row = t.to_db_row()
        assert row["camelot"] == "5A"

    def test_cue_points_jsonb(self):
        t = Track(cue_points=[
            CuePoint(name="Drop", position_ms=56789.0, hotcue_index=1, color=(230, 30, 30)),
        ])
        row = t.to_db_row()
        cues = row["cue_points"]
        assert isinstance(cues, list)
        assert len(cues) == 1
        assert cues[0]["name"] == "Drop"
        assert cues[0]["position_ms"] == 56789.0
        assert cues[0]["type"] == "cue"
        assert cues[0]["color"] == {"r": 230, "g": 30, "b": 30}

    def test_beatgrid_jsonb(self):
        t = Track(beatgrid=[
            BeatGridMarker(position_ms=100.0, bpm=128.0, beat_number=1),
        ])
        row = t.to_db_row()
        bg = row["beatgrid"]
        assert isinstance(bg, list)
        assert bg[0]["position_ms"] == 100.0
        assert bg[0]["bpm"] == 128.0

    def test_label_maps_to_record_label(self):
        t = Track(label="Defected")
        row = t.to_db_row()
        assert row["record_label"] == "Defected"
        assert "label" not in row

    def test_empty_cue_points(self):
        t = Track()
        row = t.to_db_row()
        assert row["cue_points"] == []

    def test_none_color(self):
        t = Track(cue_points=[CuePoint(name="X")])
        row = t.to_db_row()
        assert row["cue_points"][0]["color"] is None


class TestTrackFromDbRow:
    def test_basic_fields(self):
        row = {"title": "Test", "artist": "Art", "bpm": 130.0, "year": 2024}
        t = Track.from_db_row(row)
        assert t.title == "Test"
        assert t.bpm == 130.0

    def test_artists_split(self):
        row = {"artists": "A|B|C"}
        t = Track.from_db_row(row)
        assert t.artists == ["A", "B", "C"]

    def test_artists_empty(self):
        row = {"artists": None}
        t = Track.from_db_row(row)
        assert t.artists == []

    def test_key_normalized_preferred(self):
        row = {"key_normalized": "C minor", "key": 0, "mode": 0}
        t = Track.from_db_row(row)
        assert t.key == "C minor"

    def test_key_fallback_from_spotify_ints(self):
        row = {"key_normalized": None, "key": 0, "mode": 0}
        t = Track.from_db_row(row)
        assert t.key == "C minor"

    def test_key_fallback_major(self):
        row = {"key_normalized": None, "key": 9, "mode": 1}
        t = Track.from_db_row(row)
        assert t.key == "A major"

    def test_key_both_null(self):
        row = {"key_normalized": None, "key": None}
        t = Track.from_db_row(row)
        assert t.key == ""

    def test_cue_points_deserialized(self):
        row = {"cue_points": [
            {"name": "Drop", "position_ms": 56789.0, "type": "cue",
             "hotcue_index": 1, "loop_end_ms": 0.0, "color": {"r": 230, "g": 30, "b": 30}},
        ]}
        t = Track.from_db_row(row)
        assert len(t.cue_points) == 1
        assert t.cue_points[0].name == "Drop"
        assert t.cue_points[0].type == CueType.CUE
        assert t.cue_points[0].color == (230, 30, 30)

    def test_null_cue_points(self):
        row = {"cue_points": None}
        t = Track.from_db_row(row)
        assert t.cue_points == []

    def test_record_label_maps_to_label(self):
        row = {"record_label": "Defected"}
        t = Track.from_db_row(row)
        assert t.label == "Defected"

    def test_round_trip(self):
        original = Track(
            title="Test Track", artist="DJ Test", artists=["DJ Test", "MC Test"],
            album="Test Album", bpm=128.0, key="C minor", energy=0.8,
            genres="Techno|House", label="Defected", year=2024,
            duration_ms=345000, source="traktor", source_id="/path/to/file.mp3",
            cue_points=[
                CuePoint(name="Intro", position_ms=1234.56, hotcue_index=0,
                         color=(40, 226, 20)),
                CuePoint(name="Loop", type=CueType.LOOP, position_ms=23456.78,
                         loop_end_ms=31456.78, hotcue_index=2),
            ],
            beatgrid=[BeatGridMarker(position_ms=98.0, bpm=128.0, beat_number=1)],
        )
        row = original.to_db_row()
        restored = Track.from_db_row(row)
        assert restored.title == original.title
        assert restored.artists == original.artists
        assert restored.key == original.key
        assert restored.camelot == "5A"
        assert len(restored.cue_points) == 2
        assert restored.cue_points[0].color == (40, 226, 20)
        assert restored.cue_points[1].type == CueType.LOOP
        assert len(restored.beatgrid) == 1
