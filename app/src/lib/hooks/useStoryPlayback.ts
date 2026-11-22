import { useCallback, useEffect, useRef } from 'react';
import type { StoryItemDetail } from '@/lib/api/types';
import {
  retainStoryAudioContext,
  type StoryAudioAsset,
  type StoryAudioLease,
  storyAudioCache,
  storyAudioSource,
} from '@/lib/audio/storyAudioCache';
import { useStoryStore } from '@/stores/storyStore';

const PRELOAD_WINDOW_MS = 30_000;
const SCHEDULER_INTERVAL_MS = 50;
const START_LEAD_SECONDS = 0.005;

interface ActiveSource {
  source: AudioBufferSourceNode;
  gain: GainNode;
  endTimeMs: number;
}

interface PlaybackSession {
  items: StoryItemDetail[];
  scheduled: Set<string>;
  failed: Set<string>;
  anchorContextTime: number | null;
  anchorStoryTime: number;
  stopped: boolean;
  timer?: ReturnType<typeof setInterval>;
  frame?: number;
}

const endTime = (item: StoryItemDetail) =>
  item.start_time_ms +
  Math.max(0, item.duration * 1000 - (item.trim_start_ms || 0) - (item.trim_end_ms || 0));

const playbackSignature = (itemList: StoryItemDetail[]) =>
  JSON.stringify(
    itemList.map((item) => [
      item.id,
      storyAudioSource(item).key,
      item.start_time_ms,
      item.duration,
      item.trim_start_ms,
      item.trim_end_ms,
      item.volume,
    ]),
  );

