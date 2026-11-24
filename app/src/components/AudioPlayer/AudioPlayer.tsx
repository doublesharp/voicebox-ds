import { useQuery } from '@tanstack/react-query';
import { Pause, Play, Repeat, Volume2, VolumeX, X } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { apiClient } from '@/lib/api/client';
import { NativePlaybackController, type NativePlaybackUpdate } from '@/lib/audio/nativePlayback';
import { bindPlaybackPresentation } from '@/lib/audio/playbackPresentation';
import { storyAudioCache } from '@/lib/audio/storyAudioCache';
import { formatAudioDuration } from '@/lib/utils/audio';
import { debug } from '@/lib/utils/debug';
import { usePlatform } from '@/platform/PlatformContext';
import { usePlayerStore } from '@/stores/playerStore';

export function AudioPlayer() {
  const audioUrl = usePlayerStore((state) => state.audioUrl);
  const audioId = usePlayerStore((state) => state.audioId);
  const sourceGeneration = usePlayerStore((state) => state.sourceGeneration);
  // WaveSurfer's fetch cancellation cannot cancel an already-running decode.
  // Give each source its own media graph so a late decode cannot replace the
  // newly selected clip's sound or waveform.
  return audioUrl ? (
    <AudioPlayerSession key={JSON.stringify([audioId, audioUrl, sourceGeneration])} />
  ) : null;
}

function getWaveSurferAudioContext(wavesurfer: WaveSurfer | null): AudioContext | null {
  if (!wavesurfer) return null;
  const media = wavesurfer.getMediaElement() as
    | (HTMLMediaElement & { getGainNode?: () => GainNode })
    | null;
  const ctx = media?.getGainNode?.()?.context as AudioContext | undefined;
  return ctx ?? null;
}

async function resumeWaveSurferAudioContext(wavesurfer: WaveSurfer | null): Promise<void> {
  const ctx = getWaveSurferAudioContext(wavesurfer);
  if (!ctx || ctx.state === 'running' || ctx.state === 'closed') return;
  try {
    await ctx.resume();
  } catch (err) {
    debug.error('Failed to resume WebAudio context:', err);
  }
}

