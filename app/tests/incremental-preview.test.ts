import { afterEach, expect, mock, test } from 'bun:test';
import { apiClient } from '../src/lib/api/client';
import { pcmWaveStream } from '../src/lib/audio/pcmWaveStream';
import { IncrementalPlayback } from '../src/lib/audio/incrementalPlayback';
import type { NativePlaybackEvent, PlatformAudio } from '../src/platform/types';

const fetchOriginal = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = fetchOriginal;
});
const request = {
  profile_id: 'the-selected-voice',
  text: 'Hello',
  engine: 'qwen_custom_voice' as const,
};
function wave(samples = [1, -2, 32767], rate = 24000): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (const [offset, text] of [
    [0, 'RIFF'],
    [8, 'WAVEfmt '],
    [36, 'data'],
  ] as const)
    bytes.set(new TextEncoder().encode(text), offset);
  view.setUint32(4, 0xffffffff, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, 0xffffffff, true);
  samples.forEach((sample, index) => {
    view.setInt16(44 + index * 2, sample, true);
  });
  return bytes;
}
function stream(chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}
async function collect(body: ReadableStream<Uint8Array>, mode: 'incremental' | 'buffered' = 'incremental') {
  const blocks = [];
  for await (const block of pcmWaveStream(body, new AbortController().signal, mode)) blocks.push(block);
  return blocks;
}
function native() {
  let listener: (event: NativePlaybackEvent) => void = () => {};
  const audio = {
    stopPlayback: mock(async (_id?: string) => {}),
    startPcmStream: mock(async (_rate: number, _devices: string[]) => ({
      session_id: 'session',
      position: 0,
      duration: 0,
    })),
    appendPcmStream: mock(async (_id: string, _pcm: Uint8Array) => {}),
    finishPcmStream: mock(async (_id: string) => {}),
    subscribeToPlayback: mock(async (callback: typeof listener) => {
      listener = callback;
      return unlisten;
    }),
  };
  const unlisten = mock(() => {});
  return {
    audio: audio as unknown as PlatformAudio,
    calls: audio,
    unlisten,
    event: (event: Partial<NativePlaybackEvent>) =>
      listener({ session_id: 'session', position: 0, duration: 0, state: 'ended', ...event }),
  };
}
const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

test('preview posts only the selected voice and explicitly unmastered streaming request', async () => {
  let seenUrl = '';
  let seen!: RequestInit;
  const body = stream([wave()]);
  globalThis.fetch = mock(async (url, options) => {
    seenUrl = String(url);
    seen = options!;
    return new Response(body);
  }) as typeof fetch;
  const signal = new AbortController().signal;
  const response = await apiClient.previewSpeech(
    { ...request, normalize: true, effects_chain: [{ type: 'reverb', enabled: true, params: {} }] },
    signal,
  );
  expect(seenUrl.endsWith('/generate/stream?incremental=true')).toBe(true);
  expect(JSON.parse(String(seen.body))).toMatchObject({
    ...request,
    normalize: false,
    effects_chain: [],
    speed: 1,
  });
  expect(seen.signal).toBe(signal);
  expect(response.body).toBe(body);
});

test('buffered preview sends the same processing and delivery options as a generated take', async () => {
  const options = {
    ...request,
    engine: 'chatterbox' as const,
    normalize: true,
    speed: 0.95,
    chatterbox_cfg_weight: 0.3,
    chatterbox_exaggeration: 0.7,
    effects_chain: [{ type: 'compressor', enabled: true, params: {} }],
  };
  const calls = mock(async () => new Response(wave()));
  globalThis.fetch = calls as unknown as typeof fetch;
  const signal = new AbortController().signal;
  await apiClient.previewSpeech(options, signal, 'buffered');
  const [url, init] = calls.mock.calls[0] as unknown as [string, RequestInit];
  expect(url.endsWith('/generate/stream')).toBe(true);
  expect(JSON.parse(String(init.body))).toEqual(options);
  expect(init.signal).toBe(signal);
});

test('stopping during the first model load cancels the preview before synthesis', async () => {
  const abort = new AbortController();
  const calls = mock(async (_url: string, _options: RequestInit) => {
    abort.abort();
    return Response.json({ message: 'Model loaded' });
  });
  globalThis.fetch = calls as unknown as typeof fetch;
  await expect(
    apiClient.previewSpeech(request, abort.signal, 'buffered', 'chatterbox-tts'),
  ).rejects.toThrow('Preview stopped');
  expect(calls).toHaveBeenCalledTimes(1);
  const [url, options] = calls.mock.calls[0];
  expect(url.endsWith('/models/load')).toBe(true);
  expect(JSON.parse(String(options.body))).toEqual({ model_name: 'chatterbox-tts' });
  expect(options.signal).toBe(abort.signal);
});

