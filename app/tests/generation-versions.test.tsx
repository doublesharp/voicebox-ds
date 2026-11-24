import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, Fragment, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { GenerationVersionResponse, HistoryResponse } from '../src/lib/api/types';
import { useGenerationStore } from '../src/stores/generationStore';
import { usePlayerStore } from '../src/stores/playerStore';
import { useServerStore } from '../src/stores/serverStore';

const { apiClient: actualApiClient } = await import('../src/lib/api/client');

const original: GenerationVersionResponse = {
  id: 'original',
  generation_id: 'gen',
  label: 'original',
  audio_path: 'original.wav',
  is_default: false,
  created_at: '2026-10-28T10:00:00Z',
};
const processed: GenerationVersionResponse = {
  ...original,
  id: 'processed',
  label: 'version-2',
  audio_path: 'processed.wav',
  source_version_id: 'original',
  is_default: true,
  effects_chain: [{ type: 'gain', enabled: true, params: { gain_db: -6 } }],
};
const generation = {
  id: 'gen',
  profile_id: 'voice',
  profile_name: 'Voice',
  text: 'Hello',
  language: 'en',
  status: 'completed',
  created_at: original.created_at,
  versions: [original, processed],
} as HistoryResponse;
let historyData: { items: HistoryResponse[]; total: number | null; next_cursor?: string | null } = {
  items: [generation],
  total: 1,
};
const historyQueries: Array<{ offset?: number; cursor?: string; include_total?: boolean }> = [];
let laterPage: typeof historyData | undefined;
let intersect: (() => void) | undefined;
const mutation = { mutate: mock(() => {}), isPending: false, isSuccess: false };
const deleteMutation = { ...mutation };
const clearMutation = { ...mutation };
const importMutation = { ...mutation };
const update = mock(
  async (_generation: string, _id: string, data: { effects_chain: unknown[] }) => ({
    ...processed,
    audio_path: 'updated.wav',
    effects_chain: data.effects_chain,
  }),
);
const remove = mock(async () => [{ ...original, is_default: true }]);
const setDefault = mock(async () => ({ ...original, is_default: true }));
const toast = mock(() => {});
const retryGeneration = mock(async (_id: string) => ({ id: 'retry-id' }));
const regenerateGeneration = mock(async (_id: string) => ({}));
const toggleFavorite = mock(async (_id: string) => ({}));
const cancelGeneration = mock(async (_id: string) => ({ message: 'cancelling' }));

mock.module('../src/lib/hooks/useHistory', () => ({
  useHistory: (query: { offset: number; cursor?: string; include_total?: boolean }) => {
    historyQueries.push(query);
    return {
      data: query.offset === 0 && !query.cursor ? historyData : laterPage,
      isLoading: false,
      isFetching: false,
    };
  },
  useDeleteGeneration: () => deleteMutation,
  useClearFailedGenerations: () => clearMutation,
  useExportGeneration: () => mutation,
  useExportGenerationAudio: () => mutation,
  useImportGeneration: () => importMutation,
}));
mock.module('../src/lib/api/client', () => ({
  apiClient: {
    updateGenerationVersion: update,
    deleteGenerationVersion: remove,
    getVersionAudioUrl: (id: string, revision: string) =>
      `/audio/version/${id}?revision=${revision}`,
    getAudioUrl: (id: string) => `/audio/${id}`,
    setDefaultVersion: setDefault,
    retryGeneration,
    regenerateGeneration,
    toggleFavorite,
    cancelGeneration,
  },
}));
mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init() {} },
}));
mock.module('../src/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));
mock.module('framer-motion', () => ({ AnimatePresence: Fragment, motion: { div: 'div' } }));
mock.module('../src/components/Effects/EffectsChainEditor', () => ({
  EffectsChainEditor: ({
    value,
    onChange,
  }: {
    value: unknown[];
    onChange: (chain: unknown[]) => void;
  }) => (
    <div>
      <span data-chain>{JSON.stringify(value)}</span>
      <button type="button" onClick={() => onChange([])}>
        Clear effects
      </button>
    </div>
  ),
}));
const container = ({ children }: { children: ReactNode }) => <div>{children}</div>;
mock.module('../src/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: container,
  DialogHeader: container,
  DialogTitle: container,
  DialogDescription: container,
  DialogFooter: container,
}));
mock.module('../src/components/ui/dropdown-menu', () => ({
  DropdownMenu: container,
  DropdownMenuContent: container,
  DropdownMenuTrigger: container,
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect,
    onClick,
  }: {
    children: ReactNode;
    disabled?: boolean;
    onSelect?: () => void;
    onClick?: () => void;
  }) => (
    <button type="button" disabled={disabled} onClick={onClick ?? onSelect}>
      {children}
    </button>
  ),
}));
Object.defineProperty(globalThis, 'IntersectionObserver', {
  configurable: true,
  value: class {
    constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
      intersect = () => callback([{ isIntersecting: true }]);
    }
    observe() {}
    disconnect() {}
  },
});

