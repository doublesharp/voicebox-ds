import { useCallback, useEffect, useRef, useState } from 'react';
import { convertToWav } from '@/lib/utils/audio';
import {
  type MicrophoneProcessing,
  isMicrophonePermissionDenied,
  microphoneErrorMessage,
  requestMicrophone,
} from '@/lib/utils/microphone';
import { usePlatform } from '@/platform/PlatformContext';
import { useMicrophoneStore } from '@/stores/microphoneStore';

interface UseAudioRecordingOptions {
  maxDurationSeconds?: number;
  /** undefined uses the saved input; null explicitly chooses the system default. */
  deviceId?: string | null;
  /** Clean capture only disables requested browser processing; codecs are unchanged. */
  processing?: MicrophoneProcessing;
  onRecordingComplete?: (blob: Blob, duration?: number) => void;
}

interface RecordingSession {
  controller: AbortController;
  recorder: MediaRecorder | null;
  stream: MediaStream | null;
  chunks: Blob[];
  timer: number | null;
  startedAt: number | null;
  stoppedAt: number | null;
  cancelled: boolean;
}

function releaseStream(session: RecordingSession) {
  const stream = session.stream;
  session.stream = null;
  stream?.getTracks().forEach((track) => {
    track.stop();
  });
}

function clearSessionTimer(session: RecordingSession) {
  if (session.timer !== null) {
    clearInterval(session.timer);
    session.timer = null;
  }
}

