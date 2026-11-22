import { afterEach, describe, expect, test } from 'bun:test';
import {
  isValidElement,
  type ReactElement,
  type ReactNode,
  useState,
  useSyncExternalStore,
} from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { DialogContent } from '../src/components/ui/dialog';
import { StudioClient } from '../src/features/studio/client';
import { StudioContext, type StudioContextValue, useStudio } from '../src/features/studio/context';
import { Deliver } from '../src/features/studio/Deliver';
import { Director as StudioDirector } from '../src/features/studio/Director';
import type { StudioPlayback } from '../src/features/studio/playback';
import { Review } from '../src/features/studio/Review';
import {
  type CheckpointReview,
  ReviewClient,
  type ReviewResponse,
} from '../src/features/studio/review-client';
import { ReviewSessions } from '../src/features/studio/review-session';
import { ScriptEditor } from '../src/features/studio/ScriptEditor';
import { ProjectSession } from '../src/features/studio/session';
import { useDurableSubmission } from '../src/features/studio/submissions';
import { Timeline } from '../src/features/studio/Timeline';
import type { StudioCommand, StudioEngine, StudioProject } from '../src/features/studio/types';
import { PlatformProvider } from '../src/platform/PlatformContext';
import type { Platform } from '../src/platform/types';

let renderer: ReactTestRenderer;
function Director() {
  const { session, client, project } = useStudio();
  const submission = useDurableSubmission(
    session.storage,
    client.baseUrl,
    project.id,
    'generation',
  );
  return <StudioDirector submission={submission} />;
}
const sessions: Array<{ dispose(): void }> = [];
afterEach(() => {
  act(() => renderer?.unmount());
  for (const session of sessions.splice(0)) session.dispose();
});
function fixture(): StudioProject {
  const passage = {
    id: 'line',
    text: 'A performance worth keeping.',
    language: 'en',
    profile_id: 'voice',
    voice_snapshot: { name: 'Narrator', default_engine: 'engine' },
    direction: { instruct: '', seed: null, max_chunk_chars: 500, crossfade_ms: 0 },
    input_revision: 1,
    selection_token: 1,
    selected_take_id: 'take-a',
    locked: false,
  };
  const document = {
    schema_version: 1 as const,
    sample_rate: 48000 as const,
    channels: 2 as const,
    language: 'en',
    passages: [passage],
    tracks: [
      {
        id: 'voice-track',
        name: 'Narration',
        kind: 'voice' as const,
        gain: 1,
        mute: false,
        solo: false,
      },
    ],
    clips: [
      {
        id: 'clip',
        passage_id: 'line',
        take_id: 'take-a',
        asset_id: 'asset-a',
        track_id: 'voice-track',
        start_sample: 0,
        trim_start_sample: 0,
        trim_end_sample: 0,
        gain: 1,
        fade_in_samples: 0,
        fade_out_samples: 0,
      },
    ],
    mix: { normalize: false, target_lufs: -16, max_true_peak_dbtp: -1 },
  };
  return {
    id: 'project',
    name: 'Narration',
    client_label: 'Client',
    revision: 2,
    created_at: '2026-10-28',
    updated_at: '2026-10-28',
    document,
    takes: ['a', 'b'].map((id) => ({
      id: `take-${id}`,
      passage_id: 'line',
      asset_id: `asset-${id}`,
      text: passage.text,
      engine: 'engine',
      model_size: null,
      created_at: '',
      request: { text: passage.text },
    })),
    assets: ['a', 'b'].map((id) => ({
      id: `asset-${id}`,
      hash: 'hash',
      sample_rate: 48000,
      channels: 1,
      frames: 96000,
      duration: 2,
      size_bytes: 10,
    })),
    jobs: [],
    revisions: [
      {
        id: 'checkpoint',
        name: 'Approved script',
        created_at: '2026-10-28',
        project_revision: 1,
        document: structuredClone(document),
      },
    ],
    approvals: [],
    deliverables: [],
  };
}
const engine: StudioEngine = {
  id: 'engine',
  name: 'Actual engine',
  languages: ['en'],
  supports_instruct: false,
  supports_seed: false,
  expressive_tags: [],
  recognized_tags: ['[laugh]', '[cough]', '[whisper]'],
  ready: true,
  commercial_use: 'unknown',
};
async function mount(
  component: ReactNode,
  options: {
    project?: StudioProject;
    engines?: StudioEngine[];
    conflict?: boolean;
    failGenerate?: boolean;
    failRender?: boolean;
    failReviewSave?: boolean;
    store?: Map<string, string>;
  } = {},
) {
  let current = options.project ?? fixture();
  const commands: StudioCommand[] = [];
  const approvals: unknown[] = [];
  const generations: unknown[] = [];
  const renders: unknown[] = [];
  const auditions: string[] = [];
  const savedReviews = new Map<string, CheckpointReview>();
  const reviewOperations = new Map<string, ReviewResponse>();
  const reviewRequests: unknown[] = [];
  const fetcher = (async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (String(url).includes('/reviews/')) {
      const revision = String(url).split('/reviews/')[1].split('/')[0];
      const review = savedReviews.get(revision) ?? {
        revision_id: revision,
        version: 0,
        note: '',
        checklist: [],
        updated_at: null,
      };
      if (!body) return Response.json({ review });
      reviewRequests.push(body);
      const prior = reviewOperations.get(body.operation_id);
      if (prior) return Response.json(prior);
      if (body.expected_version !== review.version)
        return Response.json(
          { detail: { message: 'Review changed', current_revision: review.version } },
          { status: 409 },
        );
      if (String(url).endsWith('/approvals')) {
        const note = [
          review.note,
          `Local review snapshot · version ${review.version}`,
          ...review.checklist.map((i) => `[${i.checked ? 'x' : ' '}] ${i.label}`),
        ].join('\n');
        approvals.push({ ...body, revision_id: revision, note });
        current = {
          ...current,
          approvals: [
            ...current.approvals,
            { id: body.operation_id, revision_id: revision, note, created_at: '2026-10-28' },
          ],
        };
        const result = { review, project: current };
        reviewOperations.set(body.operation_id, structuredClone(result));
        return Response.json(result);
      }
      const saved = {
        revision_id: revision,
        version: body.expected_version + 1,
        note: body.note,
        checklist: body.checklist,
        updated_at: '2026-10-28',
      };
      savedReviews.set(revision, saved);
      const result = { review: saved };
      reviewOperations.set(body.operation_id, structuredClone(result));
      if (options.failReviewSave && reviewRequests.length === 1)
        throw new Error('Review response lost');
      return Response.json(result);
    }
    if (String(url).endsWith('/commands')) {
      commands.push(body);
      if (options.conflict)
        return Response.json(
          { detail: { message: 'Another window saved', current_revision: 4 } },
          { status: 409 },
        );
      current = structuredClone(current);
      current.revision++;
      if (body.type === 'update_passage') Object.assign(current.document.passages[0], body.payload);
      return Response.json(current);
    }
    if (String(url).endsWith('/approvals')) {
      approvals.push(body);
      return Response.json(current);
    }
    if (String(url).endsWith('/generation-jobs')) {
      generations.push(body);
      if (options.failGenerate && generations.length === 1) throw new Error('Uncertain response');
      return Response.json({ jobs: [] });
    }
    if (String(url).endsWith('/render-jobs')) {
      renders.push(body);
      if (options.failRender && renders.length === 1) throw new Error('Render response lost');
      return Response.json({ job: {} });
    }
    return Response.json(current);
  }) as typeof fetch;
  const client = new StudioClient('http://test', fetcher);
  const store = options.store ?? new Map<string, string>();
  const storage = {
    get length() {
      return store.size;
    },
    key: (index: number) => [...store.keys()][index] ?? null,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
  const session = new ProjectSession(client, 'project', storage);
  const reviewSessions = new ReviewSessions(
    new ReviewClient('http://test', fetcher),
    'project',
    storage,
  );
  sessions.push(reviewSessions);
  sessions.push(session);
  await session.load();
  function Harness() {
    const save = useSyncExternalStore(session.subscribe, session.getSnapshot);
    const [revisionId, setRevisionId] = useState('checkpoint');
    const [checkedPassages, setCheckedPassages] = useState<string[]>([]);
    const context: StudioContextValue = {
      client,
      reviewSessions,
      project: save.project!,
      save,
      session,
      profiles: [
        {
          id: 'voice',
          name: 'Narrator',
          default_engine: 'engine',
          language: 'en',
          voice_type: 'preset',
        },
      ],
      engines: options.engines ?? [engine],
      capabilitiesError: null,
      playback: {
        subscribe: () => () => {},
        getSnapshot: () => ({ mode: 'idle' }),
        audition: async (url: string) => {
          auditions.push(url);
        },
      } as unknown as StudioPlayback,
      selectedPassageId: 'line',
      selectedClipId: 'clip',
      checkedPassages,
      setCheckedPassages,
      selectPassage: () => {},
      selectClip: () => {},
      playhead: 0.75,
      setPlayhead: () => {},
      revisionId,
      setRevisionId,
      actionBusy: false,
      actionError: null,
      runAction: async (action) => {
        try {
          await action();
        } catch {
          /* Production shell presents this error. */
        }
      },
      canMutate: ['saved', 'dirty'].includes(save.status),
    };
    return (
      <PlatformProvider platform={{ filesystem: {} } as Platform}>
        <StudioContext.Provider value={context}>{component}</StudioContext.Provider>
      </PlatformProvider>
    );
  }
  await act(async () => {
    renderer = create(<Harness />);
  });
  return {
    session,
    commands,
    approvals,
    generations,
    renders,
    auditions,
    reviewSessions,
    reviewRequests,
  };
}
function button(text: string) {
  const found = renderer.root
    .findAllByType('button')
    .find((node) => textContent(node.props.children) === text);
  expect(found).toBeDefined();
  return found!;
}
function textContent(value: ReactNode): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(textContent).join('');
  return '';
}

