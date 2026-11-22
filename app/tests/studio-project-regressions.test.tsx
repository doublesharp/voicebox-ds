import { afterEach, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

let projectId = 'one';
let serverUrl = 'local';
let serverRevision = 0;
let renderer: ReactTestRenderer;
let retryJob: () => Promise<unknown> = async () => {};
let profilesRequest: (signal: AbortSignal) => Promise<any[]> = async () => [];
let includeJob = false;
let hasPassage = false;
let hasTake = false;
let initialStatus = 'saved';
let noProject = false;
let checkpointResult = true;
let checkpointHandler: () => Promise<boolean> = async () => checkpointResult;
let confirmLeave = false;
const windowListeners = new Map<string, Set<(event: any) => void>>();
const checkpoints: string[] = [];
const commands: unknown[] = [];
const sessions: any[] = [];
const playbackInstances: Array<{ tick(position: number): void; getPlayhead(): number }> = [];
let scriptRenders = 0;
const project = (id: string) => ({
  id,
  name: `Project ${id}`,
  revision: 0,
  document: { passages: hasPassage ? [{ id: 'passage', text: 'Hello' }] : [], clips: [], tracks: [], mix: {} },
  assets: [],
  takes: hasTake ? [{ id: 'take' }] : [],
  jobs: includeJob ? [{ id: 'job', kind: 'render', status: 'failed' }] : [],
  revisions: [],
});
const pass = ({ children }: any) => <>{children}</>;
const storage = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  },
  window: {
    addEventListener(type: string, listener: (event: any) => void) { if (!windowListeners.has(type)) windowListeners.set(type, new Set()); windowListeners.get(type)!.add(listener); },
    removeEventListener(type: string, listener: (event: any) => void) { windowListeners.get(type)?.delete(listener); },
    confirm: () => confirmLeave,
  },
});
mock.module('@tanstack/react-router', () => ({
  Link: pass,
  useParams: () => ({ projectId }),
  useNavigate: () => () => {},
  useBlocker: () => {},
}));
const serverState = () => ({ serverUrl, serverRevision });
mock.module('../src/stores/serverStore', () => ({
  useServerStore: Object.assign((select: any) => select(serverState()), { getState: serverState }),
}));
mock.module('../src/stores/playerStore', () => ({
  usePlayerStore: {
    getState: () => ({ setIsPlaying() {}, clearAutoPlayFlag() {} }),
    subscribe: () => () => {},
  },
}));
const platform = { audio: { stopPlayback() {} }, filesystem: { saveFile() {} } };
mock.module('../src/platform/PlatformContext', () => ({ usePlatform: () => platform }));
mock.module('../src/features/studio/client', () => ({
  StudioApiError: class extends Error {},
  StudioClient: class {
    retryJob() {
      return retryJob();
    }
    profiles(signal: AbortSignal) {
      return profilesRequest(signal);
    }
    engines() {
      return Promise.resolve({ items: [] });
    }
  },
}));
mock.module('../src/features/studio/session', () => ({
  operationId: () => 'test-operation',
  errorMessage: (e: any) => e.message,
  ProjectSession: class {
    state: any;
    listeners = new Set<() => void>();
    disposed = false;
    constructor(_client: any, id: string) {
      this.state = { project: noProject ? null : project(id), status: initialStatus, recoverySaved: true };
      sessions.push(this);
    }
    getSnapshot = () => this.state;
    subscribe = (fn: () => void) => {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    };
    load() {}
    refresh() {}
    dispose() {
      this.disposed = true;
    }
    checkpoint(name: string) { checkpoints.push(name); return checkpointHandler(); }
    flush() { commands.push(['flush']); return Promise.resolve(); }
    retry() { commands.push(['retry']); return Promise.resolve(); }
    reloadSaved() { commands.push(['reload']); return Promise.resolve(); }
    hasRecoverableEdits() { return true; }
    recover() { commands.push(['recover']); }
    recoveryCopy() { return '{"version":1}'; }
    command(type: string, payload: unknown) {
      commands.push([type, payload]);
      return Promise.resolve();
    }
  },
}));
mock.module('../src/features/studio/review-client', () => ({ ReviewClient: class {} }));
mock.module('../src/features/studio/review-session', () => ({
  ReviewSessions: class {
    subscribe = () => () => {};
    getSnapshot = () => null;
    refresh() {}
    dispose() {}
    unsafeToLeave() {
      return false;
    }
  },
}));
const idle = { mode: 'idle', position: 0 };
mock.module('../src/features/studio/playback', () => ({
  StudioPlayback: class {
    state = idle;
    listeners = new Set<() => void>();
    cursor = 0;
    constructor() {
      playbackInstances.push(this);
    }
    subscribe = (listener: () => void) => {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    };
    getSnapshot = () => this.state;
    getPlayhead = () => this.cursor;
    seek = (position: number) => {
      this.cursor = position;
      this.state = { mode: 'idle', position };
      for (const listener of this.listeners) listener();
    };
    tick(position: number) {
      this.cursor = position;
      this.state = { mode: 'timeline', position };
      for (const listener of this.listeners) listener();
    }
    stop() {}
    dispose() {}
  },
}));
mock.module('../src/components/ui/dialog', () => ({
  Dialog: ({ children, ...props }: any) => <dialog-mock {...props}>{children}</dialog-mock>,
  DialogContent: pass,
  DialogDescription: pass,
  DialogHeader: pass,
  DialogTitle: pass,
  DialogTrigger: pass,
}));
mock.module('../src/components/ui/Hint', () => ({ Hint: pass }));
mock.module('../src/components/ui/HelpButton', () => ({ HelpButton: () => null }));
mock.module('../src/features/studio/AudioMeters', () => ({ AudioMeters: () => null }));
mock.module('../src/features/studio/Deliver', () => ({ Deliver: () => null }));
mock.module('../src/features/studio/Director', () => ({ Director: () => null }));
mock.module('../src/features/studio/PronunciationPanel', () => ({ PronunciationPanel: () => null }));
mock.module('../src/features/studio/Review', () => ({ Review: () => null }));
mock.module('../src/features/studio/ScriptEditor', () => ({
  ScriptEditor: ({ emptyAction }: { emptyAction?: React.ReactNode }) => {
    scriptRenders++;
    return <>{emptyAction}</>;
  },
}));
mock.module('../src/features/studio/Timeline', () => ({
  Timeline: ({ importOnly }: { importOnly?: boolean }) =>
    importOnly ? <button type="button">Import audio</button> : null,
  Mixer: () => null,
  ClipInspector: () => null,
}));
const { StudioProjectPage } = await import('../src/features/studio/StudioProjectPage');
afterEach(() => {
  act(() => renderer?.unmount());
  commands.length = 0;
  sessions.length = 0;
  projectId = 'one';
  serverUrl = 'local';
  serverRevision = 0;
  storage.clear();
  includeJob = false;
  hasPassage = false;
  hasTake = false;
  retryJob = async () => {};
  profilesRequest = async () => [];
  initialStatus = 'saved';
  noProject = false;
  checkpointResult = true;
  checkpointHandler = async () => checkpointResult;
  confirmLeave = false;
  checkpoints.length = 0;
  windowListeners.clear();
});
async function mount() {
  await act(async () => {
    renderer = create(<StudioProjectPage />);
  });
}
const nameInput = () => renderer.root.findByProps({ 'aria-label': 'Project name' });
test('a blank Edit workspace offers audio import and reveals editing tools after the first passage', async () => {
  await mount();
  const layout = () => JSON.stringify(renderer.toJSON());
  expect(layout()).not.toContain('studio-desktop-inspector');
  expect(layout()).not.toContain('studio-outline-content');
  expect(layout()).not.toContain('studio-bottom-timeline');
  expect(layout()).not.toContain('Playhead seconds');
  expect(layout()).toContain('Import audio');

  act(() => {
    hasPassage = true;
    const session = sessions[0];
    session.state = { ...session.state, project: project(projectId) };
    for (const listener of session.listeners) listener();
  });
  expect(layout()).toContain('studio-desktop-inspector');
  expect(layout()).not.toContain('Playhead seconds');
  expect(renderer.root.findByProps({ className: 'studio-timeline-disclosure' }).props['aria-expanded']).toBe(false);
});
test('blank project name restores the saved name instead of leaving a false empty title', async () => {
  await mount();
  const target = { value: '   ' };
  act(() => nameInput().props.onBlur({ target }));
  expect(target.value).toBe('Project one');
  expect(commands).toEqual([]);
});
test('renaming submits a trimmed name and switching project disposes the old session', async () => {
  await mount();
  act(() => nameInput().props.onBlur({ target: { value: '  New title  ' } }));
  expect(commands).toEqual([['update_project', { name: 'New title' }]]);
  const old = sessions[0];
  projectId = 'two';
  await act(async () => renderer.update(<StudioProjectPage />));
  expect(old.disposed).toBe(true);
  expect(nameInput().props.defaultValue).toBe('Project two');
});

