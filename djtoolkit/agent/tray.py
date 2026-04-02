"""System tray integration — menu bar icon with agent status and controls.

Uses ``rumps`` on macOS and ``pystray`` on Windows. The tray runs on the
main thread (required by macOS AppKit) while the daemon runs in a background
thread.  ``djtoolkit agent tray`` launches both together as a single process.
"""

from __future__ import annotations

import asyncio
import logging
import sys
import threading
import time
import webbrowser
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger(__name__)

# ── Shared state between daemon thread and tray main thread ──────────────────


@dataclass
class TrayState:
    """Thread-safe shared state read by the tray, written by the daemon."""

    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    state: str = "starting"  # starting, idle, downloading, error, stopped
    active_jobs: int = 0
    last_heartbeat: float = 0.0
    error: str | None = None
    batch_total: int = 0
    batch_ok: int = 0
    batch_failed: int = 0
    session_downloaded: int = 0
    session_failed: int = 0

    def update(self, **kwargs) -> None:
        with self._lock:
            for k, v in kwargs.items():
                if hasattr(self, k):
                    setattr(self, k, v)

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "state": self.state,
                "active_jobs": self.active_jobs,
                "last_heartbeat": self.last_heartbeat,
                "error": self.error,
                "batch_total": self.batch_total,
                "batch_ok": self.batch_ok,
                "batch_failed": self.batch_failed,
                "session_downloaded": self.session_downloaded,
                "session_failed": self.session_failed,
            }


def _status_line(snap: dict) -> str:
    """Build a human-readable status string from a state snapshot."""
    state = snap["state"]
    if state == "downloading":
        done = snap["batch_ok"] + snap["batch_failed"]
        return f"Downloading ({done}/{snap['batch_total']})"
    if state == "idle":
        return "Idle — waiting for jobs"
    if state == "error":
        return f"Error: {snap.get('error', 'unknown')}"
    if state == "starting":
        return "Starting..."
    if state == "stopped":
        return "Stopped"
    return state.capitalize()


# ── Daemon thread ────────────────────────────────────────────────────────────


def _run_daemon_thread(
    cfg,
    tray_state: TrayState,
    shutdown_event_holder: list,
) -> None:
    """Target for the daemon background thread."""
    from djtoolkit.agent.daemon import run_daemon

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    shutdown_event = asyncio.Event()
    shutdown_event_holder.append((loop, shutdown_event))

    # Patch daemon status writes to also update tray state
    from djtoolkit.agent import state as state_mod
    _original_save = state_mod.save_daemon_status

    def _patched_save(status: dict) -> None:
        _original_save(status)
        tray_state.update(
            state=status.get("state", "idle"),
            active_jobs=status.get("active_jobs", 0),
            last_heartbeat=time.time(),
        )
        batch = status.get("batch")
        if batch:
            tray_state.update(
                batch_total=batch.get("total", 0),
                batch_ok=batch.get("ok", 0),
                batch_failed=batch.get("failed", 0),
            )
        totals = status.get("totals")
        if totals:
            tray_state.update(
                session_downloaded=totals.get("downloaded", 0),
                session_failed=totals.get("failed", 0),
            )

    state_mod.save_daemon_status = _patched_save

    try:
        loop.run_until_complete(run_daemon(cfg, shutdown_event=shutdown_event))
    except Exception as exc:
        log.error("Daemon thread crashed: %s", exc, exc_info=True)
        tray_state.update(state="error", error=str(exc))
    finally:
        tray_state.update(state="stopped")
        loop.close()


# ── macOS tray (rumps) ───────────────────────────────────────────────────────


