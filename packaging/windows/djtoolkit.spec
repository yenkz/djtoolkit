# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for djtoolkit local agent (Windows x86_64)."""

import os
import sys
from PyInstaller.utils.hooks import collect_submodules, collect_data_files, collect_all

# All paths resolved relative to repo root so the spec works regardless of CWD
REPO_ROOT = os.path.abspath(os.path.join(SPECPATH, "..", ".."))

# PyInstaller's module finder needs the venv's site-packages on its search path.
# Under `uv run`, sys.path alone doesn't always expose it — add it explicitly.
_venv_site_packages = []
_venv_dir = os.environ.get("VIRTUAL_ENV")
if _venv_dir:
    if sys.platform == "win32":
        _candidate = os.path.join(_venv_dir, "Lib", "site-packages")
        if os.path.isdir(_candidate):
            _venv_site_packages.append(_candidate)
    else:
        _lib_dir = os.path.join(_venv_dir, "lib")
        if os.path.isdir(_lib_dir):
            for _entry in os.listdir(_lib_dir):
                _candidate = os.path.join(_lib_dir, _entry, "site-packages")
                if os.path.isdir(_candidate):
                    _venv_site_packages.append(_candidate)
                    break
print(f"INFO: spec pathex venv_site_packages = {_venv_site_packages}")

# fpcalc.exe: env var (may be relative to repo root) or default location
FPCALC_PATH = os.environ.get("FPCALC_PATH", os.path.join("dist", "fpcalc.exe"))
if not os.path.isabs(FPCALC_PATH):
    FPCALC_PATH = os.path.join(REPO_ROOT, FPCALC_PATH)

if not os.path.exists(FPCALC_PATH):
    print(f"WARNING: fpcalc not found at {FPCALC_PATH}. It will not be bundled.")
    fpcalc_binaries = []
else:
    fpcalc_binaries = [(FPCALC_PATH, "bin")]

# Force-collect packages — editable installs / uv envs can confuse collect_submodules in CI
dj_datas, dj_binaries, dj_imports = collect_all("djtoolkit")
typer_datas, typer_binaries, typer_imports = collect_all("typer")
rich_datas, rich_binaries, rich_imports = collect_all("rich")

a = Analysis(
    [os.path.join(REPO_ROOT, "djtoolkit", "__main__.py")],
    pathex=[REPO_ROOT, *_venv_site_packages],
    binaries=[*fpcalc_binaries, *dj_binaries, *typer_binaries, *rich_binaries],
    datas=[
        *collect_data_files("librosa"),
        *collect_data_files("aioslsk"),
        *dj_datas,
        *typer_datas,
        *rich_datas,
    ],
    hiddenimports=[
        *dj_imports,
        *collect_submodules("djtoolkit"),
        *collect_submodules("aioslsk"),
        # Explicit agent commands — collect_submodules may miss these in CI
        "djtoolkit.agent.commands",
        "djtoolkit.agent.commands.browse_folder",
        "djtoolkit.agent.commands.scan_folder",
        # librosa optional backends
        "librosa.core",
        "librosa.beat",
        "librosa.feature",
        # crypto / auth
        "jose",
        "jose.jwt",
        "passlib.handlers.bcrypt",
        "cryptography.hazmat.primitives.kdf.pbkdf2",
        # Windows Credential Manager
        "keyring",
        "keyring.backends",
        "keyring.backends.Windows",
        # pywin32 for Windows Service
        "win32serviceutil",
        "win32service",
        "win32event",
        "servicemanager",
        # System tray
        "pystray",
        "pystray._win32",
        # typer / click / rich — force-collected above; imports listed for completeness
        *typer_imports,
        "click",
        *rich_imports,
        # httpx
        "httpx",
        "httpcore",
        # shellingham shell detection (Typer completion)
        *collect_submodules("shellingham"),
        # mutagen codecs
        "mutagen.mp3",
        "mutagen.flac",
        "mutagen.mp4",
        "mutagen.id3",
        # aioslsk protocol
        "aiofiles",
        "async_timeout",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[os.path.join(REPO_ROOT, "packaging", "windows", "runtime_hook_path.py")],
    excludes=[
        "fastapi",
        "uvicorn",
        "starlette",
        "asyncpg",
        "essentia",
        "tensorflow",
        "torch",
        "tkinter",
        "_tkinter",
        "IPython",
        "jupyter",
        # JIT deps — llvmlite bundles all of LLVM (~100MB); librosa falls back
        # to pure Python implementations when numba is not importable.
        "numba",
        "llvmlite",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="djtoolkit",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    target_arch=None,
    icon=(
        os.path.join(REPO_ROOT, "packaging", "windows", "assets", "icon.ico")
        if os.path.exists(os.path.join(REPO_ROOT, "packaging", "windows", "assets", "icon.ico"))
        else None
    ),
)
