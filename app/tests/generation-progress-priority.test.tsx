import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useGenerationStore } from '../src/stores/generationStore';
import { usePlayerStore } from '../src/stores/playerStore';
import { useServerStore } from '../src/stores/serverStore';

const refetch = mock(async () => {});
const invalidate = mock(async () => {});
const toast = mock(() => {});
const addStory = mock(async () => ({}));
let autoplay = true;
mock.module('@tanstack/react-query', () => ({
  useQueryClient: () => ({ refetchQueries: refetch, invalidateQueries: invalidate }),
}));
mock.module('../src/lib/hooks/useSettings', () => ({
  useGenerationSettings: () => ({ settings: { autoplay_on_generate: autoplay } }),
}));
mock.module('../src/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));
mock.module('../src/lib/api/client', () => ({
  apiClient: {
    getGenerationStatusUrl: (id: string) => `/status/${id}`,
    getAudioUrl: (id: string) => `/audio/${id}`,
    addStoryItem: addStory,
  },
}));

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static CLOSED = 2;
  readyState = 1;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}
const originalEventSource = globalThis.EventSource;
globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
afterAll(() => {
  globalThis.EventSource = originalEventSource;
});
const { useGenerationProgress } = await import('../src/lib/hooks/useGenerationProgress');
function Probe() {
  useGenerationProgress();
  return null;
}
let view: ReactTestRenderer | undefined;
beforeEach(() => {
  FakeEventSource.instances = [];
  useServerStore.setState({ serverUrl: 'http://server-a' });
  refetch.mockClear();
  invalidate.mockClear();
  toast.mockClear();
  addStory.mockClear();
  autoplay = true;
  useGenerationStore.setState({
    pendingGenerationIds: new Set(),
    pendingStoryAdds: new Map(),
    isGenerating: false,
  });
  usePlayerStore.getState().reset();
});
afterEach(() => {
  act(() => view?.unmount());
  view = undefined;
});
async function start(id = 'gen', story?: string) {
  act(() => {
    if (story) useGenerationStore.getState().addPendingStoryAdd(id, story);
    useGenerationStore.getState().addPendingGeneration(id);
    view = create(<Probe />);
  });
  await act(async () => {});
  return FakeEventSource.instances.at(-1)!;
}
test('completed generation refreshes history, clears pending, and starts the correct audio', async () => {
  const source = await start();
  await act(async () => source.emit({ id: 'gen', status: 'completed' }));
  expect(source.closed).toBe(true);
  expect(useGenerationStore.getState().pendingGenerationIds.size).toBe(0);
  expect(refetch).toHaveBeenCalledWith({ queryKey: ['history'] });
  expect(usePlayerStore.getState().audioId).toBe('gen');
  expect(usePlayerStore.getState().shouldAutoPlay).toBe(true);
});
test('story completion adds the generated clip and refreshes the relevant stories', async () => {
  const source = await start('gen', 'story');
  await act(async () => source.emit({ id: 'gen', status: 'completed', duration: 2 }));
  expect(addStory).toHaveBeenCalledWith('story', { generation_id: 'gen' });
  expect(useGenerationStore.getState().pendingStoryAdds.has('gen')).toBe(false);
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['stories', 'story'] });
  expect(toast).toHaveBeenCalled();
});
test('failures clear queued story additions and display a useful error', async () => {
  const source = await start('gen', 'story');
  await act(async () => source.emit({ id: 'gen', status: 'failed', error: 'Model unavailable' }));
  expect(useGenerationStore.getState().pendingStoryAdds.has('gen')).toBe(false);
  expect(toast.mock.calls[0]?.[0]).toMatchObject({
    title: 'Generation failed',
    description: 'Model unavailable',
    variant: 'destructive',
  });
  expect(addStory).not.toHaveBeenCalled();
});
test('agent speech and audio already playing do not interrupt playback', async () => {
  const source = await start();
  act(() => usePlayerStore.getState().setIsPlaying(true));
  await act(async () => source.emit({ id: 'gen', status: 'completed' }));
  expect(usePlayerStore.getState().audioId).toBeNull();
  act(() => view?.unmount());
  view = undefined;
  const agent = await start('agent');
  act(() => usePlayerStore.getState().setIsPlaying(false));
  await act(async () => agent.emit({ id: 'agent', status: 'completed', source: 'mcp' }));
  expect(usePlayerStore.getState().audioId).toBeNull();
});
test('stale events after removal do not play audio or consume another pending generation', async () => {
  const source = await start('old');
  act(() => useGenerationStore.getState().removePendingGeneration('old'));
  expect(source.closed).toBe(true);
  act(() => useGenerationStore.getState().addPendingGeneration('new'));
  await act(async () => source.emit({ id: 'old', status: 'completed' }));
  expect(usePlayerStore.getState().audioId).toBeNull();
  expect(useGenerationStore.getState().pendingGenerationIds.has('new')).toBe(true);
});
test('unmount closes outstanding connections', async () => {
  const source = await start();
  act(() => view?.unmount());
  view = undefined;
  expect(source.closed).toBe(true);
});

