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


def _localsystem_config_dir() -> Path:
    """Return the config dir LocalSystem services see (different from %APPDATA%).

    The Windows service runs as LocalSystem, whose %APPDATA% expands to
    ``C:\\Windows\\System32\\config\\systemprofile\\AppData\\Roaming``,
    not the installing user's profile. Credentials/config written by
    ``agent configure`` (running as the user) aren't visible to the
    service unless we copy them across.
    """
    import os
    sys_root = os.environ.get("SystemRoot", r"C:\Windows")
    return Path(sys_root) / "System32" / "config" / "systemprofile" / "AppData" / "Roaming" / "djtoolkit"


def _sync_user_config_to_localsystem() -> None:
    """Copy the installing user's credentials.json and config.toml into the
    LocalSystem profile so the service (running as LocalSystem) can read them.

    No-op on files that don't exist. Caller must have admin rights for the
    target path to be writable.
    """
    import shutil
    from djtoolkit.agent.paths import config_dir

    src_dir = config_dir()
    dst_dir = _localsystem_config_dir()
    if src_dir == dst_dir:
        return  # already running as LocalSystem; nothing to do
    try:
        dst_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        log.warning("Could not create LocalSystem config dir %s: %s", dst_dir, exc)
        return

    for name in ("credentials.json", "config.toml"):
        src = src_dir / name
        if not src.exists():
            continue
        try:
            shutil.copy2(src, dst_dir / name)
            log.info("Synced %s → %s", src, dst_dir / name)
        except OSError as exc:
            log.warning("Could not copy %s to %s: %s", src, dst_dir, exc)


def install() -> Path | None:
    """Install the agent as a Windows Service. Returns None (no plist on Windows)."""
    import win32serviceutil
    import win32service

    # Sync user credentials/config to LocalSystem profile BEFORE registering
    # the service — the service will start immediately after install and
    # needs creds to be present.
    _sync_user_config_to_localsystem()

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
                {
                    "ResetPeriod": 86400,
                    "RebootMsg": "",
                    "Command": "",
                    "Actions": actions,
                },
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

try:
    import win32serviceutil as _win32serviceutil
    _ServiceBase = _win32serviceutil.ServiceFramework
except ImportError:
    _ServiceBase = object  # type: ignore[assignment,misc]


class DJToolkitAgentService(_ServiceBase):
    """Windows Service entry point.

    Called by the SCM when the service starts/stops. Wraps the asyncio
    daemon loop and exposes shutdown via call_soon_threadsafe.
    """
    _svc_name_ = SERVICE_NAME
    _svc_display_name_ = DISPLAY_NAME

    def __init__(self, args):
        super().__init__(args)
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
        import traceback
        import win32service
        import servicemanager

        # Report RUNNING immediately so SCM doesn't time out (event 1053).
        # All heavy work (imports, config load, daemon loop) must happen AFTER
        # this — otherwise startup latency exceeds the 30s SCM grace window.
        self.ReportServiceStatus(win32service.SERVICE_RUNNING)
        servicemanager.LogInfoMsg(f"{SERVICE_NAME} starting")

        try:
            import asyncio
            import logging
            from djtoolkit.agent.daemon import run_daemon
            from djtoolkit.agent.paths import config_dir, log_dir
            from djtoolkit.config import load as load_config

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
        except BaseException as exc:
            # Surface any startup/runtime failure to the Windows Event Log —
            # otherwise the service vanishes silently.
            servicemanager.LogErrorMsg(
                f"{SERVICE_NAME} crashed: {type(exc).__name__}: {exc}\n"
                + traceback.format_exc()
            )
            raise


def service_main():
    """Entry point called by `djtoolkit agent service-entry`."""
    import servicemanager

    servicemanager.Initialize()
    servicemanager.PrepareToHostSingle(DJToolkitAgentService)
    servicemanager.StartServiceCtrlDispatcher()
