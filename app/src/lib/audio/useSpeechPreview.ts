import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api/client';
import type { GenerationRequest, SpeechPreviewMode } from '@/lib/api/types';
import { currentServerScope, isCurrentServer } from '@/lib/serverScope';
import { usePlatform } from '@/platform/PlatformContext';
import { usePlayerStore } from '@/stores/playerStore';
import { useServerStore } from '@/stores/serverStore';
import { BrowserSpeechPreview } from './browserSpeechPreview';
import { IncrementalPlayback } from './incrementalPlayback';

export function useSpeechPreview(profileId: string | null, onError: (message: string) => void) {
  const platform = usePlatform();
  const queryClient = useQueryClient();
  const [active, setActive] = useState(false);
  const revision = useRef(0);
  const errorRef = useRef(onError);
  errorRef.current = onError;
  const native = platform.metadata.isTauri && !!platform.audio.startPcmStream;
  const controller = useMemo(() => {
    const update = (playing: boolean, error?: string) => {
      setActive(playing);
      if (error) errorRef.current(error);
    };
    return native
      ? new IncrementalPlayback(platform.audio, update)
      : new BrowserSpeechPreview(update);
  }, [native, platform.audio]);
  const stop = useCallback(async () => {
    revision.current++;
    setActive(false);
    await controller.stop();
  }, [controller]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A voice change must revoke pending routing and playback even when the native adapter is unchanged.
  useEffect(() => {
    revision.current++;
    setActive(false);
    controller.dispose();
    return () => {
      revision.current++;
      controller.dispose();
    };
  }, [controller, profileId]);
  useEffect(() => {
    const unsubscribeServer = useServerStore.subscribe((state, previous) => {
      if (
        state.serverUrl !== previous.serverUrl ||
        state.serverRevision !== previous.serverRevision
      )
        void stop();
    });
    const unsubscribePlayer = usePlayerStore.subscribe((state, previous) => {
      if (state.sourceGeneration !== previous.sourceGeneration) void stop();
    });
    const unsubscribeRoutes = queryClient.getQueryCache().subscribe((event) => {
      if (!native || event.type !== 'updated' || event.action.type !== 'success') return;
      const key = event.query.queryKey;
      if (key[0] === 'channels' || (key[0] === 'profile-channels' && key[1] === profileId))
        void stop();
    });
    return () => {
      unsubscribeServer();
      unsubscribePlayer();
      unsubscribeRoutes();
    };
  }, [stop, profileId, queryClient, native]);
  const start = async (
    data: GenerationRequest,
    mode: SpeechPreviewMode = 'incremental',
    modelToPrepare?: string,
  ) => {
    if (data.profile_id !== profileId || (mode === 'incremental' && !native)) return;
    const scope = currentServerScope();
    const request = ++revision.current;
    const current = () => request === revision.current && isCurrentServer(scope);
    await controller.stop();
    if (!current()) return;
    setActive(true);
    try {
      // Resolve only this voice's configured route; never substitute another
      // voice or output when assigned devices are missing.
      const channelIds = native
        ? (await apiClient.getProfileChannels(data.profile_id)).channel_ids
        : [];
      if (!current()) return;
      const channels = channelIds.length ? await apiClient.listChannels() : [];
      if (!current()) return;
      const assigned = channels.filter((channel) => channelIds.includes(channel.id));
      if (assigned.length !== channelIds.length)
        throw new Error('A voice output channel is unavailable');
      const custom = assigned.some(
        (channel) => !channel.is_default && channel.device_ids.length > 0,
      );
      const devices = custom ? [...new Set(assigned.flatMap((channel) => channel.device_ids))] : [];
      // Close existing main-window media before acquiring the shared native owner.
      usePlayerStore.getState().reset();
      // reset synchronously revokes older previews through the subscription.
      const selected = ++revision.current;
      setActive(true);
      await controller.start(
        data,
        devices,
        () => selected === revision.current && isCurrentServer(scope),
        mode,
        modelToPrepare,
      );
    } catch (error) {
      if (!current()) return;
      setActive(false);
      errorRef.current(error instanceof Error ? error.message : String(error));
    }
  };
  return {
    active,
    start,
    stop,
    available: native,
    bufferedAvailable:
      native || (!platform.metadata.isTauri && typeof AudioContext !== 'undefined'),
  };
}
