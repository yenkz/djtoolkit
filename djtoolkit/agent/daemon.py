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
from djtoolkit.agent.executor import execute_job, execute_download_batch, shutdown_slsk_client
from djtoolkit.agent.keychain import load_agent_credentials
from djtoolkit.agent.state import (
    save_job_state, load_orphaned_jobs, cleanup_job,
    save_daemon_status, clear_daemon_status, record_recent_job,
)
from djtoolkit.config import Config

log = logging.getLogger(__name__)

__version__ = "0.1.0"


def _setup_signal_handlers(
    loop: asyncio.AbstractEventLoop,
    shutdown_event: asyncio.Event,
) -> None:
    """Register SIGTERM/SIGINT handlers to trigger graceful shutdown.

    On Windows, ``loop.add_signal_handler`` is not supported, so this is a
    no-op — Windows callers rely on ``KeyboardInterrupt`` or the service
    control manager to stop the daemon.
    """
    if sys.platform == "win32":
        return

    def _handle_signal(sig: signal.Signals) -> None:
        log.info("Received %s, shutting down gracefully…", sig.name)
        shutdown_event.set()

    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, _handle_signal, sig)


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


async def run_daemon(
    cfg: Config,
    shutdown_event: asyncio.Event | None = None,
) -> None:
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
    shutdown_event = shutdown_event or asyncio.Event()
    active_tasks: set[asyncio.Task] = set()

    loop = asyncio.get_running_loop()
    _setup_signal_handlers(loop, shutdown_event)

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
    save_daemon_status({
        "state": "idle",
        "capabilities": capabilities,
        "active_jobs": 0,
        "batch": None,
        "totals": {"downloaded": 0, "failed": 0, "batches": 0},
    })

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
            record_recent_job(
                title=payload.get("title", ""),
                artist=payload.get("artist", ""),
                job_type=job_type,
                status="completed",
            )
            if reported:
                cleanup_job(job_id)
                log.info("Job %s completed successfully", job_id)
            else:
                log.warning("Job %s completed but result report failed; saved locally", job_id)
        except Exception as exc:
            error_msg = f"{type(exc).__name__}: {exc}"
            log.error("Job %s failed: %s", job_id, error_msg)
            record_recent_job(
                title=payload.get("title", ""),
                artist=payload.get("artist", ""),
                job_type=job_type,
                status="failed",
            )
            save_job_state(job_id, "failed", payload, {"error": error_msg})
            reported = await client.report_result(job_id, success=False, error=error_msg)
            if reported:
                cleanup_job(job_id)
            else:
                log.warning("Job %s failure report failed; saved locally", job_id)

    # ── Batch download wrapper ────────────────────────────────────────────
    batch_totals = {"downloaded": 0, "failed": 0, "batches": 0}

    async def _run_download_batch(jobs: list[dict]) -> None:
        """Execute a batch of download jobs and report results individually."""
        job_ids = [j["id"] for j in jobs]
        log.info("Starting download batch: %d jobs (%s...)", len(jobs), job_ids[0][:8])

        for job in jobs:
            save_job_state(job["id"], "claimed", job.get("payload") or {})

        batch_ok = 0
        batch_fail = 0

        save_daemon_status({
            "state": "downloading",
            "active_jobs": len(active_tasks),
            "batch": {
                "total": len(jobs),
                "phase": "connecting",
                "ok": 0, "failed": 0,
            },
            "totals": batch_totals,
        })

        async def _report(job_id, success, result, error):
            nonlocal batch_ok, batch_fail
            if success:
                save_job_state(job_id, "completed", {}, result)
                batch_ok += 1
                batch_totals["downloaded"] += 1
            else:
                save_job_state(job_id, "failed", {}, {"error": error})
                batch_fail += 1
                batch_totals["failed"] += 1

            reported = await client.report_result(
                job_id, success=success, result=result, error=error,
            )
            if reported:
                cleanup_job(job_id)
            else:
                log.warning("Job %s result report failed; saved locally", job_id)

            # Update status after each track completes
            save_daemon_status({
                "state": "downloading",
                "active_jobs": len(active_tasks),
                "batch": {
                    "total": len(jobs),
                    "phase": "downloading",
                    "ok": batch_ok, "failed": batch_fail,
                },
                "totals": batch_totals,
            })

        reported_ids: set[str] = set()

        async def _tracking_report(job_id, success, result, error):
            reported_ids.add(job_id)
            job_meta = next((j for j in jobs if j["id"] == job_id), {})
            job_payload = job_meta.get("payload") or {}
            record_recent_job(
                title=job_payload.get("title", ""),
                artist=job_payload.get("artist", ""),
                job_type="download",
                status="completed" if success else "failed",
            )
            await _report(job_id, success, result, error)

        def _update_phase(phase: str):
            save_daemon_status({
                "state": "downloading",
                "active_jobs": len(active_tasks),
                "batch": {
                    "total": len(jobs),
                    "phase": phase,
                    "ok": batch_ok, "failed": batch_fail,
                },
                "totals": batch_totals,
            })

        try:
            await execute_download_batch(
                jobs, cfg, creds,
                report_fn=_tracking_report,
                status_fn=_update_phase,
            )
        except Exception:
            log.exception("Download batch failed entirely")
            for job in jobs:
                jid = job["id"]
                if jid in reported_ids:
                    continue
                save_job_state(jid, "failed", {}, {"error": "Batch execution failed"})
                await client.report_result(jid, success=False, error="Batch execution failed")
                cleanup_job(jid)
                batch_fail += 1
                batch_totals["failed"] += 1

        batch_totals["batches"] += 1
        log.info(
            "Download batch finished: %d ok, %d failed (cumulative: %d ok, %d failed across %d batches)",
            batch_ok, batch_fail,
            batch_totals["downloaded"], batch_totals["failed"], batch_totals["batches"],
        )
        save_daemon_status({
            "state": "idle",
            "active_jobs": len(active_tasks) - 1,  # this task is about to end
            "batch": None,
            "totals": batch_totals,
        })

        # Brief cooldown before next batch — gives the Soulseek server time
        # to accept a new connection after the previous one was closed.
        await asyncio.sleep(10)

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

            # ── Batch-claim download jobs ─────────────────────────────────
            download_batch_running = any(
                t.get_name() == "download-batch" for t in active_tasks
            )
            if not download_batch_running:
                download_jobs = await client.batch_claim_downloads(
                    limit=cfg.agent.max_download_batch,
                )
                if download_jobs:
                    task = asyncio.create_task(
                        _run_download_batch(download_jobs),
                        name="download-batch",
                    )
                    active_tasks.add(task)

            # ── Individual jobs (non-download) ────────────────────────────
            slots = max_concurrent - len(active_tasks)
            if slots > 0:
                try:
                    jobs = await client.poll_jobs(limit=slots)
                except AgentRevoked:
                    log.error("API key revoked during poll. Shutting down.")
                    shutdown_event.set()
                    return

                for job in jobs:
                    if job.get("job_type") == "download":
                        continue  # handled by batch path
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

        await shutdown_slsk_client()
        await client.close()
        clear_daemon_status()
        log.info("Agent stopped.")
