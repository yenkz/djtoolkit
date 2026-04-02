from djtoolkit.adapters.m3u import M3UExporter
from djtoolkit.models.track import Track


def test_m3u_header():
    tracks = [Track(title="Test", artist="Artist", duration_ms=300000, file_path="/music/test.flac")]
    data = M3UExporter().export(tracks, "My Playlist")
    text = data.decode("utf-8")
    assert text.startswith("#EXTM3U\n")
    assert "#PLAYLIST:My Playlist" in text


def test_m3u_track_entries():
    tracks = [
        Track(title="Domino", artist="Oxia", duration_ms=398000, file_path="/music/Oxia - Domino.flac"),
        Track(title="Singularity", artist="Stephan Bodzin", duration_ms=421000, file_path="/music/Bodzin.flac"),
    ]
    data = M3UExporter().export(tracks, "Test")
    text = data.decode("utf-8")
    assert "#EXTINF:398,Oxia - Domino" in text
    assert "/music/Oxia - Domino.flac" in text
    assert "#EXTINF:421,Stephan Bodzin - Singularity" in text


def test_m3u_skips_tracks_without_path():
    tracks = [
        Track(title="Has Path", artist="A", duration_ms=300000, file_path="/music/a.flac"),
        Track(title="No Path", artist="B", duration_ms=300000, file_path=None),
    ]
    data = M3UExporter().export(tracks, "Test")
    text = data.decode("utf-8")
    assert "Has Path" in text
    assert "No Path" not in text
