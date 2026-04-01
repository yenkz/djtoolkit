"""Supabase client factory.

Provides get_client() — the only entry point. All query logic lives in
adapters/supabase.py (SupabaseAdapter).
"""

import os

_client = None


def reset_client():
    """Clear the singleton so the next get_client() creates a fresh connection."""
    global _client
    _client = None


def get_client():
    """Return a singleton Supabase client.

    Reads SUPABASE_PROJECT_URL (or SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY
    from environment. Import is lazy — supabase-py is not required for CLI-only usage.
    """
    global _client
    if _client is None:
        from supabase import create_client

        url = os.environ.get("SUPABASE_PROJECT_URL") or os.environ.get("SUPABASE_URL")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        missing = []
        if not url:
            missing.append("SUPABASE_PROJECT_URL")
        if not key:
            missing.append("SUPABASE_SERVICE_ROLE_KEY")
        if missing:
            raise SystemExit(
                f"Missing required env var(s): {', '.join(missing)}\n"
                "Set them in .env or environment. See .env.example for details."
            )
        _client = create_client(url, key)
    return _client
