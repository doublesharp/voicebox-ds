import voiceboxLogo from '@/assets/voicebox-ds-icon.png';
import { TitleBarDragRegion } from '@/components/TitleBarDragRegion';
import { APP_BRANDING } from '@/lib/constants/branding';
import { TOP_SAFE_AREA_PADDING } from '@/lib/constants/ui';
import { cn } from '@/lib/utils/cn';
import './StartupScreen.css';

interface StartupScreenProps {
  error: string | null;
  onRetry: () => void;
}

export function StartupScreen({ error, onRetry }: StartupScreenProps) {
  return (
    <div
      className={cn(
        'h-screen min-h-0 bg-background flex flex-col items-center overflow-y-auto',
        TOP_SAFE_AREA_PADDING,
      )}
    >
      <TitleBarDragRegion />
      <main className="my-auto w-full max-w-md shrink-0 px-6 py-12 text-center">
        <img src={voiceboxLogo} alt="" className="mx-auto h-24 w-24 object-contain" />
        <h1 className="mt-7 text-2xl font-medium tracking-tight">{APP_BRANDING.name}</h1>
        {error ? (
          <div className="mt-9 space-y-3">
            <div role="alert" className="space-y-2">
              <p className="text-sm font-medium text-destructive">Voice server unavailable</p>
              <p className="break-words text-sm text-muted-foreground">{error}</p>
            </div>
            <button
              type="button"
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              onClick={onRetry}
            >
              Retry
            </button>
          </div>
        ) : (
          <div className="mt-9">
            <div className="startup-waveform" aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
              <span />
            </div>
            <output className="mt-4 block text-sm text-muted-foreground">
              Connecting to the voice server…
            </output>
          </div>
        )}
      </main>
    </div>
  );
}
