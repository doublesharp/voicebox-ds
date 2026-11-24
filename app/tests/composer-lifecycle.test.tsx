import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { createElement, forwardRef, type ReactNode } from 'react';
import { Controller } from 'react-hook-form';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { create as createStore } from 'zustand';

const ui = createStore<{
  selectedProfileId: string | null;
  selectedEngine: string;
  setSelectedProfileId: (id: string | null) => void;
  setSelectedEngine: (engine: string) => void;
}>((set) => ({
  selectedProfileId: 'a',
  selectedEngine: 'qwen',
  setSelectedProfileId: (id) => set({ selectedProfileId: id }),
  setSelectedEngine: (engine) => set({ selectedEngine: engine }),
}));
let profiles = [
  {
    id: 'a',
    name: 'A',
    language: 'en',
    default_engine: 'chatterbox',
    voice_type: 'cloned',
    personality: 'A',
    effects_chain: [{ type: 'a' }],
  },
  {
    id: 'b',
    name: 'B',
    language: 'en',
    default_engine: 'qwen',
    voice_type: 'cloned',
    personality: 'B',
    effects_chain: [{ type: 'b' }],
  },
];
const presets = [{ id: 'custom', name: 'Custom', effects_chain: [{ type: 'custom' }] }];
const initialProfiles = structuredClone(profiles);
let compose: (id: string) => Promise<{ text: string }> = async () => ({ text: 'composed' });
let status: Promise<{ models: never[] }> | undefined;
let statusCalls = 0;
const requests: Record<string, unknown>[] = [];
const toasts: Record<string, unknown>[] = [];
let generationError: Error | undefined;
let storyRoute = false;
let hiddenProfile = false;
let previewAvailable = false;
let previewActive = false;
const previewRequests: Record<string, unknown>[] = [];
const previewModes: (string | undefined)[] = [];
let previewStops = 0;
let previewStopHandler: () => Promise<void> = async () => {};
let mockServer = { serverUrl: 'http://server-a', serverRevision: 0 };
mock.module('../src/lib/audio/useSpeechPreview', () => ({
  useSpeechPreview: () => ({
    available: previewAvailable,
    bufferedAvailable: previewAvailable,
    active: previewActive,
    start: async (request: Record<string, unknown>, mode?: string) => {
      previewRequests.push(request);
      previewModes.push(mode);
    },
    stop: async () => {
      previewStops++;
      await previewStopHandler();
    },
  }),
}));
const mockServerStore = Object.assign(
  (selector: (state: { serverUrl: string; serverRevision: number }) => unknown) =>
    selector(mockServer),
  { getState: () => mockServer },
);
mock.module('../src/stores/serverStore', () => ({ useServerStore: mockServerStore }));
mock.module('../src/lib/api/client', () => ({
  apiClient: {
    composeWithPersonality: (id: string) => compose(id),
    listEffectPresets: async () => presets,
    getModelStatus: async () => {
      statusCalls++;
      return status ?? { models: [] };
    },
  },
}));
mock.module('@tanstack/react-query', () => ({
  useQuery: () => ({ data: presets }),
  useMutation: ({
    mutationFn,
    onError,
  }: {
    mutationFn: (id: any) => Promise<unknown>;
    onError: (error: Error, id: any) => void;
  }) => ({
    isPending: false,
    mutateAsync: async (id: any) => {
      try {
        return await mutationFn(id);
      } catch (e) {
        onError(e as Error, id);
        throw e;
      }
    },
  }),
}));
mock.module('@tanstack/react-router', () => ({
  useMatchRoute: () => () => storyRoute,
  Link: passLink,
}));
function passLink({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
mock.module('framer-motion', () => ({
  motion: {
    div: forwardRef<HTMLDivElement, { children: ReactNode }>(({ children }, ref) => (
      <div ref={ref}>{children}</div>
    )),
  },
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
mock.module('../src/lib/hooks/useProfiles', () => ({
  useProfile: (id: string) => ({
    data: hiddenProfile ? undefined : profiles.find((p) => p.id === id),
  }),
  useProfiles: () => ({ data: profiles }),
}));
mock.module('../src/lib/hooks/useStories', () => ({ useStory: () => ({ data: undefined }) }));
mock.module('../src/lib/hooks/useGeneration', () => ({
  useGeneration: () => ({
    isPending: false,
    mutateAsync: async (request: Record<string, unknown>) => {
      requests.push(request);
      if (generationError) throw generationError;
      return { id: 'generated' };
    },
  }),
}));
mock.module('../src/lib/hooks/useSettings', () => ({
  useGenerationSettings: () => ({ settings: {} }),
}));
mock.module('../src/lib/hooks/useModelDownloadToast', () => ({ useModelDownloadToast() {} }));
mock.module('../src/components/ui/use-toast', () => ({
  useToast: () => ({ toast: (value: Record<string, unknown>) => toasts.push(value) }),
}));
mock.module('../src/stores/uiStore', () => ({ useUIStore: ui }));
mock.module('../src/stores/storyStore', () => ({
  useStoryStore: (s: (x: unknown) => unknown) => s({ selectedStoryId: null, trackEditorHeight: 0 }),
}));
mock.module('../src/stores/generationStore', () => ({
  useGenerationStore: (s: (x: unknown) => unknown) =>
    s({ addPendingStoryAdd() {}, addPendingGeneration() {} }),
}));
const pass = ({ children }: { children: ReactNode }) => <>{children}</>;
mock.module('../src/components/ui/form', () => ({
  Form: pass,
  FormControl: pass,
  FormItem: pass,
  FormLabel: pass,
  FormMessage: () => null,
  FormField: Controller,
}));
mock.module('../src/components/ui/button', () => ({
  Button: (props: Record<string, unknown>) => createElement('button', { type: 'button', ...props }),
}));
mock.module('../src/components/ui/textarea', () => ({
  Textarea: forwardRef((props: Record<string, unknown>, ref) =>
    createElement('textarea', { ...props, ref }),
  ),
}));
mock.module('../src/components/ui/select', () => ({
  Select: (props: Record<string, unknown>) => createElement('mock-select', props),
  SelectContent: pass,
  SelectItem: (props: Record<string, unknown>) => createElement('mock-option', props),
  SelectTrigger: pass,
  SelectValue: () => null,
}));
mock.module('../src/components/Generation/EngineModelSelector', () => ({
  EngineModelSelector: ({
    form,
    selectedProfile,
  }: {
    form: { setValue: (key: string, value: string) => void };
    selectedProfile?: { id: string };
  }) => (
    <>
      <button
        type="button"
        aria-label="choose-engine"
        data-profile-id={selectedProfile?.id}
        onClick={() => form.setValue('engine', 'luxtts')}
      />
      <button
        type="button"
        aria-label="choose-tada-1b"
        onClick={() => {
          form.setValue('engine', 'tada');
          form.setValue('modelSize', '1B');
        }}
      />
    </>
  ),
}));
mock.module('../src/components/Generation/SpeechSettings', () => ({ SpeechSettings: () => null }));
mock.module('../src/components/Generation/ParalinguisticInput', () => ({
  ParalinguisticInput: () => null,
}));
// The renderer has no DOM; click-away listeners are irrelevant to these state tests.
(globalThis as unknown as { document: unknown }).document = {
  addEventListener() {},
  removeEventListener() {},
};
const { FloatingGenerateBox } = await import('../src/components/Generation/FloatingGenerateBox');
const { useGenerationDraftStore } = await import('../src/stores/generationDraftStore');
const { useVoiceDeliveryStore } = await import('../src/stores/voiceDeliveryStore');
let renderer: ReactTestRenderer;
function mount(layout: 'docked' | 'floating' = 'floating') {
  act(() => {
    renderer = create(<FloatingGenerateBox layout={layout} />);
  });
}
function rerender() {
  act(() => renderer.update(<FloatingGenerateBox />));
}
function chooseEffects(id: string) {
  const select = renderer.root
    .findAllByType('mock-select' as never)
    .find((x) => ['none', '_profile', 'custom'].includes(x.props.value));
  act(() => select!.props.onValueChange(id));
}
function type(text: string) {
  act(() => {
    renderer.root.findByType('textarea').props.onChange({ target: { value: text, name: 'text' } });
  });
}

test('engine options receive the selected voice profile', () => {
  mount();
  expect(
    renderer.root.findByProps({ 'aria-label': 'choose-engine' }).props['data-profile-id'],
  ).toBe('a');
  act(() => ui.getState().setSelectedProfileId('b'));
  expect(
    renderer.root.findByProps({ 'aria-label': 'choose-engine' }).props['data-profile-id'],
  ).toBe('b');
});

test('TADA 1B offers only English in the language selector', () => {
  mount();
  act(() => renderer.root.findByProps({ 'aria-label': 'choose-tada-1b' }).props.onClick());
  const languageSelect = renderer.root
    .findAllByType('mock-select' as never)
    .find((node) =>
      node.findAllByType('mock-option' as never).some((option) => option.props.value === 'en'),
    );
  expect(
    languageSelect?.findAllByType('mock-option' as never).map((option) => option.props.value),
  ).toEqual(['en']);
});
afterEach(() => {
  act(() => renderer?.unmount());
  useGenerationDraftStore.setState({
    values: null,
    textRevision: 0,
    submitting: false,
    profileId: null,
    profileServerRevision: 0,
    profileApplied: false,
    presetId: null,
    effectsOverridden: false,
    voiceoverPolish: false,
  });
  ui.setState({ selectedProfileId: 'a', selectedEngine: 'qwen' });
  requests.length = 0;
  toasts.length = 0;
  generationError = undefined;
  status = undefined;
  statusCalls = 0;
  storyRoute = false;
  hiddenProfile = false;
  previewAvailable = false;
  previewActive = false;
  previewRequests.length = 0;
  previewModes.length = 0;
  previewStops = 0;
  previewStopHandler = async () => {};
  mockServer = { serverUrl: 'http://server-a', serverRevision: 0 };
  profiles = structuredClone(initialProfiles);
});

test('late profile data does not overwrite engine and effects chosen while loading', () => {
  hiddenProfile = true;
  mount();
  act(() => renderer.root.findByProps({ 'aria-label': 'choose-engine' }).props.onClick());
  chooseEffects('custom');
  hiddenProfile = false;
  rerender();
  expect(useGenerationDraftStore.getState().values?.engine).toBe('luxtts');
  expect(useGenerationDraftStore.getState().presetId).toBe('custom');
});
afterAll(() => mock.restore());

test('refetch and route remount preserve deliberate engine and effects choices', () => {
  mount();
  act(() => renderer.root.findByProps({ 'aria-label': 'choose-engine' }).props.onClick());
  chooseEffects('custom');
  type('unfinished');
  profiles = profiles.map((p) => ({ ...p }));
  rerender();
  expect(useGenerationDraftStore.getState().values).toMatchObject({
    text: 'unfinished',
    engine: 'luxtts',
  });
  expect(useGenerationDraftStore.getState().presetId).toBe('custom');
  act(() => renderer.unmount());
  storyRoute = true;
  mount();
  expect(renderer.root.findByType('textarea').props.value).toBe('unfinished');
  expect(useGenerationDraftStore.getState().values?.engine).toBe('luxtts');
  expect(useGenerationDraftStore.getState().presetId).toBe('custom');
  act(() => ui.getState().setSelectedProfileId('b'));
  expect(useGenerationDraftStore.getState().values?.engine).toBe('qwen');
  expect(useGenerationDraftStore.getState().presetId).toBe('_profile');
});

test('saved profile effects refresh an automatic selection while an explicit override survives', () => {
  profiles = profiles.map((p) => ({ ...p, effects_chain: [] }));
  mount();
  expect(useGenerationDraftStore.getState().presetId).toBeNull();
  act(() => renderer.unmount());
  profiles = profiles.map((p) => ({ ...p, effects_chain: [{ type: 'new default' }] }));
  mount();
  expect(useGenerationDraftStore.getState().presetId).toBe('_profile');
  chooseEffects('none');
  profiles = profiles.map((p) => ({ ...p, effects_chain: [{ type: 'another default' }] }));
  rerender();
  expect(useGenerationDraftStore.getState().presetId).toBeNull();
  chooseEffects('custom');
  profiles = profiles.map((p) => ({ ...p, effects_chain: [] }));
  rerender();
  expect(useGenerationDraftStore.getState().presetId).toBe('custom');
});

test('an explicit None sends an empty chain so backend profile defaults cannot be reapplied', async () => {
  mount();
  chooseEffects('none');
  type('A take without the voice effects.');
  await act(async () => {
    await renderer.root.findByType('form').props.onSubmit({ preventDefault() {}, persist() {} });
  });
  expect(requests[0]).toHaveProperty('effects_chain', []);
});

test('automatic voice defaults wait for profile data instead of silently disabling effects', async () => {
  hiddenProfile = true;
  mount();
  type('Wait for this voice to finish loading.');
  const submit = () =>
    renderer.root.findByType('form').props.onSubmit({ preventDefault() {}, persist() {} });
  await act(async () => {
    await submit();
  });
  expect(requests).toHaveLength(0);
  hiddenProfile = false;
  rerender();
  await act(async () => {
    await submit();
  });
  expect(requests[0]).toHaveProperty('effects_chain', profiles[0].effects_chain);
});

test('compose discards stale results after edits, profile changes, and unmount', async () => {
  mount();
  let resolve!: (value: { text: string }) => void;
  compose = () =>
    new Promise((r) => {
      resolve = r;
    });
  const click = () =>
    renderer.root.findByProps({ 'aria-label': 'generation.compose.ariaLabel' }).props.onClick();
  let pending!: Promise<void>;
  act(() => {
    pending = click();
  });
  type('typed after compose');
  await act(async () => {
    resolve({ text: 'stale edit' });
    await pending;
  });
  expect(renderer.root.findByType('textarea').props.value).toBe('typed after compose');
  act(() => {
    pending = click();
    ui.getState().setSelectedProfileId('b');
  });
  await act(async () => {
    resolve({ text: 'stale profile' });
    await pending;
  });
  expect(renderer.root.findByType('textarea').props.value).toBe('typed after compose');
  act(() => {
    pending = click();
    ui.getState().setSelectedProfileId('a');
    ui.getState().setSelectedProfileId('b');
  });
  await act(async () => {
    resolve({ text: 'stale round trip' });
    await pending;
  });
  expect(renderer.root.findByType('textarea').props.value).toBe('typed after compose');
  act(() => {
    pending = click();
    renderer.unmount();
  });
  await act(async () => {
    resolve({ text: 'stale unmount' });
    await pending;
  });
  mount();
  expect(renderer.root.findByType('textarea').props.value).toBe('typed after compose');
});

test('submission captures profile and effects before the model check', async () => {
  let release!: (value: { models: never[] }) => void;
  status = new Promise((resolve) => {
    release = resolve;
  });
  mount();
  chooseEffects('custom');
  type('first take');
  let pending!: Promise<void>;
  await act(async () => {
    pending = renderer.root
      .findByType('form')
      .props.onSubmit({ preventDefault() {}, persist() {} });
    await Promise.resolve();
  });
  act(() => {
    ui.getState().setSelectedProfileId('b');
    chooseEffects('none');
    type('next take');
  });
  await act(async () => {
    release({ models: [] });
    await pending;
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    profile_id: 'a',
    text: 'first take',
    effects_chain: [{ type: 'custom' }],
  });
  expect(renderer.root.findByType('textarea').props.value).toBe('next take');
});

test('docked and floating modes share a form and scope the submit shortcut to it', () => {
  act(() => {
    renderer = create(<FloatingGenerateBox layout="docked" />);
  });
  expect(renderer.root.findByProps({ 'data-composer-layout': 'docked' })).toBeTruthy();
  const form = renderer.root.findByType('form');
  let submissions = 0;
  let prevented = false;
  act(() =>
    form.props.onKeyDown({
      key: 'Enter',
      metaKey: true,
      ctrlKey: false,
      defaultPrevented: false,
      nativeEvent: { isComposing: false },
      preventDefault() {
        prevented = true;
      },
      target: {},
      currentTarget: {
        contains: () => true,
        requestSubmit() {
          submissions++;
        },
      },
    }),
  );
  expect(prevented).toBe(true);
  expect(submissions).toBe(1);
  act(() => renderer.update(<FloatingGenerateBox layout="floating" />));
  const floating = renderer.root.findByProps({ 'data-composer-layout': 'floating' });
  expect(floating.props.className).toContain('fixed');
  expect(floating.props.style.left).toContain('var(--app-rail-width)');
  expect(floating.props.style.bottom).toContain('var(--app-player-height)');
});

test('shortcut dispatches one request and ignores repeated and composing keys', async () => {
  mount();
  type('A line');
  let release!: (value: { models: never[] }) => void;
  status = new Promise((resolve) => {
    release = resolve;
  });
  const form = renderer.root.findByType('form');
  const submits: Promise<void>[] = [];
  const key = (overrides: Record<string, unknown> = {}) => ({
    key: 'Enter',
    metaKey: false,
    ctrlKey: true,
    repeat: false,
    defaultPrevented: false,
    nativeEvent: { isComposing: false },
    preventDefault() {},
    target: {},
    currentTarget: {
      contains: () => true,
      requestSubmit() {
        submits.push(form.props.onSubmit({ preventDefault() {}, persist() {} }));
      },
    },
    ...overrides,
  });
  await act(async () => {
    form.props.onKeyDown(key());
    form.props.onKeyDown(key());
    form.props.onKeyDown(
      key({
        currentTarget: {
          contains: () => false,
          requestSubmit() {
            throw new Error('portal submitted');
          },
        },
      }),
    );
    form.props.onKeyDown(key({ repeat: true }));
    form.props.onKeyDown(key({ nativeEvent: { isComposing: true } }));
    await Promise.resolve();
  });
  expect(submits).toHaveLength(2);
  await act(async () => {
    release({ models: [] });
    await Promise.all(submits);
  });
  expect(requests).toHaveLength(1);
  expect(requests[0].text).toBe('A line');
});

test('failed generation preserves the draft and permits a successful retry', async () => {
  generationError = new Error('Transport unavailable');
  mount();
  type('Keep this draft');
  const submit = () =>
    renderer.root.findByType('form').props.onSubmit({ preventDefault() {}, persist() {} });
  await act(async () => {
    await submit();
  });
  expect(requests).toHaveLength(1);
  expect(renderer.root.findByType('textarea').props.value).toBe('Keep this draft');
  expect(useGenerationDraftStore.getState().submitting).toBe(false);
  expect(toasts).toContainEqual(
    expect.objectContaining({
      title: 'Generation failed',
      description: 'Transport unavailable',
      variant: 'destructive',
    }),
  );
  generationError = undefined;
  await act(async () => {
    await submit();
  });
  expect(requests).toHaveLength(2);
  expect(requests[1].text).toBe('Keep this draft');
  expect(renderer.root.findByType('textarea').props.value).toBe('');
});

test('empty and overlong text are rejected before model lookup and generation', async () => {
  mount();
  const submit = () =>
    renderer.root.findByType('form').props.onSubmit({ preventDefault() {}, persist() {} });
  await act(async () => {
    await submit();
  });
  type('x'.repeat(50001));
  await act(async () => {
    await submit();
  });
  expect(requests).toHaveLength(0);
  expect(statusCalls).toBe(0);
  expect(useGenerationDraftStore.getState().submitting).toBe(false);
  expect(renderer.root.findByType('textarea').props.value).toHaveLength(50001);
});

test('desktop preview speaks the current script without saving or clearing the draft; stop remains explicit', async () => {
  previewAvailable = true;
  mount();
  act(() => ui.getState().setSelectedProfileId('b'));
  type('Keep this draft for the finished take.');
  await act(async () => {
    renderer.root
      .findAllByType('button')
      .find((button) => button.props['aria-label'] === 'Preview speech')!
      .props.onClick();
    await Promise.resolve();
  });
  expect(previewRequests).toEqual([
    expect.objectContaining({
      profile_id: 'b',
      text: 'Keep this draft for the finished take.',
      engine: 'qwen',
      normalize: false,
      speed: 1,
      effects_chain: [],
    }),
  ]);
  expect(requests).toEqual([]);
  expect(renderer.root.findByType('textarea').props.value).toBe(
    'Keep this draft for the finished take.',
  );
  previewActive = true;
  rerender();
  await act(async () => {
    renderer.root
      .findAllByType('button')
      .find((button) => button.props['aria-label'] === 'Stop preview')!
      .props.onClick();
  });
  expect(previewStops).toBe(1);
});

test('the delivery picker applies an expressive setting to the original cloned voice', async () => {
  ui.setState({ selectedProfileId: 'b' });
  mount('docked');
  const upbeat = () =>
    renderer.root.findAllByType('button').find((button) => button.children.includes('generation.delivery.upbeat'));
  expect(upbeat()).toBeDefined();
  act(() => upbeat()!.props.onClick());
  expect(upbeat()!.props['aria-pressed']).toBe(true);
  expect(ui.getState().selectedProfileId).toBe('b');

  type('We made setup simpler. Try it today.');
  await act(async () => {
    await renderer.root.findByType('form').props.onSubmit({ preventDefault() {}, persist() {} });
  });
  expect(requests[0]).toMatchObject({
    profile_id: 'b',
    engine: 'chatterbox',
    chatterbox_exaggeration: 0.7,
    chatterbox_cfg_weight: 0.3,
  });
});

test('Hear it and Hear Natural compare the same first sentence and effects without creating a take', async () => {
  previewAvailable = true;
  mount('docked');
  type('We made setup simpler. Try it today.');
  chooseEffects('custom');
  const button = (label: string) =>
    renderer.root.findAllByType('button').find((candidate) =>
      candidate.props['aria-label'] === label || candidate.children.includes(label),
    );
  expect(button('generation.delivery.upbeat')).toBeDefined();
  act(() => button('generation.delivery.upbeat')!.props.onClick());
  const hear = button('generation.delivery.hear');
  const natural = button('generation.delivery.hearNatural');
  expect(hear).toBeDefined();
  expect(natural).toBeDefined();
  await act(async () => {
    hear!.props.onClick();
  });
  await act(async () => {
    natural!.props.onClick();
  });
  const shared = {
    profile_id: 'a',
    text: 'We made setup simpler.',
    engine: 'chatterbox',
    normalize: true,
    speed: 1,
    effects_chain: [{ type: 'custom' }],
  };
  expect(previewModes).toEqual(['buffered', 'buffered']);
  expect(previewRequests[0]).toMatchObject({ ...shared, chatterbox_exaggeration: 0.7, chatterbox_cfg_weight: 0.3 });
  expect(previewRequests[1]).toMatchObject(shared);
  expect(previewRequests[1].chatterbox_exaggeration).toBeUndefined();
  expect(previewRequests[1].chatterbox_cfg_weight).toBeUndefined();
  expect(requests).toHaveLength(0);
  expect(renderer.root.findByType('textarea').props.value).toBe('We made setup simpler. Try it today.');
});

test('a matching voice ID on another backend does not inherit saved delivery', () => {
  useVoiceDeliveryStore.getState().save(mockServer.serverUrl, 'a', {
    delivery: 'excited',
    voiceoverPolish: false,
  });
  try {
    mount('docked');
    expect(useGenerationDraftStore.getState().values?.chatterboxExaggeration).toBe(0.8);
    mockServer = { serverUrl: 'http://server-b', serverRevision: 1 };
    act(() => renderer.update(<FloatingGenerateBox layout="docked" />));
    expect(useGenerationDraftStore.getState().values?.chatterboxExaggeration).toBeUndefined();
    const natural = renderer.root
      .findAllByType('button')
      .find((button) => button.children.includes('generation.delivery.natural'));
    expect(natural?.props['aria-pressed']).toBe(true);
  } finally {
    useVoiceDeliveryStore.setState({ defaults: {} });
  }
});

test('compose result from a previous server cannot replace the draft', async () => {
  let resolve!: (value: { text: string }) => void;
  compose = () => new Promise((r) => { resolve = r; });
  mount();
  type('My draft');
  let pending!: Promise<void>;
  act(() => { pending = renderer.root.findByProps({ 'aria-label': 'generation.compose.ariaLabel' }).props.onClick(); });
  mockServer = { serverUrl: 'http://server-b', serverRevision: 1 };
  await act(async () => { resolve({ text: 'old server text' }); await pending; });
  expect(renderer.root.findByType('textarea').props.value).toBe('My draft');
});

test('compose failure from a previous server is not shown on the new server', async () => {
  let reject!: (error: Error) => void;
  compose = () => new Promise((_resolve, r) => { reject = r; });
  mount();
  let pending!: Promise<void>;
  act(() => { pending = renderer.root.findByProps({ 'aria-label': 'generation.compose.ariaLabel' }).props.onClick(); });
  mockServer = { serverUrl: 'http://server-b', serverRevision: 1 };
  await act(async () => { reject(new Error('old server error')); await pending; });
  expect(toasts).not.toContainEqual(expect.objectContaining({ description: 'old server error' }));
});

test('server switch while stopping preview cannot submit to the new server', async () => {
  let resolve!: () => void;
  previewStopHandler = () => new Promise((r) => { resolve = r; });
  mount();
  type('Keep this draft');
  let pending!: Promise<void>;
  await act(async () => { pending = renderer.root.findByType('form').props.onSubmit({ preventDefault() {}, persist() {} }); await Promise.resolve(); });
  mockServer = { serverUrl: 'http://server-b', serverRevision: 1 };
  await act(async () => { resolve(); await pending; });
  expect(statusCalls).toBe(0);
  expect(requests).toHaveLength(0);
  expect(renderer.root.findByType('textarea').props.value).toBe('Keep this draft');
});

test('preview and generation remain grouped when preview changes state', () => {
  previewAvailable = true;
  mount();
  const actionGroup = () => renderer.root.findByProps({ 'data-generation-actions': true });
  const previewButton = () =>
    actionGroup()
      .findAllByType('button')
      .find((button) => button.props.type === 'button');
  const generateButton = () =>
    actionGroup()
      .findAllByType('button')
      .find((button) => button.props.type === 'submit');
  expect(previewButton()).toBeDefined();
  expect(generateButton()).toBeDefined();
  const reservedPreview = previewButton()!.findAllByProps({ 'aria-hidden': 'true' });
  const reservedGenerate = generateButton()!.findAllByProps({ 'aria-hidden': 'true' });
  expect(reservedPreview.map((label) => label.children.join(''))).toEqual(['Preview speech', 'Stop preview']);
  expect(reservedGenerate.map((label) => label.children.join(''))).toEqual([
    'generation.button.generate', 'generation.button.generating',
  ]);
  const initialGenerate = generateButton();
  previewActive = true;
  rerender();
  expect(previewButton()?.props['aria-label']).toBe('Stop preview');
  expect(generateButton()).toBe(initialGenerate);
  act(() => useGenerationDraftStore.setState({ submitting: true }));
  expect(generateButton()?.props.disabled).toBe(true);
  expect(generateButton()?.props['aria-label']).toBe('generation.button.generating');
  expect(previewButton()?.props.disabled).toBe(false);
  previewAvailable = false;
  rerender();
  expect(previewButton()).toBeUndefined();
  expect(generateButton()).toBe(initialGenerate);
});