test('failed job mutation is shown and does not refresh project data', async () => {
  includeJob = true;
  retryJob = async () => {
    throw new Error('retry rejected');
  };
  await mount();
  const session = sessions[0];
  let refreshes = 0;
  session.refresh = () => {
    refreshes++;
  };
  const button = renderer.root
    .findAllByType('button')
    .find((node) => node.props.children === 'Retry frozen request')!;
  await act(async () => {
    button.props.onClick();
  });
  expect(JSON.stringify(renderer.toJSON())).toContain('retry rejected');
  expect(refreshes).toBe(0);
});

test('a job completion after switching projects cannot refresh the old project', async () => {
  includeJob = true;
  let resolve!: () => void;
  retryJob = () =>
    new Promise<void>((r) => {
      resolve = r;
    });
  await mount();
  const old = sessions[0];
  let refreshes = 0;
  old.refresh = () => {
    refreshes++;
  };
  const button = renderer.root
    .findAllByType('button')
    .find((node) => node.props.children === 'Retry frozen request')!;
  act(() => button.props.onClick());
  projectId = 'two';
  await act(async () => renderer.update(<StudioProjectPage />));
  await act(async () => resolve());
  expect(old.disposed).toBe(true);
  expect(refreshes).toBe(0);
  expect(nameInput().props.defaultValue).toBe('Project two');
});

