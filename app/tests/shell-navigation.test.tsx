import { afterEach, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

let path = '/';
mock.module('@tanstack/react-router', () => ({
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname: path } }),
  Link: ({ to, children, ...props }: Record<string, unknown>) => (
    <a href={to as string} {...props}>
      {children as React.ReactNode}
    </a>
  ),
}));
mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key.split('.')[1] }),
}));
mock.module('../src/platform/PlatformContext', () => ({
  usePlatform: () => ({
    updater: { getStatus: () => ({ available: false }), subscribe: () => () => {} },
  }),
}));
const { Sidebar } = await import('../src/components/Sidebar');
let renderer: ReactTestRenderer;
afterEach(() => act(() => renderer?.unmount()));

for (const [route, current] of [
  ['/', 'generate'],
  ['/studio/projects', 'Projects'],
  ['/studio/projects/p/edit', 'Projects'],
  ['/stories', 'stories'],
  ['/voices', 'voices'],
  ['/captures', 'captures'],
  ['/effects', 'effects'],
  ['/models', 'models'],
  ['/settings/generation', 'settings'],
] as const) {
  test(`${route} has one current navigation destination`, () => {
    path = route;
    act(() => {
      renderer = create(<Sidebar />);
    });
    const links = renderer.root.findAllByType('a');
    const active = links.filter((link) => link.props['aria-current'] === 'page');
    expect(active).toHaveLength(1);
    expect(active[0].props['aria-label']).toBe(current);
    expect(links.some((link) => link.props.href === '/stories')).toBe(true);
  });
}

test('desktop sidebar offers an accessible collapse control without losing navigation', () => {
  path = '/voices';
  let toggles = 0;
  act(() => {
    renderer = create(<Sidebar desktop collapsed={false} onToggle={() => toggles++} />);
  });
  const toggle = renderer.root.findByProps({ 'aria-label': 'Collapse sidebar' });
  expect(toggle.props['aria-expanded']).toBe(true);
  act(() => toggle.props.onClick());
  expect(toggles).toBe(1);
  act(() => renderer.update(<Sidebar desktop collapsed onToggle={() => toggles++} />));
  expect(renderer.root.findByProps({ 'aria-label': 'Expand sidebar' }).props['aria-expanded']).toBe(
    false,
  );
  expect(renderer.root.findAllByType('a').some((link) => link.props.href === '/voices')).toBe(true);
});

test('desktop sidebar width can be changed with a keyboard and stays bounded', () => {
  const widths: number[] = [];
  act(() => {
    renderer = create(
      <Sidebar
        desktop
        collapsed={false}
        width={196}
        onResize={(width: number) => widths.push(width)}
      />,
    );
  });
  const divider = renderer.root.findByProps({ 'aria-label': 'Resize sidebar' });
  expect(divider.props['aria-valuenow']).toBe(196);
  let prevented = 0;
  act(() => divider.props.onKeyDown({ key: 'ArrowRight', preventDefault: () => prevented++ }));
  act(() => divider.props.onKeyDown({ key: 'Home', preventDefault: () => prevented++ }));
  act(() => divider.props.onKeyDown({ key: 'End', preventDefault: () => prevented++ }));
  expect(widths).toEqual([206, 160, 280]);
  expect(prevented).toBe(3);
});

test('sidebar dragging only follows the captured pointer and clamps the width', () => {
  const widths: number[] = [];
  let capture = 0;
  act(() => {
    renderer = create(
      <Sidebar desktop width={196} onResize={(width: number) => widths.push(width)} />,
    );
  });
  const divider = renderer.root.findByProps({ 'aria-label': 'Resize sidebar' });
  const currentTarget = {
    setPointerCapture: (id: number) => {
      capture = id;
    },
  };
  act(() => divider.props.onPointerDown({ button: 0, pointerId: 7, currentTarget }));
  act(() => divider.props.onPointerMove({ pointerId: 8, clientX: 220 }));
  act(() => divider.props.onPointerMove({ pointerId: 7, clientX: 500 }));
  act(() => divider.props.onLostPointerCapture());
  act(() => divider.props.onPointerMove({ pointerId: 7, clientX: 170 }));
  expect(capture).toBe(7);
  expect(widths).toEqual([280]);
});
