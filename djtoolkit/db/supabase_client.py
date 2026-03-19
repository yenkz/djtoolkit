"""Supabase client factory.

Provides get_client() — the only entry point. All query logic lives in
adapters/supabase.py (SupabaseAdapter).
"""

import os

_client = None


def get_client():
    """Return a singleton Supabase client.

    Reads SUPABASE_PROJECT_URL (or SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY
    from environment. Import is lazy — supabase-py is not required for CLI-only usage.
    """
    global _client
    if _client is None:
        from supabase import create_client

        url = os.environ.get("SUPABASE_PROJECT_URL") or os.environ["SUPABASE_URL"]
        key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
        _client = create_client(url, key)
    return _client