const { HistoryTable } = await import('../src/components/History/HistoryTable');
let renderer: ReactTestRenderer;
let client: QueryClient;
function mount(items = [generation], total = items.length, nextCursor?: string, expand = true) {
  historyData = { items, total, ...(nextCursor ? { next_cursor: nextCursor } : {}) };
  laterPage = undefined;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    renderer = create(createElement(QueryClientProvider, { client }, createElement(HistoryTable)), {
      createNodeMock: () => ({ addEventListener() {}, removeEventListener() {} }),
    });
  });
  const toggle = renderer.root
    .findAllByType('button')
    .find((button) => button.props['aria-label'] === 'Toggle versions');
  if (expand) {
    expect(toggle).toBeDefined();
    act(() => toggle!.props.onClick());
  }
}
function button(label: string) {
  function text(children: ReactNode): string {
    if (typeof children === 'string') return children;
    if (Array.isArray(children)) return children.map(text).join('');
    return '';
  }
  const found = renderer.root
    .findAllByType('button')
    .filter(
      (node) => text(node.props.children) === label && typeof node.props.onClick === 'function',
    ).at(label === 'common.delete' ? -1 : 0);
  expect(found).toBeDefined();
  return found!;
}
afterEach(() => {
  act(() => renderer?.unmount());
  client?.clear();
  usePlayerStore.getState().reset();
  update.mockClear();
  remove.mockReset();
  remove.mockImplementation(async () => [{ ...original, is_default: true }]);
  setDefault.mockClear();
  toast.mockClear();
  retryGeneration.mockReset(); retryGeneration.mockImplementation(async () => ({ id: 'retry-id' }));
  regenerateGeneration.mockReset(); regenerateGeneration.mockImplementation(async () => ({}));
  toggleFavorite.mockReset(); toggleFavorite.mockImplementation(async () => ({}));
  cancelGeneration.mockReset(); cancelGeneration.mockImplementation(async () => ({ message: 'cancelling' }));
  useServerStore.setState({ serverUrl: 'http://server-a', serverRevision: 0 });
  useGenerationStore.getState().removePendingGeneration('retry-id');
  useGenerationStore.getState().removePendingGeneration('gen');
  deleteMutation.isSuccess = false;
  clearMutation.isSuccess = false;
  importMutation.isSuccess = false;
  useGenerationStore.getState().removePendingGeneration('pending');
  intersect = undefined;
});
afterAll(() => {
  // Bun's module mocks survive mock.restore(). Restore this export explicitly
  // so recording-export tests in the same process use the real API client.
  mock.module('../src/lib/api/client', () => ({ apiClient: actualApiClient }));
});

