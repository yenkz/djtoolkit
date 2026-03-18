import os
from unittest.mock import patch


def test_get_settings_reads_env():
    env = {
        "SUPABASE_URL": "https://test.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "test-key",
        "CORS_ORIGINS": "http://localhost:3000,https://djtoolkit.net",
    }
    with patch.dict(os.environ, env, clear=False):
        from djtoolkit.service.config import get_settings

        s = get_settings()
        assert s.supabase_url == "https://test.supabase.co"
        assert s.supabase_service_role_key == "test-key"
        assert s.cors_origins == ["http://localhost:3000", "https://djtoolkit.net"]


def test_get_settings_default_cors():
    env = {
        "SUPABASE_URL": "https://test.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "test-key",
    }
    with patch.dict(os.environ, env, clear=False):
        from djtoolkit.service.config import get_settings

        s = get_settings()
        assert isinstance(s.cors_origins, list)
        assert len(s.cors_origins) > 0
