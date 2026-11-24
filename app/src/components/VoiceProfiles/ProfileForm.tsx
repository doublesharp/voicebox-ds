import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { Edit2, Mic, Monitor, Music, Sparkles, Upload, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import * as z from 'zod';
import { EffectsChainEditor } from '@/components/Effects/EffectsChainEditor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { FormSection } from '@/components/ui/form-section';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/use-toast';
import { apiClient } from '@/lib/api/client';
import type { EffectConfig, PresetVoice, VoiceType } from '@/lib/api/types';
import { LANGUAGE_CODES, LANGUAGE_OPTIONS, type LanguageCode } from '@/lib/constants/languages';
import { useAudioPlayer } from '@/lib/hooks/useAudioPlayer';
import { useAudioRecording } from '@/lib/hooks/useAudioRecording';
import {
  useAddSample,
  useCreateProfile,
  useDeleteAvatar,
  useDeleteProfile,
  useProfile,
  useUpdateProfile,
  useUpdateProfileEffects,
  useUploadAvatar,
} from '@/lib/hooks/useProfiles';
import { useSystemAudioCapture } from '@/lib/hooks/useSystemAudioCapture';
import { useTranscription } from '@/lib/hooks/useTranscription';
import { convertToWav, formatAudioDuration, getAudioDuration } from '@/lib/utils/audio';
import { usePlatform } from '@/platform/PlatformContext';
import { useMicrophoneStore } from '@/stores/microphoneStore';
import { useServerStore } from '@/stores/serverStore';
import { currentServerScope, isCurrentServer, type ServerScope } from '@/lib/serverScope';
import { type ProfileFormDraft, useUIStore } from '@/stores/uiStore';
import { AudioSampleRecording } from './AudioSampleRecording';
import { AudioSampleSystem } from './AudioSampleSystem';
import { AudioSampleUpload } from './AudioSampleUpload';
import { SampleList } from './SampleList';
import { SampleQuality } from './SampleQuality';

const MAX_AUDIO_DURATION_SECONDS = 30;
const MAX_DESIGN_PROMPT_LENGTH = 500;
/** Engines that can't be a default for a sample-based (cloned) profile. */
const PRESET_ONLY_ENGINES = new Set(['kokoro', 'qwen_custom_voice', 'qwen_voice_design']);
/** The engine a designed profile is created against. */
const DESIGN_ENGINE = 'qwen_voice_design';
const DEFAULT_ENGINE_OPTIONS = [
  { value: 'qwen', label: 'Qwen3-TTS' },
  { value: 'qwen_custom_voice', label: 'Qwen CustomVoice' },
  { value: 'qwen_voice_design', label: 'Qwen VoiceDesign' },
  { value: 'moss_tts', label: 'MOSS-TTS Nano (CPU)' },
  { value: 'luxtts', label: 'LuxTTS' },
  { value: 'chatterbox', label: 'Chatterbox' },
  { value: 'chatterbox_turbo', label: 'Chatterbox Turbo' },
  { value: 'tada', label: 'TADA' },
  { value: 'kokoro', label: 'Kokoro 82M' },
  { value: 'omnivoice', label: 'OmniVoice (non-commercial)' },
] as const;

function makeProfileSchema(t: (key: string) => string) {
  const baseProfileSchema = z.object({
    name: z.string().min(1, t('profileForm.validation.nameRequired')).max(100),
    description: z.string().max(500).optional(),
    language: z.enum(LANGUAGE_CODES as [LanguageCode, ...LanguageCode[]]),
    personality: z.string().max(2000).optional(),
    sampleFile: z.instanceof(File).optional(),
    referenceText: z.string().max(1000).optional(),
    avatarFile: z.instanceof(File).optional(),
  });

  return baseProfileSchema.refine(
    (data) => {
      if (data.sampleFile && (!data.referenceText || data.referenceText.trim().length === 0)) {
        return false;
      }
      return true;
    },
    {
      message: t('profileForm.validation.referenceRequired'),
      path: ['referenceText'],
    },
  );
}

type ProfileFormValues = {
  name: string;
  description?: string;
  language: LanguageCode;
  personality?: string;
  sampleFile?: File;
  referenceText?: string;
  avatarFile?: File;
};

// Helper to convert File to base64
async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Helper to convert base64 to File
function base64ToFile(base64: string, fileName: string, fileType: string): File {
  const arr = base64.split(',');
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) {
    u8arr[n] = bstr.charCodeAt(n);
  }
  return new File([u8arr], fileName, { type: fileType });
}

