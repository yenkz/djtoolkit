# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for djtoolkit Tauri sidecar (macOS, onedir mode).

Uses onedir mode so all native libraries are separate files on disk.
When bundled into the Tauri .app, codesign --deep signs everything in a
single consistent pass — no Team ID mismatch on macOS 15+.

The onefile variant (djtoolkit.spec) is kept for the legacy standalone installer.
"""

import os
import sys
from PyInstaller.utils.hooks import collect_submodules, collect_data_files

# fpcalc is bundled separately by the CI workflow, not by PyInstaller.
# The Tauri app has its own externalBin entry for fpcalc.

a = Analysis(
    ["../../djtoolkit/__main__.py"],
    pathex=[],
    binaries=[],
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
    runtime_hooks=[],
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
    [],
    exclude_binaries=True,
    name="djtoolkit",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    console=True,
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity="-",
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="djtoolkit",
)