describe('connected studio controls', () => {
  test('script input remains visible and recoverable after a revision conflict', async () => {
    const { session, commands } = await mount(<ScriptEditor />, { conflict: true });
    act(() =>
      renderer.root
        .findByType('textarea')
        .props.onChange({ target: { value: 'My words stay here.' } }),
    );
    await act(async () => {
      await session.flush();
    });
    expect(renderer.root.findByType('textarea').props.value).toBe('My words stay here.');
    expect(session.getSnapshot().status).toBe('conflict');
    expect(commands[0].expected_revision).toBe(2);
    expect(session.recoveryCopy()).toContain('My words stay here.');
  });
  test('unsupported direction and seed controls stay absent and engine terms stay visible', async () => {
    await mount(<Director />);
    expect(renderer.root.findAllByProps({ 'aria-label': 'Delivery direction' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'aria-label': 'Seed' })).toHaveLength(0);
    expect(JSON.stringify(renderer.toJSON())).toContain('Commercial use: ');
    expect(JSON.stringify(renderer.toJSON())).toContain('unknown');
  });
  test('take audition uses immutable source and selecting a take preserves explicit timeline replacement intent', async () => {
    const { auditions, commands } = await mount(<Director />);
    await act(async () => {
      await button(' Audition').props.onClick();
    });
    expect(auditions[0]).toBe('http://test/studio/v1/assets/asset-b/audio');
    const replace = renderer.root
      .findAllByType('input')
      .find(
        (node) =>
          node.props.type === 'checkbox' &&
          node.parent?.props.className === 'studio-check' &&
          textContent(node.parent.props.children).includes('Replace linked'),
      );
    expect(replace).toBeDefined();
    act(() => replace!.props.onChange({ target: { checked: true } }));
    await act(async () => {
      await button('Use take').props.onClick();
    });
    expect(commands[0].type).toBe('select_take');
    expect(commands[0].payload).toEqual({
      passage_id: 'line',
      take_id: 'take-b',
      replace_clips: true,
    });
  });
  test('generation retry preserves the original bounded alternative/adoption request', async () => {
    const { generations } = await mount(<Director />, { failGenerate: true });
    act(() =>
      renderer.root
        .findAllByType('select')
        .find((node) => node.props['aria-label'] === 'Alternatives per passage')!
        .props.onChange({ target: { value: '3' } }),
    );
    await act(async () => {
      await button('Generate alternatives').props.onClick();
    });
    await act(async () => {
      await button('Retry take request').props.onClick();
    });
    expect(generations).toHaveLength(2);
    expect(generations[0]).toEqual(generations[1]);
    expect(generations[0]).toMatchObject({ count: 3, adopt: false, passage_ids: ['line'] });
  });
  test('the first take can be generated and an uncertain response can be retried in place', async () => {
    const project = fixture();
    project.takes = [];
    project.document.passages[0].selected_take_id = null;
    project.document.clips = [];
    const { generations } = await mount(<Director />, { project, failGenerate: true });
    await act(async () => {
      await button('Generate take').props.onClick();
    });
    expect(JSON.stringify(renderer.toJSON())).toContain('Could not confirm the take request');
    await act(async () => {
      await button('Retry take request').props.onClick();
    });
    expect(generations).toHaveLength(2);
    expect(generations[1]).toEqual(generations[0]);
  });
  test('numeric placement, split and append send undoable project-sample commands', async () => {
    const { commands } = await mount(<Timeline />);
    const start = renderer.root
      .findAllByType('input')
      .find((node) => node.props['aria-label'] === 'Start (s)')!;
    await act(async () => {
      start.props.onBlur({ currentTarget: { valueAsNumber: 1.125 } });
    });
    await act(async () => {
      await button(' Split at playhead').props.onClick();
    });
    await act(async () => {
      await button('Append').props.onClick();
    });
    expect(commands.map((command) => [command.type, command.payload])).toEqual([
      ['update_clip', { clip_id: 'clip', start_sample: 54000 }],
      ['split_clip', { clip_id: 'clip', at_sample: 36000 }],
      ['insert_passages', { passage_ids: ['line'], gap_ms: 200 }],
    ]);
  });
  test('review notes stay with their checkpoint when switching revisions', async () => {
    const project = fixture();
    project.revisions.push({
      ...structuredClone(project.revisions[0]),
      id: 'second',
      name: 'Second',
    });
    await mount(<Review />, { project });
    act(() =>
      renderer.root.findByType('textarea').props.onChange({ target: { value: 'First only' } }),
    );
    await act(async () => {
      renderer.root.findByType('select').props.onChange({ target: { value: 'second' } });
    });
    expect(renderer.root.findByType('textarea').props.value).toBe('');
    await act(async () => {
      renderer.root.findByType('select').props.onChange({ target: { value: 'checkpoint' } });
    });
    expect(renderer.root.findByType('textarea').props.value).toBe('First only');
  });
  test('review text and approval stay bound to the selected immutable checkpoint', async () => {
    const project = fixture();
    project.document.passages[0].text = 'A later draft has different words.';
    const { approvals } = await mount(<Review />, { project });
    const content = JSON.stringify(renderer.toJSON());
    expect(content).toContain('A performance worth keeping.');
    expect(content).not.toContain('A later draft has different words.');
    act(() =>
      renderer.root.findByType('textarea').props.onChange({ target: { value: 'Pacing checked' } }),
    );
    await act(async () => {
      await button(' Approve this checkpoint locally').props.onClick();
    });
    expect(approvals[0]).toMatchObject({ revision_id: 'checkpoint' });
    expect((approvals[0] as { note: string }).note).toContain(
      'Pacing checked\nLocal review snapshot',
    );
  });
});

