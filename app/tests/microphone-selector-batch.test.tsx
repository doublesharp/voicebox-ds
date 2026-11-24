import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { PlatformProvider } from '../src/platform/PlatformContext';
import type { Platform } from '../src/platform/types';

mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, params?: any) => params?.name ? `${key}:${params.name}` : key }) }));
const openMicrophoneSettings = mock(async () => {});
const platform = { metadata: { isTauri: true }, lifecycle: { openMicrophoneSettings } } as Platform;
mock.module('../src/components/ui/button', () => ({ Button: (props: any) => createElement('button', props) }));
mock.module('../src/components/ui/label', () => ({ Label: ({ children }: { children?: ReactNode }) => <>{children}</> }));
const pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
mock.module('../src/components/ui/select', () => ({ Select: (props: any) => createElement('test-select', props), SelectContent: pass, SelectItem: (props: any) => createElement('test-option', props), SelectTrigger: pass, SelectValue: () => null }));
let selected: { deviceId: string | null; deviceLabel: string | null } = { deviceId: null, deviceLabel: null };
const setMicrophone = mock((deviceId: string | null, deviceLabel: string | null) => { selected = { deviceId, deviceLabel }; });
mock.module('../src/stores/microphoneStore', () => ({ useMicrophoneStore: () => ({ ...selected, setMicrophone }) }));
const { MicrophoneSelector } = await import('../src/components/MicrophoneSelector/MicrophoneSelector');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const windowEvents = new EventTarget();
const mediaEvents = new EventTarget();
let enumerate: () => Promise<any[]> = async () => [];
let acquire: () => Promise<any> = async () => { throw new Error('not configured'); };
const media = Object.assign(mediaEvents, { enumerateDevices: () => enumerate(), getUserMedia: () => acquire() });
Object.defineProperty(globalThis, 'window', { configurable: true, value: windowEvents });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: media } });
const device = (id: string, label: string, kind = 'audioinput') => ({ kind, deviceId: id, label });
const track = () => ({ stop: mock(() => {}), getSettings: () => ({ deviceId: 'mic-a' }) });
let view: ReactTestRenderer | undefined;
async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
async function mount(disabled = false) {
  await act(async () => {
    view = create(
      <PlatformProvider platform={platform}>
        <MicrophoneSelector disabled={disabled} />
      </PlatformProvider>,
    );
  });
}
const select = () => view!.root.findByType('test-select' as never);
const options = () => view!.root.findAllByType('test-option' as never);
const button = (label: string) => view!.root.findAllByType('button').find((item) => item.props.children === label)!;
beforeEach(() => { selected = { deviceId: null, deviceLabel: null }; setMicrophone.mockClear(); enumerate = async () => []; acquire = async () => { throw new Error('not configured'); }; });
afterEach(() => { if (view) act(() => view?.unmount()); view = undefined; });
afterAll(() => { mock.restore(); if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window'); if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator); else Reflect.deleteProperty(globalThis, 'navigator'); });

test('lists real inputs and saves the chosen device and label', async () => {
  enumerate = async () => [device('default', 'Default'), device('communications', 'Calls'), device('mic-a', 'Desk mic'), device('speaker', 'Output', 'audiooutput')];
  await mount(); await flush();
  expect(options().map((item) => item.props.value)).toEqual(['system-default', 'mic-a']);
  act(() => select().props.onValueChange('mic-a'));
  expect(setMicrophone).toHaveBeenCalledWith('mic-a', 'Desk mic');
  act(() => select().props.onValueChange('system-default'));
  expect(setMicrophone).toHaveBeenCalledWith(null, null);
});

test('shows a saved disconnected input without silently changing selection', async () => {
  selected = { deviceId: 'missing', deviceLabel: 'Studio mic' };
  enumerate = async () => [device('mic-a', 'Desk mic')];
  await mount(); await flush();
  const missing = options().find((item) => item.props.value === 'missing');
  expect(missing?.props.disabled).toBe(true);
  expect(missing?.props.children).toBe('microphone.unavailable:Studio mic');
  expect(setMicrophone).not.toHaveBeenCalled();
});

test('permission grant stops the probe stream and refreshes device labels', async () => {
  const probe = track(); let calls = 0;
  enumerate = async () => ++calls === 1 ? [device('mic-a', '')] : [device('mic-a', 'Desk mic')];
  acquire = async () => ({ getTracks: () => [probe], getAudioTracks: () => [probe] });
  await mount(); await flush();
  await act(async () => button('microphone.enable').props.onClick()); await flush();
  expect(probe.stop).toHaveBeenCalledTimes(1);
  expect(options().find((item) => item.props.value === 'mic-a')?.props.children).toBe('Desk mic');
  expect(view!.root.findAllByType('button').some((item) => item.props.children === 'microphone.enable')).toBe(false);
});

test('a later enumeration cannot erase a denied-permission message', async () => {
  let finish!: (devices: any[]) => void;
  enumerate = () => new Promise((resolve) => { finish = resolve; });
  acquire = async () => { throw new DOMException('denied', 'NotAllowedError'); };
  await mount();
  await act(async () => button('microphone.enable').props.onClick()); await flush();
  expect(view!.root.findByProps({ role: 'alert' }).children).toContain('microphone.permissionDeniedDesktop');
  await act(async () => button('microphone.openSettings').props.onClick());
  expect(openMicrophoneSettings).toHaveBeenCalledTimes(1);
  await act(async () => finish([device('mic-a', '')])); await flush();
  expect(view!.root.findByProps({ role: 'alert' }).children).toContain('microphone.permissionDeniedDesktop');
});

test('only the latest enumeration result updates the device list', async () => {
  const requests: Array<(devices: any[]) => void> = [];
  enumerate = () => new Promise((resolve) => requests.push(resolve));
  await mount();
  act(() => select().props.onOpenChange(true));
  expect(requests).toHaveLength(2);
  await act(async () => requests[1]([device('new', 'New mic')])); await flush();
  await act(async () => requests[0]([device('old', 'Old mic')])); await flush();
  expect(options().map((item) => item.props.value)).toEqual(['system-default', 'new']);
});

test('unmounting while permission is pending stops a late-granted stream', async () => {
  let grant!: (stream: any) => void; const probe = track();
  acquire = () => new Promise((resolve) => { grant = resolve; });
  await mount(); await flush();
  act(() => button('microphone.enable').props.onClick());
  act(() => view?.unmount()); view = undefined;
  await act(async () => grant({ getTracks: () => [probe], getAudioTracks: () => [probe] })); await flush();
  expect(probe.stop).toHaveBeenCalledTimes(1);
});

test('enumeration failure is visible and successful refresh clears it', async () => {
  enumerate = async () => { throw new Error('device list unavailable'); };
  await mount(); await flush();
  expect(view!.root.findByProps({ role: 'alert' }).children.join('')).toContain('device list unavailable');
  enumerate = async () => [device('mic-a', 'Desk mic')];
  await act(async () => view!.root.findByProps({ 'aria-label': 'microphone.refresh' }).props.onClick()); await flush();
  expect(view!.root.findAllByProps({ role: 'alert' })).toHaveLength(0);
});

test('disabled selector disables both selection and permission controls', async () => {
  await mount(true); await flush();
  expect(select().props.disabled).toBe(true);
  expect(button('microphone.enable').props.disabled).toBe(true);
  expect(view!.root.findByProps({ 'aria-label': 'microphone.refresh' }).props.disabled).toBe(true);
});