describe('generation version controls', () => {
  const second = {
    ...generation,
    id: 'second',
    text: 'A different clip',
    versions: [{ ...processed, id: 'second-version', generation_id: 'second' }],
  };
  function row(text: string) {
    return renderer.root
      .findAllByProps({ role: 'button' })
      .find((node) =>
        node
          .findAllByProps({ 'data-history-transcript': true })
          .some((transcript) => transcript.props.children === text),
      )!;
  }
  function clickRow(text: string, transcript = false, selectedText = false) {
    const node = row(text);
    const target = {
      closest: () => null,
      tagName: transcript ? 'P' : 'DIV',
    };
    const anchorNode = {};
    const currentTarget = { contains: (n: unknown) => n === anchorNode };
    const originalWindow = globalThis.window;
    globalThis.window = {
      getSelection: () => ({
        toString: () => (selectedText ? 'Hello' : ''),
        anchorNode: selectedText ? anchorNode : null,
      }),
    } as unknown as Window & typeof globalThis;
    try {
      (node.props.onClick ?? node.props.onMouseDown)({ target, currentTarget, button: 0 });
    } finally {
      globalThis.window = originalWindow;
    }
  }

  test('clip actions remain outside the playback button accessibility subtree', () => {
    mount();
    const clip = row(generation.text);
    expect(clip.findAllByType('button')).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'aria-label': 'Favorite' }).length).toBeGreaterThan(0);
    expect(
      renderer.root.findAllByProps({ 'aria-label': 'Toggle versions' }).length,
    ).toBeGreaterThan(0);
  });

  test('a completed import does not erase an already-refreshed first page', () => {
    mount();
    historyData = { items: [generation, second], total: 2 };
    importMutation.isSuccess = true;
    act(() =>
      renderer.update(createElement(QueryClientProvider, { client }, createElement(HistoryTable))),
    );
    expect(row(generation.text)).toBeDefined();
    expect(row(second.text)).toBeDefined();
  });

  test('a later page refetch updates existing rows without duplicating them', () => {
    mount([generation], 2);
    laterPage = { items: [second], total: 2 };
    act(() => intersect!());
    expect(row(second.text)).toBeDefined();
    const updated = { ...second, text: 'Updated clip' };
    laterPage = { items: [updated], total: 2 };
    act(() =>
      renderer.update(createElement(QueryClientProvider, { client }, createElement(HistoryTable))),
    );
    expect(row(updated.text)).toBeDefined();
    expect(renderer.root.findAllByProps({ role: 'button' })).toHaveLength(2);
  });

  for (const [name, result] of [
    ['delete', deleteMutation],
    ['import', importMutation],
    ['clear failed', clearMutation],
  ] as const) {
    test(`${name} returns a later page to refreshed first-page results`, () => {
      mount([generation], 2);
      laterPage = { items: [second], total: 2 };
      act(() => intersect!());
      historyData = { items: [{ ...generation, text: 'Refreshed first page' }], total: 1 };
      result.isSuccess = true;
      act(() =>
        renderer.update(
          createElement(QueryClientProvider, { client }, createElement(HistoryTable)),
        ),
      );
      expect(row('Refreshed first page')).toBeDefined();
      expect(row(second.text)).toBeUndefined();
    });
  }

  test('a generation completion returns a later page to refreshed first-page results', () => {
    useGenerationStore.getState().addPendingGeneration('pending');
    mount([generation], 2);
    laterPage = { items: [second], total: 2 };
    act(() => intersect!());
    historyData = { items: [{ ...generation, text: 'Completed generation' }], total: 1 };
    act(() => useGenerationStore.getState().removePendingGeneration('pending'));
    expect(row('Completed generation')).toBeDefined();
    expect(row(second.text)).toBeUndefined();
  });

  test('switching an earlier page version updates its card after success', async () => {
    mount([generation], 2);
    laterPage = { items: [second], total: 2 };
    act(() => intersect!());
    const versionButton = renderer.root
      .findAllByType('button')
      .find((node) =>
        node.findAllByType('span').some((span) => span.props.children === 'original'),
      )!;
    await act(async () => {
      versionButton.props.onClick();
      await Promise.resolve();
    });
    expect(setDefault).toHaveBeenCalledWith('gen', 'original');
    act(() => clickRow(generation.text));
    expect(usePlayerStore.getState().audioUrl).toBe(
      '/audio/version/original?revision=original.wav',
    );
  });

  test('the final rapid card selection wins even before React rerenders', () => {
    usePlayerStore
      .getState()
      .setAudio('/audio/version/processed?revision=processed.wav', 'gen', 'voice');
    mount([generation, second]);
    act(() => {
      clickRow(second.text);
      clickRow(generation.text);
    });
    expect(usePlayerStore.getState().audioId).toBe('gen');
    expect(usePlayerStore.getState().audioUrl).toContain('/audio/version/processed');
  });

  test('seeded card gestures preserve selected clip and ignore nested controls', () => {
    const clips = [generation, second];
    const urls = [
      '/audio/version/processed?revision=processed.wav',
      '/audio/version/second-version?revision=processed.wav',
    ];
    mount(clips);
    for (const seed of [0x12345678, 0xdecafbad, 0x5eed]) {
      let random = seed >>> 0;
      const next = () => {
        random ^= random << 13;
        random ^= random >>> 17;
        random ^= random << 5;
        return random >>> 0;
      };
      act(() => usePlayerStore.getState().reset());
      let selected: number | null = null;
      const reached = [0, 0, 0, 0, 0];
      for (let step = 0; step < 40; step++) {
        const index = next() % 2;
        const action = next() % 5;
        reached[action]++;
        act(() => {
          if (action === 0) {
            clickRow(clips[index].text);
            selected = index;
          } else if (action === 1) {
            clickRow(clips[index].text, true, true);
          } else if (action === 2) {
            row(clips[index].text).props.onClick({
              button: 0,
              target: { closest: (selector: string) => (selector.includes('button') ? {} : null) },
            });
          } else if (action === 3) {
            row(clips[index].text).props.onKeyDown({
              key: ' ',
              target: { closest: () => null },
              preventDefault: () => {},
            });
            selected = index;
          } else {
            clickRow(clips[index].text);
            clickRow(clips[1 - index].text);
            clickRow(clips[index].text);
            selected = index;
          }
        });
        const player = usePlayerStore.getState();
        expect(player.audioId).toBe(selected === null ? null : clips[selected].id);
        expect(player.audioUrl).toBe(selected === null ? null : urls[selected]);
        expect(row(clips[0].text).props['aria-pressed']).toBe(selected === 0);
        expect(row(clips[1].text).props['aria-pressed']).toBe(selected === 1);
      }
      expect(reached.every((count) => count > 0)).toBe(true);
    }
  });

  test('clicking the transcript plays its card while selecting transcript text does not', () => {
    mount([generation, second]);
    act(() => clickRow(second.text, true));
    expect(usePlayerStore.getState().audioId).toBe('second');
    act(() => clickRow(generation.text, true, true));
    expect(usePlayerStore.getState().audioId).toBe('second');
  });

  test('the main card selects its current default version instead of restarting an old take', () => {
    usePlayerStore.getState().setAudio('/audio/version/original', 'gen', 'voice');
    mount();
    act(() => clickRow(generation.text));
    expect(usePlayerStore.getState().audioUrl).toBe(
      '/audio/version/processed?revision=processed.wav',
    );
    expect(usePlayerStore.getState().shouldAutoPlay).toBe(true);
    expect(row(generation.text).props['aria-pressed']).toBe(true);
  });

  test('loads existing effects and saves an empty chain to the same version', async () => {
    mount();
    act(() => button('history.versions.edit').props.onClick());
    expect(renderer.root.findByProps({ 'data-chain': true }).props.children).toContain('gain_db');
    act(() => button('Clear effects').props.onClick());
    await act(async () => {
      await button('common.save').props.onClick();
    });
    expect(update).toHaveBeenCalledWith('gen', 'processed', { effects_chain: [] });
    expect(remove).not.toHaveBeenCalled();
  });

  test('deletion needs confirmation and resets playback to the server-selected default', async () => {
    mount();
    act(() =>
      usePlayerStore.getState().setAudio('/audio/version/processed', 'gen', 'voice', 'Hello'),
    );
    act(() => button('history.versions.delete').props.onClick());
    expect(remove).not.toHaveBeenCalled();
    await act(async () => {
      await button('common.delete').props.onClick();
    });
    expect(remove).toHaveBeenCalledWith('gen', 'processed');
    expect(usePlayerStore.getState().audioUrl).toContain('/audio/version/original');
    expect(usePlayerStore.getState().shouldAutoPlay).toBe(false);
  });

  test('a delayed version deletion does not reopen audio after another selection is closed', async () => {
    let resolveDelete!: (versions: GenerationVersionResponse[]) => void;
    remove.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDelete = resolve;
        }),
    );
    mount([generation, second]);
    act(() => usePlayerStore.getState().setAudio('/audio/version/processed', 'gen', 'voice'));
    act(() => button('history.versions.delete').props.onClick());
    let pending!: Promise<void>;
    await act(async () => {
      pending = button('common.delete').props.onClick();
      await Promise.resolve();
    });
    act(() => {
      usePlayerStore.getState().setAudio('/audio/version/second-version', 'second', 'voice');
      usePlayerStore.getState().reset();
    });
    await act(async () => {
      resolveDelete([{ ...original, is_default: true }]);
      await pending;
    });
    expect(usePlayerStore.getState().audioId).toBeNull();
    expect(usePlayerStore.getState().audioUrl).toBeNull();
  });

  test('a failed edit keeps the editor open for correction', async () => {
    update.mockRejectedValueOnce(new Error('Source audio file not found'));
    mount();
    act(() => button('history.versions.edit').props.onClick());
    await act(async () => {
      await button('common.save').props.onClick();
    });
    expect(button('common.save').props.disabled).toBe(false);
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'Source audio file not found',
        variant: 'destructive',
      }),
    );
  });

  test('a failed deletion preserves the confirmation and restores selected audio', async () => {
    remove.mockRejectedValueOnce(new Error('This version is pinned in a story'));
    mount();
    act(() =>
      usePlayerStore.getState().setAudio('/audio/version/processed', 'gen', 'voice', 'Hello'),
    );
    act(() => button('history.versions.delete').props.onClick());
    await act(async () => {
      await button('common.delete').props.onClick();
    });
    expect(button('common.delete').props.disabled).toBe(false);
    expect(usePlayerStore.getState().audioUrl).toBe('/audio/version/processed');
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'This version is pinned in a story',
        variant: 'destructive',
      }),
    );
  });
});

