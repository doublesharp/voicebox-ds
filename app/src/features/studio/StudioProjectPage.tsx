import { Link, useBlocker, useNavigate, useParams } from '@tanstack/react-router';
import {
  Captions,
  ChevronDown,
  ChevronLeft,
  Command,
  LayoutPanelLeft,
  List,
  PanelRight,
  Redo2,
  Save,
  Undo2,
} from 'lucide-react';
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { HelpButton } from '@/components/ui/HelpButton';
import { Hint } from '@/components/ui/Hint';
import { Input } from '@/components/ui/input';
import { stopNative } from '@/lib/audio/playbackOwnership';
import { isCurrentServer } from '@/lib/serverScope';
import { usePlatform } from '@/platform/PlatformContext';
import { usePlayerStore } from '@/stores/playerStore';
import { useServerStore } from '@/stores/serverStore';
import { CaptionsPanel } from './CaptionsPanel';
import { StudioClient, type StudioProfile } from './client';
import { StudioContext } from './context';
import { Deliver } from './Deliver';
import { Director } from './Director';
import { clipFrames, isJobActive, toSamples } from './domain';
import { studioShortcut } from './keyboard';
import { StudioPlayback } from './playback';
import { PronunciationPanel } from './PronunciationPanel';
import { Review } from './Review';
import { ReviewClient } from './review-client';
import { ReviewSessions } from './review-session';
import { ScriptEditor } from './ScriptEditor';
import { StudioTransport } from './StudioTransport';
import { errorMessage, ProjectSession, type RecoveryStorage } from './session';
import { ClipInspector, Mixer, Timeline } from './Timeline';
import type { StudioEngine } from './types';
import { Field, StudioButton } from './ui';
import './studio.css';
import './visuals.css';