test('buffered preview plays a complete sized WAV and rejects a truncated recording', async () => {
  const bytes = wave();
  const view = new DataView(bytes.buffer);
  view.setUint32(4, bytes.length - 8, true);
  view.setUint32(40, bytes.length - 44, true);
  const blocks = await collect(stream([bytes.slice(0, 27), bytes.slice(27)]), 'buffered');
  expect([...blocks.flatMap((block) => [...block.pcm])]).toEqual([...bytes.slice(44)]);
  const output = native();
  const preview = new IncrementalPlayback(
    output.audio,
    () => {},
    async () => new Response(bytes),
  );
  await preview.start(request, ['studio-speaker'], () => true, 'buffered');
  expect(output.calls.startPcmStream).toHaveBeenCalledWith(24000, ['studio-speaker']);
  expect(output.calls.appendPcmStream).toHaveBeenCalledWith('session', bytes.slice(44));
  expect(output.calls.finishPcmStream).toHaveBeenCalledWith('session');
  output.event({ state: 'ended' });
  await expect(collect(stream([bytes.slice(0, 46)]), 'buffered')).rejects.toThrow('incomplete');
});

test('every arbitrary header/sample boundary preserves PCM exactly at supported sample rates', async () => {
  for (const rate of [8000, 16000, 24000, 44100, 48000, 192000]) {
    const bytes = wave([1, -2, 32767], rate);
    for (let split = 1; split < bytes.length; split++) {
      const result = await collect(stream([bytes.slice(0, split), bytes.slice(split)]));
      expect(result.every((block) => block.sampleRate === rate)).toBe(true);
      expect([...result.flatMap((block) => [...block.pcm])]).toEqual([...bytes.slice(44)]);
    }
  }
});

test('large network chunks are delivered in bounded blocks without another read', async () => {
  const blocks = await collect(stream([wave(Array.from({ length: 100000 }, (_, n) => n % 30000))]));
  expect(blocks.length).toBeGreaterThan(20);
  expect(Math.max(...blocks.map((block) => block.pcm.length))).toBeLessThanOrEqual(8192);
  expect(blocks.reduce((sum, block) => sum + block.pcm.length, 0)).toBe(200000);
});

test('invalid format, changing frame format, incomplete samples and empty streams fail closed', async () => {
  for (const bytes of [
    wave([], 24000),
    wave([1], 0),
    wave([1], 192001),
    wave().slice(0, 43),
    wave().slice(0, 49),
  ]) {
    await expect(collect(stream([bytes]))).rejects.toThrow();
  }
  for (const offset of [0, 8, 12, 16, 20, 22, 28, 32, 34, 36, 40]) {
    const bytes = wave();
    bytes[offset] ^= 8;
    await expect(collect(stream([bytes]))).rejects.toThrow('Unsupported');
  }
});

test('queues audible PCM before synthesis completes and retains one device stream through underruns', async () => {
  const n = native();
  const updates = mock(() => {});
  let network!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      network = controller;
      controller.enqueue(wave());
    },
  });
  const player = new IncrementalPlayback(n.audio, updates, async () => new Response(body));
  const playing = player.start(request, ['selected-output']);
  await tick();
  expect(n.calls.startPcmStream).toHaveBeenCalledWith(24000, ['selected-output']);
  expect(n.calls.appendPcmStream).toHaveBeenCalledTimes(1);
  expect(n.calls.finishPcmStream).not.toHaveBeenCalled();
  network.enqueue(new Uint8Array([3, 0]));
  await tick();
  expect(n.calls.startPcmStream).toHaveBeenCalledTimes(1);
  expect(n.calls.appendPcmStream).toHaveBeenCalledTimes(2);
  network.close();
  await playing;
  expect(n.calls.finishPcmStream).toHaveBeenCalledWith('session');
  n.event({ state: 'ended' });
  expect(updates).toHaveBeenLastCalledWith(false);
  expect(n.unlisten).toHaveBeenCalledTimes(1);
});

test('native backpressure pauses further network consumption, cancellation stops the pending read', async () => {
  const n = native();
  let unblock!: () => void;
  n.calls.appendPcmStream.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        unblock = resolve;
      }),
  );
  let cancelled = false;
  let reads = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        reads++;
        controller.enqueue(reads === 1 ? wave() : new Uint8Array([1, 0]));
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const player = new IncrementalPlayback(
    n.audio,
    () => {},
    async () => new Response(body),
  );
  const playing = player.start(request, []);
  await tick();
  expect(reads).toBe(1);
  await player.stop();
  await player.stop();
  unblock();
  await playing;
  expect(cancelled).toBe(true);
  expect(n.calls.finishPcmStream).not.toHaveBeenCalled();
  expect(n.calls.stopPlayback.mock.calls.some(([id]) => id === 'session')).toBe(true);
});

