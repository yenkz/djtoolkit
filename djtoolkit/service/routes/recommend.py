"""API routes for the recommendation engine."""

from __future__ import annotations

import uuid
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response

from djtoolkit.db.supabase_client import get_client
from djtoolkit.recommend.engine import RecommendationEngine
from djtoolkit.recommend.models import (
    SeedRequest,
    ExpandRequest,
    RefineRequest,
    ExportRequest,
    SeedResponse,
    ExpandResponse,
)
from djtoolkit.recommend.profiles import build_context_profile
from djtoolkit.service.auth import get_current_user

router = APIRouter()
_engine = RecommendationEngine()


def _load_analyzed_library(user_id: str) -> list[dict]:
    """Load all user tracks with relevant feature columns."""
    client = get_client()
    result = (
        client.table("tracks")
        .select("id,title,artist,album,tempo,energy,danceability,loudness,"
                "camelot,key_normalized,genres,enriched_audio,spotify_uri,"
                "cover_art_written,local_path,duration_ms,artwork_url,"
                "preview_url")
        .eq("user_id", user_id)
        .eq("acquisition_status", "available")
        .execute()
    )
    return result.data


@router.post("/recommend/seeds", response_model=SeedResponse)
async def generate_seeds(
    body: SeedRequest,
    user_id: str = Depends(get_current_user),
):
    client = get_client()

    venue_profile = None
    if body.venue_id:
        res = client.table("venues").select("target_profile,genres").eq("id", body.venue_id).execute()
        if not res.data:
            raise HTTPException(status_code=404, detail="Venue not found")
        venue_profile = res.data[0]["target_profile"]
        if res.data[0].get("genres"):
            venue_profile["genres"] = res.data[0]["genres"]

    mood_profile = None
    if body.mood_preset_id:
        res = client.table("mood_presets").select("target_profile").eq("id", body.mood_preset_id).execute()
        if not res.data:
            raise HTTPException(status_code=404, detail="Mood preset not found")
        mood_profile = res.data[0]["target_profile"]

    if not venue_profile and not mood_profile:
        raise HTTPException(status_code=400, detail="Provide venue_id or mood_preset_id")

    context_profile = build_context_profile(venue_profile, mood_profile, body.lineup_position)
    library = _load_analyzed_library(user_id)
    seeds, unanalyzed_count = _engine.generate_seeds(
        library, context_profile, return_unanalyzed_count=True
    )

    # Create session
    session_id = str(uuid.uuid4())
    client.table("recommendation_sessions").insert({
        "id": session_id,
        "user_id": user_id,
        "venue_id": body.venue_id,
        "mood_preset_id": body.mood_preset_id,
        "lineup_position": body.lineup_position,
        "context_profile": context_profile,
    }).execute()

    return SeedResponse(
        session_id=session_id,
        context_profile=context_profile,
        seeds=seeds,
        unanalyzed_count=unanalyzed_count,
    )


@router.post("/recommend/expand", response_model=ExpandResponse)
async def expand_seeds(
    body: ExpandRequest,
    user_id: str = Depends(get_current_user),
):
    client = get_client()

    res = client.table("recommendation_sessions").select("*").eq("id", body.session_id).eq("user_id", user_id).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="Session not found")
    session = res.data[0]

    feedback_dicts = [f.model_dump() for f in body.seed_feedback]
    client.table("recommendation_sessions").update({
        "seed_feedback": feedback_dicts
    }).eq("id", body.session_id).execute()

    library = _load_analyzed_library(user_id)
    result = _engine.expand(
        library,
        session["context_profile"],
        feedback_dicts,
    )

    result["tracks"] = _engine.order_by_energy_arc(
        result["tracks"], session["lineup_position"]
    )

    return ExpandResponse(**result)


