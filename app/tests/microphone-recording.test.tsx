import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { PlatformProvider } from '../src/platform/PlatformContext';
import type { Platform } from '../src/platform/types';

const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => {
    values.set(key, value);
  },
  removeItem: (key: string) => {
    values.delete(key);
  },
};
const testWindow = Object.assign(new EventTarget(), {
  setInterval,
  clearInterval,
  localStorage: storage,
});
Object.defineProperty(globalThis, 'window', { configurable: true, value: testWindow });
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });

mock.module('../src/lib/utils/audio', () => ({ convertToWav: async (blob: Blob) => blob }));

const { useMicrophoneStore } = await import('../src/stores/microphoneStore');
const { useAudioRecording } = await import('../src/lib/hooks/useAudioRecording');

const recorders: Recorder[] = [];

class Recorder {
  constructor() {
    recorders.push(this);
  }
  static isTypeSupported() {
    return true;
  }
  state = 'inactive';
  onstop: (() => void) | null = null;
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    queueMicrotask(() => this.onstop?.());
  }
}
Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: Recorder });

function microphone(deviceId: string) {
  const stop = mock(() => {});
  const track = { stop, getSettings: () => ({ deviceId }) };
  return {
    stream: { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream,
    stop,
  };
}

let renderer: ReactTestRenderer | null = null;
let recording!: ReturnType<typeof useAudioRecording>;

function RecordingProbe({
  deviceId,
  processing,
}: {
  deviceId?: string | null;
  processing?: 'processed' | 'clean';
}) {
  recording = useAudioRecording({ deviceId, processing });
  return null;
}
function mountRecording(deviceId?: string | null, processing?: 'processed' | 'clean') {
  act(() => {
    renderer = create(
      <PlatformProvider platform={{ metadata: { isTauri: true } } as Platform}>
        <RecordingProbe deviceId={deviceId} processing={processing} />
      </PlatformProvider>,
    );
  });
}

function useDevices(getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>) {
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
}

beforeEach(() => {
  useMicrophoneStore.getState().setMicrophone('shure-usb', 'Shure USB');
  useMicrophoneStore.getState().setCleanReferenceAudio(false);
});
afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
  });
  renderer = null;
});

