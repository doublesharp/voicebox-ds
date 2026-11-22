import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

type Handler = (...args: unknown[]) => void;

interface FakeWaveSurferInstance {
  handlers: Map<string, Handler[]>;
  playing: boolean;
  context: {
    state: AudioContextState | 'interrupted';
    resume: ReturnType<typeof mock>;
    close: ReturnType<typeof mock>;
  };
  play: ReturnType<typeof mock>;
  pause: ReturnType<typeof mock>;
  destroy: ReturnType<typeof mock>;
  load: ReturnType<typeof mock>;
  getDuration: () => number;
  isPlaying: () => boolean;
  getMediaElement: () => { getGainNode: () => { context: FakeWaveSurferInstance['context'] } };
  on: (event: string, cb: Handler) => void;
  emit: (event: string, ...args: unknown[]) => void;
}

const instances: FakeWaveSurferInstance[] = [];

mock.module('wavesurfer.js', () => ({
  default: {
    create: () => {
      const handlers = new Map<string, Handler[]>();
      const context: FakeWaveSurferInstance['context'] = {
        state: 'interrupted',
        resume: mock(async () => {
          context.state = 'running';
        }),
        close: mock(async () => {
          context.state = 'closed';
        }),
      };
      const instance: FakeWaveSurferInstance = {
        handlers,
        playing: false,
        context,
        play: mock(async () => {
          instance.playing = true;
          instance.emit('play');
        }),
        pause: mock(() => {
          instance.playing = false;
          instance.emit('pause');
        }),
        destroy: mock(() => {}),
        load: mock(async () => {
          instance.emit('ready');
        }),
        getDuration: () => 4.2,
        isPlaying: () => instance.playing,
        getMediaElement: () => ({
          getGainNode: () => ({ context }),
        }),
        on: (event, cb) => {
          const list = handlers.get(event) ?? [];
          list.push(cb);
          handlers.set(event, list);
        },
        emit: (event, ...args) => {
          for (const cb of handlers.get(event) ?? []) cb(...args);
        },
      };
      instances.push(instance);
      return instance;
    },
  },
}));

const { CaptureInlinePlayer } = await import('../src/components/CapturesTab/CaptureInlinePlayer');

const originalDocument = globalThis.document;
const originalGetComputedStyle = globalThis.getComputedStyle;

let renderer: ReactTestRenderer | undefined;

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  instances.length = 0;
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: originalDocument,
  });
  Object.defineProperty(globalThis, 'getComputedStyle', {
    configurable: true,
    value: originalGetComputedStyle,
  });
});

afterAll(() => mock.restore());

test('CaptureInlinePlayer resumes interrupted AudioContext before play and closes it on unmount', async () => {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { documentElement: {} },
  });
  Object.defineProperty(globalThis, 'getComputedStyle', {
    configurable: true,
    value: () => ({ getPropertyValue: () => '210 40% 50%' }),
  });

  await act(async () => {
    renderer = create(
      <CaptureInlinePlayer audioUrl="/captures/a/audio" fallbackDurationMs={4200} />,
      { createNodeMock: () => ({}) },
    );
    await Promise.resolve();
  });

  expect(instances).toHaveLength(1);
  const ws = instances[0];
  expect(ws.context.state).toBe('interrupted');

  const playButton = renderer!.root.findByType('button');
  await act(async () => {
    playButton.props.onClick();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(ws.context.resume).toHaveBeenCalledTimes(1);
  expect(ws.context.state).toBe('running');
  expect(ws.play).toHaveBeenCalledTimes(1);

  act(() => renderer?.unmount());
  renderer = undefined;

  expect(ws.destroy).toHaveBeenCalledTimes(1);
  expect(ws.context.close).toHaveBeenCalledTimes(1);
  expect(ws.context.state).toBe('closed');
});
