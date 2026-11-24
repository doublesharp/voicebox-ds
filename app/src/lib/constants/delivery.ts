import type { VoiceProfileResponse } from '@/lib/api/types';
import type { GenerationFormValues } from '@/lib/hooks/useGenerationForm';
import type { UseFormReturn } from 'react-hook-form';
import { ENGINE_LANGUAGES, type LanguageCode } from './languages';

export const DELIVERY_PRESETS = ['natural', 'upbeat', 'excited'] as const;
export type DeliveryPreset = (typeof DELIVERY_PRESETS)[number];

export const DELIVERY_PARAMETERS = {
  natural: { chatterboxCfgWeight: undefined, chatterboxExaggeration: undefined },
  upbeat: { chatterboxCfgWeight: 0.3, chatterboxExaggeration: 0.7 },
  excited: { chatterboxCfgWeight: 0.3, chatterboxExaggeration: 0.8 },
} satisfies Record<
  DeliveryPreset,
  Pick<GenerationFormValues, 'chatterboxCfgWeight' | 'chatterboxExaggeration'>
>;

export function applyDelivery(form: UseFormReturn<GenerationFormValues>, preset: DeliveryPreset) {
  if (preset !== 'natural' && form.getValues('engine') !== 'chatterbox') {
    form.setValue('engine', 'chatterbox');
    form.setValue('modelSize', undefined);
  }
  const { chatterboxCfgWeight, chatterboxExaggeration } = DELIVERY_PARAMETERS[preset];
  form.setValue('chatterboxCfgWeight', chatterboxCfgWeight);
  form.setValue('chatterboxExaggeration', chatterboxExaggeration);
}

export function supportsExpressiveDelivery(
  voice: VoiceProfileResponse | undefined,
  language: LanguageCode,
): boolean {
  return voice?.voice_type === 'cloned' && ENGINE_LANGUAGES.chatterbox.includes(language);
}

export function selectedDelivery(
  engine: GenerationFormValues['engine'],
  guidance?: number,
  expression?: number,
): DeliveryPreset | 'custom' {
  if (engine !== 'chatterbox') return 'natural';
  return (
    DELIVERY_PRESETS.find((preset) => {
      const parameters = DELIVERY_PARAMETERS[preset];
      return (
        parameters.chatterboxCfgWeight === guidance &&
        parameters.chatterboxExaggeration === expression
      );
    }) ?? 'custom'
  );
}

const MAX_PREVIEW_CHARACTERS = 240;

/** Keep a preview to the opening sentence or line, with a ceiling for long passages. */
export function previewSentence(script: string): string {
  const prefix = Array.from(script.trim()).slice(0, MAX_PREVIEW_CHARACTERS).join('');
  return prefix.match(/^[\s\S]*?(?:[.!?]+["'’”)]*(?=\s|$)|[。！？]+|\r?\n)/)?.[0].trim() ?? prefix;
}