type Workspace = 'edit' | 'mix' | 'review';
const storage: RecoveryStorage = {
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
  removeItem: (key) => localStorage.removeItem(key),
};
export function StudioProjectPage() {
  const params = useParams({ strict: false });
  const projectId = params.projectId ?? '';
  const workspace: Workspace =
    params.workspace === 'mix' ? 'mix' : params.workspace === 'review' ? 'review' : 'edit';
  const server = useServerStore((state) => state.serverUrl);
  const serverRevision = useServerStore((state) => state.serverRevision);
  return (
    <ProjectWorkspace
      key={`${serverRevision}:${server}:${projectId}`}
      projectId={projectId}
      workspace={workspace}
      server={server}
      serverRevision={serverRevision}
    />
  );
}
function ProjectWorkspace({
  projectId,
  workspace,
  server,
  serverRevision,
}: {
  projectId: string;
  workspace: Workspace;
  server: string;
  serverRevision: number;
}) {
  const platform = usePlatform();
  const navigate = useNavigate();
  const client = useMemo(() => new StudioClient(server), [server]);
  const session = useMemo(
    () => new ProjectSession(client, projectId, storage),
    [client, projectId],
  );
  const reviewSessions = useMemo(
    () => new ReviewSessions(new ReviewClient(server), projectId, storage),
    [server, projectId],
  );
  useSyncExternalStore(reviewSessions.subscribe, reviewSessions.getSnapshot);
  const save = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const playback = useMemo(
    () =>
      new StudioPlayback(() => {
        usePlayerStore.getState().setIsPlaying(false);
        usePlayerStore.getState().clearAutoPlayFlag();
        return stopNative(() => platform.audio.stopPlayback());
      }),
    [platform.audio],
  );
  const [profiles, setProfiles] = useState<StudioProfile[]>([]);
  const [engines, setEngines] = useState<StudioEngine[]>([]);
  const [capabilitiesError, setCapabilitiesError] = useState<string | null>(null);
  const [selectedPassageId, setSelectedPassageId] = useState<string | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [checkedPassages, setCheckedPassages] = useState<string[]>([]);
  const setPlayhead = useCallback((seconds: number) => playback.seek(seconds), [playback]);
  const [revisionId, setRevisionId] = useState('');
  const [checkpointName, setCheckpointName] = useState('');
  const checkpointNameRef = useRef('');
  const checkpointRequestRef = useRef(false);
  const checkpointDialogEpoch = useRef(0);
  const [checkpointBusy, setCheckpointBusy] = useState(false);
  const [checkpointOpen, setCheckpointOpen] = useState(false);
  const [captionsOpen, setCaptionsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [pronunciationOpen, setPronunciationOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [timelineOpen, setTimelineOpen] = useState<boolean | null>(null);
  const [outlineVisible, setOutlineVisible] = useState<boolean | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const paletteOpener = useRef<HTMLElement | null>(null);
  const inspectorOpener = useRef<HTMLButtonElement | null>(null);
  const pronunciationOpener = useRef<HTMLButtonElement | null>(null);
  const [layout, setLayout] = useState<Record<Workspace, { outline: number; inspector: number }>>(
    () => {
      const defaults = {
        edit: { outline: 190, inspector: 300 },
        mix: { outline: 190, inspector: 280 },
        review: { outline: 190, inspector: 280 },
      };
      try {
        const saved = JSON.parse(localStorage.getItem('voicebox-studio:layout') || '{}');
        for (const mode of ['edit', 'mix', 'review'] as const) {
          if (Number.isFinite(saved[mode]?.outline))
            defaults[mode].outline = Math.max(150, Math.min(280, saved[mode].outline));
          if (Number.isFinite(saved[mode]?.inspector))
            defaults[mode].inspector = Math.max(240, Math.min(420, saved[mode].inspector));
        }
      } catch {
        /* Default layout also works without local preferences. */
      }
      return defaults;
    },
  );
  const alive = useRef(true);
  const busyRef = useRef(false);
  const shellRef = useRef<HTMLElement>(null);
  const project = save.project;
  const canMutate = !!project && ['saved', 'dirty'].includes(save.status);
  useBlocker({
    enableBeforeUnload: false,
    shouldBlockFn: ({ next }) => {
      if (next.pathname.startsWith(`/studio/projects/${encodeURIComponent(projectId)}/`))
        return false;
      const current = session.getSnapshot();
      return (
        (reviewSessions.unsafeToLeave() ||
          (!current.recoverySaved && current.status !== 'saved')) &&
        !window.confirm(
          'Local recovery storage is unavailable. Leave and lose unacknowledged edits? Cancel to export a recovery copy first.',
        )
      );
    },
  });
  useEffect(() => {
    alive.current = true;
    void session.load();
    const poll = setInterval(() => {
      if (!isCurrentServer({ serverUrl: server, serverRevision })) return;
      void session.refresh();
      void reviewSessions.refresh();
    }, 1800);
    const unsubscribe = usePlayerStore.subscribe((state, previous) => {
      if (
        (state.isPlaying && !previous.isPlaying) ||
        (state.shouldAutoPlay && !previous.shouldAutoPlay)
      )
        playback.stop();
    });
    return () => {
      alive.current = false;
      clearInterval(poll);
      unsubscribe();
      session.dispose();
      reviewSessions.dispose();
      playback.dispose();
    };
  }, [session, playback, reviewSessions, server, serverRevision]);
  useEffect(() => {
    const request = new AbortController();
    setCapabilitiesError(null);
    Promise.all([client.profiles(request.signal), client.engines(request.signal)])
      .then(([voices, capabilities]) => {
        if (!request.signal.aborted) {
          setProfiles(voices);
          setEngines(capabilities.items);
        }
      })
      .catch((error) => {
        if (!request.signal.aborted)
          setCapabilitiesError(`Voice capabilities unavailable: ${errorMessage(error)}`);
      });
    return () => request.abort();
  }, [client]);
  useEffect(() => {
    if (
      project &&
      !selectedClipId &&
      (!selectedPassageId || !project.document.passages.some((p) => p.id === selectedPassageId))
    )
      setSelectedPassageId(project.document.passages[0]?.id ?? null);
    if (project && selectedClipId && !project.document.clips.some((c) => c.id === selectedClipId))
      setSelectedClipId(null);
  }, [project, selectedPassageId, selectedClipId]);
  useEffect(() => {
    if (project && !project.revisions.some((r) => r.id === revisionId))
      setRevisionId(project.revisions[project.revisions.length - 1]?.id ?? '');
  }, [project, revisionId]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (
        reviewSessions.unsafeToLeave() ||
        ['dirty', 'saving', 'error', 'conflict', 'recovery'].includes(session.getSnapshot().status)
      ) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [session, reviewSessions]);
  const selectPassage = useCallback((id: string) => {
    setSelectedPassageId(id);
    setSelectedClipId(null);
  }, []);
  const selectClip = useCallback(
    (id: string) => {
      setSelectedClipId(id);
      const clip = session.getSnapshot().project?.document.clips.find((c) => c.id === id);
      setSelectedPassageId(clip?.passage_id ?? null);
    },
    [session],
  );
  const runAction = useCallback(
    async (action: () => Promise<unknown>) => {
      const isCurrent = () => isCurrentServer({ serverUrl: server, serverRevision });
      if (busyRef.current || !isCurrent()) return;
      busyRef.current = true;
      setActionBusy(true);
      setActionError(null);
      try {
        await action();
        if (alive.current && isCurrent()) await session.refresh();
      } catch (error) {
        if (alive.current && isCurrent()) setActionError(errorMessage(error));
      } finally {
        busyRef.current = false;
        if (alive.current && isCurrent()) setActionBusy(false);
      }
    },
    [session, server, serverRevision],
  );
  const toggleTransport = useCallback(() => {
    if (playback.getSnapshot().mode !== 'idle') {
      playback.stop();
      return;
    }
    const latest = session.getSnapshot().project;
    if (latest)
      void playback.timeline(
        latest.document,
        latest.assets,
        (id) => client.assetAudio(id),
        playback.getPlayhead(),
        `Timeline preview · draft ${latest.revision}`,
      );
  }, [playback, session, client]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isCurrentServer({ serverUrl: server, serverRevision })) return;
      const target = event.target as HTMLElement | null;
      const timeline = !!target?.closest?.('[data-studio-timeline]');
      const action = studioShortcut(event, timeline);
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      if (action === 'palette') {
        paletteOpener.current = document.activeElement as HTMLElement;
        setPaletteOpen(true);
      }
      if (action === 'transport') toggleTransport();
      if (action === 'save') void session.flush();
      if (action === 'undo' || action === 'redo') void session.command(action);
      const clip = session
        .getSnapshot()
        .project?.document.clips.find((c) => c.id === selectedClipId);
      if (!clip) return;
      if (action === 'duplicate') void session.command('duplicate_clip', { clip_id: clip.id });
      if (action === 'delete') void session.command('delete_clip', { clip_id: clip.id });
      if (action === 'split') {
        const asset = session
          .getSnapshot()
          .project?.assets.find((asset) => asset.id === clip.asset_id);
        const at = toSamples(playback.getPlayhead());
        if (asset && at > clip.start_sample && at < clip.start_sample + clipFrames(clip, asset))
          void session.command('split_clip', { clip_id: clip.id, at_sample: at });
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [session, selectedClipId, playback, toggleTransport, server, serverRevision]);
  const changeWidth = (panel: 'outline' | 'inspector', value: number) => {
    const next = {
      ...layout,
      [workspace]: {
        ...layout[workspace],
        [panel]: Math.max(
          panel === 'outline' ? 150 : 240,
          Math.min(panel === 'outline' ? 280 : 420, value),
        ),
      },
    };
    setLayout(next);
    try {
      localStorage.setItem('voicebox-studio:layout', JSON.stringify(next));
    } catch {
      /* Layout is optional. */
    }
  };
  if (!project)
    return (
      <section className="studio studio-loading">
        <Link to="/studio/projects">← Projects</Link>
        <h1>
          {save.status === 'loading' ? 'Opening your project…' : 'Project could not be opened'}
        </h1>
        {save.error && <p role="alert">{save.error}</p>}
        <StudioButton onClick={() => void session.load()}>Retry</StudioButton>
      </section>
    );
  const activeJobs = project.jobs.filter((j) => isJobActive(j.status));
  const hasClips = project.document.clips.length > 0;
  const startingEdit =
    workspace === 'edit' &&
    !project.document.passages.length &&
    !hasClips &&
    !project.takes.length &&
    !project.assets.length &&
    save.status !== 'recovery';
  const showTimeline = timelineOpen ?? hasClips;
  const showOutline = outlineVisible ?? workspace !== 'edit';
  const showProjectActions = !startingEdit || project.revision > 0;
  const pronunciationPassage =
    project.document.passages.find((passage) => passage.id === selectedPassageId) ??
    project.document.passages[0];
  const openPronunciation = (opener: HTMLButtonElement) => {
    pronunciationOpener.current = opener;
    setPronunciationOpen(true);
  };
  const statusLabels = {
    loading: 'Loading',
    saved: 'Saved',
    dirty: 'Unsaved changes',
    saving: 'Saving…',
    error: 'Save failed',
    conflict: 'Save conflict',
    recovery: 'Recovery available',
  };
  const resize = (panel: 'outline' | 'inspector') => (
    // biome-ignore lint/a11y/useSemanticElements: This is an interactive adjustable splitter with pointer and keyboard input.
    <div
      role="separator"
      aria-label={`Resize ${panel}`}
      aria-orientation="vertical"
      aria-valuenow={layout[workspace][panel]}
      aria-valuemin={panel === 'outline' ? 150 : 240}
      aria-valuemax={panel === 'outline' ? 280 : 420}
      tabIndex={0}
      className="studio-resizer"
      onKeyDown={(event) => {
        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const delta = (event.key === 'ArrowRight' ? 10 : -10) * (panel === 'inspector' ? -1 : 1);
          changeWidth(
            panel,
            event.key === 'Home' ? 0 : event.key === 'End' ? 999 : layout[workspace][panel] + delta,
          );
        }
      }}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.dataset.startX = String(event.clientX);
        event.currentTarget.dataset.startWidth = String(layout[workspace][panel]);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          changeWidth(
            panel,
            Number(event.currentTarget.dataset.startWidth) +
              (event.clientX - Number(event.currentTarget.dataset.startX)) *
                (panel === 'inspector' ? -1 : 1),
          );
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
    />
  );
  const outline = (
    <div className="studio-outline-content">
      <h3>Outline</h3>
      <div className="studio-outline-list">
        {project.document.passages.map((p, index) => (
          <button
            type="button"
            key={p.id}
            className={selectedPassageId === p.id ? 'is-selected' : ''}
            onClick={() => {
              selectPassage(p.id);
              setOutlineOpen(false);
              const input = shellRef.current?.querySelector(
                `[aria-label="Passage ${index + 1} text"]`,
              ) as HTMLTextAreaElement | null;
              input?.focus();
              input?.scrollIntoView({ block: 'nearest' });
            }}
          >
            <span>{String(index + 1).padStart(2, '0')}</span>
            <strong>{p.text || 'Empty passage'}</strong>
          </button>
        ))}
      </div>
    </div>
  );
  return (
    <StudioContext.Provider
      value={{
        client,
        project,
        session,
        save,
        profiles,
        engines,
        capabilitiesError,
        playback,
        selectedPassageId,
        selectedClipId,
        checkedPassages,
        setCheckedPassages,
        selectPassage,
        selectClip,
        playhead: playback.getPlayhead?.() ?? 0,
        setPlayhead,
        revisionId,
        setRevisionId,
        actionBusy,
        actionError,
        runAction,
        canMutate,
        reviewSessions,
      }}
    >
      <section
        ref={shellRef}
        className={`studio studio-shell workspace-${workspace}`}
        style={
          {
            '--studio-outline-width': `${layout[workspace].outline}px`,
            '--studio-inspector-width': `${layout[workspace].inspector}px`,
          } as CSSProperties
        }
        aria-label={`${project.name} studio`}
      >
        <header className="studio-project-header">
          <Link to="/studio/projects" className="studio-back" aria-label="Back to projects">
            <ChevronLeft size={18} />
          </Link>
          <div className="studio-title-block">
            <Input
              aria-label="Project name"
              key={`${project.id}:${project.name}`}
              defaultValue={project.name}
              disabled={!canMutate}
              onBlur={(event) => {
                if (!isCurrentServer({ serverUrl: server, serverRevision })) return;
                const name = event.target.value.trim();
                if (!name) event.target.value = project.name;
                else if (name !== project.name) void session.command('update_project', { name });
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
            />
            <output className={`studio-save-state state-${save.status}`}>
              {statusLabels[save.status]}
              {activeJobs.length > 0 ? ` · ${activeJobs.length} active jobs` : ''}
            </output>
          </div>
          <div className="studio-header-actions">
            {showProjectActions && (
              <>
                <StudioButton
                  disabled={!canMutate}
                  onClick={() => void session.command('undo')}
                  title="Undo project command"
                >
                  <Undo2 size={15} />
                  <span className="studio-wide-label">Undo</span>
                </StudioButton>
                <StudioButton
                  disabled={!canMutate}
                  onClick={() => void session.command('redo')}
                  title="Redo project command"
                >
                  <Redo2 size={15} />
                  <span className="studio-wide-label">Redo</span>
                </StudioButton>
              </>
            )}
            <Dialog
              open={checkpointOpen}
              onOpenChange={(next) => {
                if (!next) checkpointDialogEpoch.current += 1;
                setCheckpointOpen(next);
              }}
            >
              {showProjectActions && (
                <DialogTrigger asChild>
                  <button className="studio-quiet" type="button" disabled={!canMutate}>
                    <Save size={15} />
                    <span className="studio-wide-label">Checkpoint</span>
                  </button>
                </DialogTrigger>
              )}
              <DialogContent className="studio studio-modal">
                <DialogHeader>
                  <DialogTitle>Keep this moment.</DialogTitle>
                  <DialogDescription>
                    Save an immutable checkpoint with pinned audio and mix settings. You can review,
                    restore, or deliver it later.
                  </DialogDescription>
                </DialogHeader>
                <Field label="Checkpoint name">
                  <Input
                    autoFocus
                    value={checkpointName}
                    onChange={(e) => {
                      checkpointNameRef.current = e.target.value;
                      setCheckpointName(e.target.value);
                    }}
                    placeholder="Client review 01"
                  />
                </Field>
                <StudioButton
                  primary
                  disabled={!checkpointName.trim() || !canMutate || checkpointBusy}
                  onClick={() => {
                    const scope = { serverUrl: server, serverRevision };
                    const name = checkpointNameRef.current;
                    if (
                      checkpointRequestRef.current ||
                      !name.trim() ||
                      !canMutate ||
                      !isCurrentServer(scope)
                    )
                      return;
                    const epoch = checkpointDialogEpoch.current;
                    checkpointRequestRef.current = true;
                    setCheckpointBusy(true);
                    void session
                      .checkpoint(name.trim())
                      .then((ok) => {
                        if (
                          ok &&
                          alive.current &&
                          isCurrentServer(scope) &&
                          checkpointDialogEpoch.current === epoch &&
                          checkpointNameRef.current === name
                        ) {
                          setCheckpointOpen(false);
                          checkpointNameRef.current = '';
                          setCheckpointName('');
                          const revisions = session.getSnapshot().project?.revisions ?? [];
                          const latest = revisions[revisions.length - 1];
                          if (latest) setRevisionId(latest.id);
                        }
                      })
                      .catch((error) => {
                        if (
                          alive.current &&
                          isCurrentServer(scope) &&
                          checkpointDialogEpoch.current === epoch
                        )
                          setActionError(errorMessage(error));
                      })
                      .finally(() => {
                        checkpointRequestRef.current = false;
                        if (alive.current && isCurrentServer(scope)) setCheckpointBusy(false);
                      });
                  }}
                >
                  Create checkpoint
                </StudioButton>
                {save.error && (
                  <p role="alert" className="studio-error">
                    {save.error}
                  </p>
                )}
              </DialogContent>
            </Dialog>
            {(!startingEdit || project.revisions.length > 0) && (
              <Deliver onCreateCheckpoint={() => setCheckpointOpen(true)} />
            )}
          </div>
        </header>
        <div className="studio-workspace-bar">
          <nav className="studio-workspace-tabs" aria-label="Project workspace">
            {(['edit', 'mix', 'review'] as const).map((mode) => (
              <Hint
                key={mode}
                content={
                  { edit: 'Script & takes', mix: 'Arrange & mix', review: 'Review & approve' }[mode]
                }
              >
                <Link
                  to="/studio/projects/$projectId/$workspace"
                  params={{ projectId, workspace: mode }}
                  className={workspace === mode ? 'is-active' : ''}
                  aria-current={workspace === mode ? 'page' : undefined}
                >
                  <span>
                    {mode[0].toUpperCase() + mode.slice(1)}
                    <small className="app-workspace-description">
                      {
                        {
                          edit: 'Script & takes',
                          mix: 'Arrange & mix',
                          review: 'Review & approve',
                        }[mode]
                      }
                    </small>
                  </span>
                </Link>
              </Hint>
            ))}
          </nav>
          {(!startingEdit || project.revisions.length > 0) && (
            <>
              <select
                className="studio-checkpoint-picker"
                aria-label="Current checkpoint"
                value={revisionId}
                onChange={(event) => setRevisionId(event.target.value)}
              >
                <option value="">Checkpoints</option>
                {project.revisions.map((revision) => (
                  <option key={revision.id} value={revision.id}>
                    {revision.name}
                  </option>
                ))}
              </select>
              <HelpButton label="About checkpoints">
                A checkpoint is a saved, unchangeable version you can review, restore or deliver.
              </HelpButton>
            </>
          )}
          <div className="studio-action-row">
            <Dialog open={captionsOpen} onOpenChange={setCaptionsOpen}>
              {!startingEdit && (
                <DialogTrigger asChild>
                  <button
                    type="button"
                    className="studio-quiet"
                    aria-label="Open captions and video timing"
                  >
                    <Captions size={16} /> Captions &amp; video
                  </button>
                </DialogTrigger>
              )}
              <DialogContent className="studio studio-modal studio-caption-modal">
                <DialogHeader>
                  <DialogTitle>Captions &amp; video timing</DialogTitle>
                  <DialogDescription>
                    Preview a reference video, set scene targets, and review captions against the
                    final arrangement.
                  </DialogDescription>
                </DialogHeader>
                <CaptionsPanel />
              </DialogContent>
            </Dialog>
            {!startingEdit && (
              <>
                <button
                  type="button"
                  className="studio-icon-button studio-outline-toggle"
                  aria-label="Toggle outline"
                  aria-pressed={showOutline}
                  title={showOutline ? 'Hide outline' : 'Show outline'}
                  onClick={() => setOutlineVisible(!showOutline)}
                >
                  <LayoutPanelLeft size={17} />
                </button>
                <Dialog open={outlineOpen} onOpenChange={setOutlineOpen}>
                  <DialogTrigger asChild>
                    <button
                      type="button"
                      className="studio-icon-button studio-drawer-toggle"
                      aria-label="Open project outline"
                    >
                      <List size={17} />
                    </button>
                  </DialogTrigger>
                  <DialogContent className="studio studio-modal">
                    <DialogHeader>
                      <DialogTitle>Project outline</DialogTitle>
                      <DialogDescription>Passages and cast at a glance.</DialogDescription>
                    </DialogHeader>
                    {outline}
                  </DialogContent>
                </Dialog>
                <Dialog open={inspectorOpen} onOpenChange={setInspectorOpen}>
                  <DialogTrigger asChild>
                    <button type="button" className="studio-quiet studio-drawer-toggle">
                      <PanelRight size={16} /> Inspector
                    </button>
                  </DialogTrigger>
                  <DialogContent
                    className="studio studio-modal"
                    onCloseAutoFocus={(event) => {
                      if (!inspectorOpener.current) return;
                      event.preventDefault();
                      inspectorOpener.current.focus();
                      inspectorOpener.current = null;
                    }}
                  >
                    <DialogHeader>
                      <DialogTitle>
                        {workspace === 'mix' ? 'Mix settings' : 'Passage settings'}
                      </DialogTitle>
                      <DialogDescription>
                        Settings follow the selected passage or project mix.
                      </DialogDescription>
                    </DialogHeader>
                    {workspace === 'mix' ? (
                      <Mixer />
                    ) : (
                      <>
                        {selectedClipId && <ClipInspector />}
                        <Director onOpenPronunciation={openPronunciation} />
                      </>
                    )}
                  </DialogContent>
                </Dialog>
              </>
            )}
            <button
              type="button"
              className="studio-icon-button"
              aria-label="Open command palette"
              onClick={(event) => {
                paletteOpener.current = event.currentTarget;
                setPaletteOpen(true);
              }}
            >
              <Command size={16} />
            </button>
          </div>
        </div>
        {(!save.recoverySaved || ['error', 'conflict', 'recovery'].includes(save.status)) && (
          <div className="studio-banner" role="alert">
            <div>
              <strong>
                {save.status === 'recovery'
                  ? 'Unfinished edits found'
                  : save.status === 'conflict'
                    ? 'A newer draft was saved elsewhere'
                    : !save.recoverySaved
                      ? 'Local recovery storage unavailable'
                      : 'Your changes have not been saved'}
              </strong>
              <p>
                {save.error ||
                  (!save.recoverySaved
                    ? 'Text remains visible. Export a recovery copy before leaving; local durability is not guaranteed.'
                    : 'Recover the local copy, or explicitly reload the saved draft.')}
              </p>
            </div>
            <div className="studio-action-row">
              {save.status === 'error' && (
                <StudioButton onClick={() => void session.retry()}>Retry same save</StudioButton>
              )}
              {save.status === 'recovery' && session.hasRecoverableEdits() && (
                <StudioButton onClick={() => session.recover()}>Recover local edits</StudioButton>
              )}
              <StudioButton
                onClick={() =>
                  void runAction(() =>
                    platform.filesystem.saveFile(
                      `${project.name.replace(/[^a-zA-Z0-9-]/g, '-')}.recovery.json`,
                      new Blob([session.recoveryCopy()], { type: 'application/json' }),
                      [{ name: 'Recovery journal', extensions: ['json'] }],
                    ),
                  )
                }
              >
                Export recovery copy
              </StudioButton>
              <StudioButton
                onClick={() => {
                  if (
                    window.confirm(
                      'Reload the saved draft and discard this local recovery copy? Export it first if you need to keep it.',
                    )
                  )
                    void session.reloadSaved();
                }}
              >
                Reload saved draft
              </StudioButton>
            </div>
          </div>
        )}
        {actionError && (
          <div className="studio-banner" role="alert">
            <p>{actionError}</p>
            <StudioButton onClick={() => setActionError(null)}>Dismiss</StudioButton>
          </div>
        )}
        <div className="studio-work-area">
          {!startingEdit && showOutline && <aside className="studio-outline">{outline}</aside>}
          {!startingEdit && showOutline && resize('outline')}
          <div className="studio-main-pane">
            <div className="studio-workspace-scroll" hidden={workspace !== 'edit'}>
              <ScriptEditor
                emptyAction={startingEdit ? <Timeline importOnly /> : undefined}
                onOpenPronunciation={openPronunciation}
                onOpenPassageSettings={(id, opener) => {
                  selectPassage(id);
                  if (window.matchMedia?.('(max-width: 1199px)').matches) {
                    inspectorOpener.current = opener;
                    setInspectorOpen(true);
                  }
                }}
              />
            </div>
            <div className="studio-workspace-scroll" hidden={workspace !== 'mix'}>
              <Timeline />
            </div>
            <div className="studio-workspace-scroll" hidden={workspace !== 'review'}>
              <Review />
            </div>
            {workspace === 'edit' && !startingEdit && (
              <div className="studio-bottom-timeline">
                <button
                  type="button"
                  className="studio-timeline-disclosure"
                  aria-expanded={showTimeline}
                  onClick={() => setTimelineOpen(!showTimeline)}
                >
                  <ChevronDown size={14} /> Timeline{' '}
                  <span>{project.document.clips.length} clips</span>
                </button>
                {showTimeline && <Timeline compact />}
              </div>
            )}
          </div>
          {!startingEdit && workspace !== 'review' && resize('inspector')}
          {!startingEdit && workspace !== 'review' && (
            <aside className="studio-desktop-inspector">
              {workspace === 'mix' ? (
                <Mixer />
              ) : (
                <>
                  {selectedClipId && <ClipInspector />}
                  <Director onOpenPronunciation={openPronunciation} />
                </>
              )}
            </aside>
          )}
        </div>
        {!!project.jobs.length && (
          <details className="studio-jobs-disclosure">
            <summary>
              {activeJobs.length ? `${activeJobs.length} jobs running` : 'Recent jobs'}
              <span>
                {project.jobs.filter((j) => ['failed', 'interrupted'].includes(j.status)).length}{' '}
                need attention
              </span>
            </summary>
            <div className="studio-job-list">
              {project.jobs
                .slice(-8)
                .reverse()
                .map((job) => (
                  <div className="studio-job" key={job.id}>
                    <div>
                      <strong>{job.kind}</strong>
                      <span>{job.phase?.replace(/_/g, ' ') ?? job.status}</span>
                      {job.error && <p className="studio-error">{job.error}</p>}
                    </div>
                    {isJobActive(job.status) && (
                      <StudioButton
                        disabled={actionBusy}
                        onClick={() => void runAction(() => client.cancelJob(job.id))}
                      >
                        Request cancel
                      </StudioButton>
                    )}
                    {['failed', 'interrupted'].includes(job.status) && (
                      <StudioButton
                        disabled={actionBusy}
                        onClick={() => void runAction(() => client.retryJob(job.id))}
                      >
                        Retry frozen request
                      </StudioButton>
                    )}
                  </div>
                ))}
            </div>
          </details>
        )}
        {!startingEdit && (
          <StudioTransport
            toggleTransport={toggleTransport}
            hideWhenIdle={workspace === 'edit' && !hasClips && !project.takes.length}
          />
        )}
        {pronunciationPassage && (
          <PronunciationPanel
            passage={pronunciationPassage}
            currentText={save.drafts?.[pronunciationPassage.id]?.text ?? pronunciationPassage.text}
            dialog={{
              open: pronunciationOpen,
              onOpenChange: setPronunciationOpen,
              onCloseAutoFocus: (event) => {
                event.preventDefault();
                pronunciationOpener.current?.focus();
              },
            }}
          />
        )}
        <Dialog open={paletteOpen} onOpenChange={setPaletteOpen}>
          <DialogContent
            className="studio studio-modal"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              paletteOpener.current?.focus();
            }}
          >
            <DialogHeader>
              <DialogTitle>Project commands</DialogTitle>
              <DialogDescription>
                Text fields keep their own Space and undo shortcuts. Timeline S, duplicate, and
                delete require timeline focus.
              </DialogDescription>
            </DialogHeader>
            {(['edit', 'mix', 'review'] as const).map((mode) => (
              <StudioButton
                key={mode}
                onClick={() => {
                  setPaletteOpen(false);
                  void navigate({
                    to: '/studio/projects/$projectId/$workspace',
                    params: { projectId, workspace: mode },
                  });
                }}
              >
                Open {mode}
              </StudioButton>
            ))}
            {startingEdit && (
              <StudioButton
                onClick={() => {
                  setPaletteOpen(false);
                  setCaptionsOpen(true);
                }}
              >
                Captions &amp; video
              </StudioButton>
            )}
            <StudioButton
              onClick={() => {
                setPaletteOpen(false);
                setCheckpointOpen(true);
              }}
            >
              Create checkpoint
            </StudioButton>
            <StudioButton
              onClick={() => {
                setPaletteOpen(false);
                setLayout({
                  edit: { outline: 190, inspector: 300 },
                  mix: { outline: 190, inspector: 280 },
                  review: { outline: 190, inspector: 280 },
                });
                try {
                  localStorage.removeItem('voicebox-studio:layout');
                } catch {
                  /* Defaults still apply in memory. */
                }
              }}
            >
              Reset layout
            </StudioButton>
          </DialogContent>
        </Dialog>
      </section>
    </StudioContext.Provider>
  );
}