test('reconnecting to the same server URL disposes the previous project session', async () => {
  await mount();
  const old = sessions[0];
  serverRevision += 2; // A connection switch away and back may be batched into one render.
  await act(async () => renderer.update(<StudioProjectPage />));
  expect(old.disposed).toBe(true);
  expect(sessions).toHaveLength(2);
  expect(nameInput().props.defaultValue).toBe('Project one');
});

test('a job response from an earlier connection cannot refresh a reconnected project', async () => {
  includeJob = true;
  let resolve!: () => void;
  retryJob = () => new Promise<void>((done) => { resolve = done; });
  await mount();
  const old = sessions[0];
  let refreshes = 0;
  old.refresh = () => { refreshes++; };
  act(() => button('Retry frozen request').props.onClick());
  serverRevision += 2;
  await act(async () => renderer.update(<StudioProjectPage />));
  await act(async () => { resolve(); });
  expect(old.disposed).toBe(true);
  expect(refreshes).toBe(0);
  expect(sessions).toHaveLength(2);
});

test('an old job response cannot refresh before a connection change rerenders the page', async () => {
  includeJob = true;
  let resolve!: () => void;
  retryJob = () => new Promise<void>((done) => { resolve = done; });
  await mount();
  let refreshes = 0;
  sessions[0].refresh = () => { refreshes++; };
  act(() => button('Retry frozen request').props.onClick());
  serverRevision += 2;
  await act(async () => { resolve(); });
  expect(refreshes).toBe(0);
});

