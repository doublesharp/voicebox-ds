import { afterEach, expect, mock, test } from 'bun:test';
import { Fragment, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useStoryStore } from '../src/stores/storyStore';
import { useServerStore } from '../src/stores/serverStore';

const wrap = ({ children }: { children: ReactNode }) => <div>{children}</div>;
const dialog = ({ open, children }: any) => (open ? <div>{children}</div> : null);
mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init() {} },
}));
mock.module('framer-motion', () => ({ AnimatePresence: Fragment, motion: { div: 'div' } }));
mock.module('@tanstack/react-router', () => ({ Link: wrap }));
mock.module('@/components/ui/dialog', () => ({
  Dialog: dialog,
  DialogContent: wrap,
  DialogHeader: wrap,
  DialogTitle: wrap,
  DialogDescription: wrap,
  DialogFooter: wrap,
}));
mock.module('@/components/ui/alert-dialog', () => ({
  AlertDialog: dialog,
  AlertDialogContent: wrap,
  AlertDialogHeader: wrap,
  AlertDialogTitle: wrap,
  AlertDialogDescription: wrap,
  AlertDialogFooter: wrap,
  AlertDialogCancel: wrap,
  AlertDialogAction: wrap,
}));
mock.module('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: wrap,
  DropdownMenuContent: wrap,
  DropdownMenuTrigger: wrap,
  DropdownMenuItem: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>,
  DropdownMenuLabel: wrap,
  DropdownMenuSeparator: wrap,
}));
mock.module('@/components/ui/popover', () => ({
  Popover: wrap,
  PopoverContent: wrap,
  PopoverTrigger: wrap,
}));
mock.module('@/components/ListPane', () => ({
  ListPane: wrap,
  ListPaneHeader: wrap,
  ListPaneTitleRow: wrap,
  ListPaneTitle: wrap,
  ListPaneActions: wrap,
  ListPaneScroll: wrap,
  ListPaneSearch: (p: any) => <input {...p} onChange={(e) => p.onChange(e.target.value)} />,
}));
const toast = mock(() => {});
mock.module('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));
const mutations = Object.fromEntries(
  ['create', 'update', 'delete', 'add', 'remove', 'reorder', 'export'].map((k) => [
    k,
    { mutate: mock(() => {}), mutateAsync: mock(async () => {}), isPending: false },
  ]),
);
const stories = [
  { id: 'a', name: 'Alpha', description: 'First', item_count: 2, updated_at: '2026-01-01' },
  { id: 'b', name: 'Beta', description: 'Second', item_count: 0, updated_at: '2026-01-02' },
];
const clips = [
  { id: 'i2', generation_id: 'g2', start_time_ms: 2000, duration: 1, engine: 'import' },
  { id: 'i1', generation_id: 'g1', start_time_ms: 0, duration: 1, engine: 'tts' },
];
let selected: any = { ...stories[0], items: clips };
let loading = false;
mock.module('@/lib/hooks/useStories', () => ({
  useStories: () => ({ data: stories, isLoading: loading }),
  useStory: () => ({ data: selected, isLoading: loading }),
  useCreateStory: () => mutations.create,
  useUpdateStory: () => mutations.update,
  useDeleteStory: () => mutations.delete,
  useAddStoryItem: () => mutations.add,
  useRemoveStoryItem: () => mutations.remove,
  useReorderStoryItems: () => mutations.reorder,
  useExportStoryAudio: () => mutations.export,
}));
mock.module('@/lib/hooks/useHistory', () => ({
  useHistory: () => ({
    data: {
      items: [
        { id: 'g1', status: 'completed', text: 'existing', profile_name: 'Voice' },
        { id: 'g3', status: 'completed', text: 'Fresh line', profile_name: 'Reader' },
        { id: 'g4', status: 'pending', text: 'Pending', profile_name: 'Voice' },
      ],
    },
  }),
}));
mock.module('@/lib/hooks/useStoryPlayback', () => ({ useStoryPlayback: () => {} }));
const regenerate = mock(async (_id: string) => {});
const importAudio = mock(async (_file: File) => ({ id: 'imported' }));
mock.module('@/lib/api/client', () => ({ apiClient: { regenerateGeneration: regenerate, importAudio } }));
mock.module('@/components/StoriesTab/StoryChatItem', () => ({
  SortableStoryChatItem: (p: any) => (
    <div data-clip={p.item.generation_id}>
      <button onClick={p.onRemove}>remove {p.item.id}</button>
      {p.onRegenerate && <button onClick={p.onRegenerate}>regen {p.item.id}</button>}
    </div>
  ),
}));
mock.module('@dnd-kit/core', () => ({
  DndContext: (p: any) => (
    <div role="application" data-dnd onDragEnd={p.onDragEnd}>
      {p.children}
    </div>
  ),
  closestCenter: () => {},
  KeyboardSensor: class {},
  PointerSensor: class {},
  useSensor: () => ({}),
  useSensors: () => [],
}));
mock.module('@dnd-kit/sortable', () => ({
  SortableContext: wrap,
  sortableKeyboardCoordinates: () => {},
  verticalListSortingStrategy: () => {},
  arrayMove: (a: any[], from: number, to: number) => {
    const copy = [...a];
    copy.splice(to, 0, copy.splice(from, 1)[0]);
    return copy;
  },
}));
const { StoryList } = await import('../src/components/StoriesTab/StoryList');
const { StoryContent } = await import('../src/components/StoriesTab/StoryContent');
let renderer: ReactTestRenderer;
function mount(component: any) {
  act(() => {
    renderer = create(component, { createNodeMock: () => ({ scrollIntoView() {}, click() {} }) });
  });
}
function text(n: any): string {
  return typeof n === 'string'
    ? n
    : Array.isArray(n)
      ? n.map(text).join('')
      : n?.props
        ? text(n.props.children)
        : '';
}
function button(label: string) {
  const b = renderer.root.findAllByType('button').find((n) => text(n.props.children) === label);
  expect(b).toBeDefined();
  return b!;
}
function click(label: string) {
  act(() => button(label).props.onClick());
}
function input(id: string, value: string) {
  act(() => renderer.root.findByProps({ id }).props.onChange({ target: { value } }));
}
afterEach(() => {
  act(() => renderer?.unmount());
  useStoryStore.setState({
    selectedStoryId: null,
    isPlaying: false,
    playbackStoryId: null,
    currentTimeMs: 0,
  });
  for (const m of Object.values(mutations)) { m.mutate.mockClear(); m.mutateAsync.mockReset(); m.mutateAsync.mockImplementation(async () => {}); }
  importAudio.mockReset();
  importAudio.mockImplementation(async () => ({ id: 'imported' }));
  useServerStore.setState({ serverUrl: 'http://server-a', serverRevision: 0 });
  toast.mockClear();
  selected = { ...stories[0], items: clips };
  loading = false;
});
test('list selects first story, exposes selection and searches descriptions', () => {
  mount(<StoryList />);
  expect(useStoryStore.getState().selectedStoryId).toBe('a');
  const rows = renderer.root.findAllByProps({ 'aria-label': 'stories.row.ariaLabel' });
  expect(rows.map((r) => r.props['aria-pressed'])).toEqual([true, false]);
  act(() => rows[1].props.onClick());
  expect(useStoryStore.getState().selectedStoryId).toBe('b');
  act(() =>
    renderer.root
      .findByProps({ placeholder: 'stories.searchPlaceholder' })
      .props.onChange(' FIRST '),
  );
  expect(renderer.root.findAllByProps({ 'aria-label': 'stories.row.ariaLabel' })).toHaveLength(1);
});
test('create validates, trims, selects on success and reports errors', () => {
  mount(<StoryList />);
  click('stories.newStory');
  click('stories.createDialog.action');
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({ title: 'stories.toast.nameRequired' }),
  );
  input('story-name', '  New story  ');
  input('story-description', '  Note  ');
  click('stories.createDialog.action');
  const [payload, callbacks] = mutations.create.mutate.mock.calls[0] as any;
  expect(payload).toEqual({ name: 'New story', description: 'Note' });
  act(() => callbacks.onError(new Error('offline')));
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({ description: 'offline', variant: 'destructive' }),
  );
  act(() => callbacks.onSuccess({ id: 'new', name: 'New story' }));
  expect(useStoryStore.getState().selectedStoryId).toBe('new');
  expect(renderer.root.findAllByProps({ id: 'story-name' })).toHaveLength(0);
});
test('edit and delete retain identity and surface failures', () => {
  mount(<StoryList />);
  click('common.edit');
  input('edit-story-name', ' Changed ');
  click('common.save');
  const [payload, callbacks] = mutations.update.mutate.mock.calls[0] as any;
  expect(payload).toEqual({ storyId: 'a', data: { name: 'Changed', description: 'First' } });
  act(() => callbacks.onError(new Error('update failed')));
  expect(toast).toHaveBeenCalledWith(expect.objectContaining({ description: 'update failed' }));
  act(() => callbacks.onSuccess());
  click('common.delete');
  const deletes = renderer.root
    .findAllByType('button')
    .filter((n) => text(n.props.children) === 'common.delete');
  act(() => deletes[deletes.length - 1].props.onClick());
  const [id, cb] = mutations.delete.mutate.mock.calls[0] as any;
  expect(id).toBe('a');
  act(() => cb.onError(new Error('delete failed')));
  expect(toast).toHaveBeenCalledWith(expect.objectContaining({ description: 'delete failed' }));
});
test('content sorts, reorders, removes, exports and reports failures', () => {
  useStoryStore.setState({ selectedStoryId: 'a' });
  mount(<StoryContent />);
  expect(
    renderer.root.findAll((n) => n.props['data-clip']).map((n) => n.props['data-clip']),
  ).toEqual(['g1', 'g2']);
  expect(
    renderer.root.findAllByType('button').some((n) => text(n.props.children) === 'regen i2'),
  ).toBe(false);
  act(() =>
    renderer.root
      .findByProps({ 'data-dnd': true })
      .props.onDragEnd({ active: { id: 'i1' }, over: { id: 'i2' } }),
  );
  expect(mutations.reorder.mutate.mock.calls[0][0]).toEqual({
    storyId: 'a',
    data: { generation_ids: ['g2', 'g1'] },
  });
  click('remove i1');
  expect(mutations.remove.mutate.mock.calls[0][0]).toEqual({ storyId: 'a', itemId: 'i1' });
  click('storyContent.exportFormats.mp3');
  expect(mutations.export.mutate.mock.calls[0][0]).toEqual({
    storyId: 'a',
    storyName: 'Alpha',
    format: 'mp3',
  });
  act(() => (mutations.export.mutate.mock.calls[0][1] as any).onError(new Error('export failed')));
  expect(toast).toHaveBeenCalledWith(expect.objectContaining({ description: 'export failed' }));
});
test('available search excludes existing and pending and adds selected generation', () => {
  useStoryStore.setState({ selectedStoryId: 'a' });
  mount(<StoryContent />);
  expect(
    renderer.root.findAllByType('button').some((n) => text(n.props.children).includes('Pending')),
  ).toBe(false);
  act(() =>
    renderer.root
      .findByProps({ placeholder: 'storyContent.searchPlaceholder' })
      .props.onChange({ target: { value: 'reader' } }),
  );
  click('ReaderFresh line');
  expect(mutations.add.mutate.mock.calls[0][0]).toEqual({
    storyId: 'a',
    data: { generation_id: 'g3' },
  });
  act(() => (mutations.add.mutate.mock.calls[0][1] as any).onError(new Error('add failed')));
  expect(toast).toHaveBeenCalledWith(expect.objectContaining({ description: 'add failed' }));
});
test('content handles selection, loading and missing story states', () => {
  mount(<StoryContent />);
  expect(JSON.stringify(renderer.toJSON())).toContain('storyContent.selectStory.title');
  loading = true;
  act(() => useStoryStore.setState({ selectedStoryId: 'a' }));
  act(() => renderer.update(<StoryContent />));
  expect(JSON.stringify(renderer.toJSON())).toContain('storyContent.loading');
  loading = false;
  selected = undefined;
  act(() => renderer.update(<StoryContent />));
  expect(JSON.stringify(renderer.toJSON())).toContain('storyContent.notFound.title');
});

