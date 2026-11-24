/**
 * Platform abstraction types
 * These interfaces define the contract that platform implementations must fulfill
 */

export interface FileFilter {
  name: string;
  extensions: string[];
}

export type SaveFileResult = { status: 'saved' | 'cancelled' | 'download_started'; path?: string };

export interface PlatformFilesystem {
  // biome-ignore lint/suspicious/noConfusingVoidType: Existing adapters may return Promise<void>.
  saveFile(filename: string, blob: Blob, filters?: FileFilter[]): Promise<SaveFileResult | void>;
  saveFromUrl?(filename: string, url: string, filters?: FileFilter[]): Promise<SaveFileResult>;
  openPath(path: string): Promise<void>;
  pickDirectory(title: string): Promise<string | null>;
}

export interface UpdateStatus {
  checking: boolean;
  available: boolean;
  version?: string;
  downloading: boolean;
  installing: boolean;
  readyToInstall: boolean;
  error?: string;
  downloadProgress?: number; // 0-100 percentage
  downloadedBytes?: number;
  totalBytes?: number;
}

export interface PlatformUpdater {
  enabled?: boolean;
  checkForUpdates(): Promise<void>;
  downloadAndInstall(): Promise<void>;
  restartAndInstall(): Promise<void>;
  getStatus(): UpdateStatus;
  subscribe(callback: (status: UpdateStatus) => void): () => void;
}

export interface AudioDevice {
  id: string;
  name: string;
  is_default: boolean;
}

export interface NativePlaybackSession {
  session_id: string;
  duration: number;
  position: number;
}

export interface NativePlaybackEvent extends NativePlaybackSession {
  state: 'playing' | 'paused' | 'ended' | 'stopped' | 'error';
  error?: string | null;
}

export interface NativePlaybackControl {
  paused?: boolean;
  position?: number;
  volume?: number;
}

export interface PlatformAudio {
  isSystemAudioSupported(): Promise<boolean>;
  startSystemAudioCapture(maxDurationSecs: number): Promise<void>;
  stopSystemAudioCapture(): Promise<Blob>;
  listOutputDevices(): Promise<AudioDevice[]>;
  playToDevices(
    audioData: Uint8Array,
    deviceIds: string[],
    options?: { startTime?: number; volume?: number },
  ): Promise<NativePlaybackSession>;
  startPcmStream?(sampleRate: number, deviceIds: string[]): Promise<NativePlaybackSession>;
  appendPcmStream?(sessionId: string, pcm: Uint8Array): Promise<void>;
  finishPcmStream?(sessionId: string): Promise<void>;
  controlPlayback(sessionId: string, control: NativePlaybackControl): Promise<void>;
  subscribeToPlayback(callback: (event: NativePlaybackEvent) => void): Promise<() => void>;
  stopPlayback(sessionId?: string): Promise<void>;
}

export interface ServerLogEntry {
  stream: 'stdout' | 'stderr';
  line: string;
}

export interface PlatformLifecycle {
  startServer(remote?: boolean, modelsDir?: string | null): Promise<string>;
  stopServer(): Promise<void>;
  restartServer(modelsDir?: string | null): Promise<string>;
  setKeepServerRunning(keep: boolean): Promise<void>;
  setBackendOverride(backend?: string | null): Promise<void>;
  openMicrophoneSettings?: () => Promise<void>;
  setupWindowCloseHandler(): Promise<void>;
  subscribeToServerLogs(callback: (entry: ServerLogEntry) => void): () => void;
  onServerReady?: () => void;
}

export interface PlatformMetadata {
  getVersion(): Promise<string>;
  isTauri: boolean;
}

export interface Platform {
  filesystem: PlatformFilesystem;
  updater: PlatformUpdater;
  audio: PlatformAudio;
  lifecycle: PlatformLifecycle;
  metadata: PlatformMetadata;
}
