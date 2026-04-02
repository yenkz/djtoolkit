"""M3U playlist exporter."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from djtoolkit.models.track import Track


class M3UExporter:
    """Export tracks as an extended M3U playlist."""

    def export(self, tracks: list[Track], playlist_name: str) -> bytes:
        lines = ["#EXTM3U", f"#PLAYLIST:{playlist_name}"]

        for track in tracks:
            if not track.file_path:
                continue
            duration_sec = track.duration_ms // 1000 if track.duration_ms else 0
            display = f"{track.artist} - {track.title}" if track.artist else track.title
            lines.append(f"#EXTINF:{duration_sec},{display}")
            lines.append(track.file_path)

        lines.append("")  # trailing newline
        return "\n".join(lines).encode("utf-8")
