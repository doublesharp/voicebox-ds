import { create } from 'zustand';
import type { GenerationFormValues } from '@/lib/hooks/useGenerationForm';

// Deliberately memory-only: drafts can contain private text.
interface GenerationDraftState {
  values: GenerationFormValues | null;
  textRevision: number;
  submitting: boolean;
  profileId: string | null;
  profileServerRevision: number;
  profileApplied: boolean;
  profileDefaultsBaseline: {
    engine: GenerationFormValues['engine'];
    language: GenerationFormValues['language'] | undefined;
    presetId: string | null;
  } | null;
  presetId: string | null;
  effectsOverridden: boolean;
  voiceoverPolish: boolean;
  setValues: (values: GenerationFormValues) => void;
  clearSubmittedText: (revision: number, text: string) => void;
  setSubmitting: (submitting: boolean) => void;
  selectProfile: (profileId: string | null, serverRevision: number) => void;
  markProfileApplied: () => void;
  setPresetId: (presetId: string | null, overridden?: boolean) => void;
  setVoiceoverPolish: (value: boolean) => void;
}

export const useGenerationDraftStore = create<GenerationDraftState>((set) => ({
  values: null,
  textRevision: 0,
  submitting: false,
  profileId: null,
  profileServerRevision: 0,
  profileApplied: false,
  profileDefaultsBaseline: null,
  presetId: null,
  effectsOverridden: false,
  voiceoverPolish: false,
  setValues: (values) =>
    set((state) => ({
      values: { ...values },
      textRevision: state.textRevision + (state.values?.text !== values.text ? 1 : 0),
    })),
  clearSubmittedText: (revision, text) =>
    set((state) =>
      state.values && state.textRevision === revision && state.values.text === text
        ? { values: { ...state.values, text: '' }, textRevision: state.textRevision + 1 }
        : state,
    ),
  setSubmitting: (submitting) => set({ submitting }),
  selectProfile: (profileId, profileServerRevision) =>
    set((state) =>
      state.profileId === profileId && state.profileServerRevision === profileServerRevision
        ? state
        : {
            profileId,
            profileServerRevision,
            profileApplied: false,
            effectsOverridden: false,
            voiceoverPolish: false,
            profileDefaultsBaseline: {
              engine: state.values?.engine,
              language: state.values?.language,
              presetId: state.presetId,
            },
          },
    ),
  markProfileApplied: () => set({ profileApplied: true }),
  setPresetId: (presetId, overridden = true) => set({ presetId, effectsOverridden: overridden }),
  setVoiceoverPolish: (voiceoverPolish) => set({ voiceoverPolish }),
}));
