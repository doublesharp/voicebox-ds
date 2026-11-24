import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiClient } from '@/lib/api/client';
import type { ModelResidencyPolicy, ModelStatus } from '@/lib/api/types';

/** Explicit session controls; mutations never trigger a model download. */
export function ModelResidencyControls({ models }: { models: ModelStatus[] }) {
  const client = useQueryClient();
  const [engineLimit, setEngineLimit] = useState<string | null>(null);
  const [weightBudget, setWeightBudget] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState('');
  const status = useQuery({
    queryKey: ['modelResidency'],
    queryFn: () => apiClient.getModelResidency(),
    refetchInterval: 5000,
    retry: false,
  });
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['modelResidency'] }),
      client.invalidateQueries({ queryKey: ['modelStatus'] }),
    ]);
  };
  const update = useMutation({
    mutationFn: (policy: ModelResidencyPolicy) => apiClient.updateModelResidency(policy),
    onSuccess: async (result) => {
      client.setQueryData(['modelResidency'], result);
      setEngineLimit(null);
      setWeightBudget(null);
      await refresh();
    },
  });
  const warm = useMutation({
    mutationFn: (name: string) => apiClient.prewarmModel(name),
    onSuccess: refresh,
  });
  const eligible = models.filter(
    (model) =>
      model.downloaded &&
      !model.model_name.startsWith('whisper-') &&
      !model.model_name.startsWith('qwen3-'),
  );
  const selected = selectedModel || eligible[0]?.model_name || '';
  const count = engineLimit ?? String(status.data?.policy.max_resident_engines ?? 1);
  const budget = weightBudget ?? String(status.data?.policy.estimated_weight_budget_mb ?? 16384);
  const valid =
    /^\d+$/.test(count) &&
    Number(count) >= 1 &&
    Number(count) <= 4 &&
    /^\d+$/.test(budget) &&
    Number(budget) >= 512 &&
    Number(budget) <= 65536;
  const busy = update.isPending || warm.isPending;
  const error = update.error || warm.error || status.error;
  return (
    <section
      className="space-y-3 border-t border-border/60 px-3 py-3.5"
      aria-label="Model readiness"
    >
      <form
        className="flex flex-wrap items-end gap-x-3 gap-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid)
            update.mutate({
              max_resident_engines: Number(count),
              estimated_weight_budget_mb: Number(budget),
            });
        }}
      >
        <label
          className="min-w-0 flex-1 basis-32 space-y-1 text-xs sm:flex-none"
          htmlFor="resident-engine-limit"
        >
          <span>Loaded speech engines (1–4)</span>
          <Input
            id="resident-engine-limit"
            type="number"
            min={1}
            max={4}
            step={1}
            value={count}
            disabled={busy || !status.data}
            onChange={(event) => setEngineLimit(event.target.value)}
            className="w-full sm:w-36"
          />
        </label>
        <label
          className="min-w-0 flex-1 basis-32 space-y-1 text-xs sm:flex-none"
          htmlFor="resident-weight-budget"
        >
          <span>Estimated weight budget (MB)</span>
          <Input
            id="resident-weight-budget"
            type="number"
            min={512}
            max={65536}
            step={1}
            value={budget}
            disabled={busy || !status.data}
            onChange={(event) => setWeightBudget(event.target.value)}
            className="w-full sm:w-44"
          />
        </label>
        <Button type="submit" variant="outline" disabled={!valid || busy || !status.data}>
          {update.isPending ? 'Applying…' : 'Apply session limits'}
        </Button>
      </form>
      {!valid && (
        <p role="alert" className="text-xs text-destructive">
          Enter 1–4 engines and a whole-number budget from 512 to 65536 MB.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Weight sizes are estimates, not a RAM limit. Settings reset when the server restarts.
      </p>
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2 border-t border-border/60 pt-3">
        <div className="w-full min-w-0 space-y-1 sm:w-auto">
          <label className="block text-xs" htmlFor="prewarm-model">
            Downloaded speech model
          </label>
          <select
            id="prewarm-model"
            value={selected}
            onChange={(event) => setSelectedModel(event.target.value)}
            className="block h-9 w-full max-w-full rounded-md border bg-background px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring sm:w-64"
            disabled={busy || !eligible.length}
          >
            {!eligible.length && <option value="">Download a speech model first</option>}
            {eligible.map((model) => (
              <option key={model.model_name} value={model.model_name}>
                {model.display_name}
              </option>
            ))}
          </select>
        </div>
        <Button
          type="button"
          disabled={busy || !eligible.some((model) => model.model_name === selected)}
          onClick={() => warm.mutate(selected)}
        >
          {warm.isPending ? 'Warming…' : 'Warm model weights'}
        </Button>
      </div>
      {warm.data && (
        <output className="block text-xs">
          {warm.data.mode === 'voice'
            ? 'Selected voice prewarmed.'
            : 'Model weights are warm. Voice preparation starts with the selected profile.'}
        </output>
      )}
      {status.data && (
        <p className="text-xs text-muted-foreground">
          Loaded:{' '}
          {status.data.resident_models.map((model) => model.model_name).join(', ') || 'none'}.
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error instanceof Error ? error.message : 'Model readiness request failed.'}
        </p>
      )}
    </section>
  );
}
