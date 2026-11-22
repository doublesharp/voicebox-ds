import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { create as createStore } from 'zustand';

const originalEventSource = Object.getOwnPropertyDescriptor(globalThis, 'EventSource');
const sources: FakeEventSource[] = [];
class FakeEventSource {
  static CLOSED = 2;
  readyState = 0;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onopen: (() => void) | null = null;
  close = mock(() => {});
  constructor(public url: string) {
    sources.push(this);
  }
  send(data: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}
Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: FakeEventSource });
const update = mock((_value: unknown) => {});
const dismiss = mock(() => {});
const toast = mock((_value: unknown) => ({ id: 'toast', update, dismiss }));
const complete = mock(() => {});
const failed = mock((_error: string) => {});
mock.module('../src/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));
const useServerStore = createStore(() => ({ serverUrl: 'http://localhost:17493', serverRevision: 0 }));
mock.module('../src/stores/serverStore', () => ({ useServerStore }));
mock.module('../src/components/ui/progress', () => ({ Progress: () => null }));
const { useModelDownloadToast } = await import('../src/lib/hooks/useModelDownloadToast');
let view: ReactTestRenderer | undefined;
function Probe({
  model = 'model-a',
  includeTerminalSnapshot = false,
}: {
  model?: string;
  includeTerminalSnapshot?: boolean;
}) {
  useModelDownloadToast({
    modelName: model,
    displayName: model,
    enabled: true,
    includeTerminalSnapshot,
    onComplete: complete,
    onError: failed,
  });
  return null;
}
beforeEach(() => {
  useServerStore.setState({ serverUrl: 'http://localhost:17493', serverRevision: 0 });
  sources.length = 0;
  update.mockClear();
  toast.mockClear();
  dismiss.mockClear();
  complete.mockClear();
  failed.mockClear();
});
afterEach(() => {
  if (view) act(() => view?.unmount());
  view = undefined;
});
afterAll(() => {
  mock.restore();
  if (originalEventSource) Object.defineProperty(globalThis, 'EventSource', originalEventSource);
  else Reflect.deleteProperty(globalThis, 'EventSource');
});
const event = (status: string, progress = 100) => ({ status, progress, current: 100, total: 100 });

test('100 percent downloaded does not finish before the server reports completion', () => {
  act(() => {
    view = create(<Probe includeTerminalSnapshot />);
  });
  const source = sources[0];
  expect(source.url).toContain('?include_terminal=true');
  act(() => source.send(event('downloading')));
  expect(complete).not.toHaveBeenCalled();
  expect(source.close).not.toHaveBeenCalled();
  act(() => source.send(event('extracting')));
  expect(complete).not.toHaveBeenCalled();
  act(() => source.send(event('complete')));
  expect(complete).toHaveBeenCalledTimes(1);
  expect(source.close).toHaveBeenCalledTimes(1);
});

test('download progress stays compact with the filename and transfer size available on demand', () => {
  act(() => { view = create(<Probe />); });
  expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'background' }));
  act(() => sources[0].send({
    status: 'downloading', progress: 25, current: 1024, total: 4096,
    filename: 'model.fp32-00002-of-00002.safetensors',
  }));
  const { description } = update.mock.calls.at(-1)?.[0] as { description: ReactNode };
  let detailsView!: ReactTestRenderer;
  act(() => { detailsView = create(<>{description}</>); });
  try {
    const details = detailsView.root.findByType('details');
    expect(details.props.open).toBeUndefined();
    expect(details.findByType('summary').children).toEqual(['Downloading · 25%']);
    expect(details.findAllByType('div').flatMap((node) => node.children)).toContain('model.fp32-00002-of-00002.safetensors');
    expect(details.findAllByType('div').flatMap((node) => node.children)).toContain('1.0 KB / 4.0 KB');
  } finally {
    act(() => detailsView.unmount());
  }
});

test('a subscription before download start ignores earlier terminal snapshots', () => {
  act(() => {
    view = create(<Probe />);
  });
  expect(sources[0].url).not.toContain('include_terminal');
});