test('a stale job action cannot dispatch before a server switch rerenders', async () => {
  includeJob = true;
  let calls = 0;
  retryJob = async () => { calls++; };
  await mount();
  serverUrl = 'other'; serverRevision++;
  await act(async () => button('Retry frozen request').props.onClick());
  expect(calls).toBe(0);
});

test('a job failure from an old connection is not displayed before rerender', async () => {
  includeJob = true;
  let reject!: (error: Error) => void;
  retryJob = () => new Promise((_resolve, fail) => { reject = fail; });
  await mount();
  act(() => button('Retry frozen request').props.onClick());
  serverRevision += 2;
  await act(async () => { reject(new Error('old connection failed')); });
  expect(JSON.stringify(renderer.toJSON())).not.toContain('old connection failed');
});

test('a successful current job action refreshes its project once', async () => {
  includeJob = true;
  await mount();
  let refreshes = 0;
  sessions[0].refresh = () => { refreshes++; };
  await act(async () => { button('Retry frozen request').props.onClick(); });
  expect(refreshes).toBe(1);
  expect(button('Retry frozen request').props.disabled).toBe(false);
});

test('reconnecting aborts old voice-capability requests and ignores their errors', async () => {
  const requests: Array<{ signal: AbortSignal; reject: (error: Error) => void }> = [];
  profilesRequest = (signal) => new Promise((_resolve, reject) => { requests.push({ signal, reject }); });
  await mount();
  expect(requests).toHaveLength(1);
  serverRevision += 2;
  await act(async () => renderer.update(<StudioProjectPage />));
  expect(requests[0].signal.aborted).toBe(true);
  expect(requests).toHaveLength(2);
  await act(async () => { requests[0].reject(new Error('old capability request failed')); });
  expect(JSON.stringify(renderer.toJSON())).not.toContain('old capability request failed');
});

test('playback clock updates transport without rerendering script and keeps manual seeks', async () => {
  hasPassage = true;
  hasTake = true;
  await mount();
  const player = playbackInstances.at(-1);
  const before = scriptRenders;
  act(() => player.tick(1.25));
  const input = renderer.root
    .findAllByType('input')
    .find((node) => node.props['aria-label'] === 'Playhead seconds')!;
  expect(input.props.value).toBe(1.25);
  expect(scriptRenders).toBe(before);
  act(() => input.props.onChange({ target: { valueAsNumber: 3.5 } }));
  expect(player.getPlayhead()).toBe(3.5);
  expect(input.props.value).toBe(3.5);
  expect(scriptRenders).toBe(before);
});

const button = (label: string) => renderer.root.findAllByType('button').find((node) => node.props.children === label)!;

test('keyboard resize clamps each panel and persists the project layout', async () => {
  hasPassage = true;
  storage.set('voicebox-studio:layout', JSON.stringify({ edit: { outline: 999, inspector: 10 } }));
  await mount();
  act(() => renderer.root.findByProps({ 'aria-label': 'Toggle outline' }).props.onClick());
  const outline = () => renderer.root.findByProps({ 'aria-label': 'Resize outline' });
  const inspector = () => renderer.root.findByProps({ 'aria-label': 'Resize inspector' });
  expect(outline().props['aria-valuenow']).toBe(280);
  expect(inspector().props['aria-valuenow']).toBe(240);
  act(() => outline().props.onKeyDown({ key: 'Home', preventDefault() {} }));
  expect(outline().props['aria-valuenow']).toBe(150);
  act(() => inspector().props.onKeyDown({ key: 'End', preventDefault() {} }));
  expect(inspector().props['aria-valuenow']).toBe(420);
  expect(JSON.parse(storage.get('voicebox-studio:layout')!).edit).toEqual({ outline: 150, inspector: 420 });
  act(() => button('Reset layout').props.onClick());
  expect(outline().props['aria-valuenow']).toBe(190);
  expect(storage.has('voicebox-studio:layout')).toBe(false);
});

