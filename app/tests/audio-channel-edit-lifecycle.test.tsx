import { afterAll, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create } from 'react-test-renderer';

let resolveVoices!: (value: { profile_ids: string[] }) => void;
const voices = new Promise<{ profile_ids: string[] }>((resolve) => {
  resolveVoices = resolve;
});
let getVoices = () => voices;
const initialChannel = {
  id: 'channel',
  name: 'Narration',
  is_default: false,
  device_ids: [] as string[],
};
let loadChannels = async () => [initialChannel];
const saveChannel = mock(async () => ({}));
const saveVoices = mock(async (_id: string, _ids: string[]) => ({}));
mock.module('../src/lib/api/client', () => ({
  apiClient: {
    listChannels: () => loadChannels(),
    listProfiles: async () => [{ id: 'voice', name: 'Existing voice' }],
    getChannelVoices: () => getVoices(),
    updateChannel: saveChannel,
    setChannelVoices: saveVoices,
  },
}));
mock.module('../src/platform/PlatformContext', () => ({
  usePlatform: () => ({
    metadata: { isTauri: true },
    audio: { listOutputDevices: async () => [] },
  }),
}));
mock.module('../src/stores/playerStore', () => ({
  usePlayerStore: (selector: any) => selector({ audioUrl: null }),
}));
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
mock.module('lucide-react', () =>
  Object.fromEntries(
    ['Check', 'CheckCircle2', 'Edit', 'Plus', 'Speaker', 'Trash2'].map((name) => [
      name,
      (props: any) => <svg {...props} data-icon={name} />,
    ]),
  ),
);
mock.module('../src/components/ui/button', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));
mock.module('../src/components/ui/badge', () => ({
  Badge: ({ children }: any) => <span>{children}</span>,
}));
mock.module('../src/components/ui/input', () => ({ Input: (props: any) => <input {...props} /> }));
mock.module('../src/components/ui/label', () => ({
  Label: ({ children }: any) => <label>{children}</label>,
}));
mock.module('../src/components/ui/dialog', () => {
  const Part = ({ children }: any) => <div>{children}</div>;
  return {
    Dialog: ({ open, children }: any) => (open ? <div>{children}</div> : null),
    DialogContent: Part,
    DialogDescription: Part,
    DialogFooter: Part,
    DialogHeader: Part,
    DialogTitle: Part,
  };
});
mock.module('../src/components/ui/select', () => {
  const Part = ({ children }: any) => <div>{children}</div>;
  return {
    Select: Part,
    SelectContent: Part,
    SelectItem: Part,
    SelectTrigger: Part,
    SelectValue: Part,
  };
});
const { AudioTab } = await import('../src/components/AudioTab/AudioTab');
const { profileListKey } = await import('../src/lib/hooks/useProfiles');
const { currentServerScope } = await import('../src/lib/serverScope');
afterAll(() => mock.restore());