test('replacement discards a late response without starting the superseded voice', async () => {
  const n = native();
  let first!: (response: Response) => void;
  let calls = 0;
  const player = new IncrementalPlayback(
    n.audio,
    () => {},
    async () =>
      ++calls === 1
        ? new Promise<Response>((resolve) => {
            first = resolve;
          })
        : new Response(stream([wave()])),
  );
  const old = player.start(request, []);
  await tick();
  await player.start({ ...request, profile_id: 'replacement-voice' }, []);
  first(new Response(stream([wave()])));
  await old;
  expect(n.calls.startPcmStream).toHaveBeenCalledTimes(1);
  expect(n.calls.appendPcmStream).toHaveBeenCalledTimes(1);
  n.event({ state: 'ended' });
});

test('disconnect, invalid response, request rejection and output failures cancel preview with no voice fallback', async () => {
  for (const kind of ['disconnect', 'invalid', 'request', 'native']) {
    const n = native();
    const updates = mock(() => {});
    let cancelled = false;
    let network!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        network = controller;
        if (kind !== 'invalid') controller.enqueue(wave());
        else {
          controller.enqueue(new Uint8Array(44));
          controller.close();
        }
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetcher = mock(async (data: typeof request) => {
      expect(data.profile_id).toBe(request.profile_id);
      if (kind === 'request') throw new Error('offline');
      return new Response(body);
    });
    const player = new IncrementalPlayback(n.audio, updates, fetcher);
    const playing = player.start(request, ['missing-or-selected-device']);
    await tick();
    if (kind === 'disconnect') network.error(new Error('disconnected'));
    if (kind === 'native') n.event({ state: 'error', error: 'Device disconnected' });
    await playing;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(
      updates.mock.calls.some(
        (args: unknown[]) => args[0] === false && typeof args[1] === 'string',
      ),
    ).toBe(true);
    if (kind === 'native') expect(cancelled).toBe(true);
  }
});

test('a late native startup is stopped before its replacement starts; repeated cancellation releases listeners once', async () => {
  const n = native();
  let finishStart!: (session: { session_id: string; duration: number; position: number }) => void;
  n.calls.startPcmStream.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishStart = resolve;
      }),
  );
  n.calls.startPcmStream.mockImplementation(async () => ({
    session_id: 'replacement',
    duration: 0,
    position: 0,
  }));
  const player = new IncrementalPlayback(
    n.audio,
    () => {},
    async () => new Response(stream([wave()])),
  );
  const previous = player.start(request, []);
  await tick();
  expect(n.calls.startPcmStream).toHaveBeenCalledTimes(1);
  const replacement = player.start({ ...request, profile_id: 'replacement-voice' }, []);
  await tick();
  expect(n.calls.startPcmStream).toHaveBeenCalledTimes(1);
  finishStart({ session_id: 'retired', position: 0, duration: 0 });
  await previous;
  await replacement;
  expect(n.calls.stopPlayback.mock.calls.some(([id]) => id === 'retired')).toBe(true);
  expect(n.calls.appendPcmStream.mock.calls.map(([id]) => id)).toEqual(['replacement']);
  const released = n.unlisten.mock.calls.length;
  await player.stop();
  await player.stop();
  expect(n.unlisten.mock.calls.length).toBe(released + 1);
});

test('a different playback owner revokes the response and its output, including pending network reads', async () => {
  const n = native();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(wave());
    },
    cancel() {
      cancelled = true;
    },
  });
  const player = new IncrementalPlayback(
    n.audio,
    () => {},
    async () => new Response(body),
  );
  const playing = player.start(request, []);
  await tick();
  const { legacyPlaybackToken } = await import('../src/lib/audio/playbackOwnership');
  const replacement = legacyPlaybackToken();
  await playing;
  replacement.release();
  expect(cancelled).toBe(true);
  expect(n.calls.stopPlayback.mock.calls.some(([id]) => id === 'session')).toBe(true);
  expect(n.unlisten).toHaveBeenCalledTimes(1);
});

test('revocation during controller handoff cannot issue a request or acquire a native owner', async () => {
  const output = native();
  const fetch = mock(async () => new Response(stream([wave()])));
  const controller = new IncrementalPlayback(output.audio, () => {}, fetch);
  let current = true;
  const pending = controller.start(request, [], () => current);
  current = false;
  await pending;
  expect(fetch).not.toHaveBeenCalled();
  expect(output.audio.startPcmStream).not.toHaveBeenCalled();
});
