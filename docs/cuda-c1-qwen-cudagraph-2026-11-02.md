# CUDA C1: CUDA-graph Qwen Base variants (2026-11-02)

Opt-in runtime variants of the Qwen Base PyTorch engine, `0.6B-cudagraph` and
`1.7B-cudagraph`, replay faster-qwen3-tts 0.3.2's predictor and talker CUDA
graphs around the stock `Qwen3TTSModel`. Stock sizes stay the default on every
platform. On one RTX 5070 Laptop GPU they generated 4.8 to 12.2 times faster
than stock, with matching durations and speaker similarity and close ASR error
on an automated corpus (one 1.7B gap is unresolved). Listening quality is
unqualified, so the variants are labelled Experimental. Raw logs, audio and
JSON live on scratch storage, not in Git.

## Runtime

- Package `faster-qwen3-tts==0.3.2` (commit `a70afc0f`, MIT), installed
  `--no-deps` like chatterbox-tts, hume-tada and omnivoice. It is the last
  release built on `qwen-tts` and transformers 4.57; later releases require
  transformers 5 and `qwen-tts-hf`, which occupies the same `qwen_tts` namespace.
  No separate worker process is needed.
- Checkpoints: `Qwen/Qwen3-TTS-12Hz-0.6B-Base@5d839924` and
  `Qwen/Qwen3-TTS-12Hz-1.7B-Base@fd4b2543`, bf16, SDPA attention.
- Variants are listed only when the backend is PyTorch and the runtime can run:
  NVIDIA CUDA torch (not ROCm/HIP), a CUDA device, no `VOICEBOX_FORCE_CPU`, the
  exact package version. The backend's own load enforces the same check, so no
  route can capture graphs on an unqualified host; the legacy
  `POST /models/load?model_size=` path answers 400 with the reason.
- Readiness, residency, generation rows and Studio identity carry the variant's
  own `model_size`, pinned revision and runtime record. The Studio adapter hash
  covers the graph modules as well as `pytorch_backend.py`.
- `backend.runtime_identity` reports `{"runtime": "stock"}` or the cudagraph
  record with the measured `graph_capture_s`. `backend.last_generation` reports
  `steps`, `hit_eos` and `max_new_tokens` for the current request only.
- A variant and the stock size of the same base share one Hugging Face cache
  directory. Deleting either while the other is loaded answers 409; a delete
  that succeeds says which other model lost its weights.

## Behavior differences from stock, recorded on purpose

- Capture runs at load, before any seeding, on the one thread that replays,
  using one reused side stream per device. The mask table for all 2048
  positions is built at load too, so the first request costs about 12% more
  than the next (1.73 s vs 1.54 s in the qualification). In gate 0, before this
  change, the first request took 10.0 s against 1.79 s for the next.
- The talker's static cache holds 2048 positions. The reference's codec frames
  fill the prefill and the text trails it, so the reference length decides
  whether a prompt fits. The token budget per request is `2048 - prompt length`
  (about 1960 steps, 160 s of speech, for the test references). Reaching it, or
  a prompt that does not fit, raises `CudaGraphRuntimeError`; stock allows 8192
  new tokens and never raises. Nothing is silently truncated.
- Codebook sampling (`subtalker_*`) is fixed inside the predictor graph at
  capture, from the checkpoint's `generation_config.json`. Talker sampling uses
  the same config values. Load refuses a config missing any sampling key.
- `instruct` is dropped, as stock Base already ignores it.
- Native streaming decodes a 25-frame sliding window per 12-step chunk, so
  seams are decoder windows, not exact frame boundaries.
- Unsupported and refused: CustomVoice and VoiceDesign graph variants,
  x-vector-only cloning, flash-attn, torch.compile, quantization, MLX, CPU.

## Host

Windows 11 native, RTX 5070 Laptop GPU (Blackwell, compute capability 12.0,
8151 MiB, driver 610.88), torch 2.11.0+cu128, transformers 4.57.3, qwen-tts
0.1.1. The desktop held 421 to 974 MiB of VRAM before each comparison process;
no run had an idle GPU. References were two synthetic Kokoro preset voices.

