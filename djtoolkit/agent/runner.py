"""djtoolkit local agent — polling loop and job dispatcher."""

from __future__ import annotations

import asyncio
import logging
import platform
import shutil
from pathlib import Path

from djtoolkit.config import Config
from djtoolkit.agent.client import AgentClient
from djtoolkit.agent import local_db
from djtoolkit.agent.jobs import download, fingerprint, metadata, cover_art

log = logging.getLogger(__name__)


def detect_capabilities() -> list[str]:
    """Detect which local processing capabilities are available."""
    caps: list[str] = []

    # aioslsk is always bundled with djtoolkit
    try:
        import aioslsk  # noqa: F401
        caps.append("aioslsk")
    except ImportError:
        pass

    # fpcalc binary for fingerprinting
    if shutil.which("fpcalc"):
        caps.append("fpcalc")

    # librosa for audio analysis (BPM/key)
    try:
        import librosa  # noqa: F401
        caps.append("librosa")
    except ImportError:
        pass

    # essentia-tensorflow for genre classification (optional, Linux/macOS x86_64 only)
    try:
        import essentia  # noqa: F401
        caps.append("essentia")
    except ImportError:
        pass

    return caps


async def _run_job(
    sem: asyncio.Semaphore,
    cfg: Config,
    client: AgentClient,
    conn,
    job: dict,
) -> None:
    job_id = job["id"]
    job_type = job["job_type"]
    payload = job.get("payload") or {}

    async with sem:
        log.info("[job:%s] starting %s", job_id, job_type)
        try:
            match job_type:
                case "download":
                    result = await download.run(cfg, payload)
                case "fingerprint":
                    result = await fingerprint.run(cfg, payload)
                case "metadata":
                    result = await metadata.run(cfg, payload)
                case "cover_art":
                    result = await cover_art.run(cfg, payload)
                case _:
                    raise ValueError(f"Unknown job_type: {job_type!r}")

            local_db.mark_done(conn, job_id)
            await client.report_result(job_id, success=True, result=result)
            log.info("[job:%s] done — %s", job_id, job_type)

        except Exception as exc:
            log.exception("[job:%s] failed — %s", job_id, exc)
            local_db.mark_failed(conn, job_id)
            await client.report_result(job_id, success=False, error=str(exc))


async def run_agent(cfg: Config) -> None:
    """Main agent polling loop. Runs until interrupted."""
    db_path = Path(cfg.agent.local_db_path).expanduser()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = local_db.init(db_path)

    client = AgentClient(cfg.agent.cloud_url, cfg.agent.api_key)
    machine = platform.node()
    caps = detect_capabilities()

    log.info("Agent starting — machine=%s capabilities=%s", machine, caps)
    log.info("Cloud URL: %s", cfg.agent.cloud_url)
    log.info("Poll interval: %.0fs  Max concurrent: %d", cfg.agent.poll_interval_sec, cfg.agent.max_concurrent_jobs)

    try:
        await client.heartbeat(machine, caps)
    except Exception as exc:
        log.error("Heartbeat failed — check cloud_url and api_key: %s", exc)
        raise

    sem = asyncio.Semaphore(cfg.agent.max_concurrent_jobs)

    try:
        while True:
            try:
                jobs = await client.fetch_jobs(limit=cfg.agent.max_concurrent_jobs)
            except Exception as exc:
                log.warning("fetch_jobs failed: %s — retrying in %.0fs", exc, cfg.agent.poll_interval_sec)
                await asyncio.sleep(cfg.agent.poll_interval_sec)
                continue

            for job in jobs:
                job_id = job["id"]
                if local_db.is_claimed(conn, job_id):
                    continue

                try:
                    claimed = await client.claim_job(job_id)
                except Exception as exc:
                    log.warning("[job:%s] claim request failed: %s", job_id, exc)
                    continue

                if claimed is None:
                    log.debug("[job:%s] already claimed by another agent", job_id)
                    continue

                local_db.mark_claimed(conn, job_id)
                asyncio.create_task(_run_job(sem, cfg, client, conn, claimed))

            await asyncio.sleep(cfg.agent.poll_interval_sec)

    finally:
        conn.close()