test('large history collections mount only a bounded window of transcript cards', () => {
  mount(
    Array.from({ length: 1000 }, (_, index) => ({
      ...generation,
      id: `history-${index}`,
      text: `Take ${index}`,
    })),
  );
  const transcripts = renderer.root.findAllByProps({ 'data-history-transcript': true });
  expect(transcripts.length).toBeGreaterThan(0);
  expect(transcripts.length).toBeLessThan(30);
  for (const transcript of transcripts) {
    expect(transcript.props.id).toBeTruthy();
    expect(renderer.root.findByProps({ 'aria-describedby': transcript.props.id }).props.role).toBe('button');
  }
});

test('older history pages use the server cursor without a deep offset or repeated total count', () => {
  mount([generation], 2, 'older-boundary');
  laterPage = {
    items: [{ ...generation, id: 'older', text: 'Older take' }],
    total: null,
    next_cursor: null,
  };
  act(() => intersect!());
  expect(historyQueries.at(-1)).toMatchObject({
    offset: 0,
    cursor: 'older-boundary',
    include_total: false,
  });
  expect(
    renderer.root
      .findAllByProps({ 'data-history-transcript': true })
      .map((node) => node.props.children),
  ).toContain('Older take');
});

test('transcript cards render full selectable text without textarea clipping and toggle long takes', () => {
  const longText = 'A '.repeat(150).trim();
  mount([{ ...generation, text: longText }], 1, undefined, false);
  expect(renderer.root.findAllByType('textarea')).toHaveLength(0);
  const transcript = renderer.root.findByProps({ 'data-history-transcript': true });
  expect(transcript.props.className).toContain('line-clamp-4');
  const showMore = renderer.root
    .findAllByType('button')
    .find((node) => node.props.children === 'Show more');
  expect(showMore).toBeDefined();
  act(() => {
    showMore!.props.onClick();
  });
  expect(renderer.root.findByProps({ 'data-history-transcript': true }).props.className).not.toContain(
    'line-clamp-4',
  );
});

