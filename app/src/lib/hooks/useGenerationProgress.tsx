import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { ToastAction } from '@/components/ui/toast';
import { useToast } from '@/components/ui/use-toast';
import { apiClient } from '@/lib/api/client';
import { useGenerationSettings } from '@/lib/hooks/useSettings';
import { condenseError } from '@/lib/utils/errorText';
import { useGenerationStore } from '@/stores/generationStore';
import { usePlayerStore } from '@/stores/playerStore';
import { useServerStore } from '@/stores/serverStore';

interface GenerationStatusEvent {
  id: string;
  profile_id?: string | null;
  text?: string | null;
  status: 'loading_model' | 'generating' | 'completed' | 'failed' | 'not_found';
  duration?: number;
  error?: string;
  source?: string;
}

// Agent-initiated generations are played by the floating pill, not the
// main-window AudioPlayer. Skip autoplay here to avoid double-playback.
const AGENT_SOURCES = new Set(['mcp', 'rest']);
// Leave room for Generate, downloads, and other requests on HTTP/1.1.
const MAX_STATUS_STREAMS = 3;
const ROTATION_INTERVAL_MS = 1_000;

/**
 * Shares a bounded set of SSE connections across pending generations. When one completes,
 * invalidates the history query, removes it from pending, and auto-plays
 * if the player is idle.
 */
