import { afterAll, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create } from 'react-test-renderer';
import type { CaptureResponse } from '../src/lib/api/types';

const row = (
  id: string,
  raw: string,
  refined: string | null,
  source: CaptureResponse['source'],
): CaptureResponse =>
  ({
    id,
    transcript_raw: raw,
    transcript_refined: refined,
    source,
    created_at: '2026-01-01T00:00:00Z',
    duration_ms: 61000,
    language: 'en',
    stt_model: 'whisper',
    llm_model: null,
  }) as CaptureResponse;
let rows = [
  row('a', 'Alpha raw', 'Alpha polished', 'dictation'),
  row('b', 'Beta raw', null, 'file'),
];
const upload = mock(() => {});
const refine = mock(() => {});
const toggle = mock(() => {});
const toast = mock(() => {});
const deleteCapture = mock(async (id: string) => {
  rows = rows.filter((r) => r.id !== id);
});
const generateSpeech = mock(async () => ({ id: 'generation-1' }));
const writeText = mock(async () => {});
const writeBinary = mock(async (_path: string, _bytes: Uint8Array) => {});
const save = mock(async () => '/captures/result.txt' as string | null);
mock.module('../src/lib/api/client', () => ({
  apiClient: {
    listCaptures: async () => ({ items: rows, total: rows.length }),
    listProfiles: async () => [],
    deleteCapture,
    generateSpeech,
    getCaptureAudioUrl: (id: string) => `/audio/${id}`,
  },
}));
mock.module('../src/lib/hooks/useSettings', () => ({
  useCaptureSettings: () => ({ settings: {}, update() {} }),
}));
mock.module('../src/lib/hooks/useDictationReadiness', () => ({
  useDictationReadiness: () => ({ canRecord: true, canCapture: true }),
}));
mock.module('../src/lib/hooks/useCaptureRecordingSession', () => ({
  useCaptureRecordingSession: () => ({
    pillState: 'hidden',
    isRecording: false,
    isUploading: false,
    uploadFile: upload,
    refine,
    toggleRecording: toggle,
  }),
}));
mock.module('../src/components/CapturesTab/CaptureInlinePlayer', () => ({
  CaptureInlinePlayer: ({ audioUrl }: { audioUrl: string }) => <div data-audio={audioUrl} />,
}));
mock.module('../src/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));
mock.module('../src/components/ui/alert-dialog', () => {
  const Part = ({ children }: any) => <div>{children}</div>;
  return {
    AlertDialog: ({ open, children }: any) => open ? <div>{children}</div> : null,
    AlertDialogAction: Part, AlertDialogCancel: Part, AlertDialogContent: Part,
    AlertDialogDescription: Part, AlertDialogFooter: Part, AlertDialogHeader: Part, AlertDialogTitle: Part,
  };
});
mock.module('../src/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));
mock.module('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));
mock.module('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
mock.module('@tauri-apps/plugin-dialog', () => ({ save }));
mock.module('@tauri-apps/plugin-fs', () => ({
  writeFile: writeBinary,
  writeTextFile: writeText,
}));
mock.module('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init() {} },
  useTranslation: () => ({ t: (key: string) => key }),
}));
const { CapturesTab } = await import('../src/components/CapturesTab/CapturesTab');
const { profileListKey } = await import('../src/lib/hooks/useProfiles');
const { currentServerScope } = await import('../src/lib/serverScope');
const { useServerStore } = await import('../src/stores/serverStore');
const { useGenerationStore } = await import('../src/stores/generationStore');
const originalNavigator = globalThis.navigator;
afterAll(() => {
  globalThis.navigator = originalNavigator;
  mock.restore();
});
const button = (view: ReturnType<typeof create>, label: string) =>
  view.root.findAllByType('button').find((n) => n.children.includes(label))!;
async function setup(voices: any[] = []) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  client.setQueryData(['captures'], { items: rows, total: rows.length });
  client.setQueryData(profileListKey(currentServerScope()), voices);
  let view!: ReturnType<typeof create>;
  await act(async () => {
    view = create(
      <QueryClientProvider client={client}>
        <CapturesTab />
      </QueryClientProvider>,
    );
  });
  return { client, view };
}
test('search and selection remain independent across refetch and transcript modes', async () => {
  rows = [row('a', 'Alpha raw', 'Alpha polished', 'dictation'), row('b', 'Beta raw', null, 'file')];
  const { client, view } = await setup();
  expect(view.root.findByType('textarea').props.value).toBe('Alpha polished');
  act(() => button(view, 'captures.transcript.raw').props.onClick());
  expect(view.root.findByType('textarea').props.value).toBe('Alpha raw');
  const search = view.root
    .findAllByType('input')
    .find((n) => n.props.placeholder === 'captures.searchPlaceholder')!;
  act(() => search.props.onChange({ target: { value: '  BETA ' } }));
  expect(view.root.findAllByProps({ 'data-audio': '/audio/a' })).toHaveLength(1);
  const beta = view.root
    .findAllByType('button')
    .find((n) => n.findAllByType('div').some((d) => d.children.includes('Beta raw')))!;
  act(() => beta.props.onClick());
  expect(view.root.findByType('textarea').props.value).toBe('Beta raw');
  expect(button(view, 'captures.transcript.refined').props.disabled).toBe(true);
  await act(async () => {
    client.setQueryData(['captures'], { items: [...rows], total: 2 });
  });
  expect(view.root.findByProps({ 'data-audio': '/audio/b' })).toBeDefined();
  act(() => search.props.onChange({ target: { value: 'missing' } }));
  expect(
    view.root.findAllByType('p').some((n) => n.children.includes('captures.empty.noMatches')),
  ).toBe(true);
  act(() => view.unmount());
  client.clear();
});
test('copy failure, import, refine and transcript export use the selected capture', async () => {
  const { client, view } = await setup();
  globalThis.navigator = {
    clipboard: {
      writeText: async () => {
        throw new Error('denied');
      },
    },
  } as Navigator;
  await act(async () => {
    await button(view, 'captures.actions.copy').props.onClick();
  });
  expect(toast).toHaveBeenCalledWith({
    title: 'captures.toast.copyFailed',
    variant: 'destructive',
  });
  act(() => button(view, 'captures.actions.reRefine').props.onClick());
  expect(refine).toHaveBeenCalledWith('a');
  const file = new File(['audio'], 'recording.wav', { type: 'audio/wav' });
  const input = view.root.findAllByType('input').find((n) => n.props.type === 'file')!;
  expect(input.props.accept).toContain('.wav');
  const target = { files: [file], value: 'recording.wav' };
  act(() => input.props.onChange({ target }));
  expect(upload).toHaveBeenCalledWith(file, 'file');
  expect(target.value).toBe('');
  await act(async () => {
    await button(view, 'captures.actions.exportTranscript').props.onClick();
  });
  expect(writeText).toHaveBeenCalledWith('/captures/result.txt', 'Alpha polished');
  act(() => button(view, 'captures.actions.dictate').props.onClick());
  expect(toggle).toHaveBeenCalled();
  expect(view.root.findByProps({ href: '/settings/captures' })).toBeDefined();
  act(() => view.unmount());
  client.clear();
});

test('audio export writes the selected recording bytes', async () => {
  rows = [row('a', 'Alpha raw', 'Alpha polished', 'dictation')];
  const previousFetch = globalThis.fetch;
  const fetchAudio = mock(async (_url: string) => new Response(new Uint8Array([1, 2, 3])));
  globalThis.fetch = fetchAudio as typeof fetch;
  const { client, view } = await setup();
  try {
    save.mockImplementationOnce(async () => '/captures/audio.wav');
    await act(async () => { await button(view, 'captures.actions.exportAudio').props.onClick(); });
    expect(fetchAudio).toHaveBeenCalledWith('/audio/a');
    expect(writeBinary).toHaveBeenCalledWith('/captures/audio.wav', new Uint8Array([1, 2, 3]));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'captures.toast.exportSuccess' }));
  } finally { act(() => view.unmount()); client.clear(); globalThis.fetch = previousFetch; writeBinary.mockClear(); toast.mockClear(); }
});

