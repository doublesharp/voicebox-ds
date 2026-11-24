import { ArrowLeft } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { useEffectsStore } from '@/stores/effectsStore';
import { EffectsDetail } from './EffectsDetail';
import { EffectsList } from './EffectsList';

export function EffectsTab() {
  const { t } = useTranslation();
  const [showDetail, setShowDetail] = useState(false);
  const selected = useEffectsStore((state) => !!state.selectedPresetId || state.isCreatingNew);
  const detailOpen = showDetail && selected;
  const back = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (detailOpen && back.current?.getClientRects().length) back.current.focus();
  }, [detailOpen]);

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <div
        ref={list}
        className={cn(
          'min-h-0 min-w-0 flex-1 md:w-[260px] md:flex-none lg:w-[300px]',
          detailOpen && 'max-md:hidden',
        )}
      >
        <EffectsList onOpenPreset={() => setShowDetail(true)} />
      </div>
      <div
        className={cn(
          'flex min-h-0 min-w-0 flex-1 flex-col md:pl-5',
          !detailOpen && 'max-md:hidden',
        )}
      >
        <Button
          ref={back}
          type="button"
          variant="ghost"
          size="sm"
          className="mb-1 shrink-0 self-start px-2 md:hidden"
          onClick={() => {
            setShowDetail(false);
            requestAnimationFrame(() => list.current?.querySelector('button')?.focus());
          }}
        >
          <ArrowLeft className="h-4 w-4" />
          {t('effects.back', { defaultValue: 'Back to presets' })}
        </Button>
        <EffectsDetail />
      </div>
    </div>
  );
}
