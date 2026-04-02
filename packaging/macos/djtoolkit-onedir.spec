# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for djtoolkit Tauri sidecar (macOS, onedir mode).

Uses onedir mode so all native libraries are separate files on disk.
When bundled into the Tauri .app, codesign --deep signs everything in a
single consistent pass — no Team ID mismatch on macOS 15+.

The onefile variant (djtoolkit.spec) is kept for the legacy standalone installer.
"""

import os
import sys
from PyInstaller.utils.hooks import collect_submodules, collect_data_files, collect_all

# fpcalc is bundled separately by the CI workflow, not by PyInstaller.
# The Tauri app has its own externalBin entry for fpcalc.

# Add venv site-packages to pathex (CI fix — same as djtoolkit.spec)
_venv_sp = os.environ.get("VENV_SITE_PACKAGES", "")
_extra_paths = [_venv_sp] if _venv_sp else []

# collect_all for packages that collect_submodules misses in CI
typer_datas, typer_binaries, typer_imports = collect_all("typer")
click_datas, click_binaries, click_imports = collect_all("click")
rich_datas, rich_binaries, rich_imports = collect_all("rich")

a = Analysis(
    ["../../djtoolkit/__main__.py"],
    pathex=_extra_paths,
    binaries=[
        *typer_binaries,
        *click_binaries,
        *rich_binaries,
    ],
    datas=[
        *collect_data_files("librosa"),
        *collect_data_files("aioslsk"),
        *typer_datas,
        *click_datas,
        *rich_datas,
    ],
    hiddenimports=[
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
        # macOS Keychain access
        "keyring",
        "keyring.backends",
        "keyring.backends.macOS",
        # typer / click / rich
        *typer_imports,
        *click_imports,
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
