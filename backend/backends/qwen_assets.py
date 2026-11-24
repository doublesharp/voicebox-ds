"""Assets shared by the Qwen3-TTS Base, CustomVoice, and VoiceDesign checkpoints."""

QWEN_TTS_REQUIRED_FILES = (
    "config.json",
    "generation_config.json",
    "merges.txt",
    "vocab.json",
    "tokenizer_config.json",
    "preprocessor_config.json",
    "model.safetensors",
    "speech_tokenizer/config.json",
    "speech_tokenizer/configuration.json",
    "speech_tokenizer/model.safetensors",
    "speech_tokenizer/preprocessor_config.json",
)

QWEN_MLX_REQUIRED_FILES = (*QWEN_TTS_REQUIRED_FILES, "model.safetensors.index.json")
