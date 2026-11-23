import { afterEach, expect, test } from 'bun:test';
import { apiClient as api } from '../src/lib/api/client';
import { useServerStore } from '../src/stores/serverStore';

const originalFetch = globalThis.fetch;
const originalUrl = useServerStore.getState().serverUrl;
afterEach(() => {
  globalThis.fetch = originalFetch;
  useServerStore.setState({ serverUrl: originalUrl });
});

test('JSON endpoint methods honor explicit route, verb and body contracts', async () => {
  useServerStore.setState({ serverUrl: 'http://matrix.test' });
  const data = { name: 'example' };
  const cases: Array<[() => Promise<unknown>, string, string, unknown?]> = [
    [() => api.getHealth(), '/health', 'GET'],
    [() => api.listPresetVoices('engine'), '/profiles/presets/engine', 'GET'],
    [() => api.updateProfile('p', data as never), '/profiles/p', 'PUT', data],
    [() => api.deleteProfile('p'), '/profiles/p', 'DELETE'],
    [() => api.composeWithPersonality('p'), '/profiles/p/compose', 'POST'],
    [() => api.listProfileSamples('p'), '/profiles/p/samples', 'GET'],
    [() => api.deleteProfileSample('a'), '/profiles/samples/a', 'DELETE'],
    [
      () => api.updateProfileSample('a', 'text'),
      '/profiles/samples/a',
      'PUT',
      { reference_text: 'text' },
    ],
    [() => api.deleteAvatar('p'), '/profiles/p/avatar', 'DELETE'],
    [() => api.generateSpeech(data as never), '/generate', 'POST', data],
    [() => api.retryGeneration('g'), '/generate/g/retry', 'POST'],
    [() => api.cancelGeneration('g'), '/generate/g/cancel', 'POST'],
    [() => api.regenerateGeneration('g'), '/generate/g/regenerate', 'POST'],
    [() => api.toggleFavorite('g'), '/history/g/favorite', 'POST'],
    [() => api.listHistory(), '/history', 'GET'],
    [
      () => api.listHistory({ profile_id: 'a/b', search: 'hi & bye', limit: 5, offset: 2 }),
      '/history?profile_id=a%2Fb&search=hi+%26+bye&limit=5&offset=2',
      'GET',
    ],
    [() => api.getGeneration('g'), '/history/g', 'GET'],
    [() => api.deleteGeneration('g'), '/history/g', 'DELETE'],
    [() => api.clearFailedGenerations(), '/history/failed', 'DELETE'],
    [() => api.listCaptures(), '/captures?limit=50&offset=0', 'GET'],
    [() => api.listCaptures(4, 3), '/captures?limit=4&offset=3', 'GET'],
    [() => api.getCapture('c'), '/captures/c', 'GET'],
    [() => api.deleteCapture('c'), '/captures/c', 'DELETE'],
    [() => api.refineCapture('c', data as never), '/captures/c/refine', 'POST', data],
    [() => api.retranscribeCapture('c', data as never), '/captures/c/retranscribe', 'POST', data],
    [() => api.getCaptureSettings(), '/settings/captures', 'GET'],
    [() => api.getCaptureReadiness(), '/capture/readiness', 'GET'],
    [() => api.updateCaptureSettings(data as never), '/settings/captures', 'PUT', data],
    [() => api.getGenerationSettings(), '/settings/generation', 'GET'],
    [() => api.listMCPBindings(), '/mcp/bindings', 'GET'],
    [() => api.upsertMCPBinding(data as never), '/mcp/bindings', 'PUT', data],
    [() => api.getModelStatus(), '/models/status', 'GET'],
    [() => api.getModelsCacheDir(), '/models/cache-dir', 'GET'],
    [() => api.migrateModels('/dest'), '/models/migrate', 'POST', { destination: '/dest' }],
    [() => api.triggerModelDownload('m'), '/models/download', 'POST', { model_name: 'm' }],
    [() => api.deleteModel('m'), '/models/m', 'DELETE'],
    [() => api.unloadModel('m'), '/models/m/unload', 'POST'],
    [() => api.cancelDownload('m'), '/models/download/cancel', 'POST', { model_name: 'm' }],
    [() => api.getActiveTasks(), '/tasks/active', 'GET'],
    [() => api.clearAllTasks(), '/tasks/clear', 'POST'],
    [() => api.listChannels(), '/channels', 'GET'],
    [
      () => api.createChannel({ name: 'n', device_ids: [] }),
      '/channels',
      'POST',
      { name: 'n', device_ids: [] },
    ],
    [() => api.updateChannel('c', data), '/channels/c', 'PUT', data],
    [() => api.deleteChannel('c'), '/channels/c', 'DELETE'],
    [() => api.getChannelVoices('c'), '/channels/c/voices', 'GET'],
    [() => api.getProfileChannels('p'), '/profiles/p/channels', 'GET'],
    [
      () => api.setProfileChannels('p', ['c']),
      '/profiles/p/channels',
      'PUT',
      { channel_ids: ['c'] },
    ],
    [() => api.getCudaStatus(), '/backend/cuda-status', 'GET'],
    [() => api.downloadCudaBackend(), '/backend/download-cuda', 'POST'],
    [() => api.deleteCudaBackend(), '/backend/cuda', 'DELETE'],
    [() => api.getRocmStatus(), '/backend/rocm-status', 'GET'],
    [() => api.downloadRocmBackend(), '/backend/download-rocm', 'POST'],
    [() => api.deleteRocmBackend(), '/backend/rocm', 'DELETE'],
    [() => api.getStory('s'), '/stories/s', 'GET'],
    [() => api.updateStory('s', data as never), '/stories/s', 'PUT', data],
    [() => api.addStoryItem('s', data as never), '/stories/s/items', 'POST', data],
    [() => api.removeStoryItem('s', 'i'), '/stories/s/items/i', 'DELETE'],
    [() => api.updateStoryItemTimes('s', data as never), '/stories/s/items/times', 'PUT', data],
    [() => api.reorderStoryItems('s', data as never), '/stories/s/items/reorder', 'PUT', data],
    [() => api.trimStoryItem('s', 'i', data as never), '/stories/s/items/i/trim', 'PUT', data],
    [
      () => api.updateStoryItemVolume('s', 'i', data as never),
      '/stories/s/items/i/volume',
      'PUT',
      data,
    ],
    [() => api.splitStoryItem('s', 'i', data as never), '/stories/s/items/i/split', 'POST', data],
    [() => api.duplicateStoryItem('s', 'i'), '/stories/s/items/i/duplicate', 'POST'],
    [
      () => api.setStoryItemVersion('s', 'i', data as never),
      '/stories/s/items/i/version',
      'PUT',
      data,
    ],
    [() => api.getAvailableEffects(), '/effects/available', 'GET'],
    [() => api.listEffectPresets(), '/effects/presets', 'GET'],
    [() => api.createEffectPreset(data as never), '/effects/presets', 'POST', data],
    [() => api.updateEffectPreset('e', data), '/effects/presets/e', 'PUT', data],
    [() => api.deleteEffectPreset('e'), '/effects/presets/e', 'DELETE'],
    [() => api.listGenerationVersions('g'), '/generations/g/versions', 'GET'],
    [
      () => api.applyEffectsToGeneration('g', data as never),
      '/generations/g/versions/apply-effects',
      'POST',
      data,
    ],
    [() => api.setDefaultVersion('g', 'v'), '/generations/g/versions/v/set-default', 'PUT'],
    [
      () => api.updateGenerationVersion('g', 'v', data as never),
      '/generations/g/versions/v',
      'PUT',
      data,
    ],
    [() => api.getCloudStatus(), '/cloud/status', 'GET'],
    [() => api.startCloudLogin(), '/cloud/login/start', 'POST'],
    [() => api.disconnectCloud(), '/cloud/disconnect', 'POST'],
  ];
  for (const [call, path, method, body] of cases) {
    let request: RequestInit | undefined;
    globalThis.fetch = (async (url, init) => {
      expect(String(url)).toBe(`http://matrix.test${path}`);
      request = init;
      return Response.json({ ok: true });
    }) as typeof fetch;
    const result = await call();
    if (method !== 'DELETE' && path !== '/stories/s/items/times')
      expect(result).toEqual({ ok: true });
    expect(request?.method ?? 'GET').toBe(method);
    expect(request?.body).toBe(body === undefined ? undefined : JSON.stringify(body));
  }
  globalThis.fetch = (async () => Response.json({ versions: [{ id: 'v' }] })) as typeof fetch;
  expect(await api.deleteGenerationVersion('g', 'v')).toEqual([{ id: 'v' }]);
});