test('retrying a failed generation tracks the newly created task', async () => {
  mount([{ ...generation, status: 'failed' }], 1, undefined, false);
  await act(async () => { renderer.root.findByProps({ 'aria-label': 'Retry generation' }).props.onClick(); await Promise.resolve(); });
  expect(retryGeneration).toHaveBeenCalledWith('gen');
  expect(useGenerationStore.getState().pendingGenerationIds.has('retry-id')).toBe(true);
});

test('failed retry reports the error without adding a pending task', async () => {
  retryGeneration.mockImplementationOnce(async () => { throw new Error('retry unavailable'); });
  mount([{ ...generation, status: 'failed' }], 1, undefined, false);
  await act(async () => { renderer.root.findByProps({ 'aria-label': 'Retry generation' }).props.onClick(); await Promise.resolve(); });
  expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Retry failed', description: 'retry unavailable' }));
  expect(useGenerationStore.getState().pendingGenerationIds.has('retry-id')).toBe(false);
});

test('late retry completion does not add a task from the previous server', async () => {
  let resolve!: (value: { id: string }) => void;
  retryGeneration.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
  mount([{ ...generation, status: 'failed' }], 1, undefined, false);
  await act(async () => { renderer.root.findByProps({ 'aria-label': 'Retry generation' }).props.onClick(); });
  act(() => useServerStore.setState({ serverUrl: 'http://server-b', serverRevision: 1 }));
  await act(async () => { resolve({ id: 'retry-id' }); });
  expect(useGenerationStore.getState().pendingGenerationIds.has('retry-id')).toBe(false);
});

