import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useUIStore } from '../src/stores/uiStore';

const calls: Record<string, any[]> = {
  create: [],
  update: [],
  add: [],
  delete: [],
  effects: [],
  toast: [],
  avatar: [],
};
let fail = '',
  duration = 5,
  profile: any;
let durationHandler: (file: File) => Promise<number> = async () => duration;
let transcribeHandler: (arg: any) => Promise<{ text: string }> = async () => ({ text: 'transcribed' });
let addHandler: (arg: any) => Promise<void> = async () => {};
let createHandler: (arg: any) => Promise<any> = async () => ({ id: 'new' });
let updateHandler: (arg: any) => Promise<void> = async () => {};
let avatarHandler: (arg: any) => Promise<void> = async () => {};
let deleteHandler: (arg: any) => Promise<void> = async () => {};
let convertHandler: (file: File) => Promise<Blob> = async () => new Blob(['wav'], { type: 'audio/wav' });
let completeRecording: ((blob: Blob, duration: number) => void) | undefined;
let finishingRecording: (() => void) | undefined;
const cancelRecording = () => {
  finishingRecording = undefined;
};
const cancelSystemRecording = () => {};
const cleanupAudio = () => {};
const voices = [{ voice_id: 'v1', name: 'Voice One', gender: 'female', language: 'en' }];
const mutation = (key: string, result?: unknown) => ({
  isPending: false,
  mutateAsync: async (arg: unknown) => {
    const visible = arg && typeof arg === 'object' ? (() => {
      const { _serverScope, ...rest } = arg as Record<string, unknown>;
      return key === 'delete' ? rest.profileId : rest;
    })() : arg;
    calls[key].push(visible);
    if (fail === key) throw new Error(`${key} failed`);
    if (key === 'add') await addHandler(arg);
    if (key === 'create') return createHandler(arg);
    if (key === 'update') await updateHandler(arg);
    if (key === 'avatar') await avatarHandler(arg);
    if (key === 'delete') await deleteHandler(arg);
    return result;
  },
});
mock.module('../src/lib/hooks/useProfiles', () => ({
  useProfile: () => ({ data: profile }),
  useCreateProfile: () => mutation('create', { id: 'new' }),
  useUpdateProfile: () => mutation('update'),
  useAddSample: () => mutation('add'),
  useDeleteProfile: () => mutation('delete'),
  useUpdateProfileEffects: () => mutation('effects'),
  useUploadAvatar: () => mutation('avatar'),
  useDeleteAvatar: () => mutation('avatar'),
}));
mock.module('../src/lib/queryClient', () => ({ queryClient: {} }));
mock.module('@tanstack/react-query', () => ({ useQuery: () => ({ data: { voices } }) }));
mock.module('../src/lib/api/client', () => ({ apiClient: {} }));
mock.module('../src/lib/hooks/useAudioPlayer', () => ({
  useAudioPlayer: () => ({ isPlaying: false, playPause() {}, cleanup: cleanupAudio }),
}));
mock.module('../src/lib/hooks/useAudioRecording', () => ({
  useAudioRecording: ({ onRecordingComplete }: { onRecordingComplete: typeof completeRecording }) => {
    completeRecording = onRecordingComplete;
    return { startRecording() {}, stopRecording() {}, cancelRecording };
  },
}));
mock.module('../src/lib/hooks/useSystemAudioCapture', () => ({
  useSystemAudioCapture: () => ({ startRecording() {}, stopRecording() {}, cancelRecording: cancelSystemRecording }),
}));
mock.module('../src/lib/hooks/useTranscription', () => ({
  useTranscription: () => ({ mutateAsync: (arg: any) => transcribeHandler(arg) }),
}));
mock.module('../src/lib/utils/audio', () => ({
  getAudioDuration: (file: File) => durationHandler(file),
  formatAudioDuration: String,
  convertToWav: (file: File) => convertHandler(file),
}));
mock.module('../src/platform/PlatformContext', () => ({
  usePlatform: () => ({ metadata: { isTauri: false } }),
}));
mock.module('../src/components/ui/use-toast', () => ({
  useToast: () => ({ toast: (v: unknown) => calls.toast.push(v) }),
}));
const translate = (key: string) => key;
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }));
mock.module('../src/components/ui/dialog', () => ({
  Dialog: ({ children, open }: any) => (open ? <div>{children}</div> : null),
  ...Object.fromEntries(
    ['DialogContent', 'DialogDescription', 'DialogHeader', 'DialogTitle'].map((k) => [
      k,
      ({ children }: any) => <div>{children}</div>,
    ]),
  ),
}));
mock.module('../src/components/ui/select', () => ({
  Select: ({ children, ...props }: any) => <select-mock {...props}>{children}</select-mock>,
  ...Object.fromEntries(
    ['SelectContent', 'SelectItem', 'SelectTrigger', 'SelectValue'].map((k) => [
      k,
      ({ children }: any) => <div>{children}</div>,
    ]),
  ),
}));
mock.module('../src/components/ui/tabs', () => ({
  Tabs: ({ children, ...props }: any) => <tabs-mock {...props}>{children}</tabs-mock>,
  ...Object.fromEntries(
    ['TabsContent', 'TabsList', 'TabsTrigger'].map((k) => [
      k,
      ({ children }: any) => <div>{children}</div>,
    ]),
  ),
}));
mock.module('../src/components/VoiceProfiles/AudioSampleUpload', () => ({
  AudioSampleUpload: (props: any) => <audio-upload {...props} />,
}));
mock.module('../src/components/VoiceProfiles/AudioSampleRecording', () => ({
  AudioSampleRecording: () => null,
}));
mock.module('../src/components/VoiceProfiles/AudioSampleSystem', () => ({
  AudioSampleSystem: () => null,
}));
mock.module('../src/components/VoiceProfiles/SampleList', () => ({ SampleList: () => null }));
mock.module('../src/components/Effects/EffectsChainEditor', () => ({
  EffectsChainEditor: (props: any) => <chain-editor {...props} />,
}));
const { useServerStore } = await import('../src/stores/serverStore');
const { ProfileForm } = await import('../src/components/VoiceProfiles/ProfileForm');
const { SampleUpload } = await import('../src/components/VoiceProfiles/SampleUpload');
let view: ReactTestRenderer;
async function mount(editingProfileId: string | null = null) {
  useUIStore.setState({ profileDialogOpen: true, editingProfileId, profileFormDraft: null });
  await act(async () => {
    view = create(<ProfileForm />);
  });
}
const input = (placeholder: string) => view.root.findAllByProps({ placeholder })[0];
async function type(placeholder: string, name: string, value: string) {
  await act(async () => {
    await input(placeholder).props.onChange({ target: { name, value }, type: 'change' });
  });
}
function click(label: string) {
  const node = view.root.findAllByType('button').find((n) => n.children.includes(label));
  if (!node) throw new Error(`missing button ${label}`);
  act(() => node.props.onClick());
}
async function submit() {
  await act(async () => {
    await view.root.findByType('form').props.onSubmit({ preventDefault() {}, persist() {} });
  });
}
const name = (value: string) => type('profileForm.fields.namePlaceholder', 'name', value);
const upload = async (file: File) => {
  await act(async () => {
    view.root.findByType('audio-upload' as never).props.onFileChange(file);
  });
};
afterEach(() => {
  act(() => view?.unmount());
  for (const arr of Object.values(calls)) arr.length = 0;
  fail = '';
  duration = 5;
  durationHandler = async () => duration;
  transcribeHandler = async () => ({ text: 'transcribed' });
  addHandler = async () => {};
  createHandler = async () => ({ id: 'new' });
  updateHandler = async () => {};
  avatarHandler = async () => {};
  deleteHandler = async () => {};
  convertHandler = async () => new Blob(['wav'], { type: 'audio/wav' });
  completeRecording = undefined;
  finishingRecording = undefined;
  useServerStore.setState({ serverUrl: 'http://server-a', serverRevision: 0 });
  profile = undefined;
  useUIStore.setState({ profileDialogOpen: false, editingProfileId: null, profileFormDraft: null });
});
afterAll(() => mock.restore());

