"""Traktor NML import/export adapter.

NML format notes:
- Cue positions in milliseconds
- MUSICAL_KEY VALUE is 0-23 integer (see camelot.TRAKTOR_KEY_MAP)
- File paths use /:  as directory separator
- TYPE: 0=cue, 1=fade-in, 2=fade-out, 3=load, 4=grid, 5=loop
"""

import xml.etree.ElementTree as ET

from djtoolkit.adapters.base import ExportAdapter, ImportAdapter, ImportResult
from djtoolkit.models.camelot import TRAKTOR_KEY_MAP, key_to_camelot
from djtoolkit.models.track import CuePoint, CueType, Track

# Traktor CUE_V2 TYPE → CueType
_NML_CUE_TYPE = {
    "0": CueType.CUE,
    "1": CueType.FADE_IN,
    "2": CueType.FADE_OUT,
    "3": CueType.LOAD,
    "4": CueType.GRID,
    "5": CueType.LOOP,
}

# Reverse: normalized key → Traktor integer
_KEY_TO_TRAKTOR = {v: k for k, v in TRAKTOR_KEY_MAP.items()}


class TraktorImporter(ImportAdapter):
    def parse(self, file_data: bytes) -> ImportResult:
        root = ET.fromstring(file_data)
        tracks: list[Track] = []
        warnings: list[str] = []

        collection = root.find("COLLECTION")
        if collection is None:
            return ImportResult(stats={"total": 0, "imported": 0})

        for entry in collection.findall("ENTRY"):
            try:
                track = self._parse_entry(entry)
                tracks.append(track)
            except Exception as e:
                title = entry.get("TITLE", "unknown")
                warnings.append(f"Skipped '{title}': {e}")

        playlists = self._parse_playlists(root)

        return ImportResult(
            tracks=tracks,
            playlists=playlists,
            warnings=warnings,
            stats={"total": len(tracks), "imported": len(tracks), "skipped": len(warnings)},
        )

    def _parse_entry(self, entry: ET.Element) -> Track:
        title = entry.get("TITLE", "")
        artist = entry.get("ARTIST", "")

        # Location
        loc = entry.find("LOCATION")
        file_path = None
        source_id = None
        if loc is not None:
            dir_str = (loc.get("DIR") or "").replace("/:", "/")
            file_name = loc.get("FILE", "")
            file_path = dir_str + file_name
            volume = loc.get("VOLUME", "")
            source_id = f"{volume}{loc.get('DIR', '')}{file_name}"

        # Album
        album_el = entry.find("ALBUM")
        album = album_el.get("TITLE", "") if album_el is not None else ""

        # Info
        info = entry.find("INFO")
        genre = ""
        label = ""
        comments = ""
        rating = 0
        play_count = 0
        duration_ms = 0
        bitrate = 0
        if info is not None:
            genre = info.get("GENRE", "")
            label = info.get("LABEL", "")
            comments = info.get("COMMENT", "")
            rating = int(info.get("RATING", "0") or "0")
            play_count = int(info.get("PLAYCOUNT", "0") or "0")
            playtime = int(info.get("PLAYTIME", "0") or "0")
            duration_ms = playtime * 1000
            bitrate = int(info.get("BITRATE", "0") or "0")

        # BPM
        tempo_el = entry.find("TEMPO")
        bpm = float(tempo_el.get("BPM", "0")) if tempo_el is not None else 0.0

        # Key
        mk = entry.find("MUSICAL_KEY")
        key = ""
        if mk is not None:
            key_int = int(mk.get("VALUE", "-1"))
            key = TRAKTOR_KEY_MAP.get(key_int, "")
        camelot = key_to_camelot(key)

        # Cue points
        cue_points: list[CuePoint] = []
        for cue_el in entry.findall("CUE_V2"):
            cue_type_str = cue_el.get("TYPE", "0")
            cue_type = _NML_CUE_TYPE.get(cue_type_str, CueType.CUE)
            if cue_type == CueType.GRID:
                continue  # Skip grid markers for now
            start = float(cue_el.get("START", "0"))
            length = float(cue_el.get("LEN", "0"))
            hotcue = int(cue_el.get("HOTCUE", "-1"))
            cue_points.append(CuePoint(
                name=cue_el.get("NAME", ""),
                position_ms=start,
                type=cue_type,
                hotcue_index=hotcue,
                loop_end_ms=start + length if cue_type == CueType.LOOP else 0.0,
            ))

        return Track(
            title=title,
            artist=artist,
            album=album,
            file_path=file_path,
            bpm=bpm,
            key=key,
            camelot=camelot,
            genres=genre,
            label=label,
            comments=comments,
            rating=rating,
            play_count=play_count,
            duration_ms=duration_ms,
            cue_points=cue_points,
            bitrate=bitrate or None,
            source="traktor",
            source_id=source_id,
        )

    def _parse_playlists(self, root: ET.Element) -> dict[str, list[str]]:
        playlists: dict[str, list[str]] = {}
        playlists_node = root.find("PLAYLISTS")
        if playlists_node is None:
            return playlists
        for node in playlists_node.iter("NODE"):
            if node.get("TYPE") == "PLAYLIST":
                name = node.get("NAME", "")
                keys: list[str] = []
                playlist_el = node.find("PLAYLIST")
                if playlist_el is not None:
                    for entry in playlist_el.findall("ENTRY"):
                        pk = entry.find("PRIMARYKEY")
                        if pk is not None:
                            keys.append(pk.get("KEY", ""))
                if name and keys:
                    playlists[name] = keys
        return playlists


