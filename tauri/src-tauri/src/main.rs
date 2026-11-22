// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod accessibility;
mod audio_capture;
mod audio_output;
mod audio_pcm;
mod audio_stream;
mod clipboard;
mod focus_capture;
#[cfg(desktop)]
mod hotkey_monitor;
mod input_monitoring;
#[cfg(desktop)]
mod key_codes;
mod keyboard_layout;
mod paste_pipeline;
mod publication;
mod publication_commands;
mod server_process;
mod server_startup;
mod speak_monitor;
mod sse_frames;
mod synthetic_keys;
mod window_close;

use std::sync::{Arc, Mutex};
use tauri::{command, State, Manager, WindowEvent, Emitter, Listener, RunEvent, WebviewUrl, WebviewWindowBuilder, PhysicalPosition};
use tauri_plugin_shell::ShellExt;
use tokio::sync::mpsc;

pub const DICTATE_WINDOW_LABEL: &str = "dictate";
const DICTATE_WINDOW_WIDTH: f64 = 420.0;
const DICTATE_WINDOW_HEIGHT: f64 = 64.0;

#[cfg(desktop)]
fn dictate_window_position(
    origin: tauri::PhysicalPosition<i32>,
    monitor: tauri::PhysicalSize<u32>,
    window: tauri::PhysicalSize<u32>,
) -> tauri::PhysicalPosition<i32> {
    let x = i64::from(origin.x) + (i64::from(monitor.width) - i64::from(window.width)) / 2;
    let y = i64::from(origin.y) + i64::from(monitor.height) * 4 / 100;
    let bounded = |value: i64| value.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32;
    tauri::PhysicalPosition::new(bounded(x), bounded(y))
}

/// Create the floating dictate webview hidden. The HotkeyMonitor shows it on
/// chord-start; the frontend hides it when the capture pipeline finishes.
/// Building it at setup avoids a race where the first chord or agent-speech
/// event fires before the webview subscribes to the `dictate:*` events.
#[cfg(desktop)]
fn build_dictate_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<tauri::WebviewWindow<R>> {
    let window = WebviewWindowBuilder::new(
        app,
        DICTATE_WINDOW_LABEL,
        WebviewUrl::App("?view=dictate".into()),
    )
    .title("Voicebox DS Dictate")
    .inner_size(DICTATE_WINDOW_WIDTH, DICTATE_WINDOW_HEIGHT)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    // Follow the user across macOS Spaces / virtual desktops instead of
    // being pinned to the Space where the window was first created.
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .visible(false)
    .build()?;

    if let Some(monitor) = window.current_monitor()? {
        let win_size = window.outer_size()?;
        window.set_position(dictate_window_position(*monitor.position(), *monitor.size(), win_size))?;
    }

    Ok(window)
}

/// Position, undo click-through, and show the dictate pill window.
///
/// The hide path parks the window at (-10_000, -10_000) and toggles
/// `ignore_cursor_events(true)` so invisible click targets don't leak; we
/// undo both here. Mirrors the logic the hotkey_monitor's
/// `Effect::StartRecording` path runs, minus the focus snapshot — this is
/// for agent-initiated speech, not dictation, so there's no focused text
/// field to paste into.
/// Build the pill webview if it doesn't exist yet. Idempotent — used by
/// agent-speech to prime the webview on speak-start so its listeners can
/// register before the actual show arrives from `audio.onplaying`.
#[cfg(desktop)]
pub fn ensure_dictate_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if app.get_webview_window(DICTATE_WINDOW_LABEL).is_none() {
        if let Err(e) = build_dictate_window(app) {
            eprintln!("ensure_dictate_window: failed to build pill: {e}");
        }
    }
}

#[cfg(desktop)]
pub fn show_dictate_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    // Build on demand so agent-initiated speech works before the user has
    // enabled the global hotkey (the hotkey path is the other place this
    // window gets built, see `enable_hotkey`).
    let window = match app.get_webview_window(DICTATE_WINDOW_LABEL) {
        Some(w) => w,
        None => match build_dictate_window(app) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("show_dictate_window: failed to build pill window: {e}");
                return;
            }
        },
    };
    // current_monitor() returns None when the window has been parked
    // off any display by the hide path; fall back to the primary.
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    if let Some(monitor) = monitor {
        if let Ok(win_size) = window.outer_size() {
            let _ = window.set_position(dictate_window_position(
                *monitor.position(), *monitor.size(), win_size,
            ));
        }
    }
    // Skip on Linux: tao's CursorIgnoreEvents handler unwraps the GdkWindow,
    // which is None until the window is first shown, aborting the process.
    // The click-through toggle is a macOS workaround and is never set on Linux.
    #[cfg(not(target_os = "linux"))]
    let _ = window.set_ignore_cursor_events(false);
    let _ = window.show();
}

/// Register the app-wide overlay show and hide event bridge.
#[cfg(desktop)]
fn install_dictate_window_handlers<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    // The frontend emits `dictate:hide` whenever the pill cycle
    // finishes (rest-fade → hidden). `hide()` alone has been
    // unreliable for transparent always-on-top windows on macOS
    // — the NSWindow lingers as an invisible click target that
    // steals focus to the Voicebox app when the user clicks
    // where it used to be. Park the window off-screen and mark
    // it click-through as well, so even if `hide()` no-ops the
    // user sees and interacts with nothing.
    let handle_for_hide = app.clone();
    app.listen("dictate:hide", move |_event| {
        if let Some(window) = handle_for_hide.get_webview_window(DICTATE_WINDOW_LABEL) {
            // Skip on Linux: aborts if the window was never realized
            // (see show_dictate_window).
            #[cfg(not(target_os = "linux"))]
            let _ = window.set_ignore_cursor_events(true);
            let _ = window.set_position(PhysicalPosition::new(-10_000, -10_000));
            let _ = window.hide();
        }
    });

    // Agent-initiated speech (voicebox_speak over MCP or POST /speak)
    // pops the pill up so the user can see what's coming out of their
    // machine. The `dictate:show` listener is kept for any frontend
    // caller that wants to force-surface the pill directly, but the
    // primary source is `speak_monitor` below — Rust subscribes to
    // the backend /events/speak SSE stream so the pill surfaces even
    // when no JS window is active.
    let handle_for_show = app.clone();
    app.listen("dictate:show", move |_event| {
        show_dictate_window(&handle_for_show);
    });
}

const LEGACY_PORT: u16 = 8000;
pub(crate) const SERVER_PORT: u16 = 17493;

/// Find a voicebox-server process listening on a given port (Windows only).
///
/// Uses PowerShell `Get-NetTCPConnection` to look up the PID owning the port,
/// then verifies via `tasklist` that it's a voicebox process. The caller is
/// responsible for checking port occupancy first (e.g. `TcpStream::connect_timeout`).
/// Replaces the previous `netstat -ano` approach which failed on systems with
/// corrupted system DLLs (see #277).
#[cfg(windows)]
fn find_voicebox_pid_on_port(port: u16) -> Option<u32> {
    use std::process::Command;

    // Use PowerShell's Get-NetTCPConnection to find the PID listening on the port.
    // This is a built-in cmdlet that doesn't depend on netstat.exe.
    let ps_script = format!(
        "Get-NetTCPConnection -LocalPort {} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess",
        port
    );
    if let Ok(output) = Command::new("powershell")
        .args(["-NoProfile", "-Command", &ps_script])
        .output()
    {
        if !output.status.success() { return None; }
        let output_str = String::from_utf8_lossy(&output.stdout);
        return server_process::windows_listener_pid(&output_str, |pid| {
            let tasklist = Command::new("tasklist")
                .args(["/FI", &format!("PID eq {}", pid), "/FO", "CSV", "/NH"])
                .output().ok()?;
            if !tasklist.status.success() { return None; }
            Some(String::from_utf8_lossy(&tasklist.stdout).into_owned())
        });
    }

    None
}

/// Check if a Voicebox server is responding on the given port.
///
/// Sends an HTTP GET to `/health` and returns `true` only if the response
/// is valid JSON matching the Voicebox `HealthResponse` schema — specifically
/// `status` must be `"healthy"`, and both `model_loaded` and `gpu_available`
/// must be present as booleans. This prevents misidentifying an unrelated
/// service that happens to expose a `/health` endpoint.
#[allow(dead_code)] // Used in platform-specific cfg blocks
fn check_health(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{}/health", port);
    match reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(3))
        .build()
    {
        Ok(client) => match client.get(&url).send() {
            Ok(resp) => {
                if resp.status() != reqwest::StatusCode::OK {
                    return false;
                }
                // Parse as JSON and validate Voicebox-specific fields
                match resp.json::<serde_json::Value>() {
                    Ok(body) => {
                        body.get("status").and_then(|v| v.as_str()) == Some("healthy")
                            && body.get("model_loaded").map(|v| v.is_boolean()).unwrap_or(false)
                            && body.get("gpu_available").map(|v| v.is_boolean()).unwrap_or(false)
                    }
                    Err(_) => false,
                }
            }
            Err(_) => false,
        },
        Err(_) => false,
    }
}

async fn manual_server_available(port: u16) -> bool {
    tokio::task::spawn_blocking(move || check_health(port))
        .await
        .unwrap_or(false)
}

async fn startup_health_check(
    port: u16,
    permit: &server_startup::StartPermit<'_>,
) -> Result<bool, String> {
    permit
        .until_cancelled(manual_server_available(port))
        .await
        .ok_or_else(|| "Server startup cancelled".to_string())
}

#[cfg(unix)]
async fn discover_listeners(
    port: u16,
    executable: Option<&std::path::Path>,
    timeout: std::time::Duration,
    permit: &server_startup::StartPermit<'_>,
) -> Result<Option<std::process::Output>, String> {
    let mut command = tokio::process::Command::new(
        executable.unwrap_or_else(|| std::path::Path::new("lsof")),
    );
    command.args(["+c", "0", "-i", &format!(":{port}"), "-sTCP:LISTEN"]);
    command.kill_on_drop(true);
    Ok(permit
        .until_cancelled(tokio::time::timeout(timeout, command.output()))
        .await
        .ok_or_else(|| "Server startup cancelled".to_string())?
        .map_err(|_| "Server listener discovery timed out".to_string())?
        .ok())
}

fn eligible_gpu_backends(
    pin: Option<&str>,
    rocm: Option<std::path::PathBuf>,
    cuda: Option<std::path::PathBuf>,
) -> (Option<std::path::PathBuf>, Option<std::path::PathBuf>) {
    let pin_cuda = pin == Some("cuda") && cuda.is_some();
    let pin_rocm = pin == Some("rocm") && rocm.is_some();
    (if pin_cuda { None } else { rocm }, if pin_rocm { None } else { cuda })
}

/// Launch eligible GPU backends in order, falling back to the CPU on spawn failure.
fn launch_backend<T, E: std::fmt::Display>(
    pin: Option<&str>,
    rocm: Option<&std::path::Path>,
    cuda: Option<&std::path::Path>,
    mut spawn_gpu: impl FnMut(&std::path::Path) -> Result<T, E>,
    spawn_cpu: impl FnOnce() -> Result<T, E>,
) -> Result<T, E> {
    if pin != Some("cpu") {
        for path in [rocm, cuda].into_iter().flatten() {
            match spawn_gpu(path) {
                Ok(child) => return Ok(child),
                Err(error) => println!("GPU backend {:?} spawn failed ({}), trying fallback", path, error),
            }
        }
    }
    spawn_cpu()
}

fn server_arguments(data_dir: &str, port: u16, parent_pid: u32, remote: bool) -> Vec<String> {
    let mut args = vec![
        "--data-dir".into(), data_dir.into(), "--port".into(), port.to_string(),
        "--parent-pid".into(), parent_pid.to_string(),
    ];
    if remote { args.extend(["--host".into(), "0.0.0.0".into()]); }
    args
}

#[cfg(any(target_os = "linux", test))]
fn trusted_microphone_origin(uri: &str) -> bool {
    trusted_microphone_origin_for_build(uri, cfg!(debug_assertions))
}

#[cfg(any(target_os = "linux", test))]
fn trusted_microphone_origin_for_build(uri: &str, development: bool) -> bool {
    let Ok(url) = reqwest::Url::parse(uri) else {
        return false;
    };
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    match (url.scheme(), url.host_str(), url.port()) {
        ("tauri", Some("localhost"), None) => true,
        ("https", Some("tauri.localhost"), None) => true,
        ("http", Some("localhost" | "127.0.0.1"), Some(5173)) if development => true,
        _ => false,
    }
}

#[cfg(any(target_os = "linux", test))]
fn allow_media_request(uri: &str, audio: bool, video: bool, display: bool) -> bool {
    audio && !video && !display && trusted_microphone_origin(uri)
}

fn resolve_remote_setting(stored: &Mutex<bool>, requested: Option<bool>) -> bool {
    let mut remote = stored.lock().unwrap();
    if let Some(requested) = requested {
        *remote = requested;
    }
    *remote
}

fn update_models_dir(stored: &Mutex<Option<String>>, requested: Option<&str>) {
    if let Some(dir) = requested {
        *stored.lock().unwrap() = (!dir.is_empty()).then(|| dir.to_string());
    }
}

struct ServerState {
    start_gate: Arc<server_startup::StartGate>,
    child: Mutex<Option<tauri_plugin_shell::process::CommandChild>>,
    server_pid: Mutex<Option<u32>>,
    keep_running_on_close: Mutex<bool>,
    remote: Mutex<bool>,
    models_dir: Mutex<Option<String>>,
    /// Override the backend selection: Some("cpu") forces the CPU sidecar even
    /// when GPU binaries exist (solving the Windows catch-22 where an active
    /// .exe cannot be deleted), while Some("cuda")/Some("rocm") pin a specific
    /// GPU variant when more than one is installed. None uses the on-disk
    /// default (ROCm preferred, then CUDA). Persisted to disk so the choice
    /// survives an app restart.
    backend_override: Mutex<Option<String>>,
}

fn backend_override_file(data_dir: &std::path::Path) -> std::path::PathBuf {
    data_dir.join("backend_override")
}

fn read_persisted_backend_override(data_dir: &std::path::Path) -> Option<String> {
    std::fs::read_to_string(backend_override_file(data_dir))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn write_persisted_backend_override(data_dir: &std::path::Path, value: Option<&str>) -> std::io::Result<()> {
    let path = backend_override_file(data_dir);
    match value {
        Some(value) => write_backend_override_from(data_dir, value.as_bytes()),
        None => match std::fs::remove_file(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            result => result,
        },
    }
}

fn write_backend_override_from(data_dir: &std::path::Path, input: impl std::io::Read) -> std::io::Result<()> {
    std::fs::create_dir_all(data_dir)?;
    publication::publish(&backend_override_file(data_dir), input)
}

fn save_backend_override(data_dir: &std::path::Path, state: &Mutex<Option<String>>, value: Option<String>) -> Result<(), String> {
    if value.as_deref().is_some_and(|choice| !matches!(choice, "cpu" | "cuda" | "rocm")) {
        return Err("Invalid backend override".into());
    }
    // Serialize disk and memory updates so concurrent commands cannot disagree.
    let mut current = state.lock().map_err(|_| "Backend override state unavailable")?;
    write_persisted_backend_override(data_dir, value.as_deref())
        .map_err(|error| format!("Failed to persist backend override: {error}"))?;
    *current = value;
    Ok(())
}

/// Run `<exe> --version` with a 10-second timeout to avoid hanging Tauri startup.
/// Returns a version only for a successful process with one Voicebox version line.
async fn probe_binary_version(exe: &std::path::Path, cwd: &std::path::Path) -> Option<String> {
    let mut cmd = tokio::process::Command::new(exe);
    cmd.arg("--version")
        .current_dir(cwd)
        .kill_on_drop(true);

    match tokio::time::timeout(std::time::Duration::from_secs(10), cmd.output()).await {
        Ok(Ok(output)) => {
            if !output.status.success() {
                return None;
            }
            let stdout = std::str::from_utf8(&output.stdout).ok()?;
            let mut versions = stdout.lines().filter_map(|line| {
                let mut words = line.split_whitespace();
                match (words.next(), words.next(), words.next()) {
                    (Some("voicebox-server"), Some(version), None) => Some(version),
                    _ => None,
                }
            });
            let version = versions.next()?;
            if versions.next().is_some() {
                return None;
            }
            Some(version.to_owned())
        }
        Ok(Err(e)) => {
            println!("Version probe failed: {}", e);
            None
        }
        Err(_) => {
            println!("Version probe timed out after 10s");
            None
        }
    }
}

async fn check_gpu_backend<F, Fut>(
    binary: std::path::PathBuf, installed: bool, app_version: &str, pin: Option<&str>,
    permit: &server_startup::StartPermit<'_>, probe: F,
) -> Result<Option<std::path::PathBuf>, String>
where
    F: FnOnce() -> Fut, Fut: std::future::Future<Output = Option<String>>,
{
    if !installed || pin == Some("cpu") { return Ok(None); }
    let version = permit.until_cancelled(probe()).await.ok_or("Server startup cancelled")?;
    let compatible = !app_version.is_empty() && version.as_deref() == Some(app_version);
    if !compatible {
        println!("GPU backend {:?} version mismatch: binary={}, app={}",
            binary, version.as_deref().unwrap_or("<unknown>"), app_version);
    }
    Ok(compatible.then_some(binary))
}

async fn probe_gpu_candidate(
    path: &std::path::Path,
    directory: &std::path::Path,
    app_version: &str,
    pin: Option<&str>,
    permit: &server_startup::StartPermit<'_>,
) -> Result<Option<std::path::PathBuf>, String> {
    check_gpu_backend(path.to_path_buf(), path.exists(), app_version, pin, permit, || {
        probe_binary_version(path, directory)
    }).await
}

#[command]
async fn start_server<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, ServerState>,
    remote: Option<bool>,
    models_dir: Option<String>,
) -> Result<String, String> {
    start_server_with(app, state, remote, models_dir, ServerStartupConfig::default()).await
}

struct ServerStartupConfig {
    port: u16,
    discover_listener: bool,
    listener_executable: Option<std::path::PathBuf>,
    listener_timeout: std::time::Duration,
    port_release_delay: std::time::Duration,
    legacy_port: Option<u16>,
    data_dir: Option<std::path::PathBuf>,
    cpu_executable: Option<std::path::PathBuf>,
    startup_timeout: std::time::Duration,
}
impl Default for ServerStartupConfig {
    fn default() -> Self {
        Self {
            port: SERVER_PORT,
            discover_listener: true,
            listener_executable: None,
            listener_timeout: std::time::Duration::from_secs(10),
            port_release_delay: std::time::Duration::from_millis(200),
            legacy_port: Some(LEGACY_PORT),
            data_dir: None,
            cpu_executable: None,
            startup_timeout: std::time::Duration::from_secs(120),
        }
    }
}

async fn start_server_with<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, ServerState>,
    remote: Option<bool>,
    models_dir: Option<String>,
    config: ServerStartupConfig,
) -> Result<String, String> {
    start_server_with_generation(app, state, remote, models_dir, config, None).await
}

