import { Headphones, Pause, Play } from 'lucide-react';
import { useMemo, useSyncExternalStore } from 'react';
import { Input } from '@/components/ui/input';
import { AudioMeters } from './AudioMeters';
import { useStudio, useStudioPlayhead } from './context';
import { formatTime, timelineEnd } from './domain';
import { Field, StudioButton } from './ui';

/** Only transport controls subscribe to the full playback clock. */
export function StudioTransport({
  toggleTransport,
  hideWhenIdle = false,
}: {
  toggleTransport: () => void;
  hideWhenIdle?: boolean;
}) {
  const { playback, project, setPlayhead } = useStudio();
  const audio = useSyncExternalStore(playback.subscribe, playback.getSnapshot);
  const playhead = useStudioPlayhead();
  const duration = useMemo(
    () => timelineEnd(project.document, project.assets) / project.document.sample_rate,
    [project.document, project.assets],
  );
  return (
    <>
      {(!hideWhenIdle || audio.mode !== 'idle') && (
        <footer className="studio-transport">
          <div className="studio-transport-controls">
            <StudioButton
              primary
              onClick={toggleTransport}
              disabled={!project.document.clips.length && audio.mode === 'idle'}
            >
              {audio.mode === 'loading' ? (
                'Cancel load'
              ) : audio.mode !== 'idle' ? (
                <>
                  <Pause size={15} /> Stop
                </>
              ) : (
                <>
                  <Play size={15} /> Play
                </>
              )}
            </StudioButton>
            <div className="studio-transport-time">
              <span className="studio-mono">{formatTime(playhead)}</span>
              <small>/ {formatTime(duration)}</small>
            </div>
            <Field label="Playhead (s)">
              <Input
                aria-label="Playhead seconds"
                type="number"
                value={Number(playhead.toFixed(3))}
                min={0}
                step={0.01}
                onChange={(event) => {
                  const value = event.target.valueAsNumber;
                  if (Number.isFinite(value) && value >= 0) {
                    setPlayhead(value);
                  }
                }}
              />
            </Field>
          </div>
          <span className="studio-transport-label">
            <Headphones size={14} aria-hidden="true" />
            <span>
              {audio.mode === 'idle'
                ? 'Source preview'
                : `${audio.label} · ${audio.mode === 'loading' ? 'Loading…' : formatTime(audio.position)}`}
            </span>
          </span>
          <AudioMeters meter={playback.meters} />
        </footer>
      )}
      {audio.error && (
        <p className="studio-playback-error" role="alert">
          {audio.error}
        </p>
      )}
    </>
  );
}
