import { useSyncExternalStore } from 'react';
import type { AudioMeter } from './meters';

const width = (db: number) => `${Math.min(100, Math.max(0, ((db + 60) / 60) * 100))}%`;
export function AudioMeters({ meter }: { meter: AudioMeter }) {
  const state = useSyncExternalStore(meter.subscribe, meter.getSnapshot);
  const active = state.status === 'active';
  return (
    <fieldset className="studio-meters" aria-label="Stereo sample peak meters">
      <div className="studio-meter-heading">
        <span>Sample peak</span>
        <span>
          {active
            ? 'dBFS'
            : state.status === 'idle'
              ? 'Stopped'
              : state.status === 'suspended'
                ? 'Hidden'
                : 'Unavailable'}
        </span>
      </div>
      {state.channels.map((channel, index) => (
        <div className="studio-meter-channel" key={index === 0 ? 'left' : 'right'}>
          <span>{index === 0 ? 'L' : 'R'}</span>
          {/* biome-ignore lint/a11y/useSemanticElements: native meter rendering cannot layer a peak-hold marker. */}
          <div
            className="studio-meter-track"
            role="meter"
            aria-label={`${index === 0 ? 'Left' : 'Right'} sample peak`}
            aria-valuemin={-60}
            aria-valuemax={0}
            aria-valuenow={Math.min(0, channel.db)}
            aria-valuetext={
              active
                ? `${channel.db <= -60 ? 'Below -60' : channel.db.toFixed(1)} dBFS`
                : state.status
            }
          >
            <span
              className="studio-meter-fill"
              style={{
                transform: `scaleX(${active ? Math.min(1, Math.max(0, (channel.db + 60) / 60)) : 0})`,
              }}
            />
            {active && (
              <span className="studio-meter-hold" style={{ left: width(channel.holdDb) }} />
            )}
          </div>
          <span
            className="studio-meter-clip"
            data-clipped={channel.clipped}
            title="Sample peak reached 0 dBFS; resets on stop"
          >
            {channel.clipped ? 'CLIP' : '·'}
          </span>
        </div>
      ))}
    </fieldset>
  );
}
