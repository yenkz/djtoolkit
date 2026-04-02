# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for djtoolkit local agent (macOS arm64 + x86_64)."""

import os
import sys
from PyInstaller.utils.hooks import collect_submodules, collect_data_files, collect_all

# Detect fpcalc location based on arch
if os.uname().machine == "arm64":
    FPCALC_PATH = "/opt/homebrew/bin/fpcalc"
else:
    FPCALC_PATH = "/usr/local/bin/fpcalc"

if not os.path.exists(FPCALC_PATH):
    raise FileNotFoundError(
        f"fpcalc not found at {FPCALC_PATH}. Install with: brew install chromaprint"
    )

# collect_all returns (datas, binaries, hiddenimports) — use it for packages
# that collect_submodules fails to detect (e.g. typer in CI)
typer_datas, typer_binaries, typer_imports = collect_all("typer")
click_datas, click_binaries, click_imports = collect_all("click")
rich_datas, rich_binaries, rich_imports = collect_all("rich")

a = Analysis(
    ["../../djtoolkit/__main__.py"],
    pathex=[],
    binaries=[
        (FPCALC_PATH, "bin"),
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
    console=True,
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity="-",
    entitlements_file=None,
)
