import { afterEach, expect, test } from 'bun:test';
import { useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import {
  type ArchiveScope,
  ArchiveScopeControls,
  archiveScopeQuery,
  completeArchiveScope,
} from '../src/features/studio/ArchiveScopeControls';
import { StudioClient } from '../src/features/studio/client';
import { StudioContext, type StudioContextValue } from '../src/features/studio/context';
import { Director } from '../src/features/studio/Director';
import type { StudioPlayback } from '../src/features/studio/playback';
import { ProjectSession } from '../src/features/studio/session';
import { useDurableSubmission } from '../src/features/studio/submissions';
import type { StudioEngine, StudioProject } from '../src/features/studio/types';

let renderer: ReactTestRenderer;
let session: ProjectSession | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  session?.dispose();
  session = undefined;
});

test('archive choices preserve explicit contents and explain playback versus regeneration', () => {
  let choice: ArchiveScope = completeArchiveScope;
  function Harness() {
    const [value, setValue] = useState(completeArchiveScope);
    choice = value;
    return <ArchiveScopeControls value={value} onChange={setValue} />;
  }
  act(() => {
    renderer = create(<Harness />);
  });
  expect(archiveScopeQuery(choice)).toBe('take_scope=all&include_regeneration_references=true');
  act(() => renderer.root.findByType('select').props.onChange({ target: { value: 'used' } }));
  act(() => renderer.root.findByType('input').props.onChange({ target: { checked: false } }));
  expect(archiveScopeQuery(choice)).toBe('take_scope=used&include_regeneration_references=false');
  expect(JSON.stringify(renderer.toJSON())).toContain('Included recordings will still play');
  expect(JSON.stringify(renderer.toJSON())).toContain(
    'Saved checkpoints, approvals and review notes stay included',
  );
  expect(JSON.stringify(renderer.toJSON())).toContain('undo');
});

async function mountDirector(missing: boolean) {
  const passage = {
    id: 'line',
    text: 'Words',
    language: 'en',
    profile_id: 'voice',
    voice_snapshot: {
      engine: 'engine',
      voice_type: 'cloned',
      samples: [{ asset_id: 'ref', reference_text: 'Voice' }],
    },
    direction: { instruct: '', seed: null, max_chunk_chars: 300, crossfade_ms: 0 },
    input_revision: 0,
    selection_token: 0,
    selected_take_id: null,
    locked: false,
  };
  const other = structuredClone(passage);
  other.id = 'other';
  if (missing) Object.assign(other.voice_snapshot, { unavailable_references: ['ref'] });
  const project: StudioProject = {
    id: 'project',
    name: 'Portable',
    revision: 0,
    client_label: null,
    created_at: '',
    updated_at: '',
    document: {
      schema_version: 1,
      sample_rate: 48000,
      channels: 2,
      language: 'en',
      passages: [passage, other],
      tracks: [],
      clips: [],
      mix: { normalize: false, target_lufs: -16, max_true_peak_dbtp: -1 },
    },
    assets: [],
    takes: [],
    jobs: [],
    revisions: [],
    approvals: [],
    deliverables: [],
  };
  const client = new StudioClient('http://test', (async () =>
    Response.json(project)) as typeof fetch);
  const entries = new Map<string, string>();
  session = new ProjectSession(client, project.id, {
    get length() {
      return entries.size;
    },
    key: (index) => [...entries.keys()][index] ?? null,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  });
  await session.load();
  const engine: StudioEngine = {
    id: 'engine',
    name: 'Engine',
    languages: ['en'],
    supports_instruct: false,
    supports_seed: false,
    expressive_tags: [],
    ready: true,
    commercial_use: 'unknown',
  };
  const value: StudioContextValue = {
    client,
    session,
    project,
    save: session.getSnapshot(),
    profiles: [
      {
        id: 'voice',
        name: 'Voice',
        language: 'en',
        voice_type: 'cloned',
        default_engine: 'engine',
      },
    ],
    engines: [engine],
    capabilitiesError: null,
    playback: { stop() {} } as unknown as StudioPlayback,
    selectedPassageId: 'line',
    selectedClipId: null,
    checkedPassages: ['line', 'other'],
    setCheckedPassages() {},
    selectPassage() {},
    selectClip() {},
    playhead: 0,
    setPlayhead() {},
    revisionId: '',
    setRevisionId() {},
    actionBusy: false,
    actionError: null,
    async runAction(action) {
      await action();
    },
    canMutate: true,
  };
  function Harness() {
    const submission = useDurableSubmission(
      value.session.storage,
      client.baseUrl,
      project.id,
      'generation',
    );
    return (
      <StudioContext.Provider value={value}>
        <Director submission={submission} />
      </StudioContext.Provider>
    );
  }
  await act(async () => {
    renderer = create(<Harness />);
  });
  return renderer.root.findAllByType('button').find((node) =>
    node.children
      .filter((child) => typeof child === 'string')
      .join('')
      .includes('Generate takes'),
  );
}

test('missing reference in a selected batch explains preserved recordings and blocks new generation', async () => {
  const generate = await mountDirector(true);
  expect(generate).toBeDefined();
  expect(generate!.props.disabled).toBe(true);
  expect(JSON.stringify(renderer.toJSON())).toContain('Existing recordings still play');
  expect(JSON.stringify(renderer.toJSON())).toContain('Reassign its voice');
});

test('normal reference snapshots remain eligible for generation', async () => {
  const generate = await mountDirector(false);
  expect(generate).toBeDefined();
  expect(generate!.props.disabled).toBe(false);
  expect(JSON.stringify(renderer.toJSON())).not.toContain('Existing recordings still play');
});