test('regeneration tracks the original task and reports failures', async () => {
  mount();
  await act(async () => { button('history.actions.regenerate').props.onClick(); await Promise.resolve(); });
  expect(regenerateGeneration).toHaveBeenCalledWith('gen');
  expect(useGenerationStore.getState().pendingGenerationIds.has('gen')).toBe(true);
  act(() => useGenerationStore.getState().removePendingGeneration('gen'));
  regenerateGeneration.mockImplementationOnce(async () => { throw new Error('regenerate unavailable'); });
  await act(async () => { button('history.actions.regenerate').props.onClick(); await Promise.resolve(); });
  expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Regenerate failed', description: 'regenerate unavailable' }));
  expect(useGenerationStore.getState().pendingGenerationIds.has('gen')).toBe(false);
});

test('a favorite failure is reported without altering playback', async () => {
  toggleFavorite.mockImplementationOnce(async () => { throw new Error('favorite unavailable'); });
  mount();
  await act(async () => { renderer.root.findByProps({ 'aria-label': 'Favorite' }).props.onClick(); await Promise.resolve(); });
  expect(toggleFavorite).toHaveBeenCalledWith('gen');
  expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Failed to update favorite', description: 'favorite unavailable' }));
  expect(usePlayerStore.getState().audioUrl).toBeNull();
});

test('a previous server favorite failure is not displayed on the new server', async () => {
  let reject!: (error: Error) => void;
  toggleFavorite.mockImplementationOnce(() => new Promise((_resolve, r) => { reject = r; }));
  mount();
  await act(async () => { renderer.root.findByProps({ 'aria-label': 'Favorite' }).props.onClick(); });
  act(() => useServerStore.setState({ serverUrl: 'http://server-b', serverRevision: 1 }));
  await act(async () => { reject(new Error('old server failure')); });
  expect(toast).not.toHaveBeenCalled();
});

test('late regeneration completion does not track a task on the new server', async () => {
  let resolve!: (value: object) => void;
  regenerateGeneration.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
  mount();
  await act(async () => { button('history.actions.regenerate').props.onClick(); });
  act(() => useServerStore.setState({ serverUrl: 'http://server-b', serverRevision: 1 }));
  await act(async () => { resolve({}); });
  expect(useGenerationStore.getState().pendingGenerationIds.has('gen')).toBe(false);
});

