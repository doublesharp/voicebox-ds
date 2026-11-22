import type { GenerationFormValues } from '@/lib/hooks/useGenerationForm';

type TtsEngine = NonNullable<GenerationFormValues['engine']>;

interface TtsModelOption {
  value: string;
  label: string;
  engine: TtsEngine;
  modelName: string;
  modelSize?: GenerationFormValues['modelSize'];
  optional?: boolean;
  acceleration?: string;
}

export const TTS_MODEL_OPTIONS: readonly TtsModelOption[] = [
  {
    value: 'qwen:1.7B',
    label: 'Qwen3-TTS 1.7B',
    engine: 'qwen',
    modelName: 'qwen-tts-1.7B',
    modelSize: '1.7B',
  },
  {
    value: 'qwen:0.6B',
    label: 'Qwen3-TTS 0.6B',
    engine: 'qwen',
    modelName: 'qwen-tts-0.6B',
    modelSize: '0.6B',
  },
  {
    value: 'qwen_custom_voice:1.7B',
    label: 'Qwen CustomVoice 1.7B',
    engine: 'qwen_custom_voice',
    modelName: 'qwen-custom-voice-1.7B',
    modelSize: '1.7B',
  },
  {
    value: 'qwen_custom_voice:0.6B',
    label: 'Qwen CustomVoice 0.6B',
    engine: 'qwen_custom_voice',
    modelName: 'qwen-custom-voice-0.6B',
    modelSize: '0.6B',
  },
  {
    value: 'qwen_voice_design',
    label: 'Qwen VoiceDesign 1.7B',
    engine: 'qwen_voice_design',
    modelName: 'qwen-voice-design-1.7B',
  },
  { value: 'moss_tts', label: 'MOSS-TTS Nano', engine: 'moss_tts', modelName: 'moss-tts' },
  { value: 'luxtts', label: 'LuxTTS', engine: 'luxtts', modelName: 'luxtts' },
  { value: 'chatterbox', label: 'Chatterbox', engine: 'chatterbox', modelName: 'chatterbox-tts' },
  {
    value: 'chatterbox_turbo',
    label: 'Chatterbox Turbo',
    engine: 'chatterbox_turbo',
    modelName: 'chatterbox-turbo',
  },
  { value: 'tada:1B', label: 'TADA 1B', engine: 'tada', modelName: 'tada-1b', modelSize: '1B' },
  {
    value: 'tada:3B',
    label: 'TADA 3B Multilingual',
    engine: 'tada',
    modelName: 'tada-3b-ml',
    modelSize: '3B',
  },
  { value: 'kokoro', label: 'Kokoro 82M', engine: 'kokoro', modelName: 'kokoro' },
  {
    value: 'omnivoice',
    label: 'OmniVoice (non-commercial)',
    engine: 'omnivoice',
    modelName: 'omnivoice',
  },
  {
    value: 'qwen:1.7B-8bit',
    label: 'Qwen3-TTS 1.7B 8-bit (Experimental)',
    engine: 'qwen',
    modelName: 'qwen-tts-1.7B-8bit',
    modelSize: '1.7B-8bit',
    optional: true,
    acceleration: 'Metal (MLX)',
  },
  {
    value: 'qwen:1.7B-4bit',
    label: 'Qwen3-TTS 1.7B 4-bit (Experimental)',
    engine: 'qwen',
    modelName: 'qwen-tts-1.7B-4bit',
    modelSize: '1.7B-4bit',
    optional: true,
    acceleration: 'Metal (MLX)',
  },
];

// The MLX dispatch in backend/backends/__init__.py and the PyTorch engines'
// get_torch_device options determine which acceleration paths Voicebox supports.
const QWEN_ACCELERATION = 'Metal (MLX), CUDA, ROCm, Intel XPU, DirectML';
const CHATTERBOX_ACCELERATION = 'Metal (MLX), CUDA, ROCm, Intel XPU';
const MPS_ACCELERATION = 'Metal (MPS), CUDA, ROCm, Intel XPU';
const ACCELERATION: Record<TtsEngine, string> = {
  qwen: QWEN_ACCELERATION,
  qwen_custom_voice: QWEN_ACCELERATION,
  qwen_voice_design: QWEN_ACCELERATION,
  moss_tts: 'CPU',
  luxtts: MPS_ACCELERATION,
  chatterbox: CHATTERBOX_ACCELERATION,
  chatterbox_turbo: CHATTERBOX_ACCELERATION,
  tada: 'CUDA, ROCm, Intel XPU',
  kokoro: 'Metal (MLX), CUDA, ROCm',
  omnivoice: MPS_ACCELERATION,
};

export function getModelAcceleration(option: TtsModelOption): string {
  return option.acceleration ?? ACCELERATION[option.engine];
}

export function getTtsModelOption(engine: TtsEngine, modelSize: GenerationFormValues['modelSize']) {
  return (
    TTS_MODEL_OPTIONS.find(
      (option) => option.engine === engine && option.modelSize === modelSize,
    ) ?? TTS_MODEL_OPTIONS.find((option) => option.engine === engine)!
  );
}
