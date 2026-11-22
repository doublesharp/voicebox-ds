import { afterEach, expect, test } from 'bun:test';
import type { ReactNode } from 'react';
import { useSyncExternalStore } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { StudioClient } from '../src/features/studio/client';
import { StudioContext, type StudioContextValue } from '../src/features/studio/context';
import { PronunciationPanel } from '../src/features/studio/PronunciationPanel';
import { previewPronunciation, type PronunciationRule } from '../src/features/studio/pronunciation';
import { ProjectSession } from '../src/features/studio/session';
import type { StudioCommand, StudioProject } from '../src/features/studio/types';

let renderer: ReactTestRenderer;
let session: ProjectSession;
afterEach(() => {
  act(() => renderer?.unmount());
  session?.dispose();
});
const rule = (extra: Partial<PronunciationRule> = {}): PronunciationRule => ({
  id: 'api',
  source: 'API',
  replacement: 'A P I',
  profile_id: null,
  case_sensitive: false,
  whole_word: true,
  ...extra,
});
function text(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return Array.isArray(node) ? node.map(text).join('') : '';
}
function button(label: string) {
  const node = renderer.root
    .findAllByType('button')
    .find((node) => text(node.props.children) === label);
  expect(node).toBeDefined();
  return node!;
}
function project(): StudioProject {
  return {
    id: 'p',
    name: 'Pronunciation',
    revision: 0,
    client_label: null,
    created_at: '',
    updated_at: '',
    document: {
      schema_version: 1,
      sample_rate: 48000,
      channels: 2,
      language: 'en',
      pronunciation_rules: [rule()],
      passages: [
        {
          id: 'line',
          text: 'Call API.',
          language: 'en',
          profile_id: 'voice',
          voice_snapshot: {
            engine: 'test',
            voice_type: 'preset',
            preset_engine: 'test',
            preset_voice_id: 'voice',
          },
          direction: { instruct: '', seed: null, max_chunk_chars: 300, crossfade_ms: 0 },
          input_revision: 0,
          selection_token: 0,
          selected_take_id: 'original',
          locked: false,
        },
      ],
      tracks: [],
      clips: [],
      mix: { normalize: false, target_lufs: -16, max_true_peak_dbtp: -1 },
    },
    takes: [],
    assets: [],
    jobs: [],
    revisions: [],
    approvals: [],
    deliverables: [],
  };
}
async function mount(options: { failGeneration?: boolean; failSave?: boolean } = {}) {
  let current = project();
  const commands: StudioCommand[] = [];
  const generations: Array<Record<string, unknown>> = [];
  const memory = new Map<string, string>();
  let failGeneration = !!options.failGeneration;
  const client = new StudioClient('http://test', (async (url, init) => {
    if (String(url).endsWith('/commands')) {
      const command = JSON.parse(String(init?.body)) as StudioCommand;
      commands.push(command);
      if (options.failSave) return Response.json({ detail: 'Disk unavailable' }, { status: 503 });
      current = structuredClone(current);
      current.revision++;
      current.document.pronunciation_rules = command.payload.rules as PronunciationRule[];
      return Response.json(current);
    }
    if (String(url).endsWith('/generation-jobs')) {
      generations.push(JSON.parse(String(init?.body)));
      if (failGeneration) throw new Error('Response lost');
      return Response.json({ jobs: [] });
    }
    return Response.json(current);
  }) as typeof fetch);
  const storage = {
    get length() {
      return memory.size;
    },
    key: (index: number) => [...memory.keys()][index] ?? null,
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memory.set(key, value);
    },
    removeItem: (key: string) => {
      memory.delete(key);
    },
  };
  session = new ProjectSession(client, 'p', storage);
  await session.load();
  function Harness({ show = true }: { show?: boolean }) {
    const save = useSyncExternalStore(session.subscribe, session.getSnapshot);
    const context = {
      client,
      project: save.project!,
      session,
      save,
      canMutate: ['saved', 'dirty'].includes(save.status),
      actionBusy: false,
      profiles: [{ id: 'voice', name: 'Narrator', language: 'en', default_engine: 'test' }],
      engines: [
        {
          id: 'test',
          name: 'Test',
          ready: true,
          languages: ['en'],
          supports_instruct: false,
          supports_seed: false,
          expressive_tags: [],
          commercial_use: 'allowed',
        },
      ],
      runAction: async (action: () => Promise<unknown>) => {
        try {
          await action();
        } catch {
          /* UI shows durable error. */
        }
      },
    } as unknown as StudioContextValue;
    return (
      <StudioContext.Provider value={context}>
        {show && (
          <PronunciationPanel
            passage={save.project!.document.passages[0]}
            currentText="Call API."
          />
        )}
      </StudioContext.Provider>
    );
  }
  await act(async () => {
    renderer = create(<Harness />);
  });
  return {
    commands,
    generations,
    memory,
    show: (show: boolean) => renderer.update(<Harness show={show} />),
    allowGeneration: () => {
      failGeneration = false;
    },
    remoteRules: () => {
      current = structuredClone(current);
      current.revision++;
      current.document.pronunciation_rules = [rule({ replacement: 'remote alias' })];
    },
  };
}

