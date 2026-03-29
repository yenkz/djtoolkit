# tests/test_folder_import_job.py
"""Tests for folder_import agent job."""

import pytest
from pathlib import Path
from unittest.mock import MagicMock, patch


@pytest.fixture
def audio_folder(tmp_path: Path) -> Path:
    """Create temp folder with tagged audio files."""
    (tmp_path / "song1.mp3").write_bytes(b"\x00" * 1024)
    (tmp_path / "song2.flac").write_bytes(b"\x00" * 2048)
    (tmp_path / "notes.txt").write_bytes(b"not audio")
    return tmp_path


@pytest.fixture
def mock_supabase():
    """Mock Supabase client with chained method calls."""
    sb = MagicMock()
    # auth mock
    sb.auth.sign_in_with_password.return_value = MagicMock()
    sb.auth.sign_out.return_value = None
    # table mock: tracks.select().eq().eq().execute() returns empty (no existing)
    select_chain = MagicMock()
    select_chain.eq.return_value = select_chain
    select_chain.execute.return_value = MagicMock(data=[])
    # table mock: tracks.insert().select().single().execute() returns new track
    insert_chain = MagicMock()
    insert_chain.select.return_value = insert_chain
    insert_chain.single.return_value = insert_chain
    insert_chain.execute.return_value = MagicMock(data={"id": 42})
    # pipeline_jobs insert
    pj_insert = MagicMock()
    pj_insert.execute.return_value = MagicMock(data={"id": "job-1"})

    def table_router(name):
        mock = MagicMock()
        if name == "tracks":
            mock.select.return_value = select_chain
            mock.insert.return_value = insert_chain
        elif name == "pipeline_jobs":
            mock.insert.return_value = pj_insert
        return mock

    sb.table.side_effect = table_router
    return sb


@pytest.mark.asyncio
async def test_folder_import_scans_audio_files(audio_folder, mock_supabase):
    from djtoolkit.agent.jobs.folder_import import run
    from djtoolkit.config import Config

    cfg = Config()

    with patch("djtoolkit.agent.jobs.folder_import.create_client", return_value=mock_supabase):
        result = await run(cfg, {
            "path": str(audio_folder),
            "user_id": "test-user-id",
            "recursive": True,
        }, {
            "supabase_url": "https://test.supabase.co",
            "supabase_anon_key": "test-key",
            "agent_email": "agent@test.com",
            "agent_password": "pass",
        })

    # Should find 2 audio files, skip .txt
    assert result["inserted"] == 2
    assert result["path"] == str(audio_folder)
    assert len(result["track_ids"]) == 2


@pytest.mark.asyncio
async def test_folder_import_empty_folder(tmp_path, mock_supabase):
    from djtoolkit.agent.jobs.folder_import import run
    from djtoolkit.config import Config

    cfg = Config()

    with patch("djtoolkit.agent.jobs.folder_import.create_client", return_value=mock_supabase):
        result = await run(cfg, {
            "path": str(tmp_path),
            "user_id": "test-user-id",
        }, {
            "supabase_url": "https://test.supabase.co",
            "supabase_anon_key": "test-key",
            "agent_email": "agent@test.com",
            "agent_password": "pass",
        })

    assert result["inserted"] == 0
    assert result["track_ids"] == []
