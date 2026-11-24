import { useQuery } from '@tanstack/react-query';
import { Loader2, Plus, Sparkles, Wand2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  ListPane,
  ListPaneActions,
  ListPaneHeader,
  ListPaneScroll,
  ListPaneTitle,
  ListPaneTitleRow,
} from '@/components/ListPane';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api/client';
import type { EffectPresetResponse } from '@/lib/api/types';
import { cn } from '@/lib/utils/cn';
import { useEffectsStore } from '@/stores/effectsStore';

export function EffectsList({ onOpenPreset }: { onOpenPreset?: () => void }) {
  const { t } = useTranslation();
  const selectedPresetId = useEffectsStore((s) => s.selectedPresetId);
  const setSelectedPresetId = useEffectsStore((s) => s.setSelectedPresetId);
  const setWorkingChain = useEffectsStore((s) => s.setWorkingChain);
  const setIsCreatingNew = useEffectsStore((s) => s.setIsCreatingNew);
  const isCreatingNew = useEffectsStore((s) => s.isCreatingNew);

  const {
    data: presets,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['effect-presets'],
    queryFn: () => apiClient.listEffectPresets(),
    staleTime: 30_000,
  });

  const builtIn = presets?.filter((p) => p.is_builtin) ?? [];
  const userPresets = presets?.filter((p) => !p.is_builtin) ?? [];

  function handleSelect(preset: EffectPresetResponse) {
    if (selectedPresetId !== preset.id || isCreatingNew) {
      setSelectedPresetId(preset.id);
      setWorkingChain(preset.effects_chain);
    }
    onOpenPreset?.();
  }

  function handleCreateNew() {
    if (!isCreatingNew) {
      setIsCreatingNew(true);
      setWorkingChain([]);
    }
    onOpenPreset?.();
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error && !presets) {
    return (
      <div className="p-4 space-y-3">
        <p role="alert" className="text-sm text-destructive">
          {error.message}
        </p>
        <Button onClick={() => void refetch()}>
          {t('common.retry', { defaultValue: 'Retry' })}
        </Button>
      </div>
    );
  }

  return (
    <ListPane>
      <ListPaneHeader className="relative shrink-0 border-b border-border/60 pb-3">
        <ListPaneTitleRow className="flex-wrap gap-2 mb-0">
          <ListPaneTitle className="px-0 leading-8">{t('effects.title')}</ListPaneTitle>
          <ListPaneActions>
            <Button onClick={handleCreateNew} size="sm">
              <Plus className="h-4 w-4" />
              {t('effects.newPreset')}
            </Button>
          </ListPaneActions>
        </ListPaneTitleRow>
      </ListPaneHeader>

      <ListPaneScroll className="pt-3">
        <div className="space-y-4 px-4 pb-4 [.app-shell[data-desktop=true]_&]:px-6">
          {builtIn.length > 0 && (
            <div>
              <div className="text-[11px] text-muted-foreground font-medium uppercase tracking-wider mb-2 px-1">
                {t('effects.sections.builtin')}
              </div>
              <div className="space-y-0.5">
                {builtIn.map((preset) => (
                  <PresetCard
                    key={preset.id}
                    preset={preset}
                    isSelected={selectedPresetId === preset.id && !isCreatingNew}
                    onSelect={() => handleSelect(preset)}
                  />
                ))}
              </div>
            </div>
          )}

          {userPresets.length > 0 && (
            <div>
              <div className="text-[11px] text-muted-foreground font-medium uppercase tracking-wider mb-2 px-1">
                {t('effects.sections.custom')}
              </div>
              <div className="space-y-0.5">
                {userPresets.map((preset) => (
                  <PresetCard
                    key={preset.id}
                    preset={preset}
                    isSelected={selectedPresetId === preset.id && !isCreatingNew}
                    onSelect={() => handleSelect(preset)}
                  />
                ))}
              </div>
            </div>
          )}

          {isCreatingNew && (
            <div>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md border border-accent/30 bg-accent/8 px-2.5 py-2 text-left"
                onClick={onOpenPreset}
              >
                <Sparkles className="h-4 w-4 text-accent" />
                <span className="text-sm font-medium">{t('effects.unsaved.title')}</span>
              </button>
            </div>
          )}
        </div>
      </ListPaneScroll>
    </ListPane>
  );
}

function PresetCard({
  preset,
  isSelected,
  onSelect,
}: {
  preset: EffectPresetResponse;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const effectCount = preset.effects_chain.length;
  const name = preset.is_builtin
    ? t(`effects.builtinPresets.${preset.name}.name`, { defaultValue: preset.name })
    : preset.name;
  const description = preset.is_builtin
    ? t(`effects.builtinPresets.${preset.name}.description`, {
        defaultValue: preset.description ?? '',
      })
    : preset.description;

  return (
    <button
      type="button"
      className={cn(
        'grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 rounded-md border px-2.5 py-2 text-left transition-colors',
        isSelected
          ? 'border-accent/30 bg-accent/8'
          : 'border-transparent hover:bg-muted/50',
      )}
      aria-pressed={isSelected}
      onClick={onSelect}
    >
      <Wand2
        aria-hidden="true"
        className={cn('size-3.5', isSelected ? 'text-accent' : 'text-muted-foreground')}
      />
      <span className="truncate text-sm font-medium leading-5">{name}</span>
      {description && (
        <p className="col-start-2 col-end-4 row-start-2 truncate text-xs text-muted-foreground">
          {description}
        </p>
      )}
      <span className="col-start-3 row-start-1 whitespace-nowrap text-[11px] text-muted-foreground">
        {t('effects.effectCount', { count: effectCount })}
      </span>
      <span
        className={cn(
          'col-start-2 col-end-4 row-start-2 truncate text-xs text-muted-foreground empty:hidden',
          description && 'sr-only',
        )}
      >
        {preset.effects_chain
          .filter((e) => e.enabled)
          .map((e) => t(`effects.types.${e.type}.label`, { defaultValue: e.type }))
          .join(' → ')}
      </span>
    </button>
  );
}
