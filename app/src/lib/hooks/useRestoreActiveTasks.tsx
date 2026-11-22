import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from '@/lib/api/client';
import type { ActiveDownloadTask } from '@/lib/api/types';
import { useGenerationStore } from '@/stores/generationStore';
import { useServerStore } from '@/stores/serverStore';

// Polling interval in milliseconds
const POLL_INTERVAL = 30000;

/**
 * Hook to monitor active tasks (downloads and generations).
 * Polls the server periodically to catch downloads triggered from anywhere
 * (transcription, generation, explicit download, etc.).
 *
 * Returns the active downloads so components can render download toasts.
 */
export function useRestoreActiveTasks() {
  const [activeDownloads, setActiveDownloads] = useState<ActiveDownloadTask[]>([]);
  const serverUrl = useServerStore((state) => state.serverUrl);
  const serverRevision = useServerStore((state) => state.serverRevision);
  const setActiveGenerationId = useGenerationStore((state) => state.setActiveGenerationId);
  const addPendingGeneration = useGenerationStore((state) => state.addPendingGeneration);

  // Track which downloads we've seen to detect new ones
  const seenDownloadsRef = useRef<Set<string>>(new Set());
  const requestVersion = useRef(0);

  const fetchActiveTasks = useCallback(async () => {
    const version = ++requestVersion.current;
    const activeIdAtStart = useGenerationStore.getState().activeGenerationId;
    try {
      const tasks = await apiClient.getActiveTasks();
      if (
        requestVersion.current !== version ||
        useServerStore.getState().serverUrl !== serverUrl ||
        useServerStore.getState().serverRevision !== serverRevision
      ) return;
      const activeIdUnchanged = useGenerationStore.getState().activeGenerationId === activeIdAtStart;

      // Restore pending generations (e.g., after page refresh)
      if (tasks.generations.length > 0) {
        if (activeIdUnchanged) setActiveGenerationId(tasks.generations[0].task_id);
        for (const gen of tasks.generations) {
          addPendingGeneration(gen.task_id);
        }
      } else {
        const currentId = useGenerationStore.getState().activeGenerationId;
        if (currentId && activeIdUnchanged) {
          setActiveGenerationId(null);
        }
      }

      // Update active downloads
      // Keep track of all active downloads (including new ones)
      const currentDownloadNames = new Set(tasks.downloads.map((d) => d.model_name));

      // Remove completed downloads from our seen set
      for (const name of seenDownloadsRef.current) {
        if (!currentDownloadNames.has(name)) {
          seenDownloadsRef.current.delete(name);
        }
      }

      // Add new downloads to seen set
      for (const download of tasks.downloads) {
        seenDownloadsRef.current.add(download.model_name);
      }

      setActiveDownloads(tasks.downloads);
    } catch (error) {
      // Silently fail - server might be temporarily unavailable
      console.debug('Failed to fetch active tasks:', error);
    }
  }, [setActiveGenerationId, addPendingGeneration, serverUrl, serverRevision]);

  useEffect(() => {
    // Clear the previous server's downloads and fetch the new server immediately.
    seenDownloadsRef.current.clear();
    setActiveDownloads([]);
    fetchActiveTasks();

    // Poll for active tasks
    const interval = setInterval(fetchActiveTasks, POLL_INTERVAL);

    return () => {
      ++requestVersion.current;
      clearInterval(interval);
    };
  }, [fetchActiveTasks]);

  return activeDownloads;
}

/**
 * Map model names to display names for download toasts.
 */
export const MODEL_DISPLAY_NAMES: Record<string, string> = {
  'qwen-tts-1.7B': 'Qwen TTS 1.7B',
  'qwen-tts-0.6B': 'Qwen TTS 0.6B',
  'qwen-custom-voice-1.7B': 'Qwen CustomVoice 1.7B',
  'qwen-custom-voice-0.6B': 'Qwen CustomVoice 0.6B',
  'qwen-voice-design-1.7B': 'Qwen VoiceDesign 1.7B',
  luxtts: 'LuxTTS',
  'chatterbox-tts': 'Chatterbox TTS',
  'chatterbox-turbo': 'Chatterbox Turbo',
  'tada-1b': 'TADA 1B',
  'tada-3b-ml': 'TADA 3B Multilingual',
  kokoro: 'Kokoro 82M',
  omnivoice: 'OmniVoice',
  'whisper-base': 'Whisper Base',
  'whisper-small': 'Whisper Small',
  'whisper-medium': 'Whisper Medium',
  'whisper-large': 'Whisper Large',
  'whisper-turbo': 'Whisper Turbo',
  'qwen3-0.6b': 'Qwen3 0.6B',
  'qwen3-1.7b': 'Qwen3 1.7B',
  'qwen3-4b': 'Qwen3 4B',
};
