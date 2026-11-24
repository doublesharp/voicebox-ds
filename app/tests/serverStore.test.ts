import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

const entries = new Map<string, string>();
const storage = {
  getItem: (key: string) => entries.get(key) ?? null,
  setItem: (key: string, value: string) => entries.set(key, value),
  removeItem: (key: string) => entries.delete(key),
  clear: () => entries.clear(),
  key: (index: number) => [...entries.keys()][index] ?? null,
  get length() {
    return entries.size;
  },
};
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });

afterAll(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

const { useServerStore } = await import('../src/stores/serverStore');
const { queryClient } = await import('../src/lib/queryClient');
const defaultUrl = 'http://127.0.0.1:17593';
const upstreamUrl = 'http://127.0.0.1:17493';
const remoteUrl = 'https://voicebox.example.com';

beforeEach(() => {
  storage.clear();
  useServerStore.setState(useServerStore.getInitialState(), true);
});

afterEach(() => {
  queryClient.clear();
});

describe('server URL selection', () => {
  test('a saved custom URL survives reload and bundled server startup', async () => {
    useServerStore.getState().setServerUrl(remoteUrl);
    const saved = storage.getItem('voicebox-server');
    useServerStore.setState(useServerStore.getInitialState(), true);
    storage.setItem('voicebox-server', saved!);
    await useServerStore.persist.rehydrate();

    // This is the production startup callback, after the store rehydrates.
    useServerStore.getState().setDiscoveredServerUrl(defaultUrl);

    expect(useServerStore.getState().serverUrl).toBe(remoteUrl);
  });
});

async function loadLegacyUrl(serverUrl: string, mode: 'local' | 'remote' = 'remote') {
  storage.setItem(
    'voicebox-server',
    JSON.stringify({ state: { serverUrl, mode }, version: 0 }),
  );
  await useServerStore.persist.rehydrate();
}

test.each([
  remoteUrl,
  upstreamUrl,
  'http://192.168.1.50:17493',
  'http://localhost:17493',
  'http://127.0.0.1:8000',
  'http://127.0.0.1:17493/proxy',
  'https://127.0.0.1:17493',
])('preserves the legacy custom address %s', async (url) => {
  await loadLegacyUrl(url);
  useServerStore.getState().setDiscoveredServerUrl(defaultUrl);
  expect(useServerStore.getState().serverUrl).toBe(url);
  expect(useServerStore.getState().serverUrlSource).toBe('custom');
  expect(useServerStore.getState().mode).toBe('remote');
});

test('legacy bundled defaults remain automatic, including after reload', async () => {
  await loadLegacyUrl(upstreamUrl, 'local');
  expect(useServerStore.getState().serverUrl).toBe(defaultUrl);
  useServerStore.getState().setDiscoveredServerUrl('http://127.0.0.1:19000');
  await useServerStore.persist.rehydrate();
  useServerStore.getState().setDiscoveredServerUrl('http://127.0.0.1:19001');
  expect(useServerStore.getState().serverUrl).toBe('http://127.0.0.1:19001');
  expect(useServerStore.getState().serverUrlSource).toBe('auto');
});

test.each(['auto', 'custom'] as const)(
  'upgrades the recorded %s address without adopting upstream by default',
  async (serverUrlSource) => {
    storage.setItem(
      'voicebox-server',
      JSON.stringify({ state: { serverUrl: upstreamUrl, serverUrlSource }, version: 1 }),
    );
    await useServerStore.persist.rehydrate();
    expect(useServerStore.getState().serverUrl).toBe(
      serverUrlSource === 'auto' ? defaultUrl : upstreamUrl,
    );
    expect(useServerStore.getState().serverUrlSource).toBe(serverUrlSource);
  },
);

test('saving the default URL explicitly prevents future automatic changes', () => {
  useServerStore.getState().setServerUrl(defaultUrl);
  useServerStore.getState().setDiscoveredServerUrl('http://127.0.0.1:19000');
  expect(useServerStore.getState().serverUrl).toBe(defaultUrl);
  expect(useServerStore.getState().serverUrlSource).toBe('custom');
});

test('a user selection made during asynchronous startup wins', async () => {
  let finishStartup: (url: string) => void = () => {};
  const startup = new Promise<string>((resolve) => {
    finishStartup = resolve;
  });
  const ready = startup.then((url) => useServerStore.getState().setDiscoveredServerUrl(url));
  useServerStore.getState().setServerUrl(remoteUrl);
  finishStartup(defaultUrl);
  await ready;
  expect(useServerStore.getState().serverUrl).toBe(remoteUrl);
});

test('only effective URL changes invalidate cached server data', () => {
  const invalidate = spyOn(queryClient, 'invalidateQueries');
  try {
    useServerStore.getState().setDiscoveredServerUrl(defaultUrl);
    expect(invalidate).toHaveBeenCalledTimes(0);
    useServerStore.getState().setDiscoveredServerUrl('http://127.0.0.1:19000');
    expect(invalidate).toHaveBeenCalledTimes(1);
    useServerStore.getState().setServerUrl(remoteUrl);
    expect(invalidate).toHaveBeenCalledTimes(2);
    useServerStore.getState().setServerUrl(remoteUrl);
    useServerStore.getState().setDiscoveredServerUrl(defaultUrl);
    expect(invalidate).toHaveBeenCalledTimes(2);
  } finally {
    invalidate.mockRestore();
  }
});

test('production web uses its origin automatically and preserves custom selections', async () => {
  const oldProd = process.env.PROD;
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  process.env.PROD = 'true';
  Object.defineProperty(globalThis, 'window', {
    value: { location: new URL('https://voicebox.example.org') },
    configurable: true,
  });
  try {
    const { getDefaultServerUrl } = await import('../src/stores/serverStore');
    const origin = getDefaultServerUrl();
    expect(origin).toBe('https://voicebox.example.org');
    await loadLegacyUrl(defaultUrl);
    useServerStore.getState().setDiscoveredServerUrl(origin);
    expect(useServerStore.getState().serverUrl).toBe(origin);
    await loadLegacyUrl(origin);
    expect(useServerStore.getState().serverUrlSource).toBe('auto');
    useServerStore.getState().setServerUrl(remoteUrl);
    useServerStore.getState().setDiscoveredServerUrl(origin);
    expect(useServerStore.getState().serverUrl).toBe(remoteUrl);
  } finally {
    if (oldProd === undefined) delete process.env.PROD;
    else process.env.PROD = oldProd;
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test.each([
  'http://tauri.localhost',
  'tauri://localhost',
])('production desktop origin %s keeps the bundled default', async (origin) => {
  const oldProd = process.env.PROD;
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  process.env.PROD = 'true';
  Object.defineProperty(globalThis, 'window', {
    value: { location: new URL(origin) },
    configurable: true,
  });
  try {
    const { getDefaultServerUrl } = await import('../src/stores/serverStore');
    expect(getDefaultServerUrl()).toBe(defaultUrl);
    await loadLegacyUrl(defaultUrl);
    expect(useServerStore.getState().serverUrlSource).toBe('auto');
  } finally {
    if (oldProd === undefined) delete process.env.PROD;
    else process.env.PROD = oldProd;
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test.each([
  'local',
  undefined,
])('legacy bundled port 8000 migrates automatically for mode %s', async (mode) => {
  storage.setItem(
    'voicebox-server',
    JSON.stringify({
      state: { serverUrl: 'http://127.0.0.1:8000', ...(mode ? { mode } : {}) },
      version: 0,
    }),
  );
  await useServerStore.persist.rehydrate();
  useServerStore.getState().setDiscoveredServerUrl(defaultUrl);
  expect(useServerStore.getState().serverUrl).toBe(defaultUrl);
  expect(useServerStore.getState().serverUrlSource).toBe('auto');
});