test('pointer resizing follows drag direction and releases pointer capture', async () => {
  hasPassage = true;
  await mount();
  act(() => renderer.root.findByProps({ 'aria-label': 'Toggle outline' }).props.onClick());
  const outline = () => renderer.root.findByProps({ 'aria-label': 'Resize outline' });
  let captured = false;
  const target = { dataset: {} as Record<string, string>, setPointerCapture() { captured = true; }, hasPointerCapture() { return captured; }, releasePointerCapture() { captured = false; } };
  act(() => outline().props.onPointerDown({ currentTarget: target, pointerId: 1, clientX: 100 }));
  act(() => outline().props.onPointerMove({ currentTarget: target, pointerId: 1, clientX: 140 }));
  expect(outline().props['aria-valuenow']).toBe(230);
  act(() => outline().props.onPointerUp({ currentTarget: target, pointerId: 1 }));
  expect(captured).toBe(false);
});

test('save and undo shortcuts dispatch once, while text fields retain undo', async () => {
  await mount();
  const send = (key: string, target: any, options = {}) => {
    let prevented = false;
    const event = { key, ctrlKey: true, target, preventDefault() { prevented = true; }, stopPropagation() {}, ...options };
    act(() => windowListeners.get('keydown')?.forEach((listener) => listener(event)));
    return prevented;
  };
  expect(send('s', { tagName: 'TEXTAREA' })).toBe(true);
  expect(send('z', { tagName: 'TEXTAREA' })).toBe(false);
  expect(send('z', { tagName: 'DIV' })).toBe(true);
  expect(send('z', { tagName: 'DIV' }, { shiftKey: true })).toBe(true);
  expect(commands).toEqual([['flush'], ['undo', undefined], ['redo', undefined]]);
});

test('stale project shortcuts cannot dispatch after the connection changes', async () => {
  await mount();
  serverUrl = 'other'; serverRevision++;
  const event = { key: 's', ctrlKey: true, target: { tagName: 'DIV' }, preventDefault() {}, stopPropagation() {} };
  act(() => windowListeners.get('keydown')?.forEach((listener) => listener(event)));
  expect(commands).toEqual([]);
});

test('a stale project-name edit cannot update the previous server', async () => {
  await mount();
  serverUrl = 'other'; serverRevision++;
  act(() => nameInput().props.onBlur({ target: { value: 'Changed after switching' } }));
  expect(commands).toEqual([]);
});

