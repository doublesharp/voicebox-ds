import { Check, Headphones } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useStudio } from './context';
import { formatTime } from './domain';
import { listeningGains, replacementNeedsReset } from './take-comparison';
import type { StudioPassage, StudioTake } from './types';
import { Field, StudioButton } from './ui';
import { PhraseRepairPanel } from './PhraseRepairPanel';
import './take-comparison.css';

function TakeAnnotation({ take, label }: { take: StudioTake; label: string }) {
  const { project, session, save, canMutate, actionBusy } = useStudio();
  const saved = project.document.take_annotations?.[take.id] ?? { name: '', note: '' };
  const draft = save.takeDrafts?.[take.id];
  const [error, setError] = useState('');
  const value = { ...saved, ...draft };
  const editDisabled = actionBusy || save.status === 'loading' || save.status === 'recovery';
  return (
    <details>
      <summary>Name and notes</summary>
      <Field label="Take name">
        <Input
          aria-label={`${label} name`}
          maxLength={120}
          value={value.name}
          disabled={editDisabled}
          onChange={(event) => session.editTakeAnnotation(take.id, { name: event.target.value })}
        />
      </Field>
      <Field label="Take notes">
        <Textarea
          aria-label={`${label} notes`}
          maxLength={4000}
          value={value.note}
          disabled={editDisabled}
          onChange={(event) => session.editTakeAnnotation(take.id, { note: event.target.value })}
        />
      </Field>
      <StudioButton
        disabled={!draft || !canMutate || actionBusy}
        onClick={async () => {
          if (!draft) return;
          setError('');
          await session.flush();
          if (session.getSnapshot().status !== 'saved') {
            setError(
              'Take notes were not saved. Your draft is retained here; resolve the save error before retrying.',
            );
          }
        }}
      >
        Save take notes
      </StudioButton>
      {error && (
        <p role="alert" className="studio-error">
          {error}
        </p>
      )}
    </details>
  );
}

function PerformanceSnapshot({ take }: { take: StudioTake }) {
  return (
    <details>
      <summary>Performance snapshot</summary>
      <p className="studio-take-script">{take.text}</p>
      <pre>{JSON.stringify(take.request, null, 2)}</pre>
    </details>
  );
}