test('editing waits for existing voice assignments before allowing a save', async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  queryClient.setQueryData(
    ['channels'],
    [{ id: 'channel', name: 'Narration', is_default: false, device_ids: [] }],
  );
  queryClient.setQueryData(['audio-devices'], []);
  queryClient.setQueryData(profileListKey(currentServerScope()), [{ id: 'voice', name: 'Existing voice' }]);
  let view!: ReturnType<typeof create>;
  try {
    await act(async () => {
      view = create(
        <QueryClientProvider client={queryClient}>
          <AudioTab />
        </QueryClientProvider>,
      );
    });
    const edit = view.root
      .findAllByType('button')
      .filter((button) =>
        button.findAllByType('svg').some((icon) => icon.props['data-icon'] === 'Edit'),
      )
      .at(-1)!;
    await act(async () => {
      edit.props.onClick({ stopPropagation() {} });
    });
    const saveButtons = () =>
      view.root.findAllByType('button').filter((button) => button.children.includes('common.save'));
    expect(saveButtons().every((button) => button.props.disabled)).toBe(true);
    await act(async () => {
      resolveVoices({ profile_ids: ['voice'] });
      await voices;
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(JSON.stringify(view.toJSON())).toContain('Existing voice');
    const save = saveButtons().find((button) => !button.props.disabled)!;
    await act(async () => {
      save.props.onClick();
    });
    expect(saveVoices).toHaveBeenCalledWith('channel', ['voice']);
  } finally {
    if (view) act(() => view.unmount());
    queryClient.clear();
  }
});

test('a failed voice assignment save keeps the editor open for retry', async () => {
  saveVoices.mockClear();
  saveVoices.mockImplementationOnce(async () => {
    throw new Error('save failed');
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData(
    ['channels'],
    [{ id: 'channel', name: 'Narration', is_default: false, device_ids: [] }],
  );
  queryClient.setQueryData(['audio-devices'], []);
  queryClient.setQueryData(profileListKey(currentServerScope()), [{ id: 'voice', name: 'Existing voice' }]);
  queryClient.setQueryData(['channel-voices', 'channel'], { profile_ids: ['voice'] });
  let view!: ReturnType<typeof create>;
  try {
    await act(async () => {
      view = create(
        <QueryClientProvider client={queryClient}>
          <AudioTab />
        </QueryClientProvider>,
      );
    });
    const edit = view.root
      .findAllByType('button')
      .filter((button) =>
        button.findAllByType('svg').some((icon) => icon.props['data-icon'] === 'Edit'),
      )
      .at(-1)!;
    await act(async () => {
      edit.props.onClick({ stopPropagation() {} });
    });
    const save = view.root
      .findAllByType('button')
      .find((button) => button.children.includes('common.save'))!;
    await act(async () => {
      save.props.onClick();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(JSON.stringify(view.toJSON())).toContain('audioChannels.editDialog.saveFailed');
    expect(
      view.root.findAllByType('button').some((button) => button.children.includes('common.save')),
    ).toBe(true);
    const retry = view.root
      .findAllByType('button')
      .find((button) => button.children.includes('common.save'))!;
    await act(async () => {
      retry.props.onClick();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(saveVoices).toHaveBeenCalledTimes(2);
    expect(saveVoices).toHaveBeenLastCalledWith('channel', ['voice']);
    expect(
      view.root.findAllByType('button').some((button) => button.children.includes('common.save')),
    ).toBe(false);
  } finally {
    if (view) act(() => view.unmount());
    queryClient.clear();
  }
});

test('a failed assignment load does not allow an empty save', async () => {
  getVoices = async () => {
    throw new Error('offline');
  };
  saveVoices.mockClear();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  queryClient.setQueryData(
    ['channels'],
    [{ id: 'channel', name: 'Narration', is_default: false, device_ids: [] }],
  );
  queryClient.setQueryData(['audio-devices'], []);
  queryClient.setQueryData(profileListKey(currentServerScope()), [{ id: 'voice', name: 'Existing voice' }]);
  let view!: ReturnType<typeof create>;
  try {
    await act(async () => {
      view = create(
        <QueryClientProvider client={queryClient}>
          <AudioTab />
        </QueryClientProvider>,
      );
    });
    const edit = view.root
      .findAllByType('button')
      .filter((button) =>
        button.findAllByType('svg').some((icon) => icon.props['data-icon'] === 'Edit'),
      )
      .at(-1)!;
    await act(async () => {
      edit.props.onClick({ stopPropagation() {} });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(JSON.stringify(view.toJSON())).toContain('audioChannels.editDialog.voicesLoadFailed');
    expect(
      view.root.findAllByType('button').some((button) => button.children.includes('common.save')),
    ).toBe(false);
    expect(saveVoices).not.toHaveBeenCalled();
  } finally {
    if (view) act(() => view.unmount());
    queryClient.clear();
    getVoices = () => voices;
  }
});

test('pending channel save blocks edits and duplicate submissions', async () => {
  let finishSave!: () => void;
  const pending = new Promise<void>((resolve) => {
    finishSave = resolve;
  });
  saveChannel.mockClear();
  saveChannel.mockImplementationOnce(async () => {
    await pending;
    return {};
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  queryClient.setQueryData(
    ['channels'],
    [{ id: 'channel', name: 'Narration', is_default: false, device_ids: [] }],
  );
  queryClient.setQueryData(['audio-devices'], []);
  queryClient.setQueryData(profileListKey(currentServerScope()), [{ id: 'voice', name: 'Existing voice' }]);
  queryClient.setQueryData(['channel-voices', 'channel'], { profile_ids: ['voice'] });
  let view!: ReturnType<typeof create>;
  try {
    await act(async () => {
      view = create(
        <QueryClientProvider client={queryClient}>
          <AudioTab />
        </QueryClientProvider>,
      );
    });
    const edit = view.root
      .findAllByType('button')
      .filter((button) =>
        button.findAllByType('svg').some((icon) => icon.props['data-icon'] === 'Edit'),
      )
      .at(-1)!;
    await act(async () => {
      edit.props.onClick({ stopPropagation() {} });
    });
    const save = view.root
      .findAllByType('button')
      .find((button) => button.children.includes('common.save'))!;
    await act(async () => {
      save.props.onClick();
      save.props.onClick();
    });
    expect(view.root.findByProps({ id: 'edit-channel-name' }).props.disabled).toBe(true);
    expect(saveChannel).toHaveBeenCalledTimes(1);
    await act(async () => {
      finishSave();
      await pending;
    });
  } finally {
    finishSave();
    if (view) act(() => view.unmount());
    queryClient.clear();
  }
});

test('device toggles cannot send overlapping updates based on stale assignments', async () => {
  let finishSave!: () => void;
  const pending = new Promise<void>((resolve) => {
    finishSave = resolve;
  });
  let finishRefresh!: (channels: (typeof initialChannel)[]) => void;
  const refresh = new Promise<(typeof initialChannel)[]>((resolve) => {
    finishRefresh = resolve;
  });
  loadChannels = () => refresh;
  saveChannel.mockClear();
  saveChannel.mockImplementationOnce(async () => {
    await pending;
    return {};
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  queryClient.setQueryData(
    ['channels'],
    [{ id: 'channel', name: 'Narration', is_default: false, device_ids: [] }],
  );
  queryClient.setQueryData(
    ['audio-devices'],
    [
      { id: 'one', name: 'Headphones', is_default: false },
      { id: 'two', name: 'Speakers', is_default: false },
    ],
  );
  queryClient.setQueryData(profileListKey(currentServerScope()), []);
  queryClient.setQueryData(['channel-voices', 'channel'], { profile_ids: [] });
  let view!: ReturnType<typeof create>;
  try {
    await act(async () => {
      view = create(
        <QueryClientProvider client={queryClient}>
          <AudioTab />
        </QueryClientProvider>,
      );
    });
    const channel = view.root
      .findAllByProps({ role: 'button' })
      .find((button) =>
        button.findAllByType('h3').some((title) => title.children.includes('Narration')),
      )!;
    await act(async () => {
      channel.props.onClick();
    });
    const device = (name: string) =>
      view.root
        .findAllByType('button')
        .find((button) =>
          button.findAllByType('span').some((span) => span.children.includes(name)),
        )!;
    await act(async () => {
      device('Headphones').props.onClick();
    });
    expect(device('Speakers').props.disabled).toBe(true);
    expect(saveChannel).toHaveBeenCalledTimes(1);
    await act(async () => {
      finishSave();
      await pending;
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(device('Speakers').props.disabled).toBe(true);
    await act(async () => {
      finishRefresh([{ ...initialChannel, device_ids: ['one'] }]);
      await refresh;
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(device('Speakers').props.disabled).toBe(false);
    await act(async () => {
      device('Speakers').props.onClick();
    });
    expect(saveChannel).toHaveBeenLastCalledWith('channel', { device_ids: ['one', 'two'] });
  } finally {
    finishSave();
    finishRefresh([initialChannel]);
    loadChannels = async () => [initialChannel];
    if (view) act(() => view.unmount());
    queryClient.clear();
  }
});

test('device toggles stay disabled when refreshing channel assignments fails', async () => {
  loadChannels = async () => {
    throw new Error('offline');
  };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  queryClient.setQueryData(['channels'], [initialChannel]);
  queryClient.setQueryData(
    ['audio-devices'],
    [
      { id: 'one', name: 'Headphones', is_default: false },
      { id: 'two', name: 'Speakers', is_default: false },
    ],
  );
  queryClient.setQueryData(profileListKey(currentServerScope()), []);
  queryClient.setQueryData(['channel-voices', 'channel'], { profile_ids: [] });
  let view!: ReturnType<typeof create>;
  try {
    await act(async () => {
      view = create(
        <QueryClientProvider client={queryClient}>
          <AudioTab />
        </QueryClientProvider>,
      );
    });
    const channel = view.root
      .findAllByProps({ role: 'button' })
      .find((button) =>
        button.findAllByType('h3').some((title) => title.children.includes('Narration')),
      )!;
    await act(async () => {
      channel.props.onClick();
    });
    const device = (name: string) =>
      view.root
        .findAllByType('button')
        .find((button) =>
          button.findAllByType('span').some((span) => span.children.includes(name)),
        )!;
    await act(async () => {
      device('Headphones').props.onClick();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(device('Speakers').props.disabled).toBe(true);
    expect(JSON.stringify(view.toJSON())).toContain('audioChannels.devices.refreshFailed');
    loadChannels = async () => [{ ...initialChannel, device_ids: ['one'] }];
    const retry = view.root
      .findAllByType('button')
      .find((button) => button.children.includes('common.retry'))!;
    await act(async () => {
      retry.props.onClick();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(device('Speakers').props.disabled).toBe(false);
    await act(async () => {
      device('Speakers').props.onClick();
    });
    expect(saveChannel).toHaveBeenLastCalledWith('channel', { device_ids: ['one', 'two'] });
  } finally {
    if (view) act(() => view.unmount());
    queryClient.clear();
    loadChannels = async () => [initialChannel];
  }
});
