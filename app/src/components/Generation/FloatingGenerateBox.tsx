import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useMatchRoute } from '@tanstack/react-router';
import { Dices, Loader2, SlidersHorizontal, Sparkles, Wand2 } from 'lucide-react';
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
import { engineSupportsInstruct } from '@/lib/constants/engines';
import { getLanguageOptionsForEngine, type LanguageCode } from '@/lib/constants/languages';
import { useGenerationForm } from '@/lib/hooks/useGenerationForm';
import { currentServerScope, isCurrentServer, requireCurrentServer, type ServerScope } from '@/lib/serverScope';
import { useProfile, useProfiles } from '@/lib/hooks/useProfiles';
import { useStory } from '@/lib/hooks/useStories';
import { cn } from '@/lib/utils/cn';
import { useGenerationDraftStore } from '@/stores/generationDraftStore';
import { useGenerationStore } from '@/stores/generationStore';
import { useStoryStore } from '@/stores/storyStore';
import { useUIStore } from '@/stores/uiStore';
import { EngineModelSelector, getEngineDescription } from './EngineModelSelector';
import { ParalinguisticInput } from './ParalinguisticInput';
import { SpeechSettings } from './SpeechSettings';

interface FloatingGenerateBoxProps {
  isPlayerOpen?: boolean;
  layout?: 'docked' | 'floating';
  showVoiceSelector?: boolean;
}