test('late retry failure is silent after switching servers', async () => {
  let reject!: (error: Error) => void;
  retryGeneration.mockImplementationOnce(() => new Promise((_resolve, r) => { reject = r; }));
  mount([{ ...generation, status: 'failed' }], 1, undefined, false);
  await act(async () => { renderer.root.findByProps({ 'aria-label': 'Retry generation' }).props.onClick(); });
  act(() => useServerStore.setState({ serverUrl: 'http://server-b', serverRevision: 1 }));
  await act(async () => { reject(new Error('old retry failed')); });
  expect(toast).not.toHaveBeenCalled();
});

test('late regeneration failure is silent after switching servers', async () => {
  let reject!: (error: Error) => void;
  regenerateGeneration.mockImplementationOnce(() => new Promise((_resolve, r) => { reject = r; }));
  mount();
  await act(async () => { button('history.actions.regenerate').props.onClick(); });
  act(() => useServerStore.setState({ serverUrl: 'http://server-b', serverRevision: 1 }));
  await act(async () => { reject(new Error('old regeneration failed')); });
  expect(toast).not.toHaveBeenCalled();
});

test('a version deletion confirmed after a server switch cannot target the new server', async () => {
  mount();
  act(() => button('history.versions.delete').props.onClick());
  const confirm = button('common.delete').props.onClick;
  act(() => useServerStore.setState({ serverUrl: 'http://server-b', serverRevision: 1 }));
  await act(async () => { await confirm(); });
  expect(remove).not.toHaveBeenCalled();
});

test('an old-server version deletion cannot restore old audio or report success', async () => {
  let resolve!: (versions: GenerationVersionResponse[]) => void;
  remove.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  mount();
  act(() => usePlayerStore.getState().setAudio('/audio/version/processed', 'gen', 'voice'));
  act(() => button('history.versions.delete').props.onClick());
  let pending!: Promise<void>;
  await act(async () => { pending = button('common.delete').props.onClick(); await Promise.resolve(); });
  act(() => useServerStore.setState({ serverUrl: 'http://server-b', serverRevision: 1 }));
  await act(async () => { resolve([{ ...original, is_default: true }]); await pending; });
  expect(usePlayerStore.getState().audioUrl).toBeNull();
  expect(toast).not.toHaveBeenCalled();
});

test('an old-server version edit cannot replace current playback or report success', async () => {
  let resolve!: (version: GenerationVersionResponse) => void;
  update.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  mount();
  act(() => button('history.versions.edit').props.onClick());
  let pending!: Promise<void>;
  await act(async () => { pending = button('common.save').props.onClick(); await Promise.resolve(); });
  act(() => {
    useServerStore.setState({ serverUrl: 'http://server-b', serverRevision: 1 });
    usePlayerStore.getState().setAudio('/current-server-audio', 'gen', 'voice');
  });
  await act(async () => { resolve({ ...processed, audio_path: 'old-result.wav' }); await pending; });
  expect(usePlayerStore.getState().audioUrl).toBe('/current-server-audio');
  expect(toast).not.toHaveBeenCalled();
});

test('an old-server version switch failure is not shown on the new server', async () => {
  let reject!: (error: Error) => void;
  setDefault.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  mount();
  const version = renderer.root.findAllByType('button').find((node) =>
    node.findAllByType('span').some((span) => span.props.children === 'original'))!;
  await act(async () => { version.props.onClick(); await Promise.resolve(); });
  act(() => useServerStore.setState({ serverUrl: 'http://server-b', serverRevision: 1 }));
  await act(async () => { reject(new Error('old server version failure')); await Promise.resolve(); });
  expect(toast).not.toHaveBeenCalled();
});

test('an edit confirmed after a server switch cannot target the new server', async () => {
  mount();
  act(() => button('history.versions.edit').props.onClick());
  const confirm = button('common.save').props.onClick;
  act(() => useServerStore.setState({ serverUrl: 'http://server-b', serverRevision: 1 }));
  await act(async () => { await confirm(); });
  expect(update).not.toHaveBeenCalled();
});

