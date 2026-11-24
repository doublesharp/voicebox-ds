#!/bin/bash
# Build Python server binary for all platforms

set -e

# Determine platform
PLATFORM=$(rustc --print host-tuple 2>/dev/null || echo "unknown")

echo "Building Voicebox sidecars for platform: $PLATFORM"

# Build Python binary
# Prepend the project's backend virtualenv when present in the working checkout
if [ -d "$PWD/backend/venv/bin" ]; then
    export PATH="$PWD/backend/venv/bin:$PATH"
fi
# Resolve overrides relative to the invoking directory, matching the Python
# driver, before this wrapper changes into backend/.
for output_variable in VOICEBOX_PYINSTALLER_DISTPATH VOICEBOX_PYINSTALLER_WORKPATH VOICEBOX_PYINSTALLER_SPECPATH; do
    output_value="${!output_variable}"
    if [ -n "$output_value" ]; then
        case "$output_value" in
            /*) ;;
            *) export "$output_variable=$PWD/$output_value" ;;
        esac
    fi
done
cd backend
DIST_DIR="${VOICEBOX_PYINSTALLER_DISTPATH:-$PWD/dist}"

# Check if PyInstaller is installed
if ! python -c "import PyInstaller" 2>/dev/null; then
    echo "Installing PyInstaller..."
    python -m pip install pyinstaller
fi

# Create binaries directory if it doesn't exist
mkdir -p ../tauri/src-tauri/binaries

copy_sidecar() {
    local name="$1"
    local packaged_name="$2"
    local sidecar="../tauri/src-tauri/binaries/${packaged_name}-${PLATFORM}"

    # Local builds may point this name at a retained artifact. Replace that
    # reference rather than overwriting its shared target through the symlink.
    if [ -L "$sidecar" ]; then
        rm "$sidecar"
    fi

    if [ "$name" = "voicebox-server" ] && [ -f "${DIST_DIR}/${name}/${name}" ]; then
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
        cp -R "${DIST_DIR}/${name}" "$bundle_dir"
        # PyInstaller re-signs Python's executable after rewriting its load
        # paths. Refresh the enclosing framework's resource seal when built
        # against a framework Python (standalone uv Python uses libpython dylib).
        if [ "$(uname -s)" = "Darwin" ] && [ -d "$bundle_dir/_internal/Python.framework" ]; then
            codesign --force --deep --sign - --timestamp=none "$bundle_dir/_internal/Python.framework"
        fi
        cp "${DIST_DIR}/${name}/${name}" "$sidecar"
        chmod +x "$sidecar"
        echo "Built ${packaged_name}-${PLATFORM} and its packaged support directory"
    elif [ -f "${DIST_DIR}/${name}" ]; then
        cp "${DIST_DIR}/${name}" "$sidecar"
        chmod +x "$sidecar"
        echo "Built ${packaged_name}-${PLATFORM}"
    elif [ -f "${DIST_DIR}/${name}.exe" ]; then
        cp "${DIST_DIR}/${name}.exe" "$sidecar.exe"
        echo "Built ${packaged_name}-${PLATFORM}.exe"
    else
        echo "Error: ${name} binary not found in ${DIST_DIR}/"
        exit 1
    fi
}

python build_binary.py
copy_sidecar voicebox-server voicebox-ds-server

python build_binary.py --shim
copy_sidecar voicebox-mcp voicebox-ds-mcp

echo "Build complete!"
