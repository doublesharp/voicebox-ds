# DoubleSharp builds

Use `doublesharp` as the integration branch for tested customizations. Feature branches remain independent for review or an upstream contribution.

GitHub builds are **manual only**. Merging or pushing a branch, opening a PR, creating a tag, or waiting for a schedule does not trigger this workflow.

After local acceptance, run the existing workflow file **release.yml** (`.github/workflows/release.yml`) with **Use workflow from: doublesharp** and choose `macos`, `windows`, or `both`. Selecting another branch skips the build job. The existing workflow file name is retained so dispatch does not require changing the fork's default branch.

To reduce repeated work, the workflow caches Python downloads, Rust dependencies and compilation, and frozen CPU/MCP/CUDA binaries keyed by their runtime source and dependency inputs. A frontend-only change can reuse the backend binaries. A newer manual run cancels an older build. Artifacts expire after seven days; they include the source commit and SHA-256 checksums. No GitHub release, tag, updater feed, or deployment is created.

## macOS

The artifact contains a zipped Apple Silicon `Voicebox DS.app`. It is a local test build without Developer ID notarization. If a stdio MCP client points to the older `/Applications/Voicebox.app/Contents/MacOS/voicebox-mcp` or `/Applications/VoiceboxDS.app/Contents/MacOS/voicebox-mcp` path, update it to `/Applications/Voicebox DS.app/Contents/MacOS/voicebox-mcp` after installing the renamed app. Runtime/model locations come from the target installation's configuration; build and deployment instructions must use explicit portable paths.

## Windows and CUDA

Download and extract the Windows artifact, install its `*-setup.exe`, then fully quit Voicebox. Run `Install-CUDA.ps1` from the extracted artifact directory. It verifies the archive checksum when `build-info.json` is present and installs the complete CUDA backend under `%APPDATA%\sh.voicebox.app\backends\cuda`, preserving the prior backend if extraction or replacement fails.

Launch Voicebox with a compatible NVIDIA driver. Check `http://127.0.0.1:17493/health` for `backend_variant: cuda`, `gpu_available: true`, and the expected GPU. A successful hosted build proves packaging; an actual Windows/NVIDIA inference test is still required.

The installer and CUDA archive belong to the same build. Distribute both. The custom desktop build disables the upstream desktop update endpoint so an upstream release cannot replace fork customizations.

The equivalent command after publishing this workflow is `gh workflow run release.yml --ref doublesharp -f platforms=both`. Do not dispatch it until local testing has been accepted.
