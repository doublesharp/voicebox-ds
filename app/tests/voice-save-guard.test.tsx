import { afterAll, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create } from 'react-test-renderer';
import { useUIStore } from '../src/stores/uiStore';

const profiles = [
  { id: 'a', name: 'Alpha', language: 'en', description: '', effects_chain: [], sample_count: 0 },
  { id: 'b', name: 'Beta', language: 'en', description: '', effects_chain: [], sample_count: 0 },
];
const requests: Array<{ values: { name: string }; finish: () => void; promise: Promise<void> }> =
  [];
mock.module('../src/lib/hooks/useProfiles', () => ({
  useProfiles: () => ({ data: profiles }),
  useProfile: (id: string) => ({ data: profiles.find((p) => p.id === id) }),
  useDeleteProfile: () => ({ mutateAsync: async () => {} }),
  useExportProfile: () => ({ mutateAsync: async () => {} }),
  useUpdateProfile: () => ({
    isPending: false,
    mutateAsync: ({ data }: { data: { name: string } }) => {
      let finish!: () => void;
      const promise = new Promise<void>((resolve) => {
        finish = resolve;
      });
      requests.push({ values: data, finish, promise });
      return promise;
    },
  }),
  useUpdateProfileEffects: () => ({ mutateAsync: async () => {} }),
  useUploadAvatar: () => ({ mutate() {} }),
  useDeleteAvatar: () => ({ isPending: false, mutateAsync: async () => {} }),
}));
mock.module('../src/lib/api/client', () => ({
  apiClient: {
    listChannels: async () => [],
    getProfileChannels: async () => ({ channel_ids: [] }),
  },
}));
mock.module('../src/components/VoiceProfiles/ProfileForm', () => ({ ProfileForm: () => null }));
mock.module('../src/components/VoiceProfiles/SampleList', () => ({ SampleList: () => null }));
mock.module('../src/components/Effects/EffectsChainEditor', () => ({
  EffectsChainEditor: () => null,
}));
mock.module('../src/components/ui/multi-select', () => ({ MultiSelect: () => null }));
mock.module('../src/components/ui/select', () =>
  Object.fromEntries(
    ['Select', 'SelectContent', 'SelectItem', 'SelectTrigger', 'SelectValue'].map((key) => [
      key,
      ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    ]),
  ),
);
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
mock.module('../src/components/ui/use-toast', () => ({ useToast: () => ({ toast() {} }) }));
mock.module('@tanstack/react-router', () => ({ useBlocker() {} }));
mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));
const { VoicesTab } = await import('../src/components/VoicesTab/VoicesTab');
afterAll(() => mock.restore());

for (const latestName of ['Newer draft', 'Alpha'])
  test(`footer and navigation saves serialize and retain ${latestName} while pending`, async () => {
    requests.length = 0;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    useUIStore.setState({ selectedVoiceId: 'a' });
    let view!: ReturnType<typeof create>;
    await act(async () => {
      view = create(
        <QueryClientProvider client={client}>
          <VoicesTab />
        </QueryClientProvider>,
      );
    });
    const input = () =>
      view.root
        .findAllByType('input')
        .find((node) => node.props.placeholder === 'profileForm.fields.namePlaceholder')!;
    const type = async (value: string) => {
      await act(async () => {
        await input().props.onChange({ target: { name: 'name', value }, type: 'change' });
      });
    };
    await type('First save');
    let pending!: Promise<void>;
    await act(async () => {
      pending = view.root.findByType('form').props.onSubmit({ preventDefault() {}, persist() {} });
      await Bun.sleep(5);
    });
    await type(latestName);
    act(() => view.root.findByProps({ title: 'Beta' }).props.onClick({ stopPropagation() {} }));
    expect(useUIStore.getState().selectedVoiceId).toBe('a');
    const guard = () => view.root.findByProps({ role: 'alertdialog' });
    const guardButton = (label: string) =>
      guard()
        .findAllByType('button')
        .find((node) => node.children.includes(label))!;
    expect(guardButton('Discard').props.disabled).toBe(true);
    const save = guardButton('profileForm.actions.saving');
    act(() => save.props.onClick());
    expect(requests).toHaveLength(1);
    expect(useUIStore.getState().selectedVoiceId).toBe('a');
    await act(async () => {
      requests[0].finish();
      await pending;
    });
    expect(input().props.value).toBe(latestName);
    act(() => {
      guardButton('common.save').props.onClick();
    });
    await act(async () => {
      await Bun.sleep(5);
    });
    expect(requests).toHaveLength(2);
    expect(requests[1].values.name).toBe(latestName);
    await act(async () => {
      requests[1].finish();
      await requests[1].promise;
      await Bun.sleep(5);
    });
    expect(useUIStore.getState().selectedVoiceId).toBe('b');
    act(() => view.unmount());
    client.clear();
  });