function importFiles(files: File[]) {
  const input = renderer.root.findAllByType('input').find((node) => node.props.type === 'file')!;
  const target = { files, value: 'selection' };
  act(() => input.props.onChange({ target }));
  expect(target.value).toBe('');
}
function setupStoryImport() {
  useStoryStore.setState({ selectedStoryId: 'a' });
  mount(<StoryContent />);
}

test('story import uploads multiple files in order and links each to the selected story', async () => {
  const first = new File(['a'], 'first.wav', { type: 'audio/wav' });
  const second = new File(['b'], 'second.wav', { type: 'audio/wav' });
  importAudio.mockImplementation(async (file) => ({ id: file.name }));
  setupStoryImport();
  await act(async () => { importFiles([first, second]); await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(importAudio.mock.calls.map(([file]) => file.name)).toEqual(['first.wav', 'second.wav']);
  expect(mutations.add.mutateAsync.mock.calls.map(([args]: any) => ({ storyId: args.storyId, data: args.data }))).toEqual([
    { storyId: 'a', data: { generation_id: 'first.wav' } },
    { storyId: 'a', data: { generation_id: 'second.wav' } },
  ]);
});

test('a server change during audio import never links the result or starts the remaining files', async () => {
  let finish!: (value: { id: string }) => void;
  importAudio.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  setupStoryImport();
  importFiles([new File(['a'], 'first.wav'), new File(['b'], 'second.wav')]);
  act(() => useServerStore.setState({ serverUrl: 'http://server-b', serverRevision: 1 }));
  await act(async () => { finish({ id: 'old-generation' }); await Promise.resolve(); });
  expect(mutations.add.mutateAsync).not.toHaveBeenCalled();
  expect(importAudio).toHaveBeenCalledTimes(1);
});

test('changing selected story while audio uploads prevents linking it to the old story', async () => {
  let finish!: (value: { id: string }) => void;
  importAudio.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  setupStoryImport();
  importFiles([new File(['a'], 'first.wav')]);
  act(() => useStoryStore.setState({ selectedStoryId: 'b' }));
  await act(async () => { finish({ id: 'old-generation' }); await Promise.resolve(); });
  expect(mutations.add.mutateAsync).not.toHaveBeenCalled();
});

test('multiple simultaneous file selections do not duplicate imports', async () => {
  let finish!: (value: { id: string }) => void;
  importAudio.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  setupStoryImport();
  importFiles([new File(['a'], 'first.wav')]);
  importFiles([new File(['b'], 'second.wav')]);
  expect(importAudio).toHaveBeenCalledTimes(1);
  await act(async () => { finish({ id: 'first' }); await Promise.resolve(); });
  expect(mutations.add.mutateAsync).toHaveBeenCalledTimes(1);
});

test('a stale import error is not reported in the next story', async () => {
  let fail!: (error: Error) => void;
  importAudio.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  setupStoryImport();
  importFiles([new File(['a'], 'first.wav')]);
  act(() => useStoryStore.setState({ selectedStoryId: 'b' }));
  await act(async () => { fail(new Error('old import failed')); await Promise.resolve(); });
  expect(toast).not.toHaveBeenCalled();
});

test('an import failure reports the file error and continues the current batch', async () => {
  importAudio.mockImplementationOnce(async () => { throw new Error('bad audio'); });
  setupStoryImport();
  await act(async () => { importFiles([new File(['a'], 'bad.wav'), new File(['b'], 'good.wav')]); await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'storyContent.toast.importFailed', description: 'bad audio' }));
  expect(importAudio).toHaveBeenCalledTimes(2);
  expect(mutations.add.mutateAsync).toHaveBeenCalledTimes(1);
});

test('an old story import cannot unlock a newer story import', async () => {
  let finishOld!: (value: { id: string }) => void;
  let finishNew!: (value: { id: string }) => void;
  importAudio.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
  importAudio.mockImplementationOnce(() => new Promise((resolve) => { finishNew = resolve; }));
  setupStoryImport();
  importFiles([new File(['a'], 'old.wav')]);
  selected = { ...stories[1], items: [] };
  act(() => useStoryStore.setState({ selectedStoryId: 'b' }));
  importFiles([new File(['b'], 'new.wav')]);
  await act(async () => { finishOld({ id: 'old' }); await Promise.resolve(); });
  expect(button('storyContent.importing').props.disabled).toBe(true);
  importFiles([new File(['c'], 'duplicate.wav')]);
  expect(importAudio).toHaveBeenCalledTimes(2);
  await act(async () => { finishNew({ id: 'new' }); await Promise.resolve(); });
  expect(mutations.add.mutateAsync.mock.calls.map(([arg]: any) => arg.storyId)).toEqual(['b']);
});

test('leaving and returning to a story invalidates an older import', async () => {
  let finish!: (value: { id: string }) => void;
  importAudio.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  setupStoryImport();
  importFiles([new File(['a'], 'old.wav')]);
  act(() => useStoryStore.setState({ selectedStoryId: 'b' }));
  act(() => useStoryStore.setState({ selectedStoryId: 'a' }));
  await act(async () => { finish({ id: 'old' }); await Promise.resolve(); });
  expect(mutations.add.mutateAsync).not.toHaveBeenCalled();
});

test('a batched switch away and back still invalidates the old story import', async () => {
  let finish!: (value: { id: string }) => void;
  importAudio.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  setupStoryImport();
  importFiles([new File(['a'], 'old.wav')]);
  act(() => {
    useStoryStore.setState({ selectedStoryId: 'b' });
    useStoryStore.setState({ selectedStoryId: 'a' });
  });
  await act(async () => { finish({ id: 'old' }); await Promise.resolve(); });
  expect(mutations.add.mutateAsync).not.toHaveBeenCalled();
});
