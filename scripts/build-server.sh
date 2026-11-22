#!/bin/bash
# Build Python server binary for all platforms

set -e

# Determine platform
PLATFORM=$(rustc --print host-tuple 2>/dev/null || echo "unknown")

echo "Building Voicebox sidecars for platform: $PLATFORM"

# Build Python binary
# Resolve PATH to absolute paths before changing directory
export PATH="$(cd "$(dirname "$0")/.." && pwd)/backend/venv/bin:$PATH"
cd backend

# Check if PyInstaller is installed
if ! python -c "import PyInstaller" 2>/dev/null; then
    echo "Installing PyInstaller..."
    python -m pip install pyinstaller
fi

# Create binaries directory if it doesn't exist
mkdir -p ../tauri/src-tauri/binaries

copy_sidecar() {
    local name="$1"
    local sidecar="../tauri/src-tauri/binaries/${name}-${PLATFORM}"

    # Local builds may point this name at a retained artifact. Replace that
    # reference rather than overwriting its shared target through the symlink.
    if [ -L "$sidecar" ]; then
        rm "$sidecar"
    fi

    if [ "$name" = "voicebox-server" ] && [ -f "dist/${name}/${name}" ]; then
        # The macOS backend runs from Resources/backend with its support files
        # beside it. Keep the small target-suffixed executable for Tauri's
        # sidecar declaration as well.
        local bundle_dir="../tauri/src-tauri/binaries/${name}"
        if [ -L "$bundle_dir" ]; then
            echo "Error: refusing to replace symlinked backend bundle: $bundle_dir"
            exit 1
        fi
        if [ -e "$bundle_dir" ]; then
            if [ ! -d "$bundle_dir" ] || [ ! -O "$bundle_dir" ] || [ ! -x "$bundle_dir/$name" ]; then
                echo "Error: existing backend directory is not an owned generated bundle: $bundle_dir"
                exit 1
            fi
            if ! command -v lsof >/dev/null; then
                echo "Error: lsof is required to check whether the existing backend is in use"
                exit 1
            fi
            if open_files=$(lsof -nP +D "$bundle_dir" 2>&1); then
                echo "Error: existing backend is in use: $bundle_dir"
                exit 1
            else
                lsof_status=$?
                if [ "$lsof_status" -ne 1 ] || [ -n "$open_files" ]; then
                    echo "Error: could not verify that the existing backend is unused: $bundle_dir"
                    exit 1
                fi
            fi
            rm -rf "$bundle_dir"
        fi
        cp -R "dist/${name}" "$bundle_dir"
        # PyInstaller re-signs Python's executable after rewriting its load
        # paths. Refresh the enclosing framework's resource seal when built
        # against a framework Python (standalone uv Python uses libpython dylib).
        if [ "$(uname -s)" = "Darwin" ] && [ -d "$bundle_dir/_internal/Python.framework" ]; then
            codesign --force --deep --sign - --timestamp=none "$bundle_dir/_internal/Python.framework"
        fi
        cp "dist/${name}/${name}" "$sidecar"
        chmod +x "$sidecar"
        echo "Built ${name}-${PLATFORM} and its packaged support directory"
    elif [ -f "dist/${name}" ]; then
        cp "dist/${name}" "$sidecar"
        chmod +x "$sidecar"
        echo "Built ${name}-${PLATFORM}"
    elif [ -f "dist/${name}.exe" ]; then
        cp "dist/${name}.exe" "../tauri/src-tauri/binaries/${name}-${PLATFORM}.exe"
        echo "Built ${name}-${PLATFORM}.exe"
    else
        echo "Error: ${name} binary not found in dist/"
        exit 1
    fi
}

python build_binary.py
copy_sidecar voicebox-server

python build_binary.py --shim
copy_sidecar voicebox-mcp

echo "Build complete!"
