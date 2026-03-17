"""Rekordbox XML import/export adapter.

Rekordbox format notes:
- Cue positions in seconds (model uses milliseconds)
- Tonality is a string like "Cm", "Ab", "F#m"
- POSITION_MARK Type: 0=cue, 4=loop
- POSITION_MARK Num: 0-7=hot cue, -1=memory cue
- TEMPO entries define dynamic beatgrid (Inizio in seconds)
"""

import xml.etree.ElementTree as ET
from urllib.parse import unquote

from djtoolkit.adapters.base import ExportAdapter, ImportAdapter, ImportResult
from djtoolkit.models.camelot import key_to_camelot, normalize_key
from djtoolkit.models.track import BeatGridMarker, CuePoint, CueType, Track


class RekordboxImporter(ImportAdapter):
    def parse(self, file_data: bytes) -> ImportResult:
        root = ET.fromstring(file_data)
        tracks: list[Track] = []
        warnings: list[str] = []

        collection = root.find("COLLECTION")
        if collection is None:
            return ImportResult(stats={"total": 0, "imported": 0})

        for track_el in collection.findall("TRACK"):
            try:
                track = self._parse_track(track_el)
                tracks.append(track)
            except Exception as e:
                name = track_el.get("Name", "unknown")
                warnings.append(f"Skipped '{name}': {e}")

        playlists = self._parse_playlists(root)

        return ImportResult(
            tracks=tracks,
            playlists=playlists,
            warnings=warnings,
            stats={"total": len(tracks), "imported": len(tracks), "skipped": len(warnings)},
        )

    def _parse_track(self, el: ET.Element) -> Track:
        # File path
        location = el.get("Location", "")
        file_path = None
        if location:
            # Strip file://localhost prefix and URL-decode
            for prefix in ("file://localhost", "file://"):
                if location.startswith(prefix):
                    location = location[len(prefix):]
                    break
            file_path = unquote(location)

        # Key
        tonality = el.get("Tonality", "")
        key = normalize_key(tonality, "rekordbox") if tonality else ""
        camelot = key_to_camelot(key)

        # Cue points
        cue_points: list[CuePoint] = []
        for pm in el.findall("POSITION_MARK"):
            pm_type = pm.get("Type", "0")
            num = int(pm.get("Num", "-1"))
            start_sec = float(pm.get("Start", "0"))
            start_ms = start_sec * 1000.0

            if pm_type == "4":  # Loop
                end_sec = float(pm.get("End", "0"))
                cue_type = CueType.LOOP
                loop_end_ms = end_sec * 1000.0
            else:
                cue_type = CueType.CUE
                loop_end_ms = 0.0

            # Color
            color = None
            r, g, b = pm.get("Red"), pm.get("Green"), pm.get("Blue")
            if r is not None and g is not None and b is not None:
                color = (int(r), int(g), int(b))

            cue_points.append(CuePoint(
                name=pm.get("Name", ""),
                position_ms=start_ms,
                type=cue_type,
                hotcue_index=num,
                loop_end_ms=loop_end_ms,
                color=color,
            ))

        # Beatgrid
        beatgrid: list[BeatGridMarker] = []
        for tempo_el in el.findall("TEMPO"):
            inizio_sec = float(tempo_el.get("Inizio", "0"))
            bpm_val = float(tempo_el.get("Bpm", "0"))
            beatgrid.append(BeatGridMarker(
                position_ms=inizio_sec * 1000.0,
                bpm=bpm_val,
                beat_number=1,  # Rekordbox doesn't encode beat_number
            ))

        # BPM: use AverageBpm attribute (dominant BPM)
        bpm = float(el.get("AverageBpm", "0") or "0")

        total_time = int(el.get("TotalTime", "0") or "0")

        return Track(
            title=el.get("Name", ""),
            artist=el.get("Artist", ""),
            album=el.get("Album", ""),
            file_path=file_path,
            bpm=bpm,
            key=key,
            camelot=camelot,
            genres=el.get("Genre", ""),
            label=el.get("Label", ""),
            comments=el.get("Comments", ""),
            year=int(el.get("Year", "0") or "0") or None,
            play_count=int(el.get("PlayCount", "0") or "0"),
            rating=int(el.get("Rating", "0") or "0"),
            duration_ms=total_time * 1000,
            cue_points=cue_points,
            beatgrid=beatgrid,
            file_size=int(el.get("Size", "0") or "0") or None,
            sample_rate=int(el.get("SampleRate", "0") or "0") or None,
            bitrate=int(el.get("BitRate", "0") or "0") or None,
            source="rekordbox",
            source_id=el.get("TrackID", ""),
        )

    def _parse_playlists(self, root: ET.Element) -> dict[str, list[str]]:
        playlists: dict[str, list[str]] = {}
        playlists_node = root.find("PLAYLISTS")
        if playlists_node is None:
            return playlists
        for node in playlists_node.iter("NODE"):
            if node.get("Type") == "1":  # Playlist type
                name = node.get("Name", "")
                keys = [t.get("Key", "") for t in node.findall("TRACK")]
                if name and keys:
                    playlists[name] = keys
        return playlists