test('unsupported stage tags block generation with an explicit wording resolution', async () => {
  const project = fixture();
  project.document.passages[0].text = '[whisper] Private words';
  const { generations } = await mount(<Director />, { project });
  expect(button('Generate alternatives').props.disabled).toBe(true);
  expect(JSON.stringify(renderer.toJSON())).toContain('Unsupported stage tags: ');
  expect(generations).toHaveLength(0);
});

test('inactive direction and seed remain saved without blocking a supported generation', async () => {
  const project = fixture();
  project.document.passages[0].direction = {
    instruct: 'Warm',
    seed: 42,
    max_chunk_chars: 500,
    crossfade_ms: 0,
  };
  const { generations, session } = await mount(<Director />, { project });
  expect(button('Generate alternatives').props.disabled).toBe(false);
  await act(async () => {
    await button('Generate alternatives').props.onClick();
  });
  expect(generations).toHaveLength(1);
  expect(session.getSnapshot().project?.document.passages[0].direction.instruct).toBe('Warm');
  expect(session.getSnapshot().project?.document.passages[0].direction.seed).toBe(42);
});

test('ordinary bracketed prose is not treated as an unsupported expressive tag', async () => {
  const project = fixture();
  project.document.passages[0].text = 'Continue with [chapter two].';
  await mount(<Director />, { project });
  expect(button('Generate alternatives').props.disabled).toBe(false);
  expect(JSON.stringify(renderer.toJSON())).not.toContain('Unsupported stage tags: ');
});

