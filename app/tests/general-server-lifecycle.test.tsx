import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

const notifications = mock((_value: any) => {});
const writes: Array<{ value: boolean; resolve: () => void; reject: (error: Error) => void }> = [];
const setNative = mock((value: boolean) => new Promise<void>((resolve, reject) => writes.push({ value, resolve, reject })));
const translate = (key: string) => key;
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: translate }), Trans: () => null }));
mock.module('../src/components/ui/use-toast', () => ({ useToast: () => ({ toast: notifications }) }));
mock.module('../src/lib/hooks/useServer', () => ({ useServerHealth: () => ({ data: null, isLoading: false, error: null }) }));
mock.module('../src/platform/PlatformContext', () => ({
  usePlatform: () => ({
    metadata: { isTauri: true, getVersion: async () => '0.6.1' },
    lifecycle: { setKeepServerRunning: setNative },
    updater: { enabled: false },
  }),
}));
mock.module('../src/hooks/useAutoUpdater', () => ({
  useAutoUpdater: () => ({ status: { available: false, checking: false } }),
}));
mock.module('../src/components/ServerTab/LanguageSelect', () => ({ LanguageSelect: () => null }));
mock.module('../src/components/ServerTab/ThemeSelect', () => ({ ThemeSelect: () => null }));
mock.module('../src/components/ui/checkbox', () => ({ Checkbox: ({ id, checked, disabled, onCheckedChange }: any) => <button id={id} role="checkbox" disabled={disabled} onClick={() => { if (!disabled) onCheckedChange(!checked); }} /> }));
mock.module('../src/components/ServerTab/CloudSection', () => ({ CloudSection: () => null }));
const { useServerStore } = await import('../src/stores/serverStore');
const { GeneralPage } = await import('../src/components/ServerTab/GeneralPage');
const { ConnectionForm } = await import('../src/components/ServerSettings/ConnectionForm');
let view: ReactTestRenderer;
const toggle = () => view.root.findByProps({ id: 'keepServerRunning', role: 'switch' });
beforeEach(() => { writes.length = 0; notifications.mockClear(); setNative.mockClear(); useServerStore.setState({ keepServerRunningOnClose: false, keepServerRunningSyncing: false }); });
afterEach(() => { if (view) act(() => view.unmount()); });
afterAll(() => mock.restore());
async function mount() { await act(async () => { view = create(<GeneralPage />); }); }

test('desktop settings hide the updater when the distribution has no update feed', async () => {
  await mount();
  expect(JSON.stringify(view.toJSON())).not.toContain('settings.general.updates.title');
});

test('success is announced only after the native setting succeeds', async () => {
  await mount();
  act(() => toggle().props.onClick());
  expect(writes.map((entry) => entry.value)).toEqual([true]);
  expect(useServerStore.getState().keepServerRunningOnClose).toBe(true);
  expect(notifications).not.toHaveBeenCalled();
  await act(async () => writes[0].resolve());
  expect(notifications).toHaveBeenCalledWith(expect.objectContaining({ title: 'settings.general.keepServerRunning.updatedTitle' }));
});

test('failed native update restores the setting and only reports failure', async () => {
  await mount();
  act(() => toggle().props.onClick());
  await act(async () => writes[0].reject(new Error('native failure')));
  expect(useServerStore.getState().keepServerRunningOnClose).toBe(false);
  expect(notifications).toHaveBeenCalledTimes(1);
  expect(notifications).toHaveBeenCalledWith(expect.objectContaining({ title: 'settings.general.keepServerRunning.failedTitle', variant: 'destructive' }));
});

test('a pending native update blocks a second toggle until it settles', async () => {
  await mount();
  act(() => toggle().props.onClick());
  expect(toggle().props.disabled).toBe(true);
  act(() => toggle().props.onClick());
  expect(writes).toHaveLength(1);
  await act(async () => writes[0].resolve());
  expect(toggle().props.disabled).toBe(false);
  act(() => toggle().props.onClick());
  expect(writes.map((entry) => entry.value)).toEqual([true, false]);
  await act(async () => writes[1].resolve());
});

test('pending native update stays locked across page remounts', async () => {
  await mount();
  act(() => toggle().props.onClick());
  act(() => view.unmount());
  await mount();
  expect(toggle().props.disabled).toBe(true);
  act(() => toggle().props.onClick());
  expect(writes).toHaveLength(1);
  await act(async () => writes[0].resolve());
  expect(toggle().props.disabled).toBe(false);
  expect(useServerStore.getState().keepServerRunningOnClose).toBe(true);
});

test('failed disable restores a previously enabled setting', async () => {
  useServerStore.setState({ keepServerRunningOnClose: true });
  await mount();
  act(() => toggle().props.onClick());
  expect(writes[0].value).toBe(false);
  await act(async () => writes[0].reject(new Error('failed')));
  expect(useServerStore.getState().keepServerRunningOnClose).toBe(true);
  expect(toggle().props.disabled).toBe(false);
});

test('synchronous platform failure also releases the pending lock', async () => {
  setNative.mockImplementationOnce(() => { throw new Error('unavailable'); });
  await mount();
  await act(async () => toggle().props.onClick());
  expect(useServerStore.getState().keepServerRunningOnClose).toBe(false);
  expect(toggle().props.disabled).toBe(false);
  expect(notifications).toHaveBeenCalledTimes(1);
  expect(notifications).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
});

test('the other settings view shares the pending guard and rolls back errors', async () => {
  await mount();
  let other!: ReactTestRenderer;
  await act(async () => { other = create(<ConnectionForm />); });
  act(() => toggle().props.onClick());
  const checkbox = () => other.root.findByProps({ id: 'keepServerRunning', role: 'checkbox' });
  expect(checkbox().props.disabled).toBe(true);
  act(() => checkbox().props.onClick());
  expect(writes).toHaveLength(1);
  await act(async () => writes[0].reject(new Error('failure')));
  expect(checkbox().props.disabled).toBe(false);
  expect(useServerStore.getState().keepServerRunningOnClose).toBe(false);
  act(() => checkbox().props.onClick());
  expect(writes).toHaveLength(2);
  await act(async () => writes[1].reject(new Error('failure')));
  expect(useServerStore.getState().keepServerRunningOnClose).toBe(false);
  expect(notifications).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Could not update setting', variant: 'destructive' }));
  act(() => other.unmount());
});

test('startup synchronization and settings writes share one pending guard', async () => {
  const { syncKeepServerRunning } = await import('../src/lib/keepServerRunning');
  let startup!: Promise<boolean>;
  act(() => { startup = syncKeepServerRunning(false, setNative); });
  await mount();
  expect(toggle().props.disabled).toBe(true);
  expect(await syncKeepServerRunning(true, setNative)).toBe(false);
  expect(writes).toHaveLength(1);
  await act(async () => { writes[0].resolve(); await startup; });
  expect(toggle().props.disabled).toBe(false);
  expect(useServerStore.getState().keepServerRunningOnClose).toBe(false);
});