test('clone creation validates name, sample and reference before creating', async () => {
  await mount();
  await submit();
  expect(calls.create).toHaveLength(0);
  await name('Clone');
  await submit();
  expect(calls.toast.at(-1).title).toBe('profileForm.toast.sampleRequired');
  await upload(new File(['audio'], 'voice.wav', { type: 'audio/wav' }));
  await submit();
  expect(calls.create).toHaveLength(0);
  await type('profileForm.fields.referenceTextPlaceholder', 'referenceText', 'Hello');
  await submit();
  expect(calls.create[0].name).toBe('Clone');
  expect(calls.add[0].referenceText).toBe('Hello');
  expect(useUIStore.getState().profileDialogOpen).toBe(false);
});

test('long audio is rejected and failed sample upload rolls back', async () => {
  await mount();
  await name('Clone');
  await upload(new File(['audio'], 'voice.wav', { type: 'audio/wav' }));
  await type('profileForm.fields.referenceTextPlaceholder', 'referenceText', 'Hello');
  duration = 31;
  await submit();
  expect(calls.create).toHaveLength(0);
  duration = 5;
  fail = 'add';
  await submit();
  expect(calls.delete).toEqual(['new']);
  expect(useUIStore.getState().profileDialogOpen).toBe(true);
  expect(calls.toast.at(-1).title).toBe('profileForm.toast.sampleFailed');
});

test('designed creation requires a prompt and trims it and personality', async () => {
  await mount();
  click('profileForm.source.design');
  await name('Designed');
  await submit();
  expect(calls.toast.at(-1).title).toBe('profileForm.toast.noDesignPrompt');
  await type('profileForm.design.placeholder', '', '  warm voice  ');
  await type('profileForm.fields.personalityPlaceholder', 'personality', '  kind  ');
  await submit();
  expect(calls.create[0]).toMatchObject({
    voice_type: 'designed',
    design_prompt: 'warm voice',
    default_engine: 'qwen_voice_design',
    personality: 'kind',
  });
});

test('builtin selection is required and submits the selected voice', async () => {
  await mount();
  click('profileForm.source.builtin');
  await name('Preset');
  await submit();
  expect(calls.toast.at(-1).title).toBe('profileForm.toast.noVoiceSelected');
  act(() =>
    view.root
      .findAllByType('button')
      .find((n) => n.findAllByType('div').some((d) => d.children.includes('Voice One')))!
      .props.onClick(),
  );
  await submit();
  expect(calls.create[0]).toMatchObject({
    voice_type: 'preset',
    preset_engine: 'kokoro',
    preset_voice_id: 'v1',
    language: 'en',
  });
});

test('closing and reopening preserves a designed draft', async () => {
  await mount();
  click('profileForm.source.design');
  await name('Draft');
  await type('profileForm.design.placeholder', '', 'warm');
  await act(async () => {
    await view.root
      .findAllByType('button')
      .find((n) => n.children.includes('common.cancel'))!
      .props.onClick();
  });
  expect(useUIStore.getState().profileFormDraft).toMatchObject({
    name: 'Draft',
    voiceSource: 'design',
    designPrompt: 'warm',
  });
  await act(async () => {
    useUIStore.getState().setProfileDialogOpen(true);
  });
  expect(input('profileForm.fields.namePlaceholder').props.value).toBe('Draft');
  expect(input('profileForm.design.placeholder').props.value).toBe('warm');
});

test('editing submits metadata and changed effects; failed save keeps dialog open', async () => {
  profile = { id: 'p', name: 'Old', language: 'en', description: '', effects_chain: [] };
  await mount('p');
  await name('New');
  act(() => view.root.findByType('chain-editor' as never).props.onChange([{ type: 'gain' }]));
  fail = 'effects';
  await submit();
  expect(calls.update[0]).toMatchObject({ profileId: 'p', data: { name: 'New' } });
  expect(calls.effects[0]).toEqual({ profileId: 'p', effectsChain: [{ type: 'gain' }] });
  expect(useUIStore.getState().profileDialogOpen).toBe(true);
  expect(calls.toast.at(-1).title).toBe('profileForm.toast.effectsUpdateFailed');
});

test('sample upload requires a file and text, and sends them to the selected profile', async () => {
  let open = true;
  await act(async () => {
    view = create(
      <SampleUpload
        profileId="p"
        open
        onOpenChange={(v) => {
          open = v;
        }}
      />,
    );
  });
  await submit();
  expect(calls.add).toHaveLength(0);
  const file = new File(['audio'], 'voice.wav', { type: 'audio/wav' });
  await upload(file);
  await submit();
  expect(calls.add).toHaveLength(0);
  await type('Enter the exact text spoken in the audio...', 'referenceText', 'Hello');
  await submit();
  expect(calls.add[0]).toEqual({ profileId: 'p', file, referenceText: 'Hello' });
  expect(open).toBe(false);
});

test('personality-only draft survives closing and reopening', async () => {
  await mount();
  await type('profileForm.fields.personalityPlaceholder', 'personality', 'Gentle');
  await act(async () => {
    await view.root
      .findAllByType('button')
      .find((n) => n.children.includes('common.cancel'))!
      .props.onClick();
  });
  expect(useUIStore.getState().profileFormDraft?.personality).toBe('Gentle');
  await act(async () => {
    useUIStore.getState().setProfileDialogOpen(true);
  });
  expect(input('profileForm.fields.personalityPlaceholder').props.value).toBe('Gentle');
});


test('replacing a sample ignores an older duration result while the new file is validating', async () => {
  const pending = new Map<string, (value: number) => void>();
  durationHandler = (file) => new Promise((resolve) => pending.set(file.name, resolve));
  await mount();
  await upload(new File(['a'], 'first.wav', { type: 'audio/wav' }));
  await upload(new File(['b'], 'second.wav', { type: 'audio/wav' }));
  await act(async () => { pending.get('first.wav')!(31); await Promise.resolve(); });
  const field = view.root.findByType('audio-upload' as never);
  expect(field.props.isValidating).toBe(true);
  expect(field.props.isDisabled).toBe(false);
  await act(async () => { pending.get('second.wav')!(5); await Promise.resolve(); });
  expect(field.props.isValidating).toBe(false);
  expect(field.props.isDisabled).toBe(false);
});

