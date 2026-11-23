import { afterEach, expect, test } from 'bun:test';
import { useRef } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import {
  HistoryPlaybackState,
  historyWindowRange,
  useHistoryWindow,
} from '../src/components/History/historyWindow';
import { usePlayerStore } from '../src/stores/playerStore';

let view: ReactTestRenderer | undefined;
const originalWindow = globalThis.window;
const originalObserver = globalThis.ResizeObserver;
afterEach(() => {
  act(() => view?.unmount());
  view = undefined;
  globalThis.window = originalWindow;
  globalThis.ResizeObserver = originalObserver;
  usePlayerStore.getState().reset();
});

test('window attaches after async loading, scrolls to older rows, and retains an interaction row', () => {
  const listeners = new Map<string, () => void>();
  let scrollTop = 0;
  const root = {
    clientHeight: 600,
    getBoundingClientRect: () => ({ top: 0 }),
    addEventListener: (name: string, callback: () => void) => listeners.set(name, callback),
    removeEventListener: (name: string) => listeners.delete(name),
  };
  const content = { getBoundingClientRect: () => ({ top: -scrollTop }) };
  globalThis.window = {
    innerHeight: 600,
    addEventListener() {},
    removeEventListener() {},
  } as unknown as Window & typeof globalThis;
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  const keys = Array.from({ length: 1000 }, (_, index) => String(index));
  function Harness({ loaded, pin }: { loaded: boolean; pin?: string }) {
    const scroll = useRef<HTMLDivElement>(null);
    const list = useHistoryWindow(loaded ? keys : [], scroll, false, [pin ?? null]);
    return (
      <div data-root ref={scroll}>
        {loaded && (
          <div data-content ref={list.content}>
            {list.rows.map((row) => (
              <span key={row.index} data-index={row.index} />
            ))}
          </div>
        )}
      </div>
    );
  }
  act(() => {
    view = create(<Harness loaded={false} />, {
      createNodeMock: (element) =>
        element.props['data-root'] !== undefined
          ? root
          : element.props['data-content'] !== undefined
            ? content
            : null,
    });
  });
  act(() => view!.update(<Harness loaded pin="0" />));
  expect(listeners.has('scroll')).toBe(true);
  expect(view!.root.findAllByType('span').length).toBeLessThan(20);
  scrollTop = 116 * 500;
  act(() => listeners.get('scroll')!());
  const indices = view!.root.findAllByType('span').map((node) => node.props['data-index']);
  expect(indices).toContain(500);
  expect(indices).toContain(0);
  expect(indices).not.toContain(100);
});

test('variable-height boundaries include expanded rows without mounting the collection', () => {
  const offsets = [0, 152, 1152, 1304, 1456, 1608, 1760, 1912, 2064];
  expect(historyWindowRange(offsets, 700, 100)).toEqual({ start: 1, end: 3 });
});

test('playback changes rerender only the selected history rows', () => {
  const renders = [0, 0, 0];
  act(() => {
    view = create(
      <div>
        {['0', '1', '2'].map((id) => (
          <HistoryPlaybackState key={id} id={id}>
            {() => {
              renders[Number(id)]++;
              return null;
            }}
          </HistoryPlaybackState>
        ))}
      </div>,
    );
  });
  expect(renders).toEqual([1, 1, 1]);
  act(() => usePlayerStore.getState().setAudio('/one', '1', 'voice'));
  expect(renders).toEqual([1, 2, 1]);
  act(() => usePlayerStore.getState().setCurrentTime(2));
  expect(renders).toEqual([1, 2, 1]);
  act(() => usePlayerStore.getState().setIsPlaying(true));
  expect(renders).toEqual([1, 3, 1]);
  act(() => usePlayerStore.getState().setAudio('/two', '2', 'voice'));
  expect(renders).toEqual([1, 4, 2]);
});
