"""Protocol behavior of the stdio-to-HTTP bridge, without a running server."""
import io
import json
import sys

import httpx
import pytest

from backend.mcp_shim import __main__ as proxy


@pytest.mark.asyncio
async def test_stdio_reads_utf8_even_if_piped_stream_uses_a_windows_code_page(monkeypatch):
    text = "ação, coração, você — こんにちは"
    request = {"id": 1, "method": "tools/call", "params": {"text": text}}
    raw = json.dumps(request, ensure_ascii=False) + "\n"
    with io.TextIOWrapper(io.BytesIO(raw.encode("utf-8")), encoding="cp1252") as stdin:
        monkeypatch.setattr(sys, "stdin", stdin)
        assert json.loads(await proxy._read_stdin_line()) == request
        assert await proxy._read_stdin_line() is None


@pytest.mark.asyncio
async def test_initialize_forwards_identity_and_reuses_session(capsys):
    seen = []
    def handler(request):
        seen.append(request)
        return httpx.Response(200, headers={'mcp-session-id': 'session-one'}, json={'jsonrpc': '2.0', 'id': len(seen), 'result': {}})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        session = [None]
        await proxy._handle_request(client, 'http://voicebox/mcp/', '{"jsonrpc":"2.0","id":1}', {'X-Voicebox-Client-Id': 'client-a'}, session)
        await proxy._handle_request(client, 'http://voicebox/mcp/', '{"jsonrpc":"2.0","id":2}', {'X-Voicebox-Client-Id': 'client-a'}, session)
    assert session == ['session-one']
    assert seen[0].headers['X-Voicebox-Client-Id'] == 'client-a'
    assert 'mcp-session-id' not in seen[0].headers
    assert seen[1].headers['mcp-session-id'] == 'session-one'
    assert [json.loads(line)['id'] for line in capsys.readouterr().out.splitlines()] == [1, 2]


@pytest.mark.asyncio
@pytest.mark.parametrize('status', [202, 400, 503])
async def test_notification_never_emits_a_json_rpc_reply(capsys, status):
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(status, text='rejected'))) as client:
        await proxy._handle_request(client, 'http://voicebox/mcp/', '{"jsonrpc":"2.0","method":"notifications/initialized"}', {}, [None])
    assert capsys.readouterr().out == ''


@pytest.mark.asyncio
@pytest.mark.parametrize('raw', ['null', '[]', '"invalid"', '42'])
async def test_rejected_non_object_json_does_not_crash_the_proxy(capsys, raw):
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(400, text='bad request'))) as client:
        await proxy._handle_request(client, 'http://voicebox/mcp/', raw, {}, [None])
    output = json.loads(capsys.readouterr().out)
    assert output['id'] is None
    assert output['error']['code'] == -32000


@pytest.mark.asyncio
async def test_sse_multiline_data_and_other_fields_form_one_rpc_message(capsys):
    response = b'event: message\r\ndata: {"jsonrpc":"2.0",\r\ndata: "id":7,"result":{"text":"hello"}}\r\n\r\n: keepalive\r\n\r\n'
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, headers={'content-type': 'text/event-stream; charset=utf-8'}, content=response))) as client:
        await proxy._handle_request(client, 'http://voicebox/mcp/', '{"id":7}', {}, [None])
    captured = capsys.readouterr()
    assert json.loads(captured.out) == {'jsonrpc': '2.0', 'id': 7, 'result': {'text': 'hello'}}
    assert captured.err == ''


@pytest.mark.asyncio
async def test_sse_malformed_event_does_not_prevent_next_event(capsys):
    response = b'data: not-json\n\ndata: {"id":2,"result":true}\n\n'
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, headers={'content-type': 'text/event-stream'}, content=response))) as client:
        await proxy._handle_request(client, 'http://voicebox/mcp/', '{"id":2}', {}, [None])
    captured = capsys.readouterr()
    assert json.loads(captured.out) == {'id': 2, 'result': True}
    assert 'malformed SSE payload' in captured.err


@pytest.mark.asyncio
async def test_invalid_json_input_never_reaches_server(capsys):
    def handler(request):
        pytest.fail('invalid JSON reached the server')
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        await proxy._handle_request(client, 'http://voicebox/mcp/', '{invalid', {}, [None])
    captured = capsys.readouterr()
    assert captured.out == ''
    assert 'invalid JSON' in captured.err


@pytest.mark.asyncio
async def test_http_failure_is_relayed_with_original_request_id(capsys):
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(503, text='unavailable'))) as client:
        await proxy._handle_request(client, 'http://voicebox/mcp/', '{"id":"abc"}', {}, [None])
    captured = capsys.readouterr()
    result = json.loads(captured.out)
    assert result['id'] == 'abc'
    assert result['error']['code'] == -32000
    assert '503' in result['error']['message']
    assert 'server 503' in captured.err


@pytest.mark.asyncio
async def test_event_stream_media_type_is_case_insensitive(capsys):
    response = b'data: {"id":3,"result":true}\n\n'
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, headers={'content-type': 'Text/Event-Stream; charset=utf-8'}, content=response))) as client:
        await proxy._handle_request(client, 'http://voicebox/mcp/', '{"id":3}', {}, [None])
    assert json.loads(capsys.readouterr().out) == {'id': 3, 'result': True}