test('a stale duration failure cannot invalidate a replacement sample', async () => {
  const pending = new Map<string, { resolve: (value: number) => void; reject: (error: Error) => void }>();
  durationHandler = (file) => new Promise((resolve, reject) => pending.set(file.name, { resolve, reject }));
  await mount();
  await upload(new File(['a'], 'first.wav', { type: 'audio/wav' }));
  await upload(new File(['b'], 'second.wav', { type: 'audio/wav' }));
  await act(async () => { pending.get('second.wav')!.resolve(5); await Promise.resolve(); });
  await act(async () => { pending.get('first.wav')!.reject(new Error('old file failed')); await Promise.resolve(); });
  await name('Clone');
  await type('profileForm.fields.referenceTextPlaceholder', 'referenceText', 'Hello');
  durationHandler = async () => 5;
  await submit();
  expect(calls.create).toHaveLength(1);
  expect(calls.add[0].file.name).toBe('second.wav');
});

test('duplicate submits while duration validation is pending create only one profile', async () => {
  await mount();
  await name('Clone');
  await upload(new File(['audio'], 'voice.wav', { type: 'audio/wav' }));
  await type('profileForm.fields.referenceTextPlaceholder', 'referenceText', 'Hello');
  const resolvers: ((value: number) => void)[] = [];
  durationHandler = () => new Promise((resolve) => resolvers.push(resolve));
  let first: Promise<unknown>;
  let second: Promise<unknown>;
  await act(async () => {
    const form = view.root.findByType('form');
    first = form.props.onSubmit({ preventDefault() {}, persist() {} });
    second = form.props.onSubmit({ preventDefault() {}, persist() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(resolvers.length).toBeGreaterThan(0);
  await act(async () => {
    for (const resolve of resolvers) resolve(5);
    await Promise.all([first!, second!]);
  });
  expect(calls.create).toHaveLength(1);
  expect(calls.add).toHaveLength(1);
});

test('clearing a sample ends validation and ignores its late result', async () => {
  let finish = (_value: number) => {};
  durationHandler = () => new Promise((resolve) => { finish = resolve; });
  await mount();
  await upload(new File(['audio'], 'old.wav', { type: 'audio/wav' }));
  await act(async () => { view.root.findByType('audio-upload' as never).props.onFileChange(undefined); });
  expect(view.root.findByType('audio-upload' as never).props.isValidating).toBe(false);
  await act(async () => { finish(31); await Promise.resolve(); });
  expect(view.root.findByType('audio-upload' as never).props.isDisabled).toBe(false);
});

test('changing the sample during submit does not create a profile from the old file', async () => {
  await mount();
  await name('Clone');
  await upload(new File(['a'], 'first.wav', { type: 'audio/wav' }));
  await type('profileForm.fields.referenceTextPlaceholder', 'referenceText', 'Hello');
  let finishOld = (_value: number) => {};
  durationHandler = (file) => file.name === 'first.wav' ? new Promise((resolve) => { finishOld = resolve; }) : Promise.resolve(5);
  let submitting: Promise<unknown>;
  await act(async () => {
    submitting = view.root.findByType('form').props.onSubmit({ preventDefault() {}, persist() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await upload(new File(['b'], 'second.wav', { type: 'audio/wav' }));
  await act(async () => { finishOld(5); await submitting!; });
  expect(calls.create).toHaveLength(0);
  expect(calls.add).toHaveLength(0);
  expect(useUIStore.getState().profileDialogOpen).toBe(true);
});


test('a late transcript cannot replace reference text for a newer sample', async () => {
  let resolveTranscript!: (value: { text: string }) => void;
  transcribeHandler = () => new Promise((resolve) => { resolveTranscript = resolve; });
  await mount();
  await upload(new File(['first'], 'first.wav', { type: 'audio/wav' }));
  await act(async () => { view.root.findByType('audio-upload' as never).props.onTranscribe(); });
  await upload(new File(['second'], 'second.wav', { type: 'audio/wav' }));
  await type('profileForm.fields.referenceTextPlaceholder', 'referenceText', 'Second sample');
  await act(async () => { resolveTranscript({ text: 'First sample transcript' }); });
  expect(input('profileForm.fields.referenceTextPlaceholder').props.value).toBe('Second sample');
});

test('transcription fills reference text for the selected sample', async () => {
  await mount();
  const sample = new File(['voice'], 'voice.wav', { type: 'audio/wav' });
  await upload(sample);
  let received: any;
  transcribeHandler = async (arg) => { received = arg; return { text: 'Recognized speech' }; };
  await act(async () => { await view.root.findByType('audio-upload' as never).props.onTranscribe(); });
  expect(received.file).toBe(sample);
  expect(input('profileForm.fields.referenceTextPlaceholder').props.value).toBe('Recognized speech');
});


test('transcription does not overwrite reference text edited while it is pending', async () => {
  let resolveTranscript!: (value: { text: string }) => void;
  transcribeHandler = () => new Promise((resolve) => { resolveTranscript = resolve; });
  await mount();
  await upload(new File(['voice'], 'voice.wav', { type: 'audio/wav' }));
  await act(async () => { view.root.findByType('audio-upload' as never).props.onTranscribe(); });
  await type('profileForm.fields.referenceTextPlaceholder', 'referenceText', 'My correction');
  await act(async () => { resolveTranscript({ text: 'Old result' }); });
  expect(input('profileForm.fields.referenceTextPlaceholder').props.value).toBe('My correction');
});

test('only the newest overlapping transcription can update reference text', async () => {
  const pending: Array<(value: { text: string }) => void> = [];
  transcribeHandler = () => new Promise((resolve) => { pending.push(resolve); });
  await mount();
  await upload(new File(['voice'], 'voice.wav', { type: 'audio/wav' }));
  await act(async () => { view.root.findByType('audio-upload' as never).props.onTranscribe(); });
  await act(async () => { view.root.findByType('audio-upload' as never).props.onTranscribe(); });
  await act(async () => { pending[0]({ text: 'Older' }); });
  expect(input('profileForm.fields.referenceTextPlaceholder').props.value).toBe('');
  await act(async () => { pending[1]({ text: 'Newer' }); });
  expect(input('profileForm.fields.referenceTextPlaceholder').props.value).toBe('Newer');
});


test('a stale transcription failure does not show an error for a replacement sample', async () => {
  let rejectTranscript!: (reason: Error) => void;
  transcribeHandler = () => new Promise((_resolve, reject) => { rejectTranscript = reject; });
  await mount();
  await upload(new File(['first'], 'first.wav', { type: 'audio/wav' }));
  await act(async () => { view.root.findByType('audio-upload' as never).props.onTranscribe(); });
  await upload(new File(['second'], 'second.wav', { type: 'audio/wav' }));
  await act(async () => { rejectTranscript(new Error('old request failed')); });
  expect(calls.toast.some((v) => v.title === 'profileForm.toast.transcribeFailed')).toBe(false);
});

test('a current transcription failure is reported', async () => {
  transcribeHandler = async () => { throw new Error('transcription unavailable'); };
  await mount();
  await upload(new File(['voice'], 'voice.wav', { type: 'audio/wav' }));
  await act(async () => { await view.root.findByType('audio-upload' as never).props.onTranscribe(); });
  expect(calls.toast.at(-1)).toEqual(expect.objectContaining({ title: 'profileForm.toast.transcribeFailed', description: 'transcription unavailable' }));
});

async function mountSample(open = true, profileId = 'p') {
  await act(async () => { view = create(<SampleUpload profileId={profileId} open={open} onOpenChange={() => {}} />); });
}
const sampleText = () => input('Enter the exact text spoken in the audio...');
const editSampleText = (value: string) => type('Enter the exact text spoken in the audio...', 'referenceText', value);

test('reopening after an external close clears the sample, reference text and source tab', async () => {
  await mountSample();
  await upload(new File(['a'], 'voice.wav', { type: 'audio/wav' }));
  await editSampleText('Old reference');
  const tabs = () => view.root.findByType('tabs-mock' as never);
  act(() => tabs().props.onValueChange('record'));
  await act(async () => { view.update(<SampleUpload profileId="p" open={false} onOpenChange={() => {}} />); });
  await act(async () => { view.update(<SampleUpload profileId="p" open onOpenChange={() => {}} />); });
  expect(tabs().props.value).toBe('upload');
  expect(view.root.findByType('audio-upload' as never).props.file).toBeUndefined();
  expect(sampleText().props.value).toBe('');
});

test('closing while a microphone recording is finishing prevents it from filling the next sample', async () => {
  await mountSample();
  const complete = completeRecording;
  finishingRecording = () => complete?.(new Blob(['audio'], { type: 'audio/webm' }), 2);
  click('Cancel');
  await act(async () => { view.update(<SampleUpload profileId="p" open={false} onOpenChange={() => {}} />); });
  await act(async () => { view.update(<SampleUpload profileId="p" open onOpenChange={() => {}} />); });
  act(() => finishingRecording?.());
  expect(view.root.findByType('audio-upload' as never).props.file).toBeUndefined();
  expect(calls.toast.some((item) => item.title === 'Recording complete')).toBe(false);
});

test('sample upload ignores a transcript for a replaced audio file', async () => {
  let resolve!: (value: { text: string }) => void;
  transcribeHandler = () => new Promise((r) => { resolve = r; });
  await mountSample();
  await upload(new File(['a'], 'first.wav', { type: 'audio/wav' }));
  await act(async () => { view.root.findByType('audio-upload' as never).props.onTranscribe(); });
  await upload(new File(['b'], 'second.wav', { type: 'audio/wav' }));
  await editSampleText('Second sample');
  await act(async () => { resolve({ text: 'First transcript' }); });
  expect(sampleText().props.value).toBe('Second sample');
});

test('sample upload does not overwrite a correction made during transcription', async () => {
  let resolve!: (value: { text: string }) => void;
  transcribeHandler = () => new Promise((r) => { resolve = r; });
  await mountSample();
  await upload(new File(['a'], 'voice.wav', { type: 'audio/wav' }));
  await act(async () => { view.root.findByType('audio-upload' as never).props.onTranscribe(); });
  await editSampleText('My correction');
  await act(async () => { resolve({ text: 'Old transcript' }); });
  expect(sampleText().props.value).toBe('My correction');
});

test('only the newest sample-upload transcription is applied', async () => {
  const pending: Array<(value: { text: string }) => void> = [];
  transcribeHandler = () => new Promise((resolve) => { pending.push(resolve); });
  await mountSample();
  await upload(new File(['a'], 'voice.wav', { type: 'audio/wav' }));
  await act(async () => { view.root.findByType('audio-upload' as never).props.onTranscribe(); });
  await act(async () => { view.root.findByType('audio-upload' as never).props.onTranscribe(); });
  await act(async () => { pending[0]({ text: 'Old' }); });
  expect(sampleText().props.value).toBe('');
  await act(async () => { pending[1]({ text: 'New' }); });
  expect(sampleText().props.value).toBe('New');
});

test('closing and reopening sample upload invalidates a pending transcript', async () => {
  let resolve!: (value: { text: string }) => void;
  transcribeHandler = () => new Promise((r) => { resolve = r; });
  await mountSample();
  await upload(new File(['a'], 'voice.wav', { type: 'audio/wav' }));
  await act(async () => { view.root.findByType('audio-upload' as never).props.onTranscribe(); });
  await act(async () => { view.update(<SampleUpload profileId="p" open={false} onOpenChange={() => {}} />); });
  await act(async () => { view.update(<SampleUpload profileId="p" open onOpenChange={() => {}} />); });
  await act(async () => { resolve({ text: 'Old transcript' }); });
  expect(sampleText().props.value).toBe('');
});

test('sample upload applies the current transcription and reports current failures', async () => {
  await mountSample();
  const file = new File(['a'], 'voice.wav', { type: 'audio/wav' });
  await upload(file);
  let received: any;
  transcribeHandler = async (arg) => { received = arg; return { text: 'Recognized speech' }; };
  await act(async () => { await view.root.findByType('audio-upload' as never).props.onTranscribe(); });
  expect(received.file).toBe(file);
  expect(sampleText().props.value).toBe('Recognized speech');
  transcribeHandler = async () => { throw new Error('recognizer unavailable'); };
  await act(async () => { await view.root.findByType('audio-upload' as never).props.onTranscribe(); });
  expect(calls.toast.at(-1)).toEqual(expect.objectContaining({ title: 'Transcription failed', description: 'recognizer unavailable' }));
});

test('sample upload ignores a stale transcription failure for a replacement', async () => {
  let reject!: (error: Error) => void;
  transcribeHandler = () => new Promise((_resolve, r) => { reject = r; });
  await mountSample();
  await upload(new File(['a'], 'first.wav', { type: 'audio/wav' }));
  await act(async () => { view.root.findByType('audio-upload' as never).props.onTranscribe(); });
  await upload(new File(['b'], 'second.wav', { type: 'audio/wav' }));
  await act(async () => { reject(new Error('old request failed')); });
  expect(calls.toast.some((entry) => entry.title === 'Transcription failed')).toBe(false);
});

test('sample upload ignores a transcript after switching profiles', async () => {
  let resolve!: (value: { text: string }) => void;
  transcribeHandler = () => new Promise((r) => { resolve = r; });
  await mountSample();
  await upload(new File(['a'], 'voice.wav', { type: 'audio/wav' }));
  await act(async () => { view.root.findByType('audio-upload' as never).props.onTranscribe(); });
  await act(async () => { view.update(<SampleUpload profileId="other" open onOpenChange={() => {}} />); });
  await act(async () => { resolve({ text: 'Old profile transcript' }); });
  expect(sampleText().props.value).toBe('');
});

test('sample upload ignores a transcript after the profile language changes', async () => {
  let resolve!: (value: { text: string }) => void;
  transcribeHandler = () => new Promise((r) => { resolve = r; });
  profile = { language: 'en' };
  await mountSample();
  await upload(new File(['a'], 'voice.wav', { type: 'audio/wav' }));
  await act(async () => { view.root.findByType('audio-upload' as never).props.onTranscribe(); });
  profile = { language: 'fr' };
  await act(async () => { view.update(<SampleUpload profileId="p" open onOpenChange={() => {}} />); });
  await act(async () => { resolve({ text: 'English transcript' }); });
  expect(sampleText().props.value).toBe('');
});

async function submitSampleWithoutWaiting() {
  await act(async () => {
    void view.root.findByType('form').props.onSubmit({ preventDefault() {}, persist() {} });
    await Promise.resolve();
  });
}

test('a completed old sample upload cannot clear newer sample edits', async () => {
  let resolve!: () => void;
  addHandler = () => new Promise((r) => { resolve = r; });
  await mountSample();
  await upload(new File(['a'], 'first.wav', { type: 'audio/wav' }));
  await editSampleText('First words');
  await submitSampleWithoutWaiting();
  expect(calls.add).toHaveLength(1);
  await upload(new File(['b'], 'second.wav', { type: 'audio/wav' }));
  await editSampleText('Second words');
  await act(async () => { resolve(); });
  expect(view.root.findByType('audio-upload' as never).props.file.name).toBe('second.wav');
  expect(sampleText().props.value).toBe('Second words');
});

test('a failed old sample upload does not report an error in a reopened dialog', async () => {
  let reject!: (error: Error) => void;
  addHandler = () => new Promise((_resolve, r) => { reject = r; });
  await mountSample();
  await upload(new File(['a'], 'first.wav', { type: 'audio/wav' }));
  await editSampleText('First words');
  await submitSampleWithoutWaiting();
  await act(async () => { view.update(<SampleUpload profileId="p" open={false} onOpenChange={() => {}} />); });
  await act(async () => { view.update(<SampleUpload profileId="p" open onOpenChange={() => {}} />); });
  await act(async () => { reject(new Error('old upload failed')); });
  expect(calls.toast.some((item) => item.description === 'old upload failed')).toBe(false);
});

test('duplicate sample submits while an upload is pending issue one request', async () => {
  let resolve!: () => void;
  addHandler = () => new Promise((r) => { resolve = r; });
  await mountSample();
  await upload(new File(['a'], 'voice.wav', { type: 'audio/wav' }));
  await editSampleText('Words');
  await submitSampleWithoutWaiting();
  await submitSampleWithoutWaiting();
  expect(calls.add).toHaveLength(1);
  await act(async () => { resolve(); });
});

test('old upload completion cannot unlock a newer dialog upload', async () => {
  const pending: Array<() => void> = [];
  addHandler = () => new Promise((resolve) => { pending.push(resolve); });
  await mountSample();
  await upload(new File(['a'], 'first.wav', { type: 'audio/wav' }));
  await editSampleText('First');
  await submitSampleWithoutWaiting();
  await act(async () => { view.update(<SampleUpload profileId="p" open={false} onOpenChange={() => {}} />); });
  await act(async () => { view.update(<SampleUpload profileId="p" open onOpenChange={() => {}} />); });
  await upload(new File(['b'], 'second.wav', { type: 'audio/wav' }));
  await editSampleText('Second');
  await submitSampleWithoutWaiting();
  expect(calls.add).toHaveLength(2);
  await act(async () => { pending[0](); });
  await submitSampleWithoutWaiting();
  expect(calls.add).toHaveLength(2);
  expect(sampleText().props.value).toBe('Second');
  await act(async () => { pending[1](); });
  expect(calls.toast.some((item) => item.title === 'Sample added')).toBe(true);
});

test('a current sample upload failure stays visible and retains form data', async () => {
  addHandler = async () => { throw new Error('upload failed'); };
  await mountSample();
  await upload(new File(['a'], 'voice.wav', { type: 'audio/wav' }));
  await editSampleText('Words');
  await submit();
  expect(calls.toast.at(-1)).toEqual(expect.objectContaining({ title: 'Could not add sample', description: 'upload failed' }));
  expect(sampleText().props.value).toBe('Words');
  expect(view.root.findByType('audio-upload' as never).props.file.name).toBe('voice.wav');
});

function switchVoiceServer(url = 'http://server-b') {
  act(() => useServerStore.setState((state) => ({ serverUrl: url, serverRevision: state.serverRevision + 1 })));
}

test('voice creation never uploads a sample to a newly selected server', async () => {
  let resolve!: (value: any) => void;
  createHandler = () => new Promise((r) => { resolve = r; });
  await mount();
  await name('Clone');
  await upload(new File(['a'], 'voice.wav', { type: 'audio/wav' }));
  await type('profileForm.fields.referenceTextPlaceholder', 'referenceText', 'Words');
  await submitSampleWithoutWaiting();
  expect(calls.create).toHaveLength(1);
  switchVoiceServer();
  await act(async () => { resolve({ id: 'new' }); });
  expect(calls.add).toHaveLength(0);
  expect(calls.delete).toHaveLength(0);
  expect(useUIStore.getState().profileDialogOpen).toBe(true);
});

test('voice creation never rolls back on a different server after sample failure', async () => {
  let reject!: (error: Error) => void;
  addHandler = () => new Promise((_resolve, r) => { reject = r; });
  await mount();
  await name('Clone');
  await upload(new File(['a'], 'voice.wav', { type: 'audio/wav' }));
  await type('profileForm.fields.referenceTextPlaceholder', 'referenceText', 'Words');
  await submitSampleWithoutWaiting();
  expect(calls.add).toHaveLength(1);
  switchVoiceServer();
  await act(async () => { reject(new Error('upload failed')); });
  expect(calls.delete).toHaveLength(0);
  expect(useUIStore.getState().profileDialogOpen).toBe(true);
});

test('sample upload ignores a transcript from a previous server even after switching back', async () => {
  let resolve!: (value: { text: string }) => void;
  transcribeHandler = () => new Promise((r) => { resolve = r; });
  await mountSample();
  await upload(new File(['a'], 'voice.wav', { type: 'audio/wav' }));
  await act(async () => { view.root.findByType('audio-upload' as never).props.onTranscribe(); });
  switchVoiceServer();
  switchVoiceServer('http://server-a');
  await act(async () => { resolve({ text: 'Old server transcript' }); });
  expect(sampleText().props.value).toBe('');
});

test('sample upload ignores completion after changing servers', async () => {
  let resolve!: () => void;
  addHandler = () => new Promise((r) => { resolve = r; });
  await mountSample();
  await upload(new File(['a'], 'voice.wav', { type: 'audio/wav' }));
  await editSampleText('Words');
  await submitSampleWithoutWaiting();
  switchVoiceServer();
  await act(async () => { resolve(); });
  expect(sampleText().props.value).toBe('Words');
  expect(calls.toast.some((item) => item.title === 'Sample added')).toBe(false);
});

test('voice creation stops before its first request if the server changes during validation', async () => {
  let resolve!: (value: number) => void;
  durationHandler = () => new Promise((r) => { resolve = r; });
  await mount();
  await name('Clone');
  await upload(new File(['a'], 'voice.wav', { type: 'audio/wav' }));
  await type('profileForm.fields.referenceTextPlaceholder', 'referenceText', 'Words');
  await submitSampleWithoutWaiting();
  switchVoiceServer();
  await act(async () => { resolve(5); });
  expect(calls.create).toHaveLength(0);
  expect(calls.add).toHaveLength(0);
});

test('voice creation ignores a transcript from a previous server', async () => {
  let resolve!: (value: { text: string }) => void;
  transcribeHandler = () => new Promise((r) => { resolve = r; });
  await mount();
  await upload(new File(['a'], 'voice.wav', { type: 'audio/wav' }));
  await act(async () => { view.root.findByType('audio-upload' as never).props.onTranscribe(); });
  switchVoiceServer();
  await act(async () => { resolve({ text: 'Old transcript' }); });
  expect(input('profileForm.fields.referenceTextPlaceholder').props.value).toBe('');
});

test('switching servers during form validation cannot create a voice on the new server', async () => {
  await mount();
  await name('Clone');
  await upload(new File(['a'], 'voice.wav', { type: 'audio/wav' }));
  await type('profileForm.fields.referenceTextPlaceholder', 'referenceText', 'Words');
  let submitted!: Promise<unknown>;
  await act(async () => {
    submitted = view.root.findByType('form').props.onSubmit({ preventDefault() {}, persist() {} });
    useServerStore.setState((state) => ({ serverUrl: 'http://server-b', serverRevision: state.serverRevision + 1 }));
    await submitted;
  });
  expect(calls.create).toHaveLength(0);
  expect(calls.add).toHaveLength(0);
});

test('switching servers during sample validation cannot upload to the new server', async () => {
  await mountSample();
  await upload(new File(['a'], 'voice.wav', { type: 'audio/wav' }));
  await editSampleText('Words');
  let submitted!: Promise<unknown>;
  await act(async () => {
    submitted = view.root.findByType('form').props.onSubmit({ preventDefault() {}, persist() {} });
    useServerStore.setState((state) => ({ serverUrl: 'http://server-b', serverRevision: state.serverRevision + 1 }));
    await submitted;
  });
  expect(calls.add).toHaveLength(0);
});

test('editing a voice never sends follow-up effects to a different server', async () => {
  let resolve!: () => void;
  updateHandler = () => new Promise((r) => { resolve = r; });
  profile = { id: 'p', name: 'Old', language: 'en', description: '', effects_chain: [] };
  await mount('p');
  await name('New');
  act(() => view.root.findByType('chain-editor' as never).props.onChange([{ type: 'gain' }]));
  await submitSampleWithoutWaiting();
  expect(calls.update).toHaveLength(1);
  switchVoiceServer();
  await act(async () => { resolve(); });
  expect(calls.effects).toHaveLength(0);
  expect(useUIStore.getState().profileDialogOpen).toBe(true);
});

test('a failed avatar deletion keeps the existing image visible', async () => {
  profile = { id: 'p', name: 'Voice', language: 'en', avatar_path: 'avatar.png' };
  fail = 'avatar';
  await mount('p');
  const image = () => view.root.findByProps({ alt: 'profileForm.avatar.alt' });
  expect(image().props.src).toContain('/profiles/p/avatar');
  await act(async () => { await view.root.findByProps({ 'aria-label': 'profileForm.avatar.remove' }).props.onClick(); });
  expect(calls.toast.at(-1).title).toBe('profileForm.toast.avatarRemoveFailed');
  expect(image().props.src).toContain('/profiles/p/avatar');
});

test('an old avatar deletion cannot clear a newly selected image', async () => {
  let resolve!: () => void;
  avatarHandler = () => new Promise((r) => { resolve = r; });
  profile = { id: 'p', name: 'Voice', language: 'en', avatar_path: 'avatar.png' };
  await mount('p');
  await act(async () => { view.root.findByProps({ 'aria-label': 'profileForm.avatar.remove' }).props.onClick(); });
  const replacement = new File(['image'], 'new.png', { type: 'image/png' });
  await act(async () => { view.root.findByProps({ accept: 'image/png,image/jpeg,image/webp' }).props.onChange({ target: { files: [replacement] } }); });
  const preview = view.root.findByProps({ alt: 'profileForm.avatar.alt' }).props.src;
  expect(preview).toStartWith('blob:');
  await act(async () => { resolve(); });
  expect(view.root.findByProps({ alt: 'profileForm.avatar.alt' }).props.src).toBe(preview);
});

test('a stale avatar deletion failure does not report an error on another server', async () => {
  let reject!: (error: Error) => void;
  avatarHandler = () => new Promise((_resolve, r) => { reject = r; });
  profile = { id: 'p', name: 'Voice', language: 'en', avatar_path: 'avatar.png' };
  await mount('p');
  await act(async () => { view.root.findByProps({ 'aria-label': 'profileForm.avatar.remove' }).props.onClick(); });
  switchVoiceServer();
  await act(async () => { reject(new Error('old server failed')); });
  expect(calls.toast.some((item) => item.description === 'old server failed')).toBe(false);
});

for (const [file, title] of [
  [new File(['not an image'], 'note.txt', { type: 'text/plain' }), 'profileForm.toast.invalidFile'],
  [new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' }), 'profileForm.toast.fileTooLarge'],
] as const) {
  test(`rejects ${file.name} as a voice image without losing the existing image`, async () => {
    profile = { id: 'p', name: 'Voice', language: 'en', avatar_path: 'avatar.png' };
    await mount('p');
    await act(async () => { view.root.findByProps({ accept: 'image/png,image/jpeg,image/webp' }).props.onChange({ target: { files: [file] } }); });
    expect(calls.toast.at(-1).title).toBe(title);
    expect(view.root.findByProps({ alt: 'profileForm.avatar.alt' }).props.src).toContain('/profiles/p/avatar');
    expect(calls.avatar).toHaveLength(0);
  });
}

test('a successful avatar deletion removes the image and reports success', async () => {
  profile = { id: 'p', name: 'Voice', language: 'en', avatar_path: 'avatar.png' };
  await mount('p');
  await act(async () => { await view.root.findByProps({ 'aria-label': 'profileForm.avatar.remove' }).props.onClick(); });
  expect(calls.avatar).toEqual([{ profileId: 'p' }]);
  expect(calls.toast.at(-1).title).toBe('profileForm.toast.avatarRemoved');
  expect(view.root.findAllByProps({ alt: 'profileForm.avatar.alt' })).toHaveLength(0);
});

test('a completed old profile save cannot close or clear a reopened draft', async () => {
  let finish!: (profile: { id: string }) => void;
  createHandler = () => new Promise((resolve) => { finish = resolve; });
  await mount();
  click('profileForm.source.design');
  await name('First');
  await type('profileForm.design.placeholder', '', 'first voice');
  let pending!: Promise<void>;
  await act(async () => { pending = view.root.findByType('form').props.onSubmit({ preventDefault() {}, persist() {} }); await Promise.resolve(); });
  await act(async () => { await view.root.findAllByType('button').find((n) => n.children.includes('common.cancel'))!.props.onClick(); });
  await act(async () => { useUIStore.getState().setProfileDialogOpen(true); });
  await name('Second draft');
  await act(async () => { finish({ id: 'old' }); await pending; });
  expect(useUIStore.getState().profileDialogOpen).toBe(true);
  expect(input('profileForm.fields.namePlaceholder').props.value).toBe('Second draft');
  expect(calls.toast.some((item) => item.title === 'profileForm.toast.profileCreated')).toBe(false);
});

test('a failed old profile save cannot display an error in a reopened form', async () => {
  let reject!: (error: Error) => void;
  createHandler = () => new Promise((_resolve, fail) => { reject = fail; });
  await mount();
  click('profileForm.source.design');
  await name('First');
  await type('profileForm.design.placeholder', '', 'first voice');
  let pending!: Promise<void>;
  await act(async () => { pending = view.root.findByType('form').props.onSubmit({ preventDefault() {}, persist() {} }); await Promise.resolve(); });
  await act(async () => { await view.root.findAllByType('button').find((n) => n.children.includes('common.cancel'))!.props.onClick(); });
  await act(async () => { useUIStore.getState().setProfileDialogOpen(true); });
  await act(async () => { reject(new Error('old save failed')); await pending; });
  expect(useUIStore.getState().profileDialogOpen).toBe(true);
  expect(calls.toast.some((item) => item.description === 'old save failed')).toBe(false);
});

test('an old save cannot block or unlock a newer profile save', async () => {
  const pending: Array<(profile: { id: string }) => void> = [];
  createHandler = () => new Promise((resolve) => { pending.push(resolve); });
  await mount();
  click('profileForm.source.design');
  await name('First');
  await type('profileForm.design.placeholder', '', 'first voice');
  let first!: Promise<void>;
  await act(async () => { first = view.root.findByType('form').props.onSubmit({ preventDefault() {}, persist() {} }); await Promise.resolve(); });
  await act(async () => { await view.root.findAllByType('button').find((n) => n.children.includes('common.cancel'))!.props.onClick(); });
  await act(async () => { useUIStore.getState().setProfileDialogOpen(true); });
  await name('Second');
  let second!: Promise<void>;
  await act(async () => { second = view.root.findByType('form').props.onSubmit({ preventDefault() {}, persist() {} }); await Promise.resolve(); });
  expect(calls.create).toHaveLength(2);
  await act(async () => { pending[0]({ id: 'old' }); await first; });
  await act(async () => { await view.root.findByType('form').props.onSubmit({ preventDefault() {}, persist() {} }); });
  expect(calls.create).toHaveLength(2);
  await act(async () => { pending[1]({ id: 'new' }); await second; });
  expect(useUIStore.getState().profileDialogOpen).toBe(false);
});

test('a clone save completes its original sample without closing a reopened draft', async () => {
  let finish!: (profile: { id: string }) => void;
  createHandler = () => new Promise((resolve) => { finish = resolve; });
  await mount();
  await name('First');
  await upload(new File(['voice'], 'first.wav', { type: 'audio/wav' }));
  await type('profileForm.fields.referenceTextPlaceholder', 'referenceText', 'First words');
  let pending!: Promise<void>;
  await act(async () => { pending = view.root.findByType('form').props.onSubmit({ preventDefault() {}, persist() {} }); await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { await view.root.findAllByType('button').find((n) => n.children.includes('common.cancel'))!.props.onClick(); });
  await act(async () => { useUIStore.getState().setProfileDialogOpen(true); });
  await name('New draft');
  await act(async () => { finish({ id: 'old' }); await pending; });
  expect(calls.add[0]).toMatchObject({ profileId: 'old', referenceText: 'First words' });
  expect(calls.add[0].file.name).toBe('first.wav');
  expect(useUIStore.getState().profileDialogOpen).toBe(true);
  expect(input('profileForm.fields.namePlaceholder').props.value).toBe('New draft');
});

test.each([true, false])('non-WAV sample upload handles conversion success=%s', async (success) => {
  if (!success) convertHandler = async () => { throw new Error('unsupported'); };
  await mount();
  await name('Clone');
  await upload(new File(['voice'], 'first.webm', { type: 'audio/webm' }));
  await type('profileForm.fields.referenceTextPlaceholder', 'referenceText', 'Words');
  await submit();
  expect(calls.add[0].file.name).toBe(success ? 'first.wav' : 'first.webm');
  expect(calls.add[0].file.type).toBe(success ? 'audio/wav' : 'audio/webm');
  expect(useUIStore.getState().profileDialogOpen).toBe(false);
});

test('sample and rollback failures are both reported while keeping the draft', async () => {
  fail = 'add';
  deleteHandler = async () => { throw new Error('rollback failed'); };
  await mount();
  await name('Clone');
  await upload(new File(['voice'], 'first.wav', { type: 'audio/wav' }));
  await type('profileForm.fields.referenceTextPlaceholder', 'referenceText', 'Words');
  await submit();
  expect(calls.toast.map((item) => item.title)).toContain('profileForm.toast.rollbackFailed');
  expect(calls.toast.map((item) => item.title)).toContain('profileForm.toast.sampleFailed');
  expect(useUIStore.getState().profileDialogOpen).toBe(true);
  expect(input('profileForm.fields.namePlaceholder').props.value).toBe('Clone');
});

const originalFileReader = globalThis.FileReader;
class ControlledFileReader {
  static pending: ControlledFileReader[] = [];
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(_file: File) { ControlledFileReader.pending.push(this); }
  succeed(data: string) { this.result = data; this.onload?.(); }
  fail() { this.onerror?.(); }
}
function controlFileReads() {
  ControlledFileReader.pending = [];
  globalThis.FileReader = ControlledFileReader as unknown as typeof FileReader;
}
function cancelProfile() {
  return view.root.findAllByType('button').find((n) => n.children.includes('common.cancel'))!.props.onClick() as Promise<void>;
}
afterEach(() => { globalThis.FileReader = originalFileReader; ControlledFileReader.pending = []; });

test('closing and reopening a clone draft preserves its audio bytes and reference text', async () => {
  controlFileReads();
  await mount();
  await name('Narrator');
  await upload(new File(['voice'], 'voice.wav', { type: 'audio/wav' }));
  await type('profileForm.fields.referenceTextPlaceholder', 'referenceText', 'Hello there');
  let closing!: Promise<void>;
  await act(async () => { closing = cancelProfile(); await Promise.resolve(); });
  await act(async () => { ControlledFileReader.pending[0].succeed('data:audio/wav;base64,dm9pY2U='); await closing; });
  await act(async () => { useUIStore.getState().setProfileDialogOpen(true); });
  expect(input('profileForm.fields.namePlaceholder').props.value).toBe('Narrator');
  expect(input('profileForm.fields.referenceTextPlaceholder').props.value).toBe('Hello there');
  const restored = view.root.findByType('audio-upload' as never).props.file as File;
  expect(restored.name).toBe('voice.wav');
  expect(restored.type).toBe('audio/wav');
  expect(await restored.text()).toBe('voice');
});

test('a file without a declared MIME type survives a draft round trip', async () => {
  controlFileReads();
  await mount();
  await name('Narrator');
  await upload(new File(['voice'], 'voice.wav'));
  let closing!: Promise<void>;
  await act(async () => { closing = cancelProfile(); await Promise.resolve(); });
  await act(async () => { ControlledFileReader.pending[0].succeed('data:;base64,dm9pY2U='); await closing; });
  await act(async () => { useUIStore.getState().setProfileDialogOpen(true); });
  const restored = view.root.findByType('audio-upload' as never).props.file as File;
  expect(restored?.name).toBe('voice.wav');
  expect(await restored.text()).toBe('voice');
});

test('a failed audio draft conversion keeps the other form fields', async () => {
  controlFileReads();
  await mount();
  await name('Narrator');
  await upload(new File(['voice'], 'voice.wav', { type: 'audio/wav' }));
  await type('profileForm.fields.referenceTextPlaceholder', 'referenceText', 'Words');
  let closing!: Promise<void>;
  await act(async () => { closing = cancelProfile(); await Promise.resolve(); });
  await act(async () => { ControlledFileReader.pending[0].fail(); await closing; });
  await act(async () => { useUIStore.getState().setProfileDialogOpen(true); });
  expect(input('profileForm.fields.namePlaceholder').props.value).toBe('Narrator');
  expect(input('profileForm.fields.referenceTextPlaceholder').props.value).toBe('Words');
  expect(view.root.findByType('audio-upload' as never).props.file).toBeUndefined();
});

test('an older draft conversion cannot overwrite or close a reopened newer draft', async () => {
  controlFileReads();
  await mount();
  await name('First');
  await upload(new File(['first'], 'first.wav', { type: 'audio/wav' }));
  let first!: Promise<void>, second!: Promise<void>;
  await act(async () => { first = cancelProfile(); await Promise.resolve(); });
  await name('Second');
  await upload(new File(['second'], 'second.wav', { type: 'audio/wav' }));
  await act(async () => { second = cancelProfile(); await Promise.resolve(); });
  await act(async () => { ControlledFileReader.pending[1].succeed('data:audio/wav;base64,c2Vjb25k'); await second; });
  await act(async () => { useUIStore.getState().setProfileDialogOpen(true); });
  await name('New edits');
  await act(async () => { ControlledFileReader.pending[0].succeed('data:audio/wav;base64,Zmlyc3Q='); await first; });
  expect(useUIStore.getState().profileDialogOpen).toBe(true);
  expect(input('profileForm.fields.namePlaceholder').props.value).toBe('New edits');
  expect(useUIStore.getState().profileFormDraft?.sampleFileName).toBe('second.wav');
});

test('editing a draft while its audio is being saved does not discard the newer edits', async () => {
  controlFileReads();
  await mount();
  await name('Before');
  await upload(new File(['voice'], 'voice.wav', { type: 'audio/wav' }));
  let closing!: Promise<void>;
  await act(async () => { closing = cancelProfile(); await Promise.resolve(); });
  await name('After');
  await act(async () => { ControlledFileReader.pending[0].succeed('data:audio/wav;base64,dm9pY2U='); await closing; });
  expect(useUIStore.getState().profileDialogOpen).toBe(true);
  expect(input('profileForm.fields.namePlaceholder').props.value).toBe('After');
});

test('a corrupt saved audio draft does not prevent restoring its text fields', async () => {
  await mount();
  await act(async () => { useUIStore.setState({ profileFormDraft: {
    name: 'Saved voice', description: '', language: 'en', personality: '', referenceText: 'Words',
    sampleMode: 'upload', sampleFileName: 'voice.wav', sampleFileType: 'audio/wav', sampleFileData: 'data:audio/wav;base64,%%%'
  }}); });
  expect(input('profileForm.fields.namePlaceholder').props.value).toBe('Saved voice');
  expect(input('profileForm.fields.referenceTextPlaceholder').props.value).toBe('Words');
  expect(view.root.findByType('audio-upload' as never).props.file).toBeUndefined();
});

test('a pending draft close cannot affect a different server', async () => {
  controlFileReads();
  await mount();
  await name('Original');
  await upload(new File(['voice'], 'voice.wav', { type: 'audio/wav' }));
  let closing!: Promise<void>;
  await act(async () => { closing = cancelProfile(); await Promise.resolve(); });
  switchVoiceServer();
  await name('New server edits');
  await act(async () => { ControlledFileReader.pending[0].succeed('data:audio/wav;base64,dm9pY2U='); await closing; });
  expect(useUIStore.getState().profileDialogOpen).toBe(true);
  expect(input('profileForm.fields.namePlaceholder').props.value).toBe('New server edits');
  expect(useUIStore.getState().profileFormDraft).toBeNull();
});

test('changing the voice source while audio is saved keeps the current form open', async () => {
  controlFileReads();
  await mount();
  await name('Original');
  await upload(new File(['voice'], 'voice.wav', { type: 'audio/wav' }));
  let closing!: Promise<void>;
  await act(async () => { closing = cancelProfile(); await Promise.resolve(); });
  click('profileForm.source.design');
  await type('profileForm.design.placeholder', '', 'Warm and clear');
  await act(async () => { ControlledFileReader.pending[0].succeed('data:audio/wav;base64,dm9pY2U='); await closing; });
  expect(useUIStore.getState().profileDialogOpen).toBe(true);
  expect(input('profileForm.design.placeholder').props.value).toBe('Warm and clear');
});

test('an old file read failure cannot overwrite a later successful close', async () => {
  controlFileReads();
  await mount();
  await name('First');
  await upload(new File(['first'], 'first.wav', { type: 'audio/wav' }));
  let first!: Promise<void>, second!: Promise<void>;
  await act(async () => { first = cancelProfile(); await Promise.resolve(); });
  await name('Second');
  await upload(new File(['second'], 'second.wav', { type: 'audio/wav' }));
  await act(async () => { second = cancelProfile(); await Promise.resolve(); });
  await act(async () => { ControlledFileReader.pending[1].succeed('data:audio/wav;base64,c2Vjb25k'); await second; });
  await act(async () => { ControlledFileReader.pending[0].fail(); await first; });
  expect(useUIStore.getState().profileFormDraft).toMatchObject({ name: 'Second', sampleFileName: 'second.wav' });
});