@router.post("/recommend/refine", response_model=ExpandResponse)
async def refine_results(
    body: RefineRequest,
    user_id: str = Depends(get_current_user),
):
    client = get_client()

    res = client.table("recommendation_sessions").select("*").eq("id", body.session_id).eq("user_id", user_id).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="Session not found")
    session = res.data[0]

    library = _load_analyzed_library(user_id)
    original_feedback = session.get("seed_feedback", [])
    new_feedback = [f.model_dump() for f in body.feedback]

    result = _engine.refine(
        library,
        session["context_profile"],
        original_feedback,
        new_feedback,
    )

    result["tracks"] = _engine.order_by_energy_arc(
        result["tracks"], session["lineup_position"]
    )

    return ExpandResponse(**result)


@router.get("/recommend/sessions")
async def list_sessions(
    user_id: str = Depends(get_current_user),
):
    client = get_client()
    result = (
        client.table("recommendation_sessions")
        .select("id,venue_id,mood_preset_id,lineup_position,created_at")
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .limit(20)
        .execute()
    )
    return result.data


@router.post("/recommend/export")
async def export_playlist(
    body: ExportRequest,
    user_id: str = Depends(get_current_user),
):
    from djtoolkit.adapters.supabase import SupabaseAdapter
    from djtoolkit.adapters.m3u import M3UExporter
    from djtoolkit.models.track import Track

    client = get_client()

    if body.format not in ("m3u", "traktor", "rekordbox", "csv"):
        raise HTTPException(status_code=400, detail="Invalid format")

    res = client.table("recommendation_sessions").select("*").eq("id", body.session_id).eq("user_id", user_id).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="Session not found")

    session = res.data[0]
    feedback = session.get("seed_feedback", [])
    if not feedback:
        raise HTTPException(status_code=400, detail="No seed feedback — run expand first")

    library = _load_analyzed_library(user_id)
    result = _engine.expand(library, session["context_profile"], feedback)
    result["tracks"] = _engine.order_by_energy_arc(result["tracks"], session["lineup_position"])

    track_ids = [t["id"] for t in result["tracks"]]
    full_rows = client.table("tracks").select("*").in_("id", track_ids).execute()
    tracks = [Track.from_db_row(row) for row in full_rows.data]

    track_by_id = {t._id: t for t in tracks}
    ordered_tracks = [track_by_id[tid] for tid in track_ids if tid in track_by_id]

    playlist_name = body.playlist_name or f"Recommendation - {session['lineup_position']}"

    # Save playlist
    playlist_id = str(uuid.uuid4())
    client.table("playlists").insert({
        "id": playlist_id,
        "user_id": user_id,
        "name": playlist_name,
        "session_id": body.session_id,
    }).execute()

    playlist_track_rows = [
        {"playlist_id": playlist_id, "track_id": t._id, "position": i}
        for i, t in enumerate(ordered_tracks) if t._id
    ]
    if playlist_track_rows:
        client.table("playlist_tracks").insert(playlist_track_rows).execute()

    if body.format == "m3u":
        data = M3UExporter().export(ordered_tracks, playlist_name)
        return Response(content=data, media_type="audio/x-mpegurl; charset=utf-8",
                        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(playlist_name)}.m3u"})
    elif body.format == "csv":
        import csv
        import io
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=["position", "playlist_name", "title", "artist", "album", "bpm", "key", "camelot", "genres", "energy", "danceability"])
        writer.writeheader()
        for i, t in enumerate(ordered_tracks):
            writer.writerow({
                "position": i + 1, "playlist_name": playlist_name,
                "title": t.title, "artist": t.artist, "album": t.album,
                "bpm": t.bpm, "key": t.key, "camelot": t.camelot,
                "genres": t.genres, "energy": t.energy, "danceability": t.danceability,
            })
        return Response(content=buf.getvalue(), media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(playlist_name)}.csv"})
    elif body.format == "traktor":
        from djtoolkit.adapters.traktor import TraktorExporter
        data = TraktorExporter().export(ordered_tracks)
        return Response(content=data, media_type="application/xml; charset=utf-8",
                        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(playlist_name)}.nml"})
    else:  # rekordbox
        from djtoolkit.adapters.rekordbox import RekordboxExporter
        data = RekordboxExporter().export(ordered_tracks)
        return Response(content=data, media_type="application/xml; charset=utf-8",
                        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(playlist_name)}.xml"})