export function useAudioRecording({
  maxDurationSeconds,
  deviceId,
  processing = 'processed',
  onRecordingComplete,
}: UseAudioRecordingOptions = {}) {
  const platform = usePlatform();
  const [isRecording, setIsRecording] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [audioStream, setAudioStream] = useState<MediaStream | null>(null);
  const [duration, setDuration] = useState(0);
  const [usingDefaultMicrophone, setUsingDefaultMicrophone] = useState(false);
  const [failure, setFailure] = useState<{ message: string; permissionDenied: boolean } | null>(
    null,
  );
  const currentRef = useRef<RecordingSession | null>(null);
  const sessionsRef = useRef(new Set<RecordingSession>());

  const startRecording = useCallback(async () => {
    const current = currentRef.current;
    if (
      current &&
      !current.cancelled &&
      (!current.recorder || current.recorder.state !== 'inactive')
    )
      return;
    const session: RecordingSession = {
      controller: new AbortController(),
      recorder: null,
      stream: null,
      chunks: [],
      timer: null,
      startedAt: null,
      stoppedAt: null,
      cancelled: false,
    };
    currentRef.current = session;
    sessionsRef.current.add(session);
    setIsStarting(true);
    setFailure(null);
    setUsingDefaultMicrophone(false);
    setDuration(0);

    try {
      if (typeof navigator === 'undefined') {
        throw new Error(
          'Navigator API is not available. This might be a Tauri configuration issue.',
        );
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        // Tauri's webview may expose media devices shortly after initialization.
        await new Promise((resolve) => setTimeout(resolve, 100));
        session.controller.signal.throwIfAborted();
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          const errorMsg = platform.metadata.isTauri
            ? 'Microphone access is not available. Please ensure:\n1. The app has microphone permissions in System Settings (macOS: System Settings > Privacy & Security > Microphone)\n2. You restart the app after granting permissions\n3. You are using Tauri v2 with a webview that supports getUserMedia'
            : 'Microphone access is not available. Please ensure you are using a secure context (HTTPS or localhost) and that your browser has microphone permissions enabled.';
          throw new Error(errorMsg);
        }
      }

      const stream = await requestMicrophone(
        navigator.mediaDevices,
        deviceId !== undefined ? deviceId : useMicrophoneStore.getState().deviceId,
        session.controller.signal,
        () => {
          if (!session.cancelled && currentRef.current === session) setUsingDefaultMicrophone(true);
        },
        processing,
      );
      if (session.cancelled || currentRef.current !== session) {
        stream.getTracks().forEach((track) => {
          track.stop();
        });
        return;
      }
      session.stream = stream;
      setAudioStream(stream);
      const options: MediaRecorderOptions = { mimeType: 'audio/webm;codecs=opus' };
      if (!MediaRecorder.isTypeSupported(options.mimeType!)) delete options.mimeType;
      const recorder = new MediaRecorder(stream, options);
      session.recorder = recorder;

      recorder.ondataavailable = (event) => {
        if (!session.cancelled && event.data.size > 0) session.chunks.push(event.data);
      };
      recorder.onstop = async () => {
        const recordedDuration =
          session.startedAt === null
            ? undefined
            : Math.max(0, (session.stoppedAt ?? Date.now()) - session.startedAt) / 1000;
        const webmBlob = new Blob(session.chunks, {
          type: recorder.mimeType || options.mimeType || 'audio/webm',
        });
        session.chunks = [];
        releaseStream(session);
        clearSessionTimer(session);
        if (currentRef.current === session) {
          setAudioStream(null);
          setIsRecording(false);
        }
        try {
          if (session.cancelled) return;
          let result: Blob;
          try {
            result = await convertToWav(webmBlob);
          } catch (err) {
            console.error('Error converting audio to WAV:', err);
            result = webmBlob;
          }
          if (!session.cancelled) onRecordingComplete?.(result, recordedDuration);
        } finally {
          sessionsRef.current.delete(session);
          if (currentRef.current === session) currentRef.current = null;
        }
      };
      recorder.onerror = (event) => {
        if (session.cancelled) return;
        session.cancelled = true;
        session.controller.abort();
        session.chunks = [];
        if (currentRef.current === session) {
          currentRef.current = null;
          setFailure({ message: 'Recording error occurred', permissionDenied: false });
          setIsStarting(false);
          setIsRecording(false);
          setAudioStream(null);
          console.error('MediaRecorder error:', event);
        }
        try {
          if (recorder.state !== 'inactive') recorder.stop();
        } catch (err) {
          console.error('Unable to stop failed recorder:', err);
        }
        releaseStream(session);
        clearSessionTimer(session);
        sessionsRef.current.delete(session);
      };

      // A single final chunk preserves the WebM header in WebKit.
      recorder.start();
      if (session.cancelled || currentRef.current !== session) return;
      session.startedAt = Date.now();
      setIsRecording(true);
      session.timer = window.setInterval(() => {
        if (session.startedAt === null || session.cancelled || currentRef.current !== session)
          return;
        const elapsed = (Date.now() - session.startedAt) / 1000;
        setDuration(elapsed);
        if (
          maxDurationSeconds !== undefined &&
          elapsed >= maxDurationSeconds &&
          recorder.state !== 'inactive'
        ) {
          session.stoppedAt = Date.now();
          recorder.stop();
          setIsRecording(false);
          clearSessionTimer(session);
        }
      }, 100);
    } catch (err) {
      releaseStream(session);
      clearSessionTimer(session);
      sessionsRef.current.delete(session);
      if (!session.cancelled && currentRef.current === session) {
        currentRef.current = null;
        setIsStarting(false);
        setAudioStream(null);
        setFailure({
          message: microphoneErrorMessage(err),
          permissionDenied: isMicrophonePermissionDenied(err),
        });
        setIsRecording(false);
      }
    } finally {
      if (currentRef.current === session) setIsStarting(false);
    }
  }, [deviceId, maxDurationSeconds, onRecordingComplete, platform.metadata.isTauri, processing]);

  const cancelRecording = useCallback(() => {
    setFailure(null);
    const session = currentRef.current;
    if (!session) return;
    session.cancelled = true;
    session.controller.abort();
    session.chunks = [];
    if (session.recorder && session.recorder.state !== 'inactive') session.recorder.stop();
    releaseStream(session);
    clearSessionTimer(session);
    sessionsRef.current.delete(session);
    currentRef.current = null;
    setIsStarting(false);
    setIsRecording(false);
    setDuration(0);
    setAudioStream(null);
  }, []);

  // Return true when a pending microphone request was cancelled before a
  // recorder existed; callers can clear any provisional recording UI.
  const stopRecording = useCallback((): boolean => {
    const session = currentRef.current;
    if (!session) return false;
    if (!session.recorder) {
      cancelRecording();
      return true;
    }
    if (session.recorder.state === 'inactive') return false;
    session.stoppedAt = Date.now();
    session.recorder.stop();
    setIsRecording(false);
    clearSessionTimer(session);
    return false;
  }, [cancelRecording]);

  useEffect(
    () => () => {
      for (const session of sessionsRef.current) {
        session.cancelled = true;
        session.controller.abort();
        if (session.recorder && session.recorder.state !== 'inactive') session.recorder.stop();
        releaseStream(session);
        clearSessionTimer(session);
      }
      sessionsRef.current.clear();
      currentRef.current = null;
    },
    [],
  );

  return {
    isRecording,
    isStarting,
    audioStream,
    usingDefaultMicrophone,
    duration,
    error: failure?.message ?? null,
    permissionDenied: failure?.permissionDenied ?? false,
    startRecording,
    stopRecording,
    cancelRecording,
  };
}