test('a backlog shares status connections and observes later jobs without waiting for the first job', async () => {
  await start('gen-1');
  const store = useGenerationStore.getState();
  act(() => {
    for (let number = 2; number <= 7; number++) {
      store.addPendingGeneration(`gen-${number}`);
    }
    store.addPendingStoryAdd('gen-7', 'harbor-story');
  });

  const openSources = () => FakeEventSource.instances.filter((source) => !source.closed);
  expect(openSources()).toHaveLength(3);
  const first = openSources()[0];
  await act(async () => first.emit({ id: 'gen-1', status: 'completed', source: 'rest' }));
  expect(first.closed).toBe(true);
  expect(openSources()).toHaveLength(3);
  expect(openSources().map((source) => source.url)).toContain('/status/gen-4');

  // A later job may finish first, including a cancellation or a restored job.
  const deadline = Date.now() + 4_500;
  while (!openSources().some((source) => source.url === '/status/gen-7') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(openSources()).toHaveLength(3);
  }
  const late = openSources().find((source) => source.url === '/status/gen-7');
  expect(late).toBeDefined();
  await act(async () => late?.emit({ id: 'gen-7', status: 'completed' }));
  expect(addStory).toHaveBeenCalledWith('harbor-story', { generation_id: 'gen-7' });
  expect(useGenerationStore.getState().pendingGenerationIds.has('gen-7')).toBe(false);
  expect(openSources()).toHaveLength(3);
}, 6_000);
test('a permanently closed status connection clears its queued story association', async () => {
  const source = await start('gen', 'story');
  source.readyState = 2;
  await act(async () => source.onerror?.());
  expect(source.closed).toBe(true);
  expect(useGenerationStore.getState().pendingGenerationIds.has('gen')).toBe(false);
  expect(useGenerationStore.getState().pendingStoryAdds.has('gen')).toBe(false);
});

test('a temporary status disconnect preserves the story until the stream reconnects', async () => {
  const source = await start('gen', 'story');
  source.readyState = 0;
  await act(async () => source.onerror?.());
  expect(source.closed).toBe(false);
  expect(useGenerationStore.getState().pendingGenerationIds.has('gen')).toBe(true);
  expect(useGenerationStore.getState().pendingStoryAdds.get('gen')).toBe('story');
  source.readyState = 1;
  await act(async () => source.emit({ id: 'gen', status: 'completed' }));
  expect(addStory).toHaveBeenCalledWith('story', { generation_id: 'gen' });
});

test('a failed story insertion reports the error without losing completed audio', async () => {
  addStory.mockImplementationOnce(async () => {
    throw new Error('offline');
  });
  const source = await start('gen', 'story');
  await act(async () => source.emit({ id: 'gen', status: 'completed' }));
  expect(toast.mock.calls[0]?.[0]).toMatchObject({
    title: 'Generation complete',
    variant: 'destructive',
  });
  expect(usePlayerStore.getState().audioId).toBe('gen');
});

test('autoplay can be disabled without leaving a completed generation pending', async () => {
  autoplay = false;
  const source = await start();
  await act(async () => source.emit({ id: 'gen', status: 'completed' }));
  expect(usePlayerStore.getState().audioId).toBeNull();
  expect(useGenerationStore.getState().pendingGenerationIds.size).toBe(0);
});

test('heartbeat and loading messages leave the generation pending', async () => {
  const source = await start();
  await act(async () => {
    source.onmessage?.({ data: ': heartbeat' });
    source.emit({ id: 'gen', status: 'loading_model' });
  });
  expect(source.closed).toBe(false);
  expect(useGenerationStore.getState().pendingGenerationIds.has('gen')).toBe(true);
  expect(refetch).not.toHaveBeenCalled();
});

test('a stale connection error cannot cancel a newer pending generation', async () => {
  const source = await start('old');
  act(() => useGenerationStore.getState().removePendingGeneration('old'));
  act(() => useGenerationStore.getState().addPendingGeneration('new'));
  await act(async () => source.onerror?.());
  expect(useGenerationStore.getState().pendingGenerationIds.has('new')).toBe(true);
  expect(refetch).not.toHaveBeenCalled();
});


test('switching servers replaces same-id generation streams and ignores the old server', async () => {
  const old = await start('same-id');
  act(() => useServerStore.setState({ serverUrl: 'http://server-b' }));
  const current = FakeEventSource.instances.at(-1)!;
  expect(old.closed).toBe(true);
  expect(current).not.toBe(old);
  await act(async () => old.emit({ id: 'same-id', status: 'completed' }));
  expect(useGenerationStore.getState().pendingGenerationIds.has('same-id')).toBe(true);
  expect(usePlayerStore.getState().audioId).toBeNull();
  await act(async () => current.emit({ id: 'same-id', status: 'completed' }));
  expect(usePlayerStore.getState().audioId).toBe('same-id');
});


test('queued old-server callbacks are ignored even before effects clean up', async () => {
  const old = await start('same-id', 'story');
  act(() => {
    useServerStore.setState({ serverUrl: 'http://server-b' });
    old.emit({ id: 'same-id', status: 'completed' });
    old.onerror?.();
  });
  expect(usePlayerStore.getState().audioId).toBeNull();
  expect(addStory).not.toHaveBeenCalled();
  expect(useGenerationStore.getState().pendingGenerationIds.has('same-id')).toBe(true);
  expect(useGenerationStore.getState().pendingStoryAdds.get('same-id')).toBe('story');
});
