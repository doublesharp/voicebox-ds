import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api/client';
import type { GenerationRequest } from '@/lib/api/types';
import { requireCurrentServer, type ServerScope } from '@/lib/serverScope';

export function useGeneration() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ _serverScope, ...data }: GenerationRequest & { _serverScope?: ServerScope }) => {
      requireCurrentServer(_serverScope);
      return apiClient.generateSpeech(data);
    },
    onSuccess: () => {
      // Invalidate history to show new generation
      queryClient.invalidateQueries({ queryKey: ['history'] });
    },
  });
}
