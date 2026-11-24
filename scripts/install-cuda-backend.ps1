param(
    [string]$ArchivePath = (Join-Path $PSScriptRoot "voicebox-cuda-windows-x64.tar.gz")
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path -LiteralPath $ArchivePath -PathType Leaf)) {
    throw "CUDA archive not found: $ArchivePath"
}
$parent = Join-Path $env:APPDATA "com.doublesharp.voicebox.ds\backends"
$destination = Join-Path $parent "cuda"
$runningBackend = Get-Process -Name "voicebox-server-cuda" -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq (Join-Path $destination "voicebox-server-cuda.exe") }
if ($runningBackend -or (Get-Process -Name "voicebox-ds" -ErrorAction SilentlyContinue)) {
    throw "Quit Voicebox DS before installing its CUDA backend."
}

$ArchivePath = (Resolve-Path -LiteralPath $ArchivePath).Path
$manifestPath = Join-Path (Split-Path -Parent $ArchivePath) "build-info.json"
if (Test-Path -LiteralPath $manifestPath) {
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    $archiveName = Split-Path -Leaf $ArchivePath
    $expected = $manifest.files.PSObject.Properties[$archiveName].Value
    if (-not $expected -or (Get-FileHash -Algorithm SHA256 -LiteralPath $ArchivePath).Hash -ne $expected) {
        throw "CUDA archive checksum does not match build-info.json."
    }
}

$token = [guid]::NewGuid().ToString("N")
$staging = Join-Path $parent "cuda-install-$token"
$backup = Join-Path $parent "cuda-backup-$token"
$previousMoved = $false
New-Item -ItemType Directory -Path $staging -Force | Out-Null

try {
    & tar -xzf $ArchivePath --strip-components=1 -C $staging
    if ($LASTEXITCODE -ne 0) { throw "Could not extract the CUDA archive." }
    if (-not (Test-Path -LiteralPath (Join-Path $staging "voicebox-server-cuda.exe"))) {
        throw "The archive does not contain a Windows CUDA backend."
    }
    if (-not (Test-Path -LiteralPath (Join-Path $staging "cuda-libs.json"))) {
        throw "The archive is missing its CUDA runtime manifest."
    }
    if (Test-Path -LiteralPath $destination) {
        Move-Item -LiteralPath $destination -Destination $backup
        $previousMoved = $true
    }
    Move-Item -LiteralPath $staging -Destination $destination
} catch {
    if ($previousMoved -and -not (Test-Path -LiteralPath $destination)) {
        Move-Item -LiteralPath $backup -Destination $destination
    }
    throw
} finally {
    if (Test-Path -LiteralPath $staging) {
        Remove-Item -LiteralPath $staging -Recurse -Force
    }
}
if (Test-Path -LiteralPath $backup) {
    Remove-Item -LiteralPath $backup -Recurse -Force
}
Write-Host "CUDA backend installed at $destination. Launch Voicebox DS to use it."
