# Windows CLI Fixes: PyInstaller Bundling + Terminal Setup Wizard

**Date**: 2026-03-19
**Status**: Approved

## Problem

Two issues with the Windows build of djtoolkit:

1. **`djtoolkit --install-completion` crashes** with `ModuleNotFoundError: No module named 'shellingham.nt'`. PyInstaller doesn't bundle the conditionally-imported `shellingham.nt` submodule that Typer needs for shell detection on Windows (NT platform).

2. **`djtoolkit setup` prints "Setup Assistant not found"** because no Windows GUI equivalent of the macOS SwiftUI Setup Assistant exists. The CLI searches for `DJToolkit Setup.exe` which was never built.

## Solution

### Fix 1: Add shellingham to PyInstaller hiddenimports

Add `shellingham` submodules to both platform specs so PyInstaller bundles them:

**Windows spec** (`packaging/windows/djtoolkit.spec`):
```python
"shellingham",
"shellingham.nt",
"shellingham.posix",
```

**macOS spec** (`packaging/macos/djtoolkit.spec`):
```python
"shellingham",
"shellingham.posix",
```

### Fix 2: Interactive terminal setup wizard

Add a Rich-based terminal wizard as a fallback when the GUI app isn't found. Uses Rich `Panel`, `Table`, and `typer.prompt()` — no new dependencies.

#### Wizard flow (6 steps, mirrors macOS GUI)

| Step | Screen | Details |
|------|--------|---------|
| 1 | **Welcome** | Rich panel: app name, description, "Let's get you set up" |
| 2 | **API Key** | Explains where to get it (web dashboard URL), prompts for `djt_xxx`, validates prefix |
| 3 | **Soulseek** | Explains purpose, prompts username + password (hidden input) |
| 4 | **AcoustID** | Explains it's optional (fingerprint dedup), prompts key or Enter to skip |
| 5 | **Confirm** | Rich table summarizing values (password masked), "Look good? [Y/n]" — if no, restart from step 2 |
| 6 | **Done** | Stores credentials via `store_agent_credentials()`, writes `config.toml`, shows success panel with next step: `djtoolkit agent install` |

#### Code location

- New function `_setup_terminal_wizard()` in `djtoolkit/__main__.py`
- Called by existing `setup_wizard()` as fallback when GUI app not found (replaces the error message)
- Reuses `store_agent_credentials()` from `djtoolkit/agent/keychain.py`
- Reuses config-writing logic from `agent_configure()` command

#### Behavior change in `setup_wizard()`

```
Before:  GUI not found → print error + "Use djtoolkit agent configure --api-key djt_xxx"
After:   GUI not found → call _setup_terminal_wizard()
```

The GUI path remains preferred — if the `.app` (macOS) or `.exe` (Windows) exists, it still launches that.

## Files Changed

| File | Change |
|------|--------|
| `packaging/windows/djtoolkit.spec` | Add `shellingham`, `shellingham.nt`, `shellingham.posix` to `hiddenimports` |
| `packaging/macos/djtoolkit.spec` | Add `shellingham`, `shellingham.posix` to `hiddenimports` |
| `djtoolkit/__main__.py` | Add `_setup_terminal_wizard()`, update `setup_wizard()` fallback |

## Files NOT Changed

- `packaging/windows/build.ps1` — no changes needed
- `packaging/macos/build.sh` — no changes needed
- `packaging/windows/djtoolkit.wxs` — WiX config unchanged
- `djtoolkit/agent/keychain.py` — reused as-is
- Agent configure commands — unchanged, wizard reuses their logic

## Testing

Manual verification:
- Run `djtoolkit setup` on a machine without the GUI app → terminal wizard should launch
- Walk through all 6 steps, verify credentials stored in system credential store
- Verify config.toml written to correct location
- Run `djtoolkit --install-completion` on Windows → should detect PowerShell, not crash
- Confirm "no" at step 5 → should restart from step 2
- Enter invalid API key (no `djt_` prefix) → should show error and re-prompt