test('preview applies scoped aliases once, chooses longest phrases, and respects word boundaries', () => {
  const rules = [
    rule(),
    rule({ id: 'long', source: 'API key', replacement: 'access key' }),
    rule({ id: 'recursive', source: 'A P I', replacement: 'wrong' }),
    rule({ id: 'voice-rule', replacement: 'voice alias', profile_id: 'voice' }),
  ];
  expect(previewPronunciation('API key, API, APIs, api.', rules, null).text).toBe(
    'access key, A P I, APIs, A P I.',
  );
  expect(previewPronunciation('API key, API.', rules, 'voice').text).toBe(
    'access key, voice alias.',
  );
  expect(
    previewPronunciation(
      'C++ and élan',
      [
        rule({ source: 'C++', replacement: 'C plus plus' }),
        rule({ source: 'élan', replacement: 'ay lan' }),
      ],
      null,
    ).text,
  ).toBe('C plus plus and ay lan');
});
test('dictionary draft previews substitutions, survives panel remount, and saves through revisioned commands', async () => {
  const result = await mount();
  expect(renderer.root.findByProps({ 'aria-label': 'Spoken text preview' }).props.children).toBe(
    'Call A P I.',
  );
  act(() =>
    renderer.root
      .findByProps({ 'aria-label': 'Rule 1 spoken alias' })
      .props.onChange({ target: { value: 'application interface' } }),
  );
  expect(renderer.root.findByProps({ 'aria-label': 'Spoken text preview' }).props.children).toBe(
    'Call application interface.',
  );
  expect(button('Generate audio preview').props.disabled).toBe(true);
  expect([...result.memory.values()].some((raw) => raw.includes('application interface'))).toBe(
    true,
  );
  act(() => result.show(false));
  act(() => result.show(true));
  expect(renderer.root.findByProps({ 'aria-label': 'Rule 1 spoken alias' }).props.value).toBe(
    'application interface',
  );
  await act(async () => {
    await button('Save dictionary').props.onClick();
  });
  expect(result.commands[0]).toMatchObject({
    expected_revision: 0,
    type: 'set_pronunciation_rules',
    payload: { rules: [rule({ replacement: 'application interface' })] },
  });
  expect(session.getSnapshot().project!.document.passages[0].selected_take_id).toBe('original');
  expect(button('Save dictionary').props.disabled).toBe(true);
});
test('audition is an alternative take and uncertain responses retry the same persisted identity', async () => {
  const result = await mount({ failGeneration: true });
  expect(button('Generate audio preview').props.disabled).toBe(false);
  await act(async () => {
    await button('Generate audio preview').props.onClick();
  });
  expect(result.generations[0]).toMatchObject({ passage_ids: ['line'], count: 1, adopt: false });
  expect(JSON.stringify(renderer.toJSON())).toContain('Response lost');
  act(() => result.show(false));
  act(() => result.show(true));
  result.allowGeneration();
  await act(async () => {
    await button('Retry audio preview').props.onClick();
  });
  expect(result.generations[1]).toEqual(result.generations[0]);
  expect(result.commands).toHaveLength(0);
  expect(session.getSnapshot().project!.document.passages[0].selected_take_id).toBe('original');
});
test('failed dictionary save preserves the local draft and recovery command', async () => {
  const result = await mount({ failSave: true });
  act(() =>
    renderer.root
      .findByProps({ 'aria-label': 'Rule 1 spoken alias' })
      .props.onChange({ target: { value: 'keep this alias' } }),
  );
  await act(async () => {
    await button('Save dictionary').props.onClick();
  });
  expect(session.getSnapshot().status).toBe('error');
  expect(session.recoveryCopy()).toContain('keep this alias');
  expect([...result.memory.values()].some((raw) => raw.includes('keep this alias'))).toBe(true);
});

test('a newer saved dictionary cannot silently rebase a local dictionary draft', async () => {
  const result = await mount();
  act(() =>
    renderer.root
      .findByProps({ 'aria-label': 'Rule 1 spoken alias' })
      .props.onChange({ target: { value: 'local alias' } }),
  );
  result.remoteRules();
  await act(async () => {
    await session.refresh();
  });
  expect(button('Save dictionary').props.disabled).toBe(true);
  expect(JSON.stringify(renderer.toJSON())).toContain('Saved rules changed');
  expect(renderer.root.findByProps({ 'aria-label': 'Rule 1 spoken alias' }).props.value).toBe(
    'local alias',
  );
  expect(result.commands).toHaveLength(0);
});

test('an unreadable recovered dictionary is retained until explicit discard', async () => {
  const result = await mount();
  const key = 'voicebox-studio:pronunciation:http%3A%2F%2Ftest:p';
  const raw = JSON.stringify({ base: '[]', rules: [{ bad: 'Retain this raw draft' }] });
  result.memory.set(key, raw);
  act(() => result.show(false));
  act(() => result.show(true));
  expect(button('Add pronunciation rule').props.disabled).toBe(true);
  expect(JSON.stringify(renderer.toJSON())).toContain('Cannot recover the dictionary draft');
  expect(result.memory.get(key)).toBe(raw);
  act(() => button('Discard dictionary draft').props.onClick());
  expect(result.memory.has(key)).toBe(false);
  expect(button('Add pronunciation rule').props.disabled).toBe(false);
});