export function FloatingGenerateBox({
  layout = 'floating',
  showVoiceSelector = false,
}: FloatingGenerateBoxProps) {
  const { t } = useTranslation();
  const selectedProfileId = useUIStore((state) => state.selectedProfileId);
  const setSelectedProfileId = useUIStore((state) => state.setSelectedProfileId);
  const setSelectedEngine = useUIStore((state) => state.setSelectedEngine);
  const { data: selectedProfile } = useProfile(selectedProfileId || '');
  const { data: profiles } = useProfiles();
  const [isExpanded, setIsExpanded] = useState(false);
  const [isInstructExpanded, setIsInstructExpanded] = useState(false);
  const selectedPresetId = useGenerationDraftStore((state) => state.presetId);
  const draftProfileId = useGenerationDraftStore((state) => state.profileId);
  const profileApplied = useGenerationDraftStore((state) => state.profileApplied);
  const setSelectedPresetId = useGenerationDraftStore((state) => state.setPresetId);
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
  const preview = useSpeechPreview(selectedProfileId, (description) => {
    toast({ title: 'Speech preview failed', description, variant: 'destructive' });
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
    queryKey: ['effect-presets'],
    queryFn: () => apiClient.listEffectPresets(),
  });

  // Calculate if track editor is visible (on stories route with items)
  const hasTrackEditor = isStoriesRoute && currentStory && currentStory.items.length > 0;

  const { form, handleSubmit, isPending } = useGenerationForm({
    onSuccess: async (generationId) => {
      setIsExpanded(false);
      // Defer the story add until TTS completes -- useGenerationProgress handles it
      if (isStoriesRoute && selectedStoryId && generationId) {
        addPendingStoryAdd(generationId, selectedStoryId);
      }
    },
    getEffectsChain: () => {
      if (!useGenerationDraftStore.getState().effectsOverridden) {
        if (!selectedProfile || selectedProfile.id !== selectedProfileId)
          throw new Error('Voice defaults are still loading. Try again in a moment.');
        return selectedProfile.effects_chain ?? [];
      }
      // An empty chain explicitly disables effects; omission asks the backend
      // to apply voice defaults, which would contradict the None selection.
      if (!selectedPresetId) return [];
      // Profile's own effects chain (no matching preset)
      if (selectedPresetId === '_profile') {
        if (!selectedProfile || selectedProfile.id !== selectedProfileId)
          throw new Error('Voice defaults are still loading. Try again in a moment.');
        return selectedProfile.effects_chain ?? [];
      }
      if (!effectPresets)
        throw new Error('Effect presets are still loading. Try again in a moment.');
      const preset = effectPresets.find((p) => p.id === selectedPresetId);
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
  type EngineValue =
    | 'qwen'
    | 'luxtts'
    | 'chatterbox'
    | 'chatterbox_turbo'
    | 'tada'
    | 'kokoro'
    | 'qwen_custom_voice'
    | 'qwen_voice_design'
    | 'omnivoice';
  useEffect(() => {
    const draft = useGenerationDraftStore.getState();
    draft.selectProfile(selectedProfileId);
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
    const defaultSizeForEngine = (targetEngine: EngineValue) => {
      if (targetEngine === 'qwen' || targetEngine === 'qwen_custom_voice') return '1.7B' as const;
      if (targetEngine === 'tada') return '1B' as const;
      return undefined;
    };
    const engine = selectedProfile?.default_engine ?? selectedProfile?.preset_engine;
    if (engine && engineUnchanged) {
      const target = engine as EngineValue;
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
    useGenerationDraftStore.getState().markProfileApplied();
  }, [selectedProfileId, selectedProfile, form]);

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

  async function onSubmit(data: Parameters<typeof handleSubmit>[0], scope: ServerScope) {
    await preview.stop();
    if (!isCurrentServer(scope)) {
      toast({ title: 'Server changed', description: 'Generation was not started. Your draft was kept.', variant: 'destructive' });
      return;
    }
    await handleSubmit(data, selectedProfileId);
  }

  const floating = layout === 'floating';
  const expanded = !floating || isExpanded;
  const engine = form.watch('engine');
  const modelSize = form.watch('modelSize');
  const script = form.watch('text') || '';
  const triggerClass = 'h-9 w-full rounded-lg text-sm';

  return (
    <div
      ref={containerRef}
      data-composer-layout={layout}
      className={cn(floating && 'fixed right-8 z-20', !floating && 'min-w-0')}
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
        className={cn(
          'rounded-[10px] border border-border/60 bg-card/40 p-4',
          floating && 'shadow-xl bg-background',
        )}
      >
        <Form {...form}>
          <form
            onSubmit={(event) => {
              const scope = currentServerScope();
              return form.handleSubmit((data) => onSubmit(data, scope))(event);
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
            className="space-y-4"
          >
            {!floating && <h2 className="text-[15px] font-semibold">Voice &amp; delivery</h2>}
            {(showVoiceSelector || !floating) && (
              <div className="space-y-2">
                <label htmlFor="generate-voice" className="text-xs font-medium">
                  Voice
                </label>
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
                {!floating && (
                  <Link
                    to="/voices"
                    className="inline-block text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                  >
                    Manage voices
                  </Link>
                )}
              </div>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <FormField
                control={form.control}
                name="engine"
                render={() => (
                  <FormItem className="min-w-0 space-y-2">
                    <FormLabel className="text-xs">Engine</FormLabel>
                    <EngineModelSelector
                      form={form}
                      selectedProfile={
                        profileApplied &&
                        draftProfileId === selectedProfileId &&
                        selectedProfile?.id === selectedProfileId
                          ? selectedProfile
                          : null
                      }
                    />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="language"
                render={({ field }) => (
                  <FormItem className="min-w-0 space-y-2">
                    <FormLabel className="text-xs">Language</FormLabel>
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
              <div className="min-w-0 space-y-2">
                <label htmlFor="generate-effects" className="text-xs font-medium">
                  Effects
                </label>
                <Select
                  value={selectedPresetId || 'none'}
                  onValueChange={(value) =>
                    setSelectedPresetId(value === 'none' ? null : value, value !== '_profile')
                  }
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
            {!floating && getEngineDescription(engine || 'qwen') && (
              <p className="text-xs text-muted-foreground">
                {getEngineDescription(engine || 'qwen')}
              </p>
            )}
            {selectedPresetId === '_profile' && (
              <p className="text-xs text-muted-foreground">
                This voice’s default effects are applied. Choose another preset to replace them for
                this take.
              </p>
            )}
            <FormField
              control={form.control}
              name="text"
              render={({ field }) => (
                <FormItem className="space-y-2">
                  <FormLabel className="text-xs">Script</FormLabel>
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
                        className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        style={{
                          minHeight: floating ? (expanded ? '100px' : '36px') : '180px',
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
                        className="w-full resize-y rounded-lg bg-background text-sm"
                        style={{
                          minHeight: floating ? (expanded ? '100px' : '36px') : '180px',
                          maxHeight: floating ? '300px' : undefined,
                        }}
                        disabled={!selectedProfileId}
                        onClick={() => setIsExpanded(true)}
                        onFocus={() => setIsExpanded(true)}
                      />
                    )}
                  </FormControl>
                  <FormMessage className="text-xs" />
                  <p className="text-right text-xs text-muted-foreground">
                    {script.length} characters
                  </p>
                </FormItem>
              )}
            />
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
            <div className="flex flex-col gap-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <SpeechSettings form={form} />
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
                className="flex max-w-full flex-wrap items-center justify-end gap-2 self-end"
              >
                {preview.available && (
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
                    className="h-9 gap-2 rounded-lg"
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
