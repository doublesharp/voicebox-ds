import { Loader2, Pause, Play } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { debug } from '@/lib/utils/debug';

function formatDuration(ms?: number | null): string {
  if (!ms || ms < 0) return '0:00';
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function CaptureInlinePlayer({
  audioUrl,
  fallbackDurationMs,
  className,
}: {
  audioUrl: string;
  fallbackDurationMs?: number | null;
  className?: string;
}) {
  const waveformRef = useRef<HTMLDivElement>(null);
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = waveformRef.current;
    if (!container) return;

    let active = true;
    setIsLoading(true);
    setError(null);
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
    const root = document.documentElement;
    const cssHsla = (varName: string, alpha: number) => {
      const value = getComputedStyle(root).getPropertyValue(varName).trim();
      if (!value) return '';
      const [h, s, l] = value.split(/\s+/);
      if (!h || !s || !l) return '';
      return `hsla(${h}, ${s}, ${l}, ${alpha})`;
    };

    const ws = WaveSurfer.create({
      container,
      waveColor: cssHsla('--muted-foreground', 1),
      progressColor: cssHsla('--accent', 1),
      cursorColor: 'transparent',
      barWidth: 2,
      barRadius: 2,
      barGap: 2,
      height: 40,
      normalize: true,
      interact: true,
      dragToSeek: { debounceTime: 0 },
      mediaControls: false,
      backend: 'WebAudio',
    });

    ws.on('ready', () => {
      if (!active) return;
      setDuration(ws.getDuration());
      setIsLoading(false);
      setError(null);
    });
    ws.on('play', () => {
      if (active) setIsPlaying(true);
    });
    ws.on('pause', () => {
      if (active) setIsPlaying(false);
    });
    ws.on('finish', () => {
      if (!active) return;
      setIsPlaying(false);
      setCurrentTime(ws.getDuration());
    });
    ws.on('timeupdate', (t) => {
      if (active) setCurrentTime(t);
    });
    ws.on('seeking', (t) => {
      if (active) setCurrentTime(t);
    });
    ws.on('error', (err) => {
      if (!active) return;
      debug.error('Inline waveform error', err);
      setError(err instanceof Error ? err.message : String(err));
      setIsLoading(false);
    });

    wavesurferRef.current = ws;

    ws.load(audioUrl).catch((err) => {
      if (!active) return;
      debug.error('Inline waveform load failed', err);
      setError(err instanceof Error ? err.message : String(err));
      setIsLoading(false);
    });

    return () => {
      active = false;
      try {
        const media = ws.getMediaElement() as
          | (HTMLMediaElement & { getGainNode?: () => GainNode })
          | null;
        const context = media?.getGainNode?.()?.context as AudioContext | undefined;
        ws.destroy();
        if (context && context.state !== 'closed') {
          void context
            .close?.()
            .catch((err) => debug.error('Inline audio context close failed', err));
        }
      } catch (err) {
        debug.error('Failed to destroy inline waveform', err);
      }
      if (wavesurferRef.current === ws) wavesurferRef.current = null;
    };
  }, [audioUrl]);

  const handlePlayPause = () => {
    const ws = wavesurferRef.current;
    if (!ws || isLoading) return;
    if (ws.isPlaying()) {
      ws.pause();
    } else {
      const media = ws.getMediaElement() as
        | (HTMLMediaElement & { getGainNode?: () => GainNode })
        | null;
      const context = media?.getGainNode?.()?.context as AudioContext | undefined;
      const resumePromise =
        context && context.state !== 'running' && context.state !== 'closed'
          ? context.resume().catch((err) => debug.error('Inline audio context resume failed', err))
          : Promise.resolve();
      void resumePromise.then(() => {
        if (wavesurferRef.current !== ws) return;
        ws.play().catch((err) => {
          if (wavesurferRef.current !== ws) return;
          debug.error('Inline play failed', err);
          setError(err instanceof Error ? err.message : String(err));
        });
      });
    }
  };

  const displayMs =
    duration > 0
      ? Math.round((isPlaying || currentTime > 0 ? currentTime : duration) * 1000)
      : (fallbackDurationMs ?? 0);

  return (
    <div className={cn('flex items-center gap-4', className)}>
      <Button
        size="icon"
        variant="outline"
        className="h-10 w-10 rounded-full shrink-0"
        onClick={handlePlayPause}
        disabled={isLoading || !!error}
        aria-label={isPlaying ? 'Pause' : 'Play'}
      >
        {isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : isPlaying ? (
          <Pause className="h-4 w-4 fill-current" />
        ) : (
          <Play className="h-4 w-4 ml-0.5 fill-current" />
        )}
      </Button>
      <div ref={waveformRef} className="flex-1 min-w-0 h-10 select-none" />
      <span className="text-xs tabular-nums text-muted-foreground font-medium shrink-0">
        {error ? '—' : formatDuration(displayMs)}
      </span>
    </div>
  );
}