class TraktorExporter(ExportAdapter):
    def export(self, tracks: list[Track]) -> bytes:
        nml = ET.Element("NML", VERSION="19")
        ET.SubElement(nml, "HEAD", COMPANY="www.native-instruments.com", PROGRAM="djtoolkit")
        ET.SubElement(nml, "MUSICFOLDERS")

        collection = ET.SubElement(nml, "COLLECTION", ENTRIES=str(len(tracks)))
        for track in tracks:
            self._write_entry(collection, track)

        tree = ET.ElementTree(nml)
        ET.indent(tree, space="  ")
        return ET.tostring(nml, encoding="unicode", xml_declaration=True).encode("utf-8")

    def _write_entry(self, parent: ET.Element, track: Track) -> None:
        entry = ET.SubElement(parent, "ENTRY",
                              TITLE=track.title, ARTIST=track.artist)

        # Location (reconstruct Traktor path format)
        # NOTE: VOLUME is hardcoded to "Macintosh HD" — cross-platform export
        # would need to store the original volume from the import. Acceptable
        # for Phase 1a; revisit if Windows/Linux support is needed.
        if track.file_path:
            from pathlib import PurePosixPath
            p = PurePosixPath(track.file_path)
            dir_str = "/:" + "/:".join(p.parts[1:-1]) + "/:"
            ET.SubElement(entry, "LOCATION", DIR=dir_str, FILE=p.name,
                          VOLUME="Macintosh HD", VOLUMEID="")

        if track.album:
            ET.SubElement(entry, "ALBUM", TITLE=track.album)

        # Info
        info_attrs: dict[str, str] = {}
        if track.genres:
            info_attrs["GENRE"] = track.genres
        if track.label:
            info_attrs["LABEL"] = track.label
        if track.comments:
            info_attrs["COMMENT"] = track.comments
        if track.rating:
            info_attrs["RATING"] = str(track.rating)
        if track.play_count:
            info_attrs["PLAYCOUNT"] = str(track.play_count)
        if track.duration_ms:
            info_attrs["PLAYTIME"] = str(track.duration_ms // 1000)
        if info_attrs:
            ET.SubElement(entry, "INFO", **info_attrs)

        # BPM
        if track.bpm:
            ET.SubElement(entry, "TEMPO", BPM=f"{track.bpm:.2f}", BPM_QUALITY="100.0")

        # Key
        key_int = _KEY_TO_TRAKTOR.get(track.key)
        if key_int is not None:
            ET.SubElement(entry, "MUSICAL_KEY", VALUE=str(key_int))

        # Cue points
        _CUE_TYPE_TO_NML = {v: k for k, v in _NML_CUE_TYPE.items()}
        for i, cue in enumerate(track.cue_points):
            nml_type = _CUE_TYPE_TO_NML.get(cue.type, "0")
            length = cue.loop_end_ms - cue.position_ms if cue.type == CueType.LOOP else 0.0
            ET.SubElement(entry, "CUE_V2",
                          NAME=cue.name,
                          DISPL_ORDER=str(i),
                          TYPE=nml_type,
                          START=f"{cue.position_ms:.2f}",
                          LEN=f"{length:.1f}",
                          REPEATS="-1",
                          HOTCUE=str(cue.hotcue_index))
