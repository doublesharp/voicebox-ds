import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useStudio } from './context';
import { SpeechReviewPanel } from './SpeechReviewPanel';
import { operationId } from './session';
import { useDurableSubmission } from './submissions';
import type { StudioPassage } from './types';
import { Field, StudioButton } from './ui';

interface Phrase {
  take_id: string;
  start: string;
  end: string;
}

export function PhraseRepairPanel({
  passage,
  currentText,
}: {
  passage: StudioPassage;
  currentText: string;
}) {
  const { project, client, session, playback, canMutate, actionBusy, runAction } = useStudio();
  const takes = project.takes.filter((take) => take.passage_id === passage.id);
  const [mode, setMode] = useState<'repair' | 'comp'>('repair');
  const [baseId, setBaseId] = useState('');
  const base = takes.find((take) => take.id === (baseId || passage.selected_take_id)) ?? takes[0];
  const [source, setSource] = useState<Phrase>({ take_id: '', start: '0', end: '' });
  const [replaceStart, setReplaceStart] = useState('0');
  const [replaceEnd, setReplaceEnd] = useState('');
  const [crossfade, setCrossfade] = useState('10');
  const [phraseText, setPhraseText] = useState('');
  const [resultText, setResultText] = useState(currentText);
  const [pieces, setPieces] = useState<Array<Phrase & { id: string }>>([]);
  const [error, setError] = useState('');
  const generation = useDurableSubmission(
    session.storage,
    client.baseUrl,
    `${project.id}:phrase-repair`,
    'generation',
  );
  const disabled = !canMutate || passage.locked || actionBusy;
  const rate = project.document.sample_rate;
  const frames = (takeId: string) => {
    const asset = project.assets.find((a) => a.id === takes.find((t) => t.id === takeId)?.asset_id);
    return asset ? Math.round((asset.frames * rate) / asset.sample_rate) : 0;
  };
  const name = (takeId: string) =>
    project.document.take_annotations?.[takeId]?.name ||
    `Take ${takes.findIndex((t) => t.id === takeId) + 1}`;
  const parse = (value: string, label: string) => {
    const number = Number(value);
    if (!value.trim() || !Number.isFinite(number) || number < 0)
      throw new Error(`${label} must be a nonnegative number.`);
    return Math.round(number * rate);
  };
  const segment = (piece: Phrase) => {
    const start = parse(piece.start, 'Phrase start');
    const end = piece.end.trim() ? parse(piece.end, 'Phrase end') : frames(piece.take_id);
    if (!piece.take_id || start >= end || end > frames(piece.take_id))
      throw new Error('Choose a take and a phrase range within its audio.');
    return { take_id: piece.take_id, start_sample: start, end_sample: end };
  };
  const compose = async () => {
    setError('');
    try {
      let segments: Array<{ take_id: string; start_sample: number; end_sample: number }>;
      if (mode === 'comp') segments = pieces.map(segment);
      else {
        if (!base) throw new Error('Choose a base take.');
        const start = parse(replaceStart, 'Replacement start');
        const end = parse(replaceEnd, 'Replacement end');
        const length = frames(base.id);
        if (start >= end || end > length)
          throw new Error('Choose a replacement interval within the base take.');
        segments = [
          ...(start > 0 ? [{ take_id: base.id, start_sample: 0, end_sample: start }] : []),
          segment(source),
          ...(end < length ? [{ take_id: base.id, start_sample: end, end_sample: length }] : []),
        ];
      }
      if (!segments.length) throw new Error('Add at least one source phrase.');
      const ms = Number(crossfade);
      if (!crossfade.trim() || !Number.isFinite(ms) || ms < 0 || ms > 500)
        throw new Error('Crossfade must be between 0 and 500 milliseconds.');
      if (!resultText.trim()) throw new Error('Enter the transcript of the completed audio.');
      const ok = await session.command('compose_take', {
        passage_id: passage.id,
        text: resultText,
        segments,
        crossfade_samples: Math.round((ms * rate) / 1000),
      });
      if (!ok)
        setError(
          'The composed take was not acknowledged. Resolve the save error and retry the pending command.',
        );
    } catch (fault) {
      setError(fault instanceof Error ? fault.message : 'Could not compose these phrases.');
    }
  };
  const sourceEditor = (piece: Phrase, change: (value: Phrase) => void, label: string) => (
    <div className="studio-phrase-source">
      <Field label={`${label} take`}>
        <select
          aria-label={`${label} take`}
          value={piece.take_id}
          disabled={disabled}
          onChange={(event) =>
            change({ ...piece, take_id: event.target.value, start: '0', end: '' })
          }
        >
          <option value="">Choose a retained take</option>
          {takes.map((take) => (
            <option key={take.id} value={take.id}>
              {name(take.id)} · {take.text.slice(0, 60)}
            </option>
          ))}
        </select>
      </Field>
      <div className="studio-phrase-range">
        <Field label="Start (seconds)">
          <Input
            aria-label={`${label} start seconds`}
            type="number"
            min="0"
            step="0.001"
            value={piece.start}
            disabled={disabled}
            onChange={(event) => change({ ...piece, start: event.target.value })}
          />
        </Field>
        <Field label="End (seconds)">
          <Input
            aria-label={`${label} end seconds`}
            type="number"
            min="0"
            step="0.001"
            placeholder={piece.take_id ? (frames(piece.take_id) / rate).toFixed(3) : 'End of take'}
            value={piece.end}
            disabled={disabled}
            onChange={(event) => change({ ...piece, end: event.target.value })}
          />
        </Field>
      </div>
      <StudioButton
        disabled={!piece.take_id || actionBusy}
        onClick={() => {
          setError('');
          try {
            const range = segment(piece);
            const take = takes.find((t) => t.id === piece.take_id)!;
            void playback.audition(
              client.assetAudio(take.asset_id),
              `${label} · ${name(take.id)}`,
              1,
              { start: range.start_sample / rate, end: range.end_sample / rate },
            );
          } catch (fault) {
            setError(fault instanceof Error ? fault.message : 'Invalid phrase range.');
          }
        }}
      >
        Play {label.toLowerCase()}
      </StudioButton>
    </div>
  );
  if (!takes.length && !generation.request && !generation.error) return null;
  return (
    <details className="studio-advanced studio-phrase-repairs">
      <summary>Phrase repairs &amp; comping</summary>
      <SpeechReviewPanel
        passage={passage}
        onRepair={(takeId, suggestion) => {
          setMode('repair');
          setBaseId(takeId);
          setPhraseText(suggestion.expected);
          if (suggestion.kind === 'substitution' && suggestion.audition) {
            setReplaceStart(String(suggestion.audition.start));
            setReplaceEnd(String(suggestion.audition.end));
          }
          setError(
            'Listen to the original and choose the exact repair interval before composing. The suggestion does not generate or adopt audio.',
          );
        }}
      />
      <p className="studio-note">Listen to the source takes and choose the ranges to join.</p>
      <Field label="Replacement phrase text">
        <Input
          aria-label="Replacement phrase text"
          maxLength={1000}
          value={phraseText}
          disabled={disabled || !!generation.request}
          onChange={(event) => setPhraseText(event.target.value)}
        />
      </Field>
      <StudioButton
        disabled={
          actionBusy ||
          (!generation.request && (disabled || !phraseText.trim() || !passage.voice_snapshot))
        }
        onClick={async () => {
          await session.flush();
          if (session.getSnapshot().status !== 'saved') return;
          await runAction(() =>
            generation.submit(
              () => ({
                idempotency_key: operationId(),
                passage_ids: [passage.id],
                count: 1,
                adopt: false,
                phrase_text: phraseText.trim(),
              }),
              (input) => client.generate(project.id, input),
            ),
          );
        }}
      >
        {generation.request ? 'Retry phrase generation' : 'Generate replacement phrase'}
      </StudioButton>
      {generation.error && (
        <p role="alert" className="studio-error">
          {generation.error}
        </p>
      )}
      {generation.rejected && (
        <StudioButton onClick={generation.discardRejected}>
          Dismiss rejected phrase generation
        </StudioButton>
      )}
      <p className="studio-note">Choose the phrase from Takes after it generates.</p>
      {!!takes.length && (
        <>
          <Field label="Edit mode">
            <select
              aria-label="Phrase edit mode"
              value={mode}
              disabled={disabled}
              onChange={(event) => setMode(event.target.value as 'repair' | 'comp')}
            >
              <option value="repair">Replace a phrase</option>
              <option value="comp">Combine phrases from takes</option>
            </select>
          </Field>
          {mode === 'repair' ? (
            <>
              <Field label="Base take">
                <select
                  aria-label="Repair base take"
                  value={base?.id ?? ''}
                  disabled={disabled}
                  onChange={(event) => setBaseId(event.target.value)}
                >
                  {takes.map((take) => (
                    <option value={take.id} key={take.id}>
                      {name(take.id)}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="studio-phrase-range">
                <Field label="Replace from (seconds)">
                  <Input
                    aria-label="Replace from seconds"
                    type="number"
                    min="0"
                    step="0.001"
                    value={replaceStart}
                    disabled={disabled}
                    onChange={(event) => setReplaceStart(event.target.value)}
                  />
                </Field>
                <Field label="Replace through (seconds)">
                  <Input
                    aria-label="Replace through seconds"
                    type="number"
                    min="0"
                    step="0.001"
                    value={replaceEnd}
                    disabled={disabled}
                    onChange={(event) => setReplaceEnd(event.target.value)}
                  />
                </Field>
              </div>
              {sourceEditor(source, setSource, 'Replacement')}
            </>
          ) : (
            <>
              {pieces.map((piece, index) => (
                <div className="studio-take" key={piece.id}>
                  {sourceEditor(
                    piece,
                    (value) =>
                      setPieces(pieces.map((p, i) => (i === index ? { ...p, ...value } : p))),
                    `Phrase ${index + 1}`,
                  )}
                  <div className="studio-action-row">
                    <StudioButton
                      disabled={disabled || index === 0}
                      onClick={() => {
                        const next = [...pieces];
                        [next[index - 1], next[index]] = [next[index], next[index - 1]];
                        setPieces(next);
                      }}
                    >
                      Move phrase {index + 1} up
                    </StudioButton>
                    <StudioButton
                      disabled={disabled}
                      onClick={() => setPieces(pieces.filter((_, i) => i !== index))}
                    >
                      Remove phrase {index + 1}
                    </StudioButton>
                  </div>
                </div>
              ))}
              <StudioButton
                disabled={disabled || pieces.length >= 32}
                onClick={() =>
                  setPieces([
                    ...pieces,
                    { id: operationId(), take_id: base?.id ?? '', start: '0', end: '' },
                  ])
                }
              >
                Add source phrase
              </StudioButton>
            </>
          )}
          <Field label="Join crossfade (ms)">
            <Input
              aria-label="Phrase crossfade milliseconds"
              type="number"
              min="0"
              max="500"
              step="1"
              value={crossfade}
              disabled={disabled}
              onChange={(event) => setCrossfade(event.target.value)}
            />
          </Field>
          <Field label="Completed audio transcript">
            <Textarea
              aria-label="Composed take transcript"
              value={resultText}
              disabled={disabled}
              onChange={(event) => setResultText(event.target.value)}
            />
          </Field>
          <StudioButton disabled={disabled} onClick={compose}>
            Create composed alternative
          </StudioButton>
        </>
      )}
      {error && (
        <p role="alert" className="studio-error">
          {error}
        </p>
      )}
    </details>
  );
}
