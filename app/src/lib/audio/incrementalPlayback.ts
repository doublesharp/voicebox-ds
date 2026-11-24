import type { GenerationRequest, SpeechPreviewMode } from '@/lib/api/types';
import type { PlatformAudio } from '@/platform/types';
import { apiClient } from '@/lib/api/client';
import { pcmWaveStream } from './pcmWaveStream';
import { legacyPlaybackToken, prepareLegacy, startNative } from './playbackOwnership';

/** A preview owns the response, device session, and existing playback lease together. */
export class IncrementalPlayback {
  private current: { abort: AbortController; stop: () => Promise<void> } | null = null;
  constructor(
    private readonly audio: PlatformAudio,
    private readonly update: (active: boolean, error?: string) => void,
    private readonly request = (
      data: GenerationRequest,
      signal: AbortSignal,
      mode: SpeechPreviewMode,
      modelToPrepare?: string,
    ) => apiClient.previewSpeech(data, signal, mode, modelToPrepare),
  ) {}

  async start(
    data: GenerationRequest,
    deviceIds: string[],
    stillCurrent: () => boolean = () => true,
    mode: SpeechPreviewMode = 'incremental',
    modelToPrepare?: string,
  ): Promise<void> {
    await this.stop();
    if (!stillCurrent()) return;
    if (!this.audio.startPcmStream || !this.audio.appendPcmStream || !this.audio.finishPcmStream) {
      this.update(false, 'Speech preview is available in the desktop app');
      return;
    }
    const token = legacyPlaybackToken();
    const abort = new AbortController();
    let sessionId: string | null = null;
    let unlisten: (() => void) | undefined;
    let stopped = false;
    const release = () => {
      token.signal.removeEventListener('abort', revoked);
      token.release();
      unlisten?.();
      unlisten = undefined;
      if (this.current === current) {
        this.current = null;
        this.update(false);
      }
    };
    const stop = async () => {
      stopped = true;
      abort.abort();
      release();
      if (sessionId) await this.audio.stopPlayback(sessionId).catch(() => {});
    };
    const current = { abort, stop };
    const revoked = () => {
      void stop();
    };
    this.current = current;
    token.signal.addEventListener('abort', revoked, { once: true });
    const valid = () => !stopped && stillCurrent() && token.valid() && this.current === current;
    this.update(true);
    try {
      await prepareLegacy(token, () => this.audio.stopPlayback());
      if (!valid()) return;
      const remove = await this.audio.subscribeToPlayback((event) => {
        if (!valid() || event.session_id !== sessionId) return;
        if (event.state === 'ended') release();
        else if (event.state === 'stopped' || event.state === 'error') {
          void stop();
          if (event.state === 'error') this.update(false, event.error || 'Audio output failed');
        }
      });
      if (!valid()) {
        remove();
        return;
      }
      unlisten = remove;
      const response = await this.request(data, abort.signal, mode, modelToPrepare);
      if (!valid()) {
        await response.body?.cancel();
        return;
      }
      if (!response.body) throw new Error('Audio preview response has no stream');
      for await (const block of pcmWaveStream(response.body, abort.signal, mode)) {
        if (!valid()) return;
        if (!sessionId) {
          await startNative(
            token,
            async () => {
              const session = await this.audio.startPcmStream!(block.sampleRate, deviceIds);
              sessionId = session.session_id;
            },
            async () => {
              if (sessionId) await this.audio.stopPlayback(sessionId);
            },
          );
        }
        if (!valid() || !sessionId) return;
        await this.audio.appendPcmStream(sessionId, block.pcm);
      }
      if (valid() && sessionId) await this.audio.finishPcmStream(sessionId);
    } catch (error) {
      const report = valid();
      await stop();
      if (report) this.update(false, error instanceof Error ? error.message : String(error));
    } finally {
      if (!sessionId || !valid()) {
        await stop();
      }
    }
  }

  async stop(): Promise<void> {
    await this.current?.stop();
  }
  dispose(): void {
    void this.stop();
  }
}
