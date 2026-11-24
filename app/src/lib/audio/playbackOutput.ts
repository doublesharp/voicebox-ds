export interface PlaybackOutput {
  audio: HTMLAudioElement;
  isStarting: () => boolean;
  dispose: () => void;
}

interface OutputContext {
  context: AudioContext;
  resuming: Promise<void> | null;
}

let sharedOutput: OutputContext | null = null;

function getOutputContext(): OutputContext | null {
  if (typeof AudioContext === 'undefined') return null;
  if (!sharedOutput || sharedOutput.context.state === 'closed') {
    // Let the device choose its sample rate and keep one context between clips.
    sharedOutput = { context: new AudioContext({ latencyHint: 'playback' }), resuming: null };
  }
  return sharedOutput;
}

function resumeOutput(output: OutputContext): Promise<void> {
  if (output.context.state === 'running') return Promise.resolve();
  if (!output.resuming) {
    output.resuming = output.context.resume().finally(() => {
      output.resuming = null;
    });
  }
  return output.resuming;
}

export async function resumePlaybackContext(): Promise<AudioContext> {
  const output = getOutputContext();
  if (!output) throw new Error('Audio playback is unavailable');
  await resumeOutput(output);
  return output.context;
}

export function createPlaybackOutput(): PlaybackOutput {
  const audio = new Audio();
  audio.crossOrigin = 'anonymous';
  audio.preload = 'auto';
  const output = getOutputContext();
  const source = output?.context.createMediaElementSource(audio);
  source?.connect(output!.context.destination);
  const play = audio.play.bind(audio);
  const pause = audio.pause.bind(audio);
  let generation = 0;
  let starting = false;
  let disposed = false;

  audio.play = async () => {
    if (disposed) return;
    const request = ++generation;
    starting = true;
    try {
      if (output && output.context.state !== 'running') await resumeOutput(output);
      if (disposed || request !== generation) return;
      await play();
    } catch (error) {
      if (!disposed && request === generation) throw error;
    } finally {
      if (request === generation) starting = false;
    }
  };
  audio.pause = () => {
    generation++;
    starting = false;
    pause();
  };

  return {
    audio,
    isStarting: () => starting,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      audio.pause();
      source?.disconnect();
      audio.removeAttribute('src');
      audio.load();
    },
  };
}
