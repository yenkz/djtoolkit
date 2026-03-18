"""GET /export/{format} — export track collection as downloadable file."""

import csv
import io
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response

from djtoolkit.adapters.supabase import SupabaseAdapter
from djtoolkit.adapters.traktor import TraktorExporter
from djtoolkit.adapters.rekordbox import RekordboxExporter
from djtoolkit.db.supabase_client import get_client
from djtoolkit.models.track import Track
from djtoolkit.service.auth import get_current_user

router = APIRouter()

VALID_FORMATS = {"traktor", "rekordbox", "csv"}

CSV_COLUMNS = [
    "title", "artist", "album", "bpm", "key", "camelot",
    "genres", "duration_ms", "energy", "danceability", "rating",
]


def _tracks_to_csv(tracks: list[Track]) -> bytes:
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=CSV_COLUMNS)
    writer.writeheader()
    for t in tracks:
        writer.writerow({col: getattr(t, col, "") for col in CSV_COLUMNS})
    return buf.getvalue().encode("utf-8")


@router.get("/export/{format}")
async def export_collection(
    format: str,
    genre: Optional[str] = None,
    user_id: str = Depends(get_current_user),
):
    if format not in VALID_FORMATS:
        raise HTTPException(status_code=400, detail=f"Unsupported format: {format}. Use: {', '.join(sorted(VALID_FORMATS))}")

    adapter = SupabaseAdapter(get_client())
    filters = {"genres": genre} if genre else None
    tracks = adapter.load_tracks(user_id, filters=filters)

    if format == "traktor":
        data = TraktorExporter().export(tracks)
        return Response(
            content=data,
            media_type="application/xml; charset=utf-8",
            headers={"Content-Disposition": "attachment; filename=collection.nml"},
        )

    if format == "rekordbox":
        data = RekordboxExporter().export(tracks)
        return Response(
            content=data,
            media_type="application/xml; charset=utf-8",
            headers={"Content-Disposition": "attachment; filename=rekordbox.xml"},
        )

    # CSV
    data = _tracks_to_csv(tracks)
    return Response(
        content=data,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=tracks.csv"},
    )
