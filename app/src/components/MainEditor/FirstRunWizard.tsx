import { ArrowRight, AudioLines, Check, Loader2, Mic, Play, Upload } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api/client';
import { useGenerationDetail } from '@/lib/hooks/useHistory';
import { isCurrentServer, type ServerScope } from '@/lib/serverScope';
import { cn } from '@/lib/utils/cn';
import { usePlayerStore } from '@/stores/playerStore';

export interface FirstRunAttempt {
  scope: ServerScope;
  profileId?: string;
  generationId?: string;
  failed?: boolean;
  finished?: boolean;
}

const waveform = [
  11, 20, 29, 25, 44, 54, 33, 69, 41, 85, 57, 93, 63, 100, 82, 49, 60, 35, 52, 28, 17, 10,
];

interface FirstRunWizardProps {
  attempt: FirstRunAttempt | null;
  voiceName: string;
  sampleText: string;
  onTryVoice: (retryGenerationId?: string) => void;
  onCreateVoice: () => void;
  onImportVoice: () => void;
  onBack: () => void;
  onFinish: () => void;
}

export function FirstRunWizard({
  attempt,
  voiceName,
  sampleText,
  onTryVoice,
  onCreateVoice,
  onImportVoice,
  onBack,
  onFinish,
}: FirstRunWizardProps) {
  const { t } = useTranslation();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const isSampleStep = attempt !== null;
  const currentStep = isSampleStep ? 1 : 0;
  const steps = [t('main.starter.chooseStep'), t('main.starter.sampleStep')];
  const take = useGenerationDetail(attempt?.generationId ?? '', attempt?.scope);
  const failed = attempt?.failed || take.isError || take.data?.status === 'failed';
  const ready = !failed && take.data?.status === 'completed' ? take.data : undefined;

  useEffect(() => {
    if (isSampleStep) headingRef.current?.focus();
  }, [isSampleStep]);

  function playSample() {
    if (!ready || !attempt || !isCurrentServer(attempt.scope)) return;
    const player = usePlayerStore.getState();
    const audioUrl = apiClient.getAudioUrl(ready.id);
    if (player.audioId === ready.id && player.audioUrl === audioUrl) {
      player.restartCurrentAudio();
    } else {
      player.setAudioWithAutoPlay(audioUrl, ready.id, ready.profile_id, sampleText);
    }
  }

  function retrySample() {
    headingRef.current?.focus();
    if (take.isError && !attempt?.failed) {
      void take.refetch();
    } else {
      onTryVoice(attempt?.generationId);
    }
  }

  return (
    <section
      aria-labelledby="first-run-heading"
      className="@container mx-auto flex min-h-full w-full max-w-3xl flex-col py-4 sm:justify-center sm:py-8"
    >
      <ol aria-label={t('main.starter.stepsLabel')} className="mb-4 grid grid-cols-2 gap-3 sm:mb-5">
        {steps.map((step, index) => (
          <li
            key={step}
            aria-current={index === currentStep ? 'step' : undefined}
            className={cn(
              'flex items-center gap-2 border-b-2 pb-2.5 text-xs font-medium sm:text-sm',
              index <= currentStep
                ? 'border-accent text-foreground'
                : 'border-border text-muted-foreground',
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'grid size-6 shrink-0 place-items-center rounded-full text-xs',
                index === currentStep ? 'bg-accent text-accent-foreground' : 'bg-muted',
              )}
            >
              {index < currentStep ? <Check className="size-3.5 text-accent" /> : index + 1}
            </span>
            {step}
          </li>
        ))}
      </ol>

      <div className="grid min-w-0 items-center gap-4 rounded-xl border border-border/70 bg-card p-4 shadow-xs @md:gap-6 @md:p-6 @min-[38rem]:grid-cols-[minmax(0,1fr)_minmax(0,0.95fr)]">
        <div className="min-w-0">
          <h1
            id="first-run-heading"
            ref={headingRef}
            tabIndex={-1}
            className="text-2xl leading-tight font-semibold tracking-tight outline-none @md:text-3xl"
          >
            {t(isSampleStep ? 'main.starter.sampleHeading' : 'main.starter.chooseHeading')}
          </h1>
          {isSampleStep ? (
            <p
              role={failed ? 'alert' : 'status'}
              className={cn(
                'mt-2 flex items-center gap-2 text-sm',
                failed ? 'text-destructive' : 'text-muted-foreground',
              )}
            >
              {!ready && !failed && (
                <Loader2 aria-hidden="true" className="size-4 shrink-0 motion-safe:animate-spin" />
              )}
              {t(
                failed
                  ? 'main.starter.failed'
                  : ready
                    ? 'main.starter.ready'
                    : 'main.starter.preparing',
              )}
            </p>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground sm:text-base">
              {t('main.starter.chooseDescription')}
            </p>
          )}

          <div className="mt-4 flex flex-wrap gap-2 sm:mt-6">
            {!isSampleStep && (
              <Button size="lg" onClick={() => onTryVoice()}>
                {t('main.starter.action')}
                <ArrowRight aria-hidden="true" className="size-4" />
              </Button>
            )}
            {ready && (
              <Button onClick={playSample}>
                <Play aria-hidden="true" className="size-4" />
                {t('main.starter.play')}
              </Button>
            )}
            {isSampleStep && failed && <Button onClick={retrySample}>{t('common.retry')}</Button>}
            {attempt?.profileId && (attempt.generationId || failed) && (
              <Button variant="outline" onClick={onFinish}>
                {t('main.starter.finish')}
                <ArrowRight aria-hidden="true" className="size-4" />
              </Button>
            )}
            {isSampleStep && failed && !attempt?.profileId && (
              <Button variant="outline" onClick={onBack}>
                {t('common.back')}
              </Button>
            )}
          </div>
        </div>

        <div className="min-w-0 rounded-lg border border-accent/15 bg-accent/5 p-3.5 sm:p-5">
          <div className="flex items-center gap-2.5">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent">
              <AudioLines aria-hidden="true" className="size-4" />
            </span>
            <div>
              <p className="text-sm font-medium">{voiceName}</p>
              <p className="text-xs text-muted-foreground">{t('main.starter.voiceDescription')}</p>
            </div>
          </div>
          <div
            aria-hidden="true"
            className="my-3 flex h-8 items-center justify-center gap-1 sm:my-4 sm:h-12 sm:gap-1.5"
          >
            {waveform.map((height) => (
              <span
                key={height}
                style={{ height: `${height}%` }}
                className="min-w-0 max-w-2 flex-1 rounded-full bg-linear-to-t from-accent/40 to-accent/80"
              />
            ))}
          </div>
          <p
            lang="en"
            className="border-t border-accent/15 pt-2.5 text-sm leading-snug text-foreground/85 sm:pt-3"
          >
            {sampleText}
          </p>
        </div>
      </div>

      {!isSampleStep && (
        <div className="mt-3 grid gap-2 sm:mt-4 sm:grid-cols-2 sm:gap-3">
          <Button
            variant="outline"
            onClick={onCreateVoice}
            className="h-auto min-h-14 justify-start gap-3 rounded-xl bg-card px-3 py-2.5 text-left whitespace-normal sm:px-4"
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent">
              <Mic aria-hidden="true" className="size-4" />
            </span>
            <span>
              <span className="block">{t('main.createVoice')}</span>
              <span className="block text-xs font-normal text-muted-foreground">
                {t('main.starter.createDescription')}
              </span>
            </span>
          </Button>
          <Button
            variant="outline"
            onClick={onImportVoice}
            className="h-auto min-h-14 justify-start gap-3 rounded-xl bg-card px-3 py-2.5 text-left whitespace-normal sm:px-4"
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent">
              <Upload aria-hidden="true" className="size-4" />
            </span>
            <span>
              <span className="block">{t('main.importVoice')}</span>
              <span className="block text-xs font-normal text-muted-foreground">
                {t('main.starter.importDescription')}
              </span>
            </span>
          </Button>
        </div>
      )}
    </section>
  );
}
