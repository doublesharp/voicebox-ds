// NOTE: This test requires system audio to be playing during execution.
// To run this test successfully:
//   1. Start playing audio (music, video, etc.)
//   2. Run: cargo test --test audio_capture_test -- --nocapture
//   3. The test will capture audio for 5 seconds and verify the output

use base64::Engine;
use voicebox::audio_capture::{start_capture, stop_capture, AudioCaptureState};

#[tokio::test]
#[ignore = "requires live system audio playback and macOS Screen Recording permission"]
async fn test_system_audio_capture() {
    // Create AudioCaptureState
    let state = AudioCaptureState::new();

    println!("Starting system audio capture with 5 second max duration...");

    // Start capture with 5 second max duration
    let result = start_capture(&state, 5).await;

    if let Err(e) = result {
        panic!("Failed to start capture: {}", e);
    }

    #[cfg(target_os = "macos")]
    assert!(
        start_capture(&state, 5).await.is_err(),
        "a second capture must not replace an active capture"
    );

    println!("Capture started, waiting 5 seconds...");

    // Wait 5 seconds for capture to complete
    tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;

    println!("Stopping capture...");

    // Stop capture and get the result
    #[cfg(target_os = "macos")]
    let (audio_data, overlap) = tokio::join!(stop_capture(&state), async {
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
        start_capture(&state, 5).await
    });
    #[cfg(target_os = "macos")]
    assert!(
        overlap.is_err(),
        "a new capture must wait until stop collects the recording"
    );
    #[cfg(not(target_os = "macos"))]
    let audio_data = stop_capture(&state).await;

    match audio_data {
        Ok(base64_wav) => {
            println!("Capture stopped successfully");

            // Validate the returned base64 WAV data
            println!("Validating base64 WAV data...");

            // Decode base64 to bytes
            let decoded_bytes = base64::engine::general_purpose::STANDARD
                .decode(&base64_wav)
                .expect("Failed to decode base64 data");

            // Verify bytes array is not empty
            assert!(!decoded_bytes.is_empty(), "Decoded bytes array is empty");

            // Confirm data has content (length > 0)
            println!("WAV data length: {} bytes", decoded_bytes.len());
            assert!(decoded_bytes.len() > 0, "WAV data has no content");

            println!("✓ Test passed: Audio capture produced valid WAV data");
        }
        Err(e) => {
            panic!("Failed to stop capture or get audio data: {}", e);
        }
    }
    #[cfg(target_os = "macos")]
    {
        start_capture(&state, 2)
            .await
            .expect("capture should restart after stop");
        tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
        let second = stop_capture(&state)
            .await
            .expect("restarted capture should stop");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(second)
            .unwrap();
        assert!(!decoded.is_empty());
    }
}

#[cfg(target_os = "macos")]
mod native_silent_lifecycle_tests {
    use super::*;
    use std::process::{Child, Command, Stdio};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    struct SilentPlayback {
        child: Child,
        dir: std::path::PathBuf,
    }

    impl SilentPlayback {
        fn start() -> Self {
            let root = std::env::var_os("VOICEBOX_AUDIO_FIXTURE_DIR")
                .expect("set VOICEBOX_AUDIO_FIXTURE_DIR to a task-owned Scratch directory");
            let dir = std::path::PathBuf::from(root).join(format!(
                "native-capture-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join("silence.wav");
            {
                let spec = hound::WavSpec {
                    channels: 1,
                    sample_rate: 16000,
                    bits_per_sample: 16,
                    sample_format: hound::SampleFormat::Int,
                };
                let mut writer = hound::WavWriter::create(&path, spec).unwrap();
                for _ in 0..(16000 * 8) {
                    writer.write_sample(0_i16).unwrap();
                }
                writer.finalize().unwrap();
            }
            let child = Command::new("/usr/bin/afplay")
                .arg(&path)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("native silent playback must start");
            Self { child, dir }
        }
    }

    impl Drop for SilentPlayback {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    async fn wait_for_samples(state: &AudioCaptureState) {
        tokio::time::timeout(Duration::from_secs(4), async {
            while state.samples.lock().unwrap().is_empty() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("silent system audio did not reach the capture callback");
    }

    fn assert_recording(encoded: &str) {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        let reader = hound::WavReader::new(std::io::Cursor::new(bytes)).unwrap();
        assert_eq!(
            (reader.spec().sample_rate, reader.spec().channels),
            (48000, 2)
        );
        assert!(reader.duration() > 0, "recording must contain audio frames");
    }

    #[tokio::test]
    #[ignore = "requires macOS screen capture permission and a working output device"]
    async fn automatic_timeout_stops_callbacks_and_manual_stop_collects_audio() {
        let _playback = SilentPlayback::start();
        let state = AudioCaptureState::new();
        start_capture(&state, 2).await.unwrap();
        wait_for_samples(&state).await;
        tokio::time::sleep(Duration::from_millis(2400)).await;
        let count_after_timeout = state.samples.lock().unwrap().len();
        assert!(count_after_timeout > 0);
        tokio::time::sleep(Duration::from_millis(350)).await;
        assert_eq!(
            state.samples.lock().unwrap().len(),
            count_after_timeout,
            "audio callbacks continued after timeout"
        );
        assert_recording(&stop_capture(&state).await.unwrap());
    }

    #[tokio::test]
    #[ignore = "requires macOS screen capture permission and a working output device"]
    async fn manual_stop_collects_audio_and_capture_can_restart() {
        let _playback = SilentPlayback::start();
        let state = AudioCaptureState::new();
        for _ in 0..2 {
            start_capture(&state, 5).await.unwrap();
            wait_for_samples(&state).await;
            assert_recording(&stop_capture(&state).await.unwrap());
        }
    }
    #[tokio::test]
    #[ignore = "requires macOS screen capture permission and a working output device"]
    async fn an_old_timeout_cannot_stop_a_replacement_capture() {
        let _playback = SilentPlayback::start();
        let state = AudioCaptureState::new();
        start_capture(&state, 2).await.unwrap();
        wait_for_samples(&state).await;
        assert_recording(&stop_capture(&state).await.unwrap());
        start_capture(&state, 5).await.unwrap();
        wait_for_samples(&state).await;
        tokio::time::sleep(Duration::from_millis(1800)).await;
        let before = state.samples.lock().unwrap().len();
        tokio::time::sleep(Duration::from_millis(400)).await;
        let after = state.samples.lock().unwrap().len();
        assert!(after > before, "old capture timer stopped its replacement");
        assert_recording(&stop_capture(&state).await.unwrap());
    }

    #[tokio::test]
    #[ignore = "requires macOS screen capture permission and a working output device"]
    async fn overlapping_stops_return_one_recording_and_allow_restart() {
        let _playback = SilentPlayback::start();
        let state = AudioCaptureState::new();
        start_capture(&state, 5).await.unwrap();
        wait_for_samples(&state).await;
        let (first, second) = tokio::join!(stop_capture(&state), stop_capture(&state));
        let recording = first.expect("first stop must collect the recording");
        assert!(second.unwrap_err().contains("starting or stopping"));
        assert_recording(&recording);
        start_capture(&state, 5).await.unwrap();
        wait_for_samples(&state).await;
        assert_recording(&stop_capture(&state).await.unwrap());
    }
}