test('audio export reports an HTTP failure without writing an incomplete file', async () => {
  rows = [row('a', 'Alpha raw', null, 'dictation')];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;
  const { client, view } = await setup();
  try {
    save.mockImplementationOnce(async () => '/captures/audio.wav');
    await act(async () => { await button(view, 'captures.actions.exportAudio').props.onClick(); });
    expect(writeBinary).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'captures.toast.exportFailed', description: 'HTTP 404' }));
  } finally { act(() => view.unmount()); client.clear(); globalThis.fetch = previousFetch; writeBinary.mockClear(); toast.mockClear(); }
});

test('audio export never fetches the same capture id from a different server after the save dialog', async () => {
  rows = [row('a', 'Alpha raw', null, 'dictation')];
  let resolve!: (path: string | null) => void;
  save.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
  const previousFetch = globalThis.fetch;
  const fetchAudio = mock(async () => new Response('audio'));
  globalThis.fetch = fetchAudio as typeof fetch;
  const { client, view } = await setup();
  try {
    await act(async () => { button(view, 'captures.actions.exportAudio').props.onClick(); });
    act(() => useServerStore.setState((s) => ({ serverUrl: 'http://server-b', serverRevision: s.serverRevision + 1 })));
    await act(async () => { resolve('/captures/audio.wav'); });
    expect(fetchAudio).not.toHaveBeenCalled();
    expect(writeBinary).not.toHaveBeenCalled();
  } finally { act(() => view.unmount()); client.clear(); globalThis.fetch = previousFetch; writeBinary.mockClear(); toast.mockClear(); useServerStore.setState({ serverUrl: 'http://server-a', serverRevision: 0 }); }
});

