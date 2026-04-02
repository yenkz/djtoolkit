import xml.etree.ElementTree as ET
from djtoolkit.adapters.traktor import TraktorExporter
from djtoolkit.adapters.rekordbox import RekordboxExporter
from djtoolkit.models.track import Track


def _sample_tracks():
    return [
        Track(title="Domino", artist="Oxia", bpm=128.0, file_path="/music/Oxia - Domino.flac"),
        Track(title="Singularity", artist="Stephan Bodzin", bpm=124.0, file_path="/music/Bodzin.flac"),
    ]


class TestTraktorPlaylistExport:
    def test_export_with_playlists_has_playlists_node(self):
        tracks = _sample_tracks()
        playlists = [("My Set", tracks)]
        data = TraktorExporter().export_with_playlists(tracks, playlists)
        root = ET.fromstring(data)
        pl_node = root.find("PLAYLISTS")
        assert pl_node is not None

    def test_playlist_contains_entries(self):
        tracks = _sample_tracks()
        playlists = [("My Set", tracks)]
        data = TraktorExporter().export_with_playlists(tracks, playlists)
        root = ET.fromstring(data)
        playlist = root.find(".//PLAYLIST")
        assert playlist is not None
        assert int(playlist.get("ENTRIES", "0")) == 2

    def test_plain_export_unchanged(self):
        tracks = _sample_tracks()
        data = TraktorExporter().export(tracks)
        root = ET.fromstring(data)
        assert root.find("PLAYLISTS") is None


class TestRekordboxPlaylistExport:
    def test_export_with_playlists_has_playlists_node(self):
        tracks = _sample_tracks()
        playlists = [("My Set", tracks)]
        data = RekordboxExporter().export_with_playlists(tracks, playlists)
        root = ET.fromstring(data)
        pl_node = root.find("PLAYLISTS")
        assert pl_node is not None

    def test_playlist_contains_track_refs(self):
        tracks = _sample_tracks()
        playlists = [("My Set", tracks)]
        data = RekordboxExporter().export_with_playlists(tracks, playlists)
        root = ET.fromstring(data)
        track_refs = root.findall(".//PLAYLISTS//TRACK")
        assert len(track_refs) == 2

    def test_plain_export_unchanged(self):
        tracks = _sample_tracks()
        data = RekordboxExporter().export(tracks)
        root = ET.fromstring(data)
        assert root.find("PLAYLISTS") is None