function AudioPlayerSession() {
  const platform = usePlatform();
  const volumeLabelId = useId();
  const {
    audioUrl,
    audioId,
    sourceGeneration,
    profileId,
    isPlaying,
    currentTime,
    duration,
    volume,
    isLooping,
    shouldRestart,
    shouldAutoPlay,
    setIsPlaying,
    setCurrentTime,
    setDuration,
    setVolume,
    toggleLoop,
    clearRestartFlag,
    reset,
  } = usePlayerStore();

  // Check if profile has assigned channels (for native audio routing)
  const { data: profileChannels } = useQuery({
    queryKey: ['profile-channels', profileId],
    queryFn: () => {
      if (!profileId) return { channel_ids: [] };
      return apiClient.getProfileChannels(profileId);
    },
    enabled: !!profileId && platform.metadata.isTauri,
  });

  const { data: channels } = useQuery({
    queryKey: ['channels'],
    queryFn: () => apiClient.listChannels(),
    enabled: !!profileChannels && profileChannels.channel_ids.length > 0,
  });

  // Determine if we should use native playback
  const useNativePlayback = useMemo(() => {
    if (!platform.metadata.isTauri || !profileChannels || !channels) {
      return false;
    }

    const assignedChannels = channels.filter((ch) => profileChannels.channel_ids.includes(ch.id));

    // Use native playback if any assigned channel has non-default devices
    const shouldUseNative = assignedChannels.some(
      (ch) => ch.device_ids.length > 0 && !ch.is_default,
    );

    return shouldUseNative;
  }, [profileChannels, channels, platform.metadata.isTauri]);

  const deviceIds = useMemo(
    () => [
      ...new Set(
        (channels ?? [])
          .filter((channel) => profileChannels?.channel_ids.includes(channel.id))
          .flatMap((channel) => channel.device_ids),
      ),
    ],
    [channels, profileChannels],
  );
  const routingReady =
    !platform.metadata.isTauri ||
    !profileId ||
    (!!profileChannels && (profileChannels.channel_ids.length === 0 || !!channels));
  const nativeRoutingRef = useRef(useNativePlayback);
  nativeRoutingRef.current = useNativePlayback;
  const nativeControllerRef = useRef<NativePlaybackController | null>(null);
  const syncingNativePositionRef = useRef(false);
  const playbackActionsRef = useRef({
    playFrom: async (_position: number) => {},
    toggle: async () => {},
  });
  const onNativeUpdateRef = useRef((_event: NativePlaybackUpdate) => {});
  const [isStarting, setIsStarting] = useState(false);

  const waveformRef = useRef<HTMLDivElement>(null);
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const loadingRef = useRef(false);
  const previousAudioIdRef = useRef<string | null>(null);
  const hasInitializedRef = useRef(false);
  const isUsingNativePlaybackRef = useRef(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wsReady, setWsReady] = useState(false);
  const sourceIsCurrent = useCallback(() => {
    const selected = usePlayerStore.getState();
    return (
      selected.audioId === audioId &&
      selected.audioUrl === audioUrl &&
      selected.sourceGeneration === sourceGeneration
    );
  }, [audioId, audioUrl, sourceGeneration]);

  useEffect(() => {
    const controller = new NativePlaybackController(platform.audio, (event) =>
      onNativeUpdateRef.current(event),
    );
    nativeControllerRef.current = controller;
    return () => {
      controller.dispose();
      if (nativeControllerRef.current === controller) nativeControllerRef.current = null;
    };
  }, [platform.audio]);

  // Create one WaveSurfer for this source; source replacement unmounts it.
  useEffect(() => {
    if (!audioUrl) return;
    if (wavesurferRef.current) return; // already created

    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const initWaveSurfer = () => {
      if (disposed || !sourceIsCurrent() || wavesurferRef.current) return;
      const container = waveformRef.current;
      if (!container) {
        retry = setTimeout(initWaveSurfer, 50);
        return;
      }

      const rect = container.getBoundingClientRect();
      const style = window.getComputedStyle(container);
      const isVisible =
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden';

      if (!isVisible) {
        retry = setTimeout(initWaveSurfer, 50);
        return;
      }

      debug.log('Creating WaveSurfer instance', {
        width: rect.width,
        height: rect.height,
      });

      try {
        const root = document.documentElement;
        const getCSSVar = (varName: string) => {
          const value = getComputedStyle(root).getPropertyValue(varName).trim();
          return value ? `hsl(${value})` : '';
        };

        const wavesurfer = WaveSurfer.create({
          container,
          waveColor: getCSSVar('--muted'),
          progressColor: getCSSVar('--accent'),
          cursorColor: getCSSVar('--accent'),
          cursorWidth: 3,
          barWidth: 2,
          barRadius: 2,
          height: 'auto',
          normalize: true,
          interact: true,
          dragToSeek: { debounceTime: 0 },
          mediaControls: false,
          backend: 'WebAudio',
        });
        wavesurferRef.current = wavesurfer;
        const ownsSource = () =>
          !disposed && sourceIsCurrent() && wavesurferRef.current === wavesurfer;
        const restartLoop = () => {
          wavesurfer.seekTo(0);
          void resumeWaveSurferAudioContext(wavesurfer).then(() => {
            if (!ownsSource() || wavesurferRef.current !== wavesurfer) return;
            wavesurfer.play().catch((error) => {
              if (!ownsSource()) return;
              debug.error('Loop play failed:', error);
              setIsPlaying(false);
              setError(`Playback error: ${error instanceof Error ? error.message : String(error)}`);
            });
          });
        };

        const presentation = bindPlaybackPresentation(
          wavesurfer,
          setCurrentTime,
          () => ownsSource() && !isUsingNativePlaybackRef.current,
        );

        // Wire up event handlers (these persist for the lifetime of the instance)
        wavesurfer.on('timeupdate', (time) => {
          if (!ownsSource()) return;
          if (isUsingNativePlaybackRef.current) return;
          const dur = usePlayerStore.getState().duration;
          if (dur > 0 && time >= dur) {
            presentation.update(dur);
            const loop = usePlayerStore.getState().isLooping;
            if (loop) {
              restartLoop();
            } else {
              wavesurfer.pause();
              setIsPlaying(false);
            }
            return;
          }
          presentation.update(time);
        });

        wavesurfer.on('ready', () => {
          if (!ownsSource()) return;
          const dur = wavesurfer.getDuration();
          setDuration(dur);
          loadingRef.current = false;
          setIsLoading(false);
          setError(null);
          debug.log('Audio ready, duration:', dur);

          wavesurfer.setVolume(usePlayerStore.getState().volume);
          wavesurfer.setMuted(nativeRoutingRef.current);
        });

        wavesurfer.on('play', () => {
          if (!ownsSource()) return;
          if (!isUsingNativePlaybackRef.current) setIsPlaying(true);
        });
        wavesurfer.on('pause', () => {
          if (!ownsSource()) return;
          if (isUsingNativePlaybackRef.current) return;
          setIsPlaying(false);
          presentation.update();
        });

        wavesurfer.on('seeking', (time) => {
          if (!ownsSource()) return;
          if (isUsingNativePlaybackRef.current) {
            setCurrentTime(time);
            if (!syncingNativePositionRef.current) {
              void nativeControllerRef.current
                ?.control({ position: time })
                .catch((error) => setError(String(error)));
            }
          } else {
            presentation.update(time);
          }
        });

        // Mute audio during drag-to-seek to prevent popping from the WebAudio
        // backend's hard stop/start cycle on each seek. Unmute with a short
        // fade-in when the drag ends.
        const seekMedia = wavesurfer.getMediaElement() as HTMLMediaElement & {
          getGainNode?: () => GainNode;
        };
        const seekGain: GainNode | null = seekMedia?.getGainNode?.() ?? null;
        if (seekGain) {
          const ctx = seekGain.context as AudioContext;
          wavesurfer.on('dragstart', () => {
            seekGain.gain.cancelScheduledValues(ctx.currentTime);
            seekGain.gain.setTargetAtTime(0, ctx.currentTime, 0.002);
          });
          wavesurfer.on('dragend', () => {
            seekGain.gain.cancelScheduledValues(ctx.currentTime);
            const targetGain = nativeRoutingRef.current ? 0 : usePlayerStore.getState().volume;
            seekGain.gain.setTargetAtTime(targetGain, ctx.currentTime, 0.01);
          });
        }
        wavesurfer.on('finish', () => {
          if (!ownsSource()) return;
          if (isUsingNativePlaybackRef.current) return;
          const loop = usePlayerStore.getState().isLooping;
          if (loop) {
            restartLoop();
          } else {
            setIsPlaying(false);
            const onFinish = usePlayerStore.getState().onFinish;
            if (onFinish) onFinish();
          }
        });

        wavesurfer.on('error', (err) => {
          if (!ownsSource()) return;
          debug.error('WaveSurfer error:', err);
          setIsLoading(false);
          setError(`Audio error: ${err instanceof Error ? err.message : String(err)}`);
        });

        wavesurfer.on('loading', (percent) => {
          if (!ownsSource()) return;
          setIsLoading(true);
          if (percent === 100) setIsLoading(false);
        });

        wavesurferRef.current = wavesurfer;
        setWsReady(true);
        debug.log('WaveSurfer created successfully');
      } catch (err) {
        debug.error('Failed to create WaveSurfer:', err);
        setError(
          `Failed to initialize waveform: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };

    let rafId: number;
    rafId = requestAnimationFrame(() => {
      initWaveSurfer();
    });

    return () => {
      disposed = true;
      clearTimeout(retry);
      cancelAnimationFrame(rafId);
    };
    // Only run on mount-like conditions. audioUrl is here so we create the instance
    // when the player first appears, but we guard against re-creation above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioUrl, sourceIsCurrent, setIsPlaying, setDuration, setCurrentTime]);

  // Destroy WaveSurfer only on unmount
  useEffect(() => {
    return () => {
      if (wavesurferRef.current) {
        debug.log('Destroying WaveSurfer instance (unmount)');
        try {
          const wavesurfer = wavesurferRef.current;
          wavesurferRef.current = null;
          wavesurfer.pause();
          const media = wavesurfer.getMediaElement() as HTMLMediaElement & {
            getGainNode?: () => GainNode;
          };
          media.removeAttribute?.('src');
          wavesurfer.destroy();
          // WaveSurfer's WebAudio media is treated as externally supplied and
          // its destroy() does not release this context. We own it here.
          const context = media.getGainNode?.().context as AudioContext | undefined;
          if (context && context.state !== 'closed') {
            void context
              .close?.()
              .catch((error) => debug.error('Audio context close failed:', error));
          }
        } catch (err) {
          debug.error('Error destroying WaveSurfer:', err);
        }
        wavesurferRef.current = null;
        setWsReady(false);
      }
    };
  }, []);

  // Load audio when URL changes (reuses the existing WaveSurfer instance)
  useEffect(() => {
    const wavesurfer = wavesurferRef.current;
    if (!wavesurfer || !wsReady || !routingReady) return;
    let active = true;

    // Invalidate pending fetch/start requests before resetting or replacing media.
    void nativeControllerRef.current
      ?.stop()
      .catch((error) => debug.error('Native stop failed:', error));
    setIsStarting(false);

    if (!audioUrl) {
      // No audio - pause and reset
      wavesurfer.pause();
      wavesurfer.seekTo(0);
      loadingRef.current = false;
      setIsLoading(false);
      setDuration(0);
      setCurrentTime(0);
      setError(null);
      isUsingNativePlaybackRef.current = false;
      return;
    }

    // Reset native playback state
    isUsingNativePlaybackRef.current = false;
    wavesurfer.setMuted(false);
    wavesurfer.setVolume(usePlayerStore.getState().volume);

    // Stop current playback and reset position before loading new audio.
    // With the WebAudio backend, pause() accumulates playedDuration internally.
    // seekTo(0) resets it so the new track starts from the beginning.
    debug.log('Loading new audio URL:', audioUrl);
    try {
      if (wavesurfer.isPlaying()) {
        wavesurfer.pause();
      }
      wavesurfer.seekTo(0);
    } catch (err) {
      debug.error('Error resetting before load:', err);
    }

    loadingRef.current = true;
    setIsLoading(true);
    setError(null);
    setCurrentTime(0);
    setDuration(0);

    const waveform = useNativePlayback
      ? storyAudioCache.retainWaveform({
          key: JSON.stringify([audioUrl, sourceGeneration]),
          url: audioUrl,
        })
      : null;
    const load = waveform
      ? waveform.promise.then(({ peaks, duration: sourceDuration }) => {
          if (!active || !sourceIsCurrent()) return;
          // A native-routed waveform has no media URL: Rust is the only
          // owner that fetches and decodes the actual audio recording.
          return wavesurfer.load('', peaks, sourceDuration);
        })
      : wavesurfer.load(audioUrl);
    load
      .then(() => {
        if (!active || !sourceIsCurrent() || wavesurferRef.current !== wavesurfer) return;
        debug.log('Audio loaded into WaveSurfer');
        loadingRef.current = false;
      })
      .catch((err) => {
        if (!active || !sourceIsCurrent() || wavesurferRef.current !== wavesurfer) return;
        debug.error('Failed to load audio:', err);
        loadingRef.current = false;
        setIsLoading(false);
        setError(`Failed to load audio: ${err instanceof Error ? err.message : String(err)}`);
      });
    return () => {
      active = false;
      waveform?.release();
    };
  }, [
    audioUrl,
    sourceGeneration,
    wsReady,
    sourceIsCurrent,
    setCurrentTime,
    setDuration,
    routingReady,
    useNativePlayback,
  ]);

  // Sync play/pause state (only when user clicks play/pause button, not auto-sync)
  // This effect is kept for external state changes but should be minimal
  // biome-ignore lint/correctness/useExhaustiveDependencies: isPlaying triggers synchronization; the current store value prevents an older effect from pausing newer playback.
  useEffect(() => {
    if (!sourceIsCurrent() || !wavesurferRef.current || duration === 0) return;
    const playing = usePlayerStore.getState().isPlaying;
    if (nativeRoutingRef.current) {
      const controller = nativeControllerRef.current;
      if (controller?.isStarting) return;
      if (controller?.hasSession) {
        void controller.control({ paused: !playing }).catch((error) => setError(String(error)));
      } else if (playing) {
        void playbackActionsRef.current.playFrom(usePlayerStore.getState().currentTime);
      }
      return;
    }

    const wavesurfer = wavesurferRef.current;
    if (playing && wavesurfer.isPlaying() === false) {
      void resumeWaveSurferAudioContext(wavesurfer).then(() => {
        if (!sourceIsCurrent() || wavesurferRef.current !== wavesurfer) return;
        if (!usePlayerStore.getState().isPlaying || nativeRoutingRef.current) return;
        wavesurfer.play().catch((error) => {
          if (!sourceIsCurrent() || wavesurferRef.current !== wavesurfer) return;
          debug.error('Failed to play:', error);
          setIsPlaying(false);
          setError(`Playback error: ${error instanceof Error ? error.message : String(error)}`);
        });
      });
    } else if (!playing && wavesurfer.isPlaying()) {
      wavesurfer.pause();
    }
  }, [isPlaying, sourceIsCurrent, setIsPlaying, duration]);

  // Recover a macOS/WKWebView AudioContext suspended while backgrounded.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      if (!usePlayerStore.getState().isPlaying || nativeRoutingRef.current) return;
      void resumeWaveSurferAudioContext(wavesurferRef.current);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  // Sync volume
  useEffect(() => {
    if (wavesurferRef.current) {
      wavesurferRef.current.setVolume(nativeRoutingRef.current ? 0 : volume);
    }
    void nativeControllerRef.current?.control({ volume }).catch((error) => setError(String(error)));
  }, [volume]);

  // Mark as initialized when audio is ready, reset when audioId changes
  useEffect(() => {
    if (duration > 0 && audioId) {
      hasInitializedRef.current = true;
    }
    // Reset initialization flag when audioId changes to a new audio
    if (audioId !== previousAudioIdRef.current && previousAudioIdRef.current !== null) {
      hasInitializedRef.current = false;
    }
    if (audioId !== null) {
      previousAudioIdRef.current = audioId;
    }
  }, [duration, audioId]);

  // Handle restart flag - when history item is clicked again, restart from beginning
  useEffect(() => {
    const wavesurfer = wavesurferRef.current;
    if (!wavesurfer || !shouldRestart || duration === 0) {
      return;
    }

    void playbackActionsRef.current.playFrom(0);

    clearRestartFlag();
  }, [shouldRestart, duration, clearRestartFlag]);

  const routeKey = useNativePlayback ? [...deviceIds].sort().join('\n') : '';
  const previousRouteRef = useRef(routeKey);
  useEffect(() => {
    if (previousRouteRef.current === routeKey) return;
    previousRouteRef.current = routeKey;
    void nativeControllerRef.current
      ?.stop()
      .catch((error) => debug.error('Native stop failed:', error));
    if (isUsingNativePlaybackRef.current) {
      wavesurferRef.current?.pause();
      isUsingNativePlaybackRef.current = false;
      setIsPlaying(false);
      setIsStarting(false);
    }
  }, [routeKey, setIsPlaying]);

  // Wait for both decoded media and routing before autoplay, so a slow channel
  // query cannot send a custom-device profile to the default output first.
  useEffect(() => {
    if (!sourceIsCurrent() || !shouldAutoPlay || !routingReady || duration === 0 || isLoading)
      return;
    usePlayerStore.getState().clearAutoPlayFlag();
    void playbackActionsRef.current.playFrom(0);
  }, [shouldAutoPlay, sourceIsCurrent, routingReady, duration, isLoading]);

  // Spacebar to play/pause (capture phase so it fires before focused elements)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.code !== 'Space' ||
        e.defaultPrevented ||
        e.repeat ||
        e.isComposing ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey
      )
        return;
      // Let focused controls handle Space, including history cards and sliders.
      const target = e.target as HTMLElement | null;
      if (
        target?.isContentEditable ||
        target?.closest?.(
          'button, input, textarea, select, a[href], [role="dialog"], [role="alertdialog"], [role="menu"], [role="button"], [role="slider"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="option"], [role="combobox"], [role="textbox"], [data-shortcut-capture]',
        )
      ) {
        return;
      }
      if (audioUrl && duration > 0 && wavesurferRef.current) {
        e.preventDefault();
        e.stopPropagation();
        void playbackActionsRef.current.toggle();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [audioUrl, duration]);

  const playFrom = async (position: number) => {
    const wavesurfer = wavesurferRef.current;
    if (!wavesurfer || !audioUrl || !routingReady || duration === 0) return;
    setError(null);
    if (useNativePlayback) {
      isUsingNativePlaybackRef.current = true;
      wavesurfer.pause();
      wavesurfer.setMuted(true);
      wavesurfer.setVolume(0);
      await nativeControllerRef.current?.start(
        audioUrl,
        deviceIds,
        position,
        usePlayerStore.getState().volume,
      );
      return;
    }
    isUsingNativePlaybackRef.current = false;
    wavesurfer.setMuted(false);
    wavesurfer.setVolume(usePlayerStore.getState().volume);
    wavesurfer.setTime(position);
    try {
      await resumeWaveSurferAudioContext(wavesurfer);
      if (!sourceIsCurrent() || wavesurferRef.current !== wavesurfer) return;
      await wavesurfer.play();
    } catch (error) {
      if (!sourceIsCurrent() || wavesurferRef.current !== wavesurfer) return;
      setIsPlaying(false);
      setError(`Playback error: ${String(error)}`);
    }
  };

  onNativeUpdateRef.current = (event) => {
    if (!sourceIsCurrent()) return;
    setIsStarting(event.state === 'starting');
    if (event.state === 'starting') return;
    if (event.state === 'error') {
      setIsPlaying(false);
      setError(event.error || 'Native audio playback failed');
      return;
    }
    // Native events report raw source time. WebAudio is not played as a second
    // clock; its waveform only receives the native session's current position.
    syncingNativePositionRef.current = true;
    try {
      wavesurferRef.current?.setTime(event.position);
    } finally {
      syncingNativePositionRef.current = false;
    }
    setCurrentTime(event.position);
    if (event.duration > 0) setDuration(event.duration);
    setIsPlaying(event.state === 'playing');
    if (event.state === 'ended') {
      if (usePlayerStore.getState().isLooping) void playbackActionsRef.current.playFrom(0);
      else usePlayerStore.getState().onFinish?.();
    }
  };

  const handlePlayPause = async () => {
    const wavesurfer = wavesurferRef.current;
    if (!wavesurfer || duration === 0 || !routingReady) return;
    if (useNativePlayback) {
      const controller = nativeControllerRef.current;
      if (!controller || controller.isStarting) return;
      const playing = usePlayerStore.getState().isPlaying;
      if (controller.hasSession) {
        try {
          await controller.control({ paused: playing });
          if (!sourceIsCurrent()) return;
          setIsPlaying(!playing);
        } catch (error) {
          setError(String(error));
        }
      } else {
        const time = usePlayerStore.getState().currentTime;
        await playFrom(time >= duration ? 0 : time);
      }
    } else if (wavesurfer.isPlaying()) wavesurfer.pause();
    else await playFrom(wavesurfer.getCurrentTime() >= duration ? 0 : wavesurfer.getCurrentTime());
  };
  playbackActionsRef.current = { playFrom, toggle: handlePlayPause };

  const handleSeek = (value: number[]) => {
    if (!wavesurferRef.current || duration === 0) return;
    const progress = value[0] / 100;
    wavesurferRef.current.seekTo(progress);
  };

  const handleVolumeChange = (value: number[]) => {
    setVolume(value[0] / 100);
  };

  const handleClose = () => {
    void nativeControllerRef.current
      ?.stop()
      .catch((error) => debug.error('Native stop failed:', error));
    setIsStarting(false);
    // Stop WaveSurfer
    if (wavesurferRef.current) {
      wavesurferRef.current.pause();
      wavesurferRef.current.seekTo(0);
    }
    // Reset player state
    reset();
  };

  // Don't render if no audio
  if (!audioUrl) {
    return null;
  }

  return (
    <div className="app-global-player fixed bottom-0 left-[var(--app-rail-width)] right-0 z-50 border-t border-border/70 bg-card/95 backdrop-blur">
      <div className="container mx-auto max-w-7xl px-2 py-1.5 md:px-4 md:py-2">
        <div className="flex items-center gap-1.5 md:gap-3">
          {/* Play/Pause Button */}
          <Button
            variant="ghost"
            size="icon"
            onClick={handlePlayPause}
            disabled={isLoading || isStarting || !routingReady || duration === 0}
            className={`size-8 shrink-0 md:size-9 ${isPlaying ? 'bg-accent/15 text-foreground' : ''}`}
            title={duration === 0 && !isLoading ? 'Audio not loaded' : ''}
            aria-label={
              duration === 0 && !isLoading ? 'Audio not loaded' : isPlaying ? 'Pause' : 'Play'
            }
          >
            {isPlaying ? (
              <Pause className="h-5 w-5 fill-current" />
            ) : (
              <Play className="h-5 w-5 fill-current" />
            )}
          </Button>

          {/* Waveform */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div ref={waveformRef} className="h-8 w-full select-none md:h-12" />
            <Slider
              value={duration > 0 ? [(currentTime / duration) * 100] : [0]}
              onValueChange={handleSeek}
              max={100}
              step={0.1}
              className="h-4 w-full"
              aria-label="Playback position"
              aria-valuetext={`${formatAudioDuration(currentTime)} of ${formatAudioDuration(duration)}`}
            />
            <span className="self-end font-mono text-[10px] leading-none text-muted-foreground md:hidden">
              {formatAudioDuration(currentTime)} / {formatAudioDuration(duration)}
            </span>

            {error && <div className="text-xs text-destructive text-center py-2">{error}</div>}
          </div>

          {/* Time Display */}
          <span className="hidden shrink-0 whitespace-nowrap font-mono text-xs text-muted-foreground md:block">
            {formatAudioDuration(currentTime)} / {formatAudioDuration(duration)}
          </span>

          {/* Loop Button */}
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleLoop}
            className={`size-8 shrink-0 ${isLooping ? 'bg-accent/15 text-foreground' : ''}`}
            title="Toggle loop"
            aria-label={isLooping ? 'Stop looping' : 'Loop'}
          >
            <Repeat className="h-4 w-4" />
          </Button>

          {/* Volume Control */}
          <fieldset
            className="flex shrink-0 items-center gap-1 border-0 p-0 md:w-27"
            aria-label="Volume"
          >
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setVolume(volume > 0 ? 0 : 1)}
              className="h-8 w-8"
              aria-label={volume > 0 ? 'Mute' : 'Unmute'}
            >
              {volume > 0 ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
            </Button>
            <span id={volumeLabelId} className="sr-only">
              Volume level, {Math.round(volume * 100)}%
            </span>
            <Slider
              value={[volume * 100]}
              onValueChange={handleVolumeChange}
              max={100}
              step={1}
              className="hidden h-4 flex-1 md:flex"
              aria-labelledby={volumeLabelId}
              aria-valuetext={`${Math.round(volume * 100)}%`}
            />
          </fieldset>

          {/* Close Button */}
          <Button
            variant="ghost"
            size="icon"
            onClick={handleClose}
            className="size-8 shrink-0 text-muted-foreground"
            title="Close player"
            aria-label="Close player"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