test('markdown export preserves capture metadata and both transcript versions', async () => {
  rows = [row('a', 'Alpha raw', 'Alpha polished', 'dictation')];
  const { client, view } = await setup();
  try {
    save.mockImplementationOnce(async () => '/captures/capture.md');
    await act(async () => { await button(view, 'captures.actions.exportMarkdown').props.onClick(); });
    const [path, content] = writeText.mock.calls.at(-1)!;
    expect(path).toBe('/captures/capture.md');
    expect(content).toContain('## Refined transcript\n\nAlpha polished');
    expect(content).toContain('## Raw transcript\n\nAlpha raw');
    expect(content).toContain('**STT model:** whisper');
  } finally { act(() => view.unmount()); client.clear(); writeText.mockClear(); toast.mockClear(); }
});

test('a delete confirmation remains attached to the capture originally selected', async () => {
  rows = [row('a', 'Alpha raw', null, 'dictation'), row('b', 'Beta raw', null, 'file')];
  deleteCapture.mockClear();
  const { client, view } = await setup();
  try {
    act(() => button(view, 'captures.actions.delete').props.onClick());
    const beta = view.root.findAllByType('button').find((n) => n.findAllByType('div').some((d) => d.children.includes('Beta raw')))!;
    act(() => beta.props.onClick());
    await act(async () => { button(view, 'common.delete').props.onClick(); await new Promise((r) => setTimeout(r, 10)); });
    expect(deleteCapture).toHaveBeenCalledWith('a');
  } finally { act(() => view.unmount()); client.clear(); toast.mockClear(); }
});

