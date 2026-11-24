import { useMutation, useQuery } from '@tanstack/react-query';
import { useMatchRoute } from '@tanstack/react-router';
import { Dices, Headphones, Loader2, SlidersHorizontal, Sparkles, Wand2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Hint } from '@/components/ui/Hint';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/use-toast';
import { apiClient } from '@/lib/api/client';
import { useSpeechPreview } from '@/lib/audio/useSpeechPreview';
import {
  applyDelivery,
  DELIVERY_PARAMETERS,
  DELIVERY_PRESETS,
  type DeliveryPreset,
  previewSentence,
  selectedDelivery,
  supportsExpressiveDelivery,
} from '@/lib/constants/delivery';
import { engineSupportsInstruct } from '@/lib/constants/engines';
import { getLanguageOptionsForEngine, type LanguageCode } from '@/lib/constants/languages';
import { getTtsModelOption } from '@/lib/constants/ttsModels';
import { type GenerationFormValues, useGenerationForm } from '@/lib/hooks/useGenerationForm';
import {
  currentServerScope,
  isCurrentServer,
  requireCurrentServer,
  type ServerScope,
} from '@/lib/serverScope';
import { useProfile, useProfiles } from '@/lib/hooks/useProfiles';
import { useStory } from '@/lib/hooks/useStories';
import { cn } from '@/lib/utils/cn';
import { useGenerationDraftStore } from '@/stores/generationDraftStore';
import { useGenerationStore } from '@/stores/generationStore';
import { useServerStore } from '@/stores/serverStore';
import { useStoryStore } from '@/stores/storyStore';
import { useUIStore } from '@/stores/uiStore';
import { useVoiceDeliveryStore, voiceDeliveryDefaults } from '@/stores/voiceDeliveryStore';
import { EngineModelSelector } from './EngineModelSelector';
import { ParalinguisticInput } from './ParalinguisticInput';
import { SpeechSettings } from './SpeechSettings';

interface FloatingGenerateBoxProps {
  layout?: 'docked' | 'floating';
  showVoiceSelector?: boolean;
}

