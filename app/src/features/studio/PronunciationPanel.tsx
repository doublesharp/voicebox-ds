import { useEffect, useMemo, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { hasMissingRegenerationReferences } from './ArchiveScopeControls';
import { useStudio } from './context';
import { engineForPassage } from './domain';
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
}: {
  passage: StudioPassage;
  currentText: string;
}) {
  const studio = useStudio();
  const { project, session, client, profiles, engines, save } = studio;
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
  const changed = JSON.stringify(rules) !== serialized;
  const conflict = !!draft && draft.base !== serialized && changed;
  const invalid = pronunciationError(rules);
  const preview = previewPronunciation(currentText, rules, passage.profile_id);
  const jargonSuggestions = useMemo(
    () => scanScriptJargon(project.document.passages, rules),
    [project.document.passages, rules],
  );
  const disabled = !studio.canMutate || studio.actionBusy || unreadable;
  const engine = engineForPassage(passage, profiles, engines);
  // Auditions own an independent pending request, so another generate action can
  // never be mistaken for a pronunciation audition or change its adoption intent.
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

  const edit = (next: PronunciationRule[]) => {
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
    edit(rules.map((rule) => (rule.id === id ? { ...rule, ...change } : rule)));

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
        rules: rules.map(({ source, replacement, case_sensitive, whole_word }) => ({
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
      setNotice(
        'Dictionary saved. Existing audio is retained; regenerate affected passages to hear the new aliases.',
      );
    }
  };
  const audition = async () => {
    if (!request) {
      await session.flush();
      if (session.getSnapshot().status !== 'saved') return;
    }
    await studio.runAction(async () => {
      await submit(
        () => ({
          idempotency_key: operationId(),
          passage_ids: [passage.id],
          count: 1,
          adopt: false,
        }),
        (input) => client.generate(project.id, input),
      );
      if (alive.current)
        setNotice(
          'Pronunciation audition queued as an alternative take. Play it from Takes when ready.',
        );
    });
  };

  return (
    <details className="studio-advanced studio-pronunciation">
      <summary>Pronunciation dictionary · {saved.length} rules</summary>
      <p className="studio-note">
        Write spoken aliases for names, acronyms, and technical terms. Rules apply once, using the
        longest match; a voice rule wins a tie. The script keeps its original spelling.
      </p>
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
      {importError && (
        <p role="alert" className="studio-error">
          {importError}
        </p>
      )}
      {jargonSuggestions.length > 0 && (
        <details className="studio-advanced">
          <summary>Uncovered acronyms &amp; firmware terms ({jargonSuggestions.length})</summary>
          <p className="studio-note">
            Detected acronyms, hex literals, units, and identifiers in your script without a
            pronunciation rule yet.
          </p>
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
        <fieldset key={rule.id} className="studio-take">
          <legend>Rule {index + 1}</legend>
          <Field label="Written word or phrase">
            <Input
              aria-label={`Rule ${index + 1} written text`}
              value={rule.source}
              maxLength={200}
              disabled={disabled || conflict}
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
          <Field label="Rule scope">
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
          <label className="studio-check">
            <input
              type="checkbox"
              aria-label={`Rule ${index + 1} case sensitive`}
              checked={rule.case_sensitive}
              disabled={disabled || conflict}
              onChange={(event) => update(rule.id, { case_sensitive: event.target.checked })}
            />{' '}
            Match case
          </label>
          <label className="studio-check">
            <input
              type="checkbox"
              aria-label={`Rule ${index + 1} whole words`}
              checked={rule.whole_word}
              disabled={disabled || conflict}
              onChange={(event) => update(rule.id, { whole_word: event.target.checked })}
            />{' '}
            Whole words only
          </label>
          <StudioButton
            disabled={disabled || conflict}
            onClick={() => edit(rules.filter((item) => item.id !== rule.id))}
          >
            Remove rule {index + 1}
          </StudioButton>
        </fieldset>
      ))}
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
      <div className="studio-action-row">
        <StudioButton disabled={disabled || !changed || !!invalid || conflict} onClick={saveRules}>
          Save dictionary
        </StudioButton>
        {(draft || unreadable) && (
          <StudioButton disabled={studio.actionBusy} onClick={discard}>
            Discard dictionary draft
          </StudioButton>
        )}
      </div>
      {conflict && (
        <p role="alert" className="studio-error">
          Saved rules changed while this draft was open. Your draft is retained locally; discard it
          to load the saved dictionary before editing.
        </p>
      )}
      {changed && invalid && <output className="studio-note">{invalid}</output>}
      {storageError && (
        <p role="alert" className="studio-error">
          {storageError}
        </p>
      )}
      <h4>Spoken text preview</h4>
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
      ) : (
        <p className="studio-note">No substitutions in this passage.</p>
      )}
      {changed && (
        <p className="studio-note">
          Preview includes your unsaved dictionary draft. Save it before auditioning.
        </p>
      )}
      <StudioButton
        disabled={
          studio.actionBusy ||
          (!request &&
            (disabled ||
              changed ||
              passage.locked ||
              !engine?.ready ||
              !passage.voice_snapshot ||
              hasMissingRegenerationReferences(passage.voice_snapshot) ||
              save.status === 'recovery'))
        }
        onClick={audition}
      >
        {request ? 'Retry pronunciation audition' : 'Audition pronunciation'}
      </StudioButton>
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
      {notice && <output className="studio-note">{notice}</output>}
    </details>
  );
}