test('commercial-only mode excludes unresolved models before generation', async () => {
  const { generations } = await mount(<Director />);
  act(() =>
    renderer.root
      .findByProps({ 'aria-label': 'Commercial-use models only' })
      .props.onChange({ target: { checked: true } }),
  );
  expect(button('Generate alternatives').props.disabled).toBe(true);
  expect(JSON.stringify(renderer.toJSON())).toContain('No eligible models are currently reported');
  expect(generations).toHaveLength(0);
});

test('commercial policy survives an uncertain request and component restart', async () => {
  const store = new Map<string, string>();
  const available = { ...engine, commercial_use: 'allowed' as const };
  const first = await mount(<Director />, { store, engines: [available], failGenerate: true });
  act(() =>
    renderer.root
      .findByProps({ 'aria-label': 'Commercial-use models only' })
      .props.onChange({ target: { checked: true } }),
  );
  await act(async () => {
    await button('Generate alternatives').props.onClick();
  });
  expect(first.generations[0]).toMatchObject({ commercial_only: true });
  act(() => renderer.unmount());
  first.session.dispose();
  const reopened = await mount(<Director />, { store, engines: [available] });
  expect(
    renderer.root.findByProps({ 'aria-label': 'Commercial-use models only' }).props.checked,
  ).toBe(true);
  await act(async () => {
    await button('Retry take request').props.onClick();
  });
  expect(reopened.generations[0]).toEqual(first.generations[0]);
});

