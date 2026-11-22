//! Rust-side subscriber for the backend `/events/speak` SSE stream.
//!
//! Owns the pill-window lifecycle for agent-initiated speech. The dictate
//! webview used to do this itself via `EventSource`, but hidden WebKit
//! windows on macOS throttle long-lived network connections, so speak events
//! never reached the pill. Tauri's event bus, on the other hand, reliably
//! delivers events to hidden webviews (the chord path proves it), so we
//! subscribe here and fan out via `emit`.
//!
//! Flow:
//!   backend speak-start → show dictate window + emit("dictate:speak-start")
//!   backend speak-end   → emit("dictate:speak-end")
//! The pill webview handles the rest (audio playback, then emits
//! `dictate:hide` back to Rust when the audio element's `ended` fires).
//!
//! Reconnect policy: idle-timeout + escalating backoff. The stream is
//! infinite by design, so a successful round means "we were receiving
//! frames and then the backend closed the connection" (typically a
//! server restart) — reset backoff and reconnect quickly. A failure or
//! a round that produced no frames escalates backoff up to a 30 s cap so
//! long-term outages stop filling stderr with reconnect log lines.
//!
//! The idle timeout guards against the worst silent-failure mode: a
//! backend that accepts the TCP connection but stops producing frames
//! (deadlocked SSE endpoint, zombie process). Without a timeout the
//! `chunk().await` blocks forever and the task never notices. The
//! backend emits a `:ping` comment every 15 s, so 45 s without any data
//! is a reliable signal the stream is dead.

use std::time::Duration;

use tauri::{AppHandle, Emitter};

use crate::{ensure_dictate_window, SERVER_PORT};

const INITIAL_BACKOFF: Duration = Duration::from_millis(500);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// Backend emits a `:ping` heartbeat every 15 s. Giving the stream 45 s
/// of idle budget absorbs one missed heartbeat (slow GC pause, brief
/// backend stall) without being so long that a truly dead stream blocks
/// the pill from surfacing for minutes.
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(45);

pub fn spawn_speak_monitor(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        run(app).await;
    });
}

async fn run(app: AppHandle) {
    let url = format!("http://127.0.0.1:{}/events/speak", SERVER_PORT);
    let client = match reqwest::Client::builder().build() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("speak_monitor: failed to build HTTP client: {e}");
            return;
        }
    };

    let mut backoff = INITIAL_BACKOFF;
    let mut attempt: u32 = 0;

    loop {
        let stream_result = stream_once(&client, &url, &app).await;
        let had_success = matches!(stream_result, Ok(true));

        if had_success {
            backoff = INITIAL_BACKOFF;
            attempt = 0;
        } else {
            attempt += 1;
            let reason = match stream_result {
                Ok(_) => "stream closed without data".to_string(),
                Err(e) => format!("stream err: {e}"),
            };
            eprintln!(
                "speak_monitor: {reason} (attempt {attempt}, retry in {:?})",
                backoff
            );
        }

        tokio::time::sleep(backoff).await;
        if !had_success {
            backoff = (backoff * 2).min(MAX_BACKOFF);
        }
    }
}

/// Consume the SSE stream until it closes or errors. Returns `Ok(true)`
/// if at least one frame was received (the connection was genuinely
/// productive), `Ok(false)` on a clean but empty close, and `Err` for
/// any connection or parse failure.
async fn stream_once(
    client: &reqwest::Client,
    url: &str,
    app: &AppHandle,
) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    let mut resp = client
        .get(url)
        .header("Accept", "text/event-stream")
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(format!("speak_monitor: backend returned {}", resp.status()).into());
    }
    let mut raw_buf: Vec<u8> = Vec::new();
    let mut saw_data = false;
    loop {
        let chunk = match tokio::time::timeout(STREAM_IDLE_TIMEOUT, resp.chunk()).await {
            Ok(Ok(Some(chunk))) => chunk,
            Ok(Ok(None)) => return Ok(saw_data),
            Ok(Err(e)) => return Err(Box::new(e)),
            Err(_) => {
                return Err(format!(
                    "no data for {:?} (heartbeat should arrive every 15 s)",
                    STREAM_IDLE_TIMEOUT
                )
                .into())
            }
        };
        saw_data = true;
        raw_buf.extend_from_slice(&chunk);
        // Frame on raw ASCII delimiters (\r\n\r\n or \n\n) before UTF-8 decoding
        // so multi-byte UTF-8 sequences split across TCP chunks never error.
        for frame_bytes in drain_sse_frames(&mut raw_buf) {
            let frame = String::from_utf8_lossy(&frame_bytes);
            if let Some((event, data)) = parse_frame(&frame) {
                dispatch(app, &event, &data);
            }
        }
    }
}

