import { ArrowRight, Download, FileArchive, Headphones } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { usePlatform } from '@/platform/PlatformContext';
import {
  ArchiveScopeControls,
  archiveScopeQuery,
  completeArchiveScope,
} from './ArchiveScopeControls';
import { useStudio } from './context';
import { isJobActive, preflight, staleRecordings } from './domain';
import { operationId } from './session';
import { useDurableSubmission } from './submissions';
import { Field, StudioButton } from './ui';
import { useRevisionDocument } from './useRevisionDocument';

export function Deliver({
  onCreateCheckpoint,
  onGoToMix,
  onGoToEdit,
}: {
  onCreateCheckpoint?: (onSaved: () => void) => void;
  onGoToMix?: () => void;
  onGoToEdit?: () => void;
}) {
  const studio = useStudio();
  const [open, setOpen] = useState(false);
  const nextAction = useRef<(() => void) | undefined>();
  const platform = usePlatform();
  const { project, client, session, revisionId, setRevisionId } = studio;
  const [kind, setKind] = useState<'mix' | 'stems'>('mix');
  const [format, setFormat] = useState<'wav' | 'mp3'>('wav');
  const [processing, setProcessing] = useState<'dry' | 'processed'>('processed');
  const [publication, setPublication] = useState('');
  const [archiveScope, setArchiveScope] = useState(completeArchiveScope);
  const {
    request,
    rejected,
    discardRejected,
    error: submissionError,
    submit,
  } = useDurableSubmission(session.storage, client.baseUrl, project.id, 'render');
  const [acknowledgedRevision, setAcknowledgedRevision] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Changing source must revoke consent, including when returning to a previously acknowledged source.
  useEffect(() => {
    setAcknowledgedRevision(null);
  }, [revisionId, project.id]);
  const revision = project.revisions.find((r) => r.id === revisionId);
  const checkpoint = useRevisionDocument(client, project.id, revision, open);
  const checkpointLoading = !!revision && !checkpoint.document && !checkpoint.error;
  const allowStale = acknowledgedRevision === `${project.id}:${revisionId}`;
  const stale = checkpoint.document ? staleRecordings(checkpoint.document, project) : [];
  const flight = checkpoint.document
    ? preflight(checkpoint.document, project, allowStale)
    : {
        errors: [
          checkpoint.error || (revision ? 'Loading checkpoint…' : 'Choose a named checkpoint.'),
        ],
        warnings: [],
      };
  const jobs = project.jobs.filter(
    (j) => j.kind === 'render' || j.kind === 'mix' || j.kind === 'stems',
  );
  const files = project.deliverables.filter((file) => file.revision_id === revisionId);
  const hasClips = project.document.clips.length > 0;
  const hasCheckpoint = project.revisions.length > 0;
  const needsTake =
    !hasClips &&
    project.document.passages.length > 0 &&
    !project.document.passages.some((passage) => passage.selected_take_id);
  const render = async () => {
    if (!request && (!revision || flight.errors.length)) return;
    await studio.runAction(async () => {
      await submit(
        () => ({
          idempotency_key: operationId(),
          revision_id: revision!.id,
          kind,
          format,
          processing,
          ...(allowStale ? { allow_stale_audio: true } : {}),
        }),
        (input) => client.render(project.id, input),
      );
    });
  };
  const safeName = project.name.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 100) || 'studio-project';
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className={hasCheckpoint || !!request ? 'studio-primary' : 'studio-quiet'}
        >
          <Download size={15} /> Deliver
        </button>
      </DialogTrigger>
      <DialogContent
        className="studio studio-modal studio-deliver"
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          const action = nextAction.current;
          if (!action) return;
          nextAction.current = undefined;
          event.preventDefault();
          action();
        }}
      >
        <DialogHeader>
          <DialogTitle>Deliver</DialogTitle>
        </DialogHeader>
        {hasCheckpoint ? (
          <Field label="Source checkpoint">
            <select
              value={revisionId}
              disabled={studio.actionBusy || !!request}
              onChange={(event) => {
                setAcknowledgedRevision(null);
                setRevisionId(event.target.value);
              }}
            >
              <option value="">Choose a checkpoint</option>
              {project.revisions.map((revision) => (
                <option key={revision.id} value={revision.id}>
                  {revision.name} · draft {revision.project_revision}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          !request && (
            <div className="studio-preflight">
              <h3>{hasClips ? 'Create a checkpoint to export audio' : 'Add audio to export'}</h3>
              {hasClips && onCreateCheckpoint && (
                <StudioButton
                  primary
                  disabled={!studio.canMutate || studio.actionBusy}
                  onClick={() => {
                    nextAction.current = () => onCreateCheckpoint(() => setOpen(true));
                    setOpen(false);
                  }}
                >
                  Create checkpoint
                </StudioButton>
              )}
              {!hasClips && (
                <div className="studio-action-row">
                  {needsTake && onGoToEdit && (
                    <StudioButton
                      primary
                      onClick={() => {
                        nextAction.current = onGoToEdit;
                        setOpen(false);
                      }}
                    >
                      Go to Edit
                    </StudioButton>
                  )}
                  {onGoToMix && (
                    <StudioButton
                      primary={!needsTake || !onGoToEdit}
                      onClick={() => {
                        nextAction.current = onGoToMix;
                        setOpen(false);
                      }}
                    >
                      <ArrowRight size={15} />
                      Go to Mix
                    </StudioButton>
                  )}
                </div>
              )}
            </div>
          )
        )}
        {(revision || request) && (
          <div className="studio-deliver-options">
            <div className="studio-field-grid">
              <Field label="Output">
                <select
                  value={kind}
                  disabled={studio.actionBusy || !!request}
                  onChange={(event) => setKind(event.target.value as 'mix' | 'stems')}
                >
                  <option value="mix">Stereo mix</option>
                  <option value="stems">Track stems</option>
                </select>
              </Field>
              <Field label="Format">
                <select
                  value={format}
                  disabled={studio.actionBusy || !!request}
                  onChange={(event) => setFormat(event.target.value as 'wav' | 'mp3')}
                >
                  <option value="wav">WAV</option>
                  <option value="mp3">MP3</option>
                </select>
              </Field>
            </div>
            <Field label="Processing">
              <select
                value={processing}
                disabled={studio.actionBusy || !!request}
                onChange={(event) => setProcessing(event.target.value as 'dry' | 'processed')}
              >
                <option value="dry">Dry</option>
                <option value="processed">Processed</option>
              </select>
            </Field>
            <details>
              <summary>About processing</summary>
              <p className="studio-note">
                Dry audio keeps clip gain, fades and placement. Processing adds track effects.
                Master settings apply to the stereo mix only. MP3 requires a server encoder.
              </p>
            </details>
          </div>
        )}
        {checkpointLoading && <output className="studio-note">Loading checkpoint…</output>}
        {revision && !checkpointLoading && flight.errors.length > 0 && (
          <div className="studio-preflight" role="alert">
            {flight.errors.map((error) => (
              <p className="studio-error" key={error}>
                {error}
              </p>
            ))}
          </div>
        )}
        {revision && !checkpointLoading && flight.warnings.length > 0 && (
          <details className="studio-advanced">
            <summary>Render notes</summary>
            {flight.warnings.map((warning) => (
              <p className="studio-note" key={warning}>
                {warning}
              </p>
            ))}
          </details>
        )}
        {!!stale.length && (
          <div className="studio-stale-recordings">
            <h3>Earlier recordings</h3>
            {stale.map(({ clip, passage, take }) => (
              <div key={clip.id}>
                <p>Recorded: {take.text}</p>
                <p>Checkpoint script: {passage.text}</p>
                <p className="studio-note">
                  Clip {clip.id} · take {take.id}. Script or direction differs from the recorded
                  inputs.
                </p>
              </div>
            ))}
            <label className="studio-check">
              <input
                type="checkbox"
                aria-label="Use earlier recording"
                checked={allowStale}
                disabled={studio.actionBusy || !!request}
                onChange={(event) =>
                  setAcknowledgedRevision(
                    event.target.checked ? `${project.id}:${revisionId}` : null,
                  )
                }
              />{' '}
              Use earlier recording for this checkpoint
            </label>
          </div>
        )}
        {request && (
          <p className="studio-note">
            Reconcile the pending {request.kind} · {request.format} request for checkpoint{' '}
            {request.revision_id}. Replay retains its original recording acknowledgement.
          </p>
        )}
        {submissionError && (
          <p role="alert" className="studio-error">
            {submissionError}
          </p>
        )}
        {rejected && (
          <StudioButton disabled={studio.actionBusy} onClick={discardRejected}>
            Dismiss rejected submission
          </StudioButton>
        )}
        {studio.actionError && (
          <p role="alert" className="studio-error">
            {studio.actionError}
          </p>
        )}
        {(revision || request) && (
          <StudioButton
            primary
            onClick={render}
            disabled={(!request && flight.errors.length > 0) || studio.actionBusy}
          >
            {studio.actionBusy
              ? 'Submitting…'
              : request
                ? 'Retry same render request'
                : `Render ${processing} ${kind === 'mix' ? 'mix' : 'stems'}`}
          </StudioButton>
        )}
        {!!jobs.length && (
          <div className="studio-job-list">
            {jobs
              .slice(-5)
              .reverse()
              .map((job) => (
                <div className="studio-job" key={job.id}>
                  <div>
                    <strong>{job.kind}</strong>
                    <span>{job.status}</span>
                    {typeof job.result?.progress === 'number' &&
                      Number.isFinite(job.result.progress) &&
                      job.result.progress >= 0 &&
                      job.result.progress <= 1 && (
                        <progress
                          aria-label="Render progress"
                          max={1}
                          value={job.result.progress}
                        />
                      )}
                    {job.error && <p className="studio-error">{job.error}</p>}
                    {job.result?.measurements != null && (
                      <details>
                        <summary>Reported render-job measurements</summary>
                        <pre>{JSON.stringify(job.result.measurements, null, 2)}</pre>
                      </details>
                    )}
                    {Array.isArray(job.result?.warnings) &&
                      job.result.warnings.map((warning) => (
                        <p className="studio-note" key={String(warning)}>
                          {String(warning)}
                        </p>
                      ))}
                  </div>
                  {isJobActive(job.status) && (
                    <StudioButton
                      disabled={studio.actionBusy}
                      onClick={() => void studio.runAction(() => client.cancelJob(job.id))}
                    >
                      Request cancel
                    </StudioButton>
                  )}
                  {['failed', 'interrupted'].includes(job.status) && (
                    <StudioButton
                      disabled={studio.actionBusy}
                      onClick={() => void studio.runAction(() => client.retryJob(job.id))}
                    >
                      Retry frozen job
                    </StudioButton>
                  )}
                </div>
              ))}
          </div>
        )}
        {files.length > 0 && (
          <div className="studio-section-title">
            <h3>Rendered files</h3>
            <span>{files.length}</span>
          </div>
        )}
        {files.map((file) => (
          <div className="studio-deliverable" key={file.id}>
            <strong>{file.filename || `${file.kind}.${file.format}`}</strong>
            <p>{file.processing ?? 'Existing render'}</p>
            <div className="studio-action-row">
              <StudioButton
                onClick={() =>
                  void studio.playback.audition(
                    client.deliverableAudio(file.id),
                    `Final file · ${file.filename || file.format}`,
                  )
                }
              >
                <Headphones size={14} /> Audition final file
              </StudioButton>
              <StudioButton
                disabled={studio.actionBusy}
                onClick={() =>
                  void studio.runAction(async () => {
                    setPublication('');
                    const name = file.filename || `${safeName}-${file.kind}.${file.format}`;
                    const url = client.deliverableDownload(file.id);
                    const filters = [{ name: 'Audio', extensions: [file.format] }];
                    const receipt = platform.filesystem.saveFromUrl
                      ? await platform.filesystem.saveFromUrl(name, url, filters)
                      : await platform.filesystem.saveFile(
                          name,
                          await client.download(url),
                          filters,
                        );
                    setPublication(
                      receipt?.status === 'saved'
                        ? 'File saved.'
                        : receipt?.status === 'cancelled'
                          ? 'Save cancelled.'
                          : receipt?.status === 'download_started'
                            ? 'Download started.'
                            : 'Save requested; destination confirmation unavailable.',
                    );
                  })
                }
              >
                <Download size={14} /> Save a copy
              </StudioButton>
            </div>
            {file.measurements && (
              <details>
                <summary>Measurements</summary>
                <pre>{JSON.stringify(file.measurements, null, 2)}</pre>
              </details>
            )}
          </div>
        ))}
        {publication && <output aria-live="polite">{publication}</output>}
        <details className="studio-advanced studio-deliver-archive">
          <summary>Project archive</summary>
          <ArchiveScopeControls
            value={archiveScope}
            onChange={setArchiveScope}
            disabled={studio.actionBusy}
          />
          <StudioButton
            disabled={studio.actionBusy}
            onClick={() =>
              void studio.runAction(async () => {
                setPublication('');
                await session.flush();
                if (session.getSnapshot().status !== 'saved')
                  throw new Error(
                    'Save the current draft before exporting an archive. Preserve or reconcile its recovery copy first.',
                  );
                const url = `${client.archiveUrl(project.id)}?${archiveScopeQuery(archiveScope)}`;
                const filters = [{ name: 'Studio project archive', extensions: ['zip'] }];
                const receipt = platform.filesystem.saveFromUrl
                  ? await platform.filesystem.saveFromUrl(`${safeName}.studio.zip`, url, filters)
                  : await platform.filesystem.saveFile(
                      `${safeName}.studio.zip`,
                      await client.download(url),
                      filters,
                    );
                setPublication(
                  receipt?.status === 'saved'
                    ? 'Archive saved.'
                    : receipt?.status === 'cancelled'
                      ? 'Save cancelled.'
                      : receipt?.status === 'download_started'
                        ? 'Download started.'
                        : 'Save requested; destination confirmation unavailable.',
                );
              })
            }
          >
            <FileArchive size={15} /> Export complete project archive
          </StudioButton>
        </details>
      </DialogContent>
    </Dialog>
  );
}
