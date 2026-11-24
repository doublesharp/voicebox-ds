import { zodResolver } from '@hookform/resolvers/zod';
import { ChevronRight, Download, Edit2, Mic, Trash2, X } from 'lucide-react';
import { type Ref, useEffect, useId, useImperativeHandle, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import * as z from 'zod';
import { EffectsChainEditor } from '@/components/Effects/EffectsChainEditor';
import { Button } from '@/components/ui/button';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { FormSection } from '@/components/ui/form-section';
import { Input } from '@/components/ui/input';
import { InspectorPanel } from '@/components/ui/inspector-panel';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/use-toast';
import { SampleList } from '@/components/VoiceProfiles/SampleList';
import type { EffectConfig, VoiceProfileResponse } from '@/lib/api/types';
import { LANGUAGE_CODES, LANGUAGE_OPTIONS, type LanguageCode } from '@/lib/constants/languages';
import {
  useDeleteAvatar,
  useProfile,
  useUpdateProfile,
  useUpdateProfileEffects,
  useUploadAvatar,
} from '@/lib/hooks/useProfiles';
import { useServerStore } from '@/stores/serverStore';

function makeProfileSchema(t: (key: string) => string, requiresDesign: boolean) {
  return z
    .object({
      name: z.string().min(1, t('profileForm.validation.nameRequired')).max(100),
      description: z.string().max(500).optional(),
      language: z.enum(LANGUAGE_CODES as [LanguageCode, ...LanguageCode[]]),
      personality: z.string().max(2000).optional(),
      design_prompt: z.string().max(2000).optional(),
    })
    .refine((data) => !requiresDesign || !!data.design_prompt?.trim(), {
      path: ['design_prompt'],
      message: t('profileForm.validation.designPromptRequired'),
    });
}

type ProfileFormValues = {
  name: string;
  description?: string;
  language: LanguageCode;
  personality?: string;
  design_prompt?: string;
};

interface VoiceInspectorProps {
  profileId: string;
  profileSummary?: Pick<VoiceProfileResponse, 'id' | 'sample_count' | 'generation_count'>;
  overlay?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onSavingChange?: (saving: boolean) => void;
  onExport?: (profile: VoiceProfileResponse) => void;
  onDelete?: (profile: VoiceProfileResponse) => void;
  actionsRef?: Ref<VoiceInspectorActions>;
}

export interface VoiceInspectorActions {
  save: () => Promise<boolean>;
  discard: () => void;
  isSaving: () => boolean;
}

export function VoiceInspector({
  profileId,
  profileSummary,
  overlay = false,
  onDirtyChange,
  onSavingChange,
  onExport,
  onDelete,
  actionsRef,
}: VoiceInspectorProps) {
  const formId = useId();
  const { t } = useTranslation();
  const { data: profile } = useProfile(profileId);
  const summary = profileSummary?.id === profileId ? profileSummary : undefined;
  const updateProfile = useUpdateProfile();
  const updateEffects = useUpdateProfileEffects();
  const uploadAvatar = useUploadAvatar();
  const deleteAvatar = useDeleteAvatar();
  const serverUrl = useServerStore((state) => state.serverUrl);
  const { toast } = useToast();

  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const avatarBlobUrlRef = useRef<string | null>(null);
  const [avatarError, setAvatarError] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  const revokeAvatarBlobUrl = () => {
    if (avatarBlobUrlRef.current) {
      URL.revokeObjectURL(avatarBlobUrlRef.current);
      avatarBlobUrlRef.current = null;
    }
  };

  useEffect(() => revokeAvatarBlobUrl, []);

  const [effectsChain, setEffectsChain] = useState<EffectConfig[]>([]);
  const [effectsDirty, setEffectsDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const pendingSave = useRef<Promise<boolean> | null>(null);
  const identity = useRef({ id: profileId, epoch: 0, mounted: true });
  if (identity.current.id !== profileId) {
    identity.current = { id: profileId, epoch: identity.current.epoch + 1, mounted: true };
  }
  const effectsRevision = useRef(0);
  const initializedProfile = useRef<string | null>(null);
  const savedEffectsAwaitingRefetch = useRef<EffectConfig[] | null>(null);
  const savedFormAwaitingRefetch = useRef<ProfileFormValues | null>(null);
  const isCurrent = (epoch: number) => identity.current.mounted && identity.current.epoch === epoch;
  useEffect(() => {
    identity.current.mounted = true;
    return () => {
      identity.current.mounted = false;
      identity.current.epoch++;
    };
  }, []);

  const form = useForm<ProfileFormValues>({
    resolver: zodResolver(makeProfileSchema(t, profile?.voice_type === 'designed')),
    defaultValues: {
      name: '',
      description: '',
      language: 'en',
      personality: '',
      design_prompt: '',
    },
  });

  // Refetches may update clean data, but must never discard a draft.
  useEffect(() => {
    if (!profile || profile.id !== profileId) return;
    const changedProfile = initializedProfile.current !== profileId;
    if (changedProfile) {
      savedFormAwaitingRefetch.current = null;
      savedEffectsAwaitingRefetch.current = null;
    }
    const refetchedForm = {
      name: profile.name,
      description: profile.description || '',
      language: profile.language as LanguageCode,
      personality: profile.personality || '',
      design_prompt: profile.design_prompt || '',
    };
    const awaitingForm = savedFormAwaitingRefetch.current;
    const confirmedForm =
      awaitingForm && JSON.stringify(awaitingForm) === JSON.stringify(refetchedForm);
    if (confirmedForm) savedFormAwaitingRefetch.current = null;
    if (changedProfile || (!form.formState.isDirty && (!awaitingForm || confirmedForm))) {
      form.reset(refetchedForm);
    }
    const refetchedEffects = profile.effects_chain ?? [];
    const awaitingEffects = savedEffectsAwaitingRefetch.current;
    const confirmedEffects =
      awaitingEffects && JSON.stringify(awaitingEffects) === JSON.stringify(refetchedEffects);
    if (confirmedEffects) savedEffectsAwaitingRefetch.current = null;
    if (changedProfile || (!effectsDirty && (!awaitingEffects || confirmedEffects))) {
      setEffectsChain(refetchedEffects);
      setEffectsDirty(false);
    }
    if (changedProfile) {
      initializedProfile.current = profileId;
      effectsRevision.current++;
      setSaving(false);
    }
  }, [profile, profileId, form, effectsDirty]);

  // Avatar preview
  useEffect(() => {
    revokeAvatarBlobUrl();
    if (profile?.avatar_path) {
      setAvatarPreview(`${serverUrl}/profiles/${profile.id}/avatar`);
    } else {
      setAvatarPreview(null);
    }
    setAvatarError(false);
  }, [profile, serverUrl]);

  function handleAvatarFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast({
        title: t('profileForm.toast.invalidFile'),
        description: t('voiceInspector.toast.invalidImageFormat'),
        variant: 'destructive',
      });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast({
        title: t('profileForm.toast.fileTooLarge'),
        description: t('profileForm.toast.imageTooLargeDescription'),
        variant: 'destructive',
      });
      return;
    }
    const epoch = identity.current.epoch;
    uploadAvatar.mutate(
      { profileId, file },
      {
        onSuccess: () => {
          if (!isCurrent(epoch)) return;
          revokeAvatarBlobUrl();
          const nextBlobUrl = URL.createObjectURL(file);
          avatarBlobUrlRef.current = nextBlobUrl;
          setAvatarPreview(nextBlobUrl);
          toast({ title: t('voiceInspector.toast.avatarUpdated') });
        },
        onError: (err) => {
          if (!isCurrent(epoch)) return;
          toast({
            title: t('profileForm.toast.avatarUploadFailed'),
            description: err instanceof Error ? err.message : t('common.unknownError'),
            variant: 'destructive',
          });
        },
      },
    );
  }

  async function handleRemoveAvatar() {
    const epoch = identity.current.epoch;
    if (profile?.avatar_path) {
      try {
        await deleteAvatar.mutateAsync(profileId);
        if (!isCurrent(epoch)) return;
        toast({ title: t('profileForm.toast.avatarRemoved') });
      } catch (err) {
        if (!isCurrent(epoch)) return;
        toast({
          title: t('profileForm.toast.avatarRemoveFailed'),
          description: err instanceof Error ? err.message : t('common.unknownError'),
          variant: 'destructive',
        });
        return;
      }
    }
    if (!isCurrent(epoch)) return;
    revokeAvatarBlobUrl();
    setAvatarPreview(null);
    if (avatarInputRef.current) avatarInputRef.current.value = '';
  }

  async function persistProfile(data: ProfileFormValues): Promise<boolean> {
    const epoch = identity.current.epoch;
    const revision = effectsRevision.current;
    setSaving(true);
    try {
      const normalizedPersonality = data.personality?.trim() || null;
      const normalizedDesignPrompt =
        profile?.voice_type === 'designed' ? data.design_prompt?.trim() : undefined;
      const savedForm = {
        name: data.name,
        description: data.description || '',
        language: data.language,
        personality: normalizedPersonality ?? '',
        design_prompt: normalizedDesignPrompt ?? data.design_prompt ?? '',
      };
      await updateProfile.mutateAsync({
        profileId,
        data: {
          name: data.name,
          description: data.description,
          language: data.language,
          personality: normalizedPersonality,
          ...(normalizedDesignPrompt !== undefined ? { design_prompt: normalizedDesignPrompt } : {}),
        },
      });

      if (isCurrent(epoch)) {
        savedFormAwaitingRefetch.current = savedForm;
        // Rebase against the acknowledged write while preserving any newer
        // typing, including a return to the original value during the request.
        const latest = form.getValues();
        form.reset(savedForm, { keepErrors: true, keepTouched: true });
        for (const field of Object.keys(savedForm) as (keyof ProfileFormValues)[]) {
          if (latest[field] !== data[field]) {
            form.setValue(field, latest[field], { shouldDirty: true });
          }
        }
      }

      if (effectsDirty) {
        try {
          await updateEffects.mutateAsync({
            profileId,
            effectsChain: effectsChain.length > 0 ? effectsChain : null,
          });
          if (isCurrent(epoch)) {
            savedEffectsAwaitingRefetch.current = effectsChain;
            if (effectsRevision.current === revision) setEffectsDirty(false);
          }
        } catch (fxError) {
          if (!identity.current.mounted) return false;
          toast({
            title: t('profileForm.toast.effectsUpdateFailed'),
            description:
              fxError instanceof Error
                ? fxError.message
                : t('profileForm.toast.effectsUpdateFailedFallback'),
            variant: 'destructive',
          });
          return false;
        }
      }

      if (!isCurrent(epoch)) return false;
      toast({
        title: t('profileForm.toast.voiceUpdated'),
        description: t('voiceInspector.toast.savedDescription', { name: data.name }),
      });
      return (
        JSON.stringify(form.getValues()) === JSON.stringify(savedForm) &&
        effectsRevision.current === revision
      );
    } catch (error) {
      if (!identity.current.mounted) return false;
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : t('profileForm.toast.saveFailed'),
        variant: 'destructive',
      });
      return false;
    } finally {
      if (isCurrent(epoch)) setSaving(false);
    }
  }

  function onSubmit(data: ProfileFormValues): Promise<boolean> {
    // Footer, Enter and navigation confirmation share one synchronous lock.
    if (pendingSave.current) return pendingSave.current.then(() => false);
    const operation = persistProfile(data).finally(() => {
      if (pendingSave.current === operation) pendingSave.current = null;
    });
    pendingSave.current = operation;
    return operation;
  }

  const isDirty = form.formState.isDirty || effectsDirty || saving;
  useEffect(() => onDirtyChange?.(isDirty), [isDirty, onDirtyChange]);
  useEffect(() => onSavingChange?.(saving), [saving, onSavingChange]);
  function discard() {
    if (pendingSave.current) return;
    if (!profile || profile.id !== profileId) return;
    form.reset(
      savedFormAwaitingRefetch.current ?? {
        name: profile.name,
        description: profile.description || '',
        language: profile.language as LanguageCode,
        personality: profile.personality || '',
        design_prompt: profile.design_prompt || '',
      },
    );
    effectsRevision.current++;
    setEffectsChain(savedEffectsAwaitingRefetch.current ?? profile.effects_chain ?? []);
    setEffectsDirty(false);
  }
  useImperativeHandle(actionsRef, () => ({
    discard,
    isSaving: () => !!pendingSave.current,
    save: async () => {
      let saved = false;
      await form.handleSubmit(async (data) => {
        saved = await onSubmit(data);
      })();
      return saved;
    },
  }));

  if (!profile || profile.id !== profileId) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        {t('voiceInspector.loading')}
      </div>
    );
  }

  return (
    <InspectorPanel
      title={profile.name}
      subtitle={[
        profile.language.toUpperCase(),
        // The detail endpoint uses zero defaults rather than aggregate counts.
        // Only the matching library summary establishes samples and take totals.
        ...(summary
          ? [`${summary.sample_count} samples`, `${summary.generation_count} takes`]
          : []),
      ].join(' · ')}
      overlay={overlay}
      icon={
        <button
          type="button"
          onClick={() => avatarInputRef.current?.click()}
          aria-label={t('voiceInspector.changeAvatar', { defaultValue: 'Change avatar' })}
          title={t('voiceInspector.changeAvatar', { defaultValue: 'Change avatar' })}
          className="relative flex h-10 w-10 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {avatarPreview && !avatarError ? (
            <img
              src={avatarPreview}
              alt=""
              className="h-full w-full rounded-xl object-cover"
              onError={() => setAvatarError(true)}
            />
          ) : (
            <Mic className="h-5 w-5" />
          )}
          <Edit2 className="absolute -bottom-1 -right-1 h-4 w-4 rounded bg-background p-0.5" />
        </button>
      }
      actions={
        <div className="flex items-center gap-1">
          {avatarPreview && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={handleRemoveAvatar}
              disabled={deleteAvatar.isPending}
              aria-label={t('voiceInspector.removeAvatar', { defaultValue: 'Remove avatar' })}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
          {onExport && profile.voice_type !== 'preset' && profile.voice_type !== 'designed' && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => onExport(profile)}
              aria-label={t('profiles.actions.export', { defaultValue: 'Export voice' })}
              title={t('profiles.actions.export', { defaultValue: 'Export voice' })}
            >
              <Download className="h-3.5 w-3.5" />
            </Button>
          )}
          {onDelete && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-destructive hover:text-destructive"
              onClick={() => onDelete(profile)}
              aria-label={t('common.delete', { defaultValue: 'Delete' })}
              title={t('common.delete', { defaultValue: 'Delete' })}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      }
      footer={
        <>
          <span className="text-xs text-muted-foreground">
            {isDirty
              ? t('voiceInspector.unsaved', { defaultValue: 'Unsaved changes' })
              : t('voiceInspector.saved', { defaultValue: 'All changes saved' })}
          </span>
          <div className="flex items-center gap-1.5">
            {isDirty && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={saving || updateProfile.isPending}
                onClick={discard}
              >
                {t('voiceInspector.discard', { defaultValue: 'Discard' })}
              </Button>
            )}
            <Button
              form={formId}
              type="submit"
              size="sm"
              disabled={!isDirty || saving || updateProfile.isPending}
            >
              {saving || updateProfile.isPending
                ? t('profileForm.actions.saving')
                : t('common.save')}
            </Button>
          </div>
        </>
      }
    >
      <input
        ref={avatarInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={handleAvatarFileChange}
        className="hidden"
      />
      <Form {...form}>
        <form id={formId} onSubmit={form.handleSubmit(onSubmit)} className="space-y-0">
          {/* Fields */}
          <div className="space-y-4 px-5 py-4">
            <FormSection
              title={t('profileForm.sections.identity', { defaultValue: 'Profile details' })}
              className="space-y-3"
            >
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('profileForm.fields.name')}</FormLabel>
                    <FormControl>
                      <Input
                        className="h-9"
                        placeholder={t('profileForm.fields.namePlaceholder')}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('voiceInspector.fields.description')}</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder={t('profileForm.fields.descriptionPlaceholder')}
                        rows={2}
                        className="min-h-14 resize-y py-1.5 leading-5"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="language"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('profileForm.fields.language')}</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger className="h-9">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {LANGUAGE_OPTIONS.map((lang) => (
                          <SelectItem key={lang.value} value={lang.value}>
                            {lang.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {profile.voice_type === 'designed' && (
                <FormField
                  control={form.control}
                  name="design_prompt"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        {t('profileForm.fields.designPrompt', {
                          defaultValue: 'Voice design prompt',
                        })}
                      </FormLabel>
                      <FormControl>
                        <Textarea
                          placeholder={t('profileForm.fields.designPromptPlaceholder', {
                            defaultValue: 'Describe the voice timbre, pacing, and character…',
                          })}
                          rows={2}
                          className="min-h-14 resize-y py-1.5 leading-5"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              <FormField
                control={form.control}
                name="personality"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      {t('profileForm.fields.personality', { defaultValue: 'Personality prompt' })}
                    </FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder={t('profileForm.fields.personalityPlaceholder', {
                          defaultValue: 'Optional character instructions for persona rewriting…',
                        })}
                        rows={2}
                        className="min-h-14 resize-y py-1.5 leading-5"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </FormSection>
            {profile.voice_type === 'preset' || profile.voice_type === 'designed' ? (
              <details className="group border-t border-border/60 pt-3">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-sm text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                  <ChevronRight aria-hidden="true" className="size-4 group-open:rotate-90" />
                  {t('voiceInspector.samples', { defaultValue: 'Reference samples' })}
                </summary>
                <div className="mt-3">
                  <SampleList profileId={profileId} />
                </div>
              </details>
            ) : (
              <FormSection
                title={t('voiceInspector.samples', { defaultValue: 'Reference samples' })}
                description={t('voiceInspector.samplesHelp', {
                  defaultValue:
                    'Use clean speech from one speaker, without music or background noise.',
                })}
                className="space-y-3 border-t border-border/60 pt-4"
              >
                <SampleList profileId={profileId} />
              </FormSection>
            )}
            {/* Effects */}
            <FormSection
              title={t('profileForm.fields.defaultEffects')}
              description={t('voiceInspector.effectsHelp', {
                defaultValue:
                  'Applied automatically with this voice. A preset selected in Generate replaces them for that take.',
              })}
              className="space-y-3 border-t border-border/60 pt-4"
            >
              <EffectsChainEditor
                value={effectsChain}
                onChange={(chain) => {
                  effectsRevision.current++;
                  setEffectsChain(chain);
                  setEffectsDirty(true);
                }}
                compact
              />
            </FormSection>
          </div>
        </form>
      </Form>
    </InspectorPanel>
  );
}