export function TakeWorkflow({
  passage,
  currentText,
}: {
  passage: StudioPassage;
  currentText: string;
}) {
  const studio = useStudio();
  const { project, client, playback, session } = studio;
  const takes = project.takes.filter((take) => take.passage_id === passage.id);
  const [replaceClips, setReplaceClips] = useState(false);
  const [replacement, setReplacement] = useState<string | null>(null);
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [match, setMatch] = useState(false);
  const pairKey = `${a}:${b}`;
  const [levels, setLevels] = useState<{
    key: string;
    gains: [number, number] | null;
    reason: string;
  } | null>(null);
  const pair = [takes.find((take) => take.id === a), takes.find((take) => take.id === b)];
  const assetA = pair[0]?.asset_id;
  const assetB = pair[1]?.asset_id;
  const validPair = !!assetA && !!assetB && a !== b;
  const disabled = !studio.canMutate || passage.locked || studio.actionBusy;
  const name = (take: StudioTake) =>
    project.document.take_annotations?.[take.id]?.name || `Take ${takes.indexOf(take) + 1}`;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    // Changing comparison controls revokes the preceding temporary audition.
    playback.stop?.();
    if (match && assetA && assetB && a !== b) {
      setLevels(null);
      void Promise.all([
        client.auditionLevel(assetA, controller.signal),
        client.auditionLevel(assetB, controller.signal),
      ])
        .then(([first, second]) => {
          if (active) setLevels({ key: pairKey, ...listeningGains(first, second) });
        })
        .catch((error: unknown) => {
          if (active)
            setLevels({
              key: pairKey,
              gains: null,
              reason: error instanceof Error ? error.message : 'Listening levels are unavailable.',
            });
        });
    }
    return () => {
      active = false;
      controller.abort();
      playback.stop?.();
    };
  }, [client, playback, a, b, pairKey, match, assetA, assetB]);

  const choose = async (takeId: string, replace: boolean, reset = false) => {
    const ok = await session.command('select_take', {
      passage_id: passage.id,
      take_id: takeId,
      replace_clips: replace,
      ...(reset ? { reset_trims: true } : {}),
    });
    if (ok) setReplacement(null);
  };
  const selectedReplacement = takes.find((take) => take.id === replacement);
  return (
    <div className="studio-take-workflow">
      <div className="studio-section-title">
        <h3>Takes</h3>
        <span>{takes.length}</span>
      </div>
      <PhraseRepairPanel passage={passage} currentText={currentText} />
      {takes.length > 0 && (
        <label className="studio-check">
          <input
            type="checkbox"
            checked={replaceClips}
            onChange={(event) => {
              setReplaceClips(event.target.checked);
              setReplacement(null);
            }}
          />{' '}
          Replace linked timeline clips when choosing
        </label>
      )}
      {!takes.length && <p className="studio-note">No takes yet.</p>}
      {takes.length >= 2 && (
        <section aria-label="A/B take comparison" className="studio-take">
          <h4>A/B comparison</h4>
          {(['A', 'B'] as const).map((side, index) => (
            <Field key={side} label={`Take ${side}`}>
              <select
                aria-label={`Comparison take ${side}`}
                value={index === 0 ? a : b}
                onChange={(event) => (index === 0 ? setA : setB)(event.target.value)}
              >
                <option value="">Choose a retained take</option>
                {takes.map((take) => (
                  <option
                    key={take.id}
                    value={take.id}
                    disabled={take.id === (index === 0 ? b : a)}
                  >
                    {name(take)}
                  </option>
                ))}
              </select>
            </Field>
          ))}
          <label className="studio-check">
            <input
              type="checkbox"
              checked={match}
              disabled={!validPair && !match}
              onChange={(event) => setMatch(event.target.checked)}
            />{' '}
            Match listening level
          </label>
          <p className="studio-note">
            Temporary attenuation from sampled RMS, with sampled-peak headroom. Up to five seconds
            of native PCM; not integrated LUFS. Audio, timeline and delivery settings stay
            unchanged.
          </p>
          {match && validPair && (
            <p aria-live="polite" className="studio-note">
              {levels?.key === pairKey
                ? levels.reason || 'Listening levels matched for this pair.'
                : 'Measuring listening levels…'}
            </p>
          )}
          {pair.map(
            (take, index) =>
              take && (
                <div key={`${index}:${take.id}`} className="studio-comparison-source">
                  <strong>
                    {index === 0 ? 'A' : 'B'} · {name(take)}
                  </strong>
                  <p>
                    {take.engine}
                    {take.model_size ? ` · ${take.model_size}` : ''}
                  </p>
                  <p className="studio-take-script">{take.text}</p>
                  <PerformanceSnapshot take={take} />
                  <div className="studio-action-row">
                    <StudioButton
                      disabled={
                        !validPair ||
                        !project.assets.some((asset) => asset.id === take.asset_id) ||
                        (match && !(levels?.key === pairKey && levels.gains))
                      }
                      onClick={() =>
                        void playback.audition(
                          client.assetAudio(take.asset_id),
                          `${index === 0 ? 'A' : 'B'} · ${name(take)}`,
                          match ? levels?.gains?.[index] : 1,
                        )
                      }
                    >
                      {index === 0 ? 'Play A' : 'Play B'}
                    </StudioButton>
                    <StudioButton
                      disabled={disabled || passage.selected_take_id === take.id}
                      onClick={() => {
                        if (
                          replaceClips &&
                          replacementNeedsReset(project, passage.id, take.asset_id)
                        )
                          setReplacement(take.id);
                        else void choose(take.id, replaceClips);
                      }}
                    >
                      Use {index === 0 ? 'A' : 'B'}
                    </StudioButton>
                  </div>
                </div>
              ),
          )}
          <StudioButton onClick={() => playback.stop()}>Stop comparison</StudioButton>
        </section>
      )}
      {selectedReplacement && (
        <section aria-label="Shorter take replacement" className="studio-recovery">
          <p>
            {name(selectedReplacement)} cannot fit the linked clips' trims or fades. Choose how to
            use it.
          </p>
          <p className="studio-note">
            Reset trims clears source trims on all linked clips and clears fades that no longer fit.
            Timeline starts and gains are preserved.
          </p>
          <div className="studio-action-row">
            <StudioButton
              disabled={disabled}
              onClick={() => void choose(selectedReplacement.id, true, true)}
            >
              Reset trims
            </StudioButton>
            <StudioButton
              disabled={disabled}
              onClick={() => void choose(selectedReplacement.id, false)}
            >
              Keep timeline audio
            </StudioButton>
            <StudioButton onClick={() => setReplacement(null)}>Cancel replacement</StudioButton>
          </div>
        </section>
      )}
      <div className="studio-takes">
        {takes
          .slice()
          .reverse()
          .map((take) => {
            const asset = project.assets.find((item) => item.id === take.asset_id);
            const label = name(take);
            return (
              <div
                className={`studio-take ${passage.selected_take_id === take.id ? 'is-selected' : ''}`}
                key={take.id}
              >
                <div className="studio-take-title">
                  <strong>{label}</strong>
                  <span>{asset ? formatTime(asset.duration) : 'Audio missing'}</span>
                </div>
                <p>
                  {take.engine}
                  {take.model_size ? ` · ${take.model_size}` : ''}
                </p>
                {take.text !== currentText && (
                  <span className="studio-status-chip">Different script</span>
                )}
                <div className="studio-action-row">
                  <StudioButton
                    disabled={!asset}
                    onClick={() => void playback.audition(client.assetAudio(take.asset_id), label)}
                  >
                    <Headphones size={14} /> Audition
                  </StudioButton>
                  <StudioButton
                    disabled={disabled || passage.selected_take_id === take.id}
                    onClick={() => {
                      if (replaceClips && replacementNeedsReset(project, passage.id, take.asset_id))
                        setReplacement(take.id);
                      else void choose(take.id, replaceClips);
                    }}
                  >
                    {passage.selected_take_id === take.id ? (
                      <>
                        <Check size={14} /> Selected
                      </>
                    ) : (
                      'Use take'
                    )}
                  </StudioButton>
                </div>
                <TakeAnnotation take={take} label={label} />
                <PerformanceSnapshot take={take} />
              </div>
            );
          })}
      </div>
    </div>
  );
}