test('multipart and binary endpoints preserve protocol and reject errors', async () => {
  useServerStore.setState({ serverUrl: 'http://matrix.test' });
  const file = new File(['audio'], 'clip.wav', { type: 'audio/wav' });
  const uploads: Array<[() => Promise<unknown>, string, Record<string, string>]> = [
    [
      () => api.addProfileSample('p', file, 'hello'),
      '/profiles/p/samples',
      { reference_text: 'hello' },
    ],
    [() => api.importProfile(file), '/profiles/import', {}],
    [() => api.uploadAvatar('p', file), '/profiles/p/avatar', {}],
    [() => api.importGeneration(file), '/history/import', {}],
    [() => api.importAudio(file), '/generate/import', {}],
    [() => api.transcribeAudio(file), '/transcribe', {}],
    [
      () => api.transcribeAudio(file, 'en', 'base'),
      '/transcribe',
      { language: 'en', model: 'base' },
    ],
    [() => api.createCapture(file), '/captures', { source: 'file' }],
    [
      () => api.createCapture(file, { source: 'microphone', language: 'en', sttModel: 'base' }),
      '/captures',
      { source: 'microphone', language: 'en', stt_model: 'base' },
    ],
  ];
  for (const [call, path, fields] of uploads) {
    globalThis.fetch = (async (url, init) => {
      expect(String(url)).toBe(`http://matrix.test${path}`);
      expect(init?.method).toBe('POST');
      expect(init?.headers).toBeUndefined();
      const form = init?.body as FormData;
      expect(await (form.get('file') as File).text()).toBe('audio');
      for (const [key, value] of Object.entries(fields)) expect(form.get(key)).toBe(value);
      return Response.json({ id: 'ok' });
    }) as typeof fetch;
    expect(await call()).toEqual({ id: 'ok' });
    globalThis.fetch = (async () => new Response('null', { status: 503 })) as typeof fetch;
    await expect(call()).rejects.toThrow(
      path === '/generate/import' ? 'HTTP 503' : 'HTTP error! status: 503',
    );
    globalThis.fetch = (async () =>
      new Response('invalid', { status: 503, statusText: 'Unavailable' })) as typeof fetch;
    await expect(call()).rejects.toThrow('Unavailable');
    globalThis.fetch = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    await expect(call()).rejects.toThrow('offline');
    globalThis.fetch = (async () => new Response('invalid')) as typeof fetch;
    await expect(call()).rejects.toThrow();
  }
  const downloads: Array<[() => Promise<Blob>, string, string, unknown?]> = [
    [() => api.exportSampleAudio('a/b'), '/samples/a%2Fb/export-audio?format=mp3', 'GET'],
    [() => api.exportProfile('p'), '/profiles/p/export', 'GET'],
    [() => api.exportGeneration('g'), '/history/g/export', 'GET'],
    [() => api.exportGenerationAudio('g'), '/history/g/export-audio?format=wav', 'GET'],
    [
      () => api.exportStoryAudio('s', 'mp3'),
      '/stories/s/export-audio?format=mp3&chapters=auto',
      'GET',
    ],
    [() => api.previewEffects('g', []), '/effects/preview/g', 'POST', { effects_chain: [] }],
  ];
  for (const [call, path, method, body] of downloads) {
    globalThis.fetch = (async (url, init) => {
      expect(String(url)).toBe(`http://matrix.test${path}`);
      expect(init?.method ?? 'GET').toBe(method);
      expect(init?.body).toBe(body === undefined ? undefined : JSON.stringify(body));
      return new Response('sound');
    }) as typeof fetch;
    expect(await (await call()).text()).toBe('sound');
    globalThis.fetch = (async () => new Response('null', { status: 503 })) as typeof fetch;
    await expect(call()).rejects.toThrow('HTTP error! status: 503');
    globalThis.fetch = (async () =>
      new Response('invalid', { status: 503, statusText: 'Unavailable' })) as typeof fetch;
    await expect(call()).rejects.toThrow('Unavailable');
    globalThis.fetch = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    await expect(call()).rejects.toThrow('offline');
  }
});

test('URL helpers use latest server and encode revision', () => {
  useServerStore.setState({ serverUrl: 'http://new.test' });
  expect(api.getGenerationStatusUrl('g')).toBe('http://new.test/generate/g/status');
  expect(api.getAudioUrl('a')).toBe('http://new.test/audio/a');
  expect(api.getSampleUrl('a')).toBe('http://new.test/samples/a');
  expect(api.getCaptureAudioUrl('c')).toBe('http://new.test/captures/c/audio');
  expect(api.getMigrationProgressUrl()).toBe('http://new.test/models/migrate/progress');
  expect(api.getVersionAudioUrl('v', 'a/b &')).toBe(
    'http://new.test/audio/version/v?revision=a%2Fb%20%26',
  );
  expect(api.getVersionAudioUrl('v')).toBe('http://new.test/audio/version/v');
});

test('JSON response parser rejects malformed success and transport failure', async () => {
  globalThis.fetch = (async () => new Response('not json')) as typeof fetch;
  await expect(api.listProfiles()).rejects.toThrow();
  globalThis.fetch = (async () => {
    throw new Error('network down');
  }) as typeof fetch;
  await expect(api.listProfiles()).rejects.toThrow('network down');
});
