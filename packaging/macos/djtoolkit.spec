# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for djtoolkit local agent (macOS arm64 + x86_64)."""

import os
import sys
from PyInstaller.utils.hooks import collect_submodules, collect_data_files

# Detect fpcalc location based on arch
if os.uname().machine == "arm64":
    FPCALC_PATH = "/opt/homebrew/bin/fpcalc"
else:
    FPCALC_PATH = "/usr/local/bin/fpcalc"

if not os.path.exists(FPCALC_PATH):
    raise FileNotFoundError(
        f"fpcalc not found at {FPCALC_PATH}. Install with: brew install chromaprint"
    )

a = Analysis(
    ["../../djtoolkit/__main__.py"],
    pathex=[],
    binaries=[
        (FPCALC_PATH, "bin"),
    ],
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
        # macOS Keychain access
        "keyring",
        "keyring.backends",
        "keyring.backends.macOS",
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
    runtime_hooks=["packaging/macos/runtime_hook_path.py"],
    excludes=[
        # Server-side deps not needed in local agent
        "fastapi",
        "uvicorn",
        "starlette",
        "asyncpg",
        # Heavy ML deps — optional, skip for base installer
        "essentia",
        "tensorflow",
        "torch",
        # GUI / notebook
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
    codesign_identity="-",
    entitlements_file=None,
)