async fn start_server_with_generation<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, ServerState>,
    remote: Option<bool>,
    models_dir: Option<String>,
    config: ServerStartupConfig,
    generation: Option<u64>,
) -> Result<String, String> {
    let permit = match generation {
        Some(value) => state.start_gate.try_begin_generation(Some(value)),
        None => state.start_gate.try_begin(),
    };
    let _start_permit = permit.ok_or(if generation.is_some() {
        "Server restart cancelled or another operation is active"
    } else {
        "The bundled server is starting or stopping. Please try again shortly."
    })?;
    let is_remote = resolve_remote_setting(&state.remote, remote);
    // Store models_dir for use on restart (empty string means reset to default)
    update_models_dir(&state.models_dir, models_dir.as_deref());
    // Check if server is already running (managed by this app instance)
    let has_managed_child = state.child.lock().unwrap().is_some();
    if has_managed_child {
        let ready = startup_health_check(config.port, &_start_permit).await?;
        if ready {
            _start_permit.commit(|| ()).ok_or("Server startup cancelled")?;
            return Ok(format!("http://127.0.0.1:{}", config.port));
        }
        return Err("The bundled server is starting or stopping. Please try again shortly.".to_string());
    }

    // Check if a voicebox server is already running on our port (from previous session with keep_running=true,
    // or an externally started server e.g. via `python`, `uvicorn`, Docker, etc.)
    #[cfg(unix)]
    if config.discover_listener {
        if let Some(output) = discover_listeners(config.port, config.listener_executable.as_deref(), config.listener_timeout, &_start_permit).await? {
            let output_str = String::from_utf8_lossy(&output.stdout);
            let healthy = output_str.lines().skip(1).any(|line| !line.trim().is_empty())
                && startup_health_check(config.port, &_start_permit).await?;
            match server_process::classify_listener(&output_str, healthy) {
                server_process::ListenerDecision::Unoccupied => {}
                server_process::ListenerDecision::ReuseOwned(pid) => {
                    #[cfg(target_os = "linux")]
                    if !server_process::linux_server_executable(pid) {
                        println!("Healthy server has an unverified executable; reusing it as external");
                        _start_permit.commit(|| ()).ok_or("Server startup cancelled")?;
                        return Ok(format!("http://127.0.0.1:{}", config.port));
                    }
                    println!("Found healthy voicebox-server on port {} (PID: {}), reusing it", config.port, pid);
                    _start_permit.commit(|| *state.server_pid.lock().unwrap() = Some(pid))
                        .ok_or("Server startup cancelled")?;
                    return Ok(format!("http://127.0.0.1:{}", config.port));
                }
                server_process::ListenerDecision::ReuseExternal => {
                    println!("Health check passed — reusing external server on port {}", config.port);
                    _start_permit.commit(|| ()).ok_or("Server startup cancelled")?;
                    return Ok(format!("http://127.0.0.1:{}", config.port));
                }
                server_process::ListenerDecision::Conflict(command) => {
                    return Err(format!(
                        "Port {} is already in use by another application ({}). \
                         Close it or change the Voicebox server port.",
                        config.port, command
                    ));
                }
            }
        }
    }
    
    #[cfg(windows)]
    if config.discover_listener {
        use std::net::TcpStream;
        if TcpStream::connect_timeout(
            &format!("127.0.0.1:{}", config.port).parse().unwrap(),
            std::time::Duration::from_secs(1),
        ).is_ok() {
            if startup_health_check(config.port, &_start_permit).await? {
                if let Some(pid) = find_voicebox_pid_on_port(config.port) {
                    println!("Found healthy voicebox-server on port {} (PID: {}), reusing it", config.port, pid);
                    _start_permit.commit(|| *state.server_pid.lock().unwrap() = Some(pid))
                        .ok_or("Server startup cancelled")?;
                } else {
                    println!("Health check passed — reusing external server on port {}", config.port);
                    _start_permit.commit(|| ()).ok_or("Server startup cancelled")?;
                }
                return Ok(format!("http://127.0.0.1:{}", config.port));
            }
            return Err(format!(
                "Port {} is already in use by another application. \
                 Close the other application or change the Voicebox port.",
                config.port
            ));
        }
    }

    // Kill any orphaned voicebox-server from previous session on legacy port 8000
    // This handles upgrades from older versions that used a fixed port
    #[cfg(unix)]
    if let Some(legacy_port) = config.legacy_port {
        use std::process::Command;
        if let Some(output) = discover_listeners(legacy_port, config.listener_executable.as_deref(), config.listener_timeout, &_start_permit).await? {
            let output_str = String::from_utf8_lossy(&output.stdout);
            let healthy = output_str.lines().skip(1).any(|line| !line.trim().is_empty())
                && startup_health_check(legacy_port, &_start_permit).await?;
            for pid in server_process::legacy_pids(&output_str, healthy) {
                #[cfg(target_os = "linux")]
                if !server_process::linux_server_executable(pid) {
                    continue;
                }
                _start_permit.commit(|| {
                    println!("Found healthy voicebox-server on legacy port {} (PID: {}), stopping it...", legacy_port, pid);
                    let _ = Command::new("kill")
                        .args(["-9", "--", &format!("-{}", pid)])
                        .output();
                    let _ = Command::new("kill")
                        .args(["-9", &pid.to_string()])
                        .output();
                }).ok_or("Server startup cancelled")?;
            }
        }
    }
    
    #[cfg(windows)]
    if let Some(legacy_port) = config.legacy_port {
        use std::net::TcpStream;
        if TcpStream::connect_timeout(
            &format!("127.0.0.1:{}", legacy_port).parse().unwrap(),
            std::time::Duration::from_secs(1),
        ).is_ok() && startup_health_check(legacy_port, &_start_permit).await? {
            if let Some(pid) = find_voicebox_pid_on_port(legacy_port) {
                _start_permit.commit(|| {
                    println!("Found orphaned voicebox-server on legacy port {} (PID: {}), killing it...", legacy_port, pid);
                    let _ = std::process::Command::new("taskkill")
                        .args(["/PID", &pid.to_string(), "/T", "/F"])
                        .output();
                }).ok_or("Server startup cancelled")?;
            }
        }
    }
    
    // Brief wait for port to be released
    _start_permit
        .until_cancelled(tokio::time::sleep(config.port_release_delay))
        .await
        .ok_or("Server startup cancelled")?;

    // Get app data directory
    let data_dir = match config.data_dir.clone() {
        Some(path) => path,
        None => app.path().app_data_dir().map_err(|e| format!("Failed to get app data dir: {}", e))?,
    };

    // Ensure data directory exists
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Failed to create data dir: {}", e))?;
    // Clear a signal left by a previous process with the same recycled PID.
    // This happens before the new child is recorded as owned, so an exit
    // request for this child cannot race with the removal.
    let sentinel = data_dir.join(format!(".keep-running-{}", std::process::id()));
    match std::fs::remove_file(sentinel) {
        Ok(()) => {},
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
        Err(e) => return Err(format!("Failed to clear old keep-running signal: {e}")),
    }

    println!("=================================================================");
    println!("Starting voicebox-server sidecar");
    println!("Data directory: {:?}", data_dir);
    println!("Remote mode: {}", is_remote);

    // Read the override before probing: forcing CPU must not execute GPU binaries.
    let backend_override = {
        let in_memory = state.backend_override.lock().unwrap().clone();
        in_memory.or_else(|| read_persisted_backend_override(&data_dir))
    };
    let app_version = app.config().version.clone().unwrap_or_default();
    let rocm_dir = data_dir.join("backends").join("rocm");
    let cuda_dir = data_dir.join("backends").join("cuda");
    let suffix = if cfg!(windows) { ".exe" } else { "" };
    let rocm_path = rocm_dir.join(format!("voicebox-server-rocm{suffix}"));
    let cuda_path = cuda_dir.join(format!("voicebox-server-cuda{suffix}"));
    let pin = backend_override.as_deref();
    // A compatible pinned backend excludes the other GPU from launch, so do
    // not execute its version probe. If the pin is stale, probe the fallback.
    let (rocm_binary, cuda_binary) = if pin == Some("cuda") {
        let cuda = probe_gpu_candidate(&cuda_path, &cuda_dir, &app_version, pin, &_start_permit).await?;
        let rocm = if cuda.is_some() { None } else {
            probe_gpu_candidate(&rocm_path, &rocm_dir, &app_version, pin, &_start_permit).await?
        };
        (rocm, cuda)
    } else {
        let rocm = probe_gpu_candidate(&rocm_path, &rocm_dir, &app_version, pin, &_start_permit).await?;
        let cuda = if pin == Some("rocm") && rocm.is_some() { None } else {
            probe_gpu_candidate(&cuda_path, &cuda_dir, &app_version, pin, &_start_permit).await?
        };
        (rocm, cuda)
    };

    #[cfg(target_os = "macos")]
    let custom_cpu = config.cpu_executable.is_some();
    let sidecar_result = match config.cpu_executable {
        Some(path) => Ok(app.shell().command(path)),
        None => app.shell().sidecar("voicebox-server"),
    };

    let mut sidecar = match sidecar_result {
        Ok(s) => s,
        Err(e) => {
            eprintln!("Failed to get sidecar: {}", e);

            // In dev mode, check if the server is already running (started manually)
            #[cfg(debug_assertions)]
            {
                eprintln!("Dev mode: Checking if server is already running on port {}...", config.port);

                // Try to connect to the server port
                if startup_health_check(config.port, &_start_permit).await? {
                    println!("Found server already running on port {}", config.port);
                    _start_permit.commit(|| ()).ok_or("Server startup cancelled")?;
                    return Ok(format!("http://127.0.0.1:{}", config.port));
                }

                eprintln!("");
                eprintln!("=================================================================");
                eprintln!("DEV MODE: No server found on port {}", config.port);
                eprintln!("");
                eprintln!("Start the Python server in a separate terminal:");
                eprintln!("  bun run dev:server");
                eprintln!("=================================================================");
                eprintln!("");
            }

            return Err(format!("Failed to start server. In dev mode, run 'bun run dev:server' in a separate terminal."));
        }
    };

    // macOS ships the large Python runtime as an onedir resource. Launch it
    // beside its support files instead of extracting a onefile archive on
    // every launch. Older bundles and development stubs retain the sidecar.
    #[cfg(target_os = "macos")]
    if !custom_cpu {
        let backend_dir = app
            .path()
            .resource_dir()
            .map_err(|e| format!("Failed to locate bundled backend: {}", e))?
            .join("backend");
        let backend_exe = backend_dir.join("voicebox-server");
        if backend_exe.is_file() {
            println!("Using unpacked macOS backend: {:?}", backend_exe);
            sidecar = app.shell().command(&backend_exe).current_dir(&backend_dir);
        }
    }

    println!("Sidecar command created successfully");

    // Build common args
    let data_dir_str = data_dir
        .to_str()
        .ok_or_else(|| "Invalid data dir path".to_string())?
        .to_string();
    let server_args = server_arguments(&data_dir_str, config.port, std::process::id(), is_remote);

    // Resolve the custom models directory from the parameter or stored state
    let effective_models_dir = state.models_dir.lock().unwrap().clone();
    if let Some(ref dir) = effective_models_dir {
        println!("Custom models directory: {}", dir);
    }

    // Honor a pinned GPU variant by ignoring the other one — but only when the
    // pinned variant is actually installed, so a stale pin to a deleted backend
    // self-heals to the default order instead of forcing CPU. With no pin, both
    // stay eligible and the launch order below prefers ROCm, then CUDA.
    let (rocm_binary, cuda_binary) = eligible_gpu_backends(
        backend_override.as_deref(), rocm_binary, cuda_binary,
    );

    // If ROCm binary exists, launch it from the onedir directory.
    // If CUDA binary exists, launch it from the onedir directory.
    // .current_dir() is critical: PyInstaller onedir expects all DLLs and
    // support files relative to the exe.
    let spawn_result = _start_permit.commit(|| {
        let result = launch_backend(
            backend_override.as_deref(),
            rocm_binary.as_deref(),
            cuda_binary.as_deref(),
            |path| {
                let dir = path.parent().unwrap();
                println!("Launching GPU backend: {:?} (cwd: {:?})", path, dir);
                let mut cmd = app.shell().command(path.to_str().unwrap()).current_dir(dir).args(&server_args);
                if let Some(ref models) = effective_models_dir { cmd = cmd.env("VOICEBOX_MODELS_DIR", models); }
                cmd.spawn()
            },
            || {
                sidecar = sidecar.args(&server_args);
                if let Some(ref models) = effective_models_dir { sidecar = sidecar.env("VOICEBOX_MODELS_DIR", models); }
                println!("Spawning bundled CPU server process...");
                sidecar.spawn()
            },
        );
        result.map(|(rx, child)| {
            let process_pid = child.pid();
            let mut pid = state.server_pid.lock().unwrap();
            let mut managed_child = state.child.lock().unwrap();
            *pid = Some(process_pid);
            *managed_child = Some(child);
            (rx, process_pid)
        })
    }).ok_or("Server startup cancelled")?;

    let (mut rx, process_pid) = match spawn_result {
        Ok(result) => result,
        Err(e) => {
            eprintln!("Failed to spawn server process: {}", e);

            // In dev mode, check if a manually-started server is available
            #[cfg(debug_assertions)]
            {
                if startup_health_check(config.port, &_start_permit).await? {
                    println!("Found manually-started server on port {}", config.port);
                    _start_permit.commit(|| ()).ok_or("Server startup cancelled")?;
                    return Ok(format!("http://127.0.0.1:{}", config.port));
                }

                eprintln!("");
                eprintln!("=================================================================");
                eprintln!("DEV MODE: Server binary failed to start");
                eprintln!("");
                eprintln!("Start the Python server in a separate terminal:");
                eprintln!("  bun run dev:server");
                eprintln!("=================================================================");
                eprintln!("");
                return Err("Dev mode: Start server manually with 'bun run dev:server'".to_string());
            }

            #[cfg(not(debug_assertions))]
            {
                eprintln!("This could be due to:");
                eprintln!("  - Missing or corrupted binary");
                eprintln!("  - Missing execute permissions");
                eprintln!("  - Code signing issues on macOS");
                eprintln!("  - Missing dependencies");
                return Err(format!("Failed to spawn: {}", e));
            }
        }
    };

    // Until the forwarder takes over, cancellation must not orphan this child.
    let startup_cleanup = server_startup::StartupCleanup::new(|| {
        let (process, permit) = state.start_gate.begin_cleanup(|| {
            server_process::take_process(&state.server_pid, &state.child, Some(process_pid))
        });
        if let Some((pid, child)) = process {
            spawn_server_stop(pid, child, permit);
        }
    });

    println!("Server process spawned, waiting for ready signal...");
    println!("=================================================================");

    let startup = _start_permit.until_cancelled(server_startup::wait_for_startup(&mut rx, config.startup_timeout, Some((if is_remote { "0.0.0.0" } else { "127.0.0.1" }, config.port)), |stream, line| {
        if stream == "stderr" { eprintln!("Server: {line}"); } else { println!("Server output: {line}"); }
        let _ = app.emit("server-log", serde_json::json!({ "stream": stream, "line": line }));
    })).await.ok_or("Server startup cancelled")?;
    match startup {
        server_startup::Outcome::Ready => println!("Server is ready!"),
        server_startup::Outcome::TimedOut(errors) => {
            eprintln!("Server startup timeout after 120 seconds");
            for line in errors { eprintln!("  {line}"); }
            #[cfg(debug_assertions)]
            let healthy = startup_health_check(config.port, &_start_permit).await?;
            #[cfg(not(debug_assertions))]
            let healthy = false;
            if healthy {
                println!("Found healthy server on port {}", config.port);
            } else {
                stop_server_if_owned(state.clone(), Some(process_pid)).await?;
                return Err("Server startup timed out. Please retry; check Console.app if the problem persists.".to_string());
            }
        }
        server_startup::Outcome::StreamError(error) => {
            return Err(format!("Server startup output failed: {}", error));
        }
        server_startup::Outcome::Exited => {
            server_process::take_process(&state.server_pid, &state.child, Some(process_pid));
            #[cfg(debug_assertions)]
            {
                if startup_health_check(config.port, &_start_permit).await? {
                    println!("Found manually-started server on port {}", config.port);
                    _start_permit.commit(|| ()).ok_or("Server startup cancelled")?;
                    return Ok(format!("http://127.0.0.1:{}", config.port));
                }
                return Err("Dev mode: Start server manually with 'bun run dev:server'".to_string());
            }
            #[cfg(not(debug_assertions))]
            return Err("Server process ended unexpectedly".to_string());
        }
    }

    _start_permit.commit(|| ()).ok_or("Server startup cancelled")?;
    // Spawn task to continue reading output and emit to frontend
    let app_handle = app.clone();
    tokio::spawn(async move {
        server_startup::forward_events(&mut rx, |stream, line| {
            if stream == "stderr" { eprintln!("Server error: {line}"); } else { println!("Server: {line}"); }
            let _ = app_handle.emit("server-log", serde_json::json!({ "stream": stream, "line": line }));
        }, || {
            let state = app_handle.state::<ServerState>();
            server_process::take_process(&state.server_pid, &state.child, Some(process_pid));
        }).await;
    });

    startup_cleanup.disarm();
    Ok(format!("http://127.0.0.1:{}", config.port))
}

#[command]
async fn stop_server(state: State<'_, ServerState>) -> Result<(), String> {
    stop_server_if_owned(state, None).await
}

async fn stop_server_if_owned(
    state: State<'_, ServerState>,
    expected: Option<u32>,
) -> Result<(), String> {
    stop_server_if_owned_with_generation(state, expected)
        .await
        .map(|_| ())
}

async fn stop_server_if_owned_with_generation(
    state: State<'_, ServerState>,
    expected: Option<u32>,
) -> Result<u64, String> {
    let take_process = || server_process::take_process(&state.server_pid, &state.child, expected);
    let (process, stop_permit) = if expected.is_none() {
        state.start_gate.begin_stop(take_process)
    } else {
        state.start_gate.begin_cleanup(take_process)
    };
    let generation = stop_permit.generation();
    if let Some((pid, child)) = process {
        spawn_server_stop(pid, child, stop_permit)
            .await
            .map_err(|error| format!("Failed to stop server: {}", error))?;
    }
    Ok(generation)
}

fn spawn_server_stop(
    pid: u32,
    child: Option<tauri_plugin_shell::process::CommandChild>,
    stop_permit: server_startup::StopPermit,
) -> tokio::task::JoinHandle<()> {
    tokio::task::spawn_blocking(move || {
        // Keep the gate held even if the async caller is cancelled.
        let _stop_permit = stop_permit;
        let _child = child;
        println!("stop_server: Stopping server with PID: {}", pid);

        #[cfg(unix)]
        {
            use std::process::Command;
            let _ = Command::new("kill")
                .args(["-TERM", "--", &format!("-{}", pid)])
                .output();
            std::thread::sleep(std::time::Duration::from_millis(100));
            let _ = Command::new("kill")
                .args(["-9", "--", &format!("-{}", pid)])
                .output();
            let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
            println!("stop_server: Process group kill completed");
        }

        #[cfg(windows)]
        {
            // Terminate the captured process tree, never a replacement server.
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .output();
        }
    })
}

#[command]
async fn restart_server<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, ServerState>,
    models_dir: Option<String>,
) -> Result<String, String> {
    restart_server_with(app, state, models_dir, ServerStartupConfig::default(), std::time::Duration::from_secs(30), std::time::Duration::from_millis(1000)).await
}

async fn restart_server_with<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, ServerState>,
    models_dir: Option<String>,
    config: ServerStartupConfig,
    stop_timeout: std::time::Duration,
    release_delay: std::time::Duration,
) -> Result<String, String> {
    println!("restart_server: stopping current server...");
    update_models_dir(&state.models_dir, models_dir.as_deref());
    let generation = stop_server_if_owned_with_generation(state.clone(), None).await?;
    state
        .start_gate
        .until_generation_cancelled(
            generation,
            tokio::time::timeout(stop_timeout, state.start_gate.wait_until_idle()),
        )
        .await
        .ok_or("Server restart cancelled")?
        .map_err(|_| "Previous server startup or cleanup did not stop in time".to_string())?;
    println!("restart_server: waiting for port release...");
    state
        .start_gate
        .until_generation_cancelled(generation, tokio::time::sleep(release_delay))
        .await
        .ok_or("Server restart cancelled")?;
    println!("restart_server: starting server...");
    start_server_with_generation(app, state, None, None, config, Some(generation)).await
}

#[command]
fn set_keep_server_running(state: State<'_, ServerState>, keep_running: bool) {
    println!("set_keep_server_running called with: {}", keep_running);
    *state.keep_running_on_close.lock().unwrap() = keep_running;
}

#[command]
fn set_backend_override(
    app: tauri::AppHandle,
    state: State<'_, ServerState>,
    backend: Option<String>,
) -> Result<(), String> {
    let data_dir = app.path().app_data_dir()
        .map_err(|error| format!("Failed to locate backend settings: {error}"))?;
    save_backend_override(&data_dir, &state.backend_override, backend)
}

#[command]
async fn start_system_audio_capture(
    state: State<'_, audio_capture::AudioCaptureState>,
    max_duration_secs: u32,
) -> Result<(), String> {
    start_system_audio_capture_with(max_duration_secs, |duration| {
        audio_capture::start_capture(&state, duration)
    })
    .await
}

async fn start_system_audio_capture_with<F, Fut>(
    max_duration_secs: u32,
    start: F,
) -> Result<(), String>
where
    F: FnOnce(u32) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    audio_capture::validate_capture_duration(max_duration_secs)?;
    start(max_duration_secs).await
}

#[command]
async fn stop_system_audio_capture(
    state: State<'_, audio_capture::AudioCaptureState>,
) -> Result<String, String> {
    audio_capture::stop_capture(&state).await
}

#[command]
fn is_system_audio_supported() -> bool {
    audio_capture::is_supported()
}

#[command]
fn list_audio_output_devices(
    state: State<'_, audio_output::AudioOutputState>,
) -> Result<Vec<audio_output::AudioOutputDevice>, String> {
    state.list_output_devices()
}

#[command]
async fn play_audio_to_devices<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, audio_output::AudioOutputState>,
    request: tauri::ipc::Request<'_>,
) -> Result<audio_output::PlaybackSession, String> {
    let (audio_data, device_ids, options) = audio_output::read_playback_request(
        request.body(),
        request
            .headers()
            .get("x-voicebox-playback")
            .and_then(|value| value.to_str().ok()),
    )?;
    state
        .play_audio_to_devices(app, audio_data, device_ids, options)
        .await
}

#[command]
async fn start_audio_pcm_stream<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, audio_output::AudioOutputState>,
    sample_rate: u32,
    device_ids: Vec<String>,
) -> Result<audio_output::PlaybackSession, String> {
    state.start_pcm_stream(app, sample_rate, device_ids).await
}

#[command]
async fn append_audio_pcm_stream(
    state: State<'_, audio_output::AudioOutputState>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let id = request
        .headers()
        .get("x-voicebox-session")
        .and_then(|value| value.to_str().ok())
        .filter(|value| value.len() <= 128)
        .ok_or("Missing preview session")?
        .to_owned();
    let tauri::ipc::InvokeBody::Raw(pcm) = request.body() else {
        return Err("Preview requires binary PCM".into());
    };
    state.append_pcm_stream(&id, pcm.clone()).await
}

#[command]
fn finish_audio_pcm_stream(
    state: State<'_, audio_output::AudioOutputState>,
    session_id: String,
) -> Result<(), String> {
    state.finish_pcm_stream(&session_id)
}

#[command]
fn control_audio_playback(
    state: State<'_, audio_output::AudioOutputState>,
    session_id: String,
    control: audio_output::PlaybackControl,
) -> Result<(), String> {
    state.control_playback(&session_id, control)
}

#[command]
fn stop_audio_playback(
    state: State<'_, audio_output::AudioOutputState>,
    session_id: Option<String>,
) -> Result<(), String> {
    state.stop_playback(session_id.as_deref())
}

/// Identifier of the Voicebox app itself — used to short-circuit auto-paste
/// when the user fires a chord while focus was inside one of our own
/// windows. Paste into Voicebox-internal targets is step 6 territory and
/// goes through a different (JS-side) injection path.
///
/// Value matches what `focus_capture::capture_focus` writes into
/// `FocusSnapshot::bundle_id` on the current platform — reverse-DNS bundle
/// id on macOS, lowercased exe basename on Windows/Linux.
#[cfg(target_os = "macos")]
const VOICEBOX_BUNDLE_ID: &str = "sh.voicebox.app";
#[cfg(target_os = "windows")]
const VOICEBOX_BUNDLE_ID: &str = "voicebox.exe";
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
const VOICEBOX_BUNDLE_ID: &str = "voicebox";

/// Milliseconds to wait between activating the target app and firing the
/// synthetic ⌘V, giving AppKit time to finish re-ordering windows and
/// restoring its last-focused field.
const POST_ACTIVATE_SETTLE_MS: u64 = 120;

/// Milliseconds the staged text lives on the clipboard after the paste
/// keystroke, before we restore the user's original clipboard contents.
/// Too short and slow apps haven't consumed the paste yet; too long and
/// the user sees our text if they look at their clipboard manager.
const PASTE_CONSUME_MS: u64 = 400;

/// Reports whether the process currently has macOS Accessibility trust.
/// Used by the settings UI and the paste debug harness to decide whether
/// synthetic key events will actually land.
#[command]
fn check_accessibility_permission() -> bool {
    accessibility::is_trusted()
}

/// Reports whether the process can observe global keyboard events. Read by
/// the Captures settings UI to surface a "missing — open Settings" hint
/// beside the hotkey toggle. No prompt side-effect.
#[command]
fn check_input_monitoring_permission() -> bool {
    input_monitoring::is_trusted()
}

/// Holds the lazily-spawned global hotkey monitor. The monitor is `None`
/// until the user opts in via the Captures settings toggle — that opt-in is
/// what triggers the macOS Input Monitoring TCC prompt, so a fresh-install
/// user who never enables the hotkey never sees the prompt.
///
/// Disabling the hotkey clears the monitor's internal `ChordMatcher` so
/// keytap's event tap is released while Tauri still owns this `HotkeyState`
/// for the rest of the process. A subsequent enable re-arms without
/// re-prompting for the Input Monitoring permission.
#[cfg(desktop)]
#[derive(Default)]
pub struct HotkeyState {
    monitor: Mutex<Option<hotkey_monitor::HotkeyMonitor>>,
}

#[cfg(desktop)]
fn build_chord_bindings(
    push_to_talk: &[String],
    toggle_to_talk: &[String],
) -> Result<hotkey_monitor::Bindings, String> {
    use hotkey_monitor::{Bindings, ChordAction};
    use keytap::Key;
    use std::collections::HashSet;

    fn build_chord(name: &str, names: &[String]) -> Result<HashSet<Key>, String> {
        if names.is_empty() {
            return Err(format!("{name} chord must have at least one key"));
        }
        let mut chord = HashSet::new();
        for raw in names {
            let key = key_codes::key_from_str(raw)
                .ok_or_else(|| format!("Unsupported key in {name} chord: {raw}"))?;
            chord.insert(key);
        }
        Ok(chord)
    }

    let push_chord = build_chord("push-to-talk", push_to_talk)?;
    let toggle_chord = build_chord("toggle-to-talk", toggle_to_talk)?;
    if push_chord == toggle_chord {
        return Err("Push-to-talk and toggle-to-talk chords must be different".to_string());
    }

    let mut bindings = Bindings::new();
    bindings.insert(ChordAction::PushToTalk, push_chord);
    bindings.insert(ChordAction::ToggleToTalk, toggle_chord);
    Ok(bindings)
}

