import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useUIStore } from '../src/stores/uiStore';

const profiles = [
  { id: 'justin', name: 'Justin', language: 'en', generation_count: 5, sample_count: 2 },
  { id: 'ella', name: 'Ella', language: 'fr', generation_count: 1, sample_count: 1 },
];
let discardCount = 0;
let saveOutcome = true;
let compactViewport = false;
mock.module('../src/lib/hooks/useMediaQuery', () => ({ useMediaQuery: () => compactViewport }));
mock.module('../src/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  ...Object.fromEntries(
    ['DialogContent', 'DialogTitle', 'DialogDescription'].map((key) => [
      key,
      ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    ]),
  ),
}));
let blocker!: { shouldBlockFn: () => boolean | Promise<boolean> };
mock.module('@tanstack/react-router', () => ({
  useBlocker: (options: typeof blocker) => {
    blocker = options;
  },
}));
mock.module('../src/components/ui/alert-dialog', () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div role="alertdialog">{children}</div> : null,
  ...Object.fromEntries(
    [
      'AlertDialogContent',
      'AlertDialogDescription',
      'AlertDialogFooter',
      'AlertDialogHeader',
      'AlertDialogTitle',
    ].map((key) => [key, ({ children }: { children: React.ReactNode }) => <div>{children}</div>]),
  ),
}));
mock.module('../src/lib/hooks/useProfiles', () => ({
  useProfiles: () => ({ data: profiles, isLoading: false }),
  useDeleteProfile: () => ({ isPending: false, mutate() {} }),
  useExportProfile: () => ({ isPending: false, mutate() {} }),
}));
mock.module('../src/lib/api/client', () => ({
  apiClient: {
    listChannels: async () => [],
    getProfileChannels: async () => ({ channel_ids: [] }),
  },
}));
mock.module('../src/components/VoiceProfiles/ProfileForm', () => ({ ProfileForm: () => null }));
mock.module('../src/components/VoicesTab/VoiceInspector', () => ({
  VoiceInspector: ({
    profileId,
    onDirtyChange,
    actionsRef,
  }: {
    profileId: string;
    onDirtyChange?: (dirty: boolean) => void;
    actionsRef?: { current: unknown };
  }) => {
    const [draft, setDraft] = useState('');
    if (actionsRef)
      actionsRef.current = {
        save: async () => saveOutcome,
        discard: () => {
          discardCount++;
        },
      };
    return (
      <aside>
        {profileId}
        <span>{draft}</span>
        <button
          type="button"
          aria-label="Edit selected voice"
          onClick={() => {
            setDraft('Local draft');
            onDirtyChange?.(true);
          }}
        >
          Edit
        </button>
      </aside>
    );
  },
}));
mock.module('../src/components/ui/multi-select', () => ({ MultiSelect: () => null }));
mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));
const { VoicesTab } = await import('../src/components/VoicesTab/VoicesTab');
let renderer: ReactTestRenderer;
let client: QueryClient;
async function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useUIStore.setState({ selectedVoiceId: 'justin' });
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <VoicesTab />
      </QueryClientProvider>,
    );
  });
}
afterEach(() => {
  act(() => renderer?.unmount());
  client?.clear();
  useUIStore.setState({ selectedVoiceId: null });
  discardCount = 0;
  saveOutcome = true;
  compactViewport = false;
});
afterAll(() => mock.restore());

test('each voice has a native keyboard-operable selection control', async () => {
  await mount();
  const ella = renderer.root.findAllByType('button').find((node) => node.props.title === 'Ella');
  expect(ella).toBeDefined();
  act(() => ella!.props.onClick({ stopPropagation() {} }));
  expect(useUIStore.getState().selectedVoiceId).toBe('ella');
  expect(renderer.root.findByProps({ title: 'Ella' }).props['aria-pressed']).toBe(true);
});

test('search trims whitespace and shows an explicit empty result', async () => {
  await mount();
  const search = renderer.root.findByType('input');
  act(() => search.props.onChange({ target: { value: '  JUSTIN  ' } }));
  expect(renderer.root.findAllByType('tbody')[0].findAllByType('tr')).toHaveLength(1);
  act(() => search.props.onChange({ target: { value: 'unmatched voice' } }));
  expect(renderer.root.findAllByType('output').map((node) => node.children.join(''))).toContain(
    'No matching voices. Try another search.',
  );
});

const clickLabel = (label: string) => {
  const node = renderer.root
    .findAllByType('button')
    .find((button) => button.children.includes(label));
  expect(node).toBeDefined();
  act(() => node!.props.onClick());
};

test('dirty voice selection waits for keep, discard or a successful save', async () => {
  await mount();
  const edit = () =>
    act(() => renderer.root.findByProps({ 'aria-label': 'Edit selected voice' }).props.onClick());
  const ella = () =>
    act(() => renderer.root.findByProps({ title: 'Ella' }).props.onClick({ stopPropagation() {} }));
  edit();
  ella();
  expect(useUIStore.getState().selectedVoiceId).toBe('justin');
  clickLabel('Keep editing');
  expect(useUIStore.getState().selectedVoiceId).toBe('justin');
  ella();
  clickLabel('Discard');
  expect(discardCount).toBe(1);
  expect(useUIStore.getState().selectedVoiceId).toBe('ella');
  edit();
  act(() => renderer.root.findByProps({ title: 'Justin' }).props.onClick({ stopPropagation() {} }));
  saveOutcome = false;
  await act(async () => clickLabel('common.save'));
  expect(useUIStore.getState().selectedVoiceId).toBe('ella');
  saveOutcome = true;
  await act(async () => clickLabel('common.save'));
  expect(useUIStore.getState().selectedVoiceId).toBe('justin');
});

test('dirty navigation blocks until the user decides and a clean navigation stays available', async () => {
  await mount();
  expect(blocker.shouldBlockFn()).toBe(false);
  act(() => renderer.root.findByProps({ 'aria-label': 'Edit selected voice' }).props.onClick());
  let decision!: boolean | Promise<boolean>;
  act(() => {
    decision = blocker.shouldBlockFn();
  });
  clickLabel('Keep editing');
  expect(await decision).toBe(true);
  act(() => {
    decision = blocker.shouldBlockFn();
  });
  clickLabel('Discard');
  expect(await decision).toBe(false);
});

test('crossing the compact breakpoint preserves a mounted dirty inspector', async () => {
  await mount();
  act(() => renderer.root.findByProps({ 'aria-label': 'Edit selected voice' }).props.onClick());
  compactViewport = true;
  act(() =>
    renderer.update(
      <QueryClientProvider client={client}>
        <VoicesTab />
      </QueryClientProvider>,
    ),
  );
  expect(
    renderer.root.findAllByType('span').some((node) => node.children.includes('Local draft')),
  ).toBe(true);
});
