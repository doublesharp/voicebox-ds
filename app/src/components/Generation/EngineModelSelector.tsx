import { useEffect } from 'react';
import type { UseFormReturn } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { FormControl } from '@/components/ui/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { VoiceProfileResponse } from '@/lib/api/types';
import { getLanguageOptionsForEngine } from '@/lib/constants/languages';
import { getModelAcceleration, TTS_MODEL_OPTIONS } from '@/lib/constants/ttsModels';
import { useAvailableTtsModels } from '@/lib/hooks/useAvailableTtsModels';
import type { GenerationFormValues } from '@/lib/hooks/useGenerationForm';

const ENGINE_DESCRIPTIONS: Record<string, string> = {
  qwen: 'Multi-language, two sizes',
  qwen_custom_voice: '9 preset voices, instruct control',
  qwen_voice_design: 'Voices described in plain language',
  moss_tts: 'CPU voice cloning, multiple languages',
  luxtts: 'Fast, English-focused',
  chatterbox: '23 languages, incl. Hebrew',
  chatterbox_turbo: 'English, [laugh] [cough] tags',
  tada: 'HumeAI, 700s+ coherent audio',
  kokoro: '82M params, CPU realtime, 8 langs',
  omnivoice: '23 languages, voice design. CC-BY-NC weights: non-commercial use only',
};

/** Engines that only support English and should force language to 'en' on select. */
const ENGLISH_ONLY_ENGINES = new Set(['luxtts', 'chatterbox_turbo']);

/** Engines that support cloned (reference audio) profiles. */
const CLONING_ENGINES = new Set([
  'qwen',
  'luxtts',
  'chatterbox',
  'chatterbox_turbo',
  'tada',
  'omnivoice',
  'moss_tts',
]);

/** Engines that synthesise a voice from a written description. */
export const DESIGN_ENGINES = new Set(['qwen_voice_design']);

function getSelectValue(engine: string, modelSize?: string): string {
  if (engine === 'qwen') return `qwen:${modelSize || '1.7B'}`;
  if (engine === 'qwen_custom_voice') return `qwen_custom_voice:${modelSize || '1.7B'}`;
  if (engine === 'tada') return `tada:${modelSize || '1B'}`;
  return engine;
}

export function applyEngineSelection(form: UseFormReturn<GenerationFormValues>, value: string) {
  if (value.startsWith('qwen_custom_voice:')) {
    const [, modelSize] = value.split(':');
    form.setValue('engine', 'qwen_custom_voice');
    form.setValue('modelSize', modelSize as '1.7B' | '0.6B' | '1.7B-8bit' | '1.7B-4bit');
    const currentLang = form.getValues('language');
    const available = getLanguageOptionsForEngine('qwen_custom_voice');
    if (!available.some((l) => l.value === currentLang)) {
      form.setValue('language', available[0]?.value ?? 'en');
    }
  } else if (value.startsWith('qwen:')) {
    const [, modelSize] = value.split(':');
    form.setValue('engine', 'qwen');
    form.setValue('modelSize', modelSize as '1.7B' | '0.6B' | '1.7B-8bit' | '1.7B-4bit');
    // Validate language is supported by Qwen
    const currentLang = form.getValues('language');
    const available = getLanguageOptionsForEngine('qwen');
    if (!available.some((l) => l.value === currentLang)) {
      form.setValue('language', available[0]?.value ?? 'en');
    }
  } else if (value.startsWith('tada:')) {
    const [, modelSize] = value.split(':');
    form.setValue('engine', 'tada');
    form.setValue('modelSize', modelSize as '1B' | '3B');
    // TADA 1B is English-only; 3B is multilingual
    if (modelSize === '1B') {
      form.setValue('language', 'en');
    } else {
      const currentLang = form.getValues('language');
      const available = getLanguageOptionsForEngine('tada', modelSize);
      if (!available.some((l) => l.value === currentLang)) {
        form.setValue('language', available[0]?.value ?? 'en');
      }
    }
  } else {
    form.setValue('engine', value as GenerationFormValues['engine']);
    form.setValue('modelSize', undefined as unknown as '1.7B' | '0.6B');
    if (ENGLISH_ONLY_ENGINES.has(value)) {
      form.setValue('language', 'en');
    } else {
      // If current language isn't supported by the new engine, reset to first available
      const currentLang = form.getValues('language');
      const available = getLanguageOptionsForEngine(value);
      if (!available.some((l) => l.value === currentLang)) {
        form.setValue('language', available[0]?.value ?? 'en');
      }
    }
  }
}

