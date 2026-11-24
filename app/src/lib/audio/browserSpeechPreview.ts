import { apiClient } from '@/lib/api/client';
import type { GenerationRequest, SpeechPreviewMode } from '@/lib/api/types';
import { usePlayerStore } from '@/stores/playerStore';
import { resumePlaybackContext } from './playbackOutput';
import { legacyPlaybackToken } from './playbackOwnership';

/** Play the buffered preview through the same browser audio output as other clips. */
export class BrowserSpeechPreview {
  private stopCurrent: (() => void) | null = null;

  constructor(private readonly update: (active: boolean, error?: string) => void) {}

  async start(
    data: GenerationRequest,
    _deviceIds: string[],
    stillCurrent: () => boolean,
    mode: SpeechPreviewMode,
    modelToPrepare?: string,
  ): Promise<void> {
    this.stop();
    if (!stillCurrent()) return;
    const token = legacyPlaybackToken();
    const abort = new AbortController();
    let source: AudioBufferSourceNode | undefined;
    let gain: GainNode | undefined;
    let started = false;
    const stop = () => {
      if (this.stopCurrent !== stop) return;
      this.stopCurrent = null;
      token.signal.removeEventListener('abort', stop);
      token.release();
      abort.abort();
      if (source) {
        source.onended = null;
        if (started) source.stop();
        source.disconnect();
      }
      gain?.disconnect();
      this.update(false);
    };
    const valid = () => this.stopCurrent === stop && token.valid() && stillCurrent();
    this.stopCurrent = stop;
    token.signal.addEventListener('abort', stop, { once: true });
    this.update(true);
    try {
      const [context, response] = await Promise.all([
        resumePlaybackContext(),
        apiClient.previewSpeech(data, abort.signal, mode, modelToPrepare),
      ]);
      if (!valid()) {
        await response.body?.cancel().catch(() => {});
        return;
      }
      const buffer = await context.decodeAudioData(await response.arrayBuffer());
      if (!valid()) return;
      gain = context.createGain();
      gain.gain.value = usePlayerStore.getState().volume;
      gain.connect(context.destination);
      source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      source.onended = stop;
      source.start();
      started = true;
    } catch (error) {
      const report = valid();
      stop();
      if (report) this.update(false, error instanceof Error ? error.message : String(error));
    } finally {
      if (!started || !valid()) stop();
    }
  }

  stop(): void {
    this.stopCurrent?.();
  }

  dispose(): void {
    this.stop();
  }
}
