"""POST /trackid/analyze — identify tracks in a DJ mix via Shazam.

Accepts a YouTube or SoundCloud URL, runs background analysis on the
Hetzner server, and writes results to the trackid_import_jobs table
in Supabase. The web UI polls the job status via its own status endpoint.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel

from djtoolkit.db.supabase_client import get_client
from djtoolkit.service.auth import get_current_user
from djtoolkit.service.analyzer import analyze_mix, deduplicate
from djtoolkit.utils.search_string import build as build_search_string

log = logging.getLogger(__name__)

router = APIRouter()


class AnalyzeRequest(BaseModel):
    url: str
    job_id: str
    confidence_threshold: float = 0.7
    preview: bool = True


class AnalyzeResponse(BaseModel):
    job_id: str
    status: str


# ─── URL validation ──────────────────────────────────────────────────────────

def _validate_mix_url(url: str) -> str:
    """Validate that the URL is a supported YouTube or SoundCloud URL.

    Returns the normalized URL. Raises HTTPException(400) on failure.
    """
    import urllib.parse
    import re

    if not url:
        raise HTTPException(status_code=400, detail="url is required")

    # YouTube
    yt_id_re = re.compile(r"^[A-Za-z0-9_-]{11}$")
    try:
        parsed = urllib.parse.urlparse(url)
        host = parsed.netloc.lower().removeprefix("www.")

        if host == "youtu.be":
            vid = parsed.path.lstrip("/").split("/")[0]
            if yt_id_re.match(vid):
                return f"https://www.youtube.com/watch?v={vid}"

        if host in ("youtube.com", "m.youtube.com"):
            if parsed.path.startswith("/embed/"):
                vid = parsed.path[len("/embed/"):].split("/")[0]
                if yt_id_re.match(vid):
                    return f"https://www.youtube.com/watch?v={vid}"
            qs = urllib.parse.parse_qs(parsed.query)
            vid = qs.get("v", [None])[0]
            if vid and yt_id_re.match(vid):
                return f"https://www.youtube.com/watch?v={vid}"

        # SoundCloud
        if host in ("soundcloud.com", "m.soundcloud.com"):
            path = parsed.path.strip("/")
            if "/" in path:
                return f"https://soundcloud.com/{path}"
    except Exception:
        pass

    raise HTTPException(
        status_code=400,
        detail="Unsupported URL — expected a YouTube or SoundCloud link",
    )


# ─── Endpoints ───────────────────────────────────────────────────────────────

@router.post("/trackid/analyze", response_model=AnalyzeResponse)
async def start_analysis(
    body: AnalyzeRequest,
    background_tasks: BackgroundTasks,
    user_id: str = Depends(get_current_user),
):
    """Submit a DJ mix URL for track identification.

    Creates a job in trackid_import_jobs, starts background analysis,
    and returns immediately with the job ID.
    """
    normalized_url = _validate_mix_url(body.url)

    client = get_client()

    # Create pending job in DB
    client.table("trackid_import_jobs").insert({
        "id": body.job_id,
        "user_id": user_id,
        "youtube_url": normalized_url,
        "status": "queued",
        "progress": 0,
        "step": "Queued for analysis…",
        "preview": body.preview,
    }).execute()

    # Start background analysis
    background_tasks.add_task(
        _run_analysis,
        job_id=body.job_id,
        url=normalized_url,
        user_id=user_id,
        confidence_threshold=body.confidence_threshold,
        preview=body.preview,
    )

    return AnalyzeResponse(job_id=body.job_id, status="queued")


# ─── Background task ─────────────────────────────────────────────────────────

async def _run_analysis(
    job_id: str,
    url: str,
    user_id: str,
    confidence_threshold: float,
    preview: bool,
):
    """Background task: analyze the mix, write results to Supabase."""
    client = get_client()

    def _update_job(updates: dict):
        updates["updated_at"] = datetime.now(timezone.utc).isoformat()
        client.table("trackid_import_jobs").update(updates).eq("id", job_id).execute()

    try:
        async def on_progress(pct: int, step: str):
            _update_job({"progress": pct, "step": step, "status": "analyzing"})

        # Run the full analysis pipeline
        tracks = await analyze_mix(
            url,
            cooldown_sec=2.5,
            on_progress=on_progress,
        )

        # Filter by confidence
        filtered = [t for t in tracks if t.get("confidence", 0) >= confidence_threshold]

        # Build preview tracks (same shape as the web UI expects)
        preview_tracks = []
        for t in filtered:
            artist = t.get("artist") or ""
            title = t.get("title") or ""
            duration_sec = t.get("duration", 0)
            duration_ms = int(duration_sec * 1000) if duration_sec else None
            search_string = build_search_string(artist, title) if (artist or title) else None
            key = f"{title.lower().strip()}|{artist.lower().strip()}"

            preview_tracks.append({
                "_key": key,
                "source": "trackid",
                "title": title,
                "artist": artist,
                "artists": artist,
                "duration_ms": duration_ms,
                "search_string": search_string,
                "timestamp": t.get("timestamp", 0),
                "confidence": t.get("confidence", 0),
                "preview_url": t.get("preview_url") or None,
                "artwork_url": t.get("artwork_url") or None,
                "already_owned": False,
            })

        # Cache the results for future requests
        cache_tracks = [
            {
                "title": t.get("title"),
                "artist": t.get("artist"),
                "artists": t.get("artist"),
                "duration_ms": int(t.get("duration", 0) * 1000) if t.get("duration") else None,
                "search_string": build_search_string(t.get("artist", ""), t.get("title", "")) or None,
                "preview_url": t.get("preview_url") or None,
                "artwork_url": t.get("artwork_url") or None,
            }
            for t in filtered
        ]
        client.table("trackid_url_cache").upsert({
            "youtube_url": url,
            "tracks": cache_tracks,
            "track_count": len(cache_tracks),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }, on_conflict="youtube_url").execute()

        # Build result object
        result_obj = {"tracks": preview_tracks, "total": len(preview_tracks)}

        _update_job({
            "status": "completed",
            "progress": 100,
            "step": f"Done — {len(preview_tracks)} track{'s' if len(preview_tracks) != 1 else ''} identified",
            "result": json.dumps(result_obj),
        })

        log.info("Job %s completed: %d tracks identified for %s", job_id, len(preview_tracks), url)

    except Exception as e:
        log.exception("Job %s failed: %s", job_id, e)
        _update_job({
            "status": "failed",
            "progress": 0,
            "step": "Failed",
            "error": str(e),
        })