@pytest.mark.asyncio
async def test_health_retries_until_backend_responds(monkeypatch):
    statuses = iter([503, 200])
    requests = []
    def handler(request):
        requests.append(str(request.url))
        return httpx.Response(next(statuses))
    async def immediate_sleep(_):
        pass
    monkeypatch.setattr(proxy.asyncio, 'sleep', immediate_sleep)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        assert await proxy._wait_for_backend(client, 'http://voicebox/health') is True
    assert requests == ['http://voicebox/health', 'http://voicebox/health']


@pytest.mark.asyncio
async def test_run_proxies_messages_until_eof_with_identity(monkeypatch, capsys):
    original_client = httpx.AsyncClient
    requests = []
    def handler(request):
        requests.append(request)
        if request.url.path == '/health':
            return httpx.Response(200)
        return httpx.Response(200, json={'jsonrpc': '2.0', 'id': 1, 'result': 'ready'})
    monkeypatch.setattr(proxy.httpx, 'AsyncClient', lambda **kwargs: original_client(transport=httpx.MockTransport(handler), **kwargs))
    lines = iter(['  \n', '{"jsonrpc":"2.0","id":1}\n', None])
    async def read_line():
        return next(lines)
    monkeypatch.setattr(proxy, '_read_stdin_line', read_line)
    monkeypatch.setenv('VOICEBOX_CLIENT_ID', 'narrator')
    monkeypatch.setenv('VOICEBOX_HOST', 'localhost')
    monkeypatch.setenv('VOICEBOX_PORT', '12345')
    assert await proxy._run() == 0
    assert [str(r.url) for r in requests] == ['http://localhost:12345/health', 'http://localhost:12345/mcp/']
    assert requests[1].headers['X-Voicebox-Client-Id'] == 'narrator'
    assert json.loads(capsys.readouterr().out)['result'] == 'ready'


@pytest.mark.asyncio
async def test_run_fails_cleanly_if_backend_never_becomes_ready(monkeypatch, capsys):
    async def unavailable(client, url):
        return False
    monkeypatch.setattr(proxy, '_wait_for_backend', unavailable)
    assert await proxy._run() == 2
    assert 'timed out waiting' in capsys.readouterr().err


@pytest.mark.asyncio
async def test_run_reports_transport_error(monkeypatch, capsys):
    original_client = httpx.AsyncClient
    def handler(request):
        if request.url.path == '/health':
            return httpx.Response(200)
        raise httpx.ConnectError('connection lost', request=request)
    monkeypatch.setattr(proxy.httpx, 'AsyncClient', lambda **kwargs: original_client(transport=httpx.MockTransport(handler), **kwargs))
    async def read_line():
        return '{"id":1}'
    monkeypatch.setattr(proxy, '_read_stdin_line', read_line)
    assert await proxy._run() == 1
    assert 'proxy failed' in capsys.readouterr().err


@pytest.mark.asyncio
async def test_invalid_json_response_is_logged_without_corrupting_stdout(capsys):
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, content=b'not json', headers={'content-type': 'text/plain'}))) as client:
        await proxy._handle_request(client, 'http://voicebox/mcp/', '{"id":1}', {}, [None])
    output = capsys.readouterr()
    reply = json.loads(output.out)
    assert reply['id'] == 1
    assert reply['error']['code'] == -32000
    assert 'non-JSON response' in output.err


@pytest.mark.asyncio
async def test_accepted_request_receives_error_instead_of_hanging(capsys):
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(202))) as client:
        await proxy._handle_request(client, 'http://voicebox/mcp/', '{"jsonrpc":"2.0","id":7,"method":"tools/call"}', {}, [None])
    reply = json.loads(capsys.readouterr().out)
    assert reply['id'] == 7
    assert reply['error']['code'] == -32000


@pytest.mark.asyncio
async def test_failed_initialize_does_not_adopt_error_response_session(capsys):
    responses = iter([
        httpx.Response(503, headers={'mcp-session-id': 'invalid-session'}, text='unavailable'),
        httpx.Response(200, headers={'mcp-session-id': 'valid-session'}, json={'jsonrpc': '2.0', 'id': 2, 'result': {}}),
    ])
    seen = []
    def handler(request):
        seen.append(request)
        return next(responses)
    session = [None]
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        await proxy._handle_request(client, 'http://voicebox/mcp/', '{"id":1}', {}, session)
        await proxy._handle_request(client, 'http://voicebox/mcp/', '{"id":2}', {}, session)
    assert 'mcp-session-id' not in seen[1].headers
    assert session == ['valid-session']
    assert len(capsys.readouterr().out.splitlines()) == 2


@pytest.mark.asyncio
async def test_successful_notification_does_not_emit_an_unsolicited_reply(capsys):
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={'result': 'unexpected'}))) as client:
        await proxy._handle_request(client, 'http://voicebox/mcp/', '{"method":"notifications/initialized"}', {}, [None])
    assert capsys.readouterr().out == ''


@pytest.mark.asyncio
async def test_notification_does_not_wait_for_an_unexpected_stream_body(capsys):
    class BlockingStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            raise AssertionError('notification body must not be consumed')
            yield b''
    response = httpx.Response(200, headers={'content-type': 'text/event-stream'}, stream=BlockingStream())
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: response)) as client:
        await proxy._handle_request(client, 'http://voicebox/mcp/', '{"method":"notifications/initialized"}', {}, [None])
    assert capsys.readouterr().out == ''
