import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import * as z from 'zod';
import { useToast } from '@/components/ui/use-toast';
import { apiClient } from '@/lib/api/client';
import type { EffectConfig, GenerationRequest } from '@/lib/api/types';
import { engineSupportsInstruct } from '@/lib/constants/engines';
import { LANGUAGE_CODES, type LanguageCode } from '@/lib/constants/languages';
import { getTtsModelOption } from '@/lib/constants/ttsModels';
import { useGeneration } from '@/lib/hooks/useGeneration';
import { useModelDownloadToast } from '@/lib/hooks/useModelDownloadToast';
import { useGenerationSettings } from '@/lib/hooks/useSettings';
import { useGenerationDraftStore } from '@/stores/generationDraftStore';
import { useGenerationStore } from '@/stores/generationStore';
import { useServerStore } from '@/stores/serverStore';
import { useUIStore } from '@/stores/uiStore';

const generationSchema = z.preprocess(
  (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const data = value as Record<string, unknown>;
    if (data.engine === 'chatterbox') return data;
    // Ignore hidden engine-specific fields before validation as well as before
    // dispatch, including invalid values retained from an earlier engine.
    return {
      ...data,
      chatterboxTemperature: undefined,
      chatterboxCfgWeight: undefined,
      chatterboxExaggeration: undefined,
    };
  },
  z.object({
    text: z.string().min(1, '').max(50000),
    language: z.enum(LANGUAGE_CODES as [LanguageCode, ...LanguageCode[]]),
    seed: z.number().int().optional(),
    modelSize: z.enum(['1.7B', '0.6B', '1B', '3B', '1.7B-8bit', '1.7B-4bit']).optional(),
    instruct: z.string().max(500).optional(),
    engine: z
      .enum([
        'qwen',
        'qwen_custom_voice',
        'qwen_voice_design',
        'luxtts',
        'chatterbox',
        'chatterbox_turbo',
        'tada',
        'kokoro',
        'omnivoice',
        'moss_tts',
      ])
      .optional(),
    personality: z.boolean().optional(),
    speed: z.number().finite().min(0.5).max(2).optional(),
    chatterboxTemperature: z.number().finite().min(0.1).max(1.5).optional(),
    chatterboxCfgWeight: z.number().finite().min(0).max(1).optional(),
    chatterboxExaggeration: z.number().finite().min(0).max(1).optional(),
  }),
);

export type GenerationFormValues = z.infer<typeof generationSchema>;

interface UseGenerationFormOptions {
  onSuccess?: (generationId: string) => void;
  defaultValues?: Partial<GenerationFormValues>;
  getEffectsChain?: () => EffectConfig[] | undefined;
}

