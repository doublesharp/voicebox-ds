import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AudioLines,
  Download,
  FileArchive,
  Loader2,
  MoreHorizontal,
  Pencil,
  Play,
  RotateCcw,
  Square,
  Star,
  Trash2,
  Wand2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { EffectsChainEditor } from '@/components/Effects/EffectsChainEditor';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Hint } from '@/components/ui/Hint';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/components/ui/use-toast';
import { apiClient } from '@/lib/api/client';
import type {
  EffectConfig,
  GenerationExportFormat,
  GenerationVersionResponse,
  HistoryResponse,
} from '@/lib/api/types';
import { BOTTOM_SAFE_AREA_PADDING } from '@/lib/constants/ui';
import {
  useClearFailedGenerations,
  useDeleteGeneration,
  useExportGeneration,
  useExportGenerationAudio,
  useHistory,
  useImportGeneration,
} from '@/lib/hooks/useHistory';
import { cn } from '@/lib/utils/cn';
import { currentServerScope, isCurrentServer, requireCurrentServer, type ServerScope } from '@/lib/serverScope';
import { formatDate, formatDuration, formatEngineName } from '@/lib/utils/format';
import { useGenerationStore } from '@/stores/generationStore';
import { usePlayerStore } from '@/stores/playerStore';
import { useServerStore } from '@/stores/serverStore';
import { HistoryPlaybackState, useHistoryWindow } from './historyWindow';

