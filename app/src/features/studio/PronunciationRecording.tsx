import { Mic, Square } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAudioRecording } from '@/lib/hooks/useAudioRecording';
import { MicrophonePermissionHelp } from '@/components/MicrophoneSelector/MicrophonePermissionHelp';
import { errorMessage } from './session';
import { StudioButton } from './ui';

export function PronunciationRecording({
  source,
  audioUrl,
  disabled,
  onStart,
  onFinish,
  onAttach,
  onRemove,
}: {
  source: string;
  audioUrl: string | undefined;
  disabled: boolean;
  onStart: () => boolean;
  onFinish: () => void;
  onAttach: (file: File) => Promise<void>;
  onRemove: () => void;
}) {
  const [recording, setRecording] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<string>();
  const [attempting, setAttempting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const recorder = useAudioRecording({
    maxDurationSeconds: 8,
    onRecordingComplete: (blob) => setRecording(blob),
  });

  useEffect(() => {
    if (!recording) {
      setPreview(undefined);
      return;
    }
    const url = URL.createObjectURL(recording);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [recording]);

  const start = () => {
    if (!onStart()) return;
    setAttempting(true);
    setRecording(null);
    setSaveError('');
    void recorder.startRecording();
  };

  const attach = async () => {
    if (!recording || saving) return;
    setSaving(true);
    setSaveError('');
    try {
      await onAttach(new File([recording], 'pronunciation.wav', { type: recording.type }));
      setRecording(null);
      setAttempting(false);
      onFinish();
    } catch (error) {
      setSaveError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    recorder.cancelRecording();
    setRecording(null);
    setAttempting(false);
    setSaveError('');
    onFinish();
  };

  const player = preview ?? audioUrl;
  const recordingError = attempting ? recorder.error : null;
  return (
    <div className="studio-pronunciation-recording">
      {player && (
        <audio aria-label={`Pronunciation recording for ${source}`} controls preload="metadata" src={player} />
      )}
      <div className="studio-action-row">
        {recorder.isRecording ? (
          <StudioButton onClick={recorder.stopRecording}>
            <Square size={13} /> Stop recording
          </StudioButton>
        ) : recording ? (
          <StudioButton disabled={disabled || saving} onClick={() => void attach()}>
            {saving ? 'Attaching…' : 'Use recording'}
          </StudioButton>
        ) : (
          <StudioButton
            disabled={disabled || !source.trim() || (attempting && !recordingError)}
            onClick={start}
          >
            <Mic size={14} />
            {recorder.isStarting ? 'Opening microphone…' : attempting && !recordingError ? 'Preparing recording…' : audioUrl ? 'Record again' : 'Record pronunciation'}
          </StudioButton>
        )}
        {attempting ? (
          <StudioButton disabled={saving} onClick={cancel}>Cancel recording</StudioButton>
        ) : audioUrl ? (
          <StudioButton disabled={disabled} onClick={onRemove}>Remove recording</StudioButton>
        ) : null}
      </div>
      {recorder.isRecording && <p className="studio-note">Say “{source}” naturally.</p>}
      {recordingError && recorder.permissionDenied ? (
        <MicrophonePermissionHelp />
      ) : (recordingError || saveError) && (
        <p className="studio-error" role="alert">{recordingError || saveError}</p>
      )}
    </div>
  );
}
