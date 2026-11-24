import { afterEach, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

mock.module('react-dom', () => ({ createPortal: (element: React.ReactNode) => element }));
const { Hint } = await import('../src/components/ui/Hint');
const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const listeners = new Map<string, (event: KeyboardEvent) => void>();
let renderer: ReactTestRenderer;
afterEach(() => {
  act(() => renderer?.unmount());
  globalThis.window = originalWindow;
  globalThis.document = originalDocument;
  listeners.clear();
});

test('focus exposes a described tooltip, Escape dismisses it and blur cleans up', () => {
  globalThis.window = {
    innerWidth: 800,
    addEventListener: (name: string, fn: (event: KeyboardEvent) => void) => listeners.set(name, fn),
    removeEventListener: (name: string) => listeners.delete(name),
  } as unknown as Window & typeof globalThis;
  globalThis.document = { body: {} } as Document;
  act(() => {
    renderer = create(
      <Hint content="More detail">
        <button type="button" aria-label="Action" aria-describedby="existing">
          Go
        </button>
      </Hint>,
    );
  });
  const anchor = renderer.root.findByProps({ className: 'app-hint-anchor' });
  expect(renderer.root.findByType('button').props['aria-describedby']).toBe('existing');
  act(() => anchor.props.onFocus({ target: { matches: () => true } }));
  const tooltip = renderer.root.findByProps({ role: 'tooltip' });
  expect(renderer.root.findByType('button').props['aria-describedby']).toBe(
    `existing ${tooltip.props.id}`,
  );
  act(() => listeners.get('keydown')?.({ key: 'Escape' } as KeyboardEvent));
  expect(renderer.root.findAllByProps({ role: 'tooltip' })).toHaveLength(0);
  expect(renderer.root.findByType('button').props['aria-describedby']).toBe('existing');
  expect(listeners.size).toBe(0);
  act(() => anchor.props.onBlur());
  act(() => anchor.props.onMouseEnter());
  expect(renderer.root.findAllByProps({ role: 'tooltip' })).toHaveLength(1);
  act(() => anchor.props.onMouseLeave());
  expect(renderer.root.findAllByProps({ role: 'tooltip' })).toHaveLength(0);
  expect(listeners.size).toBe(0);
});

test('pointer activation dismisses hover and does not reopen on focus', () => {
  globalThis.window = {
    innerWidth: 800,
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as Window & typeof globalThis;
  globalThis.document = { body: {} } as Document;
  act(() => {
    renderer = create(
      <Hint content="Remove favorite">
        <button type="button">Unfavorite</button>
      </Hint>,
    );
  });
  const anchor = renderer.root.findByProps({ className: 'app-hint-anchor' });
  const tooltips = () => renderer.root.findAllByProps({ role: 'tooltip' });
  act(() => anchor.props.onFocus({ target: { matches: () => false } }));
  expect(tooltips()).toHaveLength(0);
  act(() => anchor.props.onMouseEnter());
  expect(tooltips()).toHaveLength(1);
  act(() => anchor.props.onPointerDownCapture());
  expect(tooltips()).toHaveLength(0);
  // Some controls and test environments report focus-visible even for a pointer click.
  act(() => anchor.props.onFocus({ target: { matches: () => true } }));
  expect(tooltips()).toHaveLength(0);
  act(() => anchor.props.onClickCapture());
  act(() => anchor.props.onFocus({ target: {} }));
  expect(tooltips()).toHaveLength(1);
  act(() => anchor.props.onClickCapture());
  expect(tooltips()).toHaveLength(0);
});
