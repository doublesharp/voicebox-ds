import { Link, useNavigate } from '@tanstack/react-router';
import {
  ChevronRight,
  Ellipsis,
  FileArchive,
  FolderOpen,
  Plus,
  Search,
  Upload,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useServerStore } from '@/stores/serverStore';
import { type LegacyStory, StudioClient } from './client';
import { splitScript } from './domain';
import { StorageCleanupDialog } from './StorageCleanupDialog';
import { errorMessage } from './session';
import type { StudioProject, StudioProjectSummary } from './types';
import { Field, StudioButton } from './ui';
import './studio.css';

export function ProjectsPage() {
  const serverUrl = useServerStore((state) => state.serverUrl);
  const client = useMemo(() => new StudioClient(serverUrl), [serverUrl]);
  const navigate = useNavigate();
  const [projects, setProjects] = useState<StudioProjectSummary[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [storyOpen, setStoryOpen] = useState(false);
  const [stories, setStories] = useState<LegacyStory[]>([]);
  const [storiesLoading, setStoriesLoading] = useState(false);
  const [storyId, setStoryId] = useState('');
  const [name, setName] = useState('');
  const [label, setLabel] = useState('');
  const [script, setScript] = useState('');
  const [language, setLanguage] = useState('en');
  const archiveInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const desktopCreateButton = useRef<HTMLButtonElement>(null);
  const [toolbarTarget, setToolbarTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (typeof document !== 'undefined')
      setToolbarTarget(document.getElementById('desktop-toolbar-context-actions'));
  }, []);
  const epoch = useRef(0);
  const busyRef = useRef(false);
  const activeClient = useRef(client);
  useEffect(() => {
    activeClient.current = client;
    epoch.current++;
    busyRef.current = false;
    setBusy(false);
    return () => {
      epoch.current++;
    };
  }, [client]);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const token = epoch.current;
      setLoading(true);
      setError(null);
      try {
        const response = await client.projects(signal);
        if (!signal?.aborted && token === epoch.current && activeClient.current === client)
          setProjects(response.items);
      } catch (error) {
        if (!signal?.aborted && token === epoch.current && activeClient.current === client)
          setError(errorMessage(error));
      } finally {
        if (!signal?.aborted && token === epoch.current && activeClient.current === client)
          setLoading(false);
      }
    },
    [client],
  );
  useEffect(() => {
    const request = new AbortController();
    void load(request.signal);
    return () => request.abort();
  }, [load]);
  useEffect(() => {
    if (!storyOpen) return;
    const request = new AbortController();
    setStoriesLoading(true);
    setError(null);
    client
      .stories(request.signal)
      .then((items) => {
        if (!request.signal.aborted) setStories(items);
      })
      .catch((error) => {
        if (!request.signal.aborted) setError(errorMessage(error));
      })
      .finally(() => {
        if (!request.signal.aborted) setStoriesLoading(false);
      });
    return () => request.abort();
  }, [client, storyOpen]);
  const openProject = async (action: () => Promise<StudioProject>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const token = epoch.current;
    setBusy(true);
    setError(null);
    try {
      const project = await action();
      if (token !== epoch.current) return;
      await navigate({
        to: '/studio/projects/$projectId/$workspace',
        params: { projectId: project.id, workspace: 'edit' },
      });
    } catch (error) {
      if (token === epoch.current) setError(errorMessage(error));
    } finally {
      if (token === epoch.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };
  const filtered = projects.filter((p) =>
    `${p.name} ${p.client_label ?? ''}`.toLowerCase().includes(search.toLowerCase()),
  );
  const paragraphs = splitScript(script);
  const projectMenus = (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="studio-quiet" disabled={busy}>
            <Upload size={15} aria-hidden="true" /> Import
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => archiveInput.current?.click()}>
            <FileArchive size={15} className="mr-2" /> Project archive…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setStoryOpen(true)}>Copy from Story…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <details className="studio-project-more">
        <summary className="studio-quiet" aria-label="More project actions">
          <Ellipsis size={16} aria-hidden="true" />
        </summary>
        <div className="absolute right-0 z-20 mt-1 rounded-lg border bg-popover p-2 shadow-md">
          <StorageCleanupDialog key={client.baseUrl} baseUrl={client.baseUrl} projects={projects} />
        </div>
      </details>
    </>
  );
  return (
    <section className="studio studio-projects" aria-label="Studio projects">
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <header className="studio-landing-header">
          <h1>Projects</h1>
          <div className="studio-project-actions">
            {!toolbarTarget && projectMenus}
            <DialogTrigger asChild>
              <button className="studio-primary" type="button" hidden={!!toolbarTarget}>
                <Plus size={16} aria-hidden="true" /> New project
              </button>
            </DialogTrigger>
          </div>
        </header>
        <DialogContent
          className="studio studio-modal"
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            if (toolbarTarget && desktopCreateButton.current) {
              event.preventDefault();
              desktopCreateButton.current.focus();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void openProject(() =>
                client.createProject({
                  name: name.trim(),
                  client_label: label.trim() || undefined,
                  script,
                  language,
                }),
              );
            }}
          >
            <Field label="Project name">
              <Input
                autoFocus
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={200}
              />
            </Field>
            <Field label="Script">
              <Textarea
                value={script}
                onChange={(e) => setScript(e.target.value)}
                rows={5}
                placeholder="Separate passages with a blank line."
              />
            </Field>
            {paragraphs.length > 1 && (
              <details className="studio-paste-preview">
                <summary>{paragraphs.length} passages</summary>
                <ol>
                  {paragraphs.map((text, index) => (
                    <li key={`${index}-${text.slice(0, 20)}`}>{text}</li>
                  ))}
                </ol>
              </details>
            )}
            <details className="studio-project-options">
              <summary>Project settings</summary>
              <div className="studio-field-grid">
                <Field label="Client / collection">
                  <Input value={label} onChange={(event) => setLabel(event.target.value)} />
                </Field>
                <Field label="Language code">
                  <Input
                    required
                    value={language}
                    onChange={(event) => setLanguage(event.target.value)}
                  />
                </Field>
              </div>
            </details>
            {error && (
              <p role="alert" className="studio-error">
                {error}
              </p>
            )}
            <button
              className="studio-primary"
              type="submit"
              disabled={busy || !name.trim() || !language.trim()}
            >
              {busy ? 'Creating…' : 'Create project'}
            </button>
          </form>
        </DialogContent>
      </Dialog>
      {toolbarTarget &&
        createPortal(
          <div className="studio studio-project-actions is-desktop">
            <button
              type="button"
              className="desktop-toolbar-button"
              aria-label="Focus project search"
              onClick={() => searchInput.current?.focus()}
            >
              <Search size={16} aria-hidden="true" />
            </button>
            {projectMenus}
            <button
              ref={desktopCreateButton}
              type="button"
              className="desktop-toolbar-primary"
              aria-haspopup="dialog"
              onClick={() => setCreateOpen(true)}
            >
              <Plus size={15} aria-hidden="true" /> New project
            </button>
          </div>,
          toolbarTarget,
        )}
      <div className="studio-project-toolbar">
        <div className="studio-search">
          <Search size={16} aria-hidden="true" />
          <Input
            ref={searchInput}
            aria-label="Search projects"
            placeholder="Search projects or clients"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Dialog open={storyOpen} onOpenChange={setStoryOpen}>
          <DialogContent className="studio studio-modal" aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>Copy from Story</DialogTitle>
            </DialogHeader>
            <Field label="Story">
              <select
                value={storyId}
                onChange={(event) => setStoryId(event.target.value)}
                disabled={storiesLoading || busy}
              >
                <option value="">{storiesLoading ? 'Loading Stories…' : 'Choose a Story'}</option>
                {stories.map((story) => (
                  <option key={story.id} value={story.id}>
                    {story.name}
                  </option>
                ))}
              </select>
            </Field>
            {!storiesLoading && !stories.length && <p>No Stories yet.</p>}
            {error && (
              <p role="alert" className="studio-error">
                {error}
              </p>
            )}
            <StudioButton
              primary
              disabled={!storyId || busy}
              onClick={() => void openProject(() => client.importStory(storyId))}
            >
              {busy ? 'Importing…' : 'Create studio copy'}
            </StudioButton>
          </DialogContent>
        </Dialog>
        <input
          ref={archiveInput}
          type="file"
          accept=".zip,application/zip"
          className="sr-only"
          aria-label="Import studio archive"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void openProject(() => client.importArchive(file));
          }}
        />
      </div>
      {error && !createOpen && !storyOpen && (
        <div className="studio-banner" role="alert">
          <span>{error}</span>
          <StudioButton onClick={() => void load()}>Retry loading</StudioButton>
        </div>
      )}
      {busy && !createOpen && !storyOpen && <output>Importing project…</output>}
      {loading ? (
        <p aria-live="polite" className="studio-loading">
          Loading projects…
        </p>
      ) : filtered.length ? (
        <div className="studio-project-grid">
          {filtered.map((project) => (
            <Link
              key={project.id}
              to="/studio/projects/$projectId/$workspace"
              params={{ projectId: project.id, workspace: 'edit' }}
              className="studio-project-card"
            >
              <span className="studio-project-icon" aria-hidden="true">
                <FolderOpen size={19} />
              </span>
              <div className="min-w-0">
                <h2>{project.name}</h2>
                <p className="studio-project-meta">
                  {project.client_label && (
                    <>
                      <span>{project.client_label}</span>
                      <span>·</span>
                    </>
                  )}
                  <time dateTime={project.updated_at}>
                    {new Date(project.updated_at).toLocaleDateString()}
                  </time>
                </p>
              </div>
              <ChevronRight size={16} className="studio-card-arrow" aria-hidden="true" />
            </Link>
          ))}
        </div>
      ) : (
        !error && (
          <output className="studio-project-empty">
            {search ? 'No matching projects' : 'No projects yet'}
          </output>
        )
      )}
    </section>
  );
}
