"""Agent daemon — main async event loop.

Runs heartbeat + job polling + execution as a long-lived background process.
Designed to be launched via launchd or ``djtoolkit agent run``.
"""

from __future__ import annotations

import asyncio
import logging
import signal
import sys
from typing import Any

from djtoolkit.agent.client import AgentClient, AgentRevoked
from djtoolkit.agent.executor import execute_job
from djtoolkit.agent.keychain import load_agent_credentials
from djtoolkit.agent.state import (
    save_job_state, load_orphaned_jobs, cleanup_job,
)
from djtoolkit.config import Config

log = logging.getLogger(__name__)

__version__ = "0.1.0"


def _detect_capabilities() -> list[str]:
    """Detect locally available capabilities."""
    caps = []

    try:
        import aioslsk  # noqa: F401
        caps.append("aioslsk")
    except ImportError:
        pass

    import shutil
    if shutil.which("fpcalc"):
        caps.append("fpcalc")

    try:
        import librosa  # noqa: F401
        caps.append("librosa")
    except ImportError:
        pass

    try:
        import essentia  # noqa: F401
        caps.append("essentia")
    except ImportError:
        pass

    return caps


async def run_daemon(cfg: Config) -> None:
    """Main daemon entry point. Runs until SIGTERM/SIGINT or key revocation."""

    # ── Load credentials ─────────────────────────────────────────────────
    creds = load_agent_credentials()
    api_key = creds.get("api_key")
    if not api_key:
        log.error("No API key found in keychain. Run 'djtoolkit agent configure' first.")
        sys.exit(1)

    client = AgentClient(
        cloud_url=cfg.agent.cloud_url,
        api_key=api_key,
    )
    capabilities = _detect_capabilities()
    max_concurrent = cfg.agent.max_concurrent_jobs
    poll_interval = cfg.agent.poll_interval_sec

    # ── Graceful shutdown ────────────────────────────────────────────────
    shutdown_event = asyncio.Event()
    active_tasks: set[asyncio.Task] = set()

    def _handle_signal(sig: signal.Signals) -> None:
        log.info("Received %s, shutting down gracefully…", sig.name)
        shutdown_event.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, _handle_signal, sig)

    # ── Recover orphaned jobs ────────────────────────────────────────────
    orphans = load_orphaned_jobs()
    if orphans:
        log.info("Re-reporting %d orphaned job result(s)…", len(orphans))
        for orphan in orphans:
            success = orphan["status"] == "completed"
            reported = await client.report_result(
                orphan["job_id"],
                success=success,
                result=orphan.get("result"),
                error=orphan.get("error"),
            )
            if reported:
                cleanup_job(orphan["job_id"])
                log.info("Re-reported orphan %s", orphan["job_id"])
            else:
                log.warning("Failed to re-report orphan %s, will retry later", orphan["job_id"])

    # ── Validate API key ─────────────────────────────────────────────────
    log.info("Validating API key…")
    try:
        ok = await client.heartbeat(capabilities, __version__, 0)
        if not ok:
            log.error("Initial heartbeat failed. Check your API key and cloud URL.")
            sys.exit(1)
    except AgentRevoked:
        log.error("API key has been revoked. Re-register the agent.")
        sys.exit(1)

    log.info(
        "Agent started — cloud=%s, capabilities=%s, max_jobs=%d, poll=%ds",
        cfg.agent.cloud_url, capabilities, max_concurrent, poll_interval,
    )

    # ── Job execution wrapper ────────────────────────────────────────────
    async def _run_job(job: dict) -> None:
        job_id = job["id"]
        job_type = job["job_type"]
        payload = job.get("payload") or {}

        log.info("Executing job %s (type=%s)", job_id, job_type)
        save_job_state(job_id, "claimed", payload)

        try:
            result = await execute_job(job_type, payload, cfg, creds)
            save_job_state(job_id, "completed", payload, result)
            reported = await client.report_result(job_id, success=True, result=result)
            if reported:
                cleanup_job(job_id)
                log.info("Job %s completed successfully", job_id)
            else:
                log.warning("Job %s completed but result report failed; saved locally", job_id)
        except Exception as exc:
            error_msg = f"{type(exc).__name__}: {exc}"
            log.error("Job %s failed: %s", job_id, error_msg)
            save_job_state(job_id, "failed", payload, {"error": error_msg})
            reported = await client.report_result(job_id, success=False, error=error_msg)
            if reported:
                cleanup_job(job_id)
            else:
                log.warning("Job %s failure report failed; saved locally", job_id)

    # ── Heartbeat loop ───────────────────────────────────────────────────
    async def _heartbeat_loop() -> None:
        while not shutdown_event.is_set():
            try:
                await client.heartbeat(
                    capabilities, __version__, len(active_tasks),
                )
            except AgentRevoked:
                log.error("API key revoked during heartbeat. Shutting down.")
                shutdown_event.set()
                return
            except Exception:
                log.warning("Heartbeat failed", exc_info=True)

            try:
                await asyncio.wait_for(
                    shutdown_event.wait(), timeout=poll_interval,
                )
                return  # shutdown requested
            except asyncio.TimeoutError:
                pass

    # ── Job poll loop ────────────────────────────────────────────────────
    async def _poll_loop() -> None:
        # Offset from heartbeat by half the interval
        try:
            await asyncio.wait_for(
                shutdown_event.wait(), timeout=poll_interval / 2,
            )
            return
        except asyncio.TimeoutError:
            pass

        while not shutdown_event.is_set():
            # Clean up completed tasks
            done = {t for t in active_tasks if t.done()}
            active_tasks.difference_update(done)

            slots = max_concurrent - len(active_tasks)
            if slots > 0:
                try:
                    jobs = await client.poll_jobs(limit=slots)
                except AgentRevoked:
                    log.error("API key revoked during poll. Shutting down.")
                    shutdown_event.set()
                    return

                for job in jobs:
                    claimed = await client.claim_job(job["id"])
                    if claimed:
                        task = asyncio.create_task(_run_job(claimed))
                        active_tasks.add(task)

            try:
                await asyncio.wait_for(
                    shutdown_event.wait(), timeout=poll_interval,
                )
                return
            except asyncio.TimeoutError:
                pass

    # ── Run loops ────────────────────────────────────────────────────────
    try:
        async with asyncio.TaskGroup() as tg:
            tg.create_task(_heartbeat_loop())
            tg.create_task(_poll_loop())
    except* AgentRevoked:
        log.error("API key revoked. Agent stopping.")
    finally:
        # Wait for active jobs to finish (up to 30s)
        if active_tasks:
            log.info("Waiting for %d active job(s) to finish…", len(active_tasks))
            _, pending = await asyncio.wait(active_tasks, timeout=30)
            for t in pending:
                t.cancel()

        await client.close()
        log.info("Agent stopped.")
