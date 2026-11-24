import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DELIVERY_PRESETS, type DeliveryPreset } from '@/lib/constants/delivery';

export interface VoiceDeliveryDefaults {
  delivery: DeliveryPreset;
  voiceoverPolish: boolean;
}

interface VoiceDeliveryState {
  defaults: Record<string, VoiceDeliveryDefaults>;
  save: (serverUrl: string, profileId: string, defaults: VoiceDeliveryDefaults) => void;
}

const voiceKey = (serverUrl: string, profileId: string) => JSON.stringify([serverUrl, profileId]);

// Only the choices are stored locally. Voice recordings and scripts stay with their existing owners.
export const useVoiceDeliveryStore = create<VoiceDeliveryState>()(
  persist(
    (set) => ({
      defaults: {},
      save: (serverUrl, profileId, defaults) =>
        set((state) => ({
          defaults: { ...state.defaults, [voiceKey(serverUrl, profileId)]: defaults },
        })),
    }),
    { name: 'voicebox-ds-voice-delivery', partialize: ({ defaults }) => ({ defaults }) },
  ),
);

export function voiceDeliveryDefaults(
  defaults: VoiceDeliveryState['defaults'],
  serverUrl: string,
  profileId: string,
): VoiceDeliveryDefaults | undefined {
  const value = defaults?.[voiceKey(serverUrl, profileId)];
  if (
    value &&
    DELIVERY_PRESETS.includes(value.delivery) &&
    typeof value.voiceoverPolish === 'boolean'
  ) {
    return value;
  }
}