export function HistoryTable({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const [pageCursor, setPageCursor] = useState<string>();
  const [focusedRow, setFocusedRow] = useState<string | null>(null);
  const [menuRow, setMenuRow] = useState<string | null>(null);
  const [allHistory, setAllHistory] = useState<HistoryResponse[]>([]);
  const [total, setTotal] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [generationToDelete, setGenerationToDelete] = useState<{ id: string; name: string; scope: ServerScope } | null>(
    null,
  );
  const [effectsDialogOpen, setEffectsDialogOpen] = useState(false);
  const [effectsTargetId, setEffectsTargetId] = useState<string | null>(null);
  const [effectsTargetScope, setEffectsTargetScope] = useState<ServerScope | null>(null);
  const [effectsTargetVersions, setEffectsTargetVersions] = useState<GenerationVersionResponse[]>(
    [],
  );
  const [effectsSourceVersionId, setEffectsSourceVersionId] = useState<string | null>(null);
  const [effectsChain, setEffectsChain] = useState<EffectConfig[]>([]);
  const [applyingEffects, setApplyingEffects] = useState(false);
  const [editingVersion, setEditingVersion] = useState<GenerationVersionResponse | null>(null);
  const [versionToDelete, setVersionToDelete] = useState<{ version: GenerationVersionResponse; scope: ServerScope } | null>(null);
  const [deletingVersion, setDeletingVersion] = useState(false);
  const [clearFailedDialogOpen, setClearFailedDialogOpen] = useState(false);
  const [clearFailedScope, setClearFailedScope] = useState<ServerScope | null>(null);
  const versionMutationRef = useRef<number | null>(null);
  const nextVersionMutationRef = useRef(0);
  const serverUrl = useServerStore((state) => state.serverUrl);
  const serverRevision = useServerStore((state) => state.serverRevision);
  const [expandedVersionsId, setExpandedVersionsId] = useState<string | null>(null);
  const [expandedTextIds, setExpandedTextIds] = useState<Set<string>>(() => new Set());
  const toggleExpandedText = (generationId: string) => {
    setExpandedTextIds((prev) => {
      const next = new Set(prev);
      if (next.has(generationId)) {
        next.delete(generationId);
      } else {
        next.add(generationId);
      }
      return next;
    });
  };
  const limit = 20;
  const { toast } = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    versionMutationRef.current = null;
    setApplyingEffects(false);
    setDeletingVersion(false);
    setEffectsDialogOpen(false);
    setEffectsTargetScope(null);
    setVersionToDelete(null);
    setDeleteDialogOpen(false);
    setGenerationToDelete(null);
    setClearFailedDialogOpen(false);
    setClearFailedScope(null);
  }, [serverUrl, serverRevision]);

  const {
    data: historyData,
    isLoading,
    isFetching,
  } = useHistory({
    limit,
    offset: pageCursor ? 0 : page * limit,
    cursor: pageCursor,
    include_total: page === 0,
  });

  const deleteGeneration = useDeleteGeneration();
  const clearFailed = useClearFailedGenerations();
  const exportGeneration = useExportGeneration();
  const exportGenerationAudio = useExportGenerationAudio();
  const importGeneration = useImportGeneration();
  const cancelGeneration = useMutation({
    mutationFn: ({ generationId, scope }: { generationId: string; scope: ServerScope }) => {
      requireCurrentServer(scope);
      return apiClient.cancelGeneration(generationId);
    },
    onSuccess: async (data, { scope }) => {
      if (!isCurrentServer(scope)) return;
      await queryClient.invalidateQueries({ queryKey: ['history'] });
      if (!isCurrentServer(scope)) return;
      toast({
        title: 'Cancelling generation',
        description: data.message,
      });
    },
    onError: (error, { scope }) => {
      if (!isCurrentServer(scope)) return;
      toast({
        title: 'Cancel failed',
        description: error instanceof Error ? error.message : 'Could not cancel generation',
        variant: 'destructive',
      });
    },
  });
  const addPendingGeneration = useGenerationStore((state) => state.addPendingGeneration);
  const setAudioWithAutoPlay = usePlayerStore((state) => state.setAudioWithAutoPlay);
  const restartCurrentAudio = usePlayerStore((state) => state.restartCurrentAudio);
  const isPlayerVisible = !!usePlayerStore((state) => state.audioUrl);

  // Update accumulated history when new data arrives
  useEffect(() => {
    if (historyData?.items) {
      if (typeof historyData.total === 'number') setTotal(historyData.total);
      if (page === 0) {
        // Reset to first page
        setAllHistory(historyData.items);
      } else {
        // A refetch can update rows already accumulated on this page.
        setAllHistory((prev) => {
          const incoming = new Map(historyData.items.map((item) => [item.id, item]));
          const merged = prev.map((item) => incoming.get(item.id) ?? item);
          const existingIds = new Set(prev.map((item) => item.id));
          for (const item of historyData.items) {
            if (!existingIds.has(item.id)) {
              merged.push(item);
              existingIds.add(item.id);
            }
          }
          return merged;
        });
      }
    }
  }, [historyData, page]);

  // Reset to page 0 when deletions, imports, or generation completions occur
  const pendingCount = useGenerationStore((state) => state.pendingGenerationIds.size);
  const prevPendingCountRef = useRef(pendingCount);
  useEffect(() => {
    if (deleteGeneration.isSuccess || importGeneration.isSuccess || clearFailed.isSuccess) {
      setPageCursor(undefined);
      setPage(0);
    }
  }, [deleteGeneration.isSuccess, importGeneration.isSuccess, clearFailed.isSuccess]);

  useEffect(() => {
    // A generation finished (pending count decreased) — scroll back to show it
    if (
      prevPendingCountRef.current > 0 &&
      pendingCount < prevPendingCountRef.current &&
      page !== 0
    ) {
      setPageCursor(undefined);
      setPage(0);
    }
    prevPendingCountRef.current = pendingCount;
  }, [pendingCount, page]);

  const hasMore =
    historyData?.next_cursor === undefined ? allHistory.length < total : !!historyData.next_cursor;

  // Intersection Observer for infinite scroll
  useEffect(() => {
    const loadMoreEl = loadMoreRef.current;
    if (!loadMoreEl || !allHistory.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const target = entries[0];
        if (target.isIntersecting && !isFetching && hasMore) {
          setPageCursor(historyData?.next_cursor ?? undefined);
          setPage((prev) => prev + 1);
        }
      },
      {
        root: embedded ? null : scrollRef.current,
        rootMargin: '100px',
        threshold: 0.1,
      },
    );

    observer.observe(loadMoreEl);
    return () => observer.disconnect();
  }, [isFetching, hasMore, embedded, historyData?.next_cursor, allHistory.length]);

  const handlePlay = (audioId: string, text: string, profileId: string) => {
    const generation = allHistory.find((item) => item.id === audioId);
    const version = generation?.versions?.find((item) => item.is_default);
    const revision = generation?.audio_path;
    const desiredUrl = version
      ? apiClient.getVersionAudioUrl(version.id, version.audio_path)
      : `${apiClient.getAudioUrl(audioId)}${revision ? `?revision=${encodeURIComponent(revision)}` : ''}`;
    // Read at the gesture boundary: rapid A → B → A clicks can precede a
    // React render, and one generation may have several distinct takes.
    const player = usePlayerStore.getState();
    if (player.audioId === audioId && player.audioUrl === desiredUrl) {
      restartCurrentAudio();
    } else {
      setAudioWithAutoPlay(desiredUrl, audioId, profileId, text.substring(0, 50));
    }
  };

  const handleDownloadAudio = (
    generationId: string,
    text: string,
    format: GenerationExportFormat = 'wav',
  ) => {
    exportGenerationAudio.mutate(
      { generationId, text, format },
      {
        onError: (error) => {
          toast({
            title: 'Failed to download audio',
            description: error.message,
            variant: 'destructive',
          });
        },
      },
    );
  };

  const handleExportPackage = (generationId: string, text: string) => {
    exportGeneration.mutate(
      { generationId, text },
      {
        onError: (error) => {
          toast({
            title: 'Failed to export generation',
            description: error.message,
            variant: 'destructive',
          });
        },
      },
    );
  };

  const handleDeleteClick = (generationId: string, profileName: string) => {
    setGenerationToDelete({ id: generationId, name: profileName, scope: currentServerScope() });
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = () => {
    if (generationToDelete && isCurrentServer(generationToDelete.scope)) {
      deleteGeneration.mutate({ generationId: generationToDelete.id, scope: generationToDelete.scope });
      setDeleteDialogOpen(false);
      setGenerationToDelete(null);
    }
  };

  const handleRetry = async (generationId: string) => {
    const scope = currentServerScope();
    try {
      const result = await apiClient.retryGeneration(generationId);
      if (!isCurrentServer(scope)) return;
      addPendingGeneration(result.id);
      queryClient.invalidateQueries({ queryKey: ['history'] });
    } catch (error) {
      if (!isCurrentServer(scope)) return;
      toast({
        title: 'Retry failed',
        description: error instanceof Error ? error.message : 'Could not retry generation',
        variant: 'destructive',
      });
    }
  };

  const handleRegenerate = async (generationId: string) => {
    const scope = currentServerScope();
    try {
      await apiClient.regenerateGeneration(generationId);
      if (!isCurrentServer(scope)) return;
      addPendingGeneration(generationId);
      queryClient.invalidateQueries({ queryKey: ['history'] });
    } catch (error) {
      if (!isCurrentServer(scope)) return;
      toast({
        title: 'Regenerate failed',
        description: error instanceof Error ? error.message : 'Could not regenerate',
        variant: 'destructive',
      });
    }
  };

  const handleToggleFavorite = async (generationId: string) => {
    const scope = currentServerScope();
    try {
      await apiClient.toggleFavorite(generationId);
      if (!isCurrentServer(scope)) return;
      queryClient.invalidateQueries({ queryKey: ['history'] });
    } catch (error) {
      if (!isCurrentServer(scope)) return;
      toast({
        title: 'Failed to update favorite',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleApplyEffects = (generationId: string) => {
    const gen = allHistory.find((g) => g.id === generationId);
    const versions = gen?.versions ?? [];
    setEffectsTargetId(generationId);
    setEffectsTargetScope(currentServerScope());
    setEffectsTargetVersions(versions);
    // Default to clean/original version (no effects chain)
    const cleanVersion = versions.find((v) => !v.effects_chain || v.effects_chain.length === 0);
    setEffectsSourceVersionId(cleanVersion?.id ?? null);
    setEffectsChain([]);
    setEditingVersion(null);
    setEffectsDialogOpen(true);
  };

  const handleEditVersion = (generationId: string, version: GenerationVersionResponse) => {
    setEffectsTargetId(generationId);
    setEffectsTargetScope(currentServerScope());
    setEditingVersion(version);
    setEffectsChain(structuredClone(version.effects_chain ?? []));
    setEffectsDialogOpen(true);
  };

  const updateVersions = (generationId: string, versions: GenerationVersionResponse[]) => {
    const active = versions.find((version) => version.is_default);
    // Update accumulated pages too: invalidating only the current page leaves
    // versions on earlier pages stale until History is reopened.
    setAllHistory((previous) =>
      previous.map((generation) =>
        generation.id === generationId
          ? { ...generation, versions, audio_path: active?.audio_path ?? generation.audio_path }
          : generation,
      ),
    );
    queryClient.invalidateQueries({ queryKey: ['history'] });
    queryClient.invalidateQueries({ queryKey: ['stories'] });
  };

  const handleDeleteVersionConfirm = async () => {
    if (!versionToDelete || versionMutationRef.current) return;
    const { version: target, scope } = versionToDelete;
    if (!isCurrentServer(scope)) return;
    const request = ++nextVersionMutationRef.current;
    versionMutationRef.current = request;
    setDeletingVersion(true);
    const player = usePlayerStore.getState();
    const wasSelected = player.audioId === target.generation_id;
    // Release the media file before deletion, particularly on Windows.
    if (wasSelected) player.reset();
    const releasedSourceGeneration = usePlayerStore.getState().sourceGeneration;
    const mayRestorePlayer = () => {
      const current = usePlayerStore.getState();
      return (
        wasSelected && !current.audioId && current.sourceGeneration === releasedSourceGeneration
      );
    };
    try {
      const versions = await apiClient.deleteGenerationVersion(target.generation_id, target.id);
      if (!isCurrentServer(scope)) return;
      updateVersions(target.generation_id, versions);
      const active = versions.find((version) => version.is_default);
      if (active && mayRestorePlayer()) {
        usePlayerStore
          .getState()
          .setAudio(
            apiClient.getVersionAudioUrl(active.id, active.audio_path),
            target.generation_id,
            player.profileId,
            player.title ?? undefined,
          );
      }
      setVersionToDelete(null);
      toast({ title: t('history.versions.deleted') });
    } catch (error) {
      if (!isCurrentServer(scope)) return;
      if (player.audioUrl && mayRestorePlayer()) {
        usePlayerStore
          .getState()
          .setAudio(
            player.audioUrl,
            target.generation_id,
            player.profileId,
            player.title ?? undefined,
          );
      }
      toast({
        title: t('history.versions.deleteFailed'),
        description: error instanceof Error ? error.message : t('common.unknownError'),
        variant: 'destructive',
      });
    } finally {
      if (versionMutationRef.current === request) {
        versionMutationRef.current = null;
        setDeletingVersion(false);
      }
    }
  };

  const handleApplyEffectsConfirm = async () => {
    if (
      !effectsTargetId ||
      !effectsTargetScope ||
      (!editingVersion && effectsChain.length === 0) ||
      versionMutationRef.current
    )
      return;
    const scope = effectsTargetScope;
    if (!isCurrentServer(scope)) return;
    const request = ++nextVersionMutationRef.current;
    versionMutationRef.current = request;
    setApplyingEffects(true);
    try {
      const newVersion = editingVersion
        ? await apiClient.updateGenerationVersion(effectsTargetId, editingVersion.id, {
            effects_chain: effectsChain,
          })
        : await apiClient.applyEffectsToGeneration(effectsTargetId, {
            effects_chain: effectsChain,
            source_version_id: effectsSourceVersionId ?? undefined,
            set_as_default: true,
          });
      if (!isCurrentServer(scope)) return;
      const generation = allHistory.find((item) => item.id === effectsTargetId);
      const versions = generation?.versions ?? [];
      updateVersions(
        effectsTargetId,
        editingVersion
          ? versions.map((version) => (version.id === newVersion.id ? newVersion : version))
          : [...versions.map((version) => ({ ...version, is_default: false })), newVersion],
      );

      // If the player is currently on this generation, reload with the new version audio
      const player = usePlayerStore.getState();
      const isEditedAudio = player.audioUrl?.includes(`/audio/version/${editingVersion?.id}`);
      if (
        player.audioId === effectsTargetId &&
        (!editingVersion || newVersion.is_default || isEditedAudio)
      ) {
        const gen = allHistory.find((g) => g.id === effectsTargetId);
        if (gen) {
          const versionUrl = apiClient.getVersionAudioUrl(newVersion.id, newVersion.audio_path);
          const setAudio = player.isPlaying ? player.setAudioWithAutoPlay : player.setAudio;
          setAudio(versionUrl, effectsTargetId, gen.profile_id, gen.text.substring(0, 50));
        }
      }

      setEffectsDialogOpen(false);
      toast({
        title: editingVersion ? t('history.versions.updated') : 'Effects applied',
        description: editingVersion ? undefined : 'A new version has been created.',
      });
    } catch (error) {
      if (!isCurrentServer(scope)) return;
      toast({
        title: editingVersion ? t('history.versions.updateFailed') : 'Failed to apply effects',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      if (versionMutationRef.current === request) {
        versionMutationRef.current = null;
        setApplyingEffects(false);
      }
    }
  };

  const handleSwitchVersion = async (generationId: string, versionId: string) => {
    const scope = currentServerScope();
    try {
      const active = await apiClient.setDefaultVersion(generationId, versionId);
      if (!isCurrentServer(scope)) return;
      setAllHistory((previous) =>
        previous.map((generation) =>
          generation.id === generationId
            ? {
                ...generation,
                audio_path: active.audio_path,
                versions: generation.versions?.map((version) =>
                  version.id === versionId ? active : { ...version, is_default: false },
                ),
              }
            : generation,
        ),
      );
      queryClient.invalidateQueries({ queryKey: ['history'] });
      queryClient.invalidateQueries({ queryKey: ['stories'] });
    } catch (error) {
      if (!isCurrentServer(scope)) return;
      toast({
        title: 'Failed to switch version',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handlePlayVersion = (
    generationId: string,
    versionId: string,
    text: string,
    profileId: string,
  ) => {
    const version = allHistory
      .find((gen) => gen.id === generationId)
      ?.versions?.find((v) => v.id === versionId);
    const audioUrl = apiClient.getVersionAudioUrl(versionId, version?.audio_path);
    setAudioWithAutoPlay(audioUrl, generationId, profileId, text.substring(0, 50));
  };

  const handleImportConfirm = () => {
    if (selectedFile) {
      importGeneration.mutate(selectedFile, {
        onSuccess: (data) => {
          setImportDialogOpen(false);
          setSelectedFile(null);
          if (fileInputRef.current) {
            fileInputRef.current.value = '';
          }
          toast({
            title: 'Generation imported',
            description: data.message || 'Generation imported successfully',
          });
        },
        onError: (error) => {
          toast({
            title: 'Failed to import generation',
            description: error.message,
            variant: 'destructive',
          });
        },
      });
    }
  };

  const historyKeys = useMemo(() => allHistory.map((item) => item.id), [allHistory]);
  const virtual = useHistoryWindow(historyKeys, scrollRef, embedded, [
    expandedVersionsId,
    focusedRow,
    menuRow,
  ]);

  if (isLoading && page === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const history = allHistory;
  const failedCount = history.filter((g) => g.status === 'failed').length;

  const handleClearFailedConfirm = () => {
    const scope = clearFailedScope;
    if (!scope || !isCurrentServer(scope)) return;
    clearFailed.mutate(scope, {
      onSuccess: (data) => {
        if (!isCurrentServer(scope)) return;
        setClearFailedDialogOpen(false);
        toast({
          title: 'Cleared failed generations',
          description: `${data.deleted} failed ${data.deleted === 1 ? 'generation' : 'generations'} removed.`,
        });
      },
      onError: (error) => {
        if (!isCurrentServer(scope)) return;
        setClearFailedDialogOpen(false);
        toast({
          title: 'Failed to clear',
          description: error instanceof Error ? error.message : 'Unknown error',
          variant: 'destructive',
        });
      },
    });
  };

  return (
    <div className={cn('flex flex-col min-h-0', !embedded && 'h-full')}>
      {embedded && (
        <p className="mb-2 text-xs text-muted-foreground">
          {total} {total === 1 ? 'take' : 'takes'}
        </p>
      )}
      {history.length === 0 ? (
        <div className="text-center py-12 pt-4 lg:pt-12 px-5 border-2 border-dashed mb-5 border-muted rounded-md text-muted-foreground flex-1 flex items-start lg:items-center justify-center">
          {t('history.empty')}
        </div>
      ) : (
        <>
          {failedCount > 0 && (
            <div className="flex items-center justify-between px-1 pb-2">
              <span className="text-xs text-muted-foreground">
                {failedCount} failed {failedCount === 1 ? 'generation' : 'generations'}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-muted-foreground"
                onClick={() => {
                  setClearFailedScope(currentServerScope());
                  setClearFailedDialogOpen(true);
                }}
                disabled={clearFailed.isPending}
              >
                <Trash2 className="h-3 w-3 mr-1.5" />
                {clearFailed.isPending ? 'Clearing...' : 'Clear failed'}
              </Button>
            </div>
          )}
          <div
            ref={scrollRef}
            className={cn(
              'relative',
              !embedded && 'flex-1 min-h-0 overflow-y-auto pb-4',
              !embedded && isPlayerVisible && BOTTOM_SAFE_AREA_PADDING,
            )}
          >
            <div ref={virtual.content} style={{ position: 'relative', height: virtual.total }}>
              {virtual.rows.map(({ index, top }) => {
                const gen = history[index];
                const isInProgress = gen.status === 'loading_model' || gen.status === 'generating';
                const isGenerating = isInProgress;
                const isFailed = gen.status === 'failed';
                const isPlayable = !isGenerating && !isFailed;
                const hasVersions = gen.versions && gen.versions.length > 1;
                const isVersionsExpanded = expandedVersionsId === gen.id;
                const isLongText = gen.text.length > 260 || gen.text.split('\n').length > 4;
                const isTextExpanded = expandedTextIds.has(gen.id);
                const isCancelling =
                  cancelGeneration.isPending && cancelGeneration.variables?.generationId === gen.id &&
                  isCurrentServer(cancelGeneration.variables.scope);
                return (
                  <div
                    key={gen.id}
                    ref={(node) => virtual.measure(gen.id, node)}
                    data-history-row={gen.id}
                    style={{ position: 'absolute', top, width: '100%', paddingBottom: 8 }}
                    onFocusCapture={() => setFocusedRow(gen.id)}
                    onBlurCapture={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                        setFocusedRow(null);
                    }}
                  >
                    <HistoryPlaybackState id={gen.id}>
                      {({ isSelected, isCurrentlyPlaying }) => (
                        <div
                          className={cn(
                            'border rounded-lg bg-card transition-colors text-left w-full overflow-hidden',
                            isSelected
                              ? 'border-accent/60 bg-muted/60'
                              : 'border-border/70 hover:border-border',
                          )}
                        >
                          {/* Playable transcript area */}
                          {/* biome-ignore lint/a11y/useSemanticElements: The playable area includes selectable transcript text. Action buttons live in the sibling footer bar below. */}
                          <div
                            role="button"
                            aria-disabled={!isPlayable}
                            aria-pressed={isSelected}
                            tabIndex={isPlayable ? 0 : undefined}
                            className={cn(
                              'w-full px-3.5 pt-3 pb-2 outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset',
                              isPlayable && 'hover:bg-muted/40 cursor-pointer',
                            )}
                            aria-label={
                              isGenerating
                                ? `Generating speech for ${gen.profile_name}...`
                                : isFailed
                                  ? `Generation failed for ${gen.profile_name}`
                                  : isCurrentlyPlaying
                                    ? `Sample from ${gen.profile_name}, ${formatDuration(gen.duration ?? 0)}, ${formatDate(gen.created_at)}. Playing. Press Enter to restart.`
                                    : `Sample from ${gen.profile_name}, ${formatDuration(gen.duration ?? 0)}, ${formatDate(gen.created_at)}. Press Enter to play.`
                            }
                            onClick={(e) => {
                              if (!isPlayable || e.button !== 0) return;
                              const target = e.target as HTMLElement;
                              if (target.closest('button, [role="menuitem"]')) return;
                              const selection = window.getSelection();
                              if (
                                selection?.toString() &&
                                (!selection.anchorNode ||
                                  !e.currentTarget?.contains ||
                                  e.currentTarget.contains(selection.anchorNode))
                              ) {
                                return;
                              }
                              handlePlay(gen.id, gen.text, gen.profile_id);
                            }}
                            onKeyDown={(e) => {
                              if (!isPlayable) return;
                              const target = e.target as HTMLElement;
                              if (target.closest('button')) return;
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                handlePlay(gen.id, gen.text, gen.profile_id);
                              }
                            }}
                          >
                            <p
                              data-history-transcript
                              aria-label={`Transcript for sample from ${gen.profile_name}, ${formatDuration(gen.duration ?? 0)}`}
                              className={cn(
                                'w-full text-sm leading-relaxed text-foreground whitespace-pre-wrap break-words select-text',
                                !isTextExpanded && isLongText && 'line-clamp-4',
                              )}
                            >
                              {gen.text}
                            </p>
                          </div>

                          {/* Compact footer: metadata on left, horizontal action row on right */}
                          <div className="flex items-center justify-between gap-2 px-3.5 pb-2.5 pt-0.5">
                            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 min-w-0 text-xs text-muted-foreground">
                              <span className="font-medium text-foreground/80 truncate max-w-[160px]">
                                {gen.profile_name}
                              </span>
                              <span aria-hidden="true">·</span>
                              <span>{formatEngineName(gen.engine, gen.model_size)}</span>
                              <span aria-hidden="true">·</span>
                              <span className="tabular-nums">
                                {isFailed
                                  ? 'Failed'
                                  : isInProgress
                                    ? gen.status === 'loading_model'
                                      ? 'Loading model...'
                                      : 'Generating...'
                                    : formatDuration(gen.duration ?? 0)}
                              </span>
                              <span aria-hidden="true">·</span>
                              <span>{formatDate(gen.created_at)}</span>
                              {isCurrentlyPlaying && (
                                <span className="inline-flex items-center rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                                  Playing
                                </span>
                              )}
                              {isLongText && (
                                <button
                                  type="button"
                                  className="ml-1 text-xs font-medium text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                                  onClick={() => toggleExpandedText(gen.id)}
                                >
                                  {isTextExpanded ? 'Show less' : 'Show more'}
                                </button>
                              )}
                            </div>

                            <div className="shrink-0 flex items-center gap-0.5">
                              {isPlayable && (
                                <Hint
                                  content={isCurrentlyPlaying ? 'Restart playback' : 'Play take'}
                                >
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className={cn(
                                      'h-7 w-7 text-muted-foreground hover:text-foreground hover:bg-muted',
                                      isCurrentlyPlaying && 'text-accent hover:text-accent',
                                    )}
                                    aria-label={
                                      isCurrentlyPlaying ? 'Restart playback' : 'Play take'
                                    }
                                    onClick={() => handlePlay(gen.id, gen.text, gen.profile_id)}
                                  >
                                    <Play className="h-3.5 w-3.5" />
                                  </Button>
                                </Hint>
                              )}
                              <Hint content={gen.is_favorited ? 'Remove favorite' : 'Favorite'}>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className={cn(
                                    'h-7 w-7 text-muted-foreground hover:text-foreground hover:bg-muted',
                                    gen.is_favorited && 'text-accent hover:text-accent',
                                  )}
                                  aria-label={gen.is_favorited ? 'Unfavorite' : 'Favorite'}
                                  onClick={() => handleToggleFavorite(gen.id)}
                                >
                                  <Star
                                    className="h-3.5 w-3.5"
                                    fill={gen.is_favorited ? 'currentColor' : 'none'}
                                  />
                                </Button>
                              </Hint>
                              {hasVersions && (
                                <Hint content="Show versions">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className={cn(
                                      'h-7 px-1.5 gap-1 text-xs tabular-nums text-muted-foreground hover:text-foreground hover:bg-muted',
                                      isVersionsExpanded && 'text-accent hover:text-accent bg-accent/10',
                                    )}
                                    aria-label="Toggle versions"
                                    onClick={() =>
                                      setExpandedVersionsId(isVersionsExpanded ? null : gen.id)
                                    }
                                  >
                                    <AudioLines className="h-3.5 w-3.5" />
                                    <span>{gen.versions?.length}</span>
                                  </Button>
                                </Hint>
                              )}

                              {isFailed ? (
                                <>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7 text-muted-foreground hover:text-foreground hover:bg-muted"
                                    aria-label="Retry generation"
                                    onClick={() => handleRetry(gen.id)}
                                  >
                                    <RotateCcw className="h-3.5 w-3.5" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7 text-muted-foreground hover:text-foreground hover:bg-muted"
                                    aria-label="Delete generation"
                                    disabled={deleteGeneration.isPending}
                                    onClick={() => handleDeleteClick(gen.id, gen.profile_name)}
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </Button>
                                </>
                              ) : isGenerating ? (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-muted-foreground hover:text-foreground hover:bg-muted"
                                  aria-label="Cancel generation"
                                  disabled={isCancelling}
                                  onClick={() => cancelGeneration.mutate({ generationId: gen.id, scope: currentServerScope() })}
                                >
                                  {isCancelling ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  ) : (
                                    <Square className="h-3.5 w-3.5" />
                                  )}
                                </Button>
                              ) : (
                                <DropdownMenu
                                  onOpenChange={(open) =>
                                    setMenuRow((current) =>
                                      open ? gen.id : current === gen.id ? null : current,
                                    )
                                  }
                                >
                                  <DropdownMenuTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-7 w-7 text-muted-foreground hover:text-foreground hover:bg-muted"
                                      aria-label={t('history.actions.menu')}
                                      disabled={isGenerating}
                                    >
                                      <MoreHorizontal className="h-3.5 w-3.5" />
                                    </Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end">
                                    <DropdownMenuItem
                                      onClick={() => handlePlay(gen.id, gen.text, gen.profile_id)}
                                    >
                                      <Play className="mr-2 h-4 w-4" />
                                      {t('history.actions.play')}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      onClick={() => handleDownloadAudio(gen.id, gen.text)}
                                      disabled={exportGenerationAudio.isPending}
                                    >
                                      <Download className="mr-2 h-4 w-4" />
                                      {t('history.actions.exportAudio')}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      onClick={() => handleDownloadAudio(gen.id, gen.text, 'mp3')}
                                      disabled={exportGenerationAudio.isPending}
                                    >
                                      <Download className="mr-2 h-4 w-4" />
                                      {t('history.actions.exportAudioMp3')}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      onClick={() => handleExportPackage(gen.id, gen.text)}
                                      disabled={exportGeneration.isPending}
                                    >
                                      <FileArchive className="mr-2 h-4 w-4" />
                                      {t('history.actions.exportPackage')}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => handleApplyEffects(gen.id)}>
                                      <Wand2 className="mr-2 h-4 w-4" />
                                      {t('history.actions.applyEffects')}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => handleRegenerate(gen.id)}>
                                      <RotateCcw className="mr-2 h-4 w-4" />
                                      {t('history.actions.regenerate')}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      onClick={() => handleDeleteClick(gen.id, gen.profile_name)}
                                      disabled={deleteGeneration.isPending}
                                    >
                                      <Trash2 className="mr-2 h-4 w-4" />
                                      {t('common.delete')}
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              )}
                            </div>
                          </div>

                          {/* Expandable versions panel */}
                          <AnimatePresence>
                            {isVersionsExpanded && gen.versions && (
                              <motion.div
                                initial={{ height: 0, opacity: 0 }}
                                animate={{ height: 'auto', opacity: 1 }}
                                exit={{ height: 0, opacity: 0 }}
                                transition={{ duration: 0.2, ease: 'easeOut' }}
                                className="overflow-hidden"
                              >
                                <div className="border-t border-border/50">
                                  <div className="divide-y divide-border/40">
                                    {gen.versions.map((v) => {
                                      // Show source provenance when effects were applied to a non-clean version
                                      const sourceVersion = v.source_version_id
                                        ? gen.versions?.find((sv) => sv.id === v.source_version_id)
                                        : null;
                                      const showSource =
                                        (sourceVersion?.effects_chain?.length ?? 0) > 0;
                                      const original = gen.versions?.find(
                                        (version) =>
                                          !version.effects_chain && !version.source_version_id,
                                      );
                                      const isOriginal = v.id === original?.id;
                                      const hasDerivedVersions = gen.versions?.some(
                                        (version) => version.source_version_id === v.id,
                                      );
                                      const canEdit =
                                        !isOriginal && (!!v.effects_chain || !!v.source_version_id);

                                      return (
                                        <div
                                          key={v.id}
                                          className="flex items-center pr-2 hover:bg-muted/50 transition-colors"
                                        >
                                          <button
                                            type="button"
                                            className="flex items-center gap-2 flex-1 min-w-0 h-9 px-3 text-left"
                                            disabled={applyingEffects || deletingVersion}
                                            onClick={() => {
                                              handlePlayVersion(
                                                gen.id,
                                                v.id,
                                                gen.text,
                                                gen.profile_id,
                                              );
                                              if (!v.is_default) {
                                                handleSwitchVersion(gen.id, v.id);
                                              }
                                            }}
                                          >
                                            <AudioLines className="h-3 w-3 shrink-0 text-muted-foreground" />
                                            <span className="truncate text-xs font-medium">
                                              {v.label}
                                            </span>
                                            {v.effects_chain && v.effects_chain.length > 0 && (
                                              <span className="text-[10px] text-muted-foreground truncate">
                                                {v.effects_chain.map((e) => e.type).join(' → ')}
                                              </span>
                                            )}
                                            {showSource && (
                                              <span className="text-[10px] text-muted-foreground/60 truncate">
                                                from {sourceVersion?.label}
                                              </span>
                                            )}
                                            <span className="flex-1" />
                                            {v.is_default && (
                                              <span className="text-[10px] bg-accent/15 text-accent px-1.5 py-0.5 rounded-full">
                                                active
                                              </span>
                                            )}
                                          </button>
                                          {!isOriginal && (
                                            <DropdownMenu
                                              onOpenChange={(open) =>
                                                setMenuRow((current) =>
                                                  open
                                                    ? gen.id
                                                    : current === gen.id
                                                      ? null
                                                      : current,
                                                )
                                              }
                                            >
                                              <DropdownMenuTrigger asChild>
                                                <Button
                                                  variant="ghost"
                                                  size="icon"
                                                  className="h-7 w-7 shrink-0 text-muted-foreground"
                                                  aria-label={t('history.versions.actions', {
                                                    name: v.label,
                                                  })}
                                                  disabled={applyingEffects || deletingVersion}
                                                >
                                                  <MoreHorizontal className="h-3.5 w-3.5" />
                                                </Button>
                                              </DropdownMenuTrigger>
                                              <DropdownMenuContent align="end">
                                                {canEdit && (
                                                  <DropdownMenuItem
                                                    disabled={hasDerivedVersions}
                                                    onSelect={() => handleEditVersion(gen.id, v)}
                                                  >
                                                    <Pencil className="mr-2 h-4 w-4" />
                                                    {t('history.versions.edit')}
                                                  </DropdownMenuItem>
                                                )}
                                                <DropdownMenuItem
                                                  className="text-destructive focus:text-destructive"
                                                  disabled={
                                                    hasDerivedVersions ||
                                                    (gen.versions?.length ?? 0) <= 1
                                                  }
                                                  onSelect={() => setVersionToDelete({ version: v, scope: currentServerScope() })}
                                                >
                                                  <Trash2 className="mr-2 h-4 w-4" />
                                                  {t('history.versions.delete')}
                                                </DropdownMenuItem>
                                                {hasDerivedVersions && (
                                                  <p className="max-w-56 px-2 py-1.5 text-xs text-muted-foreground">
                                                    {t('history.versions.usedAsSource')}
                                                  </p>
                                                )}
                                              </DropdownMenuContent>
                                            </DropdownMenu>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>
                      )}
                    </HistoryPlaybackState>
                  </div>
                );
              })}
            </div>

            {/* Load more trigger element */}
            {hasMore && (
              <div ref={loadMoreRef} className="flex items-center justify-center py-4">
                {isFetching && <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />}
              </div>
            )}

            {/* End of list indicator (only after scrolling through more than one page) */}
            {!hasMore && history.length > limit && (
              <div className="text-center py-4 text-xs text-muted-foreground">
                You've reached the end
              </div>
            )}
          </div>
        </>
      )}

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('history.deleteDialog.title')}</DialogTitle>
            <DialogDescription>
              {t('history.deleteDialog.body', { name: generationToDelete?.name })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDeleteDialogOpen(false);
                setGenerationToDelete(null);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteConfirm}
              disabled={deleteGeneration.isPending}
            >
              {deleteGeneration.isPending ? t('history.deleteDialog.deleting') : t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={clearFailedDialogOpen} onOpenChange={setClearFailedDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('history.clearFailedDialog.title')}</DialogTitle>
            <DialogDescription>
              {t('history.clearFailedDialog.body', { count: failedCount })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClearFailedDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleClearFailedConfirm}
              disabled={clearFailed.isPending}
            >
              {clearFailed.isPending
                ? t('history.clearFailedDialog.clearing')
                : t('history.clearFailedDialog.clearAll')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('history.importDialog.title')}</DialogTitle>
            <DialogDescription>
              {t('history.importDialog.body', { name: selectedFile?.name })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setImportDialogOpen(false);
                setSelectedFile(null);
                if (fileInputRef.current) {
                  fileInputRef.current.value = '';
                }
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              onClick={handleImportConfirm}
              disabled={importGeneration.isPending || !selectedFile}
            >
              {importGeneration.isPending
                ? t('history.importDialog.importing')
                : t('history.importDialog.action')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!versionToDelete}
        onOpenChange={(open) => {
          if (!open && !deletingVersion) setVersionToDelete(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('history.versions.delete')}</DialogTitle>
            <DialogDescription>
              {t('history.versions.deleteBody', { name: versionToDelete?.version.label })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={deletingVersion}
              onClick={() => setVersionToDelete(null)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={deletingVersion}
              onClick={handleDeleteVersionConfirm}
            >
              {deletingVersion ? t('history.deleteDialog.deleting') : t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={effectsDialogOpen}
        onOpenChange={(open) => {
          if (!applyingEffects) setEffectsDialogOpen(open);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editingVersion
                ? t('history.versions.editTitle', { name: editingVersion.label })
                : t('history.effectsDialog.title')}
            </DialogTitle>
            <DialogDescription>
              {editingVersion ? t('history.versions.editBody') : t('history.effectsDialog.body')}
            </DialogDescription>
          </DialogHeader>
          {!editingVersion && effectsTargetVersions.length > 1 && (
            <div className="space-y-1.5">
              <label
                htmlFor="history-effects-source"
                className="text-xs font-medium text-muted-foreground"
              >
                {t('history.effectsDialog.sourceLabel')}
              </label>
              <Select
                disabled={applyingEffects}
                value={effectsSourceVersionId ?? ''}
                onValueChange={(val) => setEffectsSourceVersionId(val || null)}
              >
                <SelectTrigger id="history-effects-source" className="h-8 text-xs">
                  <SelectValue placeholder={t('history.effectsDialog.sourcePlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {effectsTargetVersions.map((v) => (
                    <SelectItem key={v.id} value={v.id} className="text-xs">
                      {v.label}
                      {v.effects_chain && v.effects_chain.length > 0 && (
                        <span className="text-muted-foreground ml-1.5">
                          ({v.effects_chain.map((e) => e.type).join(' + ')})
                        </span>
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <fieldset disabled={applyingEffects} className="py-2 max-h-80 overflow-y-auto">
            <EffectsChainEditor value={effectsChain} onChange={setEffectsChain} />
          </fieldset>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={applyingEffects}
              onClick={() => setEffectsDialogOpen(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              onClick={handleApplyEffectsConfirm}
              disabled={applyingEffects || (!editingVersion && effectsChain.length === 0)}
            >
              {applyingEffects
                ? t('history.effectsDialog.applying')
                : editingVersion
                  ? t('common.save')
                  : t('history.effectsDialog.apply')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
