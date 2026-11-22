use crate::publication::publish;
use serde::{Deserialize, Serialize};
use std::io::{self, Read};
use std::path::Path;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

#[derive(Deserialize)]
pub struct FileFilter {
    name: String,
    extensions: Vec<String>,
}
#[derive(Serialize)]
pub struct SaveResult {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
}

fn choose(
    app: &AppHandle,
    filename: &str,
    filters: &[FileFilter],
) -> Result<Option<PathBuf>, String> {
    let name = Path::new(filename)
        .file_name()
        .and_then(|v| v.to_str())
        .filter(|v| !v.is_empty())
        .ok_or("Invalid filename")?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let name_path = Path::new(name);
    let stem = name_path
        .file_stem()
        .and_then(|v| v.to_str())
        .unwrap_or("export");
    let ext = name_path
        .extension()
        .and_then(|v| v.to_str())
        .map(|v| format!(".{v}"))
        .unwrap_or_default();
    let mut dialog = app
        .dialog()
        .file()
        .set_file_name(format!("{stem}-{stamp}{ext}"));
    for filter in filters {
        let extensions: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
        dialog = dialog.add_filter(&filter.name, &extensions);
    }
    dialog
        .blocking_save_file()
        .map(|p| p.into_path().map_err(|e| e.to_string()))
        .transpose()
}

fn run(
    app: AppHandle,
    filename: String,
    filters: Vec<FileFilter>,
    input: impl FnOnce() -> Result<Box<dyn Read>, String>,
) -> Result<SaveResult, String> {
    let Some(path) = choose(&app, &filename, &filters)? else {
        return Ok(SaveResult {
            status: "cancelled",
            path: None,
        });
    };
    let reader = input()?;
    publish(&path, reader).map_err(|e| format!("Could not save {}: {e}", path.display()))?;
    Ok(SaveResult {
        status: "saved",
        path: Some(path.to_string_lossy().into_owned()),
    })
}

#[tauri::command]
pub async fn publish_file_bytes(
    app: AppHandle,
    filename: String,
    filters: Vec<FileFilter>,
    bytes: Vec<u8>,
) -> Result<SaveResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run(app, filename, filters, || {
            Ok(Box::new(io::Cursor::new(bytes)))
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn publish_file_url(
    app: AppHandle,
    filename: String,
    filters: Vec<FileFilter>,
    url: String,
) -> Result<SaveResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run(app, filename, filters, || {
            let parsed =
                reqwest::Url::parse(&url).map_err(|e| format!("Invalid download URL: {e}"))?;
            if !matches!(parsed.scheme(), "http" | "https") {
                return Err("Only HTTP(S) download URLs are supported".into());
            }
            let client = reqwest::blocking::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(std::time::Duration::from_secs(15))
                .timeout(std::time::Duration::from_secs(300))
                .build()
                .map_err(|e| e.to_string())?;
            let response = client
                .get(parsed)
                .send()
                .map_err(|e| format!("Download failed: {e}"))?;
            if !response.status().is_success() {
                return Err(format!("Download failed: HTTP {}", response.status()));
            }
            Ok(Box::new(response))
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