/// Drain all complete SSE frames (delimited by `\r\n\r\n` or `\n\n`) from a raw
/// byte buffer, leaving any partial frame bytes intact for the next TCP chunk.
fn drain_sse_frames(buf: &mut Vec<u8>) -> Vec<Vec<u8>> {
    let mut frames = Vec::new();
    loop {
        let crlf = buf.windows(4).position(|w| w == b"\r\n\r\n");
        let lf = buf.windows(2).position(|w| w == b"\n\n");
        let (end, sep_len) = match (crlf, lf) {
            (Some(c), Some(l)) if c <= l => (c, 4),
            (Some(c), None) => (c, 4),
            (_, Some(l)) => (l, 2),
            (None, None) => break,
        };
        let frame = buf.drain(..end + sep_len).take(end).collect();
        frames.push(frame);
    }
    frames
}

/// Parse a single SSE frame into (event_name, data_json).
///
/// Returns None for comment-only frames (lines starting with `:`) and
/// for frames without a recognizable `event:` or `data:` line.
fn parse_frame(frame: &str) -> Option<(String, String)> {
    let mut event: Option<String> = None;
    let mut data_lines: Vec<&str> = Vec::new();
    for line in frame.lines() {
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        if let Some(rest) = line.strip_prefix("event:") {
            event = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("data:") {
            data_lines.push(rest.trim_start());
        }
    }
    let event = event?;
    let data = data_lines.join("\n");
    Some((event, data))
}

fn dispatch(app: &AppHandle, event: &str, data: &str) {
    match event {
        "speak-start" => {
            // Defensive for dev/restart paths where the setup-created pill
            // is not present — but don't *show* it here. The pill
            // surfaces itself from `audio.onplaying` via `dictate:show`, so
            // users never see the empty-silent generation window.
            ensure_dictate_window(app);
            let _ = app.emit("dictate:speak-start", data.to_string());
        }
        "speak-end" => {
            let _ = app.emit("dictate:speak-end", data.to_string());
        }
        // `ready` and `ping` are heartbeats; ignore.
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drain_sse_frames_preserves_multibyte_utf8_split_across_chunks() {
        let full = "event: speak-start\r\ndata: {\"profile_name\":\"日本語🎙️\"}\r\n\r\n";
        let bytes = full.as_bytes();
        // Split right in the middle of the multi-byte UTF-8 sequence for "本".
        let split_at = full.find('本').unwrap() + 1;
        let mut buf = Vec::new();

        buf.extend_from_slice(&bytes[..split_at]);
        assert!(drain_sse_frames(&mut buf).is_empty());

        buf.extend_from_slice(&bytes[split_at..]);
        let frames = drain_sse_frames(&mut buf);
        assert_eq!(frames.len(), 1);
        assert!(buf.is_empty());

        let text = String::from_utf8(frames[0].clone()).expect("valid UTF-8");
        let (event, data) = parse_frame(&text).expect("parsed SSE frame");
        assert_eq!(event, "speak-start");
        assert_eq!(data, "{\"profile_name\":\"日本語🎙️\"}");
    }

    #[test]
    fn drain_sse_frames_handles_lf_and_ignores_comment_frames() {
        let mut buf = b": heartbeat\n\nevent: speak-end\ndata: {\"id\":\"1\"}\n\n".to_vec();
        let frames = drain_sse_frames(&mut buf);
        assert_eq!(frames.len(), 2);
        assert!(parse_frame(&String::from_utf8_lossy(&frames[0])).is_none());
        assert_eq!(
            parse_frame(&String::from_utf8_lossy(&frames[1])),
            Some(("speak-end".to_string(), "{\"id\":\"1\"}".to_string()))
        );
    }
}
