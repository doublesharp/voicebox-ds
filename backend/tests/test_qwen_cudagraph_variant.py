"""CUDA-graph Qwen variant contract, driven through fakes of faster-qwen3-tts 0.3.2 on CPU.

Every upstream class here is a fake that mirrors the pinned 0.3.2 interface; the
real capture, replay and audio proofs live in test_qwen_cudagraph_cuda.py.
"""

import json
import sys
import threading
from contextlib import nullcontext
from types import SimpleNamespace

import numpy as np
import pytest
import torch

from backend.backends import pytorch_backend as pt
from backend.backends import qwen_cuda_variants
from backend.backends import qwen_cudagraph as qc
from backend.backends.qwen_cuda_variants import CUDA_GRAPH_RUNTIME, CudaGraphRuntimeError

VARIANT = "0.6B-cudagraph"
PROMPT_LEN = 40
SAMPLING = {
    "do_sample": True, "top_k": 50, "top_p": 1.0, "temperature": 0.9, "repetition_penalty": 1.05,
    "subtalker_dosample": True, "subtalker_top_k": 50, "subtalker_top_p": 1.0, "subtalker_temperature": 0.9,
    "max_new_tokens": 8192,
}


class FakeUpstream:
    """Records what the adapter asks of the pinned runtime."""

    def __init__(self):
        self.events = []
        self.steps = 5
        self.prompt_len = PROMPT_LEN
        self.fail_capture = False
        self.predictor_top_k = None
        self.prepare_kwargs = []
        self.generate_kwargs = []
        self.stream_kwargs = []
        self.stream_chunks = [np.full(100, 0.1, dtype=np.float32), np.full(100, 0.2, dtype=np.float32)]
        self.graphs = []
        self.decoded = []
        upstream = self

        class PredictorGraph:
            def __init__(self, predictor, config, hidden, device, dtype, do_sample, top_k, top_p, temperature):
                self.do_sample, self.top_p, self.temperature = do_sample, top_p, temperature
                self.top_k = upstream.predictor_top_k if upstream.predictor_top_k is not None else top_k
                self.graph, self.captured, self.static_cache = None, False, object()
                upstream.graphs.append(self)

            def capture(self, num_warmup=3):
                self.graph, self.captured = object(), True

        class TalkerGraph:
            def __init__(self, model, config, device, dtype, max_seq_len):
                self.max_seq_len = max_seq_len
                self.cache_position = torch.zeros(1, dtype=torch.long)
                self.graph, self.captured, self.static_cache = None, False, object()
                self.attn_mask_table = self.attn_mask = None
                self.mask_states = []
                upstream.graphs.append(self)

            def capture(self, prefill_len=100, num_warmup=3):
                self.graph, self.captured = object(), True
                self.attn_mask_table = [object()] * self.max_seq_len

            def set_generation_state(self, attention_mask, rope_deltas):
                self.mask_states.append((tuple(attention_mask.shape), rope_deltas))

        class FasterQwen3TTS:
            def __init__(self, base_model, predictor_graph, talker_graph, device, dtype, max_seq_len):
                self.model, self.predictor_graph, self.talker_graph = base_model, predictor_graph, talker_graph
                self.device, self.dtype, self.max_seq_len = device, dtype, max_seq_len

            def warmup(self, prefill_len=100):
                upstream.events.append(("warmup", threading.get_ident(), prefill_len))
                if upstream.fail_capture:
                    raise RuntimeError("capture exploded")
                self.predictor_graph.capture()
                self.talker_graph.capture(prefill_len=prefill_len)

            def _prepare_generation(self, **kwargs):
                upstream.prepare_kwargs.append(kwargs)
                tie = torch.zeros(1, upstream.prompt_len, 8)
                return (self.model.model, "talker", "config", tie, torch.ones(1, upstream.prompt_len), "tth", "tpe",
                        torch.zeros(3, 16, dtype=torch.long))

            def generate_voice_clone_streaming(self, **kwargs):
                upstream.stream_kwargs.append(kwargs)
                total = 0
                for chunk in upstream.stream_chunks:
                    total += kwargs["chunk_size"]
                    upstream.events.append(("stream", threading.get_ident()))
                    yield chunk, 24000, {"total_steps_so_far": min(total, upstream.steps)}

        def fast_generate(**kwargs):
            upstream.generate_kwargs.append(kwargs)
            upstream.events.append(("generate", threading.get_ident()))
            steps = min(upstream.steps, kwargs["max_new_tokens"])
            return (torch.zeros(steps, 16, dtype=torch.long) if steps else None), {"steps": steps}

        self.modules = {
            "faster_qwen3_tts": SimpleNamespace(FasterQwen3TTS=FasterQwen3TTS),
            "faster_qwen3_tts.predictor_graph": SimpleNamespace(PredictorGraph=PredictorGraph),
            "faster_qwen3_tts.talker_graph": SimpleNamespace(TalkerGraph=TalkerGraph),
            "faster_qwen3_tts.generate": SimpleNamespace(fast_generate=fast_generate),
        }

    def stock_model(self):
        upstream = self

        def decode(payload):
            codes = payload["audio_codes"]
            upstream.decoded.append(tuple(codes.shape))
            return [np.linspace(0, 1, codes.shape[1] * 10, dtype=np.float32)], 24000

        talker = SimpleNamespace(code_predictor=SimpleNamespace(model=SimpleNamespace(config="pred-config")), model="talker-model")
        inner = SimpleNamespace(talker=talker, config=SimpleNamespace(talker_config=SimpleNamespace(hidden_size=8)),
                                speech_tokenizer=SimpleNamespace(decode=decode))
        return SimpleNamespace(model=inner, generate_defaults=dict(SAMPLING))


