"""Supabase client factory.

Provides get_client() — the only entry point. All query logic lives in
adapters/supabase.py (SupabaseAdapter).
"""

import os

from supabase import Client, create_client

_client: Client | None = None


def get_client() -> Client:
    """Return a singleton Supabase client.

    Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from environment.
    """
    global _client
    if _client is None:
        url = os.environ["SUPABASE_URL"]
        key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
        _client = create_client(url, key)
    return _client
