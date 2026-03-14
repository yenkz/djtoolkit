# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for djtoolkit local agent (Windows x86_64)."""

import os
import sys
from PyInstaller.utils.hooks import collect_submodules, collect_data_files

# All paths resolved relative to repo root so the spec works regardless of CWD
REPO_ROOT = os.path.abspath(os.path.join(SPECPATH, "..", ".."))

# fpcalc.exe: env var (may be relative to repo root) or default location
FPCALC_PATH = os.environ.get("FPCALC_PATH", os.path.join("dist", "fpcalc.exe"))
if not os.path.isabs(FPCALC_PATH):
    FPCALC_PATH = os.path.join(REPO_ROOT, FPCALC_PATH)

if not os.path.exists(FPCALC_PATH):
    print(f"WARNING: fpcalc not found at {FPCALC_PATH}. It will not be bundled.")
    fpcalc_binaries = []
else:
    fpcalc_binaries = [(FPCALC_PATH, "bin")]

a = Analysis(
    [os.path.join(REPO_ROOT, "djtoolkit", "__main__.py")],
    pathex=[],
    binaries=fpcalc_binaries,
    datas=[
        *collect_data_files("librosa"),
        *collect_data_files("aioslsk"),
    ],
    hiddenimports=[
        *collect_submodules("djtoolkit"),
        *collect_submodules("aioslsk"),
        # librosa optional backends
        "librosa.core",
        "librosa.beat",
        "librosa.feature",
        "numba",
        "llvmlite",
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
        # typer / click internals
        "typer",
        "typer.main",
        "click",
        "rich",
        "rich.console",
        "rich.logging",
        "rich.progress",
        "rich.table",
        # httpx
        "httpx",
        "httpcore",
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
        "IPython",
        "jupyter",
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
    console=True,
    disable_windowed_traceback=False,
    target_arch=None,
    icon=os.path.join(REPO_ROOT, "packaging", "windows", "assets", "icon.ico"),
)