@pytest.fixture
def upstream(monkeypatch):
    fake = FakeUpstream()
    for name, module in fake.modules.items():
        monkeypatch.setitem(sys.modules, name, module)
    return fake


@pytest.fixture
def backend(monkeypatch, upstream):
    backend = pt.PyTorchTTSBackend(VARIANT)
    backend.device = "cuda"
    loads = []

    def from_pretrained(path, **kwargs):
        loads.append((path, kwargs))
        return upstream.stock_model()

    monkeypatch.setattr(qwen_cuda_variants, "cuda_graph_unavailable_reason", lambda: None)
    monkeypatch.setattr(pt, "is_model_cached", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(pt, "model_load_progress", lambda *_args: nullcontext())
    monkeypatch.setattr(pt, "empty_device_cache", lambda _device: None)
    monkeypatch.setitem(sys.modules, "qwen_tts", SimpleNamespace(Qwen3TTSModel=SimpleNamespace(from_pretrained=from_pretrained)))
    monkeypatch.setattr(pt, "manual_seed", lambda seed, device: upstream.events.append(("seed", threading.get_ident(), seed)))
    backend.loads = loads
    return backend


@pytest.mark.asyncio
async def test_capture_happens_at_load_before_seeding_on_the_replay_thread(backend, upstream):
    await backend.load_model(VARIANT)
    kinds = [event[0] for event in upstream.events]
    assert kinds == ["warmup"]
    path, kwargs = backend.loads[0]
    assert path == "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
    assert kwargs["revision"] == "5d83992436eae1d760afd27aff78a71d676296fc"
    assert kwargs["torch_dtype"] == torch.bfloat16 and kwargs["attn_implementation"] == "sdpa"
    assert backend._graphs.wrapper.model is backend.model
    assert backend._current_model_size == VARIANT and backend.is_loaded()

    await backend.generate("Hello", ["voice"], language="en", seed=3)
    threads = {event[1] for event in upstream.events}
    assert len(threads) == 1 and threading.get_ident() not in threads
    assert [event[0] for event in upstream.events] == ["warmup", "seed", "generate"]


@pytest.mark.asyncio
async def test_runtime_identity_reports_the_variant_truthfully(backend, upstream):
    assert backend.runtime_identity == {"runtime": "stock"}
    await backend.load_model(VARIANT)
    identity = backend.runtime_identity
    assert json.loads(json.dumps(identity)) == identity
    capture_s = identity.pop("graph_capture_s")
    assert isinstance(capture_s, float) and capture_s >= 0
    assert identity == {
        "runtime": "cudagraph", "package": "faster-qwen3-tts", "version": "0.3.2",
        "commit": "a70afc0f81f7f5f8801c3227968f1102f43f211c", "dtype": "bfloat16", "attn": "sdpa", "max_seq_len": 2048,
    }
    assert identity["max_seq_len"] == CUDA_GRAPH_RUNTIME.max_seq_len


@pytest.mark.asyncio
async def test_generation_uses_stock_sampling_and_drops_instruct(backend, upstream):
    audio, rate = await backend.generate("Hello", ["voice"], language="ja", seed=1, instruct="whisper")
    assert rate == 24000 and audio.dtype == np.float32 and audio.ndim == 1
    prepare = upstream.prepare_kwargs[0]
    assert prepare["instruct"] is None and prepare["language"] == "japanese" and prepare["voice_clone_prompt"] == ["voice"]
    generate = upstream.generate_kwargs[0]
    assert {key: generate[key] for key in ("do_sample", "top_k", "top_p", "temperature", "repetition_penalty")} == {
        "do_sample": True, "top_k": 50, "top_p": 1.0, "temperature": 0.9, "repetition_penalty": 1.05,
    }
    assert generate["max_new_tokens"] == 2048 - PROMPT_LEN
    assert backend.last_generation == {"steps": 5, "hit_eos": True, "max_new_tokens": 2048 - PROMPT_LEN}
    assert upstream.decoded == [(1, 3 + 5, 16)]
    # 80 decoded samples cover 8 frames; the 3 reference frames are cut back out.
    assert audio.size == 80 - 30


@pytest.mark.asyncio
async def test_reaching_the_bound_raises_instead_of_returning_a_clip(backend, upstream):
    upstream.steps = 2048 - PROMPT_LEN
    with pytest.raises(CudaGraphRuntimeError, match="bound"):
        await backend.generate("Hello", ["voice"], seed=1)
    assert backend.last_generation == {"steps": 2048 - PROMPT_LEN, "hit_eos": False, "max_new_tokens": 2048 - PROMPT_LEN}
    assert upstream.decoded == []


@pytest.mark.asyncio
async def test_a_run_without_codec_tokens_is_an_error_not_silence(backend, upstream):
    upstream.steps = 0
    with pytest.raises(CudaGraphRuntimeError, match="no codec tokens"):
        await backend.generate("Hello", ["voice"], seed=1)
    assert upstream.decoded == []


@pytest.mark.asyncio
async def test_prompt_that_does_not_fit_is_refused_before_decoding(backend, upstream):
    upstream.prompt_len = 2047
    with pytest.raises(CudaGraphRuntimeError, match="shorten"):
        await backend.generate("Hello", ["voice"])
    assert upstream.generate_kwargs == [] and upstream.decoded == []


@pytest.mark.asyncio
async def test_a_refused_prompt_does_not_report_the_previous_request(backend, upstream):
    await backend.generate("Hello", ["voice"], seed=1)
    assert backend.last_generation["steps"] == 5
    upstream.prompt_len = 2047
    with pytest.raises(CudaGraphRuntimeError, match="shorten"):
        await backend.generate("Hello", ["voice"], seed=1)
    assert backend.last_generation == {"steps": None, "hit_eos": None, "max_new_tokens": None}


@pytest.mark.asyncio
async def test_capture_failure_frees_everything_and_never_falls_back_to_stock(backend, upstream):
    upstream.fail_capture = True
    with pytest.raises(CudaGraphRuntimeError, match="capture"):
        await backend.load_model(VARIANT)
    assert not backend.is_loaded() and backend.model is None and backend._graphs is None
    assert backend._current_model_size is None and backend.runtime_identity == {"runtime": "stock"}
    assert backend.generate_stream is None

    upstream.fail_capture = False
    await backend.load_model(VARIANT)
    assert backend.runtime_identity["runtime"] == "cudagraph"
    assert all(graph.captured for graph in upstream.graphs[-2:])


@pytest.mark.parametrize("defect", ["mismatch", "missing"])
@pytest.mark.asyncio
async def test_sampling_that_differs_from_the_checkpoint_is_refused(backend, upstream, monkeypatch, defect):
    if defect == "mismatch":
        upstream.predictor_top_k = 40
    else:
        SAMPLING_WITHOUT = {key: value for key, value in SAMPLING.items() if key != "subtalker_top_k"}
        monkeypatch.setattr(upstream, "stock_model", lambda: setattr_defaults(upstream, SAMPLING_WITHOUT))
    with pytest.raises(CudaGraphRuntimeError, match="sampling|top_k"):
        await backend.load_model(VARIANT)
    assert not backend.is_loaded() and backend._graphs is None


def setattr_defaults(upstream, defaults):
    model = FakeUpstream.stock_model(upstream)
    model.generate_defaults = defaults
    return model


@pytest.mark.asyncio
async def test_unload_releases_graphs_and_reload_recaptures(backend, upstream):
    await backend.load_model(VARIANT)
    session = backend._graphs
    first_graphs = list(upstream.graphs)
    backend.unload_model()
    assert backend._graphs is None and backend.model is None and session.wrapper is None
    assert all(graph.graph is None and graph.static_cache is None for graph in first_graphs)
    assert backend.runtime_identity == {"runtime": "stock"} and backend.generate_stream is None

    await backend.load_model(VARIANT)
    assert backend._graphs is not session and len(upstream.graphs) == 4
    assert backend.runtime_identity["runtime"] == "cudagraph"


@pytest.mark.asyncio
async def test_size_switch_unloads_the_graphs_before_loading_the_next_size(backend, upstream):
    await backend.load_model(VARIANT)
    first = list(upstream.graphs)
    original_close = backend._graphs.close
    backend._graphs.close = lambda: (backend.loads.append("close"), original_close())
    backend.loads.clear()
    await backend.load_model("1.7B-cudagraph")
    assert backend.loads[0] == "close" and backend.loads[1][0] == "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
    assert all(graph.graph is None for graph in first)
    assert backend._current_model_size == "1.7B-cudagraph"


@pytest.mark.asyncio
async def test_non_cuda_device_is_refused_before_the_model_loads(backend, upstream):
    backend.device = "cpu"
    with pytest.raises(CudaGraphRuntimeError, match="CUDA device"):
        await backend.load_model(VARIANT)
    assert backend.loads == [] and not backend.is_loaded()


@pytest.mark.asyncio
async def test_a_host_the_runtime_is_not_qualified_on_is_refused_by_the_backend_itself(backend, upstream, monkeypatch):
    """The registry guard runs only in load_engine_model; a direct load_model call must refuse too."""
    monkeypatch.setattr(qwen_cuda_variants, "cuda_graph_unavailable_reason",
                        lambda: "CUDA graphs are qualified on NVIDIA CUDA only, not ROCm/HIP")
    with pytest.raises(CudaGraphRuntimeError, match="ROCm"):
        await backend.load_model(VARIANT)
    assert backend.loads == [] and not backend.is_loaded() and backend.runtime_identity == {"runtime": "stock"}


def test_cache_check_uses_the_pinned_revision_and_required_files(monkeypatch):
    calls = []
    monkeypatch.setattr(pt, "is_model_cached", lambda repo, **kwargs: calls.append((repo, kwargs)) or True)
    backend = pt.PyTorchTTSBackend()
    assert backend._is_model_cached(VARIANT)
    assert calls == [("Qwen/Qwen3-TTS-12Hz-0.6B-Base", {
        "revision": "5d83992436eae1d760afd27aff78a71d676296fc",
        "required_files": ["config.json", "generation_config.json", "merges.txt", "vocab.json", "tokenizer_config.json",
                           "preprocessor_config.json", "model.safetensors", "speech_tokenizer/config.json",
                           "speech_tokenizer/configuration.json", "speech_tokenizer/model.safetensors",
                           "speech_tokenizer/preprocessor_config.json"],
    })]
    assert backend._is_model_cached("0.6B") and calls[1] == ("Qwen/Qwen3-TTS-12Hz-0.6B-Base", {})


@pytest.mark.asyncio
async def test_stock_generation_reports_only_what_it_observes(backend, upstream, monkeypatch):
    backend.device = "cpu"
    stock = upstream.stock_model()
    stock.generate_voice_clone = lambda **kwargs: ([np.array([0.1, -0.2], dtype=np.float32)], 24000)
    monkeypatch.setitem(sys.modules, "qwen_tts", SimpleNamespace(Qwen3TTSModel=SimpleNamespace(from_pretrained=lambda *a, **k: stock)))
    assert backend.last_generation == {"steps": None, "hit_eos": None, "max_new_tokens": None}
    await backend.load_model("0.6B")
    await backend.generate("Hello", ["voice"])
    assert backend.last_generation == {"steps": None, "hit_eos": None, "max_new_tokens": 8192}
    assert backend.runtime_identity == {"runtime": "stock"} and backend.generate_stream is None
    assert upstream.events == []


class TestNativeStreaming:
    @pytest.mark.asyncio
    async def test_variant_streams_native_frames_on_the_replay_thread(self, backend, upstream):
        from backend.utils.streaming_audio import iter_speech_audio

        await backend.load_model(VARIANT)
        frames = [frame async for frame in iter_speech_audio(backend, "One sentence.", ["voice"], seed=7, instruct="x", crossfade_ms=0)]
        audio = np.concatenate([frame[0] for frame in frames])
        np.testing.assert_array_equal(audio, np.concatenate(upstream.stream_chunks))
        assert {rate for _, rate in frames} == {24000}
        stream = upstream.stream_kwargs[0]
        assert stream["instruct"] is None and stream["max_new_tokens"] == 2048 - PROMPT_LEN and stream["chunk_size"] == 12
        assert {key: stream[key] for key in ("do_sample", "top_k", "top_p", "temperature", "repetition_penalty")} == {
            "do_sample": True, "top_k": 50, "top_p": 1.0, "temperature": 0.9, "repetition_penalty": 1.05,
        }
        assert backend.last_generation == {"steps": 5, "hit_eos": True, "max_new_tokens": 2048 - PROMPT_LEN}
        threads = {event[1] for event in upstream.events}
        assert len(threads) == 1
        assert [event[0] for event in upstream.events] == ["warmup", "seed", "stream", "stream"]

    @pytest.mark.asyncio
    async def test_stream_that_reaches_the_bound_raises_after_its_frames(self, backend, upstream):
        from contextlib import aclosing

        upstream.steps = 2048 - PROMPT_LEN
        upstream.stream_chunks = [np.full(10, 0.1, dtype=np.float32)] * 170
        await backend.load_model(VARIANT)
        received = []
        with pytest.raises(CudaGraphRuntimeError, match="bound"):
            async with aclosing(backend.generate_stream("Hello", ["voice"], "en", 1, None)) as stream:
                async for audio, _rate in stream:
                    received.append(audio)
        assert len(received) == 170
        assert backend.last_generation["hit_eos"] is False

    @pytest.mark.asyncio
    async def test_a_stream_taken_before_unload_refuses_after_it(self, backend, upstream):
        await backend.load_model(VARIANT)
        native = backend.generate_stream
        backend.unload_model()
        with pytest.raises(CudaGraphRuntimeError, match="No CUDA-graph variant"):
            async for _frame in native("Hello", ["voice"], "en", None, None):
                pytest.fail("frames came from released graphs")

    @pytest.mark.asyncio
    async def test_closing_the_stream_drains_the_replay_worker(self, backend, upstream):
        from contextlib import aclosing

        started, release = threading.Event(), threading.Event()
        finished = []

        def chunks():
            yield np.full(10, 0.1, dtype=np.float32)
            started.set()
            release.wait(5)
            finished.append(True)
            yield np.full(10, 0.2, dtype=np.float32)

        upstream.stream_chunks = chunks()
        await backend.load_model(VARIANT)
        await backend.generate("Hello", ["voice"], seed=1)
        assert backend.last_generation["steps"] == 5
        stream = backend.generate_stream("Hello", ["voice"], "en", None, None)
        async with aclosing(stream):
            await anext(stream)
            assert started.wait(5)
            release.set()
        assert finished == [True]
        assert backend.last_generation == {"steps": None, "hit_eos": None, "max_new_tokens": None}
