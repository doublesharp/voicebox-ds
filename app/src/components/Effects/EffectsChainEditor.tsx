import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, GripVertical, Plus, Power, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { apiClient } from '@/lib/api/client';
import type { AvailableEffect, EffectConfig, EffectPresetResponse } from '@/lib/api/types';
import { cn } from '@/lib/utils/cn';

// Each effect in the chain gets a stable ID for dnd-kit
interface EffectWithId extends EffectConfig {
  _id: string;
}

let nextId = 0;
function makeId() {
  return `fx-${++nextId}`;
}

interface EffectsChainEditorProps {
  value: EffectConfig[];
  onChange: (chain: EffectConfig[]) => void;
  compact?: boolean;
  showPresets?: boolean;
  excludedTypes?: string[];
  commitParametersOnRelease?: boolean;
  disabled?: boolean;
}

export function EffectsChainEditor({
  value,
  onChange: applyChange,
  compact = false,
  showPresets = true,
  excludedTypes = [],
  commitParametersOnRelease = false,
  disabled = false,
}: EffectsChainEditorProps) {
  const { t } = useTranslation();
  const onChange = useCallback(
    (chain: EffectConfig[]) => {
      if (!disabled) applyChange(chain);
    },
    [applyChange, disabled],
  );
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Maintain stable IDs for each effect across renders.
  // We use a ref to map value items to IDs, rebuilding when length changes.
  const idsRef = useRef<string[]>([]);
  const items: EffectWithId[] = useMemo(() => {
    // Grow ID array if effects were added
    while (idsRef.current.length < value.length) {
      idsRef.current.push(makeId());
    }
    // Shrink if effects were removed
    if (idsRef.current.length > value.length) {
      idsRef.current = idsRef.current.slice(0, value.length);
    }
    return value.map((e, i) => ({ ...e, _id: idsRef.current[i] }));
  }, [value]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const { data: availableEffects } = useQuery({
    queryKey: ['available-effects'],
    queryFn: () => apiClient.getAvailableEffects(),
    staleTime: Infinity,
  });

  const { data: presets } = useQuery({
    queryKey: ['effect-presets'],
    queryFn: () => apiClient.listEffectPresets(),
    staleTime: 30_000,
  });

  const effectsMap = useMemo(() => {
    const m = new Map<string, AvailableEffect>();
    if (availableEffects) {
      for (const e of availableEffects.effects) {
        m.set(e.type, e);
      }
    }
    return m;
  }, [availableEffects]);

  function addEffect(type: string) {
    if (excludedTypes.includes(type)) return;
    const def = effectsMap.get(type);
    if (!def) return;
    const params: Record<string, number> = {};
    for (const [key, p] of Object.entries(def.params)) {
      params[key] = p.default;
    }
    const newEffect: EffectConfig = { type, enabled: true, params };
    const newId = makeId();
    idsRef.current = [...idsRef.current, newId];
    onChange([...value, newEffect]);
    setExpandedId(newId);
  }

  const removeEffect = useCallback(
    (index: number) => {
      const removedId = idsRef.current[index];
      idsRef.current = idsRef.current.filter((_, i) => i !== index);
      onChange(value.filter((_, i) => i !== index));
      if (expandedId === removedId) setExpandedId(null);
    },
    [value, onChange, expandedId],
  );

  const toggleEnabled = useCallback(
    (index: number) => {
      onChange(value.map((e, i) => (i === index ? { ...e, enabled: !e.enabled } : e)));
    },
    [value, onChange],
  );

  const updateParam = useCallback(
    (index: number, paramName: string, paramValue: number) => {
      onChange(
        value.map((e, i) =>
          i === index ? { ...e, params: { ...e.params, [paramName]: paramValue } } : e,
        ),
      );
    },
    [value, onChange],
  );

  function loadPreset(preset: EffectPresetResponse) {
    idsRef.current = preset.effects_chain.map(() => makeId());
    onChange(preset.effects_chain);
    setExpandedId(null);
  }

  function clearAll() {
    idsRef.current = [];
    onChange([]);
    setExpandedId(null);
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = idsRef.current.indexOf(active.id as string);
    const newIndex = idsRef.current.indexOf(over.id as string);
    if (oldIndex === -1 || newIndex === -1) return;

    idsRef.current = arrayMove(idsRef.current, oldIndex, newIndex);
    onChange(arrayMove([...value], oldIndex, newIndex));
  }

  return (
    <div className={cn('space-y-1.5', compact && 'text-sm')}>
      {/* Preset selector row */}
      {showPresets && (
        <div className="flex items-center gap-2">
          <Select
            disabled={disabled}
            onValueChange={(id) => {
              const preset = presets?.find((p) => p.id === id);
              if (preset) loadPreset(preset);
            }}
          >
            <SelectTrigger
              aria-label={t('effects.chain.loadPreset')}
              className="h-9 min-w-0 flex-1 text-xs"
            >
              <SelectValue placeholder={t('effects.chain.loadPreset')} />
            </SelectTrigger>
            <SelectContent>
              {presets?.map((p) => {
                const name = p.is_builtin
                  ? t(`effects.builtinPresets.${p.name}.name`, { defaultValue: p.name })
                  : p.name;
                const description = p.is_builtin
                  ? t(`effects.builtinPresets.${p.name}.description`, {
                      defaultValue: p.description ?? '',
                    })
                  : p.description;
                return (
                  <SelectItem key={p.id} value={p.id}>
                    {name}
                    {description && (
                      <span className="ml-1 text-muted-foreground">- {description}</span>
                    )}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>

          {value.length > 0 && (
            <Button
              disabled={disabled}
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-xs text-muted-foreground"
              onClick={clearAll}
            >
              {t('effects.chain.clear')}
            </Button>
          )}
        </div>
      )}

      {/* Sortable effects chain */}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={items.map((i) => i._id)} strategy={verticalListSortingStrategy}>
          {items.map((effect, index) => (
            <SortableEffectItem
              key={effect._id}
              id={effect._id}
              effect={effect}
              index={index}
              effectDef={effectsMap.get(effect.type)}
              commitParametersOnRelease={commitParametersOnRelease}
              disabled={disabled}
              isExpanded={expandedId === effect._id}
              onToggleExpand={() => setExpandedId(expandedId === effect._id ? null : effect._id)}
              onRemove={() => removeEffect(index)}
              onToggleEnabled={() => toggleEnabled(index)}
              onUpdateParam={(paramName, paramValue) => updateParam(index, paramName, paramValue)}
            />
          ))}
        </SortableContext>
      </DndContext>

      {/* Add effect */}
      {availableEffects && (
        <Select value="" onValueChange={addEffect} disabled={disabled}>
          <SelectTrigger
            aria-label={t('effects.chain.addEffect')}
            className="h-9 border-dashed bg-transparent text-xs text-muted-foreground hover:bg-muted/40"
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            <SelectValue placeholder={t('effects.chain.addEffect')} />
          </SelectTrigger>
          <SelectContent>
            {availableEffects.effects
              .filter((e) => !excludedTypes.includes(e.type))
              .map((e) => (
                <SelectItem key={e.type} value={e.type}>
                  {t(`effects.types.${e.type}.label`, { defaultValue: e.label })}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sortable effect item
// ---------------------------------------------------------------------------

interface SortableEffectItemProps {
  disabled?: boolean;
  id: string;
  effect: EffectConfig;
  index: number;
  effectDef?: AvailableEffect;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onRemove: () => void;
  onToggleEnabled: () => void;
  onUpdateParam: (paramName: string, paramValue: number) => void;
  commitParametersOnRelease?: boolean;
}

function SortableEffectItem({
  id,
  index,
  effect,
  effectDef,
  isExpanded,
  onToggleExpand,
  onRemove,
  onToggleEnabled,
  onUpdateParam,
  commitParametersOnRelease = false,
  disabled = false,
}: SortableEffectItemProps) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : undefined,
  };

  const label = t(`effects.types.${effect.type}.label`, {
    defaultValue: effectDef?.label ?? effect.type,
  });
  const controlClass =
    'grid size-8 shrink-0 place-items-center rounded-md transition-colors enabled:hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:opacity-50';

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        '@container overflow-hidden rounded-lg border',
        effect.enabled ? 'border-border bg-card' : 'border-border/50 bg-muted/30',
        isDragging && 'opacity-80 shadow-lg',
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-1 px-1.5 py-1">
        <button
          type="button"
          aria-label={t('effects.chain.reorder', { defaultValue: 'Reorder effect' })}
          className={cn(controlClass, 'cursor-grab touch-none text-muted-foreground active:cursor-grabbing')}
          {...attributes}
          {...listeners}
          disabled={disabled}
        >
          <GripVertical className="size-4" />
        </button>
        <span
          aria-hidden="true"
          className="grid size-5 shrink-0 place-items-center rounded bg-muted text-[11px] font-medium tabular-nums text-muted-foreground"
        >
          {index + 1}
        </span>
        <button
          type="button"
          aria-expanded={isExpanded}
          aria-label={`${isExpanded ? t('effects.chain.collapse', { defaultValue: 'Collapse' }) : t('effects.chain.expand', { defaultValue: 'Expand' })} ${label}`}
          className={cn(
            'flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left text-xs font-medium transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
            !effect.enabled && 'text-muted-foreground',
          )}
          onClick={onToggleExpand}
        >
          {isExpanded ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{label}</span>
        </button>

        <button
          type="button"
          className={cn(
            controlClass,
            effect.enabled ? 'text-accent' : 'text-muted-foreground hover:text-foreground',
          )}
          onClick={onToggleEnabled}
          disabled={disabled}
          title={effect.enabled ? t('effects.chain.disable') : t('effects.chain.enable')}
        >
          <Power className="h-3.5 w-3.5" />
        </button>

        <button
          type="button"
          className={cn(controlClass, 'text-muted-foreground enabled:hover:text-destructive')}
          onClick={onRemove}
          disabled={disabled}
          title={t('effects.chain.remove')}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Params */}
      {isExpanded && effectDef && (
        <div className="grid gap-x-6 gap-y-3 border-t border-border/70 bg-muted/15 px-3 py-3 @min-[28rem]:grid-cols-2">
          {Object.entries(effectDef.params).map(([paramName, paramDef]) => {
            const currentValue = effect.params[paramName] ?? paramDef.default;
            return (
              <div key={paramName} className="space-y-1 only:col-span-full">
                <div className="flex items-baseline justify-between gap-2">
                  <Label className="text-xs leading-snug text-muted-foreground">
                    {t(`effects.types.${effect.type}.params.${paramName}`, {
                      defaultValue: paramDef.description,
                    })}
                  </Label>
                  <span className="shrink-0 rounded bg-background px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-foreground">
                    {currentValue.toFixed(
                      paramDef.step < 1 ? Math.max(1, -Math.floor(Math.log10(paramDef.step))) : 0,
                    )}
                  </span>
                </div>
                <EffectParameterSlider
                  min={paramDef.min}
                  max={paramDef.max}
                  step={paramDef.step}
                  value={currentValue}
                  commitOnRelease={commitParametersOnRelease}
                  disabled={disabled}
                  onChange={(v) => onUpdateParam(paramName, v)}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function EffectParameterSlider({
  min,
  max,
  step,
  value,
  commitOnRelease,
  disabled,
  onChange,
}: {
  min: number;
  max: number;
  step: number;
  value: number;
  commitOnRelease: boolean;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(value);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Becoming disabled cancels an uncommitted gesture even when the saved value did not change.
  useEffect(() => setDraft(value), [value, disabled]);
  return (
    <Slider
      min={min}
      max={max}
      step={step}
      value={[commitOnRelease ? draft : value]}
      disabled={disabled}
      onValueChange={([next]) => {
        if (!disabled) commitOnRelease ? setDraft(next) : onChange(next);
      }}
      onValueCommit={
        commitOnRelease
          ? ([next]) => {
              if (!disabled) onChange(next);
            }
          : undefined
      }
    />
  );
}
