import type { SpeechPreviewMode } from '@/lib/api/types';

/** Read bounded PCM16 mono blocks. Incremental WAV uses an unknown data length. */
export async function* pcmWaveStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  mode: SpeechPreviewMode = 'incremental',
): AsyncGenerator<{ sampleRate: number; pcm: Uint8Array }> {
  const reader = body.getReader();
  const header = new Uint8Array(44);
  let headerBytes = 0;
  let sampleRate = 0;
  let partial: number | null = null;
  let frames = 0;
  let bytesRemaining: number | null = null;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new DOMException('Preview stopped', 'AbortError');
      const { done, value } = await reader.read();
      if (signal.aborted) throw new DOMException('Preview stopped', 'AbortError');
      if (done) break;
      let offset = 0;
      if (headerBytes < 44) {
        const count = Math.min(44 - headerBytes, value.length);
        header.set(value.subarray(0, count), headerBytes);
        headerBytes += count;
        offset = count;
        if (headerBytes < 44) continue;
        const view = new DataView(header.buffer);
        const text = (start: number, end: number) =>
          String.fromCharCode(...header.subarray(start, end));
        const riffLength = view.getUint32(4, true);
        const dataLength = view.getUint32(40, true);
        const validLength =
          mode === 'incremental'
            ? riffLength === 0xffffffff && dataLength === 0xffffffff
            : dataLength > 0 && dataLength % 2 === 0 && riffLength === dataLength + 36;
        sampleRate = view.getUint32(24, true);
        if (
          text(0, 4) !== 'RIFF' ||
          !validLength ||
          text(8, 16) !== 'WAVEfmt ' ||
          view.getUint32(16, true) !== 16 ||
          view.getUint16(20, true) !== 1 ||
          view.getUint16(22, true) !== 1 ||
          sampleRate < 8000 ||
          sampleRate > 192000 ||
          view.getUint32(28, true) !== sampleRate * 2 ||
          view.getUint16(32, true) !== 2 ||
          view.getUint16(34, true) !== 16 ||
          text(36, 40) !== 'data'
        ) {
          throw new Error('Unsupported audio preview format');
        }
        if (mode === 'buffered') bytesRemaining = dataLength;
      }
      if (bytesRemaining !== null) {
        bytesRemaining -= value.length - offset;
        if (bytesRemaining < 0) throw new Error('Audio preview exceeded its WAV data length');
      }
      while (offset < value.length) {
        // Copy only one bounded block; native IPC never gets the whole response.
        const size = Math.min(8192 - (partial === null ? 0 : 1), value.length - offset);
        const bytes: Uint8Array = new Uint8Array(size + (partial === null ? 0 : 1));
        let start = 0;
        if (partial !== null) {
          bytes[0] = partial;
          partial = null;
          start = 1;
        }
        bytes.set(value.subarray(offset, offset + size), start);
        offset += size;
        const end = bytes.length - (bytes.length % 2);
        if (end < bytes.length) partial = bytes[end];
        if (end) {
          frames += end / 2;
          yield { sampleRate, pcm: bytes.subarray(0, end) };
        }
      }
    }
    if (headerBytes !== 44 || partial !== null || frames === 0 || (bytesRemaining ?? 0) !== 0)
      throw new Error('Audio preview ended with incomplete PCM audio');
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
