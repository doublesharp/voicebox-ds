import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api/client';
import type { GenerationExportFormat, HistoryQuery } from '@/lib/api/types';
import { isCurrentServer, requireCurrentServer, type ServerScope } from '@/lib/serverScope';
import { usePlatform } from '@/platform/PlatformContext';

export function useHistory(query?: HistoryQuery) {
  return useQuery({
    queryKey: ['history', query],
    queryFn: () => apiClient.listHistory(query),
  });
}

export function generationDetailKey(generationId: string, scope?: ServerScope) {
  return scope ? (['history', generationId, scope] as const) : (['history', generationId] as const);
}

export function useGenerationDetail(generationId: string, scope?: ServerScope) {
  return useQuery({
    queryKey: generationDetailKey(generationId, scope),
    queryFn: () => {
      requireCurrentServer(scope);
      return apiClient.getGeneration(generationId);
    },
    enabled: !!generationId,
  });
}

export function useDeleteGeneration() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: string | { generationId: string; scope: ServerScope }) => {
      if (typeof input === 'string') return apiClient.deleteGeneration(input);
      requireCurrentServer(input.scope);
      return apiClient.deleteGeneration(input.generationId);
    },
    onSuccess: (_data, input) => {
      if (typeof input !== 'string' && !isCurrentServer(input.scope)) return;
      queryClient.invalidateQueries({ queryKey: ['history'] });
    },
  });
}

export function useClearFailedGenerations() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (scope?: ServerScope) => {
      requireCurrentServer(scope);
      return apiClient.clearFailedGenerations();
    },
    onSuccess: (_data, scope) => {
      if (scope && !isCurrentServer(scope)) return;
      queryClient.invalidateQueries({ queryKey: ['history'] });
    },
  });
}

export function useExportGeneration() {
  const platform = usePlatform();

  return useMutation({
    mutationFn: async ({ generationId, text }: { generationId: string; text: string }) => {
      const blob = await apiClient.exportGeneration(generationId);

      // Create safe filename from text. Append a short id so exports of
      // similarly-worded generations don't collide on the same filename
      // (the first 30 chars are frequently identical).
      const safeText = text
        .substring(0, 30)
        .replace(/[^a-z0-9]/gi, '-')
        .toLowerCase();
      const filename = `generation-${safeText}-${generationId.substring(0, 8)}.voicebox.zip`;

      await platform.filesystem.saveFile(filename, blob, [
        {
          name: 'Voicebox Generation',
          extensions: ['zip'],
        },
      ]);

      return blob;
    },
  });
}

export function useExportGenerationAudio() {
  const platform = usePlatform();

  return useMutation({
    mutationFn: async ({
      generationId,
      text,
      format = 'wav',
    }: {
      generationId: string;
      text: string;
      format?: GenerationExportFormat;
    }) => {
      const blob = await apiClient.exportGenerationAudio(generationId, format);

      // Create safe filename from text. Append a short id so exports of
      // similarly-worded generations don't collide on the same filename
      // (the first 30 chars are frequently identical).
      const safeText = text
        .substring(0, 30)
        .replace(/[^a-z0-9]/gi, '-')
        .toLowerCase();
      const filename = `${safeText}-${generationId.substring(0, 8)}.${format}`;

      await platform.filesystem.saveFile(filename, blob, [
        {
          name: 'Audio File',
          extensions: [format],
        },
      ]);

      return blob;
    },
  });
}

export function useImportGeneration() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (file: File) => apiClient.importGeneration(file),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['history'] });
    },
  });
}
