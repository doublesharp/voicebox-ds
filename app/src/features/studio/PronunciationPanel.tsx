import { Trash2 } from 'lucide-react';
import { type ComponentProps, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { hasMissingRegenerationReferences } from './ArchiveScopeControls';
import { useStudio } from './context';
import { engineForPassage } from './domain';
import { PronunciationRecording } from './PronunciationRecording';
import {
  EMBEDDED_FIRMWARE_PACK,
  type PronunciationRule,
  parsePronunciationImport,
  previewPronunciation,
  pronunciationError,
  scanScriptJargon,
} from './pronunciation';
import { errorMessage, operationId } from './session';
import { useDurableSubmission } from './submissions';
import type { StudioPassage } from './types';
import { Field, StudioButton } from './ui';

interface DictionaryDraft {
  base: string;
  rules: PronunciationRule[];
}

export function PronunciationPanel({
  passage,
  currentText,
  dialog,
}: {
  passage: StudioPassage;
  currentText: string;
  dialog?: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCloseAutoFocus?: ComponentProps<typeof DialogContent>['onCloseAutoFocus'];
  };
}) {
  const studio = useStudio();
  const { project, session, client, profiles, engines, save } = studio;
  const ruleControlId = useId();
  const [previewPassageId, setPreviewPassageId] = useState<string | null>(null);
  const [queuedPassage, setQueuedPassage] = useState<string | null>(null);
  const [recordingRuleId, setRecordingRuleId] = useState<string | null>(null);
  const activeRecorder = useRef<string | null>(null);
  const saved = project.document.pronunciation_rules ?? [];
  const serialized = JSON.stringify(saved);
  const key = `voicebox-studio:pronunciation:${encodeURIComponent(client.baseUrl)}:${project.id}`;
  const [recovered] = useState(() => {
    try {
      const raw = session.storage.getItem(key);
      if (!raw) return { draft: null, error: '' };
      const recovered = JSON.parse(raw) as DictionaryDraft;
      if (
        !recovered ||
        typeof recovered.base !== 'string' ||
        !Array.isArray(recovered.rules) ||
        recovered.rules.some(
          (rule) =>
            !rule ||
            typeof rule.id !== 'string' ||
            typeof rule.source !== 'string' ||
            typeof rule.replacement !== 'string' ||
            (rule.profile_id !== null && typeof rule.profile_id !== 'string') ||
            typeof rule.case_sensitive !== 'boolean' ||
            typeof rule.whole_word !== 'boolean',
        )
      )
        throw new Error('Unreadable dictionary draft');
      return { draft: recovered, error: '' };
    } catch (error) {
      return { draft: null, error: `Cannot recover the dictionary draft: ${errorMessage(error)}` };
    }
  });
  const [storageError, setStorageError] = useState(recovered.error);
  const [unreadable, setUnreadable] = useState(!!recovered.error);
  const [draft, setDraft] = useState<DictionaryDraft | null>(recovered.draft);
  const [notice, setNotice] = useState('');
  const [importError, setImportError] = useState('');
  const importInputRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const rules = draft?.rules ?? saved;
  const rulesRef = useRef(rules);
  rulesRef.current = rules;
  const changed = JSON.stringify(rules) !== serialized;
  const conflict = !!draft && draft.base !== serialized && changed;
  const invalid = pronunciationError(rules);
  // Preview requests have their own journal and cannot replace the selected take.
  const {
    request,
    rejected,
    discardRejected,
    error: submissionError,
    submit,
  } = useDurableSubmission(
    session.storage,
    client.baseUrl,
    `${project.id}:pronunciation`,
    'generation',
  );
  const passages = project.document.passages;
  const target =
    passages.find((item) => item.id === (request?.passage_ids[0] ?? previewPassageId)) ?? passage;
  const previewText =
    target.id === passage.id ? currentText : (save.drafts[target.id]?.text ?? target.text);
  const canUseRecordings =
    target.voice_snapshot?.engine === 'qwen' && target.voice_snapshot?.voice_type === 'cloned';
  const preview = previewPronunciation(previewText, rules, target.profile_id, canUseRecordings);
  const jargonSuggestions = useMemo(
    () => scanScriptJargon(project.document.passages, rules),
    [project.document.passages, rules],
  );
  const disabled = !studio.canMutate || studio.actionBusy || unreadable;
  const engine = engineForPassage(target, profiles, engines);
  const previewBlocked = changed
    ? 'Save the dictionary to generate an audio preview.'
    : target.locked
      ? 'Unlock this passage to generate a preview.'
      : !target.voice_snapshot
        ? 'Assign a voice to this passage first.'
        : !engine?.ready
          ? 'The assigned voice model must be ready first.'
          : hasMissingRegenerationReferences(target.voice_snapshot)
            ? 'Restore the voice reference audio to generate a preview.'
            : !previewText.trim()
              ? 'Add text to this passage first.'
              : disabled || save.status === 'recovery'
                ? 'Finish the current project action first.'
                : null;

  const edit = (next: PronunciationRule[]) => {
    rulesRef.current = next;
    const nextDraft = { base: draft?.base ?? serialized, rules: next };
    setDraft(nextDraft);
    setNotice('');
    try {
      const raw = JSON.stringify(nextDraft);
      session.storage.setItem(key, raw);
      if (session.storage.getItem(key) !== raw) throw new Error('Draft was not retained');
      setStorageError('');
    } catch (error) {
      setStorageError(`Dictionary draft is only in this panel: ${errorMessage(error)}`);
    }
  };
  const discard = () => {
    try {
      session.storage.removeItem(key);
      setDraft(null);
      setUnreadable(false);
      setStorageError('');
      setNotice('');
    } catch (error) {
      setStorageError(errorMessage(error));
    }
  };
  const update = (id: string, change: Partial<PronunciationRule>) =>
    edit(rulesRef.current.map((rule) => (rule.id === id ? { ...rule, ...change } : rule)));

  async function attachRecording(ruleId: string, file: File) {
    let failure: unknown;
    let attached = false;
    await studio.runAction(async () => {
      try {
        const asset = await client.uploadAsset(project.id, file);
        if (alive.current && rulesRef.current.some((rule) => rule.id === ruleId)) {
          update(ruleId, { recording_asset_id: asset.id });
          attached = true;
        }
      } catch (error) {
        failure = error;
        throw error;
      }
    }, { reportError: false });
    if (failure) throw failure;
    if (!attached) throw new Error('Could not attach the recording. Try again.');
  }

  const clearRecording = () => {
    activeRecorder.current = null;
    setRecordingRuleId(null);
  };

  const mergeFirmwarePack = () => {
    setImportError('');
    const existing = new Set(
      rules.map((rule) => (rule.case_sensitive ? rule.source : rule.source.toLowerCase())),
    );
    const additions: PronunciationRule[] = [];
    for (const entry of EMBEDDED_FIRMWARE_PACK) {
      if (rules.length + additions.length >= 200) break;
      const key = entry.case_sensitive ? entry.source : entry.source.toLowerCase();
      if (existing.has(key) || existing.has(entry.source.toLowerCase())) continue;
      additions.push({
        id: operationId(),
        source: entry.source,
        replacement: entry.replacement,
        profile_id: null,
        case_sensitive: entry.case_sensitive,
        whole_word: entry.whole_word,
      });
    }
    if (!additions.length) {
      setNotice('All Embedded & Firmware glossary terms are already in this dictionary.');
      return;
    }
    edit([...rules, ...additions]);
    setNotice(
      `Added ${additions.length} Embedded & Firmware terms to your draft. Save dictionary to apply.`,
    );
  };

  const exportRulesJson = () => {
    const payload = JSON.stringify(
      {
        version: 1,
        rules: rules.filter((rule) => rule.replacement.trim()).map(({ source, replacement, case_sensitive, whole_word }) => ({
          source,
          replacement,
          case_sensitive,
          whole_word,
        })),
      },
      null,
      2,
    );
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${project.name.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'studio'}-pronunciation.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleImportFile = async (file: File) => {
    setImportError('');
    try {
      const imported = parsePronunciationImport(await file.text(), operationId);
      const existing = new Set(
        rules.map((rule) => (rule.case_sensitive ? rule.source : rule.source.toLowerCase())),
      );
      const additions = imported.filter((rule) => {
        const key = rule.case_sensitive ? rule.source : rule.source.toLowerCase();
        return !existing.has(key);
      });
      const merged = [...rules, ...additions].slice(0, 200);
      edit(merged);
      setNotice(
        `Imported ${merged.length - rules.length} new rules into your draft. Save dictionary to apply.`,
      );
    } catch (error) {
      setImportError(errorMessage(error));
    }
  };

  const saveRules = async () => {
    if (invalid || conflict) return;
    const ok = await session.command('set_pronunciation_rules', { rules });
    if (alive.current && ok) {
      discard();
      setNotice('Dictionary saved. Generate a new take to hear the updated pronunciation.');
    }
  };
  const audition = async () => {
    if (!request) {
      await session.flush();
      if (session.getSnapshot().status !== 'saved') return;
    }
    await studio.runAction(
      async () => {
        setQueuedPassage(null);
        await submit(
          () => ({
            idempotency_key: operationId(),
            passage_ids: [target.id],
            count: 1,
            adopt: false,
          }),
          (input) => client.generate(project.id, input),
        );
        if (alive.current) {
          setPreviewPassageId(target.id);
          setQueuedPassage(target.id);
        }
      },
      { reportError: false },
    );
  };

  const content = (
    <div className="studio-pronunciation">
      <section className="studio-pronunciation-preview" aria-label="Pronunciation preview">
        <h3>Spoken text preview</h3>
        {passages.length > 1 && (
          <Field label="Preview passage">
            <select
              aria-label="Preview passage"
              value={target.id}
              disabled={studio.actionBusy || !!request}
              onChange={(event) => setPreviewPassageId(event.target.value)}
            >
              {passages.map((item, index) => (
                <option key={item.id} value={item.id}>
                  {index + 1}. {(item.chapter || item.text).slice(0, 65)}
                </option>
              ))}
            </select>
          </Field>
        )}
        <output className="studio-take-script" aria-label="Spoken text preview">
          {preview.text}
        </output>
        {preview.substitutions.length ? (
          <ul aria-label="Pronunciation substitutions">
            {preview.substitutions.map((match) => (
              <li key={`${match.start}:${match.rule_id}`}>
                {match.source} → {match.replacement}
              </li>
            ))}
          </ul>
        ) : !preview.recordings.size ? (
          <p className="studio-note">No substitutions in this passage.</p>
        ) : null}
        {preview.recordings.size > 0 && (
          <p className="studio-note">
            Recorded guide: {rules.filter((rule) => preview.recordings.has(rule.id)).map((rule) => rule.source).join(', ')}
          </p>
        )}
        {!request && previewBlocked && <p className="studio-note">{previewBlocked}</p>}
        <StudioButton
          disabled={studio.actionBusy || (!request && !!previewBlocked)}
          onClick={audition}
        >
          {request ? 'Retry audio preview' : 'Generate preview take'}
        </StudioButton>
        {queuedPassage === target.id && (
          <output className="studio-note">
            Preview queued in Takes. Select Audition when it’s ready.
          </output>
        )}
        {rejected && (
          <StudioButton onClick={discardRejected} disabled={studio.actionBusy}>
            Dismiss rejected audition
          </StudioButton>
        )}
        {submissionError && (
          <p role="alert" className="studio-error">
            {submissionError}
          </p>
        )}
      </section>
      <div className="studio-pronunciation-rules">
        <div className="studio-action-row studio-dictionary-actions">
          <StudioButton
            disabled={disabled || conflict || rules.length >= 200}
            onClick={() =>
              edit([
                ...rules,
                {
                  id: operationId(),
                  source: '',
                  replacement: '',
                  profile_id: null,
                  case_sensitive: false,
                  whole_word: true,
                },
              ])
            }
          >
            Add pronunciation rule
          </StudioButton>

          <StudioButton
            primary={changed}
            disabled={disabled || !changed || !!invalid || conflict || !!recordingRuleId}
            onClick={saveRules}
          >
            Save dictionary
          </StudioButton>
          {(draft || unreadable) && (
            <StudioButton disabled={studio.actionBusy || !!recordingRuleId} onClick={discard}>
              Discard dictionary draft
            </StudioButton>
          )}
        </div>
        {notice && <output className="studio-note">{notice}</output>}
        {conflict && (
          <p role="alert" className="studio-error">
            Saved rules changed while this draft was open. Your draft is retained locally; discard
            it to load the saved dictionary before editing.
          </p>
        )}
        {changed && invalid && <output className="studio-note">{invalid}</output>}
        {storageError && (
          <p role="alert" className="studio-error">
            {storageError}
          </p>
        )}
        {importError && (
          <p role="alert" className="studio-error">
            {importError}
          </p>
        )}
        {jargonSuggestions.length > 0 && (
          <details className="studio-advanced">
            <summary>Suggested terms ({jargonSuggestions.length})</summary>
            <ul>
              {jargonSuggestions.slice(0, 25).map((item) => (
                <li key={item.source}>
                  <strong>{item.source}</strong> ({item.count}×) → {item.suggested_replacement}{' '}
                  <StudioButton
                    disabled={disabled || conflict || rules.length >= 200}
                    onClick={() =>
                      edit([
                        ...rules,
                        {
                          id: operationId(),
                          source: item.source,
                          replacement: item.suggested_replacement,
                          profile_id: null,
                          case_sensitive: item.case_sensitive,
                          whole_word: item.whole_word,
                        },
                      ])
                    }
                  >
                    + Add
                  </StudioButton>
                </li>
              ))}
            </ul>
          </details>
        )}
        {rules.map((rule, index) => (
          <fieldset key={rule.id} className="studio-pronunciation-rule">
            <legend className="sr-only">Rule {index + 1}</legend>
            <div className="studio-pronunciation-rule-heading">
              <h3>Rule {index + 1}</h3>
              <button
                type="button"
                className="studio-icon-button"
                aria-label={`Remove rule ${index + 1}`}
                title={`Remove rule ${index + 1}`}
                disabled={disabled || conflict || recordingRuleId === rule.id}
                onClick={() => edit(rules.filter((item) => item.id !== rule.id))}
              >
                <Trash2 size={15} />
              </button>
            </div>
            <div className="studio-field-grid">
              <Field label="Written text">
                <Input
                  aria-label={`Rule ${index + 1} written text`}
                  value={rule.source}
                  maxLength={200}
                  disabled={disabled || conflict || recordingRuleId === rule.id}
                  onChange={(event) => update(rule.id, { source: event.target.value })}
                />
              </Field>
              <Field label="Spoken alias">
                <Input
                  aria-label={`Rule ${index + 1} spoken alias`}
                  value={rule.replacement}
                  maxLength={500}
                  disabled={disabled || conflict}
                  onChange={(event) => update(rule.id, { replacement: event.target.value })}
                />
              </Field>
            </div>
            <PronunciationRecording
              source={rule.source}
              audioUrl={rule.recording_asset_id ? client.assetAudio(rule.recording_asset_id) : undefined}
              disabled={disabled || conflict || (recordingRuleId !== null && recordingRuleId !== rule.id)}
              onStart={() => {
                if (activeRecorder.current && activeRecorder.current !== rule.id) return false;
                activeRecorder.current = rule.id;
                setRecordingRuleId(rule.id);
                return true;
              }}
              onFinish={clearRecording}
              onAttach={(file) => attachRecording(rule.id, file)}
              onRemove={() => update(rule.id, { recording_asset_id: undefined })}
            />
            <Field label="Applies to">
              <select
                aria-label={`Rule ${index + 1} scope`}
                value={rule.profile_id ?? ''}
                disabled={disabled || conflict}
                onChange={(event) => update(rule.id, { profile_id: event.target.value || null })}
              >
                <option value="">Whole project</option>
                {rule.profile_id && !profiles.some((profile) => profile.id === rule.profile_id) && (
                  <option value={rule.profile_id}>Saved voice</option>
                )}
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </Field>
            <div className="studio-pronunciation-rule-options">
              <label className="studio-check" htmlFor={`${ruleControlId}-case-${index}`}>
                <Checkbox
                  id={`${ruleControlId}-case-${index}`}
                  aria-label={`Rule ${index + 1} case sensitive`}
                  checked={rule.case_sensitive}
                  disabled={disabled || conflict}
                  onCheckedChange={(checked) => update(rule.id, { case_sensitive: checked })}
                />
                Match case
              </label>
              <label className="studio-check" htmlFor={`${ruleControlId}-words-${index}`}>
                <Checkbox
                  id={`${ruleControlId}-words-${index}`}
                  aria-label={`Rule ${index + 1} whole words`}
                  checked={rule.whole_word}
                  disabled={disabled || conflict}
                  onCheckedChange={(checked) => update(rule.id, { whole_word: checked })}
                />
                Whole words only
              </label>
            </div>
          </fieldset>
        ))}
        <details className="studio-advanced">
          <summary>Dictionary tools</summary>
          <div className="studio-action-row">
            <StudioButton
              disabled={disabled || conflict || rules.length >= 200}
              onClick={mergeFirmwarePack}
            >
              Load Embedded &amp; Firmware pack
            </StudioButton>
            <input
              ref={importInputRef}
              type="file"
              accept=".json,application/json"
              hidden
              aria-label="Import pronunciation JSON"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void handleImportFile(file);
              }}
            />
            <StudioButton
              disabled={disabled || conflict || rules.length >= 200}
              onClick={() => importInputRef.current?.click()}
            >
              Import JSON
            </StudioButton>
            <StudioButton disabled={!rules.length} onClick={exportRulesJson}>
              Export JSON
            </StudioButton>
          </div>
        </details>
      </div>
    </div>
  );
  if (!dialog) return content;
  return (
    <Dialog
      open={dialog.open}
      onOpenChange={(open) => {
        if (!open) {
          setPreviewPassageId(null);
          clearRecording();
        }
        dialog.onOpenChange(open);
      }}
    >
      <DialogContent
        className="studio studio-modal studio-dictionary-modal"
        onCloseAutoFocus={dialog.onCloseAutoFocus}
      >
        <DialogHeader>
          <DialogTitle>Pronunciation dictionary</DialogTitle>
          <DialogDescription>
            Add a spoken alias or record a guide for a cloned Qwen voice.
          </DialogDescription>
        </DialogHeader>
        <div className="studio-dictionary-scroll">{content}</div>
      </DialogContent>
    </Dialog>
  );
}
