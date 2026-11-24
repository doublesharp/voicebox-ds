import { afterAll, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create } from 'react-test-renderer';

let ready = false;
mock.module('../src/lib/api/client', () => ({
  apiClient: { listCaptures: async () => ({ items: [] }), listProfiles: async () => [] },
}));
mock.module('../src/lib/hooks/useSettings', () => ({
  useCaptureSettings: () => ({ settings: { hotkey_enabled: false }, update() {} }),
}));
mock.module('../src/lib/hooks/useDictationReadiness', () => ({
  useDictationReadiness: () => ({ canRecord: false, canCapture: ready }),
}));
mock.module('../src/lib/hooks/useCaptureRecordingSession', () => ({
  useCaptureRecordingSession: () => ({
    pillState: 'hidden',
    isRecording: false,
    isUploading: false,
  }),
}));
mock.module('../src/components/CapturesTab/DictationReadinessChecklist', () => ({
  DictationReadinessChecklist: () => <div data-readiness>Set up dictation</div>,
}));
mock.module('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => (
    <a href="/settings/captures">{children}</a>
  ),
}));
mock.module('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
mock.module('@tauri-apps/plugin-dialog', () => ({ save: async () => null }));
mock.module('@tauri-apps/plugin-fs', () => ({
  writeFile: async () => {},
  writeTextFile: async () => {},
}));
mock.module('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init() {} },
  useTranslation: () => ({ t: (key: string) => key }),
}));
const { CapturesTab } = await import('../src/components/CapturesTab/CapturesTab');
const { profileListKey } = await import('../src/lib/hooks/useProfiles');
const { currentServerScope } = await import('../src/lib/serverScope');
afterAll(() => mock.restore());
test('manual Capture actions require the models and work without global shortcut permissions', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['captures'], { items: [] });
  client.setQueryData(profileListKey(currentServerScope()), []);
  let view!: ReturnType<typeof create>;
  const tree = () => (
    <QueryClientProvider client={client}>
      <CapturesTab />
    </QueryClientProvider>
  );
  await act(async () => {
    view = create(tree());
  });
  expect(view.root.findAllByProps({ 'data-readiness': true })).toHaveLength(1);
  expect(
    view.root
      .findAllByType('button')
      .some((node) => node.children.includes('captures.actions.dictate')),
  ).toBe(false);
  ready = true;
  act(() => view.update(tree()));
  expect(view.root.findAllByProps({ 'data-readiness': true })).toHaveLength(0);
  expect(
    view.root
      .findAllByType('button')
      .some((node) => node.children.includes('captures.actions.dictate')),
  ).toBe(true);
  expect(
    view.root
      .findAllByType('button')
      .some((node) => node.children.includes('captures.actions.import')),
  ).toBe(true);
  act(() => view.unmount());
  client.clear();
});
