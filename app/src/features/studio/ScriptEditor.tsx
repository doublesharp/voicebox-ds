import { ArrowDown, ArrowUp, Lock, Plus, Trash2, Unlock } from 'lucide-react';
import { useState } from 'react';
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
import { splitScriptWithChapters } from './domain';
import { EmptyState, Field, StudioButton } from './ui';

export function ScriptEditor() {
  const studio = useStudio();
  const { project, session, save, canMutate } = studio;
  const [pasteOpen, setPasteOpen] = useState(false);
  const [text, setText] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const passages = project.document.passages;
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
      <div className="studio-section-title">
        <div>
          <p className="studio-eyebrow">THE WORDS COME FIRST</p>
          <h2>Script</h2>
        </div>
        <span>{passages.length} passages</span>
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
            Select missing / stale ({missingOrStaleIds.length})
          </button>
        )}
        <Dialog open={pasteOpen} onOpenChange={setPasteOpen}>
          <DialogTrigger asChild>
            <button className="studio-quiet" type="button" disabled={!canMutate}>
              <Plus size={15} /> Paste / add
            </button>
          </DialogTrigger>
          <DialogContent className="studio studio-modal">
            <DialogHeader>
              <DialogTitle>Add passages</DialogTitle>
              <DialogDescription>
                Separate passages with blank lines. Prefix a section with{' '}
                <code>## Chapter Name</code> to create YouTube chapter markers automatically.
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
      </div>
      {!passages.length && (
        <EmptyState
          title="Every performance starts with a few words"
          action={
            <StudioButton primary onClick={() => setPasteOpen(true)} disabled={!canMutate}>
              <Plus size={15} /> Paste a script
            </StudioButton>
          }
        >
          Add your script, choose a voice, and make the first take. Your timeline is ready when you
          are.
        </EmptyState>
      )}
      <div className="studio-passage-list">
        {passages.map((passage, index) => {
          const take = project.takes.find((take) => take.id === passage.selected_take_id);
          const draft = save.drafts[passage.id];
          const currentText = draft?.text ?? passage.text;
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
                <label className="studio-check">
                  <input
                    type="checkbox"
                    aria-label={`Include passage ${index + 1}`}
                    checked={studio.checkedPassages.includes(passage.id)}
                    onChange={(e) =>
                      studio.setCheckedPassages(
                        e.target.checked
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
                  onClick={() => studio.selectPassage(passage.id)}
                >
                  {voiceName}
                </button>
                <span className="studio-status-chip">
                  {passage.locked
                    ? 'Locked'
                    : stale
                      ? 'Script changed'
                      : take
                        ? 'Take selected'
                        : 'No take yet'}
                </span>
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
              {(studio.selectedPassageId === passage.id || passage.chapter) && (
                <Input
                  aria-label={`Passage ${index + 1} chapter`}
                  placeholder="Optional YouTube chapter title (e.g. I2S & DMA Pipeline)"
                  maxLength={120}
                  value={
                    draft?.chapter !== undefined ? (draft.chapter ?? '') : (passage.chapter ?? '')
                  }
                  disabled={passage.locked || save.status === 'recovery'}
                  onFocus={() => studio.selectPassage(passage.id)}
                  onChange={(event) =>
                    session.editPassage(passage.id, {
                      chapter: event.target.value || null,
                    })
                  }
                />
              )}
              <Textarea
                aria-label={`Passage ${index + 1} text`}
                className="studio-script-input"
                value={currentText}
                disabled={passage.locked || save.status === 'recovery'}
                onFocus={() => studio.selectPassage(passage.id)}
                onChange={(event) => session.editPassage(passage.id, { text: event.target.value })}
              />
              <div className="studio-passage-footer">
                <button
                  className="studio-text-button"
                  type="button"
                  onClick={() => studio.selectPassage(passage.id)}
                >
                  {project.takes.filter((t) => t.passage_id === passage.id).length} takes{' '}
                  <span aria-hidden="true">↗</span>
                </button>
                {differing && <span className="studio-note">Timeline uses a different take</span>}
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