/** Web Audio owns playback timing; animation frames only paint the playhead. */
export function useStoryPlayback(items: StoryItemDetail[] | undefined) {
  const contextLeaseRef = useRef<ReturnType<typeof retainStoryAudioContext> | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const retainedRef = useRef(new Map<string, StoryAudioLease<StoryAudioAsset>>());
  const sourcesRef = useRef(new Map<string, ActiveSource>());
  const sessionRef = useRef<PlaybackSession | null>(null);
  const displayedItemsRef = useRef(items);
  const displayedStoryIdRef = useRef<string | null>(null);
  displayedItemsRef.current = items;
  if (items?.length) displayedStoryIdRef.current = items[0].story_id;

  const getContext = useCallback(() => {
    if (!contextLeaseRef.current || contextLeaseRef.current.context.state === 'closed') {
      masterGainRef.current?.disconnect();
      contextLeaseRef.current?.release();
      contextLeaseRef.current = retainStoryAudioContext();
      const context = contextLeaseRef.current.context;
      masterGainRef.current = context.createGain();
      masterGainRef.current.gain.value = 1;
      masterGainRef.current.connect(context.destination);
    }
    return contextLeaseRef.current.context;
  }, []);

  const stopSource = useCallback((id: string) => {
    const active = sourcesRef.current.get(id);
    if (!active) return;
    active.source.onended = null;
    try {
      active.source.stop();
    } catch {
      /* Already stopped. */
    }
    active.source.disconnect();
    active.gain.disconnect();
    sourcesRef.current.delete(id);
  }, []);

  const stopSources = useCallback(() => {
    for (const id of sourcesRef.current.keys()) stopSource(id);
  }, [stopSource]);

  const retainWindow = useCallback((itemList: StoryItemDetail[], position: number) => {
    const wanted = new Map(
      itemList
        .filter(
          (item) =>
            endTime(item) > position &&
            item.start_time_ms <= position + PRELOAD_WINDOW_MS &&
            !sessionRef.current?.failed.has(storyAudioSource(item).key),
        )
        .map((item) => {
          const source = storyAudioSource(item);
          return [source.key, source] as const;
        }),
    );
    for (const [key, lease] of retainedRef.current) {
      if (!wanted.has(key)) {
        lease.release();
        retainedRef.current.delete(key);
      }
    }
    for (const [key, source] of wanted) {
      if (!retainedRef.current.has(key)) {
        const lease = storyAudioCache.retain(source);
        // Failed clips are skipped once per playback session, rather than
        // re-requested every scheduler tick or trapping playback at a seek.
        void lease.promise.catch((error) => {
          if (retainedRef.current.get(key) !== lease) return;
          lease.release();
          retainedRef.current.delete(key);
          const session = sessionRef.current;
          if (
            !session ||
            session.stopped ||
            (error instanceof DOMException && error.name === 'AbortError')
          ) {
            return;
          }
          session.failed.add(key);
          for (const item of session.items) {
            if (storyAudioSource(item).key === key) session.scheduled.add(item.id);
          }
          useStoryStore.setState({
            playbackError: {
              storyId: session.items[0].story_id,
              message: 'One or more audio clips could not be loaded and were skipped.',
            },
          });
        });
        retainedRef.current.set(key, lease);
      }
    }
    const storyKeys = new Set([
      ...itemList.map((item) => storyAudioSource(item).key),
      ...(displayedItemsRef.current || []).map((item) => storyAudioSource(item).key),
    ]);
    storyAudioCache.prune(storyKeys);
    return [...retainedRef.current.values()];
  }, []);

  useEffect(() => {
    const state = useStoryStore.getState();
    if (state.isPlaying) {
      if (
        items?.length === 0 &&
        state.selectedStoryId === displayedStoryIdRef.current &&
        state.playbackStoryId === displayedStoryIdRef.current
      ) {
        useStoryStore.getState().stop();
        retainWindow([], 0);
        return;
      }
      if (
        items?.length &&
        items[0].story_id === state.playbackStoryId &&
        playbackSignature(items) !== playbackSignature(state.playbackItems || [])
      ) {
        const session = sessionRef.current;
        const position =
          session?.anchorContextTime !== null && session?.anchorContextTime !== undefined
            ? session.anchorStoryTime +
              Math.max(0, getContext().currentTime - session.anchorContextTime) * 1000
            : state.currentTimeMs;
        useStoryStore.setState({
          playbackItems: items,
          currentTimeMs: position,
          playbackStartContextTime: null,
          playbackStartStoryTime: null,
        });
      }
      return;
    }
    if (items?.length) getContext();
    retainWindow(items || [], useStoryStore.getState().currentTimeMs);
  }, [items, getContext, retainWindow]);

  useEffect(() => {
    const positionFor = (session: PlaybackSession) => {
      if (session.anchorContextTime === null || !contextLeaseRef.current)
        return session.anchorStoryTime;
      return (
        session.anchorStoryTime +
        Math.max(0, contextLeaseRef.current.context.currentTime - session.anchorContextTime) * 1000
      );
    };

    const stopSession = (keepPosition: boolean) => {
      const previous = sessionRef.current;
      sessionRef.current = null;
      if (previous) {
        previous.stopped = true;
        if (previous.timer !== undefined) clearInterval(previous.timer);
        if (previous.frame !== undefined) cancelAnimationFrame(previous.frame);
        if (keepPosition && previous.anchorContextTime !== null) {
          useStoryStore.setState({
            currentTimeMs: Math.min(
              positionFor(previous),
              useStoryStore.getState().totalDurationMs,
            ),
          });
        }
      }
      stopSources();
    };

    const scheduleReady = (session: PlaybackSession, position: number) => {
      if (session.anchorContextTime === null) return;
      const context = getContext();
      // Ready starts are scheduled ahead and survive busy rendering or
      // ordinary background timer throttling.
      for (const item of session.items) {
        if (
          endTime(item) <= position ||
          item.start_time_ms > position + PRELOAD_WINDOW_MS ||
          session.scheduled.has(item.id)
        )
          continue;
        const asset = storyAudioCache.get(storyAudioSource(item).key);
        if (!asset) continue;
        const trimStart = (item.trim_start_ms || 0) / 1000;
        const seekOffset = Math.max(0, (session.anchorStoryTime - item.start_time_ms) / 1000);
        const offset = trimStart + seekOffset;
        const duration =
          Math.min(item.duration, asset.buffer.duration) - (item.trim_end_ms || 0) / 1000 - offset;
        if (duration <= 0) {
          session.scheduled.add(item.id);
          continue;
        }
        const when = Math.max(
          context.currentTime,
          session.anchorContextTime +
            (Math.max(item.start_time_ms, session.anchorStoryTime) - session.anchorStoryTime) /
              1000,
        );
        const source = context.createBufferSource();
        source.buffer = asset.buffer;
        const gain = context.createGain();
        gain.gain.value = typeof item.volume === 'number' ? item.volume : 1;
        source.connect(gain);
        gain.connect(masterGainRef.current || context.destination);
        const active = { source, gain, endTimeMs: endTime(item) };
        sourcesRef.current.set(item.id, active);
        session.scheduled.add(item.id);
        source.onended = () => {
          // Stale ended events cannot erase a source replaced by seeking.
          if (sessionRef.current !== session || sourcesRef.current.get(item.id) !== active) return;
          source.disconnect();
          gain.disconnect();
          sourcesRef.current.delete(item.id);
        };
        source.start(when, offset, duration);
      }
    };

    const startSession = () => {
      stopSession(false);
      const state = useStoryStore.getState();
      if (!state.isPlaying || !state.playbackItems?.length) return;
      const session: PlaybackSession = {
        items: [...state.playbackItems].sort((a, b) => a.start_time_ms - b.start_time_ms),
        scheduled: new Set(),
        failed: new Set(),
        anchorContextTime: null,
        anchorStoryTime: state.currentTimeMs,
        stopped: false,
      };
      sessionRef.current = session;
      const context = getContext();
      const leases = retainWindow(session.items, session.anchorStoryTime);
      const stale = () =>
        session.stopped || sessionRef.current !== session || context.state === 'closed';
      void (async () => {
        try {
          // Keep the clock still while the first window loads or fails.
          await Promise.allSettled(leases.map((lease) => lease.promise));
          if (stale()) return;
          if (context.state !== 'running') await context.resume();
          if (stale()) return;
          session.anchorContextTime = context.currentTime + START_LEAD_SECONDS;
          const total = Math.max(0, ...session.items.map(endTime));
          useStoryStore.setState({
            playbackStartContextTime: session.anchorContextTime,
            playbackStartStoryTime: session.anchorStoryTime,
            totalDurationMs: total,
          });
          scheduleReady(session, session.anchorStoryTime);

          const tick = () => {
            if (session.stopped || sessionRef.current !== session) return;
            const position = positionFor(session);
            for (const [id, source] of sourcesRef.current) {
              if (source.endTimeMs <= position) stopSource(id);
            }
            retainWindow(session.items, position);
            const late = session.items.find(
              (item) =>
                item.start_time_ms >= session.anchorStoryTime &&
                endTime(item) > item.start_time_ms &&
                item.start_time_ms <= position &&
                !session.scheduled.has(item.id),
            );
            if (late) {
              // After a long suspension, rebuffer at the missed boundary
              // rather than silently discarding the clip's first words.
              useStoryStore.getState().seek(late.start_time_ms);
              return;
            }
            scheduleReady(session, position);
            if (position >= total) useStoryStore.getState().stop();
          };
          session.timer = setInterval(tick, SCHEDULER_INTERVAL_MS);
          const paint = () => {
            if (session.stopped || sessionRef.current !== session) return;
            useStoryStore.setState({ currentTimeMs: Math.min(positionFor(session), total) });
            session.frame = requestAnimationFrame(paint);
          };
          session.frame = requestAnimationFrame(paint);
        } catch (error) {
          if (session.stopped || sessionRef.current !== session) return;
          console.error('[StoryPlayback] Audio could not be prepared:', error);
          useStoryStore.setState({
            playbackError: {
              storyId: session.items[0].story_id,
              message: 'Playback could not start. Try playing the story again.',
            },
          });
          useStoryStore.getState().pause();
        }
      })();
    };

    const unsubscribe = useStoryStore.subscribe((next, previous) => {
      if (!next.isPlaying) {
        if (previous.isPlaying) {
          stopSession(
            next.playbackStoryId !== null && next.playbackStoryId === previous.playbackStoryId,
          );
        }
        return;
      }
      const sought =
        next.playbackStartContextTime === null &&
        (previous.playbackStartContextTime !== null ||
          next.currentTimeMs !== previous.currentTimeMs);
      if (
        !previous.isPlaying ||
        sought ||
        next.playbackItems !== previous.playbackItems ||
        next.playbackStoryId !== previous.playbackStoryId
      )
        startSession();
    });
    if (useStoryStore.getState().isPlaying) startSession();

    return () => {
      unsubscribe();
      stopSession(false);
      for (const lease of retainedRef.current.values()) lease.release();
      retainedRef.current.clear();
      storyAudioCache.prune(new Set());
      masterGainRef.current?.disconnect();
      masterGainRef.current = null;
      contextLeaseRef.current?.release();
      contextLeaseRef.current = null;
    };
  }, [getContext, retainWindow, stopSource, stopSources]);
}