describe('recording input lifecycle', () => {
  test('clean reference choice persists independently of the selected input', () => {
    useMicrophoneStore.getState().setCleanReferenceAudio(true);
    const persisted = JSON.parse(storage.getItem('voicebox-microphone')!);
    expect(persisted.state.cleanReferenceAudio).toBe(true);
    expect(persisted.state.deviceId).toBe('shure-usb');
    useMicrophoneStore.getState().setMicrophone(null, null);
    expect(useMicrophoneStore.getState().cleanReferenceAudio).toBe(true);
  });

  test('reference recording passes clean processing without changing the saved input', async () => {
    const { stream } = microphone('shure-usb');
    const acquire = mock(async (_constraints: MediaStreamConstraints) => stream);
    useDevices(acquire);
    mountRecording(undefined, 'clean');
    await act(async () => {
      await recording.startRecording();
    });
    expect(acquire.mock.calls[0][0].audio).toMatchObject({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      deviceId: { exact: 'shure-usb' },
    });
    expect(useMicrophoneStore.getState().deviceId).toBe('shure-usb');
  });

  test('dictation keeps processed defaults even with clean references enabled', async () => {
    useMicrophoneStore.setState({ cleanReferenceAudio: true });
    const { stream } = microphone('shure-usb');
    const acquire = mock(async (_constraints: MediaStreamConstraints) => stream);
    useDevices(acquire);
    mountRecording();
    await act(async () => {
      await recording.startRecording();
    });
    expect(acquire.mock.calls[0][0].audio).toMatchObject({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
  });

  test('an input override changes only this recording, leaving the saved choice intact', async () => {
    const { stream } = microphone('other-usb');
    const acquire = mock(async (_constraints: MediaStreamConstraints) => stream);
    useDevices(acquire);
    mountRecording('other-usb');
    await act(async () => {
      await recording.startRecording();
    });
    expect(acquire.mock.calls[0][0].audio).toMatchObject({ deviceId: { exact: 'other-usb' } });
    expect(recording.audioStream).toBe(stream);
    expect(useMicrophoneStore.getState().deviceId).toBe('shure-usb');
  });

  test('an explicit null override uses the system default without changing the saved mic', async () => {
    const { stream } = microphone('built-in');
    const acquire = mock(async (_constraints: MediaStreamConstraints) => stream);
    useDevices(acquire);
    mountRecording(null);
    await act(async () => {
      await recording.startRecording();
    });
    expect(acquire.mock.calls[0][0].audio).not.toHaveProperty('deviceId');
    expect(recording.usingDefaultMicrophone).toBe(false);
    expect(useMicrophoneStore.getState().deviceId).toBe('shure-usb');
  });

  test('a successful fallback exposes a notice and the actual recording stream, then resets on retry', async () => {
    const defaultMic = microphone('built-in');
    const selected = microphone('shure-usb');
    let missing = true;
    useDevices(async (constraints) => {
      if ((constraints.audio as MediaTrackConstraints).deviceId) {
        if (missing) throw new DOMException('Selected mic missing', 'NotFoundError');
        return selected.stream;
      }
      return defaultMic.stream;
    });
    mountRecording();
    await act(async () => {
      await recording.startRecording();
    });
    expect(recording.isRecording).toBe(true);
    expect(recording.usingDefaultMicrophone).toBe(true);
    expect(recording.audioStream).toBe(defaultMic.stream);
    expect(recording.error).toBeNull();
    expect(useMicrophoneStore.getState().deviceId).toBe('shure-usb');
    await act(async () => {
      recording.cancelRecording();
    });
    missing = false;
    await act(async () => {
      await recording.startRecording();
    });
    expect(recording.usingDefaultMicrophone).toBe(false);
    expect(recording.audioStream).toBe(selected.stream);
  });

  test('a denied recording can be retried after granting access', async () => {
    const { stream, stop } = microphone('shure-usb');
    let denied = true;
    const acquire = mock(async () => {
      if (denied) throw new DOMException('Permission denied', 'NotAllowedError');
      return stream;
    });
    useDevices(acquire);
    mountRecording();
    await act(async () => {
      await recording.startRecording();
    });
    expect(recording.permissionDenied).toBe(true);
    expect(recording.isRecording).toBe(false);
    expect(acquire).toHaveBeenCalledTimes(1);
    denied = false;
    await act(async () => {
      await recording.startRecording();
    });
    expect(recording.permissionDenied).toBe(false);
    expect(recording.error).toBeNull();
    expect(recording.audioStream).toBe(stream);
    await act(async () => recording.cancelRecording());
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test('automatic input stop returns the recorder to idle and allows Stop safely', async () => {
    const { stream } = microphone('shure-usb');
    useDevices(async () => stream);
    mountRecording();
    await act(async () => {
      await recording.startRecording();
    });
    await act(async () => {
      recorders[recorders.length - 1].stop();
    });
    expect(recording.isRecording).toBe(false);
    expect(() => recording.stopRecording()).not.toThrow();
  });

  test('records from the saved Shure input and exposes that same stream to the waveform', async () => {
    const { stream } = microphone('shure-usb');
    const acquire = mock(async (_constraints: MediaStreamConstraints) => stream);
    useDevices(acquire);
    mountRecording();
    await act(async () => {
      await recording.startRecording();
    });
    expect(acquire.mock.calls[0][0].audio).toMatchObject({ deviceId: { exact: 'shure-usb' } });
    expect(recording.isRecording).toBe(true);
    expect(recording.audioStream).toBe(stream);
    await act(async () => {
      recording.cancelRecording();
    });
  });

  test('canceling a pending request stops a late-granted stream without starting a recording', async () => {
    const { stream, stop } = microphone('shure-usb');
    let grant!: (stream: MediaStream) => void;
    useDevices(
      () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
    );
    mountRecording();
    let pending!: Promise<void>;
    act(() => {
      pending = recording.startRecording();
    });
    expect(recording.isStarting).toBe(true);
    act(() => {
      recording.cancelRecording();
    });
    await act(async () => {
      grant(stream);
      await pending;
    });
    expect(recording.isRecording).toBe(false);
    expect(recording.isStarting).toBe(false);
    expect(recording.audioStream).toBeNull();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test('a canceled old request cannot stop a newer recording', async () => {
    const old = microphone('shure-usb');
    const current = microphone('shure-usb');
    let grantOld!: (stream: MediaStream) => void;
    let calls = 0;
    useDevices(() =>
      ++calls === 1
        ? new Promise((resolve) => {
            grantOld = resolve;
          })
        : Promise.resolve(current.stream),
    );
    mountRecording();
    let pending!: Promise<void>;
    act(() => {
      pending = recording.startRecording();
    });
    act(() => {
      recording.cancelRecording();
    });
    await act(async () => {
      await recording.startRecording();
    });
    await act(async () => {
      grantOld(old.stream);
      await pending;
    });
    expect(recording.isRecording).toBe(true);
    expect(recording.audioStream).toBe(current.stream);
    expect(current.stop).not.toHaveBeenCalled();
    expect(old.stop).toHaveBeenCalledTimes(1);
    await act(async () => {
      recording.cancelRecording();
    });
  });

  test('the dictation webview picks up a microphone change saved by the main window', async () => {
    storage.setItem(
      'voicebox-microphone',
      JSON.stringify({
        state: { deviceId: 'another-shure', deviceLabel: 'Shure MV7' },
        version: 0,
      }),
    );
    const event = Object.assign(new Event('storage'), { key: 'voicebox-microphone' });
    await act(async () => {
      testWindow.dispatchEvent(event);
    });
    expect(useMicrophoneStore.getState().deviceId).toBe('another-shure');
    const { stream } = microphone('another-shure');
    const acquire = mock(async (_constraints: MediaStreamConstraints) => stream);
    useDevices(acquire);
    mountRecording();
    await act(async () => {
      await recording.startRecording();
    });
    expect(acquire.mock.calls[0][0].audio).toMatchObject({ deviceId: { exact: 'another-shure' } });
    await act(async () => {
      recording.cancelRecording();
    });
  });

});
