"""POST /parse — upload and parse a DJ collection file."""

import xml.etree.ElementTree as ET

from fastapi import APIRouter, Depends, HTTPException, UploadFile

from djtoolkit.adapters.supabase import SupabaseAdapter
from djtoolkit.adapters.traktor import TraktorImporter
from djtoolkit.adapters.rekordbox import RekordboxImporter
from djtoolkit.db.supabase_client import get_client
from djtoolkit.service.auth import get_current_user

router = APIRouter()


def _detect_format(data: bytes) -> str:
    """Detect collection format from XML root element."""
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        raise HTTPException(status_code=400, detail="Invalid XML format — could not parse file")

    tag = root.tag.upper()
    if tag == "NML":
        return "traktor"
    if tag == "DJ_PLAYLISTS":
        return "rekordbox"
    raise HTTPException(status_code=400, detail=f"Unknown collection format — root element: <{root.tag}>")


@router.post("/parse")
async def parse_collection(
    file: UploadFile,
    user_id: str = Depends(get_current_user),
):
    data = await file.read()

    fmt = _detect_format(data)

    if fmt == "traktor":
        result = TraktorImporter().parse(data)
    else:
        result = RekordboxImporter().parse(data)

    adapter = SupabaseAdapter(get_client())
    save_stats = adapter.save_tracks(result.tracks, user_id)

    return {
        "format": fmt,
        "tracks_imported": save_stats.get("imported", 0),
        "tracks_parsed": len(result.tracks),
        "playlists_found": len(result.playlists),
        "warnings": result.warnings,
    }