/// Spawn the global hotkey monitor on first call; subsequent calls just push
/// the new bindings into the existing monitor. Idempotent on purpose — the
/// frontend invokes this both at startup (when `capture_settings.hotkey_enabled`
/// is true) and from the settings toggle.
///
/// On macOS this is the call that triggers the "Voicebox would like to receive
/// keystrokes from any application" TCC prompt, since keytap's `Tap` creates
/// the CGEventTap inside `HotkeyMonitor::spawn`.
#[cfg(desktop)]
#[command]
fn enable_hotkey(
    app: tauri::AppHandle,
    state: State<'_, HotkeyState>,
    push_to_talk: Vec<String>,
    toggle_to_talk: Vec<String>,
) -> Result<(), String> {
    let bindings = build_chord_bindings(&push_to_talk, &toggle_to_talk)?;

    // Fire the Input Monitoring TCC prompt explicitly from the user's
    // toggle click, before keytap's Tap would do it implicitly via
    // CGEventTap creation. This makes the prompt timing deterministic — it appears in response to a click instead of as a
    // mysterious side-effect of "the app started". The call returns the
    // current grant state; keytap reports an error if the tap cannot start,
    // and the settings UI polls permission separately.
    let _ = input_monitoring::request();

    configure_hotkey_window(
        app.get_webview_window(DICTATE_WINDOW_LABEL).is_some(),
        || build_dictate_window(&app).map(|_| ()).map_err(|e| e.to_string()),
        || stop_hotkey(&state),
        || {
            let mut slot = state.monitor.lock().map_err(|e| e.to_string())?;
            match slot.as_mut() {
                Some(monitor) => monitor.update_bindings(bindings)?,
                None => {
                    *slot = Some(hotkey_monitor::HotkeyMonitor::spawn(app.clone(), bindings)?);
                }
            }
            Ok(())
        },
    )
}

// The dictation window must exist before chords can reach the recorder.
#[cfg(desktop)]
fn configure_hotkey_window(
    window_exists: bool,
    create_window: impl FnOnce() -> Result<(), String>,
    stop: impl FnOnce() -> Result<(), String>,
    arm: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if !window_exists {
        if let Err(error) = create_window() {
            let error = format!("Unable to create dictation window: {error}");
            return match stop() {
                Ok(()) => Err(error),
                Err(stop_error) => Err(format!("{error}; unable to stop hotkey: {stop_error}")),
            };
        }
    }
    arm()
}

#[cfg(desktop)]
fn stop_hotkey(state: &HotkeyState) -> Result<(), String> {
    let mut slot = state.monitor.lock().map_err(|e| e.to_string())?;
    if let Some(monitor) = slot.as_mut() {
        monitor.update_bindings(hotkey_monitor::Bindings::new())?;
    }
    Ok(())
}

/// Quiet the global hotkey. Tears down the `ChordMatcher` (which stops
/// keytap's chord worker and closes the OS event tap) but keeps the
/// `HotkeyMonitor` handle around so a subsequent `enable_hotkey` re-arms
/// without re-prompting for Input Monitoring permission.
#[cfg(desktop)]
#[command]
fn disable_hotkey(state: State<'_, HotkeyState>) -> Result<(), String> {
    stop_hotkey(&state)
}

/// Push a new chord configuration into the running `HotkeyMonitor`. Called
/// by the chord-picker UI when the user edits the chord. No-ops when the
/// monitor isn't spawned — the picker is gated behind the enable toggle, so
/// this can only happen if the frontend races; the next `enable_hotkey` will
/// pick up the saved chords.
///
/// Returns an error when a key name doesn't map to a `keytap::Key`, so the
/// picker UI can surface "this key isn't supported" instead of silently
/// dropping it from the chord.
#[cfg(desktop)]
#[command]
fn update_chord_bindings(
    state: State<'_, HotkeyState>,
    push_to_talk: Vec<String>,
    toggle_to_talk: Vec<String>,
) -> Result<(), String> {
    let bindings = build_chord_bindings(&push_to_talk, &toggle_to_talk)?;
    let mut slot = state.monitor.lock().map_err(|e| e.to_string())?;
    if let Some(monitor) = slot.as_mut() {
        monitor.update_bindings(bindings)?;
    }
    Ok(())
}

/// Open the Privacy & Security → Accessibility pane in System Settings so
/// the user can grant the permission. The URL scheme is stable across
/// macOS 10.14–15; no-op on other platforms.
#[command]
fn open_accessibility_settings(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let url = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
        app.shell()
            .open(url, None)
            .map_err(|e| format!("Failed to open Accessibility settings: {e}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("Accessibility settings pane is only implemented on macOS".into())
    }
}

/// Open the Privacy & Security → Input Monitoring pane in System Settings.
/// Used by the Captures settings UI when the toggle is on but the grant
/// is missing, so the user can flip the system toggle without hunting.
#[command]
fn open_input_monitoring_settings(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let url = "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent";
        app.shell()
            .open(url, None)
            .map_err(|e| format!("Failed to open Input Monitoring settings: {e}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("Input Monitoring settings pane is only implemented on macOS".into())
    }
}

/// Deliver `text` into the UI that had focus when the chord fired.
///
/// Pipeline: activate the captured PID → settle → save the user's
/// clipboard → write `text` → fire ⌘V → wait for the target to consume it
/// → conditionally restore the original clipboard.
///
/// The restore is conditional on `NSPasteboard.changeCount` (or the
/// Windows sequence number) matching the value captured right after
/// `write_text`: if something else wrote to the clipboard during the
/// paste-consume window — the user's own ⌘C in the target app, a
/// clipboard history tool (Paste, Pastebot, Maccy), Universal Clipboard
/// sync, 1Password inserting a secret — their newer content takes
/// priority over our snapshot and is preserved. A
/// [`clipboard::current_change_count`] read failure is treated the same
/// way: unknown state is safer than an unconditional overwrite.
///
/// `send_paste` failure is isolated from the restore decision: we always
/// attempt the conditional restore before propagating the paste error,
/// so a failed `CGEventPost` / `SendInput` never leaves the user's
/// clipboard stuck on the transcript.
///
/// Skips (returns `false`) without touching anything when:
/// - `focus.bundle_id` is Voicebox itself — step 6 will inject directly
///   into our own webview; pasting would just double-insert or miss the
///   real target.
///
/// Missing Accessibility trust returns an error before touching the clipboard;
/// otherwise returns `true` when the paste sequence completes end-to-end.
#[command]
async fn paste_final_text(
    text: String,
    focus: focus_capture::FocusSnapshot,
) -> Result<bool, String> {
    paste_pipeline::paste_final_text(&text, &focus, &paste_pipeline::NativePaste, tokio::time::sleep).await
}

/// Inspect the currently focused UI element. Returns the owning app's PID,
/// bundle id, and AX role. Useful for sanity-checking the focus pipeline
/// before committing to a paste.
#[command]
fn debug_capture_focus() -> Result<focus_capture::FocusSnapshot, String> {
    focus_capture::capture_focus()
}

/// Full auto-paste rehearsal: snapshot the focus target now, sleep
/// `drift_ms` so the user can deliberately switch to a different app
/// (proving we don't paste into whichever window is frontmost when the
/// transcribe finishes), then activate the captured PID, stage `text`,
/// fire ⌘V, and restore the clipboard.
#[command]
async fn debug_focus_roundtrip(
    text: String,
    drift_ms: u64,
    post_paste_delay_ms: u64,
) -> Result<serde_json::Value, String> {
    if !accessibility::is_trusted() {
        return Err(
            "Accessibility permission not granted. Open System Settings → Privacy & Security → Accessibility and enable Voicebox."
                .into(),
        );
    }

    let snapshot = focus_capture::capture_focus()?;

    tokio::time::sleep(std::time::Duration::from_millis(drift_ms)).await;

    focus_capture::activate_pid(snapshot.pid)?;
    // Give AppKit a beat to process the activation before the synthetic
    // Cmd+V arrives — without this the paste sometimes races ahead of the
    // window-ordering animation and lands in the previous frontmost app.
    tokio::time::sleep(std::time::Duration::from_millis(120)).await;

    let result = paste_pipeline::diagnostic_clipboard(
        &text,
        std::time::Duration::ZERO,
        std::time::Duration::from_millis(post_paste_delay_ms),
        true,
    ).await?;
    let after_write = result.after_write;
    let before_restore = result.before_restore;

    Ok(serde_json::json!({
        "focus": snapshot,
        "change_count_after_write": after_write,
        "change_count_before_restore": before_restore,
        "clobbered_during_paste": before_restore != after_write,
    }))
}

/// End-to-end smoke test for the auto-paste pipeline: save the user's
/// clipboard, stage `text`, optionally wait `pre_paste_delay_ms` so the
/// caller has time to focus the target app, synthesise ⌘V, wait
/// `post_paste_delay_ms` for the target app to consume the event, and restore
/// the original clipboard if no other application changed it.
///
/// Short-circuits when Accessibility permission is missing — without it
/// `CGEventPost` silently drops events, so running the full sequence
/// would just clobber the clipboard with nothing to show for it.
#[command]
async fn debug_paste_text(
    text: String,
    pre_paste_delay_ms: u64,
    post_paste_delay_ms: u64,
) -> Result<serde_json::Value, String> {
    if !accessibility::is_trusted() {
        return Err(
            "Accessibility permission not granted. Open System Settings → Privacy & Security → Accessibility and enable Voicebox, then try again."
                .into(),
        );
    }

    let result = paste_pipeline::diagnostic_clipboard(
        &text,
        std::time::Duration::from_millis(pre_paste_delay_ms),
        std::time::Duration::from_millis(post_paste_delay_ms),
        true,
    ).await?;
    let before = result.snapshot.change_count();
    let after_write = result.after_write;
    let before_restore = result.before_restore;
    let after_restore = result.after_restore;

    Ok(serde_json::json!({
        "change_count_before": before,
        "change_count_after_write": after_write,
        "change_count_before_restore": before_restore,
        "change_count_after_restore": after_restore,
        "clobbered_during_paste": before_restore != after_write,
    }))
}

/// Manual smoke test for the clipboard snapshot/restore primitives used by
/// the auto-paste pipeline. Stages `text` on the pasteboard, waits
/// `hold_ms` so the caller can ⌘V into another app, then restores the original
/// clipboard contents if no other application changed them. The return value reports the change-count deltas
/// so the harness can verify no third party mutated the clipboard mid-paste.
#[command]
async fn debug_clipboard_roundtrip(
    text: String,
    hold_ms: u64,
) -> Result<serde_json::Value, String> {
    let result = paste_pipeline::diagnostic_clipboard(
        &text,
        std::time::Duration::ZERO,
        std::time::Duration::from_millis(hold_ms),
        false,
    ).await?;
    let before = result.snapshot.change_count();
    let item_count = result.snapshot.item_count();
    let after_write = result.after_write;
    let before_restore = result.before_restore;
    let after_restore = result.after_restore;

    Ok(serde_json::json!({
        "saved_items": item_count,
        "change_count_before": before,
        "change_count_after_write": after_write,
        "change_count_before_restore": before_restore,
        "change_count_after_restore": after_restore,
        "clobbered_during_hold": before_restore != after_write,
    }))
}

/// Final step of the main-window close flow, after the frontend has had its
/// chance to stop the server.
///
/// On Linux, closing the main window must exit the process: the hidden dictate
/// pill webview is still a window, so Tauri would otherwise keep running with
/// no UI, the backend already stopped, and `speak_monitor` retrying
/// `/events/speak` every 30 s (#1040). On macOS and Windows the window just
/// closes, as before, so "Keep server running" plus the global hotkey keep
/// dictation available without the main window.
fn finish_main_window_close<R: tauri::Runtime>(window: &tauri::Window<R>) {
    if cfg!(target_os = "linux") {
        window.app_handle().exit(0);
    } else {
        window.close().ok();
    }
}

const CLOSE_IDLE: u64 = 0;
const CLOSE_CLEANUP: u64 = 1;
const CLOSE_READY: u64 = 2;
const CLOSE_PHASE_MASK: u64 = 3;

fn handle_window_event<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    event: &WindowEvent,
    closing: std::sync::Arc<std::sync::atomic::AtomicU64>,
) {
    handle_window_event_with_timeout(window, event, closing, std::time::Duration::from_secs(5));
}

fn handle_window_event_with_timeout<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    event: &WindowEvent,
    closing: std::sync::Arc<std::sync::atomic::AtomicU64>,
    timeout: std::time::Duration,
) {
    if window.label() != "main" {
        return;
    }
    if matches!(event, WindowEvent::Destroyed) {
        // Invalidate every pending timeout before accepting another close.
        closing.fetch_update(std::sync::atomic::Ordering::SeqCst, std::sync::atomic::Ordering::SeqCst, |state| {
            Some((state & !CLOSE_PHASE_MASK).wrapping_add(CLOSE_PHASE_MASK + 1))
        }).ok();
        return;
    }
    if let WindowEvent::CloseRequested { api, .. } = event {
        let ticket = loop {
            let current = closing.load(std::sync::atomic::Ordering::SeqCst);
            match current & CLOSE_PHASE_MASK {
                CLOSE_IDLE => {
                    let ticket = current | CLOSE_CLEANUP;
                    if closing.compare_exchange(current, ticket, std::sync::atomic::Ordering::SeqCst, std::sync::atomic::Ordering::SeqCst).is_ok() {
                        api.prevent_close();
                        break ticket;
                    }
                }
                CLOSE_CLEANUP => {
                    api.prevent_close();
                    return;
                }
                _ => return, // Cleanup finished; let the final close proceed.
            }
        };

        // Emit event to frontend to check setting and stop server if needed
        let app_handle = window.app_handle();

        let window_for_close = window.clone();
        let closing_for_timeout = closing.clone();
        let (tx, mut rx) = mpsc::unbounded_channel::<()>();
        let listener_id = match window_close::request_cleanup(
            || {
                let expected = ticket.to_string();
                window.listen("window-close-allowed", move |event| {
                    if serde_json::from_str::<String>(event.payload()).ok().as_deref() == Some(expected.as_str()) {
                        let _ = tx.send(());
                    }
                })
            },
            || app_handle.emit("window-close-requested", ticket.to_string()),
            |id| window.unlisten(id),
        ) {
            Ok(id) => id,
            Err(e) => {
                eprintln!("Failed to emit window-close-requested event: {}", e);
                if closing.compare_exchange(ticket, (ticket & !CLOSE_PHASE_MASK) | CLOSE_READY, std::sync::atomic::Ordering::SeqCst, std::sync::atomic::Ordering::SeqCst).is_ok() {
                    finish_main_window_close(window);
                }
                return;
            }
        };

        tauri::async_runtime::spawn(async move {
            tokio::select! {
                _ = rx.recv() => println!("Frontend cleanup complete, closing"),
                _ = tokio::time::sleep(timeout) => {
                    eprintln!("Window close timeout, closing anyway");
                }
            }
            window_for_close.unlisten(listener_id);
            // close() posts another close request to the native event loop.
            // Keep it authorized until the window's Destroyed event arrives.
            if closing_for_timeout.compare_exchange(ticket, (ticket & !CLOSE_PHASE_MASK) | CLOSE_READY, std::sync::atomic::Ordering::SeqCst, std::sync::atomic::Ordering::SeqCst).is_ok() {
                finish_main_window_close(&window_for_close);
            }
        });
    }
}

fn handle_server_exit_with(
    state: &ServerState,
    keep_alive: impl FnOnce(),
    stop: impl FnOnce(u32),
) {
    let keep_running = *state.keep_running_on_close.lock().unwrap();
    let has_pid = state.server_pid.lock().unwrap().is_some();
    println!("RunEvent::Exit — keep_running={}, has_pid={}", keep_running, has_pid);
    if keep_running {
        if has_pid { keep_alive(); }
    } else {
        #[cfg(unix)]
        if let Some(pid) = state.server_pid.lock().unwrap().take() { stop(pid); }
        #[cfg(not(unix))]
        let _ = stop;
    }
}

fn keep_server_running_on_exit(data_dir: Option<&std::path::Path>, port: u16) {
    println!("Keep server running: disabling watchdog...");
    if let Some(data_dir) = data_dir {
        let sentinel = data_dir.join(format!(".keep-running-{}", std::process::id()));
        if let Err(e) = std::fs::write(&sentinel, b"1") {
            eprintln!("Failed to write keep-running sentinel: {}", e);
        } else {
            println!("Wrote keep-running sentinel to {:?}", sentinel);
        }
    } else {
        eprintln!("Failed to locate the data directory for the keep-running sentinel");
    }
    let client = match reqwest::blocking::Client::builder().timeout(std::time::Duration::from_secs(2)).build() {
        Ok(client) => client,
        Err(error) => { eprintln!("Failed to create watchdog client: {}", error); return; }
    };
    match client.post(&format!("http://127.0.0.1:{}/watchdog/disable", port)).send() {
        Ok(resp) => println!("Watchdog disable response: {}", resp.status()),
        Err(e) => eprintln!("Failed to disable watchdog: {}", e),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .manage(ServerState {
            start_gate: Arc::new(server_startup::StartGate::default()),
            child: Mutex::new(None),
            server_pid: Mutex::new(None),
            keep_running_on_close: Mutex::new(false),
            remote: Mutex::new(false),
            models_dir: Mutex::new(None),
            backend_override: Mutex::new(None),
        })
        .manage(audio_capture::AudioCaptureState::new())
        .manage(audio_output::AudioOutputState::new())
        .setup(|app| {
            #[cfg(desktop)]
            {
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;

                // Resolve the active keyboard layout's V keycode now, on
                // the main thread, and register an observer for layout
                // changes. The synthetic-paste hot path then only reads an
                // atomic. See keyboard_layout.rs for why this matters
                // (Cmd+V is matched by translated character, not keycode,
                // so QWERTY keycode 9 produces Cmd+. on Dvorak).
                keyboard_layout::init();

                // HotkeyMonitor is spawned lazily via the `enable_hotkey`
                // command — see HotkeyState. The hidden dictate webview is
                // safe to build up front because it does not create the global
                // keyboard tap or trigger the macOS Input Monitoring prompt.
                app.manage(HotkeyState::default());

                install_dictate_window_handlers(app.handle());
                ensure_dictate_window(app.handle());
                speak_monitor::spawn_speak_monitor(app.handle().clone());
            }

            // Hide title bar icon on Windows
            #[cfg(windows)]
            {
                use windows::Win32::Foundation::HWND;
                use windows::Win32::UI::WindowsAndMessaging::{SetClassLongPtrW, GCLP_HICON, GCLP_HICONSM};
                
                if let Some((_, window)) = app.webview_windows().iter().next() {
                    if let Ok(hwnd) = window.hwnd() {
                        let hwnd = HWND(hwnd.0);
                        unsafe {
                            // Set both small and regular icons to NULL to hide the title bar icon
                            SetClassLongPtrW(hwnd, GCLP_HICON, 0);
                            SetClassLongPtrW(hwnd, GCLP_HICONSM, 0);
                        }
                    }
                }
            }

            // Enable microphone access on Linux (WebKitGTK denies getUserMedia by default)
            #[cfg(target_os = "linux")]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.with_webview(|webview| {
                        use webkit2gtk::{WebViewExt, SettingsExt, PermissionRequestExt, UserMediaPermissionRequestExt};
                        use webkit2gtk::glib::prelude::Cast;
                        use webkit2gtk::glib::translate::ToGlibPtr;
                        let wk_webview = webview.inner();

                        // Enable media stream support in WebKitGTK settings
                        if let Some(settings) = WebViewExt::settings(&wk_webview) {
                            settings.set_enable_media_stream(true);
                        }

                        // Auto-grant UserMediaPermissionRequest (microphone access)
                        // Only for trusted local origins (Tauri dev server or custom protocol)
                        wk_webview.connect_permission_request(move |webview, request: &webkit2gtk::PermissionRequest| {
                            if let Some(media) = request.downcast_ref::<webkit2gtk::UserMediaPermissionRequest>() {
                                let uri = WebViewExt::uri(webview).unwrap_or_default();
                                // The high-level bindings do not expose this WebKit query.
                                let display = unsafe {
                                    webkit2gtk::ffi::webkit_user_media_permission_is_for_display_device(media.to_glib_none().0) != 0
                                };
                                if allow_media_request(&uri, media.is_for_audio_device(), media.is_for_video_device(), display) {
                                    request.allow();
                                    return true;
                                }
                                request.deny();
                                return true;
                            }
                            false
                        });
                    });
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            publication_commands::publish_file_bytes,
            publication_commands::publish_file_url,
            start_server,
            stop_server,
            restart_server,
            set_keep_server_running,
            set_backend_override,
            start_system_audio_capture,
            stop_system_audio_capture,
            is_system_audio_supported,
            list_audio_output_devices,
            play_audio_to_devices,
            start_audio_pcm_stream,
            append_audio_pcm_stream,
            finish_audio_pcm_stream,
            stop_audio_playback,
            control_audio_playback,
            debug_clipboard_roundtrip,
            debug_paste_text,
            debug_capture_focus,
            debug_focus_roundtrip,
            check_accessibility_permission,
            check_input_monitoring_permission,
            open_accessibility_settings,
            open_input_monitoring_settings,
            paste_final_text,
            enable_hotkey,
            disable_hotkey,
            update_chord_bindings
        ])
        .on_window_event({
            let closing = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(CLOSE_IDLE));
            move |window, event| handle_window_event(window, event, closing.clone())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            let _ = &app; // used on unix
            match &event {
                RunEvent::Exit => {
                    let state = app.state::<ServerState>();
                    handle_server_exit_with(&state, || {
                        let data_dir = app.path().app_data_dir().ok();
                        keep_server_running_on_exit(data_dir.as_deref(), SERVER_PORT);
                    }, |pid| {
                        #[cfg(unix)]
                        {
                            use std::process::Command;
                            let _ = Command::new("kill").args(["-TERM", "--", &format!("-{}", pid)]).output();
                            std::thread::sleep(std::time::Duration::from_millis(100));
                            let _ = Command::new("kill").args(["-9", "--", &format!("-{}", pid)]).output();
                            let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
                        }
                        #[cfg(not(unix))]
                        let _ = pid;
                    });
                }
                #[cfg(target_os = "macos")]
                RunEvent::Reopen { has_visible_windows, .. } => {
                    if !has_visible_windows {
                        if let Some(main_win) = app.get_webview_window("main") {
                            let _ = main_win.show();
                            let _ = main_win.set_focus();
                        }
                    }
                }
                RunEvent::ExitRequested { api, .. } => {
                    println!("RunEvent::ExitRequested received");
                    // Don't prevent exit, just log it
                    let _ = api;
                }
                _ => {}
            }
        });
}

fn main() {
    run();
}