test('generation remount and restart replay the original identity and body before any new submission', async () => {
  const store = new Map<string, string>();
  const first = await mount(<Director />, { failGenerate: true, store });
  act(() =>
    renderer.root
      .findByProps({ 'aria-label': 'Alternatives per passage' })
      .props.onChange({ target: { value: '3' } }),
  );
  await act(async () => {
    await button('Generate alternatives').props.onClick();
  });
  act(() => renderer.unmount());
  first.session.dispose();
  const reopened = await mount(<Director />, { store });
  await act(async () => {
    await button('Retry take request').props.onClick();
  });
  expect(reopened.generations).toEqual(first.generations);
});

test('generation fails visibly before issuing a mutation when durable storage rejects writes', async () => {
  const store = new Map<string, string>();
  store.set = () => {
    throw new Error('Quota exceeded');
  };
  const { generations } = await mount(<Director />, { store });
  await act(async () => {
    await button('Generate alternatives').props.onClick();
  });
  expect(generations).toHaveLength(0);
  expect(JSON.stringify(renderer.toJSON())).toContain('persist');
});

test('model-size selection reassigns the compatible profile with the chosen registry variant', async () => {
  const p = fixture();
  p.document.passages[0].voice_snapshot = { engine: 'engine', model_size: 'small' };
  const { commands } = await mount(<Director />, {
    project: p,
    engines: [
      { ...engine, model_size: 'small' },
      { ...engine, model_size: 'large' },
    ],
  });
  const select = renderer.root
    .findAllByType('select')
    .find((node) => node.props['aria-label'] === 'Voice model size');
  expect(select).toBeDefined();
  await act(async () => {
    await select!.props.onChange({ target: { value: 'large' } });
  });
  expect(commands[0].payload).toEqual({
    passage_ids: ['line'],
    profile_id: 'voice',
    model_size: 'large',
  });
});

