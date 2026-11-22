import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { notifyManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useServerStore } from '../src/stores/serverStore';

const firstServer = 'http://first.invalid';
const requests: Array<{ resolve: (value: any) => void; reject: (error: Error) => void }> = [];
const triggerDownload = mock(async (_name: string) => ({ message: 'Download started' }));
mock.module('../src/lib/api/client', () => ({
  apiClient: {
    getModelStatus: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
    triggerModelDownload: triggerDownload,
  },
}));
const { useAvailableTtsModels } = await import('../src/lib/hooks/useAvailableTtsModels');
let current: ReturnType<typeof useAvailableTtsModels>;
let view: ReactTestRenderer;
let client: QueryClient;
function Harness() {
  current = useAvailableTtsModels();
  return null;
}
beforeEach(() => {
  notifyManager.setScheduler(queueMicrotask);
  useServerStore.setState({ serverUrl: firstServer, serverRevision: 0 });
  client = new QueryClient();
});
afterEach(() => {
  if (view) act(() => view.unmount());
  client.clear();
  requests.length = 0;
  triggerDownload.mockClear();
});
afterAll(() => {
  notifyManager.setScheduler((callback) => setTimeout(callback, 0));
  mock.restore();
});

async function mount() {
  await act(async () => {
    view = create(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
    );
  });
}

test('late results from another server cannot advertise unavailable models', async () => {
  await mount();
  expect(current!.loading).toBe(true);
  await act(async () => {
    useServerStore.setState({ serverUrl: 'http://second.invalid', serverRevision: 1 });
  });
  await act(async () => {
    requests[0].resolve({ models: [{ model_name: 'qwen-tts-1.7B-8bit' }] });
  });
  expect(current!.loading).toBe(true);
  expect(current!.models.size).toBe(0);
  await act(async () => {
    requests[1].resolve({ models: [{ model_name: 'qwen-tts-1.7B-4bit' }] });
  });
  expect([...current!.models.keys()]).toEqual(['qwen-tts-1.7B-4bit']);
  expect(current!.loading).toBe(false);
});

test('discovery failure completes without advertising a guessed precision', async () => {
  await mount();
  await act(async () => {
    requests[0].reject(new Error('offline'));
  });
  expect(current!.loading).toBe(false);
  expect(current!.models.size).toBe(0);
});

test('download starts only on the server that advertised the model', async () => {
  await mount();
  const model = {
    model_name: 'qwen-tts-1.7B-4bit',
    display_name: 'Qwen 4-bit',
    downloaded: false,
    downloading: false,
    loaded: false,
  };
  await act(async () => {
    requests[0].resolve({ models: [model] });
  });
  const download = current!.download;
  await act(async () => {
    download(model);
  });
  expect(triggerDownload).toHaveBeenCalledWith(model.model_name);
  await act(async () => {
    requests[1].resolve({ models: [{ ...model, downloading: true }] });
  });
  expect(current!.models.get(model.model_name)?.downloading).toBe(true);

  await act(async () => {
    useServerStore.setState({ serverUrl: firstServer, serverRevision: 1 });
  });
  expect(current!.models.size).toBe(0);
  await act(async () => {
    download(model);
  });
  expect(triggerDownload).toHaveBeenCalledTimes(1);
});
