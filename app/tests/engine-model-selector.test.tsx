import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { ModelStatus } from '../src/lib/api/types';

const pass = ({ children }: { children: ReactNode }) => <>{children}</>;
mock.module('../src/components/ui/form', () => ({ FormControl: pass }));
mock.module('../src/components/ui/select', () => ({
  Select: (props: any) => createElement('selector', props),
  SelectContent: pass,
  SelectItem: (props: any) => createElement('option', props),
  SelectTrigger: pass,
  SelectValue: () => null,
}));
const modelInventory = new Map<string, ModelStatus>();
let variantsLoading = false;
const download = mock((_model: ModelStatus) => {});
mock.module('../src/lib/hooks/useAvailableTtsModels', () => ({
  useAvailableTtsModels: () => ({
    models: modelInventory,
    download,
    startingDownload: false,
    loading: variantsLoading,
  }),
}));
function advertise(modelName: string) {
  modelInventory.set(modelName, {
    model_name: modelName,
    display_name: modelName,
    downloaded: false,
    downloading: false,
    loaded: false,
  });
}
const { EngineModelSelector, isProfileCompatibleWithEngine } = await import(
  '../src/components/Generation/EngineModelSelector'
);
let form: any;
let view: ReactTestRenderer;
function Harness({ profile, engine = 'qwen', size = '1.7B', language = 'fr' }: any) {
  form = useForm({ defaultValues: { engine, modelSize: size, language } });
  return <EngineModelSelector form={form} selectedProfile={profile} />;
}
function mount(props: any = {}) {
  act(() => {
    view = create(<Harness {...props} />);
  });
}
function values() {
  return view.root.findAllByType('option').map((item) => item.props.value);
}
function choose(value: string) {
  act(() => view.root.findByType('selector' as never).props.onValueChange(value));
}
afterEach(() => {
  modelInventory.clear();
  download.mockClear();
  variantsLoading = false;
  if (view) act(() => view.unmount());
});
afterAll(() => mock.restore());

test('voice types restrict the offered engines and preserve compatible selection', () => {
  mount({
    profile: { voice_type: 'preset', preset_engine: 'qwen_custom_voice' },
    engine: 'qwen_custom_voice',
    size: '0.6B',
  });
  expect(values()).toEqual(['qwen_custom_voice:1.7B', 'qwen_custom_voice:0.6B']);
  expect(form.getValues('modelSize')).toBe('0.6B');
  expect(
    isProfileCompatibleWithEngine({ voice_type: 'designed' } as any, 'qwen_voice_design'),
  ).toBe(true);
  expect(isProfileCompatibleWithEngine({ voice_type: 'cloned' } as any, 'kokoro')).toBe(false);
});

test('unknown legacy voice types follow cloned-voice engine restrictions', () => {
  expect(isProfileCompatibleWithEngine({ voice_type: 'legacy' } as any, 'kokoro')).toBe(false);
  expect(isProfileCompatibleWithEngine({ voice_type: 'legacy' } as any, 'qwen')).toBe(true);
});

test('a profile change switches an incompatible engine to a compatible one', () => {
  mount({ profile: { voice_type: 'cloned' }, engine: 'qwen' });
  expect(values()).not.toContain('kokoro');
  act(() => view.update(<Harness profile={{ voice_type: 'preset', preset_engine: 'kokoro' }} />));
  expect(form.getValues('engine')).toBe('kokoro');
  expect(values()).toEqual(['kokoro']);
});

test('an invalid size falls back within the selected engine', () => {
  mount({ profile: { voice_type: 'cloned' }, engine: 'tada', size: '1.7B' });
  expect(form.getValues('engine')).toBe('tada');
  expect(form.getValues('modelSize')).toBe('1B');
});

test('an externally selected English-only model corrects an incompatible saved language', () => {
  mount({ engine: 'tada', size: '1B', language: 'fr' });
  expect(form.getValues()).toMatchObject({ engine: 'tada', modelSize: '1B', language: 'en' });
});

