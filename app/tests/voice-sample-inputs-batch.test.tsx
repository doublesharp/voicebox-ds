import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, params?: any) => params?.time ? `${key}:${params.time}` : params?.name ? `${key}:${params.name}` : key }) }));
mock.module('../src/components/ui/button', () => ({ Button: (props: any) => <button {...props} /> }));
mock.module('../src/components/ui/checkbox', () => ({ Checkbox: (props: any) => <test-checkbox {...props} /> }));
const pass = ({ children }: any) => <>{children}</>;
mock.module('../src/components/ui/form', () => ({ FormControl: pass, FormItem: pass, FormMessage: () => null }));
mock.module('../src/components/MicrophoneSelector/MicrophoneSelector', () => ({ MicrophoneSelector: (props: any) => <test-microphone {...props} /> }));
mock.module('react-sound-visualizer', () => ({ Visualizer: ({ children }: any) => children({ canvasRef: null }) }));
let clean = false;
const setClean = mock((value: boolean) => { clean = value; });
mock.module('../src/stores/microphoneStore', () => ({ useMicrophoneStore: (select: any) => select({ cleanReferenceAudio: clean, setCleanReferenceAudio: setClean }) }));
const { AudioSampleUpload } = await import('../src/components/VoiceProfiles/AudioSampleUpload');
const { AudioSampleRecording } = await import('../src/components/VoiceProfiles/AudioSampleRecording');
const { AudioSampleSystem } = await import('../src/components/VoiceProfiles/AudioSampleSystem');
let view: ReactTestRenderer | undefined;
const clickInput = mock(() => {});
let inputNode: any;
const createView = async (element: React.ReactElement) => { await act(async () => { view = create(element, { createNodeMock: (element) => element.type === 'input' ? inputNode : null }); }); };
const fakeFile = (name = 'voice.wav', type = 'audio/wav') => ({ name, type }) as File;
const text = () => JSON.stringify(view!.toJSON());
const buttons = () => view!.root.findAllByType('button');
const button = (name: string) => buttons().find((b) => b.children.some((child) => typeof child === 'string' && child.includes(name)))!;
const callbacks = () => ({ onStart: mock(() => {}), onStop: mock(() => {}), onCancel: mock(() => {}), onTranscribe: mock(() => {}), onPlayPause: mock(() => {}) });
const uploadProps = () => ({ file: null, fieldName: 'sample', onFileChange: mock((_file: File | undefined) => {}), onTranscribe: mock(() => {}), onPlayPause: mock(() => {}), isPlaying: false });
beforeEach(() => { clean = false; setClean.mockClear(); clickInput.mockClear(); inputNode = { click: clickInput, value: 'old' }; });
afterEach(() => { if (view) act(() => view?.unmount()); view = undefined; });
afterAll(() => mock.restore());

test('upload chooser supports selection and clearing the input', async () => {
  const p = uploadProps(); await createView(<AudioSampleUpload {...p} />);
  act(() => button('audioSample.chooseFile').props.onClick()); expect(clickInput).toHaveBeenCalledTimes(1);
  act(() => view!.root.findByType('input').props.onChange({ target: { files: [fakeFile()] } })); expect(p.onFileChange).toHaveBeenLastCalledWith(fakeFile());
  act(() => view!.root.findByType('input').props.onChange({ target: { files: [] } })); expect(p.onFileChange).toHaveBeenLastCalledWith(undefined);
  await act(async () => view!.update(<AudioSampleUpload {...p} file={fakeFile()} />));
  act(() => button('audioSample.remove').props.onClick()); expect(p.onFileChange).toHaveBeenLastCalledWith(undefined); expect(inputNode.value).toBe('');
});

test('drop accepts audio only and updates drag state', async () => {
  const p = uploadProps(); await createView(<AudioSampleUpload {...p} />); const drop = () => view!.root.findByProps({ role: 'button' }); const preventDefault = mock(() => {});
  act(() => drop().props.onDragOver({ preventDefault })); expect(drop().props.className).toContain('border-primary');
  act(() => drop().props.onDrop({ preventDefault, dataTransfer: { files: [fakeFile('image.png', 'image/png')] } })); expect(p.onFileChange).not.toHaveBeenCalled();
  act(() => drop().props.onDrop({ preventDefault, dataTransfer: { files: [fakeFile()] } })); expect(p.onFileChange).toHaveBeenCalledWith(fakeFile());
  act(() => drop().props.onDragLeave({ preventDefault })); expect(drop().props.className).toContain('border-dashed');
});

