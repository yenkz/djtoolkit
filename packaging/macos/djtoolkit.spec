# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for djtoolkit (macOS, onedir mode).

Uses onedir mode to avoid the macOS 15 Team ID signing issue that breaks
onefile mode. All native libraries are separate files on disk, allowing
proper ad-hoc codesigning after the build.
"""

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

# Add venv site-packages AND repo root to pathex.
# In CI, djtoolkit is installed as editable (lives at repo root, not site-packages).
_venv_sp = os.environ.get("VENV_SITE_PACKAGES", "")
_repo_root = os.path.abspath(os.path.join(SPECPATH, "..", ".."))
_extra_paths = [p for p in [_venv_sp, _repo_root] if p]

# collect_all for packages that collect_submodules misses in CI
typer_datas, typer_binaries, typer_imports = collect_all("typer")
click_datas, click_binaries, click_imports = collect_all("click")
rich_datas, rich_binaries, rich_imports = collect_all("rich")
dj_datas, dj_binaries, dj_imports = collect_all("djtoolkit")
# librosa's BPM/key detection needs numba's JIT-compiled routines; numba
# depends on llvmlite's bundled shared library. Both must be collected in
# full — PyInstaller's default scan drops the native .so/.dll and misses
# numba's extensive submodule tree.
numba_datas, numba_binaries, numba_imports = collect_all("numba")
llvmlite_datas, llvmlite_binaries, llvmlite_imports = collect_all("llvmlite")

a = Analysis(
    ["../../djtoolkit/__main__.py"],
    pathex=_extra_paths,
    binaries=[
        (FPCALC_PATH, "bin"),
        *typer_binaries,
        *click_binaries,
        *rich_binaries,
        *dj_binaries,
        *numba_binaries,
        *llvmlite_binaries,
    ],
    datas=[
        *collect_data_files("librosa"),
        *collect_data_files("aioslsk"),
        *typer_datas,
        *click_datas,
        *rich_datas,
        *dj_datas,
        *numba_datas,
        *llvmlite_datas,
    ],
    hiddenimports=[
        *dj_imports,
        *collect_submodules("djtoolkit"),
        *collect_submodules("aioslsk"),
        *numba_imports,
        *llvmlite_imports,
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
        # System tray (menu bar)
        "rumps",
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
