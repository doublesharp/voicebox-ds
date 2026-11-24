import { SlidersHorizontal } from 'lucide-react';
import { useId } from 'react';
import { type UseFormReturn, useFormState, useWatch } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { GenerationFormValues } from '@/lib/hooks/useGenerationForm';

export function SpeechSettings({ form }: { form: UseFormReturn<GenerationFormValues> }) {
  const id = useId();
  const { errors } = useFormState({
    control: form.control,
    name: ['chatterboxCfgWeight', 'chatterboxExaggeration'],
  });
  const [rate, engine, temperature, guidance, expression] = useWatch({
    control: form.control,
    name: [
      'speed',
      'engine',
      'chatterboxTemperature',
      'chatterboxCfgWeight',
      'chatterboxExaggeration',
    ],
  });
  const speed = rate ?? 1;
  const isChatterbox = engine === 'chatterbox';
  const deliveryAdjusted =
    isChatterbox && [temperature, guidance, expression].some((value) => value !== undefined);
  const speedLabel = `${speed.toFixed(2)}×`;

  function reset() {
    form.setValue('speed', 1, { shouldDirty: true });
    form.setValue('chatterboxTemperature', undefined, { shouldDirty: true });
    form.setValue('chatterboxCfgWeight', undefined, { shouldDirty: true });
    form.setValue('chatterboxExaggeration', undefined, { shouldDirty: true });
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="h-8 shrink-0 gap-1.5 rounded-full bg-card px-3 text-xs hover:bg-background/50"
          aria-label={`Speech settings, speed ${speed.toFixed(2)} times${deliveryAdjusted ? ', delivery adjusted' : ''}`}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
          Speech {speed !== 1 && <span className="tabular-nums">{speedLabel}</span>}
          {deliveryAdjusted && (
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="max-h-[min(70vh,28rem)] w-[min(20rem,calc(100vw-2rem))] space-y-5 overflow-y-auto rounded-xl"
        aria-labelledby={`${id}-title`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id={`${id}-title`} className="text-sm font-medium">
            Speech settings
          </h3>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => {
                form.setValue('speed', 0.85, { shouldDirty: true });
                if (isChatterbox) {
                  form.setValue('chatterboxCfgWeight', 0.3, { shouldDirty: true });
                }
              }}
            >
              Relaxed
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={reset}
            >
              Reset
            </Button>
          </div>
        </div>
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor={`${id}-speed`}>Speaking speed</Label>
            <span className="text-sm tabular-nums">{speedLabel}</span>
          </div>
          <input
            id={`${id}-speed`}
            type="range"
            min={0.75}
            max={1.25}
            step={0.05}
            value={speed}
            aria-valuetext={`${speed.toFixed(2)} times normal speed`}
            className="h-5 w-full accent-primary"
            onChange={(event) => {
              form.setValue('speed', Number(event.target.value), { shouldDirty: true });
            }}
          />
          <div className="flex justify-between text-xs text-muted-foreground" aria-hidden="true">
            <span>Slower</span>
            <span>Faster</span>
          </div>
        </div>
        {isChatterbox && (
          <details className="space-y-3 border-t pt-4">
            <summary className="cursor-pointer text-xs font-medium">Advanced delivery</summary>
            <div className="space-y-2">
              <Label htmlFor={`${id}-variation`}>Delivery variation</Label>
              <Select
                value={temperature === undefined ? 'default' : String(temperature)}
                onValueChange={(value) => {
                  form.setValue(
                    'chatterboxTemperature',
                    value === 'default' ? undefined : Number(value),
                    {
                      shouldDirty: true,
                    },
                  );
                }}
              >
                <SelectTrigger id={`${id}-variation`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">Model default</SelectItem>
                  <SelectItem value="0.6">Steadier</SelectItem>
                  <SelectItem value="0.8">Natural</SelectItem>
                  <SelectItem value="1">More varied</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3 pt-2">
              <div className="space-y-2">
                <Label htmlFor={`${id}-guidance`} className="text-xs">
                  Voice guidance
                </Label>
                <Input
                  id={`${id}-guidance`}
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  placeholder="Model default"
                  value={guidance ?? ''}
                  aria-invalid={!!errors.chatterboxCfgWeight}
                  aria-describedby={`${id}-guidance-error`}
                  onChange={(event) =>
                    form.setValue(
                      'chatterboxCfgWeight',
                      event.target.value === '' ? undefined : Number(event.target.value),
                      { shouldDirty: true, shouldValidate: true },
                    )
                  }
                />
                {errors.chatterboxCfgWeight && (
                  <p id={`${id}-guidance-error`} role="alert" className="text-xs text-destructive">
                    {errors.chatterboxCfgWeight.message}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${id}-expression`} className="text-xs">
                  Expression
                </Label>
                <Input
                  id={`${id}-expression`}
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  placeholder="Model default"
                  value={expression ?? ''}
                  aria-invalid={!!errors.chatterboxExaggeration}
                  aria-describedby={`${id}-expression-error`}
                  onChange={(event) =>
                    form.setValue(
                      'chatterboxExaggeration',
                      event.target.value === '' ? undefined : Number(event.target.value),
                      { shouldDirty: true, shouldValidate: true },
                    )
                  }
                />
                {errors.chatterboxExaggeration && (
                  <p
                    id={`${id}-expression-error`}
                    role="alert"
                    className="text-xs text-destructive"
                  >
                    {errors.chatterboxExaggeration.message}
                  </p>
                )}
              </div>
            </div>
          </details>
        )}
      </PopoverContent>
    </Popover>
  );
}
