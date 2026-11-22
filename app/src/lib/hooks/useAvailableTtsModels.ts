import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useToast } from '@/components/ui/use-toast';
import { apiClient } from '@/lib/api/client';
import type { ModelStatus } from '@/lib/api/types';
import { isCurrentServer, requireCurrentServer, type ServerScope } from '@/lib/serverScope';
import { useServerStore } from '@/stores/serverStore';

/** Discover variants and download state from the connected server. */
export function useAvailableTtsModels() {
  const serverUrl = useServerStore((state) => state.serverUrl);
  const serverRevision = useServerStore((state) => state.serverRevision);
  const scope = { serverUrl, serverRevision };
  const queryKey = ['modelStatus', serverUrl, serverRevision] as const;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const status = useQuery({
    queryKey,
    queryFn: () => {
      requireCurrentServer(scope);
      return apiClient.getModelStatus();
    },
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.models.some((model) => model.downloading) ? 1500 : false,
  });
  const models = useMemo(
    () => new Map(status.data?.models.map((model) => [model.model_name, model])),
    [status.data],
  );

  const download = useMutation({
    mutationFn: ({ model, scope }: { model: ModelStatus; scope: ServerScope }) => {
      requireCurrentServer(scope);
      return apiClient.triggerModelDownload(model.model_name);
    },
    onSuccess: async (_result, { scope }) => {
      if (!isCurrentServer(scope)) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['modelStatus'] }),
        queryClient.invalidateQueries({ queryKey: ['activeTasks'] }),
      ]);
    },
    onError: (error, { scope }) => {
      if (!isCurrentServer(scope)) return;
      toast({
        title: 'Could not start model download',
        description: error.message,
        variant: 'destructive',
      });
      void queryClient.invalidateQueries({ queryKey: ['modelStatus'] });
    },
  });

  return {
    models,
    loading: status.isPending,
    startingDownload: download.isPending && isCurrentServer(download.variables.scope),
    download: (model: ModelStatus) => download.mutate({ model, scope }),
  };
}
