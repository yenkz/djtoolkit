"""Tests for Traktor NML import/export adapter."""

from pathlib import Path

from djtoolkit.adapters.traktor import TraktorImporter, TraktorExporter
from djtoolkit.models.track import CueType


FIXTURE = Path(__file__).parent / "fixtures" / "traktor_sample.nml"


class TestTraktorImporter:
    def setup_method(self):
        self.result = TraktorImporter().parse(FIXTURE.read_bytes())

    def test_track_count(self):
        assert self.result.stats["total"] == 2

    def test_track_one_metadata(self):
        t = self.result.tracks[0]
        assert t.title == "Track One"
        assert t.artist == "Artist A"
        assert t.album == "Album A"
        assert t.bpm == 128.0
        assert t.genres == "Techno"
        assert t.label == "Label X"
        assert t.comments == "Great track"
        assert t.rating == 3
        assert t.play_count == 15
        assert t.duration_ms == 345000  # PLAYTIME in seconds → ms

    def test_track_one_key(self):
        t = self.result.tracks[0]
        assert t.key == "F minor"       # MUSICAL_KEY VALUE=17
        assert t.camelot == "4A"

    def test_track_one_file_path(self):
        t = self.result.tracks[0]
        assert t.file_path == "/Users/dj/Music/Tracks/track_one.mp3"

    def test_track_one_source(self):
        t = self.result.tracks[0]
        assert t.source == "traktor"
        assert t.source_id is not None

    def test_track_one_cue_points(self):
        t = self.result.tracks[0]
        assert len(t.cue_points) == 4
        # Hot cue 0
        assert t.cue_points[0].name == "Intro"
        assert t.cue_points[0].position_ms == 1234.56
        assert t.cue_points[0].hotcue_index == 0
        assert t.cue_points[0].type == CueType.CUE
        # Hot cue 1
        assert t.cue_points[1].name == "Drop"
        assert t.cue_points[1].hotcue_index == 1
        # Loop (hot cue 2)
        assert t.cue_points[2].type == CueType.LOOP
        assert t.cue_points[2].position_ms == 23456.78
        assert t.cue_points[2].loop_end_ms == 23456.78 + 8000.0
        assert t.cue_points[2].hotcue_index == 2
        # Memory cue
        assert t.cue_points[3].hotcue_index == -1

    def test_track_two_no_cues(self):
        t = self.result.tracks[1]
        assert len(t.cue_points) == 0
        assert t.key == "C minor"       # MUSICAL_KEY VALUE=12
        assert t.camelot == "5A"

    def test_playlists(self):
        assert "Friday Night" in self.result.playlists
        assert len(self.result.playlists["Friday Night"]) == 2

    def test_warnings_empty(self):
        assert self.result.warnings == []


class TestTraktorExporter:
    def test_round_trip(self):
        """Import NML → export NML → reimport → compare."""
        original = TraktorImporter().parse(FIXTURE.read_bytes())
        xml_bytes = TraktorExporter().export(original.tracks)
        reimported = TraktorImporter().parse(xml_bytes)

        assert len(reimported.tracks) == len(original.tracks)
        for orig, reim in zip(original.tracks, reimported.tracks):
            assert reim.title == orig.title
            assert reim.artist == orig.artist
            assert reim.bpm == orig.bpm
            assert reim.key == orig.key
            assert len(reim.cue_points) == len(orig.cue_points)

    def test_output_is_valid_xml(self):
        import xml.etree.ElementTree as ET
        original = TraktorImporter().parse(FIXTURE.read_bytes())
        xml_bytes = TraktorExporter().export(original.tracks)
        root = ET.fromstring(xml_bytes)
        assert root.tag == "NML"

    def test_key_exported_as_integer(self):
        import xml.etree.ElementTree as ET
        original = TraktorImporter().parse(FIXTURE.read_bytes())
        xml_bytes = TraktorExporter().export(original.tracks)
        root = ET.fromstring(xml_bytes)
        entry = root.find(".//ENTRY")
        mk = entry.find("MUSICAL_KEY")
        assert mk is not None
        assert mk.get("VALUE").isdigit()
