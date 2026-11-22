import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

const requests: Record<string, unknown>[] = [];
let modelStatus: Promise<{ models: never[] }> | undefined;
let generationResult: Promise<{ id: string }> | undefined;
let serverUrl = 'http://server-a';
let serverRevision = 0;
const pendingIds: string[] = [];
const toasts: any[] = [];
const serverStore = Object.assign((selector: any) => selector({ serverUrl, serverRevision }), { getState: () => ({ serverUrl, serverRevision }) });
mock.module('../src/stores/serverStore', () => ({ useServerStore: serverStore }));
mock.module('../src/lib/api/client', () => ({
  apiClient: { getModelStatus: async () => modelStatus ?? { models: [] } },
}));
mock.module('../src/lib/hooks/useGeneration', () => ({
  useGeneration: () => ({
    isPending: false,
    mutateAsync: async (request: Record<string, unknown>) => {
      requests.push(JSON.parse(JSON.stringify(request)));
      return generationResult ?? { id: `generation-${requests.length}` };
    },
  }),
}));
mock.module('../src/lib/hooks/useSettings', () => ({
  useGenerationSettings: () => ({ settings: {} }),
}));
mock.module('../src/lib/hooks/useModelDownloadToast', () => ({ useModelDownloadToast() {} }));
mock.module('../src/components/ui/use-toast', () => ({ useToast: () => ({ toast(value: unknown) { toasts.push(value); } }) }));
mock.module('../src/stores/uiStore', () => ({
  useUIStore: (selector: (state: { selectedEngine: string }) => unknown) =>
    selector({ selectedEngine: 'chatterbox' }),
}));
mock.module('../src/stores/generationStore', () => ({
  useGenerationStore: (
    selector: (state: { addPendingGeneration: (id: string) => void }) => unknown,
  ) => selector({ addPendingGeneration(id: string) { pendingIds.push(id); } }),
}));
mock.module('../src/components/ui/popover', () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
mock.module('../src/components/ui/select', () => ({
  Select: (props: Record<string, unknown>) => createElement('mock-select', props),
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectTrigger: (props: Record<string, unknown>) => createElement('mock-trigger', props),
  SelectValue: () => null,
}));

const { useGenerationForm } = await import('../src/lib/hooks/useGenerationForm');
const { SpeechSettings } = await import('../src/components/Generation/SpeechSettings');
const { useGenerationDraftStore } = await import('../src/stores/generationDraftStore');
let form: ReturnType<typeof useGenerationForm>;
let renderer: ReactTestRenderer;
function Harness({ controls = false }: { controls?: boolean }) {
  form = useGenerationForm();
  return controls ? <SpeechSettings form={form.form} /> : null;
}
function mount(controls = false) {
  act(() => {
    renderer = create(<Harness controls={controls} />);
  });
}
afterEach(() => {
  act(() => renderer?.unmount());
  requests.length = 0;
  modelStatus = undefined;
  generationResult = undefined;
  serverUrl = 'http://server-a';
  serverRevision = 0;
  pendingIds.length = 0;
  toasts.length = 0;
  useGenerationDraftStore.setState({
    values: null,
    textRevision: 0,
    submitting: false,
    profileId: null,
    profileApplied: false,
    presetId: null,
  });
});
afterAll(() => mock.restore());

test('navigation preserves the draft and speech settings in memory', () => {
  mount();
  act(() => {
    form.form.setValue('text', 'Private work in progress');
    form.form.setValue('speed', 0.85);
    form.form.setValue('chatterboxTemperature', 1);
    form.form.setValue('chatterboxCfgWeight', 0.3);
    renderer.unmount();
  });
  mount();
  expect(form.form.getValues()).toMatchObject({
    text: 'Private work in progress',
    speed: 0.85,
    chatterboxTemperature: 1,
    chatterboxCfgWeight: 0.3,
  });
});

test('generation uses the selected quantized model size', async () => {
  mount();
  await act(async () => {
    await form.handleSubmit({ text: 'Hello', engine: 'qwen', modelSize: '1.7B-4bit', language: 'en' }, 'voice');
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ engine: 'qwen', model_size: '1.7B-4bit' });
});

test('a pending submission cannot erase later edits or dispatch twice', async () => {
  let release!: (value: { models: never[] }) => void;
  modelStatus = new Promise((resolve) => {
    release = resolve;
  });
  mount();
  act(() => form.form.setValue('text', 'Submitted text'));
  const data = form.form.getValues();
  let first!: Promise<void>;
  let second!: Promise<void>;
  act(() => {
    first = form.handleSubmit(data, 'voice-a');
    second = form.handleSubmit(data, 'voice-a');
    form.form.setValue('text', 'New work');
    form.form.setValue('speed', 0.9);
  });
  await act(async () => {
    release({ models: [] });
    await Promise.all([first, second]);
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ text: 'Submitted text', profile_id: 'voice-a', speed: 1 });
  expect(form.form.getValues()).toMatchObject({ text: 'New work', speed: 0.9 });
});

test('completion after navigation clears the submitted text in the newly mounted form', async () => {
  let release!: (value: { models: never[] }) => void;
  modelStatus = new Promise((resolve) => {
    release = resolve;
  });
  mount();
  act(() => {
    form.form.setValue('text', 'Submitted');
    form.form.setValue('speed', 0.85);
  });
  let pending!: Promise<void>;
  act(() => {
    pending = form.handleSubmit(form.form.getValues(), 'voice');
    renderer.unmount();
  });
  mount();
  expect(form.isPending).toBe(true);
  await act(async () => {
    release({ models: [] });
    await pending;
  });
  expect(form.form.getValues()).toMatchObject({ text: '', speed: 0.85 });
  expect(form.isPending).toBe(false);
});

test('seeded draft actions preserve text, settings, and request identity', async () => {
  for (const initialSeed of [0x12345678, 0xc0ffee, 0xdeadbeef]) {
    useGenerationDraftStore.setState({
      values: null,
      textRevision: 0,
      submitting: false,
      profileId: null,
      profileApplied: false,
      presetId: null,
    });
    let seed = initialSeed;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    const reached = [0, 0, 0, 0, 0];
    let text = '';
    let speed = 1;
    let temperature: number | undefined;
    mount();
    for (let i = 0; i < 100; i++) {
      const action = next() % 5;
      if (action !== 4 || text) reached[action]++;
      if (action === 0) {
        text = `draft-${initialSeed}-${i}`;
        act(() => form.form.setValue('text', text));
      } else if (action === 1) {
        speed = [0.75, 0.85, 1, 1.15][next() % 4];
        act(() => form.form.setValue('speed', speed));
      } else if (action === 2) {
        temperature = [undefined, 0.6, 1][next() % 3];
        act(() => form.form.setValue('chatterboxTemperature', temperature));
      } else if (action === 3) {
        act(() => renderer.unmount());
        mount();
      } else if (text) {
        const profile = `voice-${next() % 3}`;
        const count = requests.length;
        const data = form.form.getValues();
        await act(async () => {
          await form.handleSubmit(data, profile);
        });
        expect(requests).toHaveLength(count + 1);
        expect(requests[count]).toMatchObject({ text, profile_id: profile, speed });
        expect(requests[count].chatterbox_temperature).toBe(temperature);
        text = '';
      }
      expect(form.form.getValues()).toMatchObject({ text, speed, engine: 'chatterbox' });
      expect(form.form.getValues('chatterboxTemperature')).toBe(temperature);
    }
    expect(reached.every((count) => count > 0)).toBe(true);
    act(() => renderer.unmount());
  }
});

test('speech choices reach generated audio and remain selected for the next take', async () => {
  mount();
  const data = {
    text: 'A quieter, more relaxed read.',
    language: 'en' as const,
    engine: 'chatterbox' as const,
    speed: 0.85,
    chatterboxTemperature: 1,
    chatterboxCfgWeight: 0.3,
  };
  act(() => {
    for (const [key, value] of Object.entries(data)) {
      form.form.setValue(key as keyof typeof data, value as never);
    }
  });
  await act(async () => {
    await form.handleSubmit(data, 'voice');
  });
  expect(requests[0]).toMatchObject({
    speed: 0.85,
    chatterbox_temperature: 1,
    chatterbox_cfg_weight: 0.3,
  });
  expect(requests[0]).not.toHaveProperty('chatterbox_exaggeration');
  expect(form.form.getValues()).toMatchObject({
    text: '',
    speed: 0.85,
    chatterboxTemperature: 1,
    chatterboxCfgWeight: 0.3,
  });
});

test('changing engine retains speed without sending Chatterbox overrides', async () => {
  mount();
  await act(async () => {
    await form.handleSubmit(
      {
        text: 'A slower Qwen read.',
        language: 'en',
        engine: 'qwen',
        speed: 0.9,
        chatterboxTemperature: 1,
        chatterboxCfgWeight: 0.3,
        chatterboxExaggeration: 0.4,
      },
      'voice',
    );
  });
  expect(requests[0]).toMatchObject({ engine: 'qwen', speed: 0.9 });
  expect(requests[0]).not.toHaveProperty('chatterbox_temperature');
  expect(requests[0]).not.toHaveProperty('chatterbox_cfg_weight');
  expect(requests[0]).not.toHaveProperty('chatterbox_exaggeration');
});

test('untouched controls preserve model defaults', async () => {
  mount();
  await act(async () => {
    await form.handleSubmit(
      { text: 'The original read.', language: 'en', engine: 'chatterbox' },
      'voice',
    );
  });
  expect(requests[0]).toMatchObject({ speed: 1 });
  expect(requests[0]).not.toHaveProperty('chatterbox_temperature');
  expect(requests[0]).not.toHaveProperty('chatterbox_cfg_weight');
  expect(requests[0]).not.toHaveProperty('chatterbox_exaggeration');
});

test('switching engines ignores an invalid hidden Chatterbox override during form validation', async () => {
  mount();
  const submit = () => form.form.handleSubmit((data) => form.handleSubmit(data, 'voice'))();
  await act(async () => {
    form.form.setValue('text', 'A slower read.');
    form.form.setValue('speed', 0.85);
    form.form.setValue('chatterboxCfgWeight', 1.2);
    await submit();
  });
  expect(requests).toHaveLength(0);
  expect(form.form.getFieldState('chatterboxCfgWeight').error).toBeDefined();
  await act(async () => {
    form.form.setValue('engine', 'qwen');
    await submit();
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ engine: 'qwen', speed: 0.85 });
  expect(requests[0]).not.toHaveProperty('chatterbox_cfg_weight');
  expect(form.form.getFieldState('chatterboxCfgWeight').error).toBeUndefined();
});

test('Relaxed and variation controls change the take without silently overriding expression', async () => {
  mount(true);
  const relaxed = renderer.root
    .findAllByType('button')
    .find((node) => node.props.children === 'Relaxed');
  expect(relaxed).toBeDefined();
  act(() => relaxed!.props.onClick());
  expect(form.form.getValues()).toMatchObject({ speed: 0.85, chatterboxCfgWeight: 0.3 });
  expect(form.form.getValues('chatterboxTemperature')).toBeUndefined();
  expect(form.form.getValues('chatterboxExaggeration')).toBeUndefined();
  expect(renderer.root.findByProps({ type: 'range' }).props.value).toBe(0.85);
  const variation = renderer.root.findByType('mock-select' as never);
  act(() => variation.props.onValueChange('1'));
  expect(form.form.getValues('chatterboxTemperature')).toBe(1);
  act(() => form.form.setValue('engine', 'qwen'));
  expect(renderer.root.findAllByType('mock-select' as never)).toHaveLength(0);
  expect(form.form.getValues('speed')).toBe(0.85);
  const reset = renderer.root
    .findAllByType('button')
    .find((node) => node.props.children === 'Reset');
  act(() => reset!.props.onClick());
  expect(form.form.getValues('speed')).toBe(1);
  expect(form.form.getValues('chatterboxTemperature')).toBeUndefined();
  expect(form.form.getValues('chatterboxCfgWeight')).toBeUndefined();
});


test('server change during model status check cannot submit to the new server', async () => {
  let release!: (value: { models: never[] }) => void;
  modelStatus = new Promise((resolve) => { release = resolve; });
  mount();
  act(() => form.form.setValue('text', 'Keep this draft'));
  let submission!: Promise<void>;
  act(() => { submission = form.handleSubmit(form.form.getValues(), 'voice-a'); });
  serverUrl = 'http://server-b';
  serverRevision++;
  await act(async () => { release({ models: [] }); await submission; });
  expect(requests).toHaveLength(0);
  expect(pendingIds).toEqual([]);
  expect(form.form.getValues('text')).toBe('Keep this draft');
  expect(toasts.at(-1)?.title).toBe('Server changed');
});

test('late generation acceptance from a previous server preserves the draft and is not tracked on the new server', async () => {
  let release!: (value: { id: string }) => void;
  generationResult = new Promise((resolve) => { release = resolve; });
  mount();
  act(() => form.form.setValue('text', 'Keep this draft'));
  let submission!: Promise<void>;
  await act(async () => { submission = form.handleSubmit(form.form.getValues(), 'voice-a'); await Promise.resolve(); });
  expect(requests).toHaveLength(1);
  serverUrl = 'http://server-b';
  serverRevision++;
  await act(async () => { release({ id: 'old-generation' }); await submission; });
  expect(pendingIds).toEqual([]);
  expect(form.form.getValues('text')).toBe('Keep this draft');
  expect(toasts.at(-1)?.title).toBe('Server changed');
});


test('switching away and back during model lookup does not resume the old submission', async () => {
  let release!: (value: { models: never[] }) => void;
  modelStatus = new Promise((resolve) => { release = resolve; });
  mount();
  act(() => form.form.setValue('text', 'Keep this draft'));
  let submission!: Promise<void>;
  act(() => { submission = form.handleSubmit(form.form.getValues(), 'voice-a'); });
  serverUrl = 'http://server-b'; serverRevision++;
  serverUrl = 'http://server-a'; serverRevision++;
  await act(async () => { release({ models: [] }); await submission; });
  expect(requests).toHaveLength(0);
  expect(form.form.getValues('text')).toBe('Keep this draft');
  expect(toasts.at(-1)?.description).toContain('not started');
});