export function ProfileForm() {
  const defaultEngineFieldId = useId();
  const { t } = useTranslation();
  const platform = usePlatform();
  const open = useUIStore((state) => state.profileDialogOpen);
  const setOpen = useUIStore((state) => state.setProfileDialogOpen);
  const editingProfileId = useUIStore((state) => state.editingProfileId);
  const setEditingProfileId = useUIStore((state) => state.setEditingProfileId);
  const profileFormDraft = useUIStore((state) => state.profileFormDraft);
  const setProfileFormDraft = useUIStore((state) => state.setProfileFormDraft);
  const { data: editingProfile } = useProfile(editingProfileId || '');
  const createProfile = useCreateProfile();
  const updateProfile = useUpdateProfile();
  const updateEffects = useUpdateProfileEffects();
  const addSample = useAddSample();
  const deleteProfile = useDeleteProfile();
  const uploadAvatar = useUploadAvatar();
  const deleteAvatar = useDeleteAvatar();
  const transcribe = useTranscription();
  const { toast } = useToast();
  const [voiceSource, setVoiceSource] = useState<'clone' | 'builtin' | 'design'>('clone');
  const [designPrompt, setDesignPrompt] = useState<string>('');
  const [sampleMode, setSampleMode] = useState<'upload' | 'record' | 'system'>('record');
  const [audioDuration, setAudioDuration] = useState<number | null>(null);
  const [isValidatingAudio, setIsValidatingAudio] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const savingRef = useRef<number | null>(null);
  const nextSaveRef = useRef(0);
  const transcriptionRequestRef = useRef(0);
  const draftCloseRequestRef = useRef(0);
  const draftModeRef = useRef({ sampleMode, voiceSource, designPrompt });
  draftModeRef.current = { sampleMode, voiceSource, designPrompt };
  useEffect(() => () => {
    transcriptionRequestRef.current += 1;
  }, [open, editingProfileId]);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [selectedPresetEngine, setSelectedPresetEngine] = useState<string>('kokoro');
  const [selectedPresetVoiceId, setSelectedPresetVoiceId] = useState<string>('');
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const { isPlaying, playPause, cleanup: cleanupAudio } = useAudioPlayer();
  const cleanReferenceAudio = useMicrophoneStore((state) => state.cleanReferenceAudio);
  const isCreating = !editingProfileId;
  const serverUrl = useServerStore((state) => state.serverUrl);
  const serverRevision = useServerStore((state) => state.serverRevision);
  useEffect(() => () => { draftCloseRequestRef.current += 1; }, [open, editingProfileId, serverUrl, serverRevision]);
  useEffect(() => {
    setIsSaving(false);
    return () => { savingRef.current = null; };
  }, [open, editingProfileId, serverUrl, serverRevision]);
  const avatarEpoch = useRef(0);
  useEffect(() => () => { avatarEpoch.current += 1; }, [open, editingProfileId, serverUrl, serverRevision]);
  const [profileEffectsChain, setProfileEffectsChain] = useState<EffectConfig[]>([]);
  const [effectsDirty, setEffectsDirty] = useState(false);
  const [defaultEngine, setDefaultEngine] = useState<string>('');

  const form = useForm<ProfileFormValues>({
    resolver: zodResolver(makeProfileSchema(t)),
    defaultValues: {
      name: '',
      description: '',
      language: 'en',
      personality: '',
      sampleFile: undefined,
      referenceText: '',
      avatarFile: undefined,
    },
  });

  const selectedFile = form.watch('sampleFile');
  const selectedAvatarFile = form.watch('avatarFile');

  // Validate audio duration when file is selected
  useEffect(() => {
    let active = true;
    if (selectedFile && selectedFile instanceof File) {
      setIsValidatingAudio(true);
      getAudioDuration(selectedFile as File & { recordedDuration?: number })
        .then((duration) => {
          if (!active) return;
          setAudioDuration(duration);
          if (duration > MAX_AUDIO_DURATION_SECONDS) {
            form.setError('sampleFile', {
              type: 'manual',
              message: t('profileForm.validation.audioTooLong', {
                duration: formatAudioDuration(duration),
                max: formatAudioDuration(MAX_AUDIO_DURATION_SECONDS),
              }),
            });
          } else {
            form.clearErrors('sampleFile');
          }
        })
        .catch((error) => {
          if (!active) return;
          console.error('Failed to get audio duration:', error);
          setAudioDuration(null);
          const isRecordedFile =
            selectedFile.name.startsWith('recording-') ||
            selectedFile.name.startsWith('system-audio-');
          if (!isRecordedFile) {
            form.setError('sampleFile', {
              type: 'manual',
              message: t('profileForm.validation.audioFailed'),
            });
          } else {
            // Clear any existing errors for recorded files
            form.clearErrors('sampleFile');
          }
        })
        .finally(() => {
          if (active) setIsValidatingAudio(false);
        });
    } else {
      setIsValidatingAudio(false);
      setAudioDuration(null);
      form.clearErrors('sampleFile');
    }
    return () => { active = false; };
  }, [selectedFile, form, t]);

  const {
    isRecording,
    isStarting,
    audioStream: recordingStream,
    usingDefaultMicrophone,
    duration,
    error: recordingError,
    permissionDenied,
    startRecording,
    stopRecording,
    cancelRecording,
  } = useAudioRecording({
    processing: cleanReferenceAudio ? 'clean' : 'processed',
    maxDurationSeconds: 29,
    onRecordingComplete: (blob, recordedDuration) => {
      const file = new File([blob], `recording-${Date.now()}.webm`, {
        type: blob.type || 'audio/webm',
      }) as File & { recordedDuration?: number };
      // Store the actual recorded duration to bypass metadata reading issues on Windows
      if (recordedDuration !== undefined) {
        file.recordedDuration = recordedDuration;
      }
      form.setValue('sampleFile', file, { shouldValidate: true });
      toast({
        title: t('profileForm.toast.recordingComplete'),
        description: t('profileForm.toast.recordingCompleteDescription'),
      });
    },
  });

  const {
    isRecording: isSystemRecording,
    duration: systemDuration,
    error: systemRecordingError,
    isSupported: isSystemAudioSupported,
    startRecording: startSystemRecording,
    stopRecording: stopSystemRecording,
    cancelRecording: cancelSystemRecording,
  } = useSystemAudioCapture({
    maxDurationSeconds: 29,
    onRecordingComplete: (blob, recordedDuration) => {
      const file = new File([blob], `system-audio-${Date.now()}.wav`, {
        type: blob.type || 'audio/wav',
      }) as File & { recordedDuration?: number };
      // Store the actual recorded duration to bypass metadata reading issues on Windows
      if (recordedDuration !== undefined) {
        file.recordedDuration = recordedDuration;
      }
      form.setValue('sampleFile', file, { shouldValidate: true });
      toast({
        title: t('profileForm.toast.systemAudioCaptured'),
        description: t('profileForm.toast.systemAudioCapturedDescription'),
      });
    },
  });

  // Fetch available preset voices for the selected engine
  const presetEngineToQuery = isCreating
    ? selectedPresetEngine
    : (editingProfile?.preset_engine ?? '');
  const { data: presetVoicesData } = useQuery({
    queryKey: ['presetVoices', presetEngineToQuery],
    queryFn: () => apiClient.listPresetVoices(presetEngineToQuery),
    enabled:
      !!presetEngineToQuery &&
      ((voiceSource === 'builtin' && isCreating) ||
        (!isCreating && editingProfile?.voice_type === 'preset')),
  });
  const presetVoices = presetVoicesData?.voices ?? [];
  const isSampleBasedProfile = isCreating
    ? voiceSource === 'clone'
    : editingProfile?.voice_type !== 'preset' && editingProfile?.voice_type !== 'designed';
  const availableDefaultEngines = DEFAULT_ENGINE_OPTIONS.filter(
    (option) => !isSampleBasedProfile || !PRESET_ONLY_ENGINES.has(option.value),
  );

  useEffect(() => {
    if (systemRecordingError) {
      toast({
        title: t('profileForm.toast.systemAudioError'),
        description: systemRecordingError,
        variant: 'destructive',
      });
    }
  }, [systemRecordingError, toast, t]);

  // Handle avatar preview
  useEffect(() => {
    if (selectedAvatarFile instanceof File) {
      const url = URL.createObjectURL(selectedAvatarFile);
      setAvatarPreview(url);
      return () => URL.revokeObjectURL(url);
    } else if (editingProfile?.avatar_path) {
      setAvatarPreview(`${serverUrl}/profiles/${editingProfile.id}/avatar`);
    } else {
      setAvatarPreview(null);
    }
  }, [selectedAvatarFile, editingProfile, serverUrl]);

  // Restore form state from draft or editing profile
  useEffect(() => {
    if (editingProfile) {
      form.reset({
        name: editingProfile.name,
        description: editingProfile.description || '',
        language: editingProfile.language as LanguageCode,
        personality: editingProfile.personality || '',
        sampleFile: undefined,
        referenceText: undefined,
        avatarFile: undefined,
      });
      setProfileEffectsChain(editingProfile.effects_chain ?? []);
      setEffectsDirty(false);
      setDefaultEngine(editingProfile.default_engine ?? '');
    } else if (profileFormDraft && open) {
      // Restore from draft when opening in create mode
      form.reset({
        name: profileFormDraft.name,
        description: profileFormDraft.description,
        language: profileFormDraft.language as LanguageCode,
        personality: profileFormDraft.personality || '',
        referenceText: profileFormDraft.referenceText,
        sampleFile: undefined,
        avatarFile: undefined,
      });
      setSampleMode(profileFormDraft.sampleMode);
      // Reopen in the mode the draft was written in, otherwise a designed
      // draft comes back as a clone with its description dropped.
      setVoiceSource(profileFormDraft.voiceSource ?? 'clone');
      setDesignPrompt(profileFormDraft.designPrompt ?? '');
      // Restore the file if we have it saved
      if (
        profileFormDraft.sampleFileData &&
        profileFormDraft.sampleFileName
      ) {
        try {
          const file = base64ToFile(
            profileFormDraft.sampleFileData,
            profileFormDraft.sampleFileName,
            profileFormDraft.sampleFileType ?? '',
          );
          form.setValue('sampleFile', file);
        } catch {
          // Keep the remaining draft fields if persisted audio is invalid.
        }
      }
    } else if (!open) {
      // Only reset to defaults when modal is closed and no draft
      form.reset({
        name: '',
        description: '',
        language: 'en',
        personality: '',
        sampleFile: undefined,
        referenceText: undefined,
        avatarFile: undefined,
      });
      setSampleMode('record');
      setAvatarPreview(null);
    }
  }, [editingProfile, profileFormDraft, open, form]);

  useEffect(() => {
    if (
      defaultEngine &&
      !availableDefaultEngines.some((option) => option.value === defaultEngine)
    ) {
      setDefaultEngine('');
    }
  }, [availableDefaultEngines, defaultEngine]);

  useEffect(() => {
    if (!selectedPresetVoiceId) {
      return;
    }

    if (!presetVoices.some((voice: PresetVoice) => voice.voice_id === selectedPresetVoiceId)) {
      setSelectedPresetVoiceId('');
    }
  }, [presetVoices, selectedPresetVoiceId]);
  async function handleTranscribe() {
    const file = form.getValues('sampleFile');
    if (!file) {
      toast({
        title: t('profileForm.toast.noFile'),
        description: t('profileForm.toast.noFileDescription'),
        variant: 'destructive',
      });
      return;
    }

    const request = ++transcriptionRequestRef.current;
    const serverScope = currentServerScope();
    const language = form.getValues('language');
    const referenceText = form.getValues('referenceText');
    const isCurrent = () =>
      request === transcriptionRequestRef.current &&
      isCurrentServer(serverScope) &&
      useUIStore.getState().profileDialogOpen &&
      form.getValues('sampleFile') === file &&
      form.getValues('language') === language &&
      form.getValues('referenceText') === referenceText;

    try {
      const result = await transcribe.mutateAsync({ file, language, _serverScope: serverScope });
      if (!isCurrent()) return;
      form.setValue('referenceText', result.text, { shouldValidate: true });
    } catch (error) {
      if (!isCurrent()) return;
      toast({
        title: t('profileForm.toast.transcribeFailed'),
        description:
          error instanceof Error ? error.message : t('profileForm.toast.transcribeFailedFallback'),
        variant: 'destructive',
      });
    }
  }

  function handleCancelRecording() {
    if (sampleMode === 'record') {
      cancelRecording();
    } else if (sampleMode === 'system') {
      cancelSystemRecording();
    }
    form.resetField('sampleFile');
    cleanupAudio();
  }

  function handlePlayPause() {
    const file = form.getValues('sampleFile');
    playPause(file);
  }

  function handleAvatarFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      if (!file.type.startsWith('image/')) {
        toast({
          title: t('profileForm.toast.invalidFile'),
          description: t('profileForm.toast.invalidImageFormat'),
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
      avatarEpoch.current += 1;
      form.setValue('avatarFile', file);
    }
  }

  async function handleRemoveAvatar() {
    const epoch = ++avatarEpoch.current;
    const scope = currentServerScope();
    const isCurrent = () => avatarEpoch.current === epoch && isCurrentServer(scope);
    if (editingProfileId && editingProfile?.avatar_path) {
      try {
        await deleteAvatar.mutateAsync({ profileId: editingProfileId, _serverScope: scope });
        if (!isCurrent()) return;
        toast({
          title: t('profileForm.toast.avatarRemoved'),
          description: t('profileForm.toast.avatarRemovedDescription'),
        });
      } catch (error) {
        if (!isCurrent()) return;
        toast({
          title: t('profileForm.toast.avatarRemoveFailed'),
          description: error instanceof Error ? error.message : t('common.unknownError'),
          variant: 'destructive',
        });
        return;
      }
    }
    form.setValue('avatarFile', undefined);
    setAvatarPreview(null);
    if (avatarInputRef.current) {
      avatarInputRef.current.value = '';
    }
  }

  async function onSubmit(data: ProfileFormValues, serverScope: ServerScope) {
    if (savingRef.current !== null) return;
    const saveId = ++nextSaveRef.current;
    savingRef.current = saveId;
    setIsSaving(true);
    const isCurrentSave = () => {
      const state = useUIStore.getState();
      return savingRef.current === saveId && state.profileDialogOpen && state.editingProfileId === editingProfileId;
    };
    const saveToast = (value: Parameters<typeof toast>[0]) => {
      if (isCurrentSave()) toast(value);
    };
    const ensureServer = () => {
      if (isCurrentServer(serverScope)) return true;
      saveToast({
        title: t('profileForm.toast.serverChangedTitle', { defaultValue: 'Server connection changed' }),
        description: t('profileForm.toast.serverChangedDescription', {
          defaultValue: 'Check the previous server for any partially saved voice.',
        }),
        variant: 'destructive',
      });
      return false;
    };
    try {
      if (!ensureServer()) return;
      if (editingProfileId) {
        // Editing: update profile
        await updateProfile.mutateAsync({
          profileId: editingProfileId,
          _serverScope: serverScope,
          data: {
            name: data.name,
            description: data.description,
            language: data.language,
            default_engine: defaultEngine || undefined,
            personality: data.personality?.trim() ? data.personality.trim() : undefined,
          },
        });

        if (!ensureServer()) return;
        // Handle avatar upload/update if file changed
        if (data.avatarFile) {
          try {
            await uploadAvatar.mutateAsync({
              profileId: editingProfileId,
              file: data.avatarFile,
              _serverScope: serverScope,
            });
          } catch (avatarError) {
            if (!ensureServer()) return;
            saveToast({
              title: t('profileForm.toast.avatarUploadFailed'),
              description:
                avatarError instanceof Error
                  ? avatarError.message
                  : t('profileForm.toast.avatarUploadFailedFallback'),
              variant: 'destructive',
            });
          }
        }

        if (!ensureServer()) return;
        // Save effects chain if changed
        if (effectsDirty) {
          try {
            await updateEffects.mutateAsync({
              profileId: editingProfileId,
              effectsChain: profileEffectsChain.length > 0 ? profileEffectsChain : null,
              _serverScope: serverScope,
            });
          } catch (fxError) {
            if (!ensureServer()) return;
            saveToast({
              title: t('profileForm.toast.effectsUpdateFailed'),
              description:
                fxError instanceof Error
                  ? fxError.message
                  : t('profileForm.toast.effectsUpdateFailedFallback'),
              variant: 'destructive',
            });
            return;
          }
        }

        if (!ensureServer()) return;
        saveToast({
          title: t('profileForm.toast.voiceUpdated'),
          description: t('profileForm.toast.voiceUpdatedDescription', { name: data.name }),
        });
      } else if (voiceSource === 'builtin') {
        // Creating preset profile from built-in voice
        if (!selectedPresetVoiceId) {
          saveToast({
            title: t('profileForm.toast.noVoiceSelected'),
            description: t('profileForm.toast.noVoiceSelectedDescription'),
            variant: 'destructive',
          });
          return;
        }

        if (!ensureServer()) return;
        const profile = await createProfile.mutateAsync({
          _serverScope: serverScope,
          name: data.name,
          description: data.description,
          language: data.language,
          voice_type: 'preset' as VoiceType,
          preset_engine: selectedPresetEngine,
          preset_voice_id: selectedPresetVoiceId,
          default_engine: selectedPresetEngine,
          personality: data.personality?.trim() ? data.personality.trim() : undefined,
        });

        if (!ensureServer()) return;
        // Handle avatar upload if provided
        if (data.avatarFile) {
          try {
            await uploadAvatar.mutateAsync({
              profileId: profile.id,
              file: data.avatarFile,
              _serverScope: serverScope,
            });
          } catch (avatarError) {
            if (!ensureServer()) return;
            saveToast({
              title: t('profileForm.toast.avatarUploadFailed'),
              description:
                avatarError instanceof Error
                  ? avatarError.message
                  : t('profileForm.toast.avatarUploadFailedFallback'),
              variant: 'destructive',
            });
          }
        }

        if (!ensureServer()) return;
        saveToast({
          title: t('profileForm.toast.profileCreated'),
          description: t('profileForm.toast.profileCreatedBuiltin', { name: data.name }),
        });
      } else if (voiceSource === 'design') {
        // Creating a designed profile from a written voice description
        const trimmedDesign = designPrompt.trim();
        if (!trimmedDesign) {
          saveToast({
            title: t('profileForm.toast.noDesignPrompt'),
            description: t('profileForm.toast.noDesignPromptDescription'),
            variant: 'destructive',
          });
          return;
        }

        if (!ensureServer()) return;
        const profile = await createProfile.mutateAsync({
          _serverScope: serverScope,
          name: data.name,
          description: data.description,
          language: data.language,
          voice_type: 'designed' as VoiceType,
          design_prompt: trimmedDesign,
          default_engine: DESIGN_ENGINE,
          personality: data.personality?.trim() ? data.personality.trim() : undefined,
        });

        if (!ensureServer()) return;
        // Handle avatar upload if provided
        if (data.avatarFile) {
          try {
            await uploadAvatar.mutateAsync({
              profileId: profile.id,
              file: data.avatarFile,
              _serverScope: serverScope,
            });
          } catch (avatarError) {
            if (!ensureServer()) return;
            saveToast({
              title: t('profileForm.toast.avatarUploadFailed'),
              description:
                avatarError instanceof Error
                  ? avatarError.message
                  : t('profileForm.toast.avatarUploadFailedFallback'),
              variant: 'destructive',
            });
          }
        }

        if (!ensureServer()) return;
        saveToast({
          title: t('profileForm.toast.profileCreated'),
          description: t('profileForm.toast.profileCreatedDesigned', { name: data.name }),
        });
      } else {
        // Creating cloned profile: require sample file and reference text
        const sampleFile = form.getValues('sampleFile');
        const referenceText = form.getValues('referenceText');

        if (!sampleFile) {
          form.setError('sampleFile', {
            type: 'manual',
            message: t('profileForm.validation.sampleRequired'),
          });
          saveToast({
            title: t('profileForm.toast.sampleRequired'),
            description: t('profileForm.toast.sampleRequiredDescription'),
            variant: 'destructive',
          });
          return;
        }

        if (!referenceText || referenceText.trim().length === 0) {
          form.setError('referenceText', {
            type: 'manual',
            message: t('profileForm.validation.referenceTextRequired'),
          });
          saveToast({
            title: t('profileForm.toast.referenceTextRequired'),
            description: t('profileForm.toast.referenceTextRequiredDescription'),
            variant: 'destructive',
          });
          return;
        }

        // The user can replace the sample while asynchronous validation runs.
        const sampleIsCurrent = () =>
          useUIStore.getState().profileDialogOpen &&
          form.getValues('sampleFile') === sampleFile &&
          form.getValues('referenceText') === referenceText;
        try {
          const duration = await getAudioDuration(sampleFile);
          if (!sampleIsCurrent()) return;
          if (duration > MAX_AUDIO_DURATION_SECONDS) {
            form.setError('sampleFile', {
              type: 'manual',
              message: t('profileForm.validation.audioTooLong', {
                duration: formatAudioDuration(duration),
                max: formatAudioDuration(MAX_AUDIO_DURATION_SECONDS),
              }),
            });
            saveToast({
              title: t('profileForm.toast.invalidAudio'),
              description: t('profileForm.toast.invalidAudioDescription', {
                duration: formatAudioDuration(duration),
                max: formatAudioDuration(MAX_AUDIO_DURATION_SECONDS),
              }),
              variant: 'destructive',
            });
            return;
          }
        } catch (error) {
          if (!sampleIsCurrent()) return;
          form.setError('sampleFile', {
            type: 'manual',
            message: t('profileForm.validation.audioFailed'),
          });
          saveToast({
            title: t('profileForm.toast.validationError'),
            description:
              error instanceof Error ? error.message : t('profileForm.validation.audioFailed'),
            variant: 'destructive',
          });
          return;
        }

        // Creating: create profile, then add sample
        if (!ensureServer()) return;
        const profile = await createProfile.mutateAsync({
          _serverScope: serverScope,
          name: data.name,
          description: data.description,
          language: data.language,
          default_engine: defaultEngine || undefined,
          personality: data.personality?.trim() ? data.personality.trim() : undefined,
        });

        if (!ensureServer()) return;
        // Convert non-WAV uploads to WAV so the backend can always use soundfile.
        // Recorded audio is already WAV (from useAudioRecording's convertToWav call).
        let fileToUpload: File = sampleFile;
        if (!sampleFile.type.includes('wav') && !sampleFile.name.toLowerCase().endsWith('.wav')) {
          try {
            const wavBlob = await convertToWav(sampleFile);
            const wavName = sampleFile.name.replace(/\.[^.]+$/, '.wav');
            fileToUpload = new File([wavBlob], wavName, { type: 'audio/wav' });
          } catch {
            // If browser can't decode the format, send the original and let the backend try.
          }
        }

        if (!ensureServer()) return;
        try {
          await addSample.mutateAsync({
            profileId: profile.id,
            file: fileToUpload,
            referenceText: referenceText,
            _serverScope: serverScope,
          });

          if (!ensureServer()) return;
          // Handle avatar upload if provided
          if (data.avatarFile) {
            try {
              await uploadAvatar.mutateAsync({
                profileId: profile.id,
                file: data.avatarFile,
                _serverScope: serverScope,
              });
            } catch (avatarError) {
              if (!ensureServer()) return;
              saveToast({
                title: 'Avatar upload failed',
                description:
                  avatarError instanceof Error ? avatarError.message : 'Failed to upload avatar',
                variant: 'destructive',
              });
            }
          }

          if (!ensureServer()) return;
          saveToast({
            title: t('profileForm.toast.profileCreated'),
            description: t('profileForm.toast.profileCreatedSample', { name: data.name }),
          });
        } catch (sampleError) {
          if (!ensureServer()) return;
          let rollbackSucceeded = false;
          try {
            await deleteProfile.mutateAsync({ profileId: profile.id, _serverScope: serverScope });
            rollbackSucceeded = true;
          } catch (rollbackError) {
            if (!ensureServer()) return;
            saveToast({
              title: t('profileForm.toast.rollbackFailed'),
              description:
                rollbackError instanceof Error
                  ? rollbackError.message
                  : t('profileForm.toast.rollbackFailedDescription'),
              variant: 'destructive',
            });
          }

          if (!ensureServer()) return;
          const rollbackSuffix = rollbackSucceeded
            ? ` ${t('profileForm.toast.profileRolledBack')}`
            : '';
          saveToast({
            title: t('profileForm.toast.sampleFailed'),
            description:
              sampleError instanceof Error
                ? `${sampleError.message}${rollbackSuffix}`
                : rollbackSucceeded
                  ? t('profileForm.toast.sampleFailedRolledBack')
                  : t('profileForm.toast.sampleFailedDescription'),
            variant: 'destructive',
          });
          return;
        }
      }

      if (!ensureServer() || !isCurrentSave()) return;
      // Clear draft and reset form on success
      setProfileFormDraft(null);
      form.reset();
      setDesignPrompt('');
      setEditingProfileId(null);
      setOpen(false);
    } catch (error) {
      if (!ensureServer()) return;
      saveToast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : t('profileForm.toast.saveFailed'),
        variant: 'destructive',
      });
    } finally {
      if (savingRef.current === saveId) {
        savingRef.current = null;
        setIsSaving(false);
      }
    }
  }

  async function handleOpenChange(newOpen: boolean) {
    const closeRequest = ++draftCloseRequestRef.current;
    if (!newOpen) {
      savingRef.current = null;
      setIsSaving(false);
    }
    if (!newOpen && isCreating) {
      // Save draft when closing the create modal
      const values = form.getValues();
      const hasContent =
        values.name ||
        values.description ||
        values.personality ||
        values.referenceText ||
        values.sampleFile ||
        designPrompt.trim();

      if (hasContent) {
        const draft: ProfileFormDraft = {
          name: values.name || '',
          description: values.description || '',
          language: values.language || 'en',
          personality: values.personality || '',
          referenceText: values.referenceText || '',
          sampleMode,
          voiceSource,
          designPrompt,
        };

        // Save file as base64 if present
        if (values.sampleFile) {
          try {
            draft.sampleFileName = values.sampleFile.name;
            draft.sampleFileType = values.sampleFile.type;
            draft.sampleFileData = await fileToBase64(values.sampleFile);
          } catch {
            // If file conversion fails, just don't save the file
          }
        }

        // A later close, a different dialog/server, or edits made while the
        // file was being read must not be replaced by this older snapshot.
        const current = form.getValues();
        const currentMode = draftModeRef.current;
        const server = useServerStore.getState();
        if (
          draftCloseRequestRef.current !== closeRequest ||
          !useUIStore.getState().profileDialogOpen ||
          useUIStore.getState().editingProfileId !== editingProfileId ||
          server.serverUrl !== serverUrl || server.serverRevision !== serverRevision ||
          current.name !== values.name || current.description !== values.description ||
          current.language !== values.language || current.personality !== values.personality ||
          current.referenceText !== values.referenceText || current.sampleFile !== values.sampleFile ||
          current.avatarFile !== values.avatarFile || currentMode.sampleMode !== sampleMode ||
          currentMode.voiceSource !== voiceSource || currentMode.designPrompt !== designPrompt
        ) return;
        setProfileFormDraft(draft);
      }
    }

    setOpen(newOpen);
    if (!newOpen) {
      setEditingProfileId(null);
      // Don't reset form here - let the effect handle it based on draft state
      if (isRecording || isStarting) {
        cancelRecording();
      }
      if (isSystemRecording) {
        cancelSystemRecording();
      }
      cleanupAudio();
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex h-[calc(100dvh-1.5rem)] max-h-[680px] w-[calc(100vw-1.5rem)] max-w-5xl flex-col gap-0 overflow-hidden p-0 sm:h-[calc(100dvh-3rem)] sm:w-[calc(100vw-3rem)]">
        <div className="flex min-h-0 w-full flex-1 flex-col overflow-hidden">
          <DialogHeader className="shrink-0 border-b border-border/60 px-4 py-3 sm:px-5">
            <DialogTitle className="text-xl">
              {editingProfileId ? t('profileForm.editTitle') : t('profileForm.createTitle')}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {editingProfileId
                ? t('profileForm.editDescription')
                : t('profileForm.createDescription')}
            </DialogDescription>
            {isCreating && profileFormDraft && (
              <div className="flex items-center gap-2 pt-2">
                <span className="text-xs text-muted-foreground">
                  {t('profileForm.draftRestored')}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs text-muted-foreground"
                  onClick={() => {
                    setProfileFormDraft(null);
                    form.reset({
                      name: '',
                      description: '',
                      language: 'en',
                      personality: '',
                      sampleFile: undefined,
                      referenceText: '',
                      avatarFile: undefined,
                    });
                    setSampleMode('record');
                    setDesignPrompt('');
                  }}
                >
                  <X className="h-3 w-3 mr-1" />
                  {t('profileForm.discard')}
                </Button>
              </div>
            )}
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={(event) => {
              const scope = currentServerScope();
              return form.handleSubmit((data) => onSubmit(data, scope))(event);
            }} className="flex-1 min-h-0 flex flex-col">
              <div className="visible-scrollbar flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-4 scroll-py-4 min-[960px]:grid min-[960px]:grid-cols-2 min-[960px]:grid-rows-[minmax(0,1fr)] min-[960px]:gap-5 min-[960px]:overflow-hidden">
                {/* Left column: Sample management */}
                <div className="visible-scrollbar min-w-0 shrink-0 space-y-3 min-[960px]:min-h-0 min-[960px]:overflow-y-auto min-[960px]:overscroll-contain min-[960px]:border-r min-[960px]:border-border/60 min-[960px]:pr-5 min-[960px]:pb-3 min-[960px]:scroll-py-3">
                  <h3 className="text-[13px] font-semibold">
                    {t('profileForm.sections.reference', { defaultValue: 'Voice source' })}
                  </h3>
                  {isCreating ? (
                    <>
                      {/* Voice source selector */}
                      <div className="flex pb-2">
                        <div className="inline-flex flex-wrap gap-1 rounded-xl border border-border/70 p-1 bg-muted/30">
                          <button
                            type="button"
                            aria-pressed={voiceSource === 'clone'}
                            onClick={() => setVoiceSource('clone')}
                            className={`inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-md transition-colors ${
                              voiceSource === 'clone'
                                ? 'bg-accent text-accent-foreground shadow-sm'
                                : 'text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            <Mic className="h-3.5 w-3.5" />
                            {t('profileForm.source.clone')}
                          </button>
                          <button
                            type="button"
                            aria-pressed={voiceSource === 'builtin'}
                            onClick={() => setVoiceSource('builtin')}
                            className={`inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-md transition-colors ${
                              voiceSource === 'builtin'
                                ? 'bg-accent text-accent-foreground shadow-sm'
                                : 'text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            <Music className="h-3.5 w-3.5" />
                            {t('profileForm.source.builtin')}
                          </button>
                          <button
                            type="button"
                            aria-pressed={voiceSource === 'design'}
                            onClick={() => setVoiceSource('design')}
                            className={`inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-md transition-colors ${
                              voiceSource === 'design'
                                ? 'bg-accent text-accent-foreground shadow-sm'
                                : 'text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            <Sparkles className="h-3.5 w-3.5" />
                            {t('profileForm.source.design')}
                          </button>
                        </div>
                      </div>

                      {voiceSource === 'design' ? (
                        <div className="space-y-4">
                          <FormDescription>{t('profileForm.design.hint')}</FormDescription>

                          <FormItem>
                            <FormLabel>{t('profileForm.fields.designPrompt')}</FormLabel>
                            <FormControl>
                              <Textarea
                                value={designPrompt}
                                onChange={(e) => setDesignPrompt(e.target.value)}
                                placeholder={t('profileForm.design.placeholder')}
                                maxLength={MAX_DESIGN_PROMPT_LENGTH}
                                rows={6}
                                className="resize-none"
                              />
                            </FormControl>
                            <div className="flex justify-between">
                              <p className="text-xs text-muted-foreground">
                                {t('profileForm.design.engineNote')}
                              </p>
                              <p className="text-xs text-muted-foreground tabular-nums">
                                {designPrompt.length}/{MAX_DESIGN_PROMPT_LENGTH}
                              </p>
                            </div>
                          </FormItem>
                        </div>
                      ) : voiceSource === 'builtin' ? (
                        <div className="space-y-4">
                          <FormItem>
                            <FormLabel>{t('profileForm.fields.engine')}</FormLabel>
                            <Select
                              value={selectedPresetEngine}
                              onValueChange={setSelectedPresetEngine}
                            >
                              <FormControl>
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                <SelectItem value="kokoro">Kokoro 82M</SelectItem>
                                <SelectItem value="qwen_custom_voice">Qwen CustomVoice</SelectItem>
                              </SelectContent>
                            </Select>
                          </FormItem>

                          {/* Voice picker */}
                          <FormItem>
                            <FormLabel>{t('profileForm.fields.voice')}</FormLabel>
                            <div className="visible-scrollbar grid max-h-[min(19rem,38dvh)] grid-cols-2 gap-1.5 overflow-y-auto p-0.5">
                              {presetVoices.map((voice: PresetVoice) => (
                                <button
                                  key={voice.voice_id}
                                  type="button"
                                  aria-pressed={selectedPresetVoiceId === voice.voice_id}
                                  onClick={() => {
                                    setSelectedPresetVoiceId(voice.voice_id);
                                    // Auto-set language from voice
                                    if (voice.language) {
                                      form.setValue('language', voice.language as LanguageCode);
                                    }
                                  }}
                                  className={`text-left px-3 py-2 rounded-md border text-sm transition-colors ${
                                    selectedPresetVoiceId === voice.voice_id
                                      ? 'border-accent bg-accent/10 text-foreground'
                                      : 'border-border hover:bg-muted'
                                  }`}
                                >
                                  <div className="font-medium">{voice.name}</div>
                                  <div className="flex gap-1.5 mt-0.5">
                                    <Badge variant="outline" className="text-[10px] h-4 px-1">
                                      {voice.gender}
                                    </Badge>
                                    <Badge variant="outline" className="text-[10px] h-4 px-1">
                                      {voice.language}
                                    </Badge>
                                  </div>
                                </button>
                              ))}
                            </div>
                          </FormItem>
                        </div>
                      ) : (
                        <>
                          <Tabs
                            className="pt-0"
                            value={sampleMode}
                            onValueChange={(v) => {
                              const newMode = v as 'upload' | 'record' | 'system';
                              // Cancel any active recordings when switching modes
                              if ((isRecording || isStarting) && newMode !== 'record') {
                                cancelRecording();
                              }
                              if (isSystemRecording && newMode !== 'system') {
                                cancelSystemRecording();
                              }
                              setSampleMode(newMode);
                            }}
                          >
                            <TabsList
                              className={`grid w-full ${platform.metadata.isTauri && isSystemAudioSupported ? 'grid-cols-3' : 'grid-cols-2'}`}
                            >
                              <TabsTrigger value="upload" className="flex items-center gap-2">
                                <Upload className="h-4 w-4 shrink-0" />
                                {t('profileForm.sampleTabs.upload')}
                              </TabsTrigger>
                              <TabsTrigger value="record" className="flex items-center gap-2">
                                <Mic className="h-4 w-4 shrink-0" />
                                {t('profileForm.sampleTabs.record')}
                              </TabsTrigger>
                              {platform.metadata.isTauri && isSystemAudioSupported && (
                                <TabsTrigger value="system" className="flex items-center gap-2">
                                  <Monitor className="h-4 w-4 shrink-0" />
                                  {t('profileForm.sampleTabs.system')}
                                </TabsTrigger>
                              )}
                            </TabsList>

                            <TabsContent value="upload" className="space-y-4">
                              <FormField
                                control={form.control}
                                name="sampleFile"
                                render={({ field: { onChange, name } }) => (
                                  <AudioSampleUpload
                                    file={selectedFile}
                                    onFileChange={onChange}
                                    onTranscribe={handleTranscribe}
                                    onPlayPause={handlePlayPause}
                                    isPlaying={isPlaying}
                                    isValidating={isValidatingAudio}
                                    isTranscribing={transcribe.isPending}
                                    isDisabled={
                                      audioDuration !== null &&
                                      audioDuration > MAX_AUDIO_DURATION_SECONDS
                                    }
                                    fieldName={name}
                                  />
                                )}
                              />
                            </TabsContent>

                            <TabsContent value="record" className="space-y-4">
                              <FormField
                                control={form.control}
                                name="sampleFile"
                                render={() => (
                                  <AudioSampleRecording
                                    file={selectedFile}
                                    isRecording={isRecording}
                                    isStarting={isStarting}
                                    recordingStream={recordingStream}
                                    usingDefaultMicrophone={usingDefaultMicrophone}
                                    recordingError={recordingError}
                                    permissionDenied={permissionDenied}
                                    duration={duration}
                                    onStart={startRecording}
                                    onStop={stopRecording}
                                    onCancel={handleCancelRecording}
                                    onTranscribe={handleTranscribe}
                                    onPlayPause={handlePlayPause}
                                    isPlaying={isPlaying}
                                    isTranscribing={transcribe.isPending}
                                  />
                                )}
                              />
                            </TabsContent>

                            {platform.metadata.isTauri && isSystemAudioSupported && (
                              <TabsContent value="system" className="space-y-4">
                                <FormField
                                  control={form.control}
                                  name="sampleFile"
                                  render={() => (
                                    <AudioSampleSystem
                                      file={selectedFile}
                                      isRecording={isSystemRecording}
                                      duration={systemDuration}
                                      onStart={startSystemRecording}
                                      onStop={stopSystemRecording}
                                      onCancel={handleCancelRecording}
                                      onTranscribe={handleTranscribe}
                                      onPlayPause={handlePlayPause}
                                      isPlaying={isPlaying}
                                      isTranscribing={transcribe.isPending}
                                    />
                                  )}
                                />
                              </TabsContent>
                            )}
                          </Tabs>

                          <FormField
                            control={form.control}
                            name="referenceText"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>{t('profileForm.fields.referenceText')}</FormLabel>
                                <FormControl>
                                  <Textarea
                                    placeholder={t('profileForm.fields.referenceTextPlaceholder')}
                                    className="min-h-[100px]"
                                    {...field}
                                  />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                          {open && selectedFile && (
                            <SampleQuality
                              file={selectedFile}
                              referenceText={form.watch('referenceText') ?? ''}
                              language={form.watch('language')}
                            />
                          )}
                        </>
                      )}
                    </>
                  ) : (
                    // Editing mode
                    editingProfileId &&
                    editingProfile &&
                    (editingProfile.voice_type === 'preset' ? (
                      <div className="space-y-4 pt-4">
                        <div className="rounded-lg border border-border p-4 space-y-3">
                          <div className="text-sm font-medium text-muted-foreground">
                            {t('profileForm.builtin.badge')}
                          </div>
                          <div className="flex items-center gap-3">
                            <div className="text-lg font-semibold">
                              {presetVoices.find(
                                (v: PresetVoice) => v.voice_id === editingProfile.preset_voice_id,
                              )?.name ?? editingProfile.preset_voice_id}
                            </div>
                            <Badge variant="secondary" className="text-xs">
                              {editingProfile.preset_engine}
                            </Badge>
                          </div>
                          {(() => {
                            const voice = presetVoices.find(
                              (v: PresetVoice) => v.voice_id === editingProfile.preset_voice_id,
                            );
                            return voice ? (
                              <div className="flex gap-1.5">
                                <Badge variant="outline" className="text-xs">
                                  {voice.gender}
                                </Badge>
                                <Badge variant="outline" className="text-xs">
                                  {voice.language}
                                </Badge>
                              </div>
                            ) : null;
                          })()}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {t('profileForm.builtin.note')}
                        </p>
                      </div>
                    ) : editingProfile.voice_type === 'designed' ? (
                      <div className="space-y-4 pt-4">
                        <div className="rounded-lg border border-border p-4 space-y-3">
                          <div className="text-sm font-medium text-muted-foreground">
                            {t('profileForm.design.badge')}
                          </div>
                          <p className="text-sm leading-relaxed">{editingProfile.design_prompt}</p>
                          <Badge variant="secondary" className="text-xs">
                            {editingProfile.default_engine}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {t('profileForm.design.note')}
                        </p>
                      </div>
                    ) : (
                      <div>
                        <SampleList profileId={editingProfileId} />
                      </div>
                    ))
                  )}
                </div>

                {/* Right column: Profile info */}
                <div className="visible-scrollbar min-w-0 shrink-0 space-y-3 max-[959px]:border-t max-[959px]:border-border/60 max-[959px]:pt-4 min-[960px]:min-h-0 min-[960px]:overflow-y-auto min-[960px]:overscroll-contain min-[960px]:px-1 min-[960px]:pb-2 min-[960px]:scroll-py-3">
                  <FormSection
                    title={t('profileForm.sections.voiceDetails', {
                      defaultValue: 'Voice details',
                    })}
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
                              placeholder={t('profileForm.fields.namePlaceholder')}
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    {/* Avatar Upload */}
                    <FormField
                      control={form.control}
                      name="avatarFile"
                      render={() => (
                        <FormItem>
                          <FormControl>
                            <div className="flex items-center gap-2.5">
                              <div className="relative group">
                                <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-accent/20 bg-accent/10">
                                  {avatarPreview ? (
                                    <img
                                      src={avatarPreview}
                                      alt={t('profileForm.avatar.alt')}
                                      className="h-full w-full object-cover"
                                    />
                                  ) : (
                                    <Mic className="size-4 text-accent" />
                                  )}
                                </div>
                                <button
                                  type="button"
                                  aria-label={t('profileForm.avatar.change', {
                                    defaultValue: 'Change voice image',
                                  })}
                                  onClick={() => avatarInputRef.current?.click()}
                                  className="absolute inset-0 flex cursor-pointer items-center justify-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                                >
                                  <Edit2 className="absolute -bottom-0.5 -right-0.5 size-4 rounded border border-border/70 bg-background p-0.5 text-muted-foreground group-hover:text-foreground" />
                                </button>
                                {(avatarPreview || editingProfile?.avatar_path) && (
                                  <button
                                    type="button"
                                    aria-label={t('profileForm.avatar.remove', {
                                      defaultValue: 'Remove voice image',
                                    })}
                                    onClick={handleRemoveAvatar}
                                    disabled={deleteAvatar.isPending}
                                    className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full border border-border/70 bg-background text-muted-foreground shadow-sm transition-colors hover:text-foreground"
                                  >
                                    <X className="h-3.5 w-3.5" />
                                  </button>
                                )}
                              </div>
                              <div className="space-y-0.5">
                                <p className="text-xs font-medium">
                                  {t('profileForm.avatar.title', { defaultValue: 'Voice image' })}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  {t('profileForm.avatar.hint', {
                                    defaultValue: 'Optional · PNG, JPG or WebP',
                                  })}
                                </p>
                              </div>
                              <input
                                ref={avatarInputRef}
                                type="file"
                                accept="image/png,image/jpeg,image/webp"
                                onChange={handleAvatarFileChange}
                                className="hidden"
                              />
                            </div>
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
                          <FormLabel>{t('profileForm.fields.descriptionLabel')}</FormLabel>
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
                  </FormSection>
                  <FormSection
                    title={t('profileForm.sections.delivery', { defaultValue: 'Voice & delivery' })}
                    className="space-y-3 border-t border-border/60 pt-3"
                  >
                    <FormField
                      control={form.control}
                      name="personality"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t('profileForm.fields.personalityLabel')}</FormLabel>
                          <FormControl>
                            <Textarea
                              placeholder={t('profileForm.fields.personalityPlaceholder')}
                              rows={2}
                              className="min-h-14 resize-y py-1.5 leading-5"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <FormField
                        control={form.control}
                        name="language"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>{t('profileForm.fields.language')}</FormLabel>
                            <Select onValueChange={field.onChange} value={field.value}>
                              <FormControl>
                                <SelectTrigger>
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

                      <FormItem>
                        <Label htmlFor={defaultEngineFieldId}>
                          {t('profileForm.fields.defaultEngine')}
                        </Label>
                        <Select
                          value={defaultEngine || '_none'}
                          onValueChange={(v) => {
                            setDefaultEngine(v === '_none' ? '' : v);
                          }}
                          disabled={
                            voiceSource === 'builtin' ||
                            voiceSource === 'design' ||
                            editingProfile?.voice_type === 'preset' ||
                            editingProfile?.voice_type === 'designed'
                          }
                        >
                          <SelectTrigger id={defaultEngineFieldId}>
                            <SelectValue placeholder={t('profileForm.fields.noPreference')} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="_none">
                              {t('profileForm.fields.noPreference')}
                            </SelectItem>
                            {availableDefaultEngines.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </FormItem>
                    </div>
                  </FormSection>

                  {editingProfileId && (
                    <FormSection
                      title={t('profileForm.fields.defaultEffects')}
                      description={t('profileForm.fields.defaultEffectsHint')}
                      className="space-y-3 border-t border-border/60 pt-3"
                    >
                      <EffectsChainEditor
                        value={profileEffectsChain}
                        onChange={(chain) => {
                          setProfileEffectsChain(chain);
                          setEffectsDirty(true);
                        }}
                        compact
                      />
                    </FormSection>
                  )}
                </div>
              </div>

              <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border/60 bg-card/50 px-4 py-3 sm:px-5">
                <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                  {t('common.cancel')}
                </Button>
                <Button
                  type="submit"
                  disabled={
                    isSaving || createProfile.isPending || updateProfile.isPending || addSample.isPending
                  }
                >
                  {createProfile.isPending || updateProfile.isPending || addSample.isPending
                    ? t('profileForm.actions.saving')
                    : editingProfileId
                      ? t('profileForm.actions.saveChanges')
                      : t('profileForm.actions.createProfile')}
                </Button>
              </div>
            </form>
          </Form>
        </div>
      </DialogContent>
    </Dialog>
  );
}
