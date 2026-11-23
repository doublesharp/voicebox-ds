"""Graph capture reuses one side stream per device instead of upstream's new stream per capture.

Uses a fake upstream module and a counting stand-in for torch.cuda.Stream; no CUDA needed.
"""
import sys
import types

import pytest
import torch

from backend.backends import qwen_cudagraph


@pytest.fixture
def upstream(monkeypatch):
    module = types.ModuleType("fake_upstream_graph")
    module.torch = torch
    exec("class Graph:\n    def capture(self):\n        return torch.cuda.Stream(), torch.cuda.Stream()\n", module.__dict__)
    monkeypatch.setitem(sys.modules, module.__name__, module)
    created = []
    monkeypatch.setattr(torch.cuda, "Stream", lambda *args, **kwargs: created.append(kwargs) or object())
    monkeypatch.setattr(torch.cuda, "current_device", lambda: 0)
    monkeypatch.setattr(qwen_cudagraph, "_capture_streams", {})
    return module, created


def test_every_capture_in_the_process_gets_the_same_side_stream(upstream):
    module, created = upstream
    graph = module.Graph()
    with qwen_cudagraph._capture_on_one_stream(graph):
        first = graph.capture()
    with qwen_cudagraph._capture_on_one_stream(graph):
        second = graph.capture()
    assert len({id(stream) for stream in first + second}) == 1
    assert created == [{"device": 0}]
    assert module.torch is torch


def test_the_upstream_module_gets_real_torch_back_when_capture_fails(upstream):
    module, _ = upstream
    with pytest.raises(RuntimeError, match="capture failed"):
        with qwen_cudagraph._capture_on_one_stream(module.Graph()):
            raise RuntimeError("capture failed")
    assert module.torch is torch


def test_a_stream_requested_with_arguments_is_not_replaced(upstream):
    module, created = upstream
    with qwen_cudagraph._capture_on_one_stream(module.Graph()):
        module.torch.cuda.Stream(priority=-1)
        module.torch.cuda.Stream(priority=-1)
    assert created == [{"priority": -1}, {"priority": -1}]


def test_a_module_without_torch_is_left_alone_with_a_warning(upstream, caplog):
    module, created = upstream
    del module.torch
    with qwen_cudagraph._capture_on_one_stream(module.Graph()):
        pass
    assert not hasattr(module, "torch") and "no longer expose" in caplog.text


def test_other_torch_attributes_pass_through_during_capture(upstream):
    module, _ = upstream
    with qwen_cudagraph._capture_on_one_stream(module.Graph()):
        assert module.torch.zeros(2).sum().item() == 0
        assert module.torch.cuda.current_device() == 0