test('engine and model selection preserve supported languages and reset unsupported ones', () => {
  mount({ language: 'fr' });
  choose('tada:3B');
  expect(form.getValues()).toMatchObject({ engine: 'tada', modelSize: '3B', language: 'fr' });
  choose('tada:1B');
  expect(form.getValues()).toMatchObject({ engine: 'tada', modelSize: '1B', language: 'en' });
  choose('qwen_custom_voice:0.6B');
  expect(form.getValues()).toMatchObject({
    engine: 'qwen_custom_voice',
    modelSize: '0.6B',
    language: 'en',
  });
  choose('chatterbox_turbo');
  expect(form.getValues()).toMatchObject({ engine: 'chatterbox_turbo', language: 'en' });
});

test('CPU MOSS cloning is selectable for cloned voices and never offered as a preset', () => {
  mount({ profile: { voice_type: 'cloned' }, engine: 'qwen' });
  expect(values()).toContain('moss_tts');
  choose('moss_tts');
  expect(form.getValues('engine')).toBe('moss_tts');
  expect(
    isProfileCompatibleWithEngine(
      { voice_type: 'preset', preset_engine: 'kokoro' } as any,
      'moss_tts',
    ),
  ).toBe(false);
});

test('quantized variants require matching advertisement by the connected server', () => {
  advertise('qwen-tts-1.7B-8bit');
  mount({ profile: { voice_type: 'cloned' } });
  expect(values()).toContain('qwen:1.7B-8bit');
  expect(values()).not.toContain('qwen:1.7B-4bit');
  choose('qwen:1.7B-8bit');
  expect(form.getValues('modelSize')).toBe('1.7B-8bit');
});

test('a saved quantized selection waits for discovery rather than silently switching precision', () => {
  variantsLoading = true;
  mount({ engine: 'qwen', size: '1.7B-4bit' });
  expect(form.getValues('modelSize')).toBe('1.7B-4bit');
  variantsLoading = false;
  act(() => view.update(<Harness engine="qwen" size="1.7B-4bit" />));
  expect(form.getValues('modelSize')).toBe('1.7B');
});

test('model options identify accelerator support and distinguish CPU-only and MLX-only engines', () => {
  advertise('qwen-tts-1.7B-4bit');
  mount();
  const optionDetails = (value: string) =>
    view.root
      .findAllByType('option')
      .find((option) => option.props.value === value)!
      .findAllByType('span')
      .at(-1)
      ?.children.join('');
  expect(optionDetails('qwen:1.7B')).toBe('Metal (MLX), CUDA, ROCm, Intel XPU, DirectML');
  expect(optionDetails('luxtts')).toBe('Metal (MPS), CUDA, ROCm, Intel XPU');
  expect(optionDetails('tada:1B')).toBe('CUDA, ROCm, Intel XPU');
  expect(optionDetails('moss_tts')).toBe('CPU');
  expect(optionDetails('qwen:1.7B-4bit')).toBe('Metal (MLX) · Available to download');
});

test('the composer downloads the exact selected variant and hides the action once downloaded', () => {
  const model: ModelStatus = {
    model_name: 'qwen-tts-1.7B-4bit',
    display_name: 'Qwen 4-bit',
    downloaded: false,
    downloading: false,
    loaded: false,
  };
  modelInventory.set(model.model_name, model);
  mount();
  choose('qwen:1.7B-4bit');
  const button = () =>
    view.root
      .findAllByType('button')
      .find((candidate) => candidate.children.includes('Download model'));
  expect(button()?.props.type).toBe('button');
  act(() => button()?.props.onClick());
  expect(download).toHaveBeenCalledWith(model);

  modelInventory.set(model.model_name, { ...model, downloading: true });
  act(() => view.update(<Harness />));
  expect(button()).toBeUndefined();
  expect(view.root.findByType('output').children).toEqual(['Downloading model…']);

  modelInventory.set(model.model_name, { ...model, downloaded: true });
  act(() => view.update(<Harness />));
  expect(button()).toBeUndefined();
  expect(view.root.findAllByType('output')).toHaveLength(0);
});