test('drop zone keyboard activation ignores nested controls', async () => {
  const p = uploadProps(); await createView(<AudioSampleUpload {...p} file={fakeFile()} />); const drop = view!.root.findByProps({ role: 'button' }); const preventDefault = mock(() => {}); const container = {};
  act(() => drop.props.onKeyDown({ key: 'Enter', target: {}, currentTarget: container, preventDefault }));
  expect(clickInput).not.toHaveBeenCalled(); expect(preventDefault).not.toHaveBeenCalled();
  act(() => drop.props.onKeyDown({ key: ' ', target: container, currentTarget: container, preventDefault })); expect(clickInput).toHaveBeenCalledTimes(1);
});

test('upload disables playback while validating and transcription while unavailable', async () => {
  const p = uploadProps(); await createView(<AudioSampleUpload {...p} file={fakeFile()} isPlaying isValidating isTranscribing />);
  expect(view!.root.findByProps({ 'aria-label': 'audioSample.pause' }).props.disabled).toBe(true);
  expect(button('audioSample.transcribing').props.disabled).toBe(true);
  await act(async () => view!.update(<AudioSampleUpload {...p} file={fakeFile()} isDisabled />));
  expect(button('audioSample.transcribe').props.disabled).toBe(true);
});

test.each(['recording', 'system'] as const)('%s input transitions through start, recording and completed states', async (kind) => {
  const c = callbacks(); const Component = kind === 'recording' ? AudioSampleRecording : AudioSampleSystem;
  await createView(<Component {...c} file={null} isRecording={false} duration={0} isPlaying={false} />);
  act(() => button(kind === 'recording' ? 'audioSample.startRecording' : 'audioSample.startCapture').props.onClick()); expect(c.onStart).toHaveBeenCalledTimes(1);
  await act(async () => view!.update(<Component {...c} file={null} isRecording duration={12} isPlaying={false} />));
  expect(text()).toContain('0:12'); expect(text()).toContain('audioSample.remaining:0:18');
  act(() => button(kind === 'recording' ? 'audioSample.stopRecording' : 'audioSample.stopCapture').props.onClick()); expect(c.onStop).toHaveBeenCalledTimes(1);
  await act(async () => view!.update(<Component {...c} file={fakeFile()} isRecording={false} duration={12} isPlaying={false} />));
  act(() => view!.root.findByProps({ 'aria-label': 'audioSample.play' }).props.onClick()); act(() => button('audioSample.transcribe').props.onClick()); act(() => button(kind === 'recording' ? 'audioSample.recordAgain' : 'audioSample.captureAgain').props.onClick());
  expect(c.onPlayPause).toHaveBeenCalledTimes(1); expect(c.onTranscribe).toHaveBeenCalledTimes(1); expect(c.onCancel).toHaveBeenCalledTimes(1);
});

test('recording keeps the processing preference and disables input controls during startup', async () => {
  clean = true; const c = callbacks(); await createView(<AudioSampleRecording {...c} file={null} isRecording={false} isStarting duration={0} isPlaying={false} />);
  expect(view!.root.findByType('test-microphone' as never).props.disabled).toBe(true); expect(button('audioSample.startRecording').props.disabled).toBe(true); expect(view!.root.findByType('test-checkbox' as never).props).toMatchObject({ checked: true, disabled: true });
});

test('recording displays startup failures and fallback notices', async () => {
  const c = callbacks(); await createView(<AudioSampleRecording {...c} file={null} isRecording={false} duration={0} isPlaying={false} recordingError="Microphone unavailable" usingDefaultMicrophone />);
  expect(view!.root.findByProps({ role: 'alert' }).children.join('')).toBe('Microphone unavailable'); expect(text()).toContain('microphone.fallbackNotice');
});

test.each(['recording', 'system'] as const)('%s completed state exposes pause and disables pending transcription', async (kind) => {
  const c = callbacks(); const Component = kind === 'recording' ? AudioSampleRecording : AudioSampleSystem;
  await createView(<Component {...c} file={fakeFile()} isRecording={false} duration={1} isPlaying isTranscribing />);
  expect(view!.root.findByProps({ 'aria-label': 'audioSample.pause' })).toBeDefined(); expect(button('audioSample.transcribing').props.disabled).toBe(true);
});
