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
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { Link } from '@tanstack/react-router';
import { AnimatePresence, motion } from 'framer-motion';
import { BookAudio, ChevronDown, Download, FileAudio, Music, Plus, Upload, Waves } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Loader from 'react-loaders';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useToast } from '@/components/ui/use-toast';
import { apiClient } from '@/lib/api/client';
import type { StoryExportFormat } from '@/lib/api/types';
import { useHistory } from '@/lib/hooks/useHistory';
import {
  useAddStoryItem,
  useExportStoryAudio,
  useRemoveStoryItem,
  useReorderStoryItems,
  useStory,
} from '@/lib/hooks/useStories';
import { useStoryPlayback } from '@/lib/hooks/useStoryPlayback';
import { isCurrentServer } from '@/lib/serverScope';
import { cn } from '@/lib/utils/cn';
import { useServerStore } from '@/stores/serverStore';
import { useGenerationStore } from '@/stores/generationStore';
import { useStoryStore } from '@/stores/storyStore';
import { SortableStoryChatItem } from './StoryChatItem';

export function StoryContent({ composer }: { composer?: ReactNode }) {
  const { t } = useTranslation();
  const compact = !!composer;
  const selectedStoryId = useStoryStore((state) => state.selectedStoryId);
  const { data: story, isLoading, error: storyError, refetch } = useStory(selectedStoryId);
  const removeItem = useRemoveStoryItem();
  const reorderItems = useReorderStoryItems();
  const exportAudio = useExportStoryAudio();
  const addStoryItem = useAddStoryItem();
  const { toast } = useToast();
  const scrollRef = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const pendingCount = useGenerationStore((s) => s.pendingGenerationIds.size);
  const addPendingGeneration = useGenerationStore((s) => s.addPendingGeneration);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const importBatchRef = useRef<number | null>(null);
  const nextImportBatchRef = useRef(0);
  const serverUrl = useServerStore((state) => state.serverUrl);
  const serverRevision = useServerStore((state) => state.serverRevision);
  useEffect(() => {
    setIsImporting(false);
    return () => { importBatchRef.current = null; };
  }, [selectedStoryId, serverUrl, serverRevision]);
  useEffect(() => useStoryStore.subscribe((state, previous) => {
    if (state.selectedStoryId !== previous.selectedStoryId && importBatchRef.current !== null) {
      importBatchRef.current = null;
      setIsImporting(false);
    }
  }), []);
  const dragDepthRef = useRef(0);

  // Add generation popover state
  const [searchQuery, setSearchQuery] = useState('');
  const [isAddOpen, setIsAddOpen] = useState(false);
  const { data: historyData } = useHistory();

  // Filter generations not in story and matching search
  const availableGenerations = useMemo(() => {
    if (!historyData?.items || !story) return [];
    const storyGenerationIds = new Set(story.items.map((i) => i.generation_id));
    const query = searchQuery.toLowerCase();
    return historyData.items.filter(
      (gen) =>
        gen.status === 'completed' &&
        !storyGenerationIds.has(gen.id) &&
        (gen.text.toLowerCase().includes(query) || gen.profile_name.toLowerCase().includes(query)),
    );
  }, [historyData, story, searchQuery]);

  // Get track editor height from store for dynamic padding
  const trackEditorHeight = useStoryStore((state) => state.trackEditorHeight);

  // Track editor is shown when story has items
  const hasBottomBar = story && story.items.length > 0;

  // Clear the floating generate box, including its wrapped controls, and the
  // track editor bar when it's showing.
  const bottomPadding = (hasBottomBar ? trackEditorHeight : 0) + (compact ? 0 : 180);

  // Drag and drop sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // Playback state (for auto-scroll and item highlighting)
  const isPlaying = useStoryStore((state) => state.isPlaying);
  const currentTimeMs = useStoryStore((state) => state.currentTimeMs);
  const playbackStoryId = useStoryStore((state) => state.playbackStoryId);

  // Refs for auto-scrolling to playing item
  const itemRefsMap = useRef<Map<string, HTMLDivElement>>(new Map());
  const lastScrolledItemRef = useRef<string | null>(null);

  // Use playback hook
  useStoryPlayback(story?.items);

  // Sort items by start_time_ms
  const sortedItems = useMemo(() => {
    if (!story?.items) return [];
    return [...story.items].sort((a, b) => a.start_time_ms - b.start_time_ms);
  }, [story?.items]);

  // Find the currently playing item based on timecode (using effective trimmed duration)
  const currentlyPlayingItemId = useMemo(() => {
    if (!isPlaying || playbackStoryId !== story?.id || !sortedItems.length) {
      return null;
    }
    const playingItem = sortedItems.find((item) => {
      const itemStart = item.start_time_ms;
      const effectiveDurationMs = Math.max(
        0,
        item.duration * 1000 - (item.trim_start_ms || 0) - (item.trim_end_ms || 0),
      );
      const itemEnd = itemStart + effectiveDurationMs;
      return currentTimeMs >= itemStart && currentTimeMs < itemEnd;
    });
    return playingItem?.id ?? null;
  }, [isPlaying, playbackStoryId, story?.id, sortedItems, currentTimeMs]);

  // Auto-scroll to the currently playing item
  useEffect(() => {
    if (!currentlyPlayingItemId || currentlyPlayingItemId === lastScrolledItemRef.current) {
      return;
    }

    const element = itemRefsMap.current.get(currentlyPlayingItemId);
    if (element && scrollRef.current) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
      lastScrolledItemRef.current = currentlyPlayingItemId;
    }
  }, [currentlyPlayingItemId]);

  // Reset last scrolled item when playback stops
  useEffect(() => {
    if (!isPlaying) {
      lastScrolledItemRef.current = null;
    }
  }, [isPlaying]);

  const handleRegenerate = async (generationId: string) => {
    try {
      await apiClient.regenerateGeneration(generationId);
      addPendingGeneration(generationId);
    } catch (error) {
      toast({
        title: t('storyContent.toast.regenerateFailed'),
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    }
  };

  const handleRemoveItem = (itemId: string) => {
    if (!story) return;

    removeItem.mutate(
      {
        storyId: story.id,
        itemId,
      },
      {
        onError: (error) => {
          toast({
            title: t('storyContent.toast.removeFailed'),
            description: error.message,
            variant: 'destructive',
          });
        },
      },
    );
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (!story || !over || active.id === over.id) return;

    const oldIndex = sortedItems.findIndex((item) => item.id === active.id);
    const newIndex = sortedItems.findIndex((item) => item.id === over.id);

    if (oldIndex === -1 || newIndex === -1) return;

    // Calculate the new order
    const newOrder = arrayMove(sortedItems, oldIndex, newIndex);
    const generationIds = newOrder.map((item) => item.generation_id);

    // Send reorder request to backend
    reorderItems.mutate(
      {
        storyId: story.id,
        data: { generation_ids: generationIds },
      },
      {
        onError: (error) => {
          toast({
            title: t('storyContent.toast.reorderFailed'),
            description: error.message,
            variant: 'destructive',
          });
        },
      },
    );
  };

  const handleExportAudio = (format: StoryExportFormat) => {
    if (!story) return;

    exportAudio.mutate(
      {
        storyId: story.id,
        storyName: story.name,
        format,
      },
      {
        onError: (error) => {
          toast({
            title: t('storyContent.toast.exportFailed'),
            description: error.message,
            variant: 'destructive',
          });
        },
      },
    );
  };

  const handleImportFiles = async (files: FileList | File[]) => {
    const scope = { serverUrl, serverRevision };
    if (!story || story.id !== useStoryStore.getState().selectedStoryId ||
        !isCurrentServer(scope) || importBatchRef.current !== null) return;
    const batch = ++nextImportBatchRef.current;
    const storyId = story.id;
    importBatchRef.current = batch;
    const isCurrent = () => importBatchRef.current === batch && isCurrentServer(scope) &&
      useStoryStore.getState().selectedStoryId === storyId;
    setIsImporting(true);
    try {
      for (const file of Array.from(files)) {
        if (!isCurrent()) break;
        try {
          const generation = await apiClient.importAudio(file);
          if (!isCurrent()) break;
          await addStoryItem.mutateAsync({
            storyId,
            data: { generation_id: generation.id },
            _serverScope: scope,
          });
          if (!isCurrent()) break;
          setIsAddOpen(false);
        } catch (error) {
          if (!isCurrent()) break;
          toast({
            title: t('storyContent.toast.importFailed'),
            description: error instanceof Error ? error.message : String(error),
            variant: 'destructive',
          });
        }
      }
    } finally {
      if (isCurrent()) {
        importBatchRef.current = null;
        setIsImporting(false);
      }
    }
  };

  const handleAddGeneration = (generationId: string) => {
    if (!story) return;

    addStoryItem.mutate(
      {
        storyId: story.id,
        data: { generation_id: generationId },
      },
      {
        onSuccess: () => {
          setIsAddOpen(false);
          setSearchQuery('');
        },
        onError: (error) => {
          toast({
            title: t('storyContent.toast.addFailed'),
            description: error.message,
            variant: 'destructive',
          });
        },
      },
    );
  };

  if (!selectedStoryId) {
    return (
      <div className="flex items-center justify-center h-full max-lg:pb-[180px] text-muted-foreground">
        <p className="text-lg font-medium">{t('storyContent.selectStory.title')}</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full max-lg:pb-[180px]">
        <div className="text-muted-foreground">{t('storyContent.loading')}</div>
      </div>
    );
  }

  if (!story) {
    return (
      <div className="flex items-center justify-center h-full max-lg:pb-[180px] text-muted-foreground">
        <div className="space-y-3 text-center">
          {storyError ? (
            <>
              <div role="alert">
                <p className="text-lg font-medium">{t('storyContent.notFound.hint')}</p>
                <p className="text-sm text-destructive">{storyError.message}</p>
              </div>
              <Button size="sm" onClick={() => void refetch()}>
                {t('common.retry')}
              </Button>
            </>
          ) : (
            <p className="text-lg font-medium">{t('storyContent.notFound.title')}</p>
          )}
        </div>
      </div>
    );
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: There is also a keyboard-accessible import button.
    <div
      className="flex flex-col h-full min-h-0 relative overflow-hidden"
      onDragEnter={(e) => {
        if (!e.dataTransfer?.types.includes('Files')) return;
        e.preventDefault();
        dragDepthRef.current += 1;
        setIsDraggingFile(true);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
      }}
      onDragLeave={(e) => {
        if (!e.dataTransfer?.types.includes('Files')) return;
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setIsDraggingFile(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer?.files?.length) return;
        e.preventDefault();
        dragDepthRef.current = 0;
        setIsDraggingFile(false);
        handleImportFiles(e.dataTransfer.files);
      }}
    >
      <input
        ref={importInputRef}
        type="file"
        accept="audio/*,.wav,.mp3,.flac,.ogg,.m4a,.aac,.webm"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) handleImportFiles(e.target.files);
          e.target.value = '';
        }}
      />
      {isDraggingFile && (
        <div className="absolute inset-0 z-30 pointer-events-none flex items-center justify-center bg-accent/10 border-2 border-dashed border-accent rounded-lg m-4">
          <div className="flex flex-col items-center gap-2 text-accent">
            <Music className="h-8 w-8" />
            <span className="text-sm font-medium">{t('storyContent.dropToImport')}</span>
          </div>
        </div>
      )}
      <div className="z-20 mb-3 flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border/60 pb-3">
        <div className={cn('min-w-0 flex-1', compact && 'basis-full')}>
          <h2 className="truncate text-xl font-semibold tracking-tight" title={story.name}>
            {story.name}
          </h2>
          {story.description && (
            <p className="truncate text-sm text-muted-foreground mt-1" title={story.description}>
              {story.description}
            </p>
          )}
        </div>
        <div className="flex max-w-full flex-wrap items-center gap-2">
          <AnimatePresence>
            {pendingCount > 0 && (
              <motion.div
                initial={{ opacity: 0, scale: 0.9, width: 0 }}
                animate={{ opacity: 1, scale: 1, width: 'auto' }}
                exit={{ opacity: 0, scale: 0.9, width: 0 }}
                transition={{ duration: 0.2 }}
              >
                <Link
                  to="/"
                  className="flex items-center gap-2 h-8 pl-1.5 pr-3 rounded-full bg-card border border-border hover:bg-muted/50 transition-all duration-200 cursor-pointer"
                >
                  <div className="shrink-0 w-10 h-5 overflow-hidden flex items-center justify-center">
                    <div className="scale-[0.45]">
                      <Loader type="line-scale" active />
                    </div>
                  </div>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {t('storyContent.generatingCount', { count: pendingCount })}
                  </span>
                </Link>
              </motion.div>
            )}
          </AnimatePresence>
          {compact && (
            <Button
              type="button"
              size="sm"
              aria-expanded={composerOpen}
              aria-controls="story-composer"
              onClick={() => setComposerOpen(!composerOpen)}
            >
              <Waves className="h-4 w-4" />
              {t('storyContent.generate')}
            </Button>
          )}
          <Popover open={isAddOpen} onOpenChange={setIsAddOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm">
                <Plus className="h-4 w-4" />
                {t('storyContent.add')}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-80 max-w-[90vw] p-0" align="end">
              <div className="p-2 border-b space-y-2">
                <Input
                  placeholder={t('storyContent.searchPlaceholder')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  autoFocus
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full justify-start"
                  onClick={() => importInputRef.current?.click()}
                  disabled={isImporting}
                >
                  <Upload className="mr-2 h-4 w-4" />
                  {isImporting ? t('storyContent.importing') : t('storyContent.importAudio')}
                </Button>
              </div>
              <div className="max-h-60 overflow-y-auto">
                {availableGenerations.length === 0 ? (
                  <div className="p-4 text-center text-sm text-muted-foreground">
                    {searchQuery
                      ? t('storyContent.searchNoMatches')
                      : t('storyContent.searchNoAvailable')}
                  </div>
                ) : (
                  availableGenerations.map((gen) => (
                    <button
                      key={gen.id}
                      type="button"
                      className="w-full text-left px-3 py-2 hover:bg-muted transition-colors border-b last:border-b-0"
                      onClick={() => handleAddGeneration(gen.id)}
                    >
                      <div className="font-medium text-sm">{gen.profile_name}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {gen.text.length > 50 ? `${gen.text.substring(0, 50)}...` : gen.text}
                      </div>
                    </button>
                  ))
                )}
              </div>
            </PopoverContent>
          </Popover>
          {story.items.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={exportAudio.isPending}
                  aria-label={t('storyContent.exportAudio')}
                >
                  <Download className="h-4 w-4" />
                  {compact ? t('storyContent.export') : t('storyContent.exportAudio')}
                  <ChevronDown className={cn('h-3.5 w-3.5 opacity-70', compact && 'hidden')} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">
                <DropdownMenuLabel className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                  {t('storyContent.exportDropdownLabel')}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => handleExportAudio('wav')}>
                  <FileAudio className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
                  {t('storyContent.exportFormats.wav')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleExportAudio('mp3')}>
                  <FileAudio className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
                  {t('storyContent.exportFormats.mp3')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleExportAudio('m4b')}>
                  <BookAudio className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
                  {t('storyContent.exportFormats.m4b')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* Content */}
      <div
        ref={scrollRef}
        className="relative z-0 flex-1 min-h-0 overflow-y-auto space-y-3"
        style={{ paddingBottom: bottomPadding > 0 ? `${bottomPadding}px` : undefined }}
      >
        {compact && (
          <div id="story-composer" hidden={!composerOpen}>
            {composerOpen && composer}
          </div>
        )}
        {sortedItems.length === 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed px-4 py-3">
            <p className="text-sm text-muted-foreground">{t('storyContent.empty.title')}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isImporting}
              onClick={() => importInputRef.current?.click()}
            >
              <Upload className="mr-1 h-4 w-4" />
              {isImporting ? t('storyContent.importing') : t('storyContent.importAudio')}
            </Button>
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={sortedItems.map((item) => item.id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="space-y-3">
                {sortedItems.map((item, index) => (
                  <div
                    key={item.id}
                    ref={(el) => {
                      if (el) {
                        itemRefsMap.current.set(item.id, el);
                      } else {
                        itemRefsMap.current.delete(item.id);
                      }
                    }}
                  >
                    <SortableStoryChatItem
                      item={item}
                      storyId={story.id}
                      index={index}
                      onRemove={() => handleRemoveItem(item.id)}
                      onRegenerate={
                        item.engine === 'import'
                          ? undefined
                          : () => handleRegenerate(item.generation_id)
                      }
                      currentTimeMs={currentTimeMs}
                      isPlaying={isPlaying && playbackStoryId === story.id}
                    />
                  </div>
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>
    </div>
  );
}
