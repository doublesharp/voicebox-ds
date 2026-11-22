import { BookOpen, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  hasMissingRegenerationReferences,
  RegenerationReferenceNotice,
} from './ArchiveScopeControls';
import { useStudio } from './context';
import { engineForPassage } from './domain';
import { operationId } from './session';
import { useDurableSubmission } from './submissions';
import { TakeWorkflow } from './TakeWorkflow';
import { Field, NumberField, StudioButton } from './ui';

export function Director({
  onOpenPronunciation,
}: {
  onOpenPronunciation?: (opener: HTMLButtonElement) => void;
}) {
  const studio = useStudio();
  const { project, session, save, selectedPassageId, profiles, engines, client } = studio;
  const [count, setCount] = useState<1 | 2 | 3>(1);
  const [adopt, setAdopt] = useState(false);
  const [commercialOnly, setCommercialOnly] = useState(false);
  const {
    request,
    rejected,
    discardRejected,
    error: submissionError,
    submit,
  } = useDurableSubmission(session.storage, client.baseUrl, project.id, 'generation');
  const commercialFilter = request ? request.commercial_only === true : commercialOnly;
  const eligibleEngines = commercialFilter
    ? engines.filter((item) => item.commercial_use === 'allowed')
    : engines;
  const eligibleProfiles = commercialFilter
    ? profiles.filter((profile) =>
        eligibleEngines.some(
          (item) => item.id === (profile.preset_engine || profile.default_engine),
        ),
      )
    : profiles;
  const passage = project.document.passages.find((p) => p.id === selectedPassageId);
  const engine = engineForPassage(passage, profiles, eligibleEngines);
  const recoveryChoices = save.status === 'recovery' ? session.recoverableJournals() : [];
  const recoveryPanel = recoveryChoices.length > 1 && (
    <div className="studio-recovery">
      <p>
        Independent editing sessions have local recovery copies. Recover one at a time, or export
        all copies from the recovery bar.
      </p>
      {recoveryChoices.map((choice, index) => (
        <StudioButton
          key={choice.key}
          disabled={!choice.readable}
          onClick={() => session.recover(choice.key)}
        >
          Recover local copy {index + 1} · draft {choice.baseRevision ?? 'unreadable'}
        </StudioButton>
      ))}
    </div>
  );
  if (!passage)
    return (
      <div className="studio-inspector-content">
        {recoveryPanel}
        <h2>Voice &amp; takes</h2>
        <p className="studio-note">Select a passage to assign a voice or generate takes.</p>
        {submissionError && (
          <p role="alert" className="studio-error">
            {submissionError}
          </p>
        )}
        {request && (
          <StudioButton
            disabled={studio.actionBusy}
            onClick={() =>
              studio.runAction(() =>
                submit(
                  () => request,
                  (input) => client.generate(project.id, input),
                ),
              )
            }
          >
            Retry same request
          </StudioButton>
        )}
        {rejected && (
          <StudioButton disabled={studio.actionBusy} onClick={discardRejected}>
            Dismiss rejected submission
          </StudioButton>
        )}
      </div>
    );
  const selectedIds = studio.checkedPassages.length
    ? studio.checkedPassages.filter((id) => project.document.passages.some((p) => p.id === id))
    : [passage.id];
  const missingReferences = project.document.passages.some(
    (item) =>
      selectedIds.includes(item.id) && hasMissingRegenerationReferences(item.voice_snapshot),
  );
  const direction = save.drafts[passage.id]?.direction ?? passage.direction;
  const currentText = save.drafts[passage.id]?.text ?? passage.text;
  const disabled = !studio.canMutate || passage.locked;
  const profile = profiles.find((profile) => profile.id === passage.profile_id);
  const engineId =
    passage.voice_snapshot?.engine ||
    passage.voice_snapshot?.preset_engine ||
    passage.voice_snapshot?.default_engine ||
    profile?.preset_engine ||
    profile?.default_engine;
  const variants = eligibleEngines.filter(
    (variant) => variant.id === engineId && variant.model_size,
  );
  const incompatible = !engine?.supports_instruct && !!direction.instruct;
  const editDisabled = passage.locked || save.status === 'recovery';
  const incompatibleSeed = !engine?.supports_seed && direction.seed !== null;
  const unsupportedTags = (currentText.match(/\[[^\]\n]+\]/g) ?? []).filter(
    (tag) =>
      engine?.recognized_tags?.some((known) => known.toLowerCase() === tag.toLowerCase()) &&
      !engine?.expressive_tags.some(
        (supported) =>
          supported.replace(/^\[|\]$/g, '').toLowerCase() === tag.slice(1, -1).toLowerCase(),
      ),
  );
  const languageValue = save.drafts[passage.id]?.language ?? passage.language;
  const unsupportedLanguage =
    !!engine?.languages.length && !engine.languages.includes(languageValue);
  const generate = async () => {
    if (!request) {
      await session.flush();
      if (session.getSnapshot().status !== 'saved') return;
    }
    await studio.runAction(async () => {
      await submit(
        () => ({
          idempotency_key: operationId(),
          passage_ids: selectedIds,
          count,
          adopt,
          ...(commercialOnly ? { commercial_only: true } : {}),
        }),
        (input) => client.generate(project.id, input),
      );
    });
  };
  return (
    <div className="studio-inspector-content">
      {recoveryPanel}
      <div className="studio-section-title">
        <h2>Voice &amp; takes</h2>
        {passage.locked && <span className="studio-status-chip">Locked</span>}
        {!passage.locked && selectedIds.length > 1 && (
          <span>{selectedIds.length} passages selected</span>
        )}
      </div>
      {missingReferences && <RegenerationReferenceNotice />}
      <Field label="Voice">
        <select
          aria-label="Passage voice"
          value={passage.profile_id ?? ''}
          disabled={disabled || studio.actionBusy}
          onChange={(event) => {
            if (event.target.value) {
              const nextProfile = eligibleProfiles.find(
                (profile) => profile.id === event.target.value,
              );
              const nextVariants = eligibleEngines.filter(
                (variant) =>
                  variant.id === (nextProfile?.preset_engine || nextProfile?.default_engine),
              );
              const variant =
                nextVariants.find((candidate) => candidate.model_size === engine?.model_size) ??
                nextVariants.find((candidate) => candidate.ready) ??
                nextVariants[0];
              void session.command('assign_voice', {
                passage_ids: selectedIds,
                profile_id: event.target.value,
                ...(variant?.model_size ? { model_size: variant.model_size } : {}),
              });
            }
          }}
        >
          <option value="">Choose a voice</option>
          {passage.profile_id && !eligibleProfiles.some((p) => p.id === passage.profile_id) && (
            <option value={passage.profile_id}>Saved voice (unavailable in this filter)</option>
          )}
          {eligibleProfiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name} · {profile.language}
            </option>
          ))}
        </select>
      </Field>
      {!profiles.length && (
        <p className="studio-note">Create a voice in Voices, then return here to assign it.</p>
      )}
      {studio.capabilitiesError && (
        <p aria-live="polite" className="studio-error">
          {studio.capabilitiesError}
        </p>
      )}
      {engine && !engine.ready && <p className="studio-note">{engine.name} is not ready.</p>}
      {engine && engine.commercial_use !== 'allowed' && (
        <p className="studio-note">
          Commercial use: {engine.commercial_use}. Check the model terms.
        </p>
      )}
      {(engine?.supports_instruct || direction.instruct) && (
        <Field
          label="Delivery direction"
          hint={
            incompatible
              ? 'Inactive for this engine. Stored direction is retained and excluded from generation.'
              : 'Performance instructions supported by this engine.'
          }
        >
          <Textarea
            aria-label="Delivery direction"
            value={direction.instruct}
            disabled={editDisabled || !engine?.supports_instruct}
            onChange={(event) =>
              session.editPassage(passage.id, {
                direction: { ...direction, instruct: event.target.value },
              })
            }
            placeholder="Warm, unhurried, with a smile…"
          />
          {incompatible && (
            <StudioButton
              disabled={disabled}
              onClick={() =>
                session.editPassage(passage.id, { direction: { ...direction, instruct: '' } })
              }
            >
              Clear inactive direction
            </StudioButton>
          )}
        </Field>
      )}
      {!!unsupportedTags.length && (
        <p className="studio-error">
          Unsupported stage tags: {unsupportedTags.join(', ')}. Remove them, or remove brackets if
          these are spoken words.
        </p>
      )}
      {unsupportedLanguage && (
        <p className="studio-error">Choose a supported language in Generation settings.</p>
      )}
      <div className="studio-generate-box">
        {submissionError && (
          <p role="alert" className="studio-error">
            {submissionError}
          </p>
        )}
        {request && (
          <p className="studio-note">
            An earlier submission needs reconciliation. Retry sends its original passage selection,
            count and adoption intent before a new request can be made.
          </p>
        )}
        {rejected && (
          <StudioButton disabled={studio.actionBusy} onClick={discardRejected}>
            Dismiss rejected submission
          </StudioButton>
        )}
        <StudioButton
          primary
          disabled={
            studio.actionBusy ||
            (!request &&
              (disabled ||
                missingReferences ||
                !engine?.ready ||
                !passage.profile_id ||
                !currentText.trim() ||
                unsupportedTags.length > 0 ||
                unsupportedLanguage))
          }
          onClick={generate}
        >
          <Sparkles size={15} />
          {studio.actionBusy
            ? 'Submitting…'
            : request
              ? 'Retry same request'
              : adopt
                ? 'Generate and use'
                : 'Generate alternatives'}
        </StudioButton>
        {onOpenPronunciation && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={(event) => onOpenPronunciation(event.currentTarget)}
          >
            <BookOpen size={15} /> Pronunciation
          </Button>
        )}
      </div>
      <details className="studio-advanced">
        <summary>
          Generation settings{commercialFilter && ' · Commercial use'}
          {count > 1 && ` · ${count} takes`}
        </summary>
        {!!variants.length && (
          <Field label="Voice model size">
            <select
              aria-label="Voice model size"
              value={String(passage.voice_snapshot?.model_size ?? '')}
              disabled={disabled || studio.actionBusy || !profile}
              onChange={(event) => {
                if (variants.some((variant) => variant.model_size === event.target.value))
                  void session.command('assign_voice', {
                    passage_ids: selectedIds,
                    profile_id: passage.profile_id,
                    model_size: event.target.value,
                  });
              }}
            >
              <option value="">Choose a compatible variant</option>
              {variants.map((variant) => (
                <option key={variant.model_size} value={variant.model_size}>
                  {variant.name}
                  {variant.ready ? '' : ' · Not ready'}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Passage language">
          <Input
            value={languageValue}
            disabled={editDisabled}
            onChange={(event) => session.editPassage(passage.id, { language: event.target.value })}
          />
        </Field>
        {!!engine?.expressive_tags.length && (
          <p className="studio-note">
            Supported expressive tags: {engine.expressive_tags.join(', ')}
          </p>
        )}
        {(engine?.supports_seed || direction.seed !== null) && (
          <Field label="Seed (optional)">
            <Input
              type="number"
              aria-label="Seed"
              value={direction.seed ?? ''}
              disabled={editDisabled || !engine?.supports_seed}
              onChange={(event) => {
                const seed = event.target.value === '' ? null : event.target.valueAsNumber;
                if (seed === null || Number.isInteger(seed))
                  session.editPassage(passage.id, { direction: { ...direction, seed } });
              }}
            />
          </Field>
        )}
        {incompatibleSeed && (
          <div className="studio-note">
            Seed is inactive for this engine.{' '}
            <StudioButton
              disabled={editDisabled}
              onClick={() =>
                session.editPassage(passage.id, { direction: { ...direction, seed: null } })
              }
            >
              Clear inactive seed
            </StudioButton>
          </div>
        )}
        <label className="studio-check">
          <input
            type="checkbox"
            aria-label="Commercial-use models only"
            checked={commercialFilter}
            disabled={studio.actionBusy || !!request}
            onChange={(event) => setCommercialOnly(event.target.checked)}
          />{' '}
          Commercial-use models only
        </label>
        {commercialFilter && (
          <p className="studio-note">
            Models with restricted or unknown terms are excluded.
            {!eligibleEngines.length && ' No eligible models are currently reported.'}
          </p>
        )}
        <Field label="Alternatives per passage">
          <select
            aria-label="Alternatives per passage"
            value={count}
            onChange={(event) => setCount(Number(event.target.value) as 1 | 2 | 3)}
            disabled={studio.actionBusy || !!request}
          >
            <option value={1}>1 take</option>
            <option value={2}>2 takes</option>
            <option value={3}>3 takes</option>
          </select>
        </Field>
        <label className="studio-check">
          <input
            type="checkbox"
            checked={adopt}
            disabled={studio.actionBusy || !!request}
            onChange={(event) => setAdopt(event.target.checked)}
          />{' '}
          Generate and use when intent still matches
        </label>
        <details className="studio-advanced">
          <summary>Chunk, pacing, and transition settings</summary>
          <NumberField
            label="Speaking speed (0.5×–2.0×)"
            value={direction.speed ?? 1.0}
            min={0.5}
            max={2.0}
            step={0.05}
            disabled={editDisabled}
            onCommit={(value) =>
              session.editPassage(passage.id, {
                direction: { ...direction, speed: Number(value.toFixed(2)) },
              })
            }
          />
          {(() => {
            const target = project.document.scene_targets?.[passage.id];
            const selectedTake = project.takes.find((t) => t.id === passage.selected_take_id);
            const selectedAsset = selectedTake
              ? project.assets.find((a) => a.id === selectedTake.asset_id)
              : undefined;
            if (!target || !selectedAsset || selectedAsset.duration <= 0) return null;
            const targetSeconds =
              (target.end_sample - target.start_sample) / project.document.sample_rate;
            if (targetSeconds <= 0) return null;
            const currentSpeed = direction.speed ?? 1.0;
            const suggested = Math.min(
              2.0,
              Math.max(
                0.5,
                Number(((selectedAsset.duration * currentSpeed) / targetSeconds).toFixed(2)),
              ),
            );
            return (
              <StudioButton
                disabled={editDisabled}
                onClick={() =>
                  session.editPassage(passage.id, {
                    direction: { ...direction, speed: suggested },
                  })
                }
              >
                Fit speed to scene ({suggested.toFixed(2)}×)
              </StudioButton>
            );
          })()}
          <p className="studio-note">
            Insert inline silence on any engine with <code>[pause 400ms]</code> or{' '}
            <code>[pause 1.2s]</code> in the script text.
          </p>
          <NumberField
            label="Maximum characters per chunk"
            value={direction.max_chunk_chars}
            min={1}
            step={1}
            disabled={editDisabled}
            onCommit={(value) =>
              session.editPassage(passage.id, {
                direction: { ...direction, max_chunk_chars: Math.round(value) },
              })
            }
          />
          <NumberField
            label="Chunk crossfade (ms)"
            value={direction.crossfade_ms}
            max={5000}
            step={1}
            disabled={editDisabled}
            onCommit={(value) =>
              session.editPassage(passage.id, { direction: { ...direction, crossfade_ms: value } })
            }
          />
        </details>
      </details>
      <TakeWorkflow key={passage.id} passage={passage} currentText={currentText} />
    </div>
  );
}
