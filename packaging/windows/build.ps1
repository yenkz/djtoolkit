# packaging/windows/build.ps1
# Build djtoolkit Windows MSI installer
# Run from repo root: powershell -ExecutionPolicy Bypass -File packaging/windows/build.ps1
param(
    [string]$Version = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $Version) {
    $Version = (poetry version -s)
}

Write-Host "Building djtoolkit $Version for Windows x86_64"

# ── 1. Download fpcalc.exe if not present ──────────────────────────────────
$FpcalcPath = "dist\fpcalc.exe"
if (-not (Test-Path $FpcalcPath)) {
    Write-Host "Downloading fpcalc.exe..."
    $chromaprintVersion = "1.5.1"
    $url = "https://github.com/acoustid/chromaprint/releases/download/v${chromaprintVersion}/chromaprint-fpcalc-${chromaprintVersion}-windows-x86_64.zip"
    $zipPath = "dist\fpcalc.zip"
    New-Item -ItemType Directory -Path "dist" -Force | Out-Null
    Invoke-WebRequest -Uri $url -OutFile $zipPath
    Expand-Archive -Path $zipPath -DestinationPath "dist\fpcalc-tmp" -Force
    Get-ChildItem -Path "dist\fpcalc-tmp" -Recurse -Filter "fpcalc.exe" |
        Copy-Item -Destination $FpcalcPath
    Remove-Item -Recurse "dist\fpcalc-tmp", $zipPath
    Write-Host "fpcalc.exe downloaded"
}

# ── 2. PyInstaller — single-file executable ────────────────────────────────
Write-Host "Running PyInstaller..."
$env:FPCALC_PATH = $FpcalcPath
poetry run pyinstaller packaging/windows/djtoolkit.spec --clean --noconfirm

$Binary = "dist\djtoolkit.exe"
if (-not (Test-Path $Binary)) {
    Write-Error "PyInstaller output not found at $Binary"
    exit 1
}
$size = (Get-Item $Binary).Length / 1MB
Write-Host ("Binary built: $Binary ({0:N1} MB)" -f $size)

# ── 3. Build MSI via WiX 4+ ───────────────────────────────────────────────
Write-Host "Building MSI..."
$msiName = "djtoolkit-${Version}-windows.msi"

wix build packaging/windows/djtoolkit.wxs `
    -o "dist\$msiName" `
    -d Version=$Version `
    -d BinaryPath=$Binary `
    -d FpcalcPath=$FpcalcPath

if (-not (Test-Path "dist\$msiName")) {
    Write-Error "MSI build failed"
    exit 1
}

$msiSize = (Get-Item "dist\$msiName").Length / 1MB
Write-Host ("MSI built: dist\$msiName ({0:N1} MB)" -f $msiSize)

Write-Host ""
Write-Host "Build complete:"
Write-Host "  dist\$msiName"