test('periodic refresh does not read an old project after a connection change', async () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let poll!: () => void;
  globalThis.setInterval = ((callback: () => void) => { poll = callback; return 1; }) as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  try {
    await mount();
    let refreshes = 0;
    sessions[0].refresh = () => { refreshes++; };
    serverUrl = 'other'; serverRevision++;
    act(() => poll());
    expect(refreshes).toBe(0);
  } finally {
    act(() => renderer.unmount());
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test('dirty projects warn before browser unload and clean projects do not', async () => {
  await mount();
  let prevented = 0;
  const event = { returnValue: 'unchanged', preventDefault() { prevented++; } };
  act(() => windowListeners.get('beforeunload')?.forEach((listener) => listener(event)));
  expect(prevented).toBe(0);
  sessions[0].state = { ...sessions[0].state, status: 'dirty' };
  act(() => windowListeners.get('beforeunload')?.forEach((listener) => listener(event)));
  expect(prevented).toBe(1);
  expect(event.returnValue).toBe('');
});

test('checkpoint name is required, trimmed, and cleared after success', async () => {
  await mount();
  const input = () => renderer.root.findByProps({ placeholder: 'Client review 01' });
  expect(button('Create checkpoint').props.disabled).toBe(true);
  act(() => input().props.onChange({ target: { value: '  Review 1  ' } }));
  expect(button('Create checkpoint').props.disabled).toBe(false);
  await act(async () => { button('Create checkpoint').props.onClick(); });
  expect(checkpoints).toEqual(['Review 1']);
  expect(input().props.value).toBe('');
});

test('failed project load exposes a retry action', async () => {
  noProject = true;
  initialStatus = 'error';
  await mount();
  expect(JSON.stringify(renderer.toJSON())).toContain('Project could not be opened');
  let attempts = 0;
  sessions[0].load = () => { attempts++; };
  act(() => button('Retry').props.onClick());
  expect(attempts).toBe(1);
});

test('recovery controls require confirmation before discarding local edits', async () => {
  initialStatus = 'recovery';
  await mount();
  expect(JSON.stringify(renderer.toJSON())).toContain('Unfinished edits found');
  act(() => button('Recover local edits').props.onClick());
  act(() => button('Reload saved draft').props.onClick());
  expect(commands).toEqual([['recover']]);
  confirmLeave = true;
  act(() => button('Reload saved draft').props.onClick());
  expect(commands).toEqual([['recover'], ['reload']]);
});

test('invalid saved panel preferences fall back to usable defaults', async () => {
  hasPassage = true;
  storage.set('voicebox-studio:layout', '{broken json');
  await mount();
  act(() => renderer.root.findByProps({ 'aria-label': 'Toggle outline' }).props.onClick());
  expect(renderer.root.findByProps({ 'aria-label': 'Resize outline' }).props['aria-valuenow']).toBe(190);
  expect(renderer.root.findByProps({ 'aria-label': 'Resize inspector' }).props['aria-valuenow']).toBe(300);
});

test('a rejected checkpoint keeps the entered name available for retry', async () => {
  checkpointResult = false;
  await mount();
  const input = () => renderer.root.findByProps({ placeholder: 'Client review 01' });
  act(() => input().props.onChange({ target: { value: 'Client review' } }));
  await act(async () => { button('Create checkpoint').props.onClick(); });
  expect(checkpoints).toEqual(['Client review']);
  expect(input().props.value).toBe('Client review');
});

test('save failure offers retry without discarding the draft', async () => {
  initialStatus = 'error';
  await mount();
  expect(JSON.stringify(renderer.toJSON())).toContain('Your changes have not been saved');
  act(() => button('Retry same save').props.onClick());
  expect(commands).toEqual([['retry']]);
  expect(nameInput().props.defaultValue).toBe('Project one');
});

test('repeated job retry clicks do not send concurrent requests', async () => {
  includeJob = true;
  let resolve!: () => void;
  let calls = 0;
  retryJob = () => { calls++; return new Promise<void>((r) => { resolve = r; }); };
  await mount();
  const retry = button('Retry frozen request');
  act(() => { retry.props.onClick(); retry.props.onClick(); });
  expect(calls).toBe(1);
  expect(button('Retry frozen request').props.disabled).toBe(true);
  await act(async () => { resolve(); });
  expect(button('Retry frozen request').props.disabled).toBe(false);
});

test('repeated checkpoint clicks while saving create only one checkpoint', async () => {
  let finish!: (result: boolean) => void;
  checkpointHandler = () => new Promise((resolve) => { finish = resolve; });
  await mount();
  act(() => renderer.root.findByProps({ placeholder: 'Client review 01' }).props.onChange({ target: { value: 'Review' } }));
  const create = button('Create checkpoint');
  act(() => { create.props.onClick(); create.props.onClick(); });
  expect(checkpoints).toEqual(['Review']);
  await act(async () => { finish(true); });
});

test('a checkpoint completion does not erase a newer name entered while saving', async () => {
  let finish!: (result: boolean) => void;
  checkpointHandler = () => new Promise((resolve) => { finish = resolve; });
  await mount();
  const input = () => renderer.root.findByProps({ placeholder: 'Client review 01' });
  act(() => input().props.onChange({ target: { value: 'First' } }));
  act(() => button('Create checkpoint').props.onClick());
  act(() => input().props.onChange({ target: { value: 'Next review' } }));
  await act(async () => { finish(true); });
  expect(input().props.value).toBe('Next review');
});

test('a stale checkpoint button does not submit after the server changes', async () => {
  await mount();
  act(() => renderer.root.findByProps({ placeholder: 'Client review 01' }).props.onChange({ target: { value: 'Review' } }));
  serverUrl = 'other'; serverRevision++;
  act(() => button('Create checkpoint').props.onClick());
  expect(checkpoints).toEqual([]);
});

test('a checkpoint response from an earlier connection does not clear current input', async () => {
  let finish!: (result: boolean) => void;
  checkpointHandler = () => new Promise((resolve) => { finish = resolve; });
  await mount();
  const input = () => renderer.root.findByProps({ placeholder: 'Client review 01' });
  act(() => input().props.onChange({ target: { value: 'Review' } }));
  act(() => button('Create checkpoint').props.onClick());
  serverRevision++;
  await act(async () => { finish(true); });
  expect(input().props.value).toBe('Review');
});

test('closing and reopening the checkpoint dialog invalidates an earlier completion', async () => {
  let finish!: (result: boolean) => void;
  checkpointHandler = () => new Promise((resolve) => { finish = resolve; });
  await mount();
  const input = () => renderer.root.findByProps({ placeholder: 'Client review 01' });
  const dialog = () => renderer.root.findAllByType('dialog-mock' as never)[0];
  act(() => input().props.onChange({ target: { value: 'Review' } }));
  act(() => button('Create checkpoint').props.onClick());
  act(() => dialog().props.onOpenChange(false));
  act(() => dialog().props.onOpenChange(true));
  await act(async () => { finish(true); });
  expect(dialog().props.open).toBe(true);
  expect(input().props.value).toBe('Review');
});

test('a failed checkpoint reports an error and allows the same name to be retried', async () => {
  checkpointHandler = async () => { throw new Error('checkpoint failed'); };
  await mount();
  const input = () => renderer.root.findByProps({ placeholder: 'Client review 01' });
  act(() => input().props.onChange({ target: { value: 'Review' } }));
  await act(async () => { button('Create checkpoint').props.onClick(); });
  expect(JSON.stringify(renderer.toJSON())).toContain('checkpoint failed');
  expect(input().props.value).toBe('Review');
  expect(button('Create checkpoint').props.disabled).toBe(false);
  checkpointHandler = async () => true;
  await act(async () => { button('Create checkpoint').props.onClick(); });
  expect(checkpoints).toEqual(['Review', 'Review']);
  expect(input().props.value).toBe('');
});

test('an old checkpoint failure is not displayed after changing connections', async () => {
  let fail!: (error: Error) => void;
  checkpointHandler = () => new Promise((_resolve, reject) => { fail = reject; });
  await mount();
  act(() => renderer.root.findByProps({ placeholder: 'Client review 01' }).props.onChange({ target: { value: 'Review' } }));
  act(() => button('Create checkpoint').props.onClick());
  serverRevision++;
  await act(async () => { fail(new Error('old checkpoint failure')); });
  expect(JSON.stringify(renderer.toJSON())).not.toContain('old checkpoint failure');
});

test('a checkpoint failure after closing its dialog does not display in the reopened dialog', async () => {
  let fail!: (error: Error) => void;
  checkpointHandler = () => new Promise((_resolve, reject) => { fail = reject; });
  await mount();
  const dialog = () => renderer.root.findAllByType('dialog-mock' as never)[0];
  act(() => renderer.root.findByProps({ placeholder: 'Client review 01' }).props.onChange({ target: { value: 'Review' } }));
  act(() => button('Create checkpoint').props.onClick());
  act(() => dialog().props.onOpenChange(false));
  act(() => dialog().props.onOpenChange(true));
  await act(async () => { fail(new Error('old dialog failure')); });
  expect(JSON.stringify(renderer.toJSON())).not.toContain('old dialog failure');
});