The comparison and quality scoring ran on a clean tree at `25fb051`. Two later
source changes followed review: capture now reuses one side stream instead of
clearing cuBLAS workspaces process-wide, and the generation outcome resets
before loading. Neither touches the replay or decode path. The real-CUDA tests
and the qualification below ran on a clean tree at `4c0b9a2` (recorded in the
run log), where replay still reproduces the gate-0 output bit for bit. The last
code change after that only passes explicit stream arguments through and warns
if upstream stops exposing `torch`; the real-CUDA cycle test passed on it.

## Stock vs CUDA graphs

`scripts/compare-local-tts.py`: fresh serial processes in ABBA order, the same
pinned assets, both references, seeds 42, 7 and 1234, and three texts (short,
medium, names and numbers). 0.6B ran 4 rounds (72 warm samples per side); 1.7B
ran 2 rounds (36, a small sample). Every candidate generation ended at EOS;
none reached the bound.

| | 0.6B stock | 0.6B graphs | 1.7B stock | 1.7B graphs |
| --- | --- | --- | --- | --- |
| Warm generation p50 / p95 | 27.2 / 76.7 s | 2.68 / 5.79 s | 26.1 / 73.9 s | 3.09 / 6.31 s |
| Output duration p50 / p95 | 6.88 / 16.1 s | 6.92 / 15.2 s | 7.04 / 15.2 s | 7.00 / 14.7 s |
| Load p50 (graphs include capture) | 7.8 s | 19.7 s (capture 11.6 s) | 7.8 s | 11.3 s (capture 5.5 s) |
| Peak allocated during generation p50 | 2.64 GB | 2.91 GB | 4.67 GB | 4.95 GB |

Stock timing is bimodal on this laptop, with process CPU time close to wall time
in both modes, so one host thread sets the pace. Most stock processes stayed in
one mode; three of 36 switched partway (for example 5.08, 3.09, then 2.11).
Classified by each process's median warm `wall_audio_rtf` (above 3 is slow),
slow processes ranged 3.09 to 4.97 (0.6B) and 4.77 to 5.71 (1.7B), fast ones
1.88 to 2.12 and 1.99 to 2.19. The graph variants stayed between 0.35 and 0.46
in every process. A pooled ratio would depend on which mode each round landed
in, so the comparison is reported per mode:

| `wall_audio_rtf` p50 (lower is better) | Stock, slow mode | Stock, fast mode | Graphs | Speedup |
| --- | --- | --- | --- | --- |
| 0.6B | 4.79 (15 processes) | 2.05 (9) | 0.392 | 12.2× slow, 5.2× fast |
| 1.7B | 5.06 (5) | 2.12 (7) | 0.440 | 11.5× slow, 4.8× fast |

Each speedup divides a per-mode stock p50 by the graph p50 pooled across modes.
The 0.6B graph runs were slightly faster in the fast-mode round (about 0.35 to
0.37), so the fast-mode ratio is, if anything, slightly understated. What
switches the host mode is not known.

## Speech quality signals

