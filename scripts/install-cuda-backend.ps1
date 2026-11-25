param(
    [string]$ArchivePath = (Join-Path $PSScriptRoot "voicebox-cuda-windows-x64.tar.gz")
)

$ErrorActionPreference = "Stop"
$legacyArchive = $PSBoundParameters.ContainsKey("ArchivePath") -or
    (Test-Path -LiteralPath $ArchivePath -PathType Leaf)
if ($legacyArchive -and -not (Test-Path -LiteralPath $ArchivePath -PathType Leaf)) {
    throw "CUDA archive not found: $ArchivePath"
}
$parent = Join-Path $env:APPDATA "com.doublesharp.voicebox.ds\backends"
$destination = Join-Path $parent "cuda"
$runningBackend = Get-Process -Name "voicebox-server-cuda" -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq (Join-Path $destination "voicebox-server-cuda.exe") }
if ($runningBackend -or (Get-Process -Name "voicebox-ds" -ErrorAction SilentlyContinue)) {
    throw "Quit Voicebox DS before installing its CUDA backend."
}

function Assert-ArchiveHash([string]$Path, [string]$Expected) {
    if (-not $Expected -or (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash -ne $Expected) {
        throw "CUDA archive checksum does not match: $Path"
    }
}

function Get-LibraryPath([string]$Root, [string]$RelativePath) {
    $prefix = [IO.Path]::GetFullPath($Root) + [IO.Path]::DirectorySeparatorChar
    $path = [IO.Path]::GetFullPath((Join-Path $Root $RelativePath))
    if (-not $path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Invalid CUDA library path: $RelativePath"
    }
    return $path
}

function Install-SplitArchives([string]$Staging, [string]$Installed) {
    $core = Join-Path $PSScriptRoot "voicebox-server-cuda-windows-x86_64.tar.gz"
    $coreHash = (Get-Content -Raw -LiteralPath "$core.sha256").Trim().Split(" ")[0]
    Assert-ArchiveHash $core $coreHash

    $manifestPath = Join-Path $PSScriptRoot "cuda-libs.json"
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    $libraries = @($manifest.files.PSObject.Properties)
    if ($manifest.platform -ne "windows-x86_64" -or $libraries.Count -eq 0 -or -not $manifest.archive) {
        throw "Invalid Windows CUDA runtime manifest."
    }

    # Match the actual installed runtime bytes, including installs made from the old combined archive.
    $reuse = Test-Path -LiteralPath $Installed -PathType Container
    foreach ($library in $libraries) {
        $installedPath = Get-LibraryPath $Installed $library.Name
        if (-not (Test-Path -LiteralPath $installedPath -PathType Leaf) -or
            (Get-FileHash -Algorithm SHA256 -LiteralPath $installedPath).Hash -ne $library.Value) {
            $reuse = $false
            break
        }
    }

    & tar -xzf $core -C $Staging
    if ($LASTEXITCODE -ne 0) { throw "Could not extract the CUDA backend." }

    if ($reuse) {
        foreach ($library in $libraries) {
            $source = Get-LibraryPath $Installed $library.Name
            $target = Get-LibraryPath $Staging $library.Name
            New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
            Copy-Item -LiteralPath $source -Destination $target
        }
        Write-Host "Reused installed NVIDIA runtime libraries."
    } else {
        $runtime = Join-Path $PSScriptRoot $manifest.archive
        if ($manifest.parts.Count -gt 0) {
            $parts = foreach ($part in $manifest.parts) {
                $path = Join-Path $PSScriptRoot $part
                if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
                    throw "Download all numbered parts of $($manifest.archive) into $PSScriptRoot and rerun the script."
                }
                $path
            }
            $runtime = Join-Path $Staging $manifest.archive
            $combined = [IO.File]::Create($runtime)
            try {
                foreach ($part in $parts) {
                    $stream = [IO.File]::OpenRead($part)
                    try { $stream.CopyTo($combined) } finally { $stream.Dispose() }
                }
            } finally {
                $combined.Dispose()
            }
        } elseif (-not (Test-Path -LiteralPath $runtime -PathType Leaf)) {
            throw "Download $($manifest.archive) into $PSScriptRoot and rerun the script."
        }
        Assert-ArchiveHash $runtime $manifest.sha256
        & tar -xzf $runtime -C $Staging
        if ($LASTEXITCODE -ne 0) { throw "Could not extract the NVIDIA runtime libraries." }
        if ($manifest.parts.Count -gt 0) { Remove-Item -LiteralPath $runtime }
    }
    Copy-Item -LiteralPath $manifestPath -Destination $Staging
}

$token = [guid]::NewGuid().ToString("N")
$staging = Join-Path $parent "cuda-install-$token"
$backup = Join-Path $parent "cuda-backup-$token"
$previousMoved = $false
New-Item -ItemType Directory -Path $staging -Force | Out-Null

try {
    if ($legacyArchive) {
        $ArchivePath = (Resolve-Path -LiteralPath $ArchivePath).Path
        $manifestPath = Join-Path (Split-Path -Parent $ArchivePath) "build-info.json"
        if (Test-Path -LiteralPath $manifestPath) {
            $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
            $archiveName = Split-Path -Leaf $ArchivePath
            Assert-ArchiveHash $ArchivePath $manifest.files.PSObject.Properties[$archiveName].Value
        }
        & tar -xzf $ArchivePath --strip-components=1 -C $staging
        if ($LASTEXITCODE -ne 0) { throw "Could not extract the CUDA archive." }
    } else {
        Install-SplitArchives $staging $destination
    }
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
