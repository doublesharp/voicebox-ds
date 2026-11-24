import { ArrowDown, ArrowUp, BookOpen, Lock, Plus, Trash2, Unlock } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useStudio } from './context';
import { isJobActive, splitScriptWithChapters } from './domain';
import { EmptyState, Field, StudioButton } from './ui';

export function ScriptEditor({
  emptyAction,
  onOpenPassageSettings,
  onOpenPronunciation,
}: {
  emptyAction?: ReactNode;
  onOpenPassageSettings?: (id: string, opener: HTMLButtonElement) => void;
  onOpenPronunciation?: (opener: HTMLButtonElement) => void;
}) {
  const studio = useStudio();
  const { project, session, save, canMutate } = studio;
  const passageControlId = useId();
  const [pasteOpen, setPasteOpen] = useState(false);
  const [text, setText] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const passages = project.document.passages;
  const generating = new Set(
    project.jobs
      .filter((job) => job.passage_id && isJobActive(job.status))
      .map((job) => job.passage_id),
  );
  const parsed = splitScriptWithChapters(text);
  const missingOrStaleIds = passages
    .filter((passage) => {
      if (passage.locked) return false;
      const take = project.takes.find((item) => item.id === passage.selected_take_id);
      const current = save.drafts[passage.id]?.text ?? passage.text;
      return !take || take.text !== current;
    })
    .map((passage) => passage.id);
  const move = (index: number, delta: number) => {
    const ids = passages.map((p) => p.id);
    [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
    void session.command('reorder_passages', { passage_ids: ids });
  };
  return (
    <section className="studio-script" aria-label="Script editor">
      <Dialog open={pasteOpen} onOpenChange={setPasteOpen}>
        {passages.length > 0 ? (
          <header className="studio-section-title studio-script-toolbar">
            <div>
              <h2>Script</h2>
              <span className="studio-note">
                {passages.length} {passages.length === 1 ? 'passage' : 'passages'}
              </span>
            </div>
            <div className="studio-action-row">
              {onOpenPronunciation && (
                <button
                  type="button"
                  className="studio-quiet"
                  onClick={(event) => onOpenPronunciation(event.currentTarget)}
                >
                  <BookOpen size={15} /> Pronunciation
                </button>
              )}
              {missingOrStaleIds.length > 0 && (
                <button
                  className="studio-quiet"
                  type="button"
                  disabled={!canMutate}
                  onClick={() => {
                    studio.setCheckedPassages(missingOrStaleIds);
                    studio.selectPassage(missingOrStaleIds[0]);
                  }}
                >
                  Select unfinished ({missingOrStaleIds.length})
                </button>
              )}
              <DialogTrigger asChild>
                <button className="studio-quiet" type="button" disabled={!canMutate}>
                  <Plus size={15} /> Add passages
                </button>
              </DialogTrigger>
            </div>
          </header>
        ) : (
          <EmptyState
            title={emptyAction ? 'Start your project' : 'Add a script'}
            action={
              <div className="studio-start-actions">
                <DialogTrigger asChild>
                  <Button type="button" size="sm" className="studio-button" disabled={!canMutate}>
                    <Plus size={15} /> Paste a script
                  </Button>
                </DialogTrigger>
                {emptyAction}
              </div>
            }
          >
            {emptyAction
              ? 'Paste a script to create voice takes, or import audio to build an arrangement.'
              : 'Paste your script to create passages and assign voices.'}
          </EmptyState>
        )}
        <DialogContent className="studio studio-modal">
          <DialogHeader>
            <DialogTitle>Add passages</DialogTitle>
            <DialogDescription>
              Separate passages with blank lines. Prefix a section with <code>## Chapter Name</code>{' '}
              to create YouTube chapter markers automatically.
            </DialogDescription>
          </DialogHeader>
          <Field label="New script">
            <Textarea
              autoFocus
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={7}
            />
          </Field>
          <div className="studio-paste-preview">
            <strong>{parsed.length} passages</strong>
            <ol>
              {parsed.map((part, index) => (
                <li key={`${index}-${part.text.slice(0, 10)}`}>
                  {part.chapter && <strong>[{part.chapter}] </strong>}
                  {part.text}
                </li>
              ))}
            </ol>
          </div>
          <StudioButton
            primary
            disabled={!parsed.length || !canMutate}
            onClick={() => {
              const hasChapters = parsed.some((item) => item.chapter !== null);
              void session
                .command('add_passages', {
                  texts: parsed.map((item) => item.text),
                  ...(hasChapters ? { chapters: parsed.map((item) => item.chapter) } : {}),
                })
                .then((ok) => {
                  if (ok) {
                    setText('');
                    setPasteOpen(false);
                  }
                });
            }}
          >
            Add to script
          </StudioButton>
        </DialogContent>
      </Dialog>
      <div className="studio-passage-list">
        {passages.map((passage, index) => {
          const take = project.takes.find((take) => take.id === passage.selected_take_id);
          const draft = save.drafts[passage.id];
          const currentText = draft?.text ?? passage.text;
          const chapterTitle = draft?.chapter !== undefined ? draft.chapter : passage.chapter;
          const takeCount = project.takes.filter((item) => item.passage_id === passage.id).length;
          const openPassageSettings = (opener: HTMLButtonElement) => {
            if (onOpenPassageSettings) onOpenPassageSettings(passage.id, opener);
            else studio.selectPassage(passage.id);
          };
          const stale = take && take.text !== currentText;
          const differing = project.document.clips.some(
            (clip) => clip.passage_id === passage.id && clip.take_id !== passage.selected_take_id,
          );
          const voiceName = String(
            passage.voice_snapshot?.name ||
              studio.profiles.find((p) => p.id === passage.profile_id)?.name ||
              (passage.profile_id ? 'Saved voice snapshot' : 'Choose a voice'),
          );
          return (
            <article
              key={passage.id}
              className={`studio-passage ${studio.selectedPassageId === passage.id ? 'is-selected' : ''}`}
              aria-label={`Passage ${index + 1}`}
            >
              <div className="studio-passage-heading">
                <label className="studio-check" htmlFor={`${passageControlId}-${index}`}>
                  <Checkbox
                    id={`${passageControlId}-${index}`}
                    aria-label={`Include passage ${index + 1}`}
                    checked={studio.checkedPassages.includes(passage.id)}
                    onCheckedChange={(checked) =>
                      studio.setCheckedPassages(
                        checked
                          ? [...studio.checkedPassages, passage.id]
                          : studio.checkedPassages.filter((id) => id !== passage.id),
                      )
                    }
                  />
                  <span className="studio-mono">{String(index + 1).padStart(2, '0')}</span>
                </label>
                <button
                  type="button"
                  className="studio-speaker"
                  onClick={(event) => openPassageSettings(event.currentTarget)}
                >
                  {voiceName}
                </button>
                {stale && <span className="studio-status-chip">Script changed</span>}
                <button
                  type="button"
                  className="studio-icon-button"
                  aria-label={`${passage.locked ? 'Unlock' : 'Lock'} passage ${index + 1}`}
                  disabled={!canMutate}
                  onClick={() =>
                    void session.command('set_lock', {
                      passage_id: passage.id,
                      locked: !passage.locked,
                    })
                  }
                >
                  {passage.locked ? <Lock size={14} /> : <Unlock size={14} />}
                </button>
              </div>
              <div className="studio-script-field">
                <span aria-hidden="true">{currentText} </span>
                <Textarea
                  aria-label={`Passage ${index + 1} text`}
                  className="studio-script-input"
                  rows={1}
                  value={currentText}
                  disabled={passage.locked || save.status === 'recovery'}
                  onFocus={() => studio.selectPassage(passage.id)}
                  onChange={(event) =>
                    session.editPassage(passage.id, { text: event.target.value })
                  }
                />
              </div>
              {(studio.selectedPassageId === passage.id || chapterTitle) && (
                <details className="studio-passage-chapter">
                  <summary>{chapterTitle || 'Add chapter title'}</summary>
                  <Input
                    aria-label={`Passage ${index + 1} chapter`}
                    placeholder="Chapter title"
                    maxLength={120}
                    value={chapterTitle ?? ''}
                    disabled={passage.locked || save.status === 'recovery'}
                    onFocus={() => studio.selectPassage(passage.id)}
                    onChange={(event) =>
                      session.editPassage(passage.id, { chapter: event.target.value || null })
                    }
                  />
                </details>
              )}
              <div className="studio-passage-footer">
                {takeCount > 0 && (
                  <button
                    className="studio-text-button"
                    type="button"
                    onClick={(event) => openPassageSettings(event.currentTarget)}
                  >
                    {takeCount} {takeCount === 1 ? 'take' : 'takes'}{' '}
                    <span aria-hidden="true">↗</span>
                  </button>
                )}
                {generating.has(passage.id) ? (
                  <span className="studio-note">Generating…</span>
                ) : takeCount === 0 ? (
                  <span className="studio-note">No take yet</span>
                ) : null}
                {differing && (
                  <span className="studio-note studio-timeline-take-note">
                    Timeline uses a different take
                  </span>
                )}
                <div className="studio-passage-actions">
                  <button
                    className="studio-icon-button"
                    type="button"
                    aria-label={`Move passage ${index + 1} up`}
                    disabled={index === 0 || !canMutate}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp size={14} />
                  </button>
                  <button
                    className="studio-icon-button"
                    type="button"
                    aria-label={`Move passage ${index + 1} down`}
                    disabled={index === passages.length - 1 || !canMutate}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown size={14} />
                  </button>
                  <button
                    className="studio-icon-button"
                    type="button"
                    aria-label={`Delete passage ${index + 1}`}
                    disabled={!canMutate || passage.locked}
                    onClick={() => setDeleteId(passage.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </article>
          );
        })}
      </div>
      <Dialog
        open={deleteId !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteId(null);
        }}
      >
        <DialogContent className="studio studio-modal">
          <DialogHeader>
            <DialogTitle>Remove this passage?</DialogTitle>
            <DialogDescription>
              This also removes its timeline clips. Takes remain in project history and the command
              can be undone.
            </DialogDescription>
          </DialogHeader>
          <StudioButton onClick={() => setDeleteId(null)}>Keep passage</StudioButton>
          <StudioButton
            disabled={!canMutate}
            onClick={() => {
              if (deleteId)
                void session.command('delete_passage', { passage_id: deleteId }).then((ok) => {
                  if (ok) setDeleteId(null);
                });
            }}
          >
            Remove passage and clips
          </StudioButton>
        </DialogContent>
      </Dialog>
    </section>
  );
}
