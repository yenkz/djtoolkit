"""Windows Service integration — install/manage the agent as an NT service.

Requires pywin32 (Windows-only). This module is never imported on macOS/Linux.
"""
from __future__ import annotations

import logging
import sys
from pathlib import Path

log = logging.getLogger(__name__)

SERVICE_NAME = "DJToolkitAgent"
DISPLAY_NAME = "djtoolkit Agent"


def _resolve_binary() -> str:
    """Find the djtoolkit binary path for service registration."""
    if getattr(sys, "frozen", False):
        return sys.executable
    import shutil
    which = shutil.which("djtoolkit")
    if which:
        return which
    raise FileNotFoundError("djtoolkit binary not found in PATH")


def install() -> Path | None:
    """Install the agent as a Windows Service. Returns None (no plist on Windows)."""
    import win32serviceutil
    import win32service

    binary = _resolve_binary()
    win32serviceutil.InstallService(
        pythonClassString=None,
        serviceName=SERVICE_NAME,
        displayName=DISPLAY_NAME,
        startType=win32service.SERVICE_AUTO_START,
        exeName=binary,
        exeArgs="agent service-entry",
    )

    # Set recovery: restart on all failures with 60s delay
    scm = win32service.OpenSCManager(None, None, win32service.SC_MANAGER_ALL_ACCESS)
    try:
        svc = win32service.OpenService(scm, SERVICE_NAME, win32service.SERVICE_ALL_ACCESS)
        try:
            actions = [
                (win32service.SC_ACTION_RESTART, 60000),
                (win32service.SC_ACTION_RESTART, 60000),
                (win32service.SC_ACTION_RESTART, 60000),
            ]
            win32service.ChangeServiceConfig2(
                svc, win32service.SERVICE_CONFIG_FAILURE_ACTIONS,
                {"ResetPeriod": 86400, "Actions": actions}
            )
        finally:
            win32service.CloseServiceHandle(svc)
    finally:
        win32service.CloseServiceHandle(scm)

    start()
    log.info("Windows Service '%s' installed and started", SERVICE_NAME)
    return None


def uninstall() -> None:
    """Stop (if running) and remove the Windows Service."""
    import win32serviceutil

    if is_running():
        stop()

    win32serviceutil.RemoveService(SERVICE_NAME)
    log.info("Windows Service '%s' removed", SERVICE_NAME)


def start() -> None:
    """Start the Windows Service."""
    import win32serviceutil
    if not is_installed():
        raise FileNotFoundError(f"Service '{SERVICE_NAME}' is not installed")
    win32serviceutil.StartService(SERVICE_NAME)


def stop() -> None:
    """Stop the Windows Service."""
    import win32serviceutil
    if not is_installed():
        raise FileNotFoundError(f"Service '{SERVICE_NAME}' is not installed")
    win32serviceutil.StopService(SERVICE_NAME)


def is_installed() -> bool:
    """Check if the Windows Service is registered."""
    import win32service
    try:
        scm = win32service.OpenSCManager(None, None, win32service.SC_MANAGER_CONNECT)
        try:
            svc = win32service.OpenService(scm, SERVICE_NAME, win32service.SERVICE_QUERY_STATUS)
            win32service.CloseServiceHandle(svc)
            return True
        except win32service.error:
            return False
        finally:
            win32service.CloseServiceHandle(scm)
    except win32service.error:
        return False


def is_running() -> bool:
    """Check if the Windows Service is currently running."""
    import win32service
    try:
        scm = win32service.OpenSCManager(None, None, win32service.SC_MANAGER_CONNECT)
        try:
            svc = win32service.OpenService(scm, SERVICE_NAME, win32service.SERVICE_QUERY_STATUS)
            try:
                status = win32service.QueryServiceStatus(svc)
                return status[1] == win32service.SERVICE_RUNNING
            finally:
                win32service.CloseServiceHandle(svc)
        except win32service.error:
            return False
        finally:
            win32service.CloseServiceHandle(scm)
    except win32service.error:
        return False


# ── Service Framework (entry point for SCM) ────────────────────────────────

class DJToolkitAgentService:
    """Windows Service entry point.

    Called by the SCM when the service starts/stops. Wraps the asyncio
    daemon loop and exposes shutdown via call_soon_threadsafe.
    """
    _svc_name_ = SERVICE_NAME
    _svc_display_name_ = DISPLAY_NAME

    def __init__(self):
        import win32event
        self.stop_event = win32event.CreateEvent(None, 0, 0, None)
        self._loop = None
        self._shutdown_event = None

    def SvcStop(self):
        """Called by SCM to stop the service."""
        import win32service
        import servicemanager
        self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING)
        if self._loop and self._shutdown_event:
            self._loop.call_soon_threadsafe(self._shutdown_event.set)
        servicemanager.LogInfoMsg(f"{SERVICE_NAME} stopping")

    def SvcDoRun(self):
        """Called by SCM to start the service."""
        import asyncio
        import logging
        import servicemanager
        from djtoolkit.agent.daemon import run_daemon
        from djtoolkit.agent.paths import config_dir, log_dir
        from djtoolkit.config import load_config

        servicemanager.LogInfoMsg(f"{SERVICE_NAME} starting")

        logs = log_dir()
        logs.mkdir(parents=True, exist_ok=True)
        logging.basicConfig(
            level=logging.INFO,
            format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
            handlers=[logging.FileHandler(logs / "agent.log")],
        )

        cfg_path = str(config_dir() / "config.toml")
        cfg = load_config(cfg_path)

        self._shutdown_event = asyncio.Event()
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)

        try:
            self._loop.run_until_complete(
                run_daemon(cfg, shutdown_event=self._shutdown_event)
            )
        finally:
            self._loop.close()

        servicemanager.LogInfoMsg(f"{SERVICE_NAME} stopped")


def service_main():
    """Entry point called by `djtoolkit agent service-entry`."""
    import win32serviceutil
    import servicemanager

    win32serviceutil.HandleCommandLine(DJToolkitAgentService)