def _run_macos_tray(tray_state: TrayState, shutdown_event_holder: list) -> None:
    """macOS menu bar app using rumps."""
    import rumps

    from djtoolkit.agent.paths import config_dir, log_dir

    class DJToolkitApp(rumps.App):
        def __init__(self):
            super().__init__("djtoolkit", title="DJ")
            self.menu = [
                rumps.MenuItem("Status: Starting..."),
                None,  # separator
                rumps.MenuItem("Open Dashboard", callback=self.open_dashboard),
                rumps.MenuItem("View Logs", callback=self.view_logs),
                None,
                rumps.MenuItem("Quit", callback=self.quit_app),
            ]
            # Update status every 3 seconds
            self._timer = rumps.Timer(self._update_status, 3)
            self._timer.start()

        def _update_status(self, _sender=None):
            snap = tray_state.snapshot()
            status_text = _status_line(snap)
            # Update the status menu item
            self.menu["Status: Starting..."]  # noqa — menu items are keyed by initial title
            # rumps doesn't support renaming easily, so we update the title
            keys = list(self.menu.keys())
            if keys:
                first_item = self.menu[keys[0]]
                first_item.title = f"Status: {status_text}"

            # Update icon title based on state
            state = snap["state"]
            if state == "downloading":
                self.title = "DJ ↓"
            elif state == "error":
                self.title = "DJ !"
            elif state == "idle":
                self.title = "DJ"
            else:
                self.title = "DJ"

        def open_dashboard(self, _sender=None):
            webbrowser.open("https://www.djtoolkit.net/pipeline")

        def view_logs(self, _sender=None):
            log_path = log_dir() / "agent.log"
            if log_path.exists():
                import subprocess
                subprocess.run(["open", "-a", "Console", str(log_path)])
            else:
                rumps.notification(
                    "djtoolkit",
                    "No log file",
                    f"Log not found at {log_path}",
                )

        def quit_app(self, _sender=None):
            # Signal daemon to shut down
            if shutdown_event_holder:
                loop, event = shutdown_event_holder[0]
                loop.call_soon_threadsafe(event.set)
            rumps.quit_application()

    DJToolkitApp().run()


# ── Windows tray (pystray) ───────────────────────────────────────────────────


def _run_windows_tray(tray_state: TrayState, shutdown_event_holder: list) -> None:
    """Windows system tray using pystray."""
    import pystray
    from PIL import Image, ImageDraw

    from djtoolkit.agent.paths import log_dir

    def _create_icon() -> Image.Image:
        """Create a simple tray icon."""
        img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        draw.ellipse([4, 4, 60, 60], fill=(59, 130, 246))  # blue circle
        draw.text((18, 16), "DJ", fill=(255, 255, 255))
        return img

    def _on_dashboard(icon, item):
        webbrowser.open("https://www.djtoolkit.net/pipeline")

    def _on_logs(icon, item):
        log_path = log_dir() / "agent.log"
        if log_path.exists():
            import os
            os.startfile(str(log_path))  # type: ignore[attr-defined]

    def _on_quit(icon, item):
        if shutdown_event_holder:
            loop, event = shutdown_event_holder[0]
            loop.call_soon_threadsafe(event.set)
        icon.stop()

    def _status_text(item):
        snap = tray_state.snapshot()
        return _status_line(snap)

    icon = pystray.Icon(
        "djtoolkit",
        _create_icon(),
        "djtoolkit Agent",
        menu=pystray.Menu(
            pystray.MenuItem(_status_text, None, enabled=False),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Open Dashboard", _on_dashboard),
            pystray.MenuItem("View Logs", _on_logs),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Quit", _on_quit),
        ),
    )
    icon.run()


# ── Entry point ──────────────────────────────────────────────────────────────


def run_tray(cfg) -> None:
    """Launch the tray icon (main thread) and daemon (background thread).

    This is the primary entry point for ``djtoolkit agent tray``.
    """
    tray_state = TrayState()
    shutdown_event_holder: list = []

    # Start daemon in background thread
    daemon_thread = threading.Thread(
        target=_run_daemon_thread,
        args=(cfg, tray_state, shutdown_event_holder),
        daemon=True,
        name="agent-daemon",
    )
    daemon_thread.start()

    # Run tray on main thread (required by macOS AppKit / Windows message pump)
    try:
        if sys.platform == "darwin":
            _run_macos_tray(tray_state, shutdown_event_holder)
        elif sys.platform == "win32":
            _run_windows_tray(tray_state, shutdown_event_holder)
        else:
            log.error("System tray not supported on %s. Use 'djtoolkit agent run' instead.", sys.platform)
            # Fall back to just running the daemon directly
            daemon_thread.join()
    except ImportError as exc:
        log.warning(
            "Tray library not available (%s). Falling back to headless daemon.",
            exc,
        )
        # If tray library isn't installed, just wait for daemon
        daemon_thread.join()
    finally:
        # Ensure daemon shuts down
        if shutdown_event_holder:
            loop, event = shutdown_event_holder[0]
            loop.call_soon_threadsafe(event.set)
        daemon_thread.join(timeout=30)