// Inspect the actual closed sheet's React elements; Radix portal/DOM behavior is outside this suite.
interface SheetProps {
  children: ReactNode;
  value: string;
  disabled: boolean;
  'aria-label'?: string;
  onClick: () => void | Promise<void>;
  onChange: (event: { target: { value?: string; checked?: boolean } }) => void;
}
function sheetElements(): ReactElement<SheetProps>[] {
  function visit(node: ReactNode): ReactElement<SheetProps>[] {
    if (Array.isArray(node)) return node.flatMap(visit);
    if (!isValidElement<SheetProps>(node)) return [];
    return [node, ...visit(node.props.children)];
  }
  return visit(renderer.root.findByType(DialogContent).props.children);
}
function sheetButton(label: string) {
  const item = sheetElements().find(
    (node) =>
      textContent(node.props.children) === label && typeof node.props.onClick === 'function',
  );
  expect(item).toBeDefined();
  return item!;
}
test('delivery offers Mix when the project has no clips or checkpoints', async () => {
  const project = fixture();
  project.revisions = [];
  project.document.clips = [];
  let wentToMix = false;
  await mount(
    <Deliver
      onGoToMix={() => {
        wentToMix = true;
      }}
    />,
    { project },
  );
  act(() => sheetButton('Go to Mix').props.onClick());
  act(() =>
    renderer.root.findByType(DialogContent).props.onCloseAutoFocus({ preventDefault() {} }),
  );
  expect(wentToMix).toBe(true);
});
test('render restart retains exact checkpoint, encoding and idempotency body', async () => {
  const store = new Map<string, string>();
  const project = fixture();
  project.revisions.push({
    ...project.revisions[0],
    id: 'original-source',
    name: 'Delivery source',
    document: structuredClone(project.revisions[0].document),
  });
  project.revisions[1].document.passages[0].text = 'Corrected words after the recording.';
  const first = await mount(<Deliver />, { store, failRender: true, project });
  const changeSelect = (current: string, next: string) =>
    act(() =>
      sheetElements()
        .find((node) => node.type === 'select' && node.props.value === current)!
        .props.onChange({ target: { value: next } }),
    );
  changeSelect('checkpoint', 'original-source');
  changeSelect('mix', 'stems');
  changeSelect('wav', 'mp3');
  act(() =>
    sheetElements()
      .find((node) => node.props['aria-label'] === 'Use earlier recording')!
      .props.onChange({ target: { checked: true } }),
  );
  await act(async () => {
    await sheetButton('Render processed stems').props.onClick();
  });
  act(() => renderer.unmount());
  first.session.dispose();
  const next = await mount(<Deliver />, { store });
  await act(async () => {
    await sheetButton('Retry same render request').props.onClick();
  });
  expect(next.renders).toEqual(first.renders);
  expect(next.renders[0]).toMatchObject({
    revision_id: 'original-source',
    kind: 'stems',
    format: 'mp3',
    allow_stale_audio: true,
  });
});
test('delivery stale consent is explicit, revision-bound and includes recorded versus script text', async () => {
  const p = fixture();
  p.revisions[0].document.passages[0].text = 'The corrected script.';
  p.revisions.push({ ...p.revisions[0], id: 'second', name: 'Another checkpoint' });
  const { renders } = await mount(<Deliver />, { project: p });
  expect(sheetButton('Render processed mix').props.disabled).toBe(true);
  expect(
    sheetElements()
      .map((node) => textContent(node.props.children))
      .join(' '),
  ).toContain('The corrected script.');
  const consent = sheetElements().find(
    (node) => node.props['aria-label'] === 'Use earlier recording',
  );
  expect(consent).toBeDefined();
  act(() => consent!.props.onChange({ target: { checked: true } }));
  expect(sheetButton('Render processed mix').props.disabled).toBe(false);
  const select = sheetElements().find(
    (node) => node.type === 'select' && node.props.value === 'checkpoint',
  )!;
  act(() => select.props.onChange({ target: { value: 'second' } }));
  expect(sheetButton('Render processed mix').props.disabled).toBe(true);
  expect(renders).toHaveLength(0);
  const secondConsent = sheetElements().find(
    (node) => node.props['aria-label'] === 'Use earlier recording',
  )!;
  act(() => secondConsent.props.onChange({ target: { checked: true } }));
  await act(async () => {
    await sheetButton('Render processed mix').props.onClick();
  });
  expect(renders[0]).toMatchObject({ revision_id: 'second', allow_stale_audio: true });
});

test('direction-only mismatch requires consent and structural errors remain blocking after consent', async () => {
  const project = fixture();
  project.takes[0].request = {
    passage: { input_revision: 1, direction: project.document.passages[0].direction },
  };
  project.revisions[0].document.passages[0].input_revision = 2;
  project.revisions[0].document.passages[0].direction.instruct = 'Different pacing';
  project.revisions[0].document.clips[0].track_id = 'missing';
  const { renders } = await mount(<Deliver />, { project });
  const checkbox = sheetElements().find(
    (node) => node.props['aria-label'] === 'Use earlier recording',
  );
  expect(checkbox).toBeDefined();
  act(() => checkbox!.props.onChange({ target: { checked: true } }));
  expect(sheetButton('Render processed mix').props.disabled).toBe(true);
  expect(renders).toHaveLength(0);
});