export function FloatingGenerateBox({
  layout = 'floating',
  showVoiceSelector = false,
}: FloatingGenerateBoxProps) {
  const { t } = useTranslation();
  const floating = layout === 'floating';
  const serverUrl = useServerStore((state) => state.serverUrl);
  const serverRevision = useServerStore((state) => state.serverRevision);
  const selectedProfileId = useUIStore((state) => state.selectedProfileId);
  const setSelectedProfileId = useUIStore((state) => state.setSelectedProfileId);
  const setSelectedEngine = useUIStore((state) => state.setSelectedEngine);
  const { data: selectedProfile } = useProfile(selectedProfileId || '');
  const { data: profiles } = useProfiles();
  const [isExpanded, setIsExpanded] = useState(false);
  const [isInstructExpanded, setIsInstructExpanded] = useState(false);
  const selectedPresetId = useGenerationDraftStore((state) => state.presetId);
  const draftProfileId = useGenerationDraftStore((state) => state.profileId);
  const draftServerRevision = useGenerationDraftStore((state) => state.profileServerRevision);
  const profileApplied = useGenerationDraftStore((state) => state.profileApplied);
  const setSelectedPresetId = useGenerationDraftStore((state) => state.setPresetId);
  const voiceoverPolish = useGenerationDraftStore((state) => state.voiceoverPolish);
  const setVoiceoverPolish = useGenerationDraftStore((state) => state.setVoiceoverPolish);
  const savedDelivery = useVoiceDeliveryStore((state) =>
    selectedProfileId
      ? voiceDeliveryDefaults(state.defaults, serverUrl, selectedProfileId)
      : undefined,
  );
  const mountedRef = useRef(false);
  const profileIdentity = useRef({ id: selectedProfileId, revision: 0 });
  if (profileIdentity.current.id !== selectedProfileId) {
    profileIdentity.current = {
      id: selectedProfileId,
      revision: profileIdentity.current.revision + 1,
    };
  }
  useEffect(() => {
    mountedRef.current = true;
    const unsubscribe = useUIStore.subscribe((state) => {
      if (profileIdentity.current.id !== state.selectedProfileId) {
        profileIdentity.current = {
          id: state.selectedProfileId,
          revision: profileIdentity.current.revision + 1,
        };
      }
    });
    return () => {
      mountedRef.current = false;
      unsubscribe();
    };
  }, []);
  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const matchRoute = useMatchRoute();
  const isStoriesRoute = matchRoute({ to: '/stories' });
  const selectedStoryId = useStoryStore((state) => state.selectedStoryId);
  const trackEditorHeight = useStoryStore((state) => state.trackEditorHeight);
  const { data: currentStory } = useStory(selectedStoryId);
  const addPendingStoryAdd = useGenerationStore((s) => s.addPendingStoryAdd);
  const { toast } = useToast();
  const [previewMode, setPreviewMode] = useState<'selected' | 'natural'>('selected');
  const preview = useSpeechPreview(selectedProfileId, (description) => {
    toast({ title: t('generation.delivery.previewFailed'), description, variant: 'destructive' });
  });

  const composeMutation = useMutation({
    mutationFn: ({ profileId, scope }: { profileId: string; scope: ServerScope }) => {
      requireCurrentServer(scope);
      return apiClient.composeWithPersonality(profileId);
    },
    onError: (err: Error, { scope }) => {
      if (!isCurrentServer(scope)) return;
      toast({
        title: t('generation.compose.failedTitle'),
        description: err.message || t('generation.compose.failedDescription'),
        variant: 'destructive',
      });
    },
  });

  // Fetch effect presets for the dropdown
  const { data: effectPresets } = useQuery({
    queryKey: ['effect-presets', serverUrl, serverRevision],
    queryFn: () => {
      requireCurrentServer({ serverUrl, serverRevision });
      return apiClient.listEffectPresets();
    },
  });
  const voiceoverPreset = effectPresets?.find(
    (preset) => preset.is_builtin && preset.name === 'YouTube Narration',
  );
  const polishOn =
    voiceoverPolish || (!!voiceoverPreset && selectedPresetId === voiceoverPreset.id);
  const modelStatus = useQuery({
    queryKey: ['modelStatus', serverUrl, serverRevision],
    queryFn: () => {
      requireCurrentServer({ serverUrl, serverRevision });
      return apiClient.getModelStatus();
    },
    enabled: !floating,
    retry: false,
  });

  // Calculate if track editor is visible (on stories route with items)
  const hasTrackEditor = isStoriesRoute && currentStory && currentStory.items.length > 0;

  const { form, handleSubmit, generationRequest, isPending } = useGenerationForm({
    onSuccess: async (generationId) => {
      setIsExpanded(false);
      // Defer the story add until TTS completes -- useGenerationProgress handles it
      if (isStoriesRoute && selectedStoryId && generationId) {
        addPendingStoryAdd(generationId, selectedStoryId);
      }
    },
    getEffectsChain: () => {
      const draft = useGenerationDraftStore.getState();
      if (draft.voiceoverPolish) {
        if (voiceoverPreset) return voiceoverPreset.effects_chain;
        throw new Error(t('generation.delivery.polishUnavailable'));
      }
      if (!draft.effectsOverridden) {
        if (!selectedProfile || selectedProfile.id !== selectedProfileId)
          throw new Error('Voice defaults are still loading. Try again in a moment.');
        return selectedProfile.effects_chain ?? [];
      }
      // An empty chain explicitly disables effects; omission asks the backend
      // to apply voice defaults, which would contradict the None selection.
      if (!draft.presetId) return [];
      // Profile's own effects chain (no matching preset)
      if (draft.presetId === '_profile') {
        if (!selectedProfile || selectedProfile.id !== selectedProfileId)
          throw new Error('Voice defaults are still loading. Try again in a moment.');
        return selectedProfile.effects_chain ?? [];
      }
      if (!effectPresets)
        throw new Error('Effect presets are still loading. Try again in a moment.');
      const preset = effectPresets.find((p) => p.id === draft.presetId);
      if (!preset)
        throw new Error('The selected effect preset is unavailable. Choose another preset.');
      return preset.effects_chain;
    },
  });

  // Click away handler to collapse the box
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as HTMLElement;

      // Don't collapse if clicking inside the container
      if (containerRef.current?.contains(target)) {
        return;
      }

      // Don't collapse if clicking on a Select dropdown (which renders in a portal)
      if (
        target.closest('[role="listbox"]') ||
        target.closest('[data-radix-popper-content-wrapper]')
      ) {
        return;
      }

      setIsExpanded(false);
    }

    if (layout === 'floating' && isExpanded) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isExpanded, layout]);

  // Set first voice as default if none selected
  useEffect(() => {
    if (!selectedProfileId && profiles && profiles.length > 0) {
      setSelectedProfileId(profiles[0].id);
    }
  }, [selectedProfileId, profiles, setSelectedProfileId]);

  // Sync engine selection to global store so ProfileList can filter
  const watchedEngine = form.watch('engine');
  useEffect(() => {
    if (watchedEngine) {
      setSelectedEngine(watchedEngine);
    }
  }, [watchedEngine, setSelectedEngine]);

  // Apply defaults once for each selected profile, not on refetch or remount.
  useEffect(() => {
    const draft = useGenerationDraftStore.getState();
    draft.selectProfile(selectedProfileId, serverRevision);
    if (draft.profileId !== selectedProfileId || draft.profileServerRevision !== serverRevision)
      applyDelivery(form, 'natural');
    const currentDraft = useGenerationDraftStore.getState();
    if (
      !selectedProfileId ||
      selectedProfile?.id !== selectedProfileId ||
      currentDraft.profileApplied
    )
      return;
    const baseline = currentDraft.profileDefaultsBaseline;
    const engineUnchanged = !baseline || baseline.engine === form.getValues('engine');
    const languageUnchanged = !baseline || baseline.language === form.getValues('language');
    if (selectedProfile?.language && languageUnchanged) {
      form.setValue('language', selectedProfile.language as LanguageCode);
    }
    // Auto-switch engine to match the profile and restore valid default modelSize.
    const defaultSizeForEngine = (targetEngine: GenerationFormValues['engine']) => {
      if (targetEngine === 'qwen' || targetEngine === 'qwen_custom_voice') return '1.7B' as const;
      if (targetEngine === 'tada') return '1B' as const;
      return undefined;
    };
    const engine = selectedProfile?.default_engine ?? selectedProfile?.preset_engine;
    if (engine && engineUnchanged) {
      const target = engine as GenerationFormValues['engine'];
      form.setValue('engine', target);
      const nextSize = defaultSizeForEngine(target);
      if (nextSize !== undefined || form.getValues('modelSize') !== undefined) {
        form.setValue('modelSize', nextSize);
      }
    } else if (
      engineUnchanged &&
      selectedProfile &&
      selectedProfile.voice_type !== 'preset' &&
      selectedProfile.voice_type !== 'designed'
    ) {
      // Cloned profile with no default — ensure a compatible (non-preset) engine.
      // Designed profiles are excluded: they always carry a design engine and
      // would be broken by a fallback to qwen.
      const currentEngine = form.getValues('engine');
      const presetEngines = new Set(['kokoro', 'qwen_custom_voice', 'qwen_voice_design']);
      if (currentEngine && presetEngines.has(currentEngine)) {
        form.setValue('engine', 'qwen');
        if (!form.getValues('modelSize')) {
          form.setValue('modelSize', '1.7B');
        }
      }
    }
    // Persona toggle only applies when the profile has a personality prompt.
    if (selectedProfile && !selectedProfile.personality?.trim()) {
      form.setValue('personality', false);
    }
    const defaults = voiceDeliveryDefaults(
      useVoiceDeliveryStore.getState().defaults,
      serverUrl,
      selectedProfileId,
    );
    if (defaults) {
      if (!currentDraft.effectsOverridden)
        currentDraft.setVoiceoverPolish(defaults.voiceoverPolish);
      if (
        defaults.delivery !== 'natural' &&
        engineUnchanged &&
        supportsExpressiveDelivery(selectedProfile, form.getValues('language'))
      ) {
        applyDelivery(form, defaults.delivery);
      }
    }
    useGenerationDraftStore.getState().markProfileApplied();
  }, [serverUrl, serverRevision, selectedProfileId, selectedProfile, form]);

  // Automatic defaults follow saved voice changes; explicit None or a preset
  // remains a take-level choice across refetches and navigation.
  useEffect(() => {
    if (!selectedProfileId || selectedProfile?.id !== selectedProfileId) return;
    if (useGenerationDraftStore.getState().effectsOverridden) return;
    setSelectedPresetId(selectedProfile.effects_chain?.length ? '_profile' : null, false);
  }, [selectedProfileId, selectedProfile, setSelectedPresetId]);

  // Auto-resize textarea based on content (only when expanded)
  useEffect(() => {
    if (layout === 'docked') return;
    if (!isExpanded) {
      // Reset textarea height after collapse animation completes
      const timeoutId = setTimeout(() => {
        const textarea = textareaRef.current;
        if (textarea) {
          textarea.style.height = '32px';
          textarea.style.overflowY = 'hidden';
        }
      }, 200); // Wait for animation to complete
      return () => clearTimeout(timeoutId);
    }

    const textarea = textareaRef.current;
    if (!textarea) return;

    const adjustHeight = () => {
      textarea.style.height = 'auto';
      const scrollHeight = textarea.scrollHeight;
      const minHeight = 100; // Expanded minimum
      const maxHeight = 300; // Max height in pixels
      const targetHeight = Math.max(minHeight, Math.min(scrollHeight, maxHeight));
      textarea.style.height = `${targetHeight}px`;

      // Show scrollbar if content exceeds max height
      if (scrollHeight > maxHeight) {
        textarea.style.overflowY = 'auto';
      } else {
        textarea.style.overflowY = 'hidden';
      }
    };

    // Small delay to let framer animation complete
    const timeoutId = setTimeout(() => {
      adjustHeight();
    }, 200);

    // Adjust on mount and when value changes
    adjustHeight();

    // Watch for input changes
    textarea.addEventListener('input', adjustHeight);

    return () => {
      clearTimeout(timeoutId);
      textarea.removeEventListener('input', adjustHeight);
    };
  }, [isExpanded, layout]);

  async function onSubmit(data: GenerationFormValues, scope: ServerScope, profileRevision: number) {
    await preview.stop();
    if (!isCurrentServer(scope)) {
      toast({
        title: 'Server changed',
        description: 'Generation was not started. Your draft was kept.',
        variant: 'destructive',
      });
      return;
    }
    if (profileIdentity.current.revision !== profileRevision) return;
    await handleSubmit(data, selectedProfileId);
  }

  const expanded = !floating || isExpanded;
  const engine = form.watch('engine');
  const modelSize = form.watch('modelSize');
  const language = form.watch('language');
  const guidance = form.watch('chatterboxCfgWeight');
  const expression = form.watch('chatterboxExaggeration');
  const script = form.watch('text') || '';
  const voiceReady =
    profileApplied &&
    draftProfileId === selectedProfileId &&
    draftServerRevision === serverRevision &&
    selectedProfile?.id === selectedProfileId;
  const delivery = selectedDelivery(engine, guidance, expression);
  const showDelivery =
    !floating && voiceReady && supportsExpressiveDelivery(selectedProfile, language);
  const modelIsMissing = (name: string) =>
    modelStatus.data?.models?.find((model) => model.model_name === name)?.downloaded === false;
  const downloadForPreview = modelIsMissing(
    getTtsModelOption(engine ?? 'qwen', modelSize).modelName,
  );
  const canHear = voiceReady && !!script.trim() && !isPending;
  const polishing = !!voiceoverPreset && polishOn;
  const isSaved =
    savedDelivery?.delivery === delivery && savedDelivery?.voiceoverPolish === polishOn;
  const showSave =
    !floating &&
    voiceReady &&
    delivery !== 'custom' &&
    (!!savedDelivery || delivery !== 'natural' || polishing);
  const triggerClass = 'h-9 w-full rounded-lg text-sm';

  function changeDelivery(preset: DeliveryPreset) {
    if (preview.active) void preview.stop();
    applyDelivery(form, preset);
  }

  function hear(mode: 'selected' | 'natural') {
    if (preview.active && previewMode === mode) {
      void preview.stop();
      return;
    }
    if (!selectedProfileId || !canHear) return;
    const scope = currentServerScope();
    const profileRevision = profileIdentity.current.revision;
    const current = () =>
      mountedRef.current &&
      isCurrentServer(scope) &&
      profileIdentity.current.revision === profileRevision;
    void form.handleSubmit(async (values) => {
      if (!current()) return;
      try {
        const request = generationRequest(
          {
            ...values,
            text: previewSentence(values.text),
            personality: false,
            ...(mode === 'natural' ? DELIVERY_PARAMETERS.natural : {}),
          },
          selectedProfileId,
        );
        const selectedModel = getTtsModelOption(
          request.engine ?? 'qwen',
          request.model_size,
        ).modelName;
        const needsDownload = modelIsMissing(selectedModel);
        setPreviewMode(mode);
        await preview.start(request, 'buffered', needsDownload ? selectedModel : undefined);
        if (needsDownload && current()) void modelStatus.refetch();
      } catch (error) {
        if (current())
          toast({
            title: t('generation.delivery.previewFailed'),
            description: error instanceof Error ? error.message : String(error),
            variant: 'destructive',
          });
      }
    })();
  }

  return (
    <div
      ref={containerRef}
      data-composer-layout={layout}
      className={floating ? 'fixed right-8 z-20' : '@container min-w-0'}
      style={
        floating
          ? {
              left: isStoriesRoute
                ? 'calc(var(--app-rail-width) + 360px + 1.5rem)'
                : 'calc(var(--app-rail-width) + 2rem)',
              bottom: hasTrackEditor
                ? `${trackEditorHeight + 24}px`
                : 'calc(var(--app-player-height) + 1.5rem)',
            }
          : undefined
      }
    >
      <div
        className={
          floating
            ? 'rounded-[10px] border border-border/60 bg-background p-4 shadow-xl'
            : 'rounded-xl border border-border/70 bg-card p-3 shadow-xs sm:p-4'
        }
      >
        <Form {...form}>
          <form
            onSubmit={(event) => {
              const scope = currentServerScope();
              const profileRevision = profileIdentity.current.revision;
              return form.handleSubmit((data) => onSubmit(data, scope, profileRevision))(event);
            }}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                (event.metaKey || event.ctrlKey) &&
                !event.defaultPrevented &&
                event.currentTarget.contains(event.target as Node) &&
                !event.nativeEvent.isComposing &&
                !event.repeat
              ) {
                event.preventDefault();
                event.currentTarget.requestSubmit();
              }
            }}
            className="space-y-3"
          >
            {(showVoiceSelector || !floating) && (
              <div className="space-y-1">
                <Label htmlFor="generate-voice" className="block">
                  Voice
                </Label>
                <Select
                  value={selectedProfileId || ''}
                  onValueChange={(value) => setSelectedProfileId(value || null)}
                >
                  <SelectTrigger id="generate-voice" className={triggerClass} aria-label="Voice">
                    <SelectValue placeholder={t('generation.voiceSelector.placeholder')} />
                  </SelectTrigger>
                  <SelectContent side={floating ? 'top' : undefined}>
                    {profiles?.map((profile) => (
                      <SelectItem key={profile.id} value={profile.id}>
                        {profile.name}
                        {profile.language ? ` · ${profile.language}` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {(showDelivery || showSave) && (
              <div className="space-y-1.5">
                <div className="flex min-h-6 flex-wrap items-center justify-between gap-x-2">
                  {showDelivery && (
                    <div className="flex items-center gap-1.5">
                      <span id="generate-delivery" className="text-xs font-medium">
                        {t('generation.delivery.label')}
                      </span>
                      {delivery === 'custom' && (
                        <span className="text-xs text-muted-foreground">
                          {t('generation.delivery.custom')}
                        </span>
                      )}
                    </div>
                  )}
                  {showSave && selectedProfileId && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto h-6 px-2 text-muted-foreground"
                      disabled={isSaved || (polishOn && !voiceoverPreset)}
                      onClick={() =>
                        useVoiceDeliveryStore.getState().save(serverUrl, selectedProfileId, {
                          delivery,
                          voiceoverPolish: polishing,
                        })
                      }
                    >
                      {t(isSaved ? 'generation.delivery.saved' : 'generation.delivery.save')}
                    </Button>
                  )}
                </div>
                {showDelivery && (
                  <fieldset
                    aria-labelledby="generate-delivery"
                    className="grid min-w-0 grid-cols-3 gap-1 rounded-lg border border-border/60 bg-muted/25 p-0.5"
                  >
                    {DELIVERY_PRESETS.map((preset) => (
                      <Button
                        key={preset}
                        size="sm"
                        variant={delivery === preset ? 'secondary' : 'ghost'}
                        aria-pressed={delivery === preset}
                        className="h-auto min-h-8 whitespace-normal px-1.5 py-1 aria-pressed:bg-accent/15 aria-pressed:text-foreground"
                        onClick={() => changeDelivery(preset)}
                      >
                        {t(`generation.delivery.${preset}`)}
                      </Button>
                    ))}
                  </fieldset>
                )}
              </div>
            )}
            <FormField
              control={form.control}
              name="text"
              render={({ field }) => (
                <FormItem className="space-y-1">
                  <FormLabel className="block">Script</FormLabel>
                  <FormControl>
                    {engine === 'chatterbox_turbo' ? (
                      <ParalinguisticInput
                        ref={(input) => {
                          // The rich editor exposes its contenteditable through its imperative ref.
                          input?.element?.setAttribute('aria-label', 'Script');
                        }}
                        value={field.value}
                        onChange={field.onChange}
                        placeholder={
                          isStoriesRoute && currentStory
                            ? t('generation.placeholder.storyWithEffects', {
                                name: currentStory.name,
                              })
                            : selectedProfile
                              ? t('generation.placeholder.effectsHint')
                              : t('generation.placeholder.selectVoice')
                        }
                        className={cn(
                          'w-full rounded-lg border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          !floating && 'min-h-24 @md:min-h-40',
                        )}
                        style={{
                          minHeight: floating ? (expanded ? '100px' : '36px') : undefined,
                          maxHeight: floating ? '300px' : undefined,
                          overflowY: 'auto',
                        }}
                        disabled={!selectedProfileId}
                        onClick={() => setIsExpanded(true)}
                        onFocus={() => setIsExpanded(true)}
                      />
                    ) : (
                      <Textarea
                        {...field}
                        aria-label="Script"
                        ref={(node: HTMLTextAreaElement | null) => {
                          textareaRef.current = node;
                          field.ref(node);
                        }}
                        placeholder={
                          isStoriesRoute && currentStory
                            ? t('generation.placeholder.story', { name: currentStory.name })
                            : selectedProfile
                              ? t('generation.placeholder.profile', { name: selectedProfile.name })
                              : t('generation.placeholder.selectVoice')
                        }
                        className={cn(
                          'w-full resize-y rounded-lg bg-background text-sm',
                          !floating && 'min-h-24 @md:min-h-40',
                        )}
                        style={{
                          minHeight: floating ? (expanded ? '100px' : '36px') : undefined,
                          maxHeight: floating ? '300px' : undefined,
                        }}
                        disabled={!selectedProfileId}
                        onClick={() => setIsExpanded(true)}
                        onFocus={() => setIsExpanded(true)}
                      />
                    )}
                  </FormControl>
                  <FormMessage className="text-xs" />
                </FormItem>
              )}
            />
            <div
              className={cn(
                'grid grid-cols-2 gap-x-2 gap-y-2.5',
                floating
                  ? 'sm:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)_minmax(0,1.15fr)]'
                  : '@md:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)_minmax(0,1.15fr)]',
              )}
            >
              <FormField
                control={form.control}
                name="engine"
                render={() => (
                  <FormItem className="space-y-1">
                    <FormLabel className="block">Engine</FormLabel>
                    <EngineModelSelector
                      form={form}
                      selectedProfile={voiceReady ? selectedProfile : null}
                    />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="language"
                render={({ field }) => (
                  <FormItem className="space-y-1">
                    <FormLabel className="block">Language</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger className={triggerClass}>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent side={floating ? 'top' : undefined}>
                        {getLanguageOptionsForEngine(engine || 'qwen', modelSize).map((lang) => (
                          <SelectItem key={lang.value} value={lang.value}>
                            {lang.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage className="text-xs" />
                  </FormItem>
                )}
              />
              <div
                className={cn(
                  'col-span-2 min-w-0 space-y-1',
                  floating ? 'sm:col-span-1' : '@md:col-span-1',
                )}
              >
                <Label htmlFor="generate-effects" className="block">
                  Effects
                </Label>
                <Select
                  value={(polishing ? voiceoverPreset.id : selectedPresetId) || 'none'}
                  onValueChange={(value) => {
                    if (preview.active) void preview.stop();
                    setVoiceoverPolish(false);
                    setSelectedPresetId(value === 'none' ? null : value, value !== '_profile');
                  }}
                >
                  <SelectTrigger
                    id="generate-effects"
                    className={triggerClass}
                    aria-label="Effects"
                  >
                    <SelectValue placeholder={t('generation.effects.none')} />
                  </SelectTrigger>
                  <SelectContent side={floating ? 'top' : undefined}>
                    <SelectItem value="none">{t('generation.effects.none')}</SelectItem>
                    {!!selectedProfile?.effects_chain?.length && (
                      <SelectItem value="_profile">
                        {t('generation.effects.profileDefault')}
                      </SelectItem>
                    )}
                    {effectPresets?.map((preset) => (
                      <SelectItem key={preset.id} value={preset.id}>
                        {preset.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {isInstructExpanded && engineSupportsInstruct(engine) && (
              <FormField
                control={form.control}
                name="instruct"
                render={({ field }) => (
                  <FormItem className="space-y-2">
                    <FormLabel className="text-xs">Instruct</FormLabel>
                    <FormControl>
                      <Textarea
                        {...field}
                        placeholder={
                          engine === 'omnivoice'
                            ? t('generation.instruct.placeholderOmnivoice')
                            : t('generation.instruct.placeholder')
                        }
                        className="min-h-[60px] rounded-lg"
                        maxLength={500}
                      />
                    </FormControl>
                    <FormMessage className="text-xs" />
                  </FormItem>
                )}
              />
            )}
            <div
              className={
                floating
                  ? 'flex flex-wrap items-center justify-between gap-3'
                  : 'grid items-center gap-2.5 border-t border-border/70 pt-2.5 @min-[35rem]:flex @min-[35rem]:flex-wrap @min-[35rem]:justify-between'
              }
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <SpeechSettings form={form} />
                {!floating && voiceReady && (voiceoverPreset || voiceoverPolish) && (
                  <Button
                    role="switch"
                    aria-checked={polishOn}
                    variant="outline"
                    size="sm"
                    className="h-auto min-h-8 gap-1.5 rounded-full bg-card px-2.5 py-1 whitespace-normal"
                    onClick={() => {
                      if (preview.active) void preview.stop();
                      setVoiceoverPolish(!polishOn);
                      if (polishOn && voiceoverPreset && selectedPresetId === voiceoverPreset.id) {
                        setSelectedPresetId(
                          selectedProfile?.effects_chain?.length ? '_profile' : null,
                          false,
                        );
                      }
                    }}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        'w-5 shrink-0 rounded-full p-0.5 transition-colors',
                        polishOn ? 'bg-accent/40' : 'bg-muted',
                      )}
                    >
                      <span
                        className={cn(
                          'block h-2 w-2 rounded-full transition-transform',
                          polishOn ? 'translate-x-2 bg-accent' : 'bg-muted-foreground',
                        )}
                      />
                    </span>
                    {t('generation.delivery.polish')}
                  </Button>
                )}
                {selectedProfile?.personality?.trim() && (
                  <>
                    <Hint content={t('generation.compose.tooltip')}>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-8 w-8 rounded-lg"
                        disabled={composeMutation.isPending || !selectedProfileId}
                        aria-label={t('generation.compose.ariaLabel')}
                        onClick={async () => {
                          if (!selectedProfileId) return;
                          const profileRevision = profileIdentity.current.revision;
                          const textRevision = useGenerationDraftStore.getState().textRevision;
                          const scope = currentServerScope();
                          try {
                            const result = await composeMutation.mutateAsync({
                              profileId: selectedProfileId,
                              scope,
                            });
                            if (
                              !mountedRef.current ||
                              !isCurrentServer(scope) ||
                              profileIdentity.current.revision !== profileRevision ||
                              useGenerationDraftStore.getState().textRevision !== textRevision
                            )
                              return;
                            form.setValue('text', result.text, { shouldDirty: true });
                            setIsExpanded(true);
                          } catch {
                            /* The mutation reports the failure. */
                          }
                        }}
                      >
                        {composeMutation.isPending ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Dices className="h-4 w-4" />
                        )}
                      </Button>
                    </Hint>
                    <FormField
                      control={form.control}
                      name="personality"
                      render={({ field }) => (
                        <FormItem className="space-y-0">
                          <FormControl>
                            <Hint
                              content={
                                field.value
                                  ? t('generation.persona.tooltipActive')
                                  : t('generation.persona.tooltipInactive')
                              }
                            >
                              <Button
                                type="button"
                                variant={field.value ? 'secondary' : 'outline'}
                                size="icon"
                                className="h-8 w-8 rounded-lg"
                                onClick={() => field.onChange(!field.value)}
                                aria-label={
                                  field.value
                                    ? t('generation.persona.ariaLabelActive')
                                    : t('generation.persona.ariaLabelInactive')
                                }
                                aria-pressed={!!field.value}
                              >
                                <Wand2 className="h-4 w-4" />
                              </Button>
                            </Hint>
                          </FormControl>
                        </FormItem>
                      )}
                    />
                  </>
                )}
                {engineSupportsInstruct(engine) && (
                  <Hint content={t('generation.instruct.tooltip')}>
                    <Button
                      type="button"
                      variant={isInstructExpanded ? 'secondary' : 'outline'}
                      size="icon"
                      className="h-8 w-8 rounded-lg"
                      onClick={() => setIsInstructExpanded((prev) => !prev)}
                      aria-label={
                        isInstructExpanded
                          ? t('generation.instruct.hide')
                          : t('generation.instruct.show')
                      }
                      aria-pressed={isInstructExpanded}
                    >
                      <SlidersHorizontal className="h-4 w-4" />
                    </Button>
                  </Hint>
                )}
              </div>
              <div
                data-generation-actions
                className={cn(
                  'ml-auto flex max-w-full flex-wrap items-center justify-end gap-1.5',
                  !floating &&
                    'w-full [&>.app-hint-anchor]:w-full @md:w-auto @md:[&>.app-hint-anchor]:w-auto',
                )}
              >
                {!floating && preview.bufferedAvailable && voiceReady && (
                  <>
                    {((preview.active && previewMode === 'natural') ||
                      (showDelivery && delivery !== 'natural' && !downloadForPreview)) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-auto min-h-9 min-w-0 flex-1 whitespace-normal px-2.5 py-1.5 @md:flex-none"
                        disabled={!canHear && !(preview.active && previewMode === 'natural')}
                        onClick={() => hear('natural')}
                      >
                        {t(
                          preview.active && previewMode === 'natural'
                            ? 'generation.delivery.stopNatural'
                            : 'generation.delivery.hearNatural',
                        )}
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-auto min-h-9 min-w-0 flex-1 whitespace-normal px-2.5 py-1.5 @md:flex-none"
                      disabled={!canHear && !(preview.active && previewMode === 'selected')}
                      onClick={() => hear('selected')}
                    >
                      <Headphones aria-hidden="true" />
                      {t(
                        preview.active && previewMode === 'selected'
                          ? 'generation.delivery.stop'
                          : downloadForPreview
                            ? 'generation.delivery.downloadHear'
                            : 'generation.delivery.hear',
                      )}
                    </Button>
                  </>
                )}
                {floating && preview.available && (
                  <Hint content="Listen to your script at normal speed without effects or loudness normalization. Preview is not saved; Generate creates the finished audio.">
                    <Button
                      type="button"
                      variant="outline"
                      className="h-9 rounded-lg"
                      aria-label={preview.active ? 'Stop preview' : 'Preview speech'}
                      disabled={
                        !selectedProfileId || (!preview.active && (!script.trim() || isPending))
                      }
                      onClick={() => {
                        if (preview.active) {
                          void preview.stop();
                          return;
                        }
                        void form.handleSubmit(async (values) => {
                          if (!selectedProfileId) return;
                          const previewEngine = values.engine || 'qwen';
                          await preview.start({
                            profile_id: selectedProfileId,
                            text: values.text,
                            language: values.language,
                            engine: previewEngine,
                            model_size: ['qwen', 'qwen_custom_voice', 'tada'].includes(
                              previewEngine,
                            )
                              ? values.modelSize
                              : undefined,
                            seed: values.seed,
                            instruct: engineSupportsInstruct(previewEngine)
                              ? values.instruct || undefined
                              : undefined,
                            normalize: false,
                            effects_chain: [],
                            speed: 1,
                          });
                        })();
                      }}
                    >
                      <span className="grid">
                        <span aria-hidden="true" className="invisible col-start-1 row-start-1">
                          Preview speech
                        </span>
                        <span aria-hidden="true" className="invisible col-start-1 row-start-1">
                          Stop preview
                        </span>
                        <span className="col-start-1 row-start-1">
                          {preview.active ? 'Stop preview' : 'Preview speech'}
                        </span>
                      </span>
                    </Button>
                  </Hint>
                )}
                <Hint content="Command or Control + Enter">
                  <Button
                    type="submit"
                    disabled={isPending || !selectedProfileId}
                    className={cn(
                      'h-9 gap-2 rounded-lg',
                      !floating && 'h-auto min-h-9 w-full whitespace-normal @md:w-auto',
                    )}
                    aria-label={
                      isPending
                        ? t('generation.button.generating')
                        : !selectedProfileId
                          ? t('generation.button.selectFirst')
                          : t('generation.button.generate')
                    }
                  >
                    {isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Sparkles className="h-4 w-4" />
                    )}{' '}
                    <span className="grid">
                      <span aria-hidden="true" className="invisible col-start-1 row-start-1">
                        {t('generation.button.generate')}
                      </span>
                      <span aria-hidden="true" className="invisible col-start-1 row-start-1">
                        {t('generation.button.generating')}
                      </span>
                      <span className="col-start-1 row-start-1">
                        {isPending
                          ? t('generation.button.generating')
                          : t('generation.button.generate')}
                      </span>
                    </span>
                  </Button>
                </Hint>
              </div>
            </div>
          </form>
        </Form>
      </div>
    </div>
  );
}
