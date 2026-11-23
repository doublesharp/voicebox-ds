import { afterAll, expect, mock, test } from 'bun:test';
import { act, create } from 'react-test-renderer';

const originalDocument = globalThis.document;
const originalStyle = globalThis.getComputedStyle;
globalThis.document = { documentElement: {} } as Document;
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '0 0% 50%' }) as CSSStyleDeclaration;

type Handler = (...args: unknown[]) => void;
const waves: ReturnType<typeof makeWave>[] = [];
function makeWave() {
  const handlers = new Map<string, Handler>();
  const rejects: Array<(error: Error) => void> = [];
  const wave = {
    on: (name: string, cb: Handler) => {
      handlers.set(name, cb);
    },
    emit: (name: string, ...args: unknown[]) => handlers.get(name)?.(...args),
    load: (_url: string) =>
      new Promise<void>((_resolve, fail) => {
        rejects.push(fail);
      }),
    fail: (index = 0) => rejects[index](new Error('old source failed')),
    getDuration: () => 12,
    getMediaElement: () => null,
    isPlaying: () => false,
    seekTo: () => {},
    pause: () => {},
    play: mock(async () => {
      wave.emit('play');
    }),
    destroy: mock(() => {}),
  };
  return wave;
}
mock.module('wavesurfer.js', () => ({
  default: {
    create: () => {
      const wave = makeWave();
      waves.push(wave);
      return wave;
    },
  },
}));
const { CaptureInlinePlayer } = await import('../src/components/CapturesTab/CaptureInlinePlayer');
afterAll(() => {
  globalThis.document = originalDocument;
  globalThis.getComputedStyle = originalStyle;
  mock.restore();
});

test('old source failure cannot disable a newly ready source', async () => {
  let view!: ReturnType<typeof create>;
  await act(async () => {
    view = create(<CaptureInlinePlayer audioUrl="a" />, { createNodeMock: () => ({}) });
  });
  const old = waves.at(-1)!;
  await act(async () => view.update(<CaptureInlinePlayer audioUrl="b" />));
  const current = waves.at(-1)!;
  await act(async () => current.emit('ready'));
  await act(async () => old.fail());
  expect(view.root.findByProps({ 'aria-label': 'Play' }).props.disabled).toBe(false);
  expect(view.root.findAllByType('span').at(-1)?.children).toEqual(['0:12']);
  act(() => view.unmount());
});

test('playback events update time and old events after source change and unmount are ignored', async () => {
  let view!: ReturnType<typeof create>;
  await act(async () => {
    view = create(<CaptureInlinePlayer audioUrl="first" fallbackDurationMs={4500} />, {
      createNodeMock: () => ({}),
    });
  });
  const old = waves.at(-1)!;
  expect(view.root.findAllByType('span').at(-1)?.children).toEqual(['0:05']);
  await act(async () => old.emit('ready'));
  await act(async () => view.root.findByProps({ 'aria-label': 'Play' }).props.onClick());
  expect(view.root.findByProps({ 'aria-label': 'Pause' })).toBeDefined();
  await act(async () => old.emit('timeupdate', 4));
  expect(view.root.findAllByType('span').at(-1)?.children).toEqual(['0:04']);
  await act(async () => view.update(<CaptureInlinePlayer audioUrl="second" />));
  const current = waves.at(-1)!;
  await act(async () => {
    current.emit('ready');
    old.emit('timeupdate', 99);
    old.emit('error', new Error('stale'));
  });
  expect(view.root.findAllByType('span').at(-1)?.children).toEqual(['0:12']);
  act(() => view.unmount());
  expect(current.destroy).toHaveBeenCalledTimes(1);
  await act(async () => {
    current.emit('ready');
    current.emit('play');
    current.fail();
  });
});
