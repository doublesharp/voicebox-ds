import { Copy, Plus, Scissors, Trash2 } from 'lucide-react';
import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { EffectsChainEditor } from '@/components/Effects/EffectsChainEditor';
import { Input } from '@/components/ui/input';
import { readStudioPlayhead, useStudio, useStudioPlayhead } from './context';
import { clipFrames, formatTime, timelineEnd, toSamples } from './domain';
import type { StudioClip } from './types';
import { Field, NumberField, StudioButton } from './ui';
import { Waveform } from './Waveform';
import './waveforms.css';

export function Timeline({ compact = false }: { compact?: boolean }) {
  const studio = useStudio();
  const { project, session, canMutate } = studio;
  const [gap, setGap] = useState(200);
  const [mediaKind, setMediaKind] = useState<'music' | 'sfx'>('music');
  const importInput = useRef<HTMLInputElement>(null);
  const doc = project.document;
  const end = Math.max(timelineEnd(doc, project.assets) / doc.sample_rate, 10);
  const selectedIds = studio.checkedPassages.length
    ? doc.passages.filter((p) => studio.checkedPassages.includes(p.id)).map((p) => p.id)
    : studio.selectedPassageId
      ? [studio.selectedPassageId]
      : [];
  const unresolved = selectedIds.some(
    (id) => !doc.passages.find((p) => p.id === id)?.selected_take_id,
  );
  const insert = (atPlayhead: boolean) =>
    void session.command('insert_passages', {
      passage_ids: selectedIds,
      gap_ms: gap,
      ...(atPlayhead
        ? { start_sample: toSamples(readStudioPlayhead(studio), doc.sample_rate) }
        : {}),
    });
  const importAudio = (file: File) => {
    if (!canMutate || studio.actionBusy) return;
    const startSample = toSamples(readStudioPlayhead(studio), doc.sample_rate);
    void studio.runAction(async () => {
      const asset = await studio.client.uploadAsset(project.id, file);
      await session.command('insert_asset', {
        asset_id: asset.id,
        start_sample: startSample,
        kind: mediaKind,
        name: file.name,
      });
    });
  };
  return (
    <section
      className={`studio-timeline ${compact ? 'is-compact' : ''}`}
      aria-label="Timeline"
      data-studio-timeline
    >
      <div className="studio-timeline-heading">
        <div>
          <h2>Arrangement</h2>
          <p>{doc.clips.length} clips · 48 kHz stereo</p>
        </div>
        <div className="studio-action-row">
          <input
            ref={importInput}
            type="file"
            accept="audio/*"
            hidden
            aria-label="Import arrangement audio"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              importAudio(file);
            }}
          />
          <select
            aria-label="Imported audio track type"
            value={mediaKind}
            onChange={(event) => setMediaKind(event.target.value as 'music' | 'sfx')}
          >
            <option value="music">Music</option>
            <option value="sfx">Sound effect</option>
          </select>
          <StudioButton
            disabled={!canMutate || studio.actionBusy}
            onClick={() => importInput.current?.click()}
          >
            Import audio
          </StudioButton>
          <NumberField label="Gap (ms)" value={gap} step={1} max={60000} onCommit={setGap} />
          <StudioButton
            disabled={!canMutate || !selectedIds.length || unresolved}
            onClick={() => insert(true)}
          >
            <Plus size={14} /> At playhead
          </StudioButton>
          <StudioButton
            disabled={!canMutate || !selectedIds.length || unresolved}
            onClick={() => insert(false)}
          >
            Append
          </StudioButton>
        </div>
      </div>
      {unresolved && (
        <p className="studio-note">Choose a take for every selected passage before insertion.</p>
      )}
      {!doc.clips.length && (
        <button
          type="button"
          disabled={!canMutate || studio.actionBusy}
          aria-label="Import audio into the empty arrangement"
          aria-disabled={!canMutate || studio.actionBusy}
          onClick={() => importInput.current?.click()}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            const file = event.dataTransfer.files[0];
            if (file) importAudio(file);
          }}
        >
          <span>Drop audio here, or choose an audio file.</span>
        </button>
      )}
      <div className="studio-timeline-scroll">
        <div className="studio-ruler">
          <span>TRACK / SOURCE</span>
          <div>
            {[0, 0.25, 0.5, 0.75, 1].map((fraction) => (
              <span key={fraction}>{formatTime(end * fraction)}</span>
            ))}
          </div>
        </div>
        {doc.tracks.map((track) => (
          <div className="studio-track" key={track.id}>
            <div className="studio-track-label">
              <strong>{track.name}</strong>
              <div className="studio-action-row">
                <button
                  type="button"
                  disabled={!canMutate}
                  aria-label={`Mute ${track.name}`}
                  aria-pressed={track.mute}
                  className="studio-track-toggle"
                  onClick={() =>
                    void session.command('update_track', { track_id: track.id, mute: !track.mute })
                  }
                >
                  M
                </button>
                <button
                  type="button"
                  disabled={!canMutate}
                  aria-label={`Solo ${track.name}`}
                  aria-pressed={track.solo}
                  className="studio-track-toggle"
                  onClick={() =>
                    void session.command('update_track', { track_id: track.id, solo: !track.solo })
                  }
                >
                  S
                </button>
              </div>
            </div>
            <div className="studio-track-lane">
              <TimelinePlayhead end={end} />
              {doc.clips
                .filter((clip) => clip.track_id === track.id)
                .map((clip) => {
                  const asset = project.assets.find((a) => a.id === clip.asset_id);
                  const passage = doc.passages.find((p) => p.id === clip.passage_id);
                  const duration = asset
                    ? clipFrames(clip, asset, doc.sample_rate) / doc.sample_rate
                    : 0;
                  return (
                    <button
                      type="button"
                      key={clip.id}
                      className={`studio-clip ${studio.selectedClipId === clip.id ? 'is-selected' : clip.passage_id === studio.selectedPassageId ? 'is-linked' : ''}`}
                      aria-label={`Select clip: ${passage?.text || 'Imported audio'}`}
                      aria-pressed={studio.selectedClipId === clip.id}
                      style={{
                        left: `${(clip.start_sample / doc.sample_rate / end) * 100}%`,
                        width: `${Math.max(2, (duration / end) * 100)}%`,
                      }}
                      onClick={() => studio.selectClip(clip.id)}
                    >
                      {asset && (
                        <Waveform
                          url={`${studio.client.url(`/assets/${encodeURIComponent(asset.id)}/waveform`)}?bins=2048`}
                          trimStart={clip.trim_start_sample}
                          trimEnd={clip.trim_end_sample}
                          projectRate={doc.sample_rate}
                        />
                      )}
                      <span>{passage?.text || 'Audio'}</span>
                      <small>{formatTime(duration)}</small>
                    </button>
                  );
                })}
            </div>
          </div>
        ))}
        {!doc.clips.length && (
          <div className="studio-timeline-empty">
            Your composition starts here. Select passages, choose their takes, then Append.
          </div>
        )}
      </div>
      {!compact && (
        <>
          <div className="studio-section-title">
            <h3>Precise clip placement</h3>
            <span>Seconds · rounded to project samples</span>
          </div>
          <div className="studio-clip-list">
            {doc.clips.map((clip, index) => (
              <button
                type="button"
                key={clip.id}
                className={`studio-clip-row ${studio.selectedClipId === clip.id ? 'is-selected' : clip.passage_id === studio.selectedPassageId ? 'is-linked' : ''}`}
                onClick={() => studio.selectClip(clip.id)}
              >
                <span>{String(index + 1).padStart(2, '0')}</span>
                <strong>
                  {doc.passages.find((p) => p.id === clip.passage_id)?.text || 'Imported audio'}
                </strong>
                <span>{formatTime(clip.start_sample / doc.sample_rate)}</span>
              </button>
            ))}
          </div>
          <ClipInspector />
        </>
      )}
    </section>
  );
}