#[cfg(all(test, unix))]
mod backend_probe_tests {
    use super::probe_binary_version;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new(script: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("voicebox-probe-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
            fs::create_dir(&dir).unwrap();
            let exe = dir.join("backend");
            fs::write(&exe, format!("#!/bin/sh\n{script}\n")).unwrap();
            fs::set_permissions(&exe, fs::Permissions::from_mode(0o700)).unwrap();
            Self(dir)
        }
        async fn probe(&self) -> Option<String> {
            probe_binary_version(&self.0.join("backend"), &self.0).await
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    #[tokio::test]
    async fn valid_server_version_is_read_from_successful_process() {
        let f = Fixture::new("printf 'voicebox-server 0.6.0\\n'");
        assert_eq!(f.probe().await.as_deref(), Some("0.6.0"));
    }
    #[tokio::test]
    async fn unsuccessful_process_cannot_report_a_usable_version() {
        let f = Fixture::new("printf 'voicebox-server 0.6.0\\n'; exit 3");
        assert_eq!(f.probe().await, None);
    }
    #[tokio::test]
    async fn unrelated_stdout_is_not_a_server_version() {
        let f = Fixture::new("printf 'not-the-server 0.6.0\\n'");
        assert_eq!(f.probe().await, None);
    }
    #[tokio::test]
    async fn version_line_can_be_followed_by_unrelated_output() {
        let f = Fixture::new("printf 'voicebox-server 0.6.0\\nwarning from startup\\n'");
        assert_eq!(f.probe().await.as_deref(), Some("0.6.0"));
    }
    #[tokio::test]
    async fn invalid_utf8_cannot_masquerade_as_version_output() {
        let f = Fixture::new("printf 'voicebox-server 0.6.0\\377\\n'");
        assert_eq!(f.probe().await, None);
    }
    #[tokio::test]
    async fn ambiguous_version_lines_are_rejected() {
        let f = Fixture::new("printf 'voicebox-server 0.6.0\\nvoicebox-server 0.7.0\\n'");
        assert_eq!(f.probe().await, None);
    }
    #[tokio::test]
    async fn missing_executable_and_empty_output_are_not_versions() {
        let f = Fixture::new("exit 0");
        assert_eq!(f.probe().await, None);
        assert_eq!(probe_binary_version(&f.0.join("missing"), &f.0).await, None);
    }
}

#[cfg(all(test, desktop))]
mod chord_validation_tests {
    use super::build_chord_bindings;
    use crate::hotkey_monitor::ChordAction;
    use keytap::Key;
    use std::collections::HashSet;

    fn keys(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn defaults_allow_superset_and_preserve_key_identity() {
        let bindings = build_chord_bindings(
            &keys(&["MetaRight", "AltGr"]),
            &keys(&["MetaRight", "AltRight", "Space"]),
        ).unwrap();
        assert_eq!(bindings[&ChordAction::PushToTalk], HashSet::from([Key::MetaRight, Key::AltRight]));
        assert_eq!(bindings[&ChordAction::ToggleToTalk], HashSet::from([Key::MetaRight, Key::AltRight, Key::Space]));
    }

    #[test]
    fn empty_and_unsupported_chords_are_rejected() {
        assert!(build_chord_bindings(&[], &keys(&["Space"])).is_err());
        assert!(build_chord_bindings(&keys(&["Space"]), &[]).is_err());
        assert!(build_chord_bindings(&keys(&["Unknown"]), &keys(&["Space"])).is_err());
    }

    #[test]
    fn identical_chords_are_rejected_even_with_aliases_and_reordered_keys() {
        let error = build_chord_bindings(
            &keys(&["MetaRight", "AltGr"]),
            &keys(&["AltRight", "MetaRight"]),
        ).unwrap_err();
        assert!(error.contains("different"), "{error}");
    }
}

#[cfg(test)]
mod server_health_tests {
    use super::check_health;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    fn serve(status: &str, headers: &str, body: &str) -> (u16, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let response = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}", body.len());
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(std::time::Duration::from_secs(3))).unwrap();
            let mut buf = [0; 1024];
            let _ = stream.read(&mut buf);
            let _ = stream.write_all(response.as_bytes());
        });
        (port, handle)
    }

    #[test]
    fn valid_health_requires_expected_fields_and_success_status() {
        for (status, body, expected) in [
            ("200 OK", r#"{"status":"healthy","model_loaded":false,"gpu_available":true}"#, true),
            ("200 OK", r#"{"status":"healthy","model_loaded":true}"#, false),
            ("200 OK", r#"{"status":"healthy","model_loaded":1,"gpu_available":true}"#, false),
            ("200 OK", r#"{"status":"degraded","model_loaded":true,"gpu_available":false}"#, false),
            ("200 OK", "not json", false),
            ("503 Service Unavailable", r#"{"status":"healthy","model_loaded":true,"gpu_available":true}"#, false),
        ] {
            let (port, handle) = serve(status, "", body);
            assert_eq!(check_health(port), expected, "{status}: {body}");
            handle.join().unwrap();
        }
    }

    #[test]
    fn non_ok_success_statuses_do_not_identify_a_voicebox_server() {
        let body = r#"{"status":"healthy","model_loaded":true,"gpu_available":false}"#;
        for status in ["201 Created", "202 Accepted", "206 Partial Content"] {
            let (port, handle) = serve(status, "", body);
            assert!(!check_health(port), "unexpectedly accepted {status}");
            handle.join().unwrap();
        }
    }

    #[test]
    fn redirect_must_not_turn_an_unrelated_service_into_a_healthy_backend() {
        let (target, target_handle) = serve("200 OK", "", r#"{"status":"healthy","model_loaded":true,"gpu_available":false}"#);
        let (source, source_handle) = serve("302 Found", &format!("Location: http://127.0.0.1:{target}/health\r\n"), "");
        let healthy = check_health(source);
        source_handle.join().unwrap();
        // Release the target listener whether or not the client followed the redirect.
        let _ = std::net::TcpStream::connect(("127.0.0.1", target));
        target_handle.join().unwrap();
        assert!(!healthy);
    }
}

#[cfg(test)]
mod backend_override_tests {
    use super::{read_persisted_backend_override, write_persisted_backend_override};
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn backend_override_survives_restart_and_can_be_cleared() {
        let dir = std::env::temp_dir().join(format!("voicebox-override-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        assert_eq!(read_persisted_backend_override(&dir), None);
        write_persisted_backend_override(&dir, Some("cuda")).unwrap();
        assert_eq!(read_persisted_backend_override(&dir).as_deref(), Some("cuda"));
        write_persisted_backend_override(&dir, Some("  rocm\n")).unwrap();
        assert_eq!(read_persisted_backend_override(&dir).as_deref(), Some("rocm"));
        write_persisted_backend_override(&dir, Some(" \n")).unwrap();
        assert_eq!(read_persisted_backend_override(&dir), None);
        write_persisted_backend_override(&dir, None).unwrap();
        assert_eq!(read_persisted_backend_override(&dir), None);
        let current = std::sync::Mutex::new(None);
        for choice in ["cpu", "cuda", "rocm"] {
            super::save_backend_override(&dir, &current, Some(choice.into())).unwrap();
            assert_eq!(current.lock().unwrap().as_deref(), Some(choice));
            assert_eq!(read_persisted_backend_override(&dir).as_deref(), Some(choice));
        }
        super::save_backend_override(&dir, &current, None).unwrap();
        super::save_backend_override(&dir, &current, None).unwrap();
        assert_eq!(*current.lock().unwrap(), None);
        assert_eq!(read_persisted_backend_override(&dir), None);

        // Concurrent settings updates must leave disk and memory in agreement.
        std::thread::scope(|scope| {
            for choice in ["cpu", "cuda", "rocm"] {
                let dir = &dir;
                let current = &current;
                scope.spawn(move || {
                    for _ in 0..10 {
                        super::save_backend_override(dir, current, Some(choice.into())).unwrap();
                    }
                });
            }
        });
        assert_eq!(*current.lock().unwrap(), read_persisted_backend_override(&dir));
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(all(test, debug_assertions))]
mod manual_server_tests {
    use super::manual_server_available;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    fn serve(status: &str, body: &str) -> (u16, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let response = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(std::time::Duration::from_secs(2))).unwrap();
            let mut request = [0; 1024];
            if stream.read(&mut request).unwrap_or(0) > 0 {
                let _ = stream.write_all(response.as_bytes());
            }
        });
        (port, server)
    }

    #[tokio::test]
    async fn only_a_healthy_voicebox_server_is_a_usable_manual_server() {
        for (status, body, expected) in [
            ("200 OK", r#"{"status":"healthy","model_loaded":false,"gpu_available":true}"#, true),
            ("200 OK", "unrelated service", false),
            ("200 OK", r#"{"status":"healthy"}"#, false),
            ("503 Service Unavailable", r#"{"status":"healthy","model_loaded":true,"gpu_available":true}"#, false),
        ] {
            let (port, server) = serve(status, body);
            assert_eq!(manual_server_available(port).await, expected, "{status}: {body}");
            server.join().unwrap();
        }
    }

    #[tokio::test]
    async fn absent_listener_is_not_a_usable_manual_server() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert!(!manual_server_available(port).await);
    }
}

#[cfg(test)]
mod backend_selection_tests {
    use super::eligible_gpu_backends;
    use std::path::PathBuf;

    #[test]
    fn installed_and_pinned_backends_keep_the_expected_fallbacks() {
        for (pin, rocm, cuda, expected) in [
            (None, true, true, (true, true)),
            (None, true, false, (true, false)),
            (None, false, true, (false, true)),
            (None, false, false, (false, false)),
            (Some("cuda"), true, true, (false, true)),
            (Some("rocm"), true, true, (true, false)),
            (Some("cuda"), true, false, (true, false)),
            (Some("rocm"), false, true, (false, true)),
            (Some("cuda"), false, false, (false, false)),
            (Some("rocm"), false, false, (false, false)),
            (Some("cpu"), true, true, (true, true)),
            (Some("unknown"), true, true, (true, true)),
        ] {
            let actual = eligible_gpu_backends(pin, rocm.then(|| PathBuf::from("rocm")), cuda.then(|| PathBuf::from("cuda")));
            assert_eq!((actual.0.is_some(), actual.1.is_some()), expected, "pin={pin:?}, rocm={rocm}, cuda={cuda}");
            if let Some(path) = actual.0 { assert_eq!(path, PathBuf::from("rocm")); }
            if let Some(path) = actual.1 { assert_eq!(path, PathBuf::from("cuda")); }
        }
    }
}

#[cfg(test)]
mod server_arguments_tests {
    use super::server_arguments;

    #[test]
    fn local_launch_preserves_data_path_as_one_argument_and_uses_loopback_default() {
        assert_eq!(server_arguments("/data/voice box", 17493, 123, false),
            ["--data-dir", "/data/voice box", "--port", "17493", "--parent-pid", "123"]);
    }

    #[test]
    fn remote_launch_adds_public_host_without_changing_other_arguments() {
        assert_eq!(server_arguments("/data/voice box", 17493, 123, true),
            ["--data-dir", "/data/voice box", "--port", "17493", "--parent-pid", "123", "--host", "0.0.0.0"]);
    }
}

#[cfg(test)]
mod microphone_origin_tests {
    use super::trusted_microphone_origin;

    #[test]
    fn permits_the_desktop_origin_and_local_development_servers() {
        for uri in [
            "tauri://localhost/", "tauri://localhost/index.html",
            "https://tauri.localhost/", "https://tauri.localhost/index.html",
            "http://localhost:5173/", "http://127.0.0.1:5173/index.html",
        ] {
            assert!(trusted_microphone_origin(uri), "{uri}");
        }
    }

    #[test]
    fn rejects_prefix_spoofs_and_nonlocal_origins() {
        for uri in [
            "http://localhost.evil.example/", "http://localhost@evil.example/",
            "http://127.0.0.1.evil.example/", "http://127.0.0.1@evil.example/",
            "https://tauri.localhost.evil.example/", "https://tauri.localhost@evil.example/",
            "tauri://evil.example/", "tauri://localhost:444/", "https://tauri.localhost:444/", "http://user@localhost/", "https://evil.example/", "file:///example/index.html",
        ] {
            assert!(!trusted_microphone_origin(uri), "{uri}");
        }
    }

    #[test]
    fn rejects_malformed_and_unsafe_schemes() {
        for uri in ["", "http://localhost:invalid/", "http://localhost:99999/", "https://localhost/", "http://tauri.localhost/", "javascript:alert(1)"] {
            assert!(!trusted_microphone_origin(uri), "{uri}");
        }
    }
}

#[cfg(test)]
mod microphone_origin_build_regression_tests {
    use super::trusted_microphone_origin_for_build;

    #[test]
    fn production_allows_bundled_origins() {
        for uri in ["tauri://localhost/", "https://tauri.localhost/index.html"] {
            assert!(trusted_microphone_origin_for_build(uri, false), "{uri}");
        }
    }

    #[test]
    fn production_does_not_grant_microphone_to_local_http_servers() {
        for uri in ["http://localhost:5173/", "http://127.0.0.1:5173/", "http://localhost:17493/", "http://127.0.0.1/", "http://localhost:1/"] {
            assert!(!trusted_microphone_origin_for_build(uri, false), "{uri}");
        }
    }

    #[test]
    fn development_allows_only_the_configured_local_dev_port() {
        for uri in ["http://localhost:5173/", "http://127.0.0.1:5173/index.html"] {
            assert!(trusted_microphone_origin_for_build(uri, true), "{uri}");
        }
        for uri in ["http://localhost:5174/", "http://127.0.0.1:17493/", "http://localhost/", "http://localhost:80/", "http://127.0.0.1:1/"] {
            assert!(!trusted_microphone_origin_for_build(uri, true), "{uri}");
        }
    }

    #[test]
    fn development_origin_requires_an_exact_loopback_host_and_no_credentials() {
        for uri in ["http://localhost.evil:5173/", "http://evil.localhost:5173/", "http://127.0.0.2:5173/", "http://user@localhost:5173/", "https://localhost:5173/"] {
            assert!(!trusted_microphone_origin_for_build(uri, true), "{uri}");
        }
    }

    #[test]
    fn dev_port_matches_the_desktop_configuration() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let url = config["build"]["devUrl"].as_str().unwrap();
        assert!(trusted_microphone_origin_for_build(url, true));
        assert!(!trusted_microphone_origin_for_build(url, false));
    }
}

#[cfg(test)]
mod media_permission_tests {
    use super::allow_media_request;

    #[test]
    fn trusted_origins_only_allow_microphone_requests() {
        for uri in ["tauri://localhost/", "https://tauri.localhost/", "http://localhost:5173/"] {
            assert!(allow_media_request(uri, true, false, false), "{uri}");
            for (audio, video, display) in [(false, true, false), (true, true, false), (false, false, true), (true, false, true), (true, true, true), (false, false, false)] {
                assert!(!allow_media_request(uri, audio, video, display), "{uri}: {audio} {video} {display}");
            }
        }
    }

    #[test]
    fn a_different_loopback_service_cannot_receive_microphone_permission() {
        for uri in ["http://localhost:5174/", "http://127.0.0.1:17493/"] {
            assert!(!allow_media_request(uri, true, false, false), "{uri}");
        }
    }

    #[test]
    fn untrusted_origins_cannot_receive_any_media_permission() {
        for uri in ["http://localhost.evil.example/", "https://evil.example/", "file:///example/index.html", ""] {
            for audio in [false, true] {
                for video in [false, true] {
                    for display in [false, true] {
                        assert!(!allow_media_request(uri, audio, video, display), "{uri}: {audio} {video} {display}");
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod restart_configuration_tests {
    use super::{resolve_remote_setting, server_arguments, update_models_dir};
    use std::sync::Mutex;

    fn args(remote: bool) -> Vec<String> { server_arguments("/data", 17493, 123, remote) }

    #[test]
    fn remote_binding_survives_restart_without_an_explicit_override() {
        let state = Mutex::new(false);
        assert!(args(resolve_remote_setting(&state, Some(true))).contains(&"0.0.0.0".into()));
        let restarted = args(resolve_remote_setting(&state, None));
        assert!(restarted.contains(&"0.0.0.0".into()));
        assert_eq!(restarted.last().unwrap(), "0.0.0.0");
    }

    #[test]
    fn explicit_local_mode_replaces_the_previous_remote_choice() {
        let state = Mutex::new(false);
        resolve_remote_setting(&state, Some(true));
        assert!(!args(resolve_remote_setting(&state, Some(false))).contains(&"--host".into()));
        assert!(!args(resolve_remote_setting(&state, None)).contains(&"--host".into()));
    }

    #[test]
    fn models_directory_is_retained_replaced_and_reset_across_restarts() {
        let models = Mutex::new(None);
        update_models_dir(&models, Some("/Volumes/Models With Spaces"));
        assert_eq!(models.lock().unwrap().as_deref(), Some("/Volumes/Models With Spaces"));
        update_models_dir(&models, None);
        assert_eq!(models.lock().unwrap().as_deref(), Some("/Volumes/Models With Spaces"));
        update_models_dir(&models, Some("/Volumes/別の場所"));
        assert_eq!(models.lock().unwrap().as_deref(), Some("/Volumes/別の場所"));
        update_models_dir(&models, Some(""));
        assert_eq!(*models.lock().unwrap(), None);
        update_models_dir(&models, None);
        assert_eq!(*models.lock().unwrap(), None);
    }

    #[test]
    fn omitted_setting_defaults_to_local_and_each_instance_is_independent() {
        let first = Mutex::new(false);
        let second = Mutex::new(false);
        assert!(!resolve_remote_setting(&first, None));
        assert!(resolve_remote_setting(&first, Some(true)));
        assert!(!resolve_remote_setting(&second, None));
        assert!(resolve_remote_setting(&first, None));
    }
}

#[cfg(all(test, unix))]
mod override_persistence_regression_tests {
    use super::*;

    #[test]
    fn failed_write_reports_error_without_changing_current_choice() {
        let state = Mutex::new(Some("cpu".into()));
        assert!(save_backend_override(std::path::Path::new("/dev/null"), &state, Some("cuda".into())).is_err());
        assert_eq!(state.lock().unwrap().as_deref(), Some("cpu"));
    }

    #[test]
    fn failed_reset_reports_error_without_changing_current_choice() {
        let state = Mutex::new(Some("cuda".into()));
        assert!(save_backend_override(std::path::Path::new("/dev/null"), &state, None).is_err());
        assert_eq!(state.lock().unwrap().as_deref(), Some("cuda"));
    }
}

#[cfg(test)]
mod gpu_startup_regression_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn forced_cpu_never_probes_an_installed_gpu() {
        let calls = AtomicUsize::new(0);
        let gate = server_startup::StartGate::default();
        let permit = gate.try_begin().unwrap();
        let result = check_gpu_backend("gpu".into(), true, "0.6.0", Some("cpu"), &permit, || async {
            calls.fetch_add(1, Ordering::Relaxed);
            Some("0.6.0".into())
        }).await.unwrap();
        assert_eq!(result, None);
        assert_eq!(calls.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn absent_backend_never_starts_a_probe() {
        let gate = server_startup::StartGate::default();
        let permit = gate.try_begin().unwrap();
        assert_eq!(check_gpu_backend("missing".into(), false, "0.6.0", None, &permit, || async { panic!("probe should not run") }).await.unwrap(), None);
    }

    #[tokio::test]
    async fn version_validation_rejects_missing_mismatched_or_empty_app_version() {
        let gate = server_startup::StartGate::default();
        let permit = gate.try_begin().unwrap();
        for (app, probe) in [("0.6.0", None), ("0.6.0", Some("0.5.0")), ("", Some(""))] {
            assert_eq!(check_gpu_backend("gpu".into(), true, app, None, &permit, || async { probe.map(str::to_owned) }).await.unwrap(), None);
        }
    }

    #[tokio::test]
    async fn compatible_gpu_is_eligible_for_automatic_and_pinned_selection() {
        let gate = server_startup::StartGate::default();
        let permit = gate.try_begin().unwrap();
        for pin in [None, Some("cuda"), Some("rocm")] {
            assert_eq!(check_gpu_backend("gpu".into(), true, "0.6.0", pin, &permit, || async { Some("0.6.0".into()) }).await.unwrap(), Some("gpu".into()));
        }
    }

    #[tokio::test]
    async fn cancellation_interrupts_a_pending_gpu_probe() {
        let gate = server_startup::StartGate::default();
        let permit = gate.try_begin().unwrap();
        let (entered, waiting) = tokio::sync::oneshot::channel();
        let work = check_gpu_backend("gpu".into(), true, "0.6.0", None, &permit, || async {
            entered.send(()).unwrap();
            std::future::pending::<Option<String>>().await
        });
        tokio::pin!(work);
        tokio::select! { _ = &mut work => panic!("probe finished early"), _ = waiting => {} }
        gate.cancel_and(|| ());
        assert_eq!(tokio::time::timeout(std::time::Duration::from_secs(1), work).await.unwrap().unwrap_err(), "Server startup cancelled");
    }
}

#[cfg(test)]
mod launch_fallback_tests {
    use super::*;
    use std::cell::RefCell;
    use std::path::Path;

    fn run(pin: Option<&str>, rocm: bool, cuda: bool, fail: &[&str], cpu_fails: bool) -> (Result<String, &'static str>, Vec<String>) {
        let calls = RefCell::new(Vec::new());
        let (rocm, cuda) = eligible_gpu_backends(pin, rocm.then(|| "rocm".into()), cuda.then(|| "cuda".into()));
        let result = launch_backend(pin, rocm.as_deref(), cuda.as_deref(), |path| {
            let name = path.to_str().unwrap();
            calls.borrow_mut().push(name.to_owned());
            if fail.contains(&name) { Err("gpu failed") } else { Ok(name.to_owned()) }
        }, || {
            calls.borrow_mut().push("cpu".into());
            if cpu_fails { Err("cpu failed") } else { Ok("cpu".into()) }
        });
        (result, calls.into_inner())
    }

    #[test]
    fn available_rocm_is_preferred_without_starting_other_backends() {
        let (result, calls) = run(None, true, true, &[], false);
        assert_eq!(result.unwrap(), "rocm");
        assert_eq!(calls, ["rocm"]);
    }

    #[test]
    fn failed_rocm_falls_back_to_cuda() {
        let (result, calls) = run(None, true, true, &["rocm"], false);
        assert_eq!(result.unwrap(), "cuda");
        assert_eq!(calls, ["rocm", "cuda"]);
    }

    #[test]
    fn failed_gpu_launches_fall_back_to_cpu() {
        let (result, calls) = run(None, true, true, &["rocm", "cuda"], false);
        assert_eq!(result.unwrap(), "cpu");
        assert_eq!(calls, ["rocm", "cuda", "cpu"]);
    }

    #[test]
    fn no_gpu_and_explicit_cpu_start_only_cpu() {
        for (pin, rocm, cuda) in [(None, false, false), (Some("cpu"), true, true)] {
            let (result, calls) = run(pin, rocm, cuda, &[], false);
            assert_eq!(result.unwrap(), "cpu");
            assert_eq!(calls, ["cpu"]);
        }
    }

    #[test]
    fn pinned_gpu_runs_without_trying_the_other_installed_gpu() {
        for (pin, selected) in [("cuda", "cuda"), ("rocm", "rocm")] {
            let (result, calls) = run(Some(pin), true, true, &[selected], false);
            assert_eq!(result.unwrap(), "cpu");
            assert_eq!(calls, [selected, "cpu"]);
        }
    }

    #[test]
    fn missing_pinned_gpu_uses_the_installed_alternative() {
        for (pin, rocm, cuda, selected) in [("cuda", true, false, "rocm"), ("rocm", false, true, "cuda")] {
            let (result, calls) = run(Some(pin), rocm, cuda, &[], false);
            assert_eq!(result.unwrap(), selected);
            assert_eq!(calls, [selected]);
        }
    }

    #[test]
    fn cpu_error_is_propagated_after_gpu_failures() {
        let (result, calls) = run(None, true, true, &["rocm", "cuda"], true);
        assert_eq!(result.unwrap_err(), "cpu failed");
        assert_eq!(calls, ["rocm", "cuda", "cpu"]);
    }

    #[test]
    fn cancelled_start_never_launches_any_backend() {
        let gate = server_startup::StartGate::default();
        let permit = gate.try_begin().unwrap();
        gate.cancel_and(|| ());
        assert!(permit.commit(|| launch_backend(None, Some(Path::new("rocm")), Some(Path::new("cuda")), |_| -> Result<(), &str> { panic!("gpu spawned") }, || { panic!("cpu spawned") })).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn real_spawn_failure_falls_back_to_a_real_cpu_process() {
        let child = launch_backend(None, Some(Path::new("/dev/null/no-binary")), None,
            |path| std::process::Command::new(path).spawn(),
            || std::process::Command::new("/usr/bin/true").spawn()).unwrap();
        assert!(child.wait_with_output().unwrap().status.success());
    }
}

#[cfg(all(test, unix))]
mod server_stop_worker_tests {
    use super::*;

    #[tokio::test]
    async fn stop_worker_terminates_a_task_owned_real_child() {
        struct OwnedChild(std::process::Child);
        impl Drop for OwnedChild {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let mut child = OwnedChild(std::process::Command::new("/bin/sleep").arg("30").spawn().unwrap());
        let gate = Arc::new(server_startup::StartGate::default());
        let (_, stop) = gate.begin_cleanup(|| ());
        assert!(gate.try_begin().is_none());
        tokio::time::timeout(std::time::Duration::from_secs(5), spawn_server_stop(child.0.id(), None, stop))
            .await.unwrap().unwrap();
        assert!(!child.0.wait().unwrap().success());
        assert!(gate.try_begin().is_some());
    }
}

#[cfg(test)]
mod capture_duration_regression_tests {
    use super::start_system_audio_capture_with;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn invalid_capture_durations_are_rejected_before_starting_the_worker() {
        for duration in [0, 31, 300, u32::MAX] {
            let calls = AtomicUsize::new(0);
            let result = start_system_audio_capture_with(duration, |_| {
                calls.fetch_add(1, Ordering::SeqCst);
                async { Ok(()) }
            }).await;
            assert!(result.is_err(), "accepted duration {duration}");
            assert_eq!(calls.load(Ordering::SeqCst), 0);
        }
    }

    #[tokio::test]
    async fn platform_entry_rejects_invalid_duration_before_touching_capture_state() {
        let state = super::audio_capture::AudioCaptureState::new();
        *state.samples.lock().unwrap() = vec![0.25, -0.25];
        for duration in [0, 31, 300, u32::MAX] {
            let error = super::audio_capture::start_capture(&state, duration).await.unwrap_err();
            assert!(error.contains("between 1 and 30"));
            assert_eq!(*state.samples.lock().unwrap(), [0.25, -0.25]);
        }
    }

    #[tokio::test]
    async fn valid_capture_durations_reach_the_worker_and_preserve_errors() {
        for duration in [1, 29, 30] {
            let result = start_system_audio_capture_with(duration, |actual| async move {
                assert_eq!(actual, duration);
                Err("worker failure".into())
            }).await;
            assert_eq!(result.unwrap_err(), "worker failure");
        }
    }
}

#[cfg(all(test, desktop))]
mod command_ipc_regression_tests {
    use super::*;
    use tauri::ipc::InvokeBody;
    use tauri::test::MockRuntime;
    use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
    use tauri::webview::InvokeRequest;

    fn setup() -> (tauri::App<MockRuntime>, tauri::WebviewWindow<MockRuntime>) {
        let app = mock_builder()
            .manage(audio_output::AudioOutputState::new())
            .manage(audio_capture::AudioCaptureState::new())
            .manage(HotkeyState::default())
            .manage(ServerState {
                start_gate: Arc::new(server_startup::StartGate::default()),
                child: Mutex::new(None),
                server_pid: Mutex::new(None),
                keep_running_on_close: Mutex::new(false),
                remote: Mutex::new(false),
                models_dir: Mutex::new(None),
                backend_override: Mutex::new(None),
            })
            .invoke_handler(tauri::generate_handler![
                play_audio_to_devices,
                is_system_audio_supported,
                list_audio_output_devices,
                start_system_audio_capture,
                stop_system_audio_capture,
                start_audio_pcm_stream,
                append_audio_pcm_stream,
                finish_audio_pcm_stream,
                control_audio_playback,
                stop_audio_playback,
                disable_hotkey,
                update_chord_bindings,
                set_keep_server_running,
                stop_server,
                start_server,
                check_accessibility_permission,
                check_input_monitoring_permission,
                debug_capture_focus,
                paste_final_text,
            ])
            .build(mock_context(noop_assets()))
            .unwrap();
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        (app, window)
    }

    fn invoke(
        window: &tauri::WebviewWindow<MockRuntime>,
        command: &str,
        body: InvokeBody,
        session: Option<&str>,
    ) -> Result<serde_json::Value, serde_json::Value> {
        let mut headers = tauri::http::HeaderMap::new();
        if let Some(value) = session {
            headers.insert("x-voicebox-session", value.parse().unwrap());
        }
        get_ipc_response(
            window,
            InvokeRequest {
                cmd: command.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "http://tauri.localhost".parse().unwrap(),
                body,
                headers,
                invoke_key: INVOKE_KEY.into(),
            },
        )
        .map(|body| body.deserialize().unwrap())
    }

    fn play(
        window: &tauri::WebviewWindow<MockRuntime>,
        body: InvokeBody,
        metadata: Option<&str>,
    ) -> Result<serde_json::Value, serde_json::Value> {
        let mut headers = tauri::http::HeaderMap::new();
        if let Some(value) = metadata {
            headers.insert("x-voicebox-playback", value.parse().unwrap());
        }
        get_ipc_response(
            window,
            InvokeRequest {
                cmd: "play_audio_to_devices".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "http://tauri.localhost".parse().unwrap(),
                body,
                headers,
                invoke_key: INVOKE_KEY.into(),
            },
        )
        .map(|body| body.deserialize().unwrap())
    }

    #[test]
    fn audio_capabilities_and_output_devices_are_serialized_over_ipc() {
        let (_app, window) = setup();
        let empty = || InvokeBody::Json(serde_json::json!({}));
        assert!(invoke(&window, "is_system_audio_supported", empty(), None).unwrap().is_boolean());
        match invoke(&window, "list_audio_output_devices", empty(), None) {
            Ok(devices) => for device in devices.as_array().expect("device array") {
                assert!(device["id"].is_string());
                assert!(device["name"].is_string());
                assert!(device["is_default"].is_boolean());
            },
            Err(error) => assert!(error.as_str().is_some_and(|value| value.contains("output"))),
        }
    }

    #[test]
    fn malformed_capture_start_is_rejected_before_recording() {
        let (app, window) = setup();
        for payload in [serde_json::json!({}), serde_json::json!({"maxDurationSecs":-1}), serde_json::json!({"maxDurationSecs":"60"}), serde_json::json!({"maxDurationSecs":4294967296_u64})] {
            assert!(invoke(&window, "start_system_audio_capture", InvokeBody::Json(payload), None).is_err());
        }
        assert!(app.state::<audio_capture::AudioCaptureState>().samples.lock().unwrap().is_empty());
    }

    #[test]
    fn out_of_range_capture_duration_is_rejected_over_ipc_before_recording() {
        let (app, window) = setup();
        let state = app.state::<audio_capture::AudioCaptureState>();
        *state.samples.lock().unwrap() = vec![0.25, -0.25];
        for duration in [0, 31, 300, u32::MAX] {
            let error = invoke(
                &window,
                "start_system_audio_capture",
                InvokeBody::Json(serde_json::json!({"maxDurationSecs": duration})),
                None,
            ).unwrap_err();
            assert!(error.as_str().unwrap().contains("between 1 and 30"));
            assert_eq!(*state.samples.lock().unwrap(), [0.25, -0.25]);
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn capture_stop_returns_decodable_wav_or_reports_failure_over_ipc() {
        use base64::Engine;
        let (app, window) = setup();
        let state = app.state::<audio_capture::AudioCaptureState>();
        let stop = || invoke(&window, "stop_system_audio_capture", InvokeBody::Json(serde_json::json!({})), None);
        assert!(stop().unwrap_err().as_str().unwrap().contains("No audio samples"));
        *state.samples.lock().unwrap() = vec![0.5, -0.5, 1.0, -1.0];
        *state.sample_rate.lock().unwrap() = 48000;
        *state.channels.lock().unwrap() = 2;
        let encoded = stop().unwrap();
        let bytes = base64::engine::general_purpose::STANDARD.decode(encoded.as_str().unwrap()).unwrap();
        let mut wav = hound::WavReader::new(std::io::Cursor::new(bytes)).unwrap();
        assert_eq!((wav.spec().sample_rate, wav.spec().channels), (48000, 2));
        assert_eq!(wav.samples::<i16>().map(Result::unwrap).collect::<Vec<_>>(), [16383, -16383, 32767, -32767]);
        *state.error.lock().unwrap() = Some("capture interrupted".into());
        assert!(stop().unwrap_err().as_str().unwrap().contains("capture interrupted"));
    }

    #[test]
    fn focus_capture_reports_a_snapshot_or_a_meaningful_native_error_over_ipc() {
        let (_app, window) = setup();
        let result = invoke(&window, "debug_capture_focus", InvokeBody::Json(serde_json::json!({})), None);
        match result {
            Ok(snapshot) => {
                assert!(snapshot["pid"].as_i64().is_some_and(|pid| pid > 0));
                assert!(snapshot["bundle_id"].is_null() || snapshot["bundle_id"].is_string());
                assert!(snapshot["role"].is_null() || snapshot["role"].is_string());
            }
            Err(error) => assert!(error.as_str().is_some_and(|message| !message.is_empty())),
        }
    }

    #[test]
    fn dictation_permission_checks_return_boolean_over_ipc() {
        let (_app, window) = setup();
        for command in ["check_accessibility_permission", "check_input_monitoring_permission"] {
            let result = invoke(&window, command, InvokeBody::Json(serde_json::json!({})), None).unwrap();
            assert!(result.is_boolean(), "{command} must return the current permission state");
        }
    }

    #[test]
    fn self_focused_paste_is_skipped_over_ipc_without_native_side_effects() {
        let (_app, window) = setup();
        for (text, role) in [("hello", Some("AXTextField")), ("", None), ("世界\n🎙", Some("AXTextArea"))] {
            let body = InvokeBody::Json(serde_json::json!({"text":text, "focus":{"pid":-1, "bundle_id":VOICEBOX_BUNDLE_ID, "role":role}}));
            assert_eq!(invoke(&window, "paste_final_text", body, None).unwrap(), serde_json::json!(false));
        }
    }

    #[test]
    fn malformed_paste_ipc_requests_are_rejected_before_native_operations() {
        let (_app, window) = setup();
        for body in [
            serde_json::json!({}),
            serde_json::json!({"text":"a", "focus":null}),
            serde_json::json!({"text":"a", "focus":{"pid":"invalid", "bundle_id":VOICEBOX_BUNDLE_ID}}),
            serde_json::json!({"text":"a", "focus":{"pid":2147483648_i64, "bundle_id":VOICEBOX_BUNDLE_ID}}),
            serde_json::json!({"text":false, "focus":{"pid":-1, "bundle_id":VOICEBOX_BUNDLE_ID}}),
        ] {
            assert!(invoke(&window, "paste_final_text", InvokeBody::Json(body), None).is_err());
        }
        assert!(invoke(&window, "paste_final_text", InvokeBody::Raw(vec![]), None).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn self_paste_identifier_matches_the_bundled_application_identifier() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], VOICEBOX_BUNDLE_ID);
    }

    #[test]
    fn audio_ipc_rejects_malformed_binary_requests_and_invalid_preview_rate() {
        let (_app, window) = setup();
        assert_eq!(
            play(&window, InvokeBody::Raw(vec![]), None).unwrap_err(),
            "Missing or oversized playback metadata"
        );
        assert_eq!(
            play(&window, InvokeBody::Raw(vec![]), Some("not-json")).unwrap_err(),
            "Invalid playback metadata"
        );
        assert_eq!(
            play(
                &window,
                InvokeBody::Json(serde_json::json!({})),
                Some(r#"{"deviceIds":[]}"#)
            )
            .unwrap_err(),
            "Playback audio must use a binary request body"
        );
        assert_eq!(
            play(
                &window,
                InvokeBody::Raw(vec![]),
                Some(r#"{"deviceIds":[]}"#)
            )
            .unwrap_err(),
            "No output devices selected"
        );
        assert_eq!(
            invoke(
                &window,
                "start_audio_pcm_stream",
                InvokeBody::Json(serde_json::json!({"sampleRate":0,"deviceIds":[]})),
                None
            )
            .unwrap_err(),
            "Invalid preview sample rate"
        );
    }

    #[test]
    #[ignore = "requires a working native output device; emits silence"]
    fn native_silent_ipc_preview_and_binary_clip() {
        use tauri::Listener;
        let (app, window) = setup();
        let (tx, rx) = std::sync::mpsc::channel();
        app.listen("native-audio-playback", move |event| {
            let _ = tx.send(event.payload().to_owned());
        });
        let preview = invoke(
            &window,
            "start_audio_pcm_stream",
            InvokeBody::Json(serde_json::json!({"sampleRate":8000,"deviceIds":[]})),
            None,
        )
        .unwrap();
        let id = preview["session_id"].as_str().unwrap();
        assert!(invoke(
            &window,
            "append_audio_pcm_stream",
            InvokeBody::Raw(vec![0; 1600]),
            Some(id)
        )
        .is_ok());
        assert!(invoke(
            &window,
            "control_audio_playback",
            InvokeBody::Json(serde_json::json!({"sessionId":id,"control":{"paused":false}})),
            None
        )
        .is_ok());
        assert!(invoke(
            &window,
            "finish_audio_pcm_stream",
            InvokeBody::Json(serde_json::json!({"sessionId":id})),
            None
        )
        .is_ok());
        loop {
            let event: serde_json::Value =
                serde_json::from_str(&rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap())
                    .unwrap();
            if event["session_id"] == id && event["state"] == "ended" {
                break;
            }
        }
        let devices = app
            .state::<audio_output::AudioOutputState>()
            .list_output_devices()
            .unwrap();
        let device = devices
            .iter()
            .find(|device| device.is_default)
            .expect("default output device");
        let mut bytes = std::io::Cursor::new(Vec::new());
        {
            let mut writer = hound::WavWriter::new(
                &mut bytes,
                hound::WavSpec {
                    channels: 1,
                    sample_rate: 8000,
                    bits_per_sample: 16,
                    sample_format: hound::SampleFormat::Int,
                },
            )
            .unwrap();
            for _ in 0..8000 {
                writer.write_sample(0_i16).unwrap();
            }
            writer.finalize().unwrap();
        }
        let metadata =
            serde_json::json!({"deviceIds":[device.id],"options":{"volume":0.5}}).to_string();
        let clip = play(
            &window,
            InvokeBody::Raw(bytes.into_inner()),
            Some(&metadata),
        )
        .unwrap();
        let id = clip["session_id"].as_str().unwrap();
        assert!(invoke(
            &window,
            "stop_audio_playback",
            InvokeBody::Json(serde_json::json!({"sessionId":id})),
            None
        )
        .is_ok());
        loop {
            let event: serde_json::Value =
                serde_json::from_str(&rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap())
                    .unwrap();
            if event["session_id"] == id && event["state"] == "stopped" {
                break;
            }
        }
    }

    #[test]
    fn startup_ipc_refuses_overlapping_attempt_without_changing_settings() {
        let (app, window) = setup();
        let state = app.state::<ServerState>();
        let permit = state.start_gate.try_begin().unwrap();
        let body = InvokeBody::Json(serde_json::json!({"remote":true, "modelsDir":"unexpected"}));
        let error = invoke(&window, "start_server", body, None).unwrap_err();
        assert!(error.as_str().unwrap().contains("starting or stopping"));
        assert!(!*state.remote.lock().unwrap());
        assert!(state.models_dir.lock().unwrap().is_none());
        assert!(state.server_pid.lock().unwrap().is_none());
        drop(permit);
    }

    #[test]
    fn stop_server_ipc_cancels_pending_start_and_is_idempotent() {
        let (app, window) = setup();
        let state = app.state::<ServerState>();
        let pending = state.start_gate.try_begin().unwrap();
        for _ in 0..2 {
            assert!(invoke(
                &window,
                "stop_server",
                InvokeBody::Json(serde_json::json!({})),
                None
            )
            .is_ok());
        }
        assert!(pending.commit(|| ()).is_none());
        drop(pending);
        assert!(state.start_gate.try_begin().is_some());
        assert!(state.server_pid.lock().unwrap().is_none());
    }

    #[test]
    fn preview_ipc_validates_header_body_and_ended_session() {
        let (_app, window) = setup();
        let raw = || InvokeBody::Raw(vec![0, 0]);
        assert_eq!(
            invoke(&window, "append_audio_pcm_stream", raw(), None).unwrap_err(),
            "Missing preview session"
        );
        assert_eq!(
            invoke(
                &window,
                "append_audio_pcm_stream",
                raw(),
                Some(&"x".repeat(129))
            )
            .unwrap_err(),
            "Missing preview session"
        );
        assert_eq!(
            invoke(
                &window,
                "append_audio_pcm_stream",
                InvokeBody::Json(serde_json::json!({})),
                Some("old")
            )
            .unwrap_err(),
            "Preview requires binary PCM"
        );
        assert_eq!(
            invoke(&window, "append_audio_pcm_stream", raw(), Some("old")).unwrap_err(),
            "Preview session has ended"
        );
        assert_eq!(
            invoke(
                &window,
                "finish_audio_pcm_stream",
                InvokeBody::Json(serde_json::json!({"sessionId":"old"})),
                None
            )
            .unwrap_err(),
            "Preview session has ended"
        );
    }

    #[test]
    fn playback_ipc_rejects_bad_controls_and_allows_idempotent_stop() {
        let (_app, window) = setup();
        for control in [
            serde_json::json!({"volume": 2.0}),
            serde_json::json!({"position": -1.0}),
        ] {
            let body = InvokeBody::Json(serde_json::json!({"sessionId":"old", "control":control}));
            assert_eq!(
                invoke(&window, "control_audio_playback", body, None).unwrap_err(),
                "Invalid playback position or volume"
            );
        }
        let body =
            InvokeBody::Json(serde_json::json!({"sessionId":"old", "control":{"paused":true}}));
        assert_eq!(
            invoke(&window, "control_audio_playback", body, None).unwrap_err(),
            "Playback session has ended"
        );
        assert!(invoke(
            &window,
            "stop_audio_playback",
            InvokeBody::Json(serde_json::json!({"sessionId":"old"})),
            None
        )
        .is_ok());
        assert!(invoke(
            &window,
            "stop_audio_playback",
            InvokeBody::Json(serde_json::json!({})),
            None
        )
        .is_ok());
    }

    #[test]
    fn settings_ipc_validates_hotkeys_and_updates_server_preference() {
        let (app, window) = setup();
        let body = InvokeBody::Json(serde_json::json!({"pushToTalk":[], "toggleToTalk":["KeyA"]}));
        assert!(invoke(&window, "update_chord_bindings", body, None)
            .unwrap_err()
            .as_str()
            .unwrap()
            .contains("at least one key"));
        let body =
            InvokeBody::Json(serde_json::json!({"pushToTalk":["KeyA"], "toggleToTalk":["KeyA"]}));
        assert!(invoke(&window, "update_chord_bindings", body, None)
            .unwrap_err()
            .as_str()
            .unwrap()
            .contains("must be different"));
        let body =
            InvokeBody::Json(serde_json::json!({"pushToTalk":["KeyA"], "toggleToTalk":["KeyB"]}));
        assert!(invoke(&window, "update_chord_bindings", body, None).is_ok());
        assert!(invoke(
            &window,
            "disable_hotkey",
            InvokeBody::Json(serde_json::json!({})),
            None
        )
        .is_ok());
        for keep in [true, false] {
            let body = InvokeBody::Json(serde_json::json!({"keepRunning":keep}));
            assert!(invoke(&window, "set_keep_server_running", body, None).is_ok());
            assert_eq!(
                *app.state::<ServerState>()
                    .keep_running_on_close
                    .lock()
                    .unwrap(),
                keep
            );
        }
    }
}

#[cfg(all(test, desktop))]
mod dictate_overlay_integration_tests {
    use super::*;

    #[test]
    fn hide_before_first_show_does_not_create_an_overlay() {
        let app = tauri::test::mock_app();
        install_dictate_window_handlers(app.handle());
        app.emit("dictate:hide", ()).unwrap();
        assert!(app.get_webview_window(DICTATE_WINDOW_LABEL).is_none());
        assert!(app.webview_windows().is_empty());
    }

    #[test]
    fn show_creates_one_overlay_and_repeated_events_reuse_it() {
        let app = tauri::test::mock_app();
        install_dictate_window_handlers(app.handle());
        for event in ["dictate:show", "dictate:hide", "dictate:show", "dictate:show"] {
            app.emit(event, ()).unwrap();
            assert!(app.get_webview_window(DICTATE_WINDOW_LABEL).is_some());
            assert_eq!(app.webview_windows().len(), 1);
        }
    }

    #[test]
    fn ensure_and_show_reuse_the_existing_overlay_without_touching_main_window() {
        let app = tauri::test::mock_app();
        let _main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
        install_dictate_window_handlers(app.handle());
        ensure_dictate_window(app.handle());
        ensure_dictate_window(app.handle());
        app.emit("dictate:hide", ()).unwrap();
        app.emit("dictate:show", ()).unwrap();
        assert!(app.get_webview_window("main").is_some());
        assert!(app.get_webview_window(DICTATE_WINDOW_LABEL).is_some());
        assert_eq!(app.webview_windows().len(), 2);
    }

    #[test]
    fn unrelated_event_does_not_create_the_overlay() {
        let app = tauri::test::mock_app();
        install_dictate_window_handlers(app.handle());
        app.emit("dictate:unrelated", ()).unwrap();
        assert!(app.get_webview_window(DICTATE_WINDOW_LABEL).is_none());
    }
}

#[cfg(test)]
mod exit_ownership_regression_tests {
    use super::*;
    use std::cell::Cell;

    fn state(keep: bool, pid: Option<u32>) -> ServerState {
        ServerState {
            start_gate: Arc::new(server_startup::StartGate::default()),
            child: Mutex::new(None),
            server_pid: Mutex::new(pid),
            keep_running_on_close: Mutex::new(keep),
            remote: Mutex::new(false),
            models_dir: Mutex::new(None),
            backend_override: Mutex::new(None),
        }
    }

    #[test]
    fn keep_running_without_a_recorded_server_has_no_external_side_effects() {
        let state = state(true, None);
        let keep_called = Cell::new(false);
        handle_server_exit_with(&state, || keep_called.set(true), |_| panic!("no server should be stopped"));
        assert!(!keep_called.get(), "must not disable an unrelated server's watchdog");
    }

    #[test]
    fn keep_running_for_a_recorded_server_preserves_its_pid() {
        let state = state(true, Some(42));
        let keep_called = Cell::new(false);
        handle_server_exit_with(&state, || keep_called.set(true), |_| panic!("server should not be stopped"));
        assert!(keep_called.get());
        assert_eq!(*state.server_pid.lock().unwrap(), Some(42));
    }

    #[test]
    fn unrecorded_server_neither_receives_a_request_nor_a_sentinel() {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let dir = std::env::temp_dir().join(format!("voicebox-exit-unowned-{}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        let state = state(true, None);
        handle_server_exit_with(&state, || keep_server_running_on_exit(Some(&dir), port), |_| panic!("unexpected stop"));
        assert!(!dir.join(format!(".keep-running-{}", std::process::id())).exists());
        assert_eq!(listener.accept().unwrap_err().kind(), std::io::ErrorKind::WouldBlock);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn recorded_server_gets_sentinel_and_loopback_watchdog_request() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.set_read_timeout(Some(std::time::Duration::from_secs(2))).unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                let count = socket.read(&mut buffer).unwrap();
                assert!(count > 0 && request.len() < 16384);
                request.extend_from_slice(&buffer[..count]);
            }
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
            request
        });
        let dir = std::env::temp_dir().join(format!("voicebox-exit-owned-{}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        let state = state(true, Some(42));
        handle_server_exit_with(&state, || keep_server_running_on_exit(Some(&dir), port), |_| panic!("unexpected stop"));
        let request = server.join().unwrap();
        assert!(request.starts_with(b"POST /watchdog/disable "));
        assert_eq!(std::fs::read(dir.join(format!(".keep-running-{}", std::process::id()))).unwrap(), b"1");
        assert_eq!(*state.server_pid.lock().unwrap(), Some(42));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn normal_exit_stops_only_the_recorded_process_once() {
        let state = state(false, Some(42));
        let stopped = Cell::new(None);
        handle_server_exit_with(&state, || panic!("watchdog must remain enabled"), |pid| stopped.set(Some(pid)));
        assert_eq!(stopped.get(), Some(42));
        assert_eq!(*state.server_pid.lock().unwrap(), None);
        handle_server_exit_with(&state, || panic!("watchdog must remain enabled"), |_| panic!("process already detached"));
    }
}

#[cfg(test)]
mod window_lifecycle_integration_tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

    #[test]
    fn closing_dictate_window_does_not_request_main_server_cleanup() {
        let app = tauri::test::mock_app();
        let _webview =
            tauri::WebviewWindowBuilder::new(&app, DICTATE_WINDOW_LABEL, Default::default())
                .build()
                .unwrap();
        let window = app.get_window(DICTATE_WINDOW_LABEL).unwrap();
        let requests = Arc::new(AtomicUsize::new(0));
        let observed = requests.clone();
        app.listen("window-close-requested", move |_| {
            observed.fetch_add(1, Ordering::SeqCst);
        });
        let (tx, rx) = std::sync::mpsc::channel();
        let event: WindowEvent =
            tauri_runtime::window::WindowEvent::CloseRequested { signal_tx: tx }.into();
        handle_window_event(&window, &event, Arc::new(AtomicU64::new(CLOSE_IDLE)));
        assert_eq!(
            requests.load(Ordering::SeqCst),
            0,
            "closing the dictation window requested main-window cleanup"
        );
        assert!(
            rx.try_recv().is_err(),
            "dictation window close was prevented"
        );
    }

    #[test]
    fn main_window_close_requests_cleanup_and_prevents_immediate_close() {
        let app = tauri::test::mock_app();
        let _webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let window = app.get_window("main").unwrap();
        let requests = Arc::new(AtomicUsize::new(0));
        let observed = requests.clone();
        let handle = app.handle().clone();
        app.listen("window-close-requested", move |event| {
            observed.fetch_add(1, Ordering::SeqCst);
            let ticket: String = serde_json::from_str(event.payload()).unwrap();
            handle.emit("window-close-allowed", ticket).unwrap();
        });
        let (tx, rx) = std::sync::mpsc::channel();
        let event: WindowEvent =
            tauri_runtime::window::WindowEvent::CloseRequested { signal_tx: tx }.into();
        handle_window_event(&window, &event, Arc::new(AtomicU64::new(CLOSE_IDLE)));
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        assert_eq!(rx.try_recv().unwrap(), true);
    }

    #[test]
    fn unrelated_main_window_events_do_not_request_cleanup() {
        let app = tauri::test::mock_app();
        let _webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let window = app.get_window("main").unwrap();
        let requests = Arc::new(AtomicUsize::new(0));
        let observed = requests.clone();
        app.listen("window-close-requested", move |_| {
            observed.fetch_add(1, Ordering::SeqCst);
        });
        handle_window_event(
            &window,
            &WindowEvent::Focused(false),
            Arc::new(AtomicU64::new(CLOSE_IDLE)),
        );
        assert_eq!(requests.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn repeated_close_is_blocked_while_frontend_cleanup_is_pending() {
        let app = tauri::test::mock_app();
        let _webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let window = app.get_window("main").unwrap();
        let requests = Arc::new(AtomicUsize::new(0));
        let observed = requests.clone();
        app.listen("window-close-requested", move |_| {
            observed.fetch_add(1, Ordering::SeqCst);
        });
        let closing = Arc::new(AtomicU64::new(CLOSE_IDLE));
        for _ in 0..2 {
            let (tx, rx) = std::sync::mpsc::channel();
            let event: WindowEvent =
                tauri_runtime::window::WindowEvent::CloseRequested { signal_tx: tx }.into();
            handle_window_event(&window, &event, closing.clone());
            assert_eq!(
                rx.try_recv(),
                Ok(true),
                "close must be prevented until cleanup completes"
            );
        }
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        app.emit("window-close-allowed", closing.load(Ordering::SeqCst).to_string()).unwrap();
    }

    #[tokio::test]
    async fn stale_acknowledgement_does_not_authorize_a_new_close() {
        let app = tauri::test::mock_app();
        let _webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
        let window = app.get_window("main").unwrap();
        let closing = Arc::new(AtomicU64::new(CLOSE_IDLE));
        let (tx, rx) = std::sync::mpsc::channel();
        let first: WindowEvent = tauri_runtime::window::WindowEvent::CloseRequested { signal_tx: tx }.into();
        handle_window_event_with_timeout(&window, &first, closing.clone(), std::time::Duration::from_secs(2));
        assert_eq!(rx.try_recv(), Ok(true));
        let old_ticket = closing.load(Ordering::SeqCst).to_string();
        handle_window_event(&window, &WindowEvent::Destroyed, closing.clone());
        let (tx, rx) = std::sync::mpsc::channel();
        let second: WindowEvent = tauri_runtime::window::WindowEvent::CloseRequested { signal_tx: tx }.into();
        handle_window_event_with_timeout(&window, &second, closing.clone(), std::time::Duration::from_secs(2));
        assert_eq!(rx.try_recv(), Ok(true));
        let current_ticket = closing.load(Ordering::SeqCst).to_string();
        assert_ne!(old_ticket, current_ticket);
        app.emit("window-close-allowed", ()).unwrap();
        app.emit("window-close-allowed", 5_u64).unwrap();
        app.emit("window-close-allowed", "wrong").unwrap();
        app.emit("window-close-allowed", old_ticket).unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert_eq!(closing.load(Ordering::SeqCst) & CLOSE_PHASE_MASK, CLOSE_CLEANUP, "stale acknowledgment bypassed the new cleanup");
        app.emit("window-close-allowed", current_ticket).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while closing.load(Ordering::SeqCst) & CLOSE_PHASE_MASK != CLOSE_READY { tokio::time::sleep(std::time::Duration::from_millis(5)).await; }
        }).await.expect("current acknowledgement did not allow close");
    }

    #[tokio::test]
    async fn destroyed_window_timeout_does_not_authorize_later_close() {
        let app = tauri::test::mock_app();
        let _webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
        let window = app.get_window("main").unwrap();
        let closing = Arc::new(AtomicU64::new(CLOSE_IDLE));
        let (tx, rx) = std::sync::mpsc::channel();
        let first: WindowEvent = tauri_runtime::window::WindowEvent::CloseRequested { signal_tx: tx }.into();
        handle_window_event_with_timeout(&window, &first, closing.clone(), std::time::Duration::from_millis(30));
        assert_eq!(rx.try_recv(), Ok(true));
        handle_window_event(&window, &WindowEvent::Destroyed, closing.clone());
        let (tx, rx) = std::sync::mpsc::channel();
        let second: WindowEvent = tauri_runtime::window::WindowEvent::CloseRequested { signal_tx: tx }.into();
        handle_window_event_with_timeout(&window, &second, closing.clone(), std::time::Duration::from_secs(2));
        assert_eq!(rx.try_recv(), Ok(true));
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert_eq!((closing.load(Ordering::SeqCst) & CLOSE_PHASE_MASK), CLOSE_CLEANUP, "old timeout bypassed the new cleanup");
        app.emit("window-close-allowed", closing.load(Ordering::SeqCst).to_string()).unwrap();
    }

    #[tokio::test]
    async fn destroyed_window_timeout_does_not_reauthorize_a_closed_window() {
        let app = tauri::test::mock_app();
        let _webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
        let window = app.get_window("main").unwrap();
        let closing = Arc::new(AtomicU64::new(CLOSE_IDLE));
        let (tx, rx) = std::sync::mpsc::channel();
        let first: WindowEvent = tauri_runtime::window::WindowEvent::CloseRequested { signal_tx: tx }.into();
        handle_window_event_with_timeout(&window, &first, closing.clone(), std::time::Duration::from_millis(30));
        assert_eq!(rx.try_recv(), Ok(true));
        handle_window_event(&window, &WindowEvent::Destroyed, closing.clone());
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert_eq!((closing.load(Ordering::SeqCst) & CLOSE_PHASE_MASK), CLOSE_IDLE, "destroyed window was reauthorized by its old timeout");
    }

    #[tokio::test]
    async fn destroyed_window_ignores_a_late_cleanup_acknowledgement() {
        let app = tauri::test::mock_app();
        let _webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
        let window = app.get_window("main").unwrap();
        let closing = Arc::new(AtomicU64::new(CLOSE_IDLE));
        let (tx, rx) = std::sync::mpsc::channel();
        let first: WindowEvent = tauri_runtime::window::WindowEvent::CloseRequested { signal_tx: tx }.into();
        handle_window_event_with_timeout(&window, &first, closing.clone(), std::time::Duration::from_secs(2));
        assert_eq!(rx.try_recv(), Ok(true));
        let old_ticket = closing.load(Ordering::SeqCst).to_string();
        handle_window_event(&window, &WindowEvent::Destroyed, closing.clone());
        app.emit("window-close-allowed", old_ticket).unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert_eq!(closing.load(Ordering::SeqCst) & CLOSE_PHASE_MASK, CLOSE_IDLE);
    }

    #[tokio::test]
    async fn current_cleanup_timeout_allows_final_close() {
        let app = tauri::test::mock_app();
        let _webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
        let window = app.get_window("main").unwrap();
        let closing = Arc::new(AtomicU64::new(CLOSE_IDLE));
        let (tx, rx) = std::sync::mpsc::channel();
        let first: WindowEvent = tauri_runtime::window::WindowEvent::CloseRequested { signal_tx: tx }.into();
        handle_window_event_with_timeout(&window, &first, closing.clone(), std::time::Duration::from_millis(30));
        assert_eq!(rx.try_recv(), Ok(true));
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while closing.load(Ordering::SeqCst) & CLOSE_PHASE_MASK != CLOSE_READY {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        }).await.expect("current cleanup timeout did not allow close");
        let (tx, rx) = std::sync::mpsc::channel();
        let final_close: WindowEvent = tauri_runtime::window::WindowEvent::CloseRequested { signal_tx: tx }.into();
        handle_window_event(&window, &final_close, closing);
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn acknowledgement_allows_the_final_close_and_destroy_resets_the_gate() {
        let app = tauri::test::mock_app();
        let _webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let window = app.get_window("main").unwrap();
        let requests = Arc::new(AtomicUsize::new(0));
        let observed = requests.clone();
        app.listen("window-close-requested", move |_| {
            observed.fetch_add(1, Ordering::SeqCst);
        });
        let closing = Arc::new(AtomicU64::new(CLOSE_IDLE));
        let (tx, rx) = std::sync::mpsc::channel();
        let first: WindowEvent =
            tauri_runtime::window::WindowEvent::CloseRequested { signal_tx: tx }.into();
        handle_window_event(&window, &first, closing.clone());
        assert_eq!(rx.try_recv(), Ok(true));
        app.emit("window-close-allowed", closing.load(Ordering::SeqCst).to_string()).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while (closing.load(Ordering::SeqCst) & CLOSE_PHASE_MASK) != CLOSE_READY {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("cleanup acknowledgement did not authorize close");
        let (tx, rx) = std::sync::mpsc::channel();
        let final_close: WindowEvent =
            tauri_runtime::window::WindowEvent::CloseRequested { signal_tx: tx }.into();
        handle_window_event(&window, &final_close, closing.clone());
        assert!(
            rx.try_recv().is_err(),
            "final close should not be prevented"
        );
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        handle_window_event(&window, &WindowEvent::Destroyed, closing.clone());
        assert_eq!((closing.load(Ordering::SeqCst) & CLOSE_PHASE_MASK), CLOSE_IDLE);
    }
}

#[cfg(all(test, unix))]
mod server_start_flow_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct Fixture {
        dir: std::path::PathBuf,
        port: u16,
        exe: std::path::PathBuf,
    }
    impl Fixture {
        fn new(script: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "voicebox-start-flow-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&dir).unwrap();
            let exe = dir.join("fake-sidecar");
            std::fs::write(&exe, format!("#!/bin/sh\n{script}\n")).unwrap();
            std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o700)).unwrap();
            // Stand-in sidecars never bind a socket; port zero avoids racing
            // other processes for a released ephemeral port. Listener tests
            // supply the actual port held by their own bound socket.
            let port = 0;
            Self { dir, port, exe }
        }
        fn config(&self) -> ServerStartupConfig {
            ServerStartupConfig {
                port: self.port,
                discover_listener: false,
                listener_executable: None,
                listener_timeout: Duration::from_secs(10),
                port_release_delay: Duration::from_millis(200),
                legacy_port: None,
                data_dir: Some(self.dir.join("data")),
                cpu_executable: Some(self.exe.clone()),
                startup_timeout: Duration::from_secs(120),
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
    fn app() -> tauri::App<tauri::test::MockRuntime> {
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().version = Some("0.6.0".into());
        tauri::test::mock_builder()
            .plugin(tauri_plugin_shell::init())
            .manage(ServerState {
                start_gate: Arc::new(server_startup::StartGate::default()),
                child: Mutex::new(None),
                server_pid: Mutex::new(None),
                keep_running_on_close: Mutex::new(false),
                remote: Mutex::new(false),
                models_dir: Mutex::new(None),
                backend_override: Mutex::new(None),
            })
            .build(context)
            .unwrap()
    }

    #[tokio::test]
    async fn headerless_listener_output_never_launches_a_second_sidecar() {
        let fixture = Fixture::new("touch \"$2/sidecar-started\"\nprintf 'INFO: Uvicorn running on http://127.0.0.1:%s\\n' \"$4\" >&2\nexec /bin/sleep 5");
        let probe = fixture.dir.join("lsof-truncated");
        std::fs::write(&probe, "#!/bin/sh\nprintf 'python 123 user 9u IPv4 1 TCP localhost:17493 (LISTEN)\\n'\n").unwrap();
        std::fs::set_permissions(&probe, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut config = fixture.config();
        config.discover_listener = true;
        config.listener_executable = Some(probe);
        let app = app();
        let result = tokio::time::timeout(Duration::from_secs(5), start_server_with(app.handle().clone(), app.state(), None, None, config)).await.unwrap();
        stop_server_if_owned(app.state(), None).await.unwrap();
        assert!(result.is_err(), "truncated discovery unexpectedly allowed startup: {result:?}");
        assert!(!fixture.dir.join("data/sidecar-started").exists());
    }

    #[test]
    fn production_defaults_keep_fixed_ports_and_packaged_paths() {
        let config = ServerStartupConfig::default();
        assert_eq!(config.port, SERVER_PORT);
        assert!(config.discover_listener);
        assert!(config.listener_executable.is_none());
        assert_eq!(config.listener_timeout, Duration::from_secs(10));
        assert_eq!(config.port_release_delay, Duration::from_millis(200));
        assert_eq!(config.legacy_port, Some(LEGACY_PORT));
        assert!(config.data_dir.is_none());
        assert!(config.cpu_executable.is_none());
        assert_eq!(config.startup_timeout, Duration::from_secs(120));
    }

    #[tokio::test]
    async fn isolated_sidecar_starts_reports_logs_and_stops() {
        let fixture = Fixture::new(
            "printf '%s\\n' \"$VOICEBOX_MODELS_DIR\" \"$@\" > \"$2/invocation\"\nprintf 'INFO: Uvicorn running on http://127.0.0.1:%s\\n' \"$4\" >&2\nexec /bin/sleep 5",
        );
        let data_dir = fixture.dir.join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        let stale = data_dir.join(format!(".keep-running-{}", std::process::id()));
        std::fs::write(&stale, b"1").unwrap();
        let app = app();
        let logs = Arc::new(Mutex::new(Vec::<String>::new()));
        let observed = logs.clone();
        app.listen("server-log", move |event| {
            observed.lock().unwrap().push(event.payload().into())
        });
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            start_server_with(
                app.handle().clone(),
                app.state(),
                Some(false),
                Some("custom models".into()),
                fixture.config(),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(result, format!("http://127.0.0.1:{}", fixture.port));
        assert!(!stale.exists(), "stale signal must be removed before launching a child");
        let invocation = std::fs::read_to_string(fixture.dir.join("data/invocation")).unwrap();
        let args: Vec<&str> = invocation.lines().collect();
        assert_eq!(args[0], "custom models");
        assert_eq!(args[1], "--data-dir");
        assert_eq!(args[2], fixture.dir.join("data").to_str().unwrap());
        assert_eq!(args[3], "--port");
        assert_eq!(args[4], fixture.port.to_string());
        assert_eq!(args[5], "--parent-pid");
        assert!(app
            .state::<ServerState>()
            .server_pid
            .lock()
            .unwrap()
            .is_some());
        assert!(logs
            .lock()
            .unwrap()
            .iter()
            .any(|entry| entry.contains("Uvicorn running")));
        stop_server_if_owned(app.state(), None).await.unwrap();
        assert!(app
            .state::<ServerState>()
            .server_pid
            .lock()
            .unwrap()
            .is_none());
        assert!(app.state::<ServerState>().child.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn startup_fails_before_spawn_if_stale_keep_running_signal_cannot_be_cleared() {
        let fixture = Fixture::new("exit 42");
        let data_dir = fixture.dir.join("data");
        std::fs::create_dir_all(data_dir.join(format!(".keep-running-{}", std::process::id()))).unwrap();
        let app = app();
        let error = start_server_with(app.handle().clone(), app.state(), None, None, fixture.config()).await.unwrap_err();
        assert!(error.contains("Failed to clear old keep-running signal"));
        assert!(app.state::<ServerState>().server_pid.lock().unwrap().is_none());
        assert!(app.state::<ServerState>().child.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn direct_start_applies_retained_custom_and_reset_model_directories() {
        for (requested, expected) in [
            (None, "previous models"),
            (Some("models/音声 with spaces"), "models/音声 with spaces"),
            (Some(""), "unset"),
        ] {
            let fixture = Fixture::new("printf '%s\\n' \"${VOICEBOX_MODELS_DIR-unset}\" > \"$2/models\"\nprintf 'INFO: Uvicorn running on http://127.0.0.1:%s\\n' \"$4\" >&2\nexec /bin/sleep 5");
            let app = app();
            *app.state::<ServerState>().models_dir.lock().unwrap() = Some("previous models".into());
            let result = start_server_with(
                app.handle().clone(), app.state(), Some(false),
                requested.map(str::to_string), fixture.config(),
            ).await;
            let observed = std::fs::read_to_string(fixture.dir.join("data/models"));
            stop_server_if_owned(app.state(), None).await.unwrap();
            assert!(result.is_ok(), "startup failed: {result:?}");
            assert_eq!(observed.unwrap().trim_end(), expected, "requested {requested:?}");
        }
    }

    #[tokio::test]
    async fn invalid_data_directory_does_not_spawn_a_server_and_can_be_retried() {
        let fixture = Fixture::new("touch \"$2/started\"\nprintf 'INFO: Uvicorn running on http://127.0.0.1:%s\\n' \"$4\" >&2\nexec /bin/sleep 5");
        let app = app();
        let blocked = fixture.dir.join("not-a-directory");
        std::fs::write(&blocked, "file").unwrap();
        let mut config = fixture.config();
        config.data_dir = Some(blocked.join("data"));
        let error = start_server_with(app.handle().clone(), app.state(), None, None, config).await.unwrap_err();
        assert!(error.contains("Failed to create data dir"), "{error}");
        assert!(app.state::<ServerState>().server_pid.lock().unwrap().is_none());
        assert!(app.state::<ServerState>().child.lock().unwrap().is_none());
        assert!(!fixture.dir.join("data/started").exists());
        let result = start_server_with(app.handle().clone(), app.state(), None, None, fixture.config()).await;
        stop_server_if_owned(app.state(), None).await.unwrap();
        assert!(result.is_ok(), "retry failed: {result:?}");
        assert!(fixture.dir.join("data/started").exists());
    }

    #[tokio::test]
    async fn restart_replaces_the_sidecar_and_preserves_or_updates_settings() {
        for (requested, expected) in [(None, "original models"), (Some("new models"), "new models"), (Some(""), "unset")] {
            let fixture = Fixture::new("printf '%s\\n' \"${VOICEBOX_MODELS_DIR-unset}\" >> \"$2/models\"\nprintf '%s\\n' \"$@\" > \"$2/args\"\nprintf 'INFO: Uvicorn running on http://0.0.0.0:%s\\n' \"$4\" >&2\nexec /bin/sleep 5");
            let app = app();
            start_server_with(app.handle().clone(), app.state(), Some(true), Some("original models".into()), fixture.config()).await.unwrap();
            let original_pid = app.state::<ServerState>().server_pid.lock().unwrap().unwrap();
            let result = tokio::time::timeout(Duration::from_secs(5), restart_server_with(
                app.handle().clone(), app.state(), requested.map(str::to_string), fixture.config(), Duration::from_secs(3), Duration::ZERO,
            )).await.unwrap().unwrap();
            assert_eq!(result, format!("http://127.0.0.1:{}", fixture.port));
            let new_pid = app.state::<ServerState>().server_pid.lock().unwrap().unwrap();
            assert_ne!(original_pid, new_pid);
            let models = std::fs::read_to_string(fixture.dir.join("data/models")).unwrap();
            assert_eq!(models.lines().collect::<Vec<_>>(), ["original models", expected]);
            let args = std::fs::read_to_string(fixture.dir.join("data/args")).unwrap();
            assert!(args.lines().collect::<Vec<_>>().windows(2).any(|args| args == ["--host", "0.0.0.0"]));
            assert!(*app.state::<ServerState>().remote.lock().unwrap());
            assert_eq!(app.state::<ServerState>().models_dir.lock().unwrap().as_deref(), if expected == "unset" { None } else { Some(expected) });
            stop_server_if_owned(app.state(), None).await.unwrap();
        }
    }

    #[tokio::test]
    async fn restart_cancels_pending_start_before_launching_replacement() {
        let old = Fixture::new("exec /bin/sleep 5");
        let replacement = Fixture::new("printf 'INFO: Uvicorn running on http://127.0.0.1:%s\\n' \"$4\" >&2\nexec /bin/sleep 5");
        let app = app();
        let handle = app.handle().clone();
        let config = old.config();
        let first = tokio::spawn(async move { start_server_with(handle.clone(), handle.state(), None, None, config).await });
        tokio::time::timeout(Duration::from_secs(4), async {
            while app.state::<ServerState>().server_pid.lock().unwrap().is_none() { tokio::time::sleep(Duration::from_millis(10)).await; }
        }).await.expect("first sidecar did not start");
        let old_pid = app.state::<ServerState>().server_pid.lock().unwrap().unwrap();
        let result = tokio::time::timeout(Duration::from_secs(5), restart_server_with(
            app.handle().clone(), app.state(), None, replacement.config(), Duration::from_secs(3), Duration::ZERO,
        )).await.unwrap().unwrap();
        assert_eq!(result, format!("http://127.0.0.1:{}", replacement.port));
        assert!(first.await.unwrap().unwrap_err().contains("cancelled"));
        assert_ne!(old_pid, app.state::<ServerState>().server_pid.lock().unwrap().unwrap());
        stop_server_if_owned(app.state(), None).await.unwrap();
    }

    #[tokio::test]
    async fn stop_during_restart_release_wait_cancels_before_sidecar_launch() {
        let fixture = Fixture::new("touch \"$2/started\"\nexec /bin/sleep 5");
        let app = app();
        let handle = app.handle().clone();
        let config = fixture.config();
        let mut restart = tokio::spawn(async move {
            restart_server_with(handle.clone(), handle.state(), None, config, Duration::from_secs(3), Duration::from_secs(3)).await
        });
        tokio::task::yield_now().await;
        stop_server_if_owned(app.state(), None).await.unwrap();
        let result = tokio::time::timeout(Duration::from_millis(500), &mut restart).await;
        if result.is_err() {
            restart.abort();
            let _ = restart.await;
            panic!("restart did not respond to stop during the release wait");
        }
        assert!(result.unwrap().unwrap().unwrap_err().contains("cancelled"));
        assert!(!fixture.dir.join("data/started").exists());
        assert!(app.state::<ServerState>().server_pid.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn stop_during_restart_delay_never_launches_replacement_afterward() {
        let fixture = Fixture::new("touch \"$2/started\"\nprintf 'INFO: Uvicorn running on http://127.0.0.1:%s\\n' \"$4\" >&2\nexec /bin/sleep 5");
        let app = app();
        let handle = app.handle().clone();
        let config = fixture.config();
        let restart = tokio::spawn(async move {
            restart_server_with(handle.clone(), handle.state(), None, config, Duration::from_secs(3), Duration::from_millis(250)).await
        });
        tokio::task::yield_now().await;
        stop_server_if_owned(app.state(), None).await.unwrap();
        let result = tokio::time::timeout(Duration::from_secs(5), restart).await.unwrap().unwrap();
        let launched = fixture.dir.join("data/started").exists();
        stop_server_if_owned(app.state(), None).await.unwrap();
        assert!(result.is_err(), "restart succeeded after stop: {result:?}");
        assert!(!launched, "restart launched a replacement after stop");
    }

    #[tokio::test]
    async fn newer_restart_supersedes_waiting_restart_without_launching_old_sidecar() {
        let first = Fixture::new("touch \"$2/first\"\nexec /bin/sleep 5");
        let second = Fixture::new("touch \"$2/second\"\nprintf 'INFO: Uvicorn running on http://127.0.0.1:%s\\n' \"$4\" >&2\nexec /bin/sleep 5");
        let app = app();
        let handle = app.handle().clone();
        let first_config = first.config();
        let first_restart = tokio::spawn(async move {
            restart_server_with(handle.clone(), handle.state(), None, first_config, Duration::from_secs(3), Duration::from_secs(3)).await
        });
        tokio::task::yield_now().await;
        let latest = tokio::time::timeout(Duration::from_secs(5), restart_server_with(
            app.handle().clone(), app.state(), None, second.config(), Duration::from_secs(3), Duration::ZERO,
        )).await.unwrap();
        let earlier = tokio::time::timeout(Duration::from_secs(1), first_restart).await.unwrap().unwrap();
        let first_launched = first.dir.join("data/first").exists();
        let second_launched = second.dir.join("data/second").exists();
        stop_server_if_owned(app.state(), None).await.unwrap();
        assert!(earlier.unwrap_err().contains("cancelled"));
        assert!(latest.is_ok());
        assert!(!first_launched);
        assert!(second_launched);
    }

    #[tokio::test]
    async fn stop_during_restart_idle_wait_cancels_without_launch() {
        let fixture = Fixture::new("touch \"$2/started\"\nexec /bin/sleep 5");
        let app = app();
        let state = app.state::<ServerState>();
        let pending = state.start_gate.try_begin().unwrap();
        let handle = app.handle().clone();
        let config = fixture.config();
        let mut restart = tokio::spawn(async move {
            restart_server_with(handle.clone(), handle.state(), None, config, Duration::from_secs(3), Duration::ZERO).await
        });
        tokio::task::yield_now().await;
        stop_server_if_owned(state.clone(), None).await.unwrap();
        let result = tokio::time::timeout(Duration::from_millis(500), &mut restart).await;
        if result.is_err() {
            restart.abort();
            let _ = restart.await;
            drop(pending);
            panic!("restart did not respond to stop during the idle wait");
        }
        assert!(result.unwrap().unwrap().unwrap_err().contains("cancelled"));
        assert!(!fixture.dir.join("data/started").exists());
        drop(pending);
    }

    #[tokio::test]
    async fn restart_timeout_does_not_launch_a_replacement_while_prior_start_is_busy() {
        let fixture = Fixture::new("touch \"$2/started\"\nexec /bin/sleep 5");
        let app = app();
        let state = app.state::<ServerState>();
        let pending = state.start_gate.try_begin().unwrap();
        let error = restart_server_with(app.handle().clone(), state.clone(), None, fixture.config(), Duration::from_millis(40), Duration::ZERO).await.unwrap_err();
        assert!(error.contains("did not stop in time"));
        assert!(!fixture.dir.join("data/started").exists());
        assert!(state.server_pid.lock().unwrap().is_none());
        drop(pending);
        assert!(state.start_gate.try_begin().is_some());
    }

    #[tokio::test]
    async fn repeated_start_reuses_healthy_managed_child_without_spawning_again() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let server = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            let mut socket = loop {
                match listener.accept() {
                    Ok((socket, _)) => break socket,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock && std::time::Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
                    Err(error) => panic!("health request not received: {error}"),
                }
            };
            socket.set_nonblocking(false).unwrap();
            socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut request = Vec::new();
            let mut chunk = [0; 1024];
            while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                let count = socket.read(&mut chunk).unwrap();
                assert!(count > 0, "client closed before request headers");
                request.extend_from_slice(&chunk[..count]);
                assert!(request.len() < 16 * 1024);
            }
            assert!(request.starts_with(b"GET /health "));
            let body = r#"{"status":"healthy","model_loaded":false,"gpu_available":false}"#;
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        });
        let fixture = Fixture::new("echo started >> \"$2/starts\"\nprintf 'INFO: Uvicorn running on http://127.0.0.1:%s\\n' \"$4\" >&2\nexec /bin/sleep 5");
        let mut config = fixture.config();
        config.port = port;
        let app = app();
        start_server_with(app.handle().clone(), app.state(), None, None, config).await.unwrap();
        let pid = app.state::<ServerState>().server_pid.lock().unwrap().unwrap();
        let mut retry_config = fixture.config();
        retry_config.port = port;
        let result = start_server_with(app.handle().clone(), app.state(), None, None, retry_config).await;
        server.join().unwrap();
        let current_pid = *app.state::<ServerState>().server_pid.lock().unwrap();
        let starts = std::fs::read_to_string(fixture.dir.join("data/starts")).unwrap();
        stop_server_if_owned(app.state(), None).await.unwrap();
        assert_eq!(result.unwrap(), format!("http://127.0.0.1:{port}"));
        assert_eq!(current_pid, Some(pid));
        assert_eq!(starts.lines().count(), 1);
    }

    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn failed_or_exited_sidecar_reuses_only_a_healthy_manual_server() {
        use std::io::{Read, Write};
        for spawn_failure in [true, false] {
            for healthy in [true, false] {
                let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
                listener.set_nonblocking(true).unwrap();
                let port = listener.local_addr().unwrap().port();
                let server = std::thread::spawn(move || {
                    let deadline = std::time::Instant::now() + Duration::from_secs(5);
                    loop {
                        match listener.accept() {
                            Ok((mut socket, _)) => {
                                socket.set_nonblocking(false).unwrap();
                                socket.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
                                let mut request = Vec::new();
                                let mut chunk = [0; 1024];
                                while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                                    let count = socket.read(&mut chunk).unwrap();
                                    assert!(count > 0, "client closed before request headers");
                                    request.extend_from_slice(&chunk[..count]);
                                    assert!(request.len() < 16 * 1024);
                                }
                                assert!(request.starts_with(b"GET /health "));
                                let body = if healthy { r#"{"status":"healthy","model_loaded":false,"gpu_available":false}"# } else { "{}" };
                                write!(socket, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
                                return;
                            }
                            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock && std::time::Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
                            Err(error) => panic!("health request not received: {error}"),
                        }
                    }
                });
                let fixture = Fixture::new("exit 42");
                let mut config = fixture.config();
                config.port = port;
                if spawn_failure { config.cpu_executable = Some(fixture.dir.join("missing-sidecar")); }
                let app = app();
                let result = tokio::time::timeout(Duration::from_secs(7), start_server_with(
                    app.handle().clone(), app.state(), None, None, config,
                )).await.expect("startup did not finish");
                server.join().unwrap();
                if healthy {
                    assert_eq!(result.unwrap(), format!("http://127.0.0.1:{port}"));
                } else {
                    assert!(result.unwrap_err().contains("Start server manually"));
                }
                let state = app.state::<ServerState>();
                assert!(state.server_pid.lock().unwrap().is_none());
                assert!(state.child.lock().unwrap().is_none());
                assert!(state.start_gate.try_begin().is_some());
                stop_server_if_owned(state, None).await.unwrap();
            }
        }
    }

    #[tokio::test]
    async fn isolated_sidecar_exit_clears_ownership_and_reports_failure() {
        let fixture = Fixture::new("printf 'ERROR: startup failed\\n' >&2\nexit 42");
        let app = app();
        let logs = Arc::new(Mutex::new(Vec::<String>::new()));
        let observed = logs.clone();
        app.listen("server-log", move |event| {
            observed.lock().unwrap().push(event.payload().into())
        });
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            start_server_with(
                app.handle().clone(),
                app.state(),
                None,
                None,
                fixture.config(),
            ),
        )
        .await
        .unwrap();
        assert!(result.unwrap_err().contains("Start server manually"));
        assert!(logs
            .lock()
            .unwrap()
            .iter()
            .any(|entry| entry.contains("startup failed")));
        assert!(app
            .state::<ServerState>()
            .server_pid
            .lock()
            .unwrap()
            .is_none());
        assert!(app.state::<ServerState>().child.lock().unwrap().is_none());
        assert!(app.state::<ServerState>().start_gate.try_begin().is_some());
    }

    #[tokio::test]
    async fn stop_cancels_an_isolated_inflight_sidecar_start() {
        let fixture = Fixture::new("exec /bin/sleep 5");
        let app = app();
        let handle = app.handle().clone();
        let config = fixture.config();
        let startup = tokio::spawn(async move {
            start_server_with(handle.clone(), handle.state(), None, None, config).await
        });
        tokio::time::timeout(Duration::from_secs(4), async {
            while app
                .state::<ServerState>()
                .server_pid
                .lock()
                .unwrap()
                .is_none()
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("sidecar did not start");
        stop_server_if_owned(app.state(), None).await.unwrap();
        let result = tokio::time::timeout(Duration::from_secs(3), startup)
            .await
            .unwrap()
            .unwrap();
        assert!(result.unwrap_err().contains("cancelled"));
        assert!(app
            .state::<ServerState>()
            .server_pid
            .lock()
            .unwrap()
            .is_none());
        assert!(app.state::<ServerState>().child.lock().unwrap().is_none());
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn isolated_listener_reuses_healthy_server_and_rejects_conflicts() {
        use std::io::{Read, Write};
        for healthy in [true, false] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = std::thread::spawn(move || {
                let deadline = std::time::Instant::now() + Duration::from_secs(4);
                loop {
                    match listener.accept() {
                        Ok((mut socket, _)) => {
                            socket.set_nonblocking(false).unwrap();
                            socket
                                .set_read_timeout(Some(Duration::from_secs(1)))
                                .unwrap();
                            let mut request = Vec::new();
                            let mut chunk = [0; 1024];
                            while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                                let count = socket.read(&mut chunk).unwrap();
                                assert!(
                                    count > 0,
                                    "client closed before completing request headers"
                                );
                                request.extend_from_slice(&chunk[..count]);
                                assert!(request.len() < 16 * 1024, "request headers too large");
                            }
                            assert!(request.starts_with(b"GET /health "));
                            let body = if healthy {
                                r#"{"status":"healthy","model_loaded":false,"gpu_available":false}"#
                            } else {
                                "{}"
                            };
                            write!(socket, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
                            break;
                        }
                        Err(error)
                            if error.kind() == std::io::ErrorKind::WouldBlock
                                && std::time::Instant::now() < deadline =>
                        {
                            std::thread::sleep(Duration::from_millis(5))
                        }
                        Err(error) => panic!("health request not received: {error}"),
                    }
                }
            });
            let fixture = Fixture::new("exit 42");
            let mut config = fixture.config();
            config.port = port;
            config.discover_listener = true;
            let app = app();
            let result = tokio::time::timeout(
                Duration::from_secs(5),
                start_server_with(app.handle().clone(), app.state(), None, None, config),
            )
            .await
            .unwrap();
            if healthy {
                assert_eq!(result.unwrap(), format!("http://127.0.0.1:{port}"));
            } else {
                assert!(result.unwrap_err().contains("already in use"));
            }
            assert!(app
                .state::<ServerState>()
                .server_pid
                .lock()
                .unwrap()
                .is_none());
            assert!(app.state::<ServerState>().child.lock().unwrap().is_none());
            server.join().unwrap();
        }
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn malformed_listener_row_prevents_claiming_healthy_external_server() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut request = Vec::new();
            let mut chunk = [0; 1024];
            while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                let count = socket.read(&mut chunk).unwrap();
                assert!(count > 0 && request.len() < 16 * 1024);
                request.extend_from_slice(&chunk[..count]);
            }
            assert!(request.starts_with(b"GET /health "));
            let body = r#"{"status":"healthy","model_loaded":false,"gpu_available":false}"#;
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        });
        let fixture = Fixture::new("exit 42");
        let probe = fixture.dir.join("listener-probe");
        std::fs::write(&probe, "#!/bin/sh\nprintf 'COMMAND PID\\nvoicebox-server 123\\nmystery\\n'\n").unwrap();
        std::fs::set_permissions(&probe, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut config = fixture.config();
        config.port = port;
        config.discover_listener = true;
        config.listener_executable = Some(probe);
        let app = app();
        let result = tokio::time::timeout(Duration::from_secs(5),
            start_server_with(app.handle().clone(), app.state(), None, None, config)).await.unwrap().unwrap();
        assert_eq!(result, format!("http://127.0.0.1:{port}"));
        assert!(app.state::<ServerState>().server_pid.lock().unwrap().is_none());
        assert!(app.state::<ServerState>().child.lock().unwrap().is_none());
        server.join().unwrap();
    }

    fn install_gpu(
        fixture: &Fixture,
        kind: &str,
        version: &str,
        remove_execute_after_probe: bool,
    ) -> std::path::PathBuf {
        let directory = fixture.dir.join("data/backends").join(kind);
        std::fs::create_dir_all(&directory).unwrap();
        let executable = directory.join(format!("voicebox-server-{kind}"));
        let chmod = if remove_execute_after_probe {
            "/bin/chmod 600 \"$0\""
        } else {
            ":"
        };
        let script = format!("#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then\n  printf probed > probe\n  printf 'voicebox-server {version}\\n'\n  {chmod}\n  exit 0\nfi\nprintf '{kind}\\n%s\\n%s\\n' \"$VOICEBOX_MODELS_DIR\" \"$PWD\" > \"$2/selected\"\nprintf 'INFO: Uvicorn running on http://127.0.0.1:%s\\n' \"$4\" >&2\nexec /bin/sleep 5\n");
        std::fs::write(&executable, script).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        directory
    }

    #[tokio::test]
    async fn pinned_gpu_only_probes_fallback_if_the_pin_is_missing_or_incompatible() {
        for (pin, rocm_version, cuda_version, expected, expected_probes) in [
            ("cuda", Some("0.6.0"), Some("0.6.0"), "cuda", (false, true)),
            ("rocm", Some("0.6.0"), Some("0.6.0"), "rocm", (true, false)),
            ("cuda", Some("0.6.0"), None, "rocm", (true, false)),
            ("cuda", Some("0.6.0"), Some("0.5.0"), "rocm", (true, true)),
            ("rocm", Some("0.5.0"), Some("0.6.0"), "cuda", (true, true)),
            ("cuda", Some("0.5.0"), Some("0.5.0"), "cpu", (true, true)),
        ] {
            let fixture = Fixture::new("printf 'cpu\n' > \"$2/selected\"\nprintf 'INFO: Uvicorn running on http://127.0.0.1:%s\n' \"$4\" >&2\nexec /bin/sleep 5");
            let rocm = fixture.dir.join("data/backends/rocm");
            let cuda = fixture.dir.join("data/backends/cuda");
            if let Some(version) = rocm_version { install_gpu(&fixture, "rocm", version, false); }
            if let Some(version) = cuda_version { install_gpu(&fixture, "cuda", version, false); }
            let app = app();
            *app.state::<ServerState>().backend_override.lock().unwrap() = Some(pin.into());
            let result = tokio::time::timeout(Duration::from_secs(8), start_server_with(
                app.handle().clone(), app.state(), None, None, fixture.config(),
            )).await.unwrap();
            if result.is_ok() { stop_server_if_owned(app.state(), None).await.unwrap(); }
            result.unwrap();
            let selected = std::fs::read_to_string(fixture.dir.join("data/selected")).unwrap();
            assert_eq!(selected.lines().next(), Some(expected), "pin={pin}");
            assert_eq!((rocm.join("probe").exists(), cuda.join("probe").exists()), expected_probes, "pin={pin}");
        }
    }

    #[tokio::test]
    async fn cancelling_a_pinned_probe_does_not_probe_the_other_gpu() {
        let fixture = Fixture::new("exec /bin/sleep 5");
        let rocm = install_gpu(&fixture, "rocm", "0.6.0", false);
        let cuda = install_gpu(&fixture, "cuda", "0.6.0", false);
        let executable = cuda.join("voicebox-server-cuda");
        std::fs::write(&executable, "#!/bin/sh\nprintf started > probe-started\nexec /bin/sleep 10\n").unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let app = app();
        *app.state::<ServerState>().backend_override.lock().unwrap() = Some("cuda".into());
        let handle = app.handle().clone();
        let config = fixture.config();
        let task = tokio::spawn(async move { start_server_with(handle.clone(), handle.state(), None, None, config).await });
        let entered = tokio::time::timeout(Duration::from_secs(4), async {
            while !cuda.join("probe-started").exists() { tokio::time::sleep(Duration::from_millis(5)).await; }
        }).await;
        if entered.is_err() { task.abort(); panic!("selected probe did not start"); }
        app.state::<ServerState>().start_gate.cancel_and(|| ());
        let result = tokio::time::timeout(Duration::from_secs(2), task).await.unwrap().unwrap();
        assert!(result.unwrap_err().contains("cancelled"));
        assert!(!rocm.join("probe").exists());
        assert!(app.state::<ServerState>().server_pid.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn real_sidecar_selection_honors_pins_versions_and_spawn_fallback() {
        for (pin, rocm_version, remove_execute, expected, probes) in [
            (None, "0.6.0", false, "rocm", (true, true)),
            (Some("cuda"), "0.6.0", false, "cuda", (false, true)),
            (Some("cpu"), "0.6.0", false, "cpu", (false, false)),
            (None, "0.5.0", false, "cuda", (true, true)),
            (None, "0.6.0", true, "cuda", (true, true)),
            (Some("rocm"), "0.6.0", true, "cpu", (true, false)),
        ] {
            let fixture = Fixture::new("printf 'cpu\\n%s\\n' \"$VOICEBOX_MODELS_DIR\" > \"$2/selected\"\nprintf 'INFO: Uvicorn running on http://127.0.0.1:%s\\n' \"$4\" >&2\nexec /bin/sleep 5");
            let rocm = install_gpu(&fixture, "rocm", rocm_version, remove_execute);
            let cuda = install_gpu(&fixture, "cuda", "0.6.0", false);
            let app = app();
            *app.state::<ServerState>().backend_override.lock().unwrap() = pin.map(str::to_owned);
            let result = tokio::time::timeout(
                Duration::from_secs(8),
                start_server_with(
                    app.handle().clone(),
                    app.state(),
                    None,
                    Some("custom models".into()),
                    fixture.config(),
                ),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(result, format!("http://127.0.0.1:{}", fixture.port));
            let selected = std::fs::read_to_string(fixture.dir.join("data/selected")).unwrap();
            let values: Vec<_> = selected.lines().collect();
            assert_eq!(values[0], expected, "pin={pin:?}, version={rocm_version}");
            assert_eq!(values[1], "custom models");
            if expected != "cpu" {
                assert_eq!(
                    values[2],
                    if expected == "rocm" {
                        rocm.to_str().unwrap()
                    } else {
                        cuda.to_str().unwrap()
                    }
                );
            }
            assert_eq!(
                (rocm.join("probe").exists(), cuda.join("probe").exists()),
                probes
            );
            stop_server_if_owned(app.state(), None).await.unwrap();
        }
    }

    #[tokio::test]
    async fn saved_gpu_override_selects_backend_after_restart() {
        for (saved, live, install_rocm, expected, probes) in [
            ("cpu", None, true, "cpu", (false, false)),
            ("cuda", None, true, "cuda", (false, true)),
            ("rocm", None, true, "rocm", (true, false)),
            ("rocm", None, false, "cuda", (false, true)),
            ("cuda", Some("cpu"), true, "cpu", (false, false)),
        ] {
            let fixture = Fixture::new("printf 'cpu\\n%s\\n' \"$VOICEBOX_MODELS_DIR\" > \"$2/selected\"\nprintf 'INFO: Uvicorn running on http://127.0.0.1:%s\\n' \"$4\" >&2\nexec /bin/sleep 5");
            let rocm = fixture.dir.join("data/backends/rocm");
            if install_rocm { install_gpu(&fixture, "rocm", "0.6.0", false); }
            let cuda = install_gpu(&fixture, "cuda", "0.6.0", false);
            write_persisted_backend_override(&fixture.dir.join("data"), Some(saved)).unwrap();
            let app = app();
            *app.state::<ServerState>().backend_override.lock().unwrap() = live.map(str::to_string);
            let result = tokio::time::timeout(Duration::from_secs(8), start_server_with(
                app.handle().clone(), app.state(), None, Some("saved models".into()), fixture.config(),
            )).await.unwrap().unwrap();
            assert_eq!(result, format!("http://127.0.0.1:{}", fixture.port));
            let selected = std::fs::read_to_string(fixture.dir.join("data/selected")).unwrap();
            let lines: Vec<_> = selected.lines().collect();
            assert_eq!(lines[0], expected, "saved={saved}, live={live:?}");
            assert_eq!(lines[1], "saved models");
            assert_eq!((rocm.join("probe").exists(), cuda.join("probe").exists()), probes);
            stop_server_if_owned(app.state(), None).await.unwrap();
        }
    }

    #[tokio::test]
    async fn cancelling_start_reaps_a_stalled_real_gpu_version_probe() {
        let fixture = Fixture::new("touch \"$2/cpu-started\"\nexec /bin/sleep 5");
        let rocm = fixture.dir.join("data/backends/rocm");
        std::fs::create_dir_all(&rocm).unwrap();
        let binary = rocm.join("voicebox-server-rocm");
        std::fs::write(&binary, "#!/bin/sh\nprintf '%s' \"$$\" > probe-pid\nexec /bin/sleep 30\n").unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        let app = app();
        let handle = app.handle().clone();
        let config = fixture.config();
        let startup = tokio::spawn(async move {
            start_server_with(handle.clone(), handle.state(), None, None, config).await
        });
        let pid_file = rocm.join("probe-pid");
        let pid = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Ok(pid) = std::fs::read_to_string(&pid_file) {
                    if let Ok(pid) = pid.parse::<u32>() { break pid; }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.expect("GPU probe did not start");
        stop_server_if_owned(app.state(), None).await.unwrap();
        let result = tokio::time::timeout(Duration::from_secs(3), startup).await.unwrap().unwrap();
        assert!(result.unwrap_err().contains("cancelled"));
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let exists = std::process::Command::new("kill").args(["-0", &pid.to_string()]).output().unwrap().status.success();
                if !exists { break; }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }).await.expect("cancelled version probe was not reaped");
        assert!(!fixture.dir.join("data/cpu-started").exists());
        assert!(app.state::<ServerState>().server_pid.lock().unwrap().is_none());
        assert!(app.state::<ServerState>().start_gate.try_begin().is_some());
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn stop_interrupts_stalled_current_and_legacy_health_probes() {
        use std::io::{Read, Write};
        for legacy in [false, true] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let port = listener.local_addr().unwrap().port();
            let (accepted_tx, accepted_rx) = tokio::sync::oneshot::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            let server = std::thread::spawn(move || {
                let deadline = std::time::Instant::now() + Duration::from_secs(5);
                let mut socket = loop {
                    match listener.accept() {
                        Ok((socket, _)) => break socket,
                        Err(e)
                            if e.kind() == std::io::ErrorKind::WouldBlock
                                && std::time::Instant::now() < deadline =>
                        {
                            std::thread::sleep(Duration::from_millis(5))
                        }
                        Err(e) => panic!("health probe did not connect: {e}"),
                    }
                };
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut headers = Vec::new();
                let mut chunk = [0; 1024];
                while !headers.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                    let n = socket.read(&mut chunk).unwrap();
                    assert!(n > 0);
                    headers.extend_from_slice(&chunk[..n]);
                }
                let _ = accepted_tx.send(());
                let _ = release_rx.recv_timeout(Duration::from_secs(5));
                let body = r#"{"status":"healthy","model_loaded":false,"gpu_available":false}"#;
                let _ = write!(
                    socket,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
            });
            let fixture = Fixture::new("touch \"$2/sidecar-started\"\nexec /bin/sleep 5");
            let mut config = fixture.config();
            if legacy {
                config.legacy_port = Some(port);
            } else {
                config.port = port;
                config.discover_listener = true;
            }
            let app = app();
            let handle = app.handle().clone();
            let mut startup = tokio::spawn(async move {
                start_server_with(handle.clone(), handle.state(), None, None, config).await
            });
            tokio::time::timeout(Duration::from_secs(5), accepted_rx)
                .await
                .unwrap()
                .unwrap();
            stop_server_if_owned(app.state(), None).await.unwrap();
            let timely = tokio::time::timeout(Duration::from_millis(500), &mut startup).await;
            let _ = release_tx.send(());
            server.join().unwrap();
            let result = match timely {
                Ok(joined) => joined.unwrap(),
                Err(_) => {
                    let _ = startup.await;
                    panic!("stop waited for stalled health probe, legacy={legacy}");
                }
            };
            assert!(result.unwrap_err().contains("cancelled"), "legacy={legacy}");
            assert!(!fixture.dir.join("data/sidecar-started").exists());
            assert!(app
                .state::<ServerState>()
                .server_pid
                .lock()
                .unwrap()
                .is_none());
        }
    }

    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn stopping_during_timeout_health_probe_cancels_and_reaps_sidecar() {
        use std::io::Read;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let (accepted_tx, accepted_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let server = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            let mut socket = loop {
                match listener.accept() {
                    Ok((socket, _)) => break socket,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock && std::time::Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
                    Err(error) => panic!("health request not received: {error}"),
                }
            };
            socket.set_nonblocking(false).unwrap();
            socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut chunk = [0; 1024];
            assert!(socket.read(&mut chunk).unwrap() > 0);
            let _ = accepted_tx.send(());
            let _ = release_rx.recv_timeout(Duration::from_secs(5));
        });
        let fixture = Fixture::new("exec /bin/sleep 5");
        let mut config = fixture.config();
        config.port = port;
        config.startup_timeout = Duration::from_millis(150);
        let app = app();
        let handle = app.handle().clone();
        let startup = tokio::spawn(async move { start_server_with(handle.clone(), handle.state(), None, None, config).await });
        tokio::time::timeout(Duration::from_secs(5), accepted_rx).await.unwrap().unwrap();
        let pid = app.state::<ServerState>().server_pid.lock().unwrap().unwrap();
        tokio::time::timeout(Duration::from_secs(3), stop_server_if_owned(app.state(), None)).await.unwrap().unwrap();
        let error = tokio::time::timeout(Duration::from_secs(3), startup).await.unwrap().unwrap().unwrap_err();
        let _ = release_tx.send(());
        server.join().unwrap();
        assert!(error.contains("cancelled"), "{error}");
        assert!(app.state::<ServerState>().server_pid.lock().unwrap().is_none());
        assert!(app.state::<ServerState>().child.lock().unwrap().is_none());
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let alive = std::process::Command::new("kill").args(["-0", &pid.to_string()]).output().unwrap().status.success();
                if !alive { break; }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }).await.expect("sidecar remains alive after cancellation");
    }

    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn timeout_health_fallback_requires_valid_voicebox_health() {
        use std::io::{Read, Write};
        for healthy in [true, false] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = std::thread::spawn(move || {
                let deadline = std::time::Instant::now() + Duration::from_secs(5);
                let mut socket = loop {
                    match listener.accept() {
                        Ok((socket, _)) => break socket,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock && std::time::Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
                        Err(error) => panic!("health request not received: {error}"),
                    }
                };
                socket.set_nonblocking(false).unwrap();
                socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                let mut request = Vec::new();
                let mut chunk = [0; 1024];
                while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                    let count = socket.read(&mut chunk).unwrap();
                    assert!(count > 0, "client closed before request headers");
                    request.extend_from_slice(&chunk[..count]);
                    assert!(request.len() < 16 * 1024);
                }
                assert!(request.starts_with(b"GET /health "));
                let body = if healthy { r#"{"status":"healthy","model_loaded":false,"gpu_available":false}"# } else { "{}" };
                write!(socket, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
            });
            let fixture = Fixture::new("printf 'ERROR: still starting\\n' >&2\nexec /bin/sleep 5");
            let mut config = fixture.config();
            config.port = port;
            config.startup_timeout = Duration::from_millis(150);
            let app = app();
            let result = tokio::time::timeout(Duration::from_secs(7), start_server_with(
                app.handle().clone(), app.state(), None, None, config,
            )).await.expect("startup did not finish");
            server.join().unwrap();
            let state = app.state::<ServerState>();
            let owned = state.server_pid.lock().unwrap().is_some();
            stop_server_if_owned(state.clone(), None).await.unwrap();
            assert!(state.child.lock().unwrap().is_none());
            if healthy {
                assert_eq!(result.unwrap(), format!("http://127.0.0.1:{port}"));
                assert!(owned);
            } else {
                assert!(result.unwrap_err().contains("timed out"));
                assert!(!owned);
            }
        }
    }

    #[tokio::test]
    async fn timed_out_sidecar_is_stopped_and_ownership_is_cleared() {
        let fixture = Fixture::new("printf 'ERROR: still starting\\n' >&2\nexec /bin/sleep 5");
        let app = app();
        let mut config = fixture.config();
        config.startup_timeout = Duration::from_millis(1500);
        let logs = Arc::new(Mutex::new(Vec::<String>::new()));
        let observed = logs.clone();
        app.listen("server-log", move |event| {
            observed.lock().unwrap().push(event.payload().into())
        });
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            start_server_with(app.handle().clone(), app.state(), None, None, config),
        )
        .await
        .unwrap();
        assert!(result.unwrap_err().contains("timed out"));
        assert!(logs
            .lock()
            .unwrap()
            .iter()
            .any(|entry| entry.contains("still starting")));
        assert!(app
            .state::<ServerState>()
            .server_pid
            .lock()
            .unwrap()
            .is_none());
        assert!(app.state::<ServerState>().child.lock().unwrap().is_none());
        assert!(app.state::<ServerState>().start_gate.try_begin().is_some());
    }

    #[tokio::test]
    async fn ready_sidecar_exit_is_forwarded_and_releases_ownership() {
        let fixture = Fixture::new("printf 'INFO: Uvicorn running on http://127.0.0.1:%s\\nINFO: after readiness\\n' \"$4\" >&2\nexec /bin/sleep 1");
        let app = app();
        let logs = Arc::new(Mutex::new(Vec::<String>::new()));
        let observed = logs.clone();
        app.listen("server-log", move |event| {
            observed.lock().unwrap().push(event.payload().into())
        });
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            start_server_with(
                app.handle().clone(),
                app.state(),
                None,
                None,
                fixture.config(),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(result, format!("http://127.0.0.1:{}", fixture.port));
        tokio::time::timeout(Duration::from_secs(4), async {
            while app
                .state::<ServerState>()
                .server_pid
                .lock()
                .unwrap()
                .is_some()
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("exited sidecar ownership was not released");
        assert!(app.state::<ServerState>().child.lock().unwrap().is_none());
        assert!(logs
            .lock()
            .unwrap()
            .iter()
            .any(|entry| entry.contains("after readiness")));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancel_during_port_release_delay_returns_promptly_without_launch() {
        let fixture = Fixture::new("touch \"$2/sidecar-started\"\nexec /bin/sleep 5");
        let mut config = fixture.config();
        config.port_release_delay = Duration::from_secs(3);
        let app = app();
        let handle = app.handle().clone();
        let mut startup = tokio::spawn(async move {
            start_server_with(handle.clone(), handle.state(), None, None, config).await
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while app.state::<ServerState>().start_gate.try_begin().is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        stop_server_if_owned(app.state(), None).await.unwrap();
        let timely = tokio::time::timeout(Duration::from_millis(800), &mut startup).await;
        let result = match timely {
            Ok(result) => result.unwrap(),
            Err(_) => {
                let _ = startup.await;
                panic!("startup did not cancel during port-release delay");
            }
        };
        assert!(result.unwrap_err().contains("cancelled"));
        assert!(!fixture.dir.join("data/sidecar-started").exists());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancel_during_listener_discovery_terminates_probe_and_never_launches_sidecar() {
        for legacy in [false, true] {
            let fixture = Fixture::new("touch \"$2/sidecar-started\"\nexec /bin/sleep 5");
            let marker = fixture.dir.join("listener-pid");
            let probe = fixture.dir.join("slow-lsof");
            std::fs::write(
                &probe,
                format!(
                    "#!/bin/sh\nprintf '%s' \"$$\" > '{}'\nexec /bin/sleep 3\n",
                    marker.display()
                ),
            )
            .unwrap();
            std::fs::set_permissions(&probe, std::fs::Permissions::from_mode(0o700)).unwrap();
            let mut config = fixture.config();
            config.listener_executable = Some(probe);
            if legacy {
                config.legacy_port = Some(12345);
            } else {
                config.discover_listener = true;
            }
            let app = app();
            let handle = app.handle().clone();
            let mut startup = tokio::spawn(async move {
                start_server_with(handle.clone(), handle.state(), None, None, config).await
            });
            tokio::time::timeout(Duration::from_secs(3), async {
                while !marker.exists() {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("listener probe did not start");
            let pid = std::fs::read_to_string(&marker).unwrap();
            stop_server_if_owned(app.state(), None).await.unwrap();
            let timely = tokio::time::timeout(Duration::from_millis(800), &mut startup).await;
            let result = match timely {
                Ok(result) => result.unwrap(),
                Err(_) => {
                    let _ = startup.await;
                    panic!("startup waited for stalled listener probe, legacy={legacy}");
                }
            };
            assert!(result.unwrap_err().contains("cancelled"));
            tokio::time::timeout(Duration::from_secs(2), async {
                while std::process::Command::new("/bin/kill")
                    .args(["-0", pid.as_str()])
                    .status()
                    .unwrap()
                    .success()
                {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("cancelled listener probe survived");
            assert!(!fixture.dir.join("data/sidecar-started").exists());
        }
    }

    #[tokio::test]
    async fn missing_or_failing_listener_probe_preserves_sidecar_fallback() {
        for legacy in [false, true] {
            for missing in [false, true] {
                let fixture = Fixture::new("printf 'INFO: Uvicorn running on http://127.0.0.1:%s\\n' \"$4\" >&2\nexec /bin/sleep 5");
                let probe = fixture.dir.join("lsof-fixture");
                if !missing {
                    std::fs::write(&probe, "#!/bin/sh\nexit 1\n").unwrap();
                    std::fs::set_permissions(&probe, std::fs::Permissions::from_mode(0o700))
                        .unwrap();
                }
                let mut config = fixture.config();
                config.listener_executable = Some(probe);
                if legacy {
                    config.legacy_port = Some(12345);
                } else {
                    config.discover_listener = true;
                }
                let app = app();
                let result = tokio::time::timeout(
                    Duration::from_secs(5),
                    start_server_with(app.handle().clone(), app.state(), None, None, config),
                )
                .await
                .unwrap()
                .unwrap();
                assert_eq!(result, format!("http://127.0.0.1:{}", fixture.port));
                stop_server_if_owned(app.state(), None).await.unwrap();
            }
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stalled_listener_discovery_times_out_and_terminates_probe() {
        for legacy in [false, true] {
            let fixture = Fixture::new("touch \"$2/sidecar-started\"\nexec /bin/sleep 5");
            let marker = fixture.dir.join("listener-pid");
            let probe = fixture.dir.join("slow-lsof");
            std::fs::write(
                &probe,
                format!(
                    "#!/bin/sh\nprintf '%s' \"$$\" > '{}'\nexec /bin/sleep 5\n",
                    marker.display()
                ),
            )
            .unwrap();
            std::fs::set_permissions(&probe, std::fs::Permissions::from_mode(0o700)).unwrap();
            let mut config = fixture.config();
            config.listener_executable = Some(probe);
            config.listener_timeout = Duration::from_millis(1500);
            if legacy {
                config.legacy_port = Some(12345);
            } else {
                config.discover_listener = true;
            }
            let app = app();
            let handle = app.handle().clone();
            let mut startup = tokio::spawn(async move {
                start_server_with(handle.clone(), handle.state(), None, None, config).await
            });
            tokio::time::timeout(Duration::from_secs(3), async {
                while !marker.exists() {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("listener probe did not start");
            let pid = std::fs::read_to_string(&marker).unwrap();
            let timely = tokio::time::timeout(Duration::from_secs(3), &mut startup).await;
            let result = match timely {
                Ok(result) => result.unwrap(),
                Err(_) => {
                    stop_server_if_owned(app.state(), None).await.unwrap();
                    let _ = startup.await;
                    panic!("stalled listener probe did not time out, legacy={legacy}");
                }
            };
            assert!(
                result.unwrap_err().contains("listener discovery timed out"),
                "legacy={legacy}"
            );
            tokio::time::timeout(Duration::from_secs(2), async {
                while std::process::Command::new("/bin/kill")
                    .args(["-0", pid.as_str()])
                    .status()
                    .unwrap()
                    .success()
                {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("timed-out listener probe survived");
            assert!(!fixture.dir.join("data/sidecar-started").exists());
            assert!(app
                .state::<ServerState>()
                .server_pid
                .lock()
                .unwrap()
                .is_none());
        }
    }

    #[tokio::test]
    async fn sidecar_listening_on_wrong_port_is_not_reported_ready() {
        let fixture = Fixture::new(
            "printf 'INFO: Uvicorn running on http://127.0.0.1:1\\n' >&2\nexec /bin/sleep 5",
        );
        let app = app();
        let mut config = fixture.config();
        config.startup_timeout = Duration::from_millis(500);
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            start_server_with(app.handle().clone(), app.state(), None, None, config),
        )
        .await
        .unwrap();
        // Ensure the unfixed implementation does not leave the stand-in process running.
        stop_server_if_owned(app.state(), None).await.unwrap();
        assert!(
            result.is_err(),
            "sidecar on port 1 was accepted for port {}",
            fixture.port
        );
    }

    #[tokio::test]
    async fn remote_sidecar_reports_ready_on_public_bind_address() {
        let fixture = Fixture::new("printf '%s\\n' \"$@\" > \"$2/invocation\"\nprintf 'INFO: Uvicorn running on http://0.0.0.0:%s\\n' \"$4\" >&2\nexec /bin/sleep 5");
        let app = app();
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            start_server_with(
                app.handle().clone(),
                app.state(),
                Some(true),
                None,
                fixture.config(),
            ),
        )
        .await
        .unwrap();
        let invocation = std::fs::read_to_string(fixture.dir.join("data/invocation")).unwrap();
        let args: Vec<_> = invocation.lines().collect();
        stop_server_if_owned(app.state(), None).await.unwrap();
        assert_eq!(
            result.unwrap(),
            format!("http://127.0.0.1:{}", fixture.port)
        );
        assert!(args.windows(2).any(|pair| pair == ["--host", "0.0.0.0"]));
    }
}

#[cfg(all(test, desktop))]
mod hotkey_window_startup_tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn failed_window_creation_stops_existing_listener_and_fails_startup() {
        let events = RefCell::new(Vec::new());
        let result = configure_hotkey_window(
            false,
            || {
                events.borrow_mut().push("create");
                Err("window unavailable".into())
            },
            || {
                events.borrow_mut().push("stop");
                Ok(())
            },
            || {
                events.borrow_mut().push("arm");
                Ok(())
            },
        );
        assert!(result.unwrap_err().contains("window unavailable"));
        assert_eq!(*events.borrow(), ["create", "stop"]);
    }

    #[test]
    fn existing_window_arms_without_rebuilding_or_stopping() {
        let result = configure_hotkey_window(
            true,
            || panic!("existing window must not be rebuilt"),
            || panic!("existing listener must not be stopped"),
            || Ok(()),
        );
        assert!(result.is_ok());
    }

    #[test]
    fn new_window_is_created_before_listener_is_armed() {
        let events = RefCell::new(Vec::new());
        let result = configure_hotkey_window(
            false,
            || {
                events.borrow_mut().push("create");
                Ok(())
            },
            || panic!("successful startup must not stop"),
            || {
                events.borrow_mut().push("arm");
                Ok(())
            },
        );
        assert!(result.is_ok());
        assert_eq!(*events.borrow(), ["create", "arm"]);
    }

    #[test]
    fn listener_start_error_reaches_caller_after_window_creation() {
        let result = configure_hotkey_window(
            false,
            || Ok(()),
            || Ok(()),
            || Err("tap unavailable".into()),
        );
        assert_eq!(result.unwrap_err(), "tap unavailable");
    }

    #[test]
    fn window_and_stop_errors_are_both_reported_without_arming() {
        let result = configure_hotkey_window(
            false,
            || Err("window unavailable".into()),
            || Err("monitor unavailable".into()),
            || panic!("must not arm without a window"),
        );
        let error = result.unwrap_err();
        assert!(error.contains("window unavailable"));
        assert!(error.contains("monitor unavailable"));
    }

    #[test]
    fn stopping_before_a_listener_exists_is_safe_and_idempotent() {
        let state = HotkeyState::default();
        assert!(stop_hotkey(&state).is_ok());
        assert!(stop_hotkey(&state).is_ok());
        assert!(state.monitor.lock().unwrap().is_none());
    }

    #[test]
    fn poisoned_monitor_state_returns_error_instead_of_panicking() {
        let state = HotkeyState::default();
        let _ = std::panic::catch_unwind(|| {
            let _guard = state.monitor.lock().unwrap();
            panic!("simulate monitor owner panic");
        });
        assert!(stop_hotkey(&state).is_err());
    }
}

#[cfg(all(test, desktop))]
mod dictate_position_tests {
    use super::*;
    use tauri::PhysicalSize;

    #[test]
    fn overlay_placement_tracks_each_monitor_origin() {
        let monitor = PhysicalSize::new(1920, 1080);
        let window = PhysicalSize::new(420, 64);
        for (origin, expected) in [
            ((0, 0), (750, 43)),
            ((1920, 0), (2670, 43)),
            ((-1920, 0), (-1170, 43)),
            ((0, -1080), (750, -1037)),
            ((-1920, -1080), (-1170, -1037)),
            ((320, 1440), (1070, 1483)),
        ] {
            let actual =
                dictate_window_position(PhysicalPosition::new(origin.0, origin.1), monitor, window);
            assert_eq!((actual.x, actual.y), expected, "monitor origin {origin:?}");
        }
    }

    #[test]
    fn overlay_is_centered_for_a_wider_window() {
        let actual = dictate_window_position(
            PhysicalPosition::new(-1280, 100),
            PhysicalSize::new(320, 600),
            PhysicalSize::new(420, 64),
        );
        assert_eq!((actual.x, actual.y), (-1330, 124));
    }

    #[test]
    fn large_display_values_do_not_overflow() {
        let actual = dictate_window_position(
            PhysicalPosition::new(i32::MAX, i32::MAX),
            PhysicalSize::new(u32::MAX, u32::MAX),
            PhysicalSize::new(0, 0),
        );
        assert_eq!((actual.x, actual.y), (i32::MAX, i32::MAX));
        let actual = dictate_window_position(
            PhysicalPosition::new(i32::MIN, 0),
            PhysicalSize::new(0, 0),
            PhysicalSize::new(u32::MAX, 0),
        );
        assert_eq!((actual.x, actual.y), (i32::MIN, 0));
    }
}

#[cfg(test)]
mod backend_override_integrity_tests {
    use super::*;
    use std::io::{self, Read};
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "voicebox-backend-integrity-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    struct InterruptedWrite(bool);
    impl Read for InterruptedWrite {
        fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
            if !self.0 {
                self.0 = true;
                output[..2].copy_from_slice(b"cp");
                Ok(2)
            } else {
                Err(io::Error::new(
                    io::ErrorKind::Other,
                    "simulated read failure",
                ))
            }
        }
    }

    #[test]
    fn failed_update_preserves_previous_backend_choice() {
        let fixture = Fixture::new();
        write_persisted_backend_override(&fixture.0, Some("cuda")).unwrap();
        assert!(write_backend_override_from(&fixture.0, InterruptedWrite(false)).is_err());
        assert_eq!(
            read_persisted_backend_override(&fixture.0).as_deref(),
            Some("cuda")
        );
        assert_eq!(std::fs::read_dir(&fixture.0).unwrap().count(), 1);
    }

    #[test]
    fn failed_first_write_does_not_leave_partial_choice() {
        let fixture = Fixture::new();
        assert!(write_backend_override_from(&fixture.0, InterruptedWrite(false)).is_err());
        assert!(!backend_override_file(&fixture.0).exists());
        assert_eq!(std::fs::read_dir(&fixture.0).unwrap().count(), 0);
    }

    #[test]
    fn invalid_choices_cannot_change_memory_or_disk() {
        let fixture = Fixture::new();
        let state = Mutex::new(None);
        save_backend_override(&fixture.0, &state, Some("cuda".into())).unwrap();
        for invalid in ["", "auto", "GPU", "cuda\nrocm", " cpu ", "../../cpu"] {
            assert!(
                save_backend_override(&fixture.0, &state, Some(invalid.into())).is_err(),
                "invalid choice {invalid:?}"
            );
            assert_eq!(state.lock().unwrap().as_deref(), Some("cuda"));
            assert_eq!(
                read_persisted_backend_override(&fixture.0).as_deref(),
                Some("cuda")
            );
        }
    }

    #[test]
    fn failed_update_can_be_retried_and_then_reset() {
        let fixture = Fixture::new();
        let state = Mutex::new(None);
        save_backend_override(&fixture.0, &state, Some("cuda".into())).unwrap();
        assert!(write_backend_override_from(&fixture.0, InterruptedWrite(false)).is_err());
        assert_eq!(state.lock().unwrap().as_deref(), Some("cuda"));
        assert_eq!(
            read_persisted_backend_override(&fixture.0).as_deref(),
            Some("cuda")
        );
        save_backend_override(&fixture.0, &state, Some("cpu".into())).unwrap();
        assert_eq!(state.lock().unwrap().as_deref(), Some("cpu"));
        assert_eq!(
            read_persisted_backend_override(&fixture.0).as_deref(),
            Some("cpu")
        );
        save_backend_override(&fixture.0, &state, None).unwrap();
        assert!(state.lock().unwrap().is_none());
        assert!(!backend_override_file(&fixture.0).exists());
        assert_eq!(std::fs::read_dir(&fixture.0).unwrap().count(), 0);
    }
}
