import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { queryClient } from '@/lib/queryClient';
import { useGenerationStore } from '@/stores/generationStore';

export const LOCAL_SERVER_URL = 'http://127.0.0.1:17593';
const retiredLocalUrls = ['http://127.0.0.1:17493', 'http://127.0.0.1:8000'];

interface ServerStore {
  serverUrl: string;
  serverRevision: number;
  serverUrlSource: 'auto' | 'custom';
  setServerUrl: (url: string) => void;
  setDiscoveredServerUrl: (url: string) => void;

  isConnected: boolean;
  setIsConnected: (connected: boolean) => void;

  mode: 'local' | 'remote';
  setMode: (mode: 'local' | 'remote') => void;

  keepServerRunningOnClose: boolean;
  keepServerRunningSyncing: boolean;
  setKeepServerRunningOnClose: (keepRunning: boolean) => void;

  customModelsDir: string | null;
  setCustomModelsDir: (dir: string | null) => void;
}

/**
 * Invalidate all React Query caches so stale data from the previous
 * server is not shown. Called when the server URL changes.
 */
function invalidateAllServerData() {
  // Task IDs and deferred story associations belong to the previous server.
  useGenerationStore.setState({
    pendingGenerationIds: new Set(),
    pendingStoryAdds: new Map(),
    activeGenerationId: null,
    isGenerating: false,
  });
  queryClient.invalidateQueries();
}

export function getDefaultServerUrl(): string {
  if (!import.meta.env.PROD || typeof window === 'undefined') {
    return LOCAL_SERVER_URL;
  }

  const { protocol, origin, hostname } = window.location;
  if ((protocol === 'http:' || protocol === 'https:') && origin && hostname !== 'tauri.localhost') {
    return origin;
  }

  return LOCAL_SERVER_URL;
}

export const useServerStore = create<ServerStore>()(
  persist(
    (set, get) => ({
      serverUrl: getDefaultServerUrl(),
      serverRevision: 0,
      serverUrlSource: 'auto',
      setServerUrl: (url) => {
        const prev = get().serverUrl;
        set((state) => ({
          serverUrl: url,
          serverUrlSource: 'custom',
          serverRevision: state.serverRevision + (url !== prev ? 1 : 0),
        }));
        if (url !== prev) {
          invalidateAllServerData();
        }
      },

      setDiscoveredServerUrl: (url) => {
        // Read the latest selection: a user may save while startup is pending.
        if (get().serverUrlSource === 'custom') return;
        const prev = get().serverUrl;
        set((state) => ({
          serverUrl: url,
          serverRevision: state.serverRevision + (url !== prev ? 1 : 0),
        }));
        if (url !== prev) {
          invalidateAllServerData();
        }
      },

      isConnected: false,
      setIsConnected: (connected) => set({ isConnected: connected }),

      mode: 'local',
      setMode: (mode) => set({ mode }),

      keepServerRunningOnClose: false,
      keepServerRunningSyncing: false,
      setKeepServerRunningOnClose: (keepRunning) => set({ keepServerRunningOnClose: keepRunning }),

      customModelsDir: null,
      setCustomModelsDir: (dir) => set({ customModelsDir: dir }),
    }),
    {
      name: 'voicebox-server',
      // In-flight writes are process-local and must not survive a restart.
      partialize: ({ keepServerRunningSyncing: _pending, ...state }): Partial<ServerStore> => state,
      version: 2,
      migrate: (persistedState, version): Partial<ServerStore> => {
        const state = persistedState as Partial<ServerStore>;
        const defaultUrl = getDefaultServerUrl();
        const wasLocalDefault = retiredLocalUrls.includes(state.serverUrl ?? '');
        const isAutomatic =
          version === 0
            ? !state.serverUrl ||
              state.serverUrl === defaultUrl ||
              state.serverUrl === LOCAL_SERVER_URL ||
              (wasLocalDefault && state.mode !== 'remote')
            : state.serverUrlSource !== 'custom';
        return {
          ...state,
          serverUrl: isAutomatic ? defaultUrl : state.serverUrl,
          serverUrlSource: isAutomatic ? 'auto' : 'custom',
        };
      },
    },
  ),
);