test('an error at 100 percent is reported as an error', () => {
  act(() => {
    view = create(<Probe />);
  });
  act(() => sources[0].send({ ...event('error'), error: 'model load failed' }));
  expect(failed).toHaveBeenCalledWith('model load failed');
  expect(complete).not.toHaveBeenCalled();
});

test('events from a replaced subscription cannot finish the new download', () => {
  act(() => {
    view = create(<Probe model="model-a" />);
  });
  const old = sources[0];
  act(() => view?.update(<Probe model="model-b" />));
  const current = sources[1];
  expect(old.close).toHaveBeenCalledTimes(1);
  act(() => old.send(event('complete')));
  act(() => old.onerror?.(new Error('late disconnect')));
  expect(complete).not.toHaveBeenCalled();
  expect(current.close).not.toHaveBeenCalled();
  act(() => current.send(event('complete')));
  act(() => current.send(event('complete')));
  expect(complete).toHaveBeenCalledTimes(1);
});


test('a temporary disconnect allows the browser to reconnect and complete tracking', () => {
  act(() => { view = create(<Probe />); });
  const source = sources[0];
  act(() => source.onerror?.(new Error('temporary disconnect')));
  expect(source.close).not.toHaveBeenCalled();
  expect(failed).not.toHaveBeenCalled();
  act(() => source.send(event('complete')));
  expect(complete).toHaveBeenCalledTimes(1);
});

test('a permanently closed connection reports a tracking error without reporting download failure', () => {
  act(() => { view = create(<Probe />); });
  const source = sources[0];
  source.readyState = FakeEventSource.CLOSED;
  act(() => source.onerror?.(new Error('connection rejected')));
  expect(source.close).toHaveBeenCalledTimes(1);
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ description: 'Failed to track download progress', duration: 5000 }));
  expect(failed).not.toHaveBeenCalled();
  act(() => view?.unmount());
  view = undefined;
  expect(dismiss).not.toHaveBeenCalled();
});

test('replacing or unmounting an active subscription dismisses its unfinished toast', () => {
  act(() => { view = create(<Probe model="model-a" />); });
  act(() => view?.update(<Probe model="model-b" />));
  expect(dismiss).toHaveBeenCalledTimes(1);
  act(() => view?.unmount());
  view = undefined;
  expect(dismiss).toHaveBeenCalledTimes(2);
});

test('completed notifications remain visible after the subscription ends', () => {
  act(() => { view = create(<Probe />); });
  act(() => sources[0].send(event('complete')));
  act(() => view?.unmount());
  view = undefined;
  expect(dismiss).not.toHaveBeenCalled();
});


test('queued old-server events cannot complete or fail the new server download', () => {
  act(() => { view = create(<Probe />); });
  const old = sources[0];
  act(() => {
    useServerStore.setState({ serverUrl: 'http://server-b', serverRevision: 1 });
    old.send(event('complete'));
    old.readyState = FakeEventSource.CLOSED;
    old.onerror?.(new Error('old server disconnected'));
  });
  expect(complete).not.toHaveBeenCalled();
  expect(failed).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
  expect(old.close).toHaveBeenCalled();
  expect(sources[1].url).toContain('http://server-b/');
  act(() => sources[1].send(event('complete')));
  expect(complete).toHaveBeenCalledTimes(1);
});

test('switching away and back replaces a same-url stream and ignores its queued events', () => {
  act(() => { view = create(<Probe />); });
  const old = sources[0];
  act(() => {
    useServerStore.setState({ serverUrl: 'http://server-b', serverRevision: 1 });
    useServerStore.setState({ serverUrl: 'http://localhost:17493', serverRevision: 2 });
    old.send({ ...event('error'), error: 'old failure' });
  });
  expect(failed).not.toHaveBeenCalled();
  expect(old.close).toHaveBeenCalled();
  expect(sources).toHaveLength(2);
  act(() => sources[1].send(event('complete')));
  expect(complete).toHaveBeenCalledTimes(1);
});
