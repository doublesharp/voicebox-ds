import { useEffect, useRef } from 'react';
import { Progress } from '@/components/ui/progress';
import { useToast } from '@/components/ui/use-toast';
import type { ModelProgress } from '@/lib/api/types';
import { useServerStore } from '@/stores/serverStore';

interface UseModelDownloadToastOptions {
  modelName: string;
  displayName: string;
  enabled?: boolean;
  includeTerminalSnapshot?: boolean;
  onComplete?: () => void;
  onError?: (error: string) => void;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), sizes.length - 1);
  return `${(bytes / 1024 ** index).toFixed(1)} ${sizes[index]}`;
}

function downloadStatus(progress: ModelProgress) {
  const hasTotal = progress.total > 0;
  const stage = progress.status === 'extracting' ? 'Extracting' : 'Downloading';
  const summary = hasTotal
    ? `${stage} · ${progress.progress.toFixed(1).replace(/\.0$/, '')}%`
    : `${stage}…`;

  return (
    <div className="space-y-1 text-xs">
      {progress.filename || hasTotal ? (
        <details>
          <summary className="cursor-pointer select-none rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-ring">
            {summary}
          </summary>
          <div className="mt-1 space-y-1 break-all">
            {progress.filename && <div>{progress.filename}</div>}
            {hasTotal && (
              <div className="text-muted-foreground">
                {`${formatBytes(progress.current)} / ${formatBytes(progress.total)}`}
              </div>
            )}
          </div>
        </details>
      ) : (
        <div className="text-muted-foreground">{summary}</div>
      )}
      {hasTotal && <Progress value={progress.progress} className="h-1" aria-hidden="true" />}
    </div>
  );
}

/** Track a model download and show its progress in a compact notification. */
export function useModelDownloadToast({
  modelName,
  displayName,
  enabled = false,
  includeTerminalSnapshot = false,
  onComplete,
  onError,
}: UseModelDownloadToastOptions) {
  const { toast } = useToast();
  const serverUrl = useServerStore((state) => state.serverUrl);
  const serverRevision = useServerStore((state) => state.serverRevision);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!enabled || !serverUrl || !modelName) return;

    const notification = toast({
      title: displayName,
      description: <span className="text-xs text-muted-foreground">Connecting to download…</span>,
      className: 'w-64 max-w-full self-end px-3 py-2 pr-9 shadow-md [&_[toast-close]]:opacity-100',
      type: 'background',
      duration: Infinity,
    });
    const eventSource = new EventSource(
      `${serverUrl}/models/progress/${modelName}${includeTerminalSnapshot ? '?include_terminal=true' : ''}`,
    );
    eventSourceRef.current = eventSource;
    let active = true;
    const isCurrent = () => {
      const current = useServerStore.getState();
      return active && current.serverUrl === serverUrl && current.serverRevision === serverRevision;
    };
    const close = () => {
      active = false;
      eventSource.close();
      if (eventSourceRef.current === eventSource) eventSourceRef.current = null;
    };
    const finish = (description: string, duration: number, variant?: 'destructive') => {
      close();
      notification.update({ id: notification.id, description, duration, variant });
    };

    eventSource.onmessage = (event) => {
      if (!isCurrent()) return;
      try {
        const progress = JSON.parse(event.data) as ModelProgress;
        // Byte transfer can reach 100% before extraction or model loading.
        if (progress.status === 'complete') {
          finish('Download complete', 3000);
          onComplete?.();
        } else if (progress.status === 'error') {
          finish('Download failed. See Problems on the Models page.', 5000);
          onError?.(progress.error || 'Unknown error');
        } else {
          notification.update({
            id: notification.id,
            description: downloadStatus(progress),
          });
        }
      } catch (error) {
        console.error('Error processing model download progress:', error);
      }
    };

    eventSource.onerror = () => {
      // EventSource reconnects automatically while in CONNECTING state.
      if (!isCurrent() || eventSource.readyState !== EventSource.CLOSED) return;
      finish('Failed to track download progress', 5000, 'destructive');
    };

    return () => {
      if (!active) return;
      close();
      notification.dismiss();
    };
  }, [
    enabled,
    serverUrl,
    serverRevision,
    modelName,
    displayName,
    toast,
    onComplete,
    onError,
    includeTerminalSnapshot,
  ]);

  return { isTracking: enabled && eventSourceRef.current !== null };
}
