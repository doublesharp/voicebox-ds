import { isTauri } from '@tauri-apps/api/core';
import { cn } from '@/lib/utils/cn';

export function TitleBarDragRegion({ className }: { className?: string }) {
  if (!isTauri() || navigator.userAgent.includes('Windows')) return null;

  return (
    <div data-tauri-drag-region className={cn('fixed inset-x-0 top-0 z-[9999] h-12', className)} />
  );
}