function TimelinePlayhead({ end }: { end: number }) {
  const studio = useStudio();
  const playhead = useStudioPlayhead();
  const mode = useCallback(() => studio.playback.getSnapshot().mode, [studio.playback]);
  const playing = useSyncExternalStore(studio.playback.subscribe, mode) === 'timeline';
  return (
    <div
      className={`studio-playhead ${playing ? 'is-playing' : ''}`}
      style={{ transform: `translateX(${Math.min(100, (playhead / end) * 100)}%)` }}
    />
  );
}

function SplitClipButton({ clip, duration }: { clip: StudioClip; duration: number }) {
  const studio = useStudio();
  const { project, session, canMutate } = studio;
  const playhead = useStudioPlayhead();
  const canSplit =
    playhead > clip.start_sample / project.document.sample_rate &&
    playhead < clip.start_sample / project.document.sample_rate + duration;
  return (
    <StudioButton
      disabled={!canMutate || !canSplit}
      onClick={() =>
        void session.command('split_clip', {
          clip_id: clip.id,
          at_sample: toSamples(readStudioPlayhead(studio)),
        })
      }
    >
      <Scissors size={14} /> Split at playhead
    </StudioButton>
  );
}

export function ClipInspector() {
  const studio = useStudio();
  const { project, session, canMutate } = studio;
  const clip = project.document.clips.find((c) => c.id === studio.selectedClipId);
  if (!clip)
    return (
      <p className="studio-note studio-padding">
        Select a timeline clip to trim, split, move, or adjust its gain and fades.
      </p>
    );
  const asset = project.assets.find((a) => a.id === clip.asset_id);
  const duration = asset ? clipFrames(clip, asset) / project.document.sample_rate : 0;
  const update = (field: keyof StudioClip, value: number) => {
    if (clip[field] !== value)
      void session.command('update_clip', { clip_id: clip.id, [field]: value });
  };
  const numeric = (
    label: string,
    field: keyof StudioClip,
    value: number,
    samples = true,
    max?: number,
  ) => (
    <NumberField
      label={label}
      value={samples ? value / project.document.sample_rate : value}
      max={max}
      disabled={!canMutate}
      onCommit={(input) =>
        update(field, samples ? toSamples(input, project.document.sample_rate) : input)
      }
    />
  );
  return (
    <div className="studio-clip-inspector">
      <div className="studio-section-title">
        <h3>Selected clip</h3>
        <span className="studio-mono">{clip.id.slice(0, 8)}</span>
      </div>
      <p className="studio-note">
        Clean source stays intact. Source trims and fixed starts are independent of passage take
        selection.
      </p>
      <Field label="Clip track">
        <select
          value={clip.track_id}
          disabled={!canMutate}
          onChange={(event) =>
            void session.command('update_clip', { clip_id: clip.id, track_id: event.target.value })
          }
        >
          {project.document.tracks.map((track) => (
            <option key={track.id} value={track.id}>
              {track.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="studio-numeric-grid">
        {numeric('Start (s)', 'start_sample', clip.start_sample)}
        {numeric('Trim from start (s)', 'trim_start_sample', clip.trim_start_sample)}
        {numeric('Trim from end (s)', 'trim_end_sample', clip.trim_end_sample)}
        {numeric('Gain (linear)', 'gain', clip.gain, false, 16)}
        {numeric('Fade in (s)', 'fade_in_samples', clip.fade_in_samples)}
        {numeric('Fade out (s)', 'fade_out_samples', clip.fade_out_samples)}
      </div>
      <div className="studio-action-row">
        <SplitClipButton clip={clip} duration={duration} />
        <StudioButton
          disabled={!canMutate}
          onClick={() => void session.command('duplicate_clip', { clip_id: clip.id })}
        >
          <Copy size={14} /> Duplicate
        </StudioButton>
        <StudioButton
          disabled={!canMutate}
          onClick={() => void session.command('delete_clip', { clip_id: clip.id })}
        >
          <Trash2 size={14} /> Remove
        </StudioButton>
      </div>
    </div>
  );
}

export function Mixer() {
  const { project, session, canMutate } = useStudio();
  const mix = project.document.mix;
  return (
    <section className="studio-mixer" aria-label="Mixer">
      <p className="studio-eyebrow">MIX & MASTER</p>
      <h2>Give every voice its space.</h2>
      {project.document.tracks.map((track) => (
        <div className="studio-mixer-track" key={track.id}>
          <Field label="Track name">
            <Input
              key={`${track.id}:${track.name}`}
              defaultValue={track.name}
              disabled={!canMutate}
              onBlur={(event) => {
                const name = event.target.value.trim();
                if (name && name !== track.name)
                  void session.command('update_track', { track_id: track.id, name });
              }}
            />
          </Field>
          <NumberField
            label={`${track.name} gain (linear)`}
            value={track.gain}
            max={16}
            disabled={!canMutate}
            onCommit={(gain) => {
              if (gain !== track.gain)
                void session.command('update_track', { track_id: track.id, gain });
            }}
          />
          <details>
            <summary>Track effects</summary>
            <fieldset disabled={!canMutate}>
              <EffectsChainEditor
                value={track.effects_chain ?? []}
                compact
                showPresets={true}
                excludedTypes={['pitch_shift']}
                commitParametersOnRelease
                disabled={!canMutate}
                onChange={(effects_chain) =>
                  canMutate &&
                  void session.command('update_track', { track_id: track.id, effects_chain })
                }
              />
            </fieldset>
            <p className="studio-note">Pitch shifting is available in legacy Effects.</p>
          </details>
        </div>
      ))}
      <div className="studio-divider" />
      <h3>Delivery mastering</h3>
      <div className="studio-action-row">
        <StudioButton
          disabled={!canMutate}
          onClick={() =>
            void session.command('update_mix', {
              normalize: true,
              target_lufs: -14,
              max_true_peak_dbtp: -1,
              limiter: true,
            })
          }
        >
          YouTube preset (-14 LUFS / -1 dBTP)
        </StudioButton>
      </div>
      <label className="studio-check">
        <input
          type="checkbox"
          checked={mix.duck_music ?? false}
          disabled={!canMutate}
          onChange={(event) =>
            void session.command('update_mix', { duck_music: event.target.checked })
          }
        />{' '}
        Auto-duck music tracks under narration
      </label>
      {mix.duck_music && (
        <div className="studio-numeric-grid">
          <NumberField
            label="Music duck depth (dB)"
            min={-30}
            max={0}
            step={1}
            value={mix.duck_db ?? -14}
            disabled={!canMutate}
            onCommit={(duck_db) => void session.command('update_mix', { duck_db })}
          />
          <NumberField
            label="Duck attack (ms)"
            min={5}
            max={1000}
            step={10}
            value={mix.duck_attack_ms ?? 80}
            disabled={!canMutate}
            onCommit={(duck_attack_ms) => void session.command('update_mix', { duck_attack_ms })}
          />
          <NumberField
            label="Duck release (ms)"
            min={20}
            max={3000}
            step={25}
            value={mix.duck_release_ms ?? 350}
            disabled={!canMutate}
            onCommit={(duck_release_ms) => void session.command('update_mix', { duck_release_ms })}
          />
        </div>
      )}
      <NumberField
        label="Master gain (linear)"
        min={0}
        max={16}
        value={mix.master_gain ?? 1}
        disabled={!canMutate}
        onCommit={(master_gain) => void session.command('update_mix', { master_gain })}
      />
      <label className="studio-check">
        <input
          type="checkbox"
          checked={mix.limiter ?? false}
          disabled={!canMutate}
          onChange={(event) =>
            void session.command('update_mix', { limiter: event.target.checked })
          }
        />{' '}
        Oversampled peak limiter (final true-peak compliance is not guaranteed)
      </label>
      <p className="studio-note">
        Targets are saved with the checkpoint. Final-file measurements come from the renderer;
        timeline playback bypasses effects and master processing. Processed renders include up to
        ten seconds of effect tail, limited by the two-hour output boundary.
      </p>
      <label className="studio-check">
        <input
          type="checkbox"
          checked={mix.normalize}
          disabled={!canMutate}
          onChange={(event) =>
            void session.command('update_mix', { normalize: event.target.checked })
          }
        />{' '}
        Normalize on delivery
      </label>
      <NumberField
        label="Target loudness (LUFS)"
        min={-40}
        max={-5}
        value={mix.target_lufs}
        disabled={!canMutate}
        onCommit={(target_lufs) => {
          if (target_lufs !== mix.target_lufs) void session.command('update_mix', { target_lufs });
        }}
      />
      <NumberField
        label="Maximum true peak (dBTP)"
        min={-9}
        max={0}
        value={mix.max_true_peak_dbtp}
        disabled={!canMutate}
        onCommit={(max_true_peak_dbtp) => {
          if (max_true_peak_dbtp !== mix.max_true_peak_dbtp)
            void session.command('update_mix', { max_true_peak_dbtp });
        }}
      />
      <p className="studio-note">
        No live loudness claim. Use Deliver to render a frozen checkpoint and audition the encoded
        file.
      </p>
    </section>
  );
}