`scripts/score-local-tts.py` scored every saved WAV offline with Whisper base
(`openai/whisper-base@e37978b9`, Whisper's English normalizer on both sides)
and the Chatterbox voice encoder (an uncalibrated, relative speaker signal).

| | WER mean: short / medium / names and numbers | Similarity to own reference / to the other |
| --- | --- | --- |
| 0.6B stock | 0 / 0.015 / 0.262 | 0.919 / 0.598 |
| 0.6B graphs | 0 / 0.015 / 0.272 | 0.926 / 0.597 |
| 1.7B stock | 0 / 0.015 / 0.190 | 0.924 / 0.597 |
| 1.7B graphs | 0 / 0.010 / 0.224 | 0.923 / 0.596 |

Means cover every saved clip: 40 per text per side for 0.6B and 20 for 1.7B,
including cold and warmup generations. No repetition, omission, clipping or
non-finite output was flagged. The 1.7B names-and-numbers gap is within what
Whisper base's weakness on names and numbers can produce, and is not resolved
either way. A
blind audition set exists but no listening review has happened.

## Qualification

`scripts/qualify-qwen-cudagraph.py --second-model 1.7B-cudagraph
--lifecycle-cycles 10` passed all 12 gating checks on the final source. Spies only count graph
captures and replays.

- Capture then replay with no recapture; runtime identity truthful.
- Same seed bit-identical, different seed different; speaker A identical after B.
- Short, paragraph and second-speaker requests all ended at EOS.
- Generation bound: a 16,432-character text decoded 1959 steps and raised with
  `hit_eos: false`. Prompt bound: a 207.2 s reference (about 2590 codec frames
  at 12.5 Hz) was refused with zero replays. Later output stayed bit-identical
  after both.
- Capture failure left 35 MB allocated, the same floor as a clean unload; the
  next load, a different serialized call and a generation succeeded.
- 0.6B → 1.7B → 0.6B produced bit-identical 0.6B output.
- Ten load/generate/unload cycles each recaptured, and allocated VRAM after
  unload stayed at 35.2 MB in every cycle, flat to the byte. It includes three
  cuBLAS workspaces that live for the process (the default stream, the reused
  warmup stream and torch's shared capture stream, about 9 MiB each); the rest
  is not attributed. Host RSS after unload rose from 2614 to 2642 MiB over the
  ten.
- Recorded, not gated: an out-of-memory condition could not be provoked. With a
  4.15 GB filler held, the next generation still completed; how the variants
  behave at real VRAM exhaustion is unknown.

`backend/tests/test_qwen_cudagraph_cuda*.py` on the final source passed 18 of 18:

| | 0.6B-cudagraph | 1.7B-cudagraph |
| --- | --- | --- |
| Load incl. capture | 6.9 s (capture 5.0 s) | 7.8 s (capture 5.0 s) |
| Allocated / reserved after load | 2366 / 2572 MiB | 4328 / 4532 MiB |
| Device free after load | 4359 MiB | 2345 MiB |
| First request / warm replays (4.1 s and 3.7 s clips, 5 samples) | 1.65 s / 1.52 to 1.55 s | 1.77 s / 1.68 to 1.69 s |
| Paragraph, 25.7 s of speech | 9.2 s (321 steps) | 11.0 s (322 steps) |
| Streaming the same paragraph | 10.4 s, first frame 0.50 s | 12.4 s, first frame 0.54 s |
| Largest seam step vs p99 in-frame step | 0.051 vs 0.101 | 0.063 vs 0.094 |
| Allocated after unload / after capture failure (before load) | 58 / 58 MiB (33) | 62 / 62 MiB (58) |

The after-unload rows sit above their pre-load baseline because the test
module keeps its encoded voice prompts on the GPU between tests. Streaming
produced the same sample count as the buffered render, with correlation 0.9956
(0.6B) and 0.9959 (1.7B). Load and capture times varied
between runs (0.6B capture 5.0 s here, 11.6 s p50 in the comparison
processes); the cause was not investigated.

## Defect found and fixed

faster-qwen3-tts captures each graph on a new side stream, and PyTorch keeps a
cuBLAS workspace per stream for the life of the process. Every variant load
left about 16 MiB more allocated after unload: 34 MB over three cycles in the
real-CUDA cycle test. A first fix cleared all cuBLAS workspaces on release,
but that could free a workspace Whisper or the local LLM was using, since they
run outside the TTS lock. Capture now gives the upstream graph modules one
reused stream per device instead, and nothing clears workspaces globally. The
cycle test fails without a fix and passes with this one.

## Unqualified

Listening quality, other NVIDIA GPUs, Linux, frozen builds (C2), first audible
device latency, and the cause of the stock host modes.

## Rollback

Select the stock `0.6B` or `1.7B` size. Removing `faster-qwen3-tts` hides the
variants, and every selection of them fails before loading.
