"""API routes for venues and mood presets."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from djtoolkit.db.supabase_client import get_client
from djtoolkit.service.auth import get_current_user

router = APIRouter()


@router.get("/venues")
async def list_venues(
    country: Optional[str] = None,
    user_id: str = Depends(get_current_user),
):
    client = get_client()
    query = client.table("venues").select("*").order("name")
    if country:
        query = query.ilike("country", country)
    result = query.execute()
    return result.data


@router.get("/venues/{venue_id}")
async def get_venue(
    venue_id: str,
    user_id: str = Depends(get_current_user),
):
    client = get_client()
    result = client.table("venues").select("*").eq("id", venue_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Venue not found")
    return result.data[0]


@router.get("/mood-presets")
async def list_mood_presets(
    user_id: str = Depends(get_current_user),
):
    client = get_client()
    result = client.table("mood_presets").select("*").order("category").order("name").execute()
    return result.data