test('a play-as result from the previous server does not start a new-server task', async () => {
  rows = [row('a', 'Alpha raw', null, 'dictation')];
  let resolve!: (result: { id: string }) => void;
  generateSpeech.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
  const { client, view } = await setup([{ id: 'voice', name: 'Voice', language: 'en', default_engine: 'kokoro' }]);
  try {
    await act(async () => { button(view, 'captures.actions.playAs').props.onClick(); await Promise.resolve(); });
    act(() => useServerStore.setState((s) => ({ serverUrl: 'http://server-b', serverRevision: s.serverRevision + 1 })));
    await act(async () => { resolve({ id: 'generation-1' }); });
    expect(useGenerationStore.getState().pendingGenerationIds.has('generation-1')).toBe(false);
  } finally { act(() => view.unmount()); client.clear(); useGenerationStore.getState().removePendingGeneration('generation-1'); useServerStore.setState({ serverUrl: 'http://server-a', serverRevision: 0 }); toast.mockClear(); }
});

for (const action of ['delete', 'play'] as const) {
  test(`queued capture ${action} does not dispatch to a different server`, async () => {
    rows = [row('a', 'Alpha raw', null, 'dictation')];
    deleteCapture.mockClear(); generateSpeech.mockClear();
    const { client, view } = await setup([{ id: 'voice', name: 'Voice', language: 'en', default_engine: 'kokoro' }]);
    try {
      if (action === 'delete') act(() => button(view, 'captures.actions.delete').props.onClick());
      await act(async () => {
        button(view, action === 'delete' ? 'common.delete' : 'captures.actions.playAs').props.onClick();
        useServerStore.setState((s) => ({ serverUrl: 'http://server-b', serverRevision: s.serverRevision + 1 }));
        await new Promise((r) => setTimeout(r, 10));
      });
      expect(action === 'delete' ? deleteCapture : generateSpeech).not.toHaveBeenCalled();
      expect(toast).not.toHaveBeenCalled();
    } finally { act(() => view.unmount()); client.clear(); useServerStore.setState({ serverUrl: 'http://server-a', serverRevision: 0 }); toast.mockClear(); }
  });
}

test.each([
  ['refined', 'Polished words'],
  ['raw', 'Raw words'],
])('play-as submits the displayed %s transcript and selected voice engine', async (version, text) => {
  rows = [row('a', 'Raw words', 'Polished words', 'dictation')];
  generateSpeech.mockClear();
  const { client, view } = await setup([{ id: 'voice', name: 'Voice', language: 'en', default_engine: 'kokoro' }]);
  try {
    if (version === 'raw') act(() => button(view, 'captures.transcript.raw').props.onClick());
    await act(async () => { button(view, 'captures.actions.playAs').props.onClick(); await new Promise((r) => setTimeout(r, 10)); });
    expect(generateSpeech).toHaveBeenCalledWith({ profile_id: 'voice', text, language: 'en', engine: 'kokoro' });
    expect(useGenerationStore.getState().pendingGenerationIds.has('generation-1')).toBe(true);
  } finally { act(() => view.unmount()); client.clear(); useGenerationStore.getState().removePendingGeneration('generation-1'); }
});

test('cancelled export does not fetch or write audio', async () => {
  rows = [row('a', 'Words', null, 'dictation')];
  const previousFetch = globalThis.fetch;
  const fetchAudio = mock(async () => new Response('audio'));
  globalThis.fetch = fetchAudio as typeof fetch;
  save.mockImplementationOnce(async () => null);
  const { client, view } = await setup();
  try {
    await act(async () => { await button(view, 'captures.actions.exportAudio').props.onClick(); });
    expect(fetchAudio).not.toHaveBeenCalled();
    expect(writeBinary).not.toHaveBeenCalled();
  } finally { act(() => view.unmount()); client.clear(); globalThis.fetch = previousFetch; }
});

test('empty transcript cannot be exported as text or markdown', async () => {
  rows = [row('a', '   ', null, 'dictation')];
  const { client, view } = await setup();
  try {
    save.mockClear(); toast.mockClear();
    await act(async () => { await button(view, 'captures.actions.exportTranscript').props.onClick(); });
    await act(async () => { await button(view, 'captures.actions.exportMarkdown').props.onClick(); });
    expect(save).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledTimes(2);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'captures.toast.exportEmpty' }));
  } finally { act(() => view.unmount()); client.clear(); toast.mockClear(); }
});
