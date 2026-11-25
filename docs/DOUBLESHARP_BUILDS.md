# DoubleSharp builds

Use `doublesharp` as the integration branch for tested customizations. Feature branches remain independent for review or an upstream contribution.

## Publish a GitHub release

Tag the commit on `doublesharp` with `ds-v<version>`, using the app version from `tauri/src-tauri/tauri.conf.json`. For example, to publish version 0.6.1 from the current commit:

```sh
git tag -a ds-v0.6.1 -m "Voicebox DS 0.6.1"
git push origin ds-v0.6.1
```

The workflow builds macOS (Apple Silicon), Linux (x64 `.deb`), and Windows (x64 setup executable). After all three builds pass, it publishes the packages and checksums to [GitHub Releases](https://github.com/doublesharp/voicebox-ds/releases).

If GitHub misses a tag push, run the workflow with the existing tag to retry the release:

```sh
gh workflow run release.yml --ref doublesharp -f release_tag=ds-v0.6.1
```

## Manual test builds

After local acceptance, run **release.yml** from `doublesharp` with `macos`, `windows`, `linux`, or `both` (macOS and Windows). The [GitHub Actions run](https://github.com/doublesharp/voicebox-ds/actions/workflows/release.yml) keeps the test packages and their source commit and checksums for seven days.

The equivalent CLI command is `gh workflow run release.yml --ref doublesharp -f platforms=both`.

## macOS

The archive contains the ad-hoc-signed Apple Silicon `Voicebox DS.app`. If a stdio MCP client points to the older `/Applications/Voicebox.app/Contents/MacOS/voicebox-mcp` or `/Applications/VoiceboxDS.app/Contents/MacOS/voicebox-mcp` path, update it to `/Applications/Voicebox DS.app/Contents/MacOS/voicebox-ds-mcp` after installing the renamed app. Runtime and model locations come from the target installation's configuration.

## Windows and CUDA

Run `Voicebox-DS-Windows-x64-setup.exe` to install the app with CPU support.

For NVIDIA acceleration, put `Install-CUDA.ps1`, `voicebox-server-cuda-windows-x86_64.tar.gz`, its `.sha256` file, and `cuda-libs.json` in one folder. For manual builds, extract the CUDA backend and NVIDIA runtime artifacts into the same folder. Quit Voicebox DS and run the script from PowerShell.

The script reuses matching NVIDIA libraries already installed. If it requests the NVIDIA runtime archive, put the archive or all its numbered parts in the same folder and rerun the script. The script verifies the checksums and installs under `%APPDATA%\com.doublesharp.voicebox.ds\backends\cuda` while preserving the prior backend if extraction or replacement fails.

Launch Voicebox with a compatible NVIDIA driver. Check `http://127.0.0.1:17593/health` for `backend_variant: cuda`, `gpu_available: true`, and the expected GPU.

Use the CUDA backend for the same release as the Windows installer. The desktop build disables the upstream update endpoint.
