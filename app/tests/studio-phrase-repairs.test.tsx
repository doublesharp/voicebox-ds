import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { StudioContext, type StudioContextValue } from '../src/features/studio/context';
import { PhraseRepairPanel } from '../src/features/studio/PhraseRepairPanel';

let renderer: ReactTestRenderer;
afterEach(() => act(() => renderer?.unmount()));
function text(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(text).join('');
  return '';
}
function button(label: string) {
  return renderer.root.findAllByType('button').find((node) => text(node.props.children) === label)!;
}
async function mount(withSpeechReview = false, takeIds = ['base', 'donor']) {
  const commands: Array<{ type: string; payload: unknown }> = [];
  const generations: unknown[] = [];
  const auditions: unknown[][] = [];
  const storage = new Map<string, string>();
  const passage = {
    id: 'line',
    text: 'Hello Ada',
    language: 'en',
    selected_take_id: 'base',
    locked: false,
    voice_snapshot: { engine: 'test' },
  };
  const context = {
    project: {
      id: 'p',
      document: {
        sample_rate: 48000,
        passages: [passage],
        speech_reviews: withSpeechReview
          ? [
              {
                source: {
                  asset_hash: 'a'.repeat(64),
                  take_text: 'base',
                  take_engine: 'fixture',
                  take_model: null,
                  script_text: 'Hello Ada',
                  language: 'en',
                },
                recognized_text: 'Hello Eva',
                words: [],
                recognizer: { backend: 'fixture', model_size: 'base' },
                differences: [
                  {
                    kind: 'substitution',
                    expected: 'Ada',
                    recognized: 'Eva',
                    expected_start: 1,
                    audition: { start: 0.2, end: 0.6 },
                  },
                ],
              },
            ]
          : [],
      },
      takes: takeIds.map((id) => ({
        id,
        passage_id: 'line',
        asset_id: id,
        text: id,
        engine: 'fixture',
        model_size: null,
      })),
      assets: ['base', 'donor'].map((id) => ({
        id,
        frames: 48000,
        sample_rate: 48000,
        hash: 'a'.repeat(64),
      })),
    },
    client: {
      baseUrl: 'http://test',
      assetAudio: (id: string) => `/${id}`,
      generate: async (_id: string, body: unknown) => {
        generations.push(body);
      },
    },
    session: {
      storage: {
        get length() {
          return storage.size;
        },
        key: (index: number) => [...storage.keys()][index] ?? null,
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
      flush: async () => {},
      getSnapshot: () => ({ status: 'saved' }),
      command: async (type: string, payload: unknown) => {
        commands.push({ type, payload });
        return true;
      },
    },
    playback: {
      audition: async (...args: unknown[]) => {
        auditions.push(args);
      },
    },
    canMutate: true,
    actionBusy: false,
    runAction: async (action: () => Promise<unknown>) => {
      await action();
    },
  } as unknown as StudioContextValue;
  await act(async () => {
    renderer = create(
      <StudioContext.Provider value={context}>
        <PhraseRepairPanel passage={passage as never} currentText="Hello Ada" />
      </StudioContext.Provider>,
    );
  });
  const edit = (label: string, value: string) =>
    act(() =>
      renderer.root.findByProps({ 'aria-label': label }).props.onChange({ target: { value } }),
    );
  return { commands, generations, auditions, edit };
}

test('phrase repair is hidden until a take exists', async () => {
  await mount(false, []);
  expect(renderer.toJSON()).toBeNull();
});

test('repair uses source ranges in working samples and publishes an alternative without selecting it', async () => {
  const result = await mount();
  result.edit('Replace from seconds', '0.25');
  result.edit('Replace through seconds', '0.75');
  result.edit('Replacement take', 'donor');
  result.edit('Replacement end seconds', '0.5');
  result.edit('Phrase crossfade milliseconds', '10');
  await act(async () => {
    await button('Create composed alternative').props.onClick();
  });
  expect(result.commands).toEqual([
    {
      type: 'compose_take',
      payload: {
        passage_id: 'line',
        text: 'Hello Ada',
        crossfade_samples: 480,
        segments: [
          { take_id: 'base', start_sample: 0, end_sample: 12000 },
          { take_id: 'donor', start_sample: 0, end_sample: 24000 },
          { take_id: 'base', start_sample: 36000, end_sample: 48000 },
        ],
      },
    },
  ]);
  await act(async () => {
    await button('Play replacement').props.onClick();
  });
  expect(result.auditions[0]).toEqual([
    '/donor',
    'Replacement · Take 2',
    1,
    { start: 0, end: 0.5 },
  ]);
});

test('replacement generation freezes phrase text and leaves the full take selected', async () => {
  const result = await mount();
  result.edit('Replacement phrase text', 'Ay-duh');
  await act(async () => {
    await button('Generate replacement phrase').props.onClick();
  });
  expect(result.generations).toHaveLength(1);
  expect(result.generations[0]).toMatchObject({
    passage_ids: ['line'],
    phrase_text: 'Ay-duh',
    count: 1,
    adopt: false,
  });
  expect(result.commands).toHaveLength(0);
});

test('comping retains the explicit order of phrases and rejects an empty source list', async () => {
  const result = await mount();
  result.edit('Phrase edit mode', 'comp');
  await act(async () => {
    await button('Create composed alternative').props.onClick();
  });
  expect(result.commands).toHaveLength(0);
  expect(JSON.stringify(renderer.toJSON())).toContain('Add at least one source phrase');
  act(() => button('Add source phrase').props.onClick());
  result.edit('Phrase 1 take', 'donor');
  result.edit('Phrase 1 end seconds', '0.5');
  act(() => button('Add source phrase').props.onClick());
  result.edit('Phrase 2 start seconds', '0.5');
  act(() => button('Move phrase 2 up').props.onClick());
  await act(async () => {
    await button('Create composed alternative').props.onClick();
  });
  expect(result.commands[0]).toMatchObject({
    payload: {
      segments: [
        { take_id: 'base', start_sample: 24000, end_sample: 48000 },
        { take_id: 'donor', start_sample: 0, end_sample: 24000 },
      ],
    },
  });
});

test('an advisory substitution prepares editable phrase fields without generating, composing or adopting', async () => {
  const value = await mount(true);
  act(() => button('Prepare replacement phrase').props.onClick());
  expect(renderer.root.findByProps({ 'aria-label': 'Replacement phrase text' }).props.value).toBe(
    'Ada',
  );
  expect(renderer.root.findByProps({ 'aria-label': 'Replace from seconds' }).props.value).toBe(
    '0.2',
  );
  expect(renderer.root.findByProps({ 'aria-label': 'Replace through seconds' }).props.value).toBe(
    '0.6',
  );
  expect(value.commands).toEqual([]);
  expect(value.generations).toEqual([]);
});
