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
from djtoolkit.agent.paths import config_dir
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

    # ── Raise FD soft limit (safety net for direct invocations / old plists)
    if sys.platform != "win32":
        import resource
        soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
        target = min(8192, hard) if hard != resource.RLIM_INFINITY else 8192
        if soft < target:
            try:
                resource.setrlimit(resource.RLIMIT_NOFILE, (target, hard))
                log.info("Raised FD soft limit: %d → %d", soft, target)
            except (ValueError, OSError) as exc:
                log.warning("Could not raise FD limit from %d: %s", soft, exc)

    # ── Load credentials ─────────────────────────────────────────────────
    creds = load_agent_credentials()
    api_key = creds.get("api_key")
    if not api_key:
        log.error("No API key found in keychain. Run 'djtoolkit agent configure' first.")
        return

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
            return
    except AgentRevoked:
        log.error("API key has been revoked. Re-register the agent.")
        return

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
        except Exception as exc:
            log.error("Download batch failed entirely: %s", exc, exc_info=True)
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

    # ── Realtime subscription ────────────────────────────────────────────
    realtime_wake = asyncio.Event()
    realtime_connected = False
    command_wake = asyncio.Event()

    async def _realtime_loop() -> None:
        """Subscribe to Supabase Realtime for instant job notifications.

        When a new pending pipeline_job is inserted (by the DB trigger),
        Realtime pushes an event and we immediately wake the poll loop.
        Falls back to polling-only if credentials are missing or on error.
        """
        nonlocal realtime_connected

        sb_url = creds.get("supabase_url")
        sb_anon_key = creds.get("supabase_anon_key")
        agent_email = creds.get("agent_email")
        agent_pw = creds.get("agent_password")

        if not all([sb_url, sb_anon_key, agent_email, agent_pw]):
            log.info("Realtime credentials not configured — using polling only")
            return

        from supabase import acreate_client
        from realtime import RealtimePostgresChangesListenEvent

        def _on_job_event(payload: Any) -> None:
            log.debug("Realtime: new pipeline_job event")
            realtime_wake.set()

        retry_delay = 5.0
        max_retry_delay = 60.0

        while not shutdown_event.is_set():
            sb_client = None
            try:
                sb_client = await acreate_client(sb_url, sb_anon_key)
                await sb_client.auth.sign_in_with_password({
                    "email": agent_email,
                    "password": agent_pw,
                })

                channel = sb_client.channel("agent-jobs")
                channel.on_postgres_changes(
                    RealtimePostgresChangesListenEvent.Insert,
                    _on_job_event,
                    table="pipeline_jobs",
                    schema="public",
                    filter="status=eq.pending",
                )
                await channel.subscribe()

                # Agent commands channel — instant wake for interactive requests
                def _on_command_event(payload: Any) -> None:
                    log.debug("Realtime: new agent_command event")
                    command_wake.set()

                cmd_channel = sb_client.channel("agent-commands")
                cmd_channel.on_postgres_changes(
                    RealtimePostgresChangesListenEvent.Insert,
                    _on_command_event,
                    table="agent_commands",
                    schema="public",
                    filter="status=eq.pending",
                )
                await cmd_channel.subscribe()

                realtime_connected = True
                retry_delay = 5.0
                log.info("Realtime subscription active")

                # Stay connected until shutdown
                await shutdown_event.wait()

            except Exception as exc:
                realtime_connected = False
                log.warning(
                    "Realtime connection failed: %s — retrying in %.0fs",
                    exc, retry_delay,
                )
                try:
                    await asyncio.wait_for(
                        shutdown_event.wait(), timeout=retry_delay,
                    )
                    return  # shutdown requested
                except asyncio.TimeoutError:
                    retry_delay = min(retry_delay * 2, max_retry_delay)
            finally:
                realtime_connected = False
                if sb_client:
                    try:
                        await sb_client.remove_all_channels()
                    except Exception:
                        pass
                    try:
                        await sb_client.auth.close()
                    except Exception:
                        pass

    async def _command_poll_loop() -> None:
        """Poll for agent commands (browse_folder, etc.) and execute inline."""
        from djtoolkit.agent.commands.browse_folder import browse_folder
        from djtoolkit.agent.commands.scan_folder import scan_folder

        while not shutdown_event.is_set():
            try:
                commands = await client.poll_commands(limit=5)
                for cmd in commands:
                    cmd_id = cmd["id"]
                    cmd_type = cmd.get("command_type", "")
                    payload = cmd.get("payload") or {}

                    await client.claim_command(cmd_id)

                    try:
                        match cmd_type:
                            case "browse_folder":
                                result = browse_folder(payload)
                            case "scan_folder":
                                result = scan_folder(payload)
                            case _:
                                raise ValueError(f"Unknown command: {cmd_type}")

                        await client.report_command_result(cmd_id, result=result)
                        log.info("Command %s completed: %s", cmd_type, cmd_id[:8])

                    except Exception as exc:
                        log.warning("Command %s failed: %s", cmd_id[:8], exc)
                        await client.report_command_result(cmd_id, error=str(exc))

            except Exception as exc:
                log.debug("Command poll error: %s", exc)

            # Wait for Realtime wake or poll interval
            try:
                await asyncio.wait_for(
                    asyncio.ensure_future(command_wake.wait()),
                    timeout=30.0 if not realtime_connected else 120.0,
                )
                command_wake.clear()
            except asyncio.TimeoutError:
                pass

            if shutdown_event.is_set():
                break

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
            # Check for pause flag file (managed by Tauri app)
            pause_file = config_dir() / "agent_paused"
            if pause_file.exists():
                log.info("Agent is paused (flag file exists), skipping poll cycle")
                try:
                    await asyncio.wait_for(
                        shutdown_event.wait(), timeout=poll_interval,
                    )
                    return
                except asyncio.TimeoutError:
                    continue

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
                    log.info(
                        "Claimed %d download job(s), starting batch",
                        len(download_jobs),
                    )
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

                if jobs:
                    log.info(
                        "Polled %d job(s): %s",
                        len(jobs),
                        ", ".join(f"{j['job_type']}({j['id'][:8]})" for j in jobs),
                    )

                for job in jobs:
                    if job.get("job_type") == "download":
                        continue  # handled by batch path
                    claimed = await client.claim_job(job["id"])
                    if claimed:
                        log.info(
                            "Claimed job %s (type=%s)",
                            claimed["id"][:8],
                            claimed.get("job_type", "?"),
                        )
                        task = asyncio.create_task(_run_job(claimed))
                        active_tasks.add(task)

            # Wait for shutdown, Realtime wake, or fallback timeout.
            # When Realtime is connected, use a longer fallback (120s)
            # since events are delivered instantly. Otherwise use the
            # configured poll interval.
            effective_interval = 120.0 if realtime_connected else poll_interval
            wake_task = asyncio.create_task(realtime_wake.wait())
            shutdown_task = asyncio.create_task(shutdown_event.wait())
            try:
                done_tasks, pending_tasks = await asyncio.wait(
                    {wake_task, shutdown_task},
                    timeout=effective_interval,
                    return_when=asyncio.FIRST_COMPLETED,
                )
            finally:
                for t in (wake_task, shutdown_task):
                    if not t.done():
                        t.cancel()

            if shutdown_event.is_set():
                return
            if realtime_wake.is_set():
                log.debug("Poll loop woken by Realtime event")
                realtime_wake.clear()

    # ── Run loops ────────────────────────────────────────────────────────
    try:
        async with asyncio.TaskGroup() as tg:
            tg.create_task(_heartbeat_loop())
            tg.create_task(_poll_loop())
            tg.create_task(_realtime_loop())
            tg.create_task(_command_poll_loop())
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
