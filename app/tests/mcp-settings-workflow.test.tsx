import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

const upsert = mock(async (_value: any) => {});
const remove = mock(async (_id: string) => {});
const update = mock((_value: any) => {});
const t = (key: string, options?: any) => options?.defaultValue ?? key;
const binding = { client_id: 'agent', label: 'Agent', profile_id: 'voice-a', default_engine: 'kokoro', default_personality: true, last_seen_at: null };
mock.module('react-i18next', () => ({ initReactI18next: { type: '3rdParty', init() {} }, useTranslation: () => ({ t }), Trans: ({ i18nKey }: any) => i18nKey }));
mock.module('../src/lib/hooks/useMCPBindings', () => ({ useMCPBindings: () => ({ bindings: [binding], upsertAsync: upsert, removeAsync: remove, isRemoving: false }) }));
mock.module('../src/lib/hooks/useProfiles', () => ({ useProfiles: () => ({ data: [{ id: 'voice-a', name: 'Voice A' }, { id: 'voice-b', name: 'Voice B' }] }) }));
mock.module('../src/lib/hooks/useSettings', () => ({ useCaptureSettings: () => ({ settings: { default_playback_voice_id: 'voice-a' }, update }) }));
mock.module('../src/components/ui/select', () => ({
  Select: ({ children, value, onValueChange }: any) => <select value={value} onChange={(event: any) => onValueChange(event.target.value)}>{children}</select>,
  SelectTrigger: ({ children }: any) => <>{children}</>, SelectValue: () => null,
  SelectContent: ({ children }: any) => <>{children}</>,
  SelectItem: ({ children, value }: any) => <option value={value}>{children}</option>,
}));
const { MCPPage } = await import('../src/components/ServerTab/MCPPage');
let view: ReactTestRenderer;
const selects = () => view.root.findAllByType('select');
const input = (placeholder: string) => view.root.findByProps({ placeholder });
const button = (label: string) => view.root.findAllByType('button').find((node) => node.children.includes(label))!;
beforeEach(() => { upsert.mockReset(); upsert.mockImplementation(async () => {}); remove.mockClear(); update.mockClear(); });
afterEach(() => { if (view) act(() => view.unmount()); });
afterAll(() => mock.restore());
async function mount() { await act(async () => { view = create(<MCPPage />); }); }

test('voice selection updates only the chosen agent binding', async () => {
  await mount();
  await act(async () => selects()[1].props.onChange({ target: { value: 'voice-b' } }));
  expect(upsert).toHaveBeenCalledWith({ client_id: 'agent', label: 'Agent', profile_id: 'voice-b' });
});

test('global voice can be cleared and agent bindings can be removed', async () => {
  await mount();
  act(() => selects()[0].props.onChange({ target: { value: '__default__' } }));
  expect(update).toHaveBeenCalledWith({ default_playback_voice_id: null });
  act(() => view.root.findByProps({ 'aria-label': 'settings.mcp.bindings.removeAria' }).props.onClick());
  expect(remove).toHaveBeenCalledWith('agent');
});

test('adding a binding trims input and clears fields after success', async () => {
  await mount();
  act(() => input('settings.mcp.bindings.add.clientIdPlaceholder').props.onChange({ target: { value: '  new-agent  ' } }));
  act(() => input('settings.mcp.bindings.add.labelPlaceholder').props.onChange({ target: { value: '  New Agent  ' } }));
  await act(async () => button('settings.mcp.bindings.add.action').props.onClick());
  expect(upsert).toHaveBeenCalledWith({ client_id: 'new-agent', label: 'New Agent', profile_id: null });
  expect(input('settings.mcp.bindings.add.clientIdPlaceholder').props.value).toBe('');
});

test('failed add keeps input and reports a visible error', async () => {
  upsert.mockImplementationOnce(async () => { throw new Error('offline'); });
  await mount();
  act(() => input('settings.mcp.bindings.add.clientIdPlaceholder').props.onChange({ target: { value: 'new-agent' } }));
  await act(async () => { try { await button('settings.mcp.bindings.add.action').props.onClick(); } catch {} });
  expect(input('settings.mcp.bindings.add.clientIdPlaceholder').props.value).toBe('new-agent');
  expect(view.root.findAllByProps({ role: 'alert' })).toHaveLength(1);
});

test('failed voice selection reports an error rather than leaking a rejection', async () => {
  upsert.mockImplementationOnce(async () => { throw new Error('offline'); });
  await mount();
  await act(async () => { try { await selects()[1].props.onChange({ target: { value: 'voice-b' } }); } catch {} });
  expect(view.root.findAllByProps({ role: 'alert' })).toHaveLength(1);
});


test('failed agent removal displays an error and retains the binding', async () => {
  remove.mockImplementationOnce(async () => { throw new Error('offline'); });
  await mount();
  await act(async () => { try { await view.root.findByProps({ 'aria-label': 'settings.mcp.bindings.removeAria' }).props.onClick(); } catch {} });
  expect(view.root.findAllByProps({ role: 'alert' })).toHaveLength(1);
  expect(view.root.findByProps({ 'aria-label': 'settings.mcp.bindings.removeAria' })).toBeDefined();
});

test('stdio setup points to the installed bundle for each desktop platform', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    for (const [platform, agent, expected] of [
      ['MacIntel', 'Macintosh', '/Applications/Voicebox DS.app/Contents/MacOS/voicebox-ds-mcp'],
      ['Win32', 'Windows', 'C:\\Program Files\\Voicebox DS\\voicebox-ds-mcp.exe'],
      ['Linux', 'Linux', 'voicebox-ds-mcp'],
    ]) {
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { platform, userAgent: agent } });
      await mount();
      const snippets = view.root.findAllByType('pre').map((node) => node.children.join(''));
      const configuration = snippets.map((text) => { try { return JSON.parse(text); } catch { return null; } })
        .find((value) => value?.mcpServers?.['voicebox-ds']?.command);
      expect(configuration.mcpServers['voicebox-ds'].command).toBe(expected);
      act(() => view.unmount());
    }
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});