test('Director exposes independent orphan choices and recovers only the chosen snapshot', async () => {
  const store = new Map<string, string>();
  const prefix = 'voicebox-studio:recovery:http%3A%2F%2Ftest:project:session:';
  for (const id of ['first', 'second'])
    store.set(
      prefix + id,
      JSON.stringify({
        version: 1,
        project_id: 'project',
        base_revision: 2,
        drafts: { line: { text: `${id} orphan` } },
        queue: [],
      }),
    );
  const { session } = await mount(<Director />, { store });
  await act(async () => {
    await button('Recover local copy 2 · draft 2').props.onClick();
  });
  expect(session.getSnapshot().drafts.line.text).toBe('second orphan');
  expect(store.get(`${prefix}first`)).toContain('first orphan');
});

test('review save failure blocks approval, exact retry keeps newer typing and freezes the checked snapshot', async () => {
  const { reviewRequests, approvals } = await mount(<Review />, { failReviewSave: true });
  act(() => renderer.root.findByType('textarea').props.onChange({ target: { value: 'Original' } }));
  await act(async () => {
    await button('Save review').props.onClick();
  });
  expect(JSON.stringify(renderer.toJSON())).toContain('Review save failed');
  expect(button(' Approve this checkpoint locally').props.disabled).toBe(true);
  expect(approvals).toHaveLength(0);
  act(() => {
    renderer.root
      .findByType('textarea')
      .props.onChange({ target: { value: 'Newer checked note' } });
    renderer.root
      .findAllByType('input')
      .find((n) => n.props.type === 'checkbox')!
      .props.onChange({ target: { checked: true } });
  });
  await act(async () => {
    await button('Retry exact review request').props.onClick();
  });
  expect(reviewRequests[1]).toEqual(reviewRequests[0]);
  expect(renderer.root.findByType('textarea').props.value).toBe('Newer checked note');
  expect(JSON.stringify(renderer.toJSON())).toContain('Review saved');
  await act(async () => {
    await button(' Approve this checkpoint locally').props.onClick();
  });
  const note = (approvals[0] as { note: string }).note;
  expect(note).toContain('Newer checked note');
  expect(note).toContain('[x] Pronunciation and wording checked');
  expect(note).toContain('[ ] Pacing and timing checked');
  act(() =>
    renderer.root.findByType('textarea').props.onChange({ target: { value: 'After approval' } }),
  );
  await act(async () => {
    await button('Save review').props.onClick();
  });
  expect((approvals[0] as { note: string }).note).toBe(note);
});

test('Review reconnect exposes a durable note/checklist copy and recovers it before approval', async () => {
  const store = new Map<string, string>();
  const first = await mount(<Review />, { store });
  act(() => {
    renderer.root.findByType('textarea').props.onChange({ target: { value: 'Restart note' } });
    renderer.root
      .findAllByType('input')
      .find((n) => n.props.type === 'checkbox')!
      .props.onChange({ target: { checked: true } });
  });
  act(() => renderer.unmount());
  first.reviewSessions.dispose();
  first.session.dispose();
  const next = await mount(<Review />, { store });
  expect(JSON.stringify(renderer.toJSON())).toContain('Review recovery available');
  expect(button(' Approve this checkpoint locally').props.disabled).toBe(true);
  act(() => button('Recover review copy 1').props.onClick());
  expect(renderer.root.findByType('textarea').props.value).toBe('Restart note');
  expect(
    renderer.root.findAllByType('input').find((n) => n.props.type === 'checkbox')!.props.checked,
  ).toBe(true);
  await act(async () => {
    await button(' Approve this checkpoint locally').props.onClick();
  });
  expect((next.approvals[0] as { note: string }).note).toContain('Restart note');
});

test('Review presents exportable typing when local storage fails and never submits an approval', async () => {
  const store = new Map<string, string>();
  const { reviewRequests, approvals } = await mount(<Review />, { store });
  store.set = () => {
    throw new Error('Storage unavailable');
  };
  act(() =>
    renderer.root.findByType('textarea').props.onChange({ target: { value: 'Copy this note' } }),
  );
  await act(async () => {
    await button(' Approve this checkpoint locally').props.onClick();
  });
  expect(reviewRequests).toHaveLength(0);
  expect(approvals).toHaveLength(0);
  expect(JSON.stringify(renderer.toJSON())).toContain('Keep this project open');
  act(() => button('Show review recovery copy').props.onClick());
  expect(
    renderer.root.findAllByType('textarea').find((n) => n.props.readOnly)!.props.value,
  ).toContain('Copy this note');
});