test('an old-server deletion failure cannot restore audio or show an error', async () => {
  let reject!: (error: Error) => void;
  remove.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  mount();
  act(() => usePlayerStore.getState().setAudio('/audio/version/processed', 'gen', 'voice'));
  act(() => button('history.versions.delete').props.onClick());
  let pending!: Promise<void>;
  await act(async () => { pending = button('common.delete').props.onClick(); await Promise.resolve(); });
  act(() => useServerStore.setState({ serverUrl: 'http://server-b', serverRevision: 1 }));
  await act(async () => { reject(new Error('old deletion failed')); await pending; });
  expect(usePlayerStore.getState().audioUrl).toBeNull();
  expect(toast).not.toHaveBeenCalled();
});

test('an old version edit cannot unlock a newer server edit', async () => {
  const pending: Array<(version: GenerationVersionResponse) => void> = [];
  update.mockImplementationOnce(() => new Promise((resolve) => { pending.push(resolve); }));
  update.mockImplementationOnce(() => new Promise((resolve) => { pending.push(resolve); }));
  mount();
  act(() => button('history.versions.edit').props.onClick());
  let first!: Promise<void>;
  await act(async () => { first = button('common.save').props.onClick(); await Promise.resolve(); });
  act(() => useServerStore.setState({ serverUrl: 'http://server-b', serverRevision: 1 }));
  act(() => button('history.versions.edit').props.onClick());
  let second!: Promise<void>;
  await act(async () => { second = button('common.save').props.onClick(); await Promise.resolve(); });
  expect(update).toHaveBeenCalledTimes(2);
  await act(async () => { pending[0]({ ...processed, audio_path: 'old.wav' }); await first; });
  expect(button('history.effectsDialog.applying').props.disabled).toBe(true);
  await act(async () => { pending[1]({ ...processed, audio_path: 'new.wav' }); await second; });
  expect(toast).toHaveBeenCalledTimes(1);
});

test('a generation deletion confirmed after switching servers cannot delete on the new server', () => {
  deleteMutation.mutate.mockClear();
  mount([{ ...generation, status: 'failed', versions: [] }], 1, undefined, false);
  act(() => renderer.root.findByProps({ 'aria-label': 'Delete generation' }).props.onClick());
  const confirm = button('common.delete').props.onClick;
  act(() => useServerStore.setState({ serverUrl: 'http://server-b', serverRevision: 1 }));
  act(() => confirm());
  expect(deleteMutation.mutate).not.toHaveBeenCalled();
});

test('clear failed confirmed after switching servers cannot clear the new server', () => {
  clearMutation.mutate.mockClear();
  mount([{ ...generation, status: 'failed', versions: [] }], 1, undefined, false);
  act(() => button('Clear failed').props.onClick());
  const confirm = button('history.clearFailedDialog.clearAll').props.onClick;
  act(() => useServerStore.setState({ serverUrl: 'http://server-b', serverRevision: 1 }));
  act(() => confirm());
  expect(clearMutation.mutate).not.toHaveBeenCalled();
});

test('queued cancellation cannot dispatch to a newly selected server', async () => {
  mount([{ ...generation, status: 'generating', versions: [] }], 1, undefined, false);
  await act(async () => {
    renderer.root.findByProps({ 'aria-label': 'Cancel generation' }).props.onClick();
    useServerStore.setState({ serverUrl: 'http://server-b', serverRevision: 1 });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(cancelGeneration).not.toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalled();
});

test('old-server cancellation completion does not notify the current server', async () => {
  let resolve!: (value: { message: string }) => void;
  cancelGeneration.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  mount([{ ...generation, status: 'generating', versions: [] }], 1, undefined, false);
  await act(async () => {
    renderer.root.findByProps({ 'aria-label': 'Cancel generation' }).props.onClick();
    await new Promise((done) => setTimeout(done, 0));
  });
  act(() => useServerStore.setState({ serverUrl: 'http://server-b', serverRevision: 1 }));
  await act(async () => { resolve({ message: 'old server cancelled' }); await Promise.resolve(); });
  expect(toast).not.toHaveBeenCalled();
});