export function useGenerationForm(options: UseGenerationFormOptions = {}) {
  const { toast } = useToast();
  const generation = useGeneration();
  const addPendingGeneration = useGenerationStore((state) => state.addPendingGeneration);
  const { settings: genSettings } = useGenerationSettings();
  const maxChunkChars = genSettings?.max_chunk_chars ?? 800;
  const crossfadeMs = genSettings?.crossfade_ms ?? 50;
  const normalizeAudio = genSettings?.normalize_audio ?? true;
  const selectedEngine = useUIStore((state) => state.selectedEngine);
  const isSubmitting = useGenerationDraftStore((state) => state.submitting);
  const [downloadingModelName, setDownloadingModelName] = useState<string | null>(null);
  const [downloadingDisplayName, setDownloadingDisplayName] = useState<string | null>(null);

  useModelDownloadToast({
    modelName: downloadingModelName || '',
    displayName: downloadingDisplayName || '',
    enabled: !!downloadingModelName,
  });

  const form = useForm<GenerationFormValues>({
    resolver: zodResolver(generationSchema),
    defaultValues: {
      text: '',
      language: 'en',
      seed: undefined,
      modelSize: '1.7B',
      instruct: '',
      engine: (selectedEngine as GenerationFormValues['engine']) || 'qwen',
      personality: false,
      speed: 1,
      ...options.defaultValues,
      ...useGenerationDraftStore.getState().values,
    },
  });

  useEffect(() => {
    const draft = useGenerationDraftStore.getState();
    if (!draft.values) draft.setValues(form.getValues());
    const watch = form.watch(() => useGenerationDraftStore.getState().setValues(form.getValues()));
    const unsubscribe = useGenerationDraftStore.subscribe((state) => {
      if (state.values && state.values.text !== form.getValues('text')) {
        form.setValue('text', state.values.text);
      }
    });
    return () => {
      watch.unsubscribe();
      unsubscribe();
    };
  }, [form]);

  function generationRequest(data: GenerationFormValues, profileId: string): GenerationRequest {
    const engine = data.engine || 'qwen';
    const { modelSize } = getTtsModelOption(engine, data.modelSize);
    return {
      profile_id: profileId,
      text: data.text,
      language: data.language,
      seed: data.seed,
      model_size: modelSize,
      engine,
      instruct: engineSupportsInstruct(engine) ? data.instruct || undefined : undefined,
      personality: data.personality || undefined,
      max_chunk_chars: maxChunkChars,
      crossfade_ms: crossfadeMs,
      normalize: normalizeAudio,
      effects_chain: options.getEffectsChain?.(),
      speed: data.speed ?? 1,
      chatterbox_temperature: engine === 'chatterbox' ? data.chatterboxTemperature : undefined,
      chatterbox_cfg_weight: engine === 'chatterbox' ? data.chatterboxCfgWeight : undefined,
      chatterbox_exaggeration: engine === 'chatterbox' ? data.chatterboxExaggeration : undefined,
    };
  }

  async function handleSubmit(
    data: GenerationFormValues,
    selectedProfileId: string | null,
  ): Promise<void> {
    if (!selectedProfileId) {
      toast({
        title: 'No profile selected',
        description: 'Please select a voice profile from the cards above.',
        variant: 'destructive',
      });
      return;
    }

    const draft = useGenerationDraftStore.getState();
    if (draft.submitting) return;
    const { serverUrl, serverRevision } = useServerStore.getState();
    const serverChanged = () => {
      const current = useServerStore.getState();
      return current.serverUrl !== serverUrl || current.serverRevision !== serverRevision;
    };
    const reportServerChange = (mayHaveStarted: boolean) => {
      toast({
        title: 'Server changed',
        description: mayHaveStarted
          ? 'Generation may continue on the previous server. Your draft was kept.'
          : 'Generation was not started. Your draft was kept.',
        variant: 'destructive',
      });
    };
    draft.setSubmitting(true);
    const textRevision = draft.textRevision;
    let generationDispatched = false;
    try {
      // Capture all request inputs at submission, before the model status request.
      const request = generationRequest(data, selectedProfileId);
      const { modelName, label } = getTtsModelOption(request.engine ?? 'qwen', request.model_size);

      // Check if model needs downloading
      try {
        const modelStatus = await apiClient.getModelStatus();
        if (serverChanged()) {
          reportServerChange(false);
          return;
        }
        const model = modelStatus.models.find((m) => m.model_name === modelName);

        if (model && !model.downloaded) {
          setDownloadingModelName(modelName);
          setDownloadingDisplayName(label);
        }
      } catch (error) {
        console.error('Failed to check model status:', error);
      }

      if (serverChanged()) {
        reportServerChange(false);
        return;
      }

      // This now returns immediately with status="generating"
      generationDispatched = true;
      const result = await generation.mutateAsync(request);

      if (serverChanged()) {
        reportServerChange(true);
        return;
      }

      // Track this generation for SSE status updates
      addPendingGeneration(result.id);

      useGenerationDraftStore.getState().clearSubmittedText(textRevision, data.text);
      options.onSuccess?.(result.id);
    } catch (error) {
      if (serverChanged()) {
        reportServerChange(generationDispatched);
        return;
      }
      toast({
        title: 'Generation failed',
        description: error instanceof Error ? error.message : 'Failed to generate audio',
        variant: 'destructive',
      });
    } finally {
      useGenerationDraftStore.getState().setSubmitting(false);
      setDownloadingModelName(null);
      setDownloadingDisplayName(null);
    }
  }

  return {
    form,
    handleSubmit,
    generationRequest,
    isPending: generation.isPending || isSubmitting,
  };
}
