"""Tests for Rekordbox XML import/export adapter."""

from pathlib import Path

from djtoolkit.adapters.rekordbox import RekordboxImporter, RekordboxExporter
from djtoolkit.models.track import CueType


FIXTURE = Path(__file__).parent / "fixtures" / "rekordbox_sample.xml"


class TestRekordboxImporter:
    def setup_method(self):
        self.result = RekordboxImporter().parse(FIXTURE.read_bytes())

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
        assert t.play_count == 15
        assert t.duration_ms == 345000  # TotalTime in seconds → ms

    def test_track_one_key(self):
        t = self.result.tracks[0]
        assert t.key == "F minor"       # Tonality="Fm"
        assert t.camelot == "4A"

    def test_track_one_file_path(self):
        t = self.result.tracks[0]
        # file://localhost/ prefix stripped
        assert t.file_path == "/Users/dj/Music/Tracks/track_one.mp3"

    def test_track_one_source(self):
        t = self.result.tracks[0]
        assert t.source == "rekordbox"
        assert t.source_id == "15"

    def test_track_one_cue_points(self):
        t = self.result.tracks[0]
        assert len(t.cue_points) == 4
        # Hot cue 0
        assert t.cue_points[0].name == "Intro"
        assert abs(t.cue_points[0].position_ms - 1234.56) < 0.1  # sec → ms
        assert t.cue_points[0].hotcue_index == 0
        assert t.cue_points[0].color == (40, 226, 20)
        # Hot cue 1
        assert t.cue_points[1].name == "Drop"
        assert t.cue_points[1].color == (230, 30, 30)
        # Loop
        assert t.cue_points[2].type == CueType.LOOP
        assert abs(t.cue_points[2].position_ms - 23456.78) < 0.1
        assert abs(t.cue_points[2].loop_end_ms - 31456.78) < 0.1
        # Memory cue
        assert t.cue_points[3].hotcue_index == -1

    def test_track_one_beatgrid(self):
        t = self.result.tracks[0]
        assert len(t.beatgrid) == 1
        assert t.beatgrid[0].bpm == 128.0
        assert abs(t.beatgrid[0].position_ms - 98.0) < 0.1  # Inizio sec → ms

    def test_track_two_no_cues(self):
        t = self.result.tracks[1]
        assert len(t.cue_points) == 0
        assert t.key == "C minor"
        assert t.camelot == "5A"

    def test_playlists(self):
        assert "Friday Night" in self.result.playlists
        assert len(self.result.playlists["Friday Night"]) == 2
        assert "15" in self.result.playlists["Friday Night"]
        assert "22" in self.result.playlists["Friday Night"]


class TestRekordboxExporter:
    def test_round_trip(self):
        original = RekordboxImporter().parse(FIXTURE.read_bytes())
        xml_bytes = RekordboxExporter().export(original.tracks)
        reimported = RekordboxImporter().parse(xml_bytes)

        assert len(reimported.tracks) == len(original.tracks)
        for orig, reim in zip(original.tracks, reimported.tracks):
            assert reim.title == orig.title
            assert reim.artist == orig.artist
            assert reim.bpm == orig.bpm
            assert reim.key == orig.key
            assert len(reim.cue_points) == len(orig.cue_points)

    def test_output_is_valid_xml(self):
        import xml.etree.ElementTree as ET
        original = RekordboxImporter().parse(FIXTURE.read_bytes())
        xml_bytes = RekordboxExporter().export(original.tracks)
        root = ET.fromstring(xml_bytes)
        assert root.tag == "DJ_PLAYLISTS"

    def test_cue_positions_in_seconds(self):
        import xml.etree.ElementTree as ET
        original = RekordboxImporter().parse(FIXTURE.read_bytes())
        xml_bytes = RekordboxExporter().export(original.tracks)
        root = ET.fromstring(xml_bytes)
        track = root.find(".//TRACK")
        pm = track.find("POSITION_MARK")
        start_sec = float(pm.get("Start"))
        # Original was 1234.56 ms → should be ~1.23456 sec
        assert abs(start_sec - 1.23456) < 0.001