class RekordboxExporter(ExportAdapter):
    def export(self, tracks: list[Track]) -> bytes:
        root = ET.Element("DJ_PLAYLISTS", Version="1.0.0")
        ET.SubElement(root, "PRODUCT", Name="djtoolkit", Version="1.0.0", Company="djtoolkit")

        collection = ET.SubElement(root, "COLLECTION", Entries=str(len(tracks)))
        for i, track in enumerate(tracks, start=1):
            self._write_track(collection, track, track_id=track.source_id or str(i))

        tree = ET.ElementTree(root)
        ET.indent(tree, space="  ")
        return ET.tostring(root, encoding="unicode", xml_declaration=True).encode("utf-8")

    def _write_track(self, parent: ET.Element, track: Track, track_id: str) -> None:
        attrs: dict[str, str] = {
            "TrackID": track_id,
            "Name": track.title,
            "Artist": track.artist,
            "Album": track.album,
        }
        if track.genres:
            attrs["Genre"] = track.genres
        if track.label:
            attrs["Label"] = track.label
        if track.bpm:
            attrs["AverageBpm"] = f"{track.bpm:.2f}"
        if track.comments:
            attrs["Comments"] = track.comments
        if track.play_count:
            attrs["PlayCount"] = str(track.play_count)
        if track.rating:
            attrs["Rating"] = str(track.rating)
        if track.duration_ms:
            attrs["TotalTime"] = str(track.duration_ms // 1000)
        if track.year:
            attrs["Year"] = str(track.year)
        if track.key:
            # Convert to Rekordbox Tonality format
            key = track.key
            if key.endswith(" minor"):
                attrs["Tonality"] = key.replace(" minor", "m")
            elif key.endswith(" major"):
                attrs["Tonality"] = key.replace(" major", "")

        if track.file_path:
            from urllib.parse import quote
            attrs["Location"] = "file://localhost" + quote(track.file_path)

        track_el = ET.SubElement(parent, "TRACK", **attrs)

        # Beatgrid
        for bg in track.beatgrid:
            ET.SubElement(track_el, "TEMPO",
                          Inizio=f"{bg.position_ms / 1000.0:.3f}",
                          Bpm=f"{bg.bpm:.2f}",
                          Metro="4/4",
                          Battito=str(bg.beat_number))

        # Cue points
        for cue in track.cue_points:
            pm_attrs: dict[str, str] = {
                "Name": cue.name,
                "Start": f"{cue.position_ms / 1000.0:.5f}",
                "Num": str(cue.hotcue_index),
            }
            if cue.type == CueType.LOOP:
                pm_attrs["Type"] = "4"
                pm_attrs["End"] = f"{cue.loop_end_ms / 1000.0:.5f}"
            else:
                pm_attrs["Type"] = "0"

            if cue.color:
                pm_attrs["Red"] = str(cue.color[0])
                pm_attrs["Green"] = str(cue.color[1])
                pm_attrs["Blue"] = str(cue.color[2])

            ET.SubElement(track_el, "POSITION_MARK", **pm_attrs)