export function useGenerationProgress() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const pendingIds = useGenerationStore((s) => s.pendingGenerationIds);
  const serverUrl = useServerStore((s) => s.serverUrl);
  const serverRevision = useServerStore((s) => s.serverRevision);
  const removePendingGeneration = useGenerationStore((s) => s.removePendingGeneration);
  const removePendingStoryAdd = useGenerationStore((s) => s.removePendingStoryAdd);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const setAudioWithAutoPlay = usePlayerStore((s) => s.setAudioWithAutoPlay);
  const { settings: genSettings } = useGenerationSettings();
  const autoplayOnGenerate = genSettings?.autoplay_on_generate ?? true;

  // Keep refs to avoid stale closures in EventSource handlers
  const isPlayingRef = useRef(isPlaying);
  const autoplayRef = useRef(autoplayOnGenerate);
  isPlayingRef.current = isPlaying;
  autoplayRef.current = autoplayOnGenerate;

  // Track active EventSource instances
  const eventSourcesRef = useRef<Map<string, EventSource>>(new Map());

  // Close old-server subscriptions before opening streams for the new server.
  useEffect(() => {
    const sources = eventSourcesRef.current;
    return () => {
      for (const source of sources.values()) {
        source.close();
      }
      sources.clear();
    };
  }, [serverUrl, serverRevision]);

  useEffect(() => {
    const currentSources = eventSourcesRef.current;
    const isCurrentServer = () => {
      const server = useServerStore.getState();
      return server.serverUrl === serverUrl && server.serverRevision === serverRevision;
    };

    // Close SSE connections for IDs no longer pending
    for (const [id, source] of currentSources.entries()) {
      if (!pendingIds.has(id)) {
        source.close();
        currentSources.delete(id);
      }
    }

    function watch(id: string) {
      const url = apiClient.getGenerationStatusUrl(id);
      const source = new EventSource(url);
      const isCurrentSource = () =>
        currentSources.get(id) === source &&
        isCurrentServer() &&
        useGenerationStore.getState().pendingGenerationIds.has(id);

      source.onmessage = (event) => {
        if (!isCurrentSource()) return;
        try {
          const data: GenerationStatusEvent = JSON.parse(event.data);
          if (data.id !== id) return;

          if (data.status === 'completed') {
            source.close();
            currentSources.delete(id);
            removePendingGeneration(id);

            // Refetch history to pick up the completed generation
            queryClient.refetchQueries({ queryKey: ['history'] });

            // If this generation was queued for a story, add it now
            const storyId = removePendingStoryAdd(id);
            if (storyId) {
              apiClient
                .addStoryItem(storyId, { generation_id: id })
                .then(() => {
                  if (!isCurrentServer()) return;
                  queryClient.invalidateQueries({ queryKey: ['stories'] });
                  queryClient.invalidateQueries({ queryKey: ['stories', storyId] });
                  toast({
                    title: 'Added to story',
                    description: data.duration
                      ? `Audio generated (${data.duration.toFixed(2)}s) and added to story`
                      : 'Audio generated and added to story',
                  });
                })
                .catch(() => {
                  if (!isCurrentServer()) return;
                  toast({
                    title: 'Generation complete',
                    description: 'Audio generated but failed to add to story',
                    variant: 'destructive',
                  });
                });
            }

            // Auto-play if enabled and nothing is currently playing.
            // Skip agent-initiated sources — the floating pill window
            // plays those itself.
            const isAgentSpeak = data.source ? AGENT_SOURCES.has(data.source) : false;
            if (autoplayRef.current && !isPlayingRef.current && !isAgentSpeak) {
              const genAudioUrl = apiClient.getAudioUrl(id);
              setAudioWithAutoPlay(
                genAudioUrl,
                id,
                typeof data.profile_id === 'string' && data.profile_id ? data.profile_id : null,
                typeof data.text === 'string' ? data.text : '',
              );
            }
          } else if (data.status === 'failed' || data.status === 'not_found') {
            source.close();
            currentSources.delete(id);
            removePendingGeneration(id);
            removePendingStoryAdd(id);

            queryClient.refetchQueries({ queryKey: ['history'] });

            const condensed = condenseError(data.error || 'An error occurred during generation');
            toast({
              title: data.status === 'not_found' ? 'Generation not found' : 'Generation failed',
              description: condensed.truncated
                ? `${condensed.display}\n\n(${condensed.omitted} more characters — copy for the full error, or see Settings → Logs)`
                : condensed.display,
              variant: 'destructive',
              // Only offered when there is more to read than what is shown, so
              // the common short error keeps a plain toast.
              action: condensed.truncated ? (
                <ToastAction
                  altText="Copy the full error text"
                  onClick={() => {
                    // Two ways this fails: the Clipboard API is absent outside
                    // a secure context (property access throws), or writeText
                    // rejects because permission was denied. The try/catch
                    // covers both, so the click never becomes an unhandled
                    // rejection and the user is told nothing was copied.
                    void (async () => {
                      try {
                        await navigator.clipboard.writeText(condensed.full);
                      } catch {
                        toast({
                          title: 'Could not copy',
                          description:
                            'Clipboard unavailable. The full error is in Settings → Logs.',
                          variant: 'destructive',
                        });
                      }
                    })();
                  }}
                >
                  Copy
                </ToastAction>
              ) : undefined,
            });
          }
        } catch {
          // Ignore parse errors from heartbeats etc
        }
      };

      source.onerror = () => {
        if (!isCurrentSource()) return;
        // EventSource reconnects automatically after a transient interruption.
        // Keep pending story additions until it completes or closes permanently.
        if (source.readyState !== EventSource.CLOSED) return;
        // A permanently closed stream cannot report completion.
        source.close();
        currentSources.delete(id);
        removePendingGeneration(id);
        removePendingStoryAdd(id);
        queryClient.refetchQueries({ queryKey: ['history'] });
      };

      currentSources.set(id, source);
    }

    const waiting: string[] = [];
    for (const id of pendingIds) {
      if (currentSources.has(id)) continue;
      if (currentSources.size < MAX_STATUS_STREAMS) watch(id);
      else waiting.push(id);
    }
    if (!waiting.length) return;

    // A newly subscribed stream sends the current status first. Rotate the
    // oldest connection so later cancellations and completions are observed.
    const rotation = setInterval(() => {
      if (!isCurrentServer()) return;
      const next = waiting.shift();
      const oldest = currentSources.entries().next().value;
      if (!next || !oldest) return;
      const pending = useGenerationStore.getState().pendingGenerationIds;
      if (!pending.has(next)) return;
      const [id, source] = oldest;
      currentSources.delete(id);
      source.close();
      if (pending.has(id)) waiting.push(id);
      watch(next);
    }, ROTATION_INTERVAL_MS);
    return () => clearInterval(rotation);
  }, [
    pendingIds,
    serverUrl,
    serverRevision,
    removePendingGeneration,
    removePendingStoryAdd,
    queryClient,
    toast,
    setAudioWithAutoPlay,
  ]);
}