interface EngineModelSelectorProps {
  form: UseFormReturn<GenerationFormValues>;
  compact?: boolean;
  selectedProfile?: VoiceProfileResponse | null;
}

export function EngineModelSelector({ form, compact, selectedProfile }: EngineModelSelectorProps) {
  const engine = form.watch('engine') || 'qwen';
  const modelSize = form.watch('modelSize');
  const language = form.watch('language');
  const selectValue = getSelectValue(engine, modelSize);
  const discovered = useAvailableTtsModels();
  const availableOptions = TTS_MODEL_OPTIONS.filter(
    (option) =>
      (!option.optional || discovered.models.has(option.modelName)) &&
      (!selectedProfile || isProfileCompatibleWithEngine(selectedProfile, option.engine)),
  );
  const selectedOption = availableOptions.find((option) => option.value === selectValue);
  const selectedModel = selectedOption && discovered.models.get(selectedOption.modelName);

  const currentEngineAvailable = !!selectedOption;

  useEffect(() => {
    if (
      discovered.loading &&
      engine === 'qwen' &&
      modelSize?.endsWith('bit') &&
      (!selectedProfile || isProfileCompatibleWithEngine(selectedProfile, engine))
    )
      return;
    if (!currentEngineAvailable && availableOptions.length > 0) {
      const fallback =
        availableOptions.find((option) => option.engine === engine) ?? availableOptions[0];
      applyEngineSelection(form, fallback.value);
      return;
    }
    const languages = getLanguageOptionsForEngine(engine, modelSize);
    if (!languages.some((option) => option.value === language)) {
      form.setValue('language', languages[0]?.value ?? 'en');
    }
  }, [
    availableOptions,
    currentEngineAvailable,
    discovered.loading,
    engine,
    form,
    language,
    modelSize,
    selectedProfile,
  ]);

  const itemClass = compact ? 'text-xs text-muted-foreground' : undefined;
  const triggerClass = compact
    ? 'h-8 text-xs bg-card border-border rounded-full hover:bg-background/50 transition-all'
    : undefined;

  return (
    <>
      <Select value={selectValue} onValueChange={(v) => applyEngineSelection(form, v)}>
        <FormControl>
          <SelectTrigger className={triggerClass}>
            <SelectValue>{selectedOption?.label}</SelectValue>
          </SelectTrigger>
        </FormControl>
        <SelectContent side={compact ? 'top' : undefined} className="max-w-[calc(100vw-2rem)]">
          {availableOptions.map((option) => {
            const model = discovered.models.get(option.modelName);
            const status =
              model &&
              (model.downloading
                ? 'Downloading'
                : model.downloaded
                  ? 'Downloaded'
                  : 'Available to download');
            return (
              <SelectItem
                key={option.value}
                value={option.value}
                textValue={option.label}
                className={itemClass}
              >
                <span className="block">{option.label}</span>
                <span className="block text-xs font-normal text-muted-foreground">
                  {getModelAcceleration(option)}
                  {status && ` · ${status}`}
                </span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      {selectedModel &&
        !selectedModel.downloaded &&
        (selectedModel.downloading ? (
          <output className="block text-xs text-muted-foreground">Downloading model…</output>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={discovered.startingDownload}
            onClick={() => discovered.download(selectedModel)}
          >
            Download model
          </Button>
        ))}
    </>
  );
}

/** Returns a human-readable description for the currently selected engine. */
export function getEngineDescription(engine: string): string {
  return ENGINE_DESCRIPTIONS[engine] ?? '';
}

/**
 * Check if a profile is compatible with the currently selected engine.
 * Useful for UI hints.
 */
export function isProfileCompatibleWithEngine(
  profile: VoiceProfileResponse,
  engine: string,
): boolean {
  const voiceType = profile.voice_type || 'cloned';
  if (voiceType === 'preset') return profile.preset_engine === engine;
  if (voiceType === 'designed') return DESIGN_ENGINES.has(engine);
  return CLONING_ENGINES.has(engine);
}
