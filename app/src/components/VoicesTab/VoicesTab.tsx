import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useBlocker } from '@tanstack/react-router';
import { Mic, Plus, Search, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

import { MultiSelect } from '@/components/ui/multi-select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useToast } from '@/components/ui/use-toast';
import { ProfileForm } from '@/components/VoiceProfiles/ProfileForm';
import { apiClient } from '@/lib/api/client';
import type { VoiceProfileResponse } from '@/lib/api/types';
import { BOTTOM_SAFE_AREA_PADDING } from '@/lib/constants/ui';
import { useMediaQuery } from '@/lib/hooks/useMediaQuery';
import { useDeleteProfile, useExportProfile, useProfiles } from '@/lib/hooks/useProfiles';
import { cn } from '@/lib/utils/cn';
import { usePlayerStore } from '@/stores/playerStore';
import { useServerStore } from '@/stores/serverStore';
import { useUIStore } from '@/stores/uiStore';
import { VoiceInspector, type VoiceInspectorActions } from './VoiceInspector';

export function VoicesTab() {
  const { t } = useTranslation();
  const { data: profiles, isLoading } = useProfiles();
  const deleteProfile = useDeleteProfile();
  const exportProfile = useExportProfile();
  const { toast } = useToast();
  const [deleteTarget, setDeleteTarget] = useState<VoiceProfileResponse | null>(null);
  const queryClient = useQueryClient();
  const setDialogOpen = useUIStore((state) => state.setProfileDialogOpen);
  const selectedVoiceId = useUIStore((state) => state.selectedVoiceId);
  const setSelectedVoiceId = useUIStore((state) => state.setSelectedVoiceId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const audioUrl = usePlayerStore((state) => state.audioUrl);
  const isPlayerVisible = !!audioUrl;
  const [search, setSearch] = useState('');
  const compact = useMediaQuery('(max-width: 1099px)');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [inspectorCompact, setInspectorCompact] = useState(compact);
  useEffect(() => {
    // Changing portal/container unmounts the form. Hold its current presentation
    // while dirty, then adapt once the user saves or discards the draft.
    if (!dirty && compact !== inspectorCompact) {
      setInspectorCompact(compact);
      if (selectedVoiceId) setSheetOpen(true);
    }
  }, [compact, dirty, inspectorCompact, selectedVoiceId]);
  const [guard, setGuard] = useState<{ proceed: () => void; cancel?: () => void } | null>(null);
  const [guardSaving, setGuardSaving] = useState(false);
  const [inspectorSaving, setInspectorSaving] = useState(false);
  const inspector = useRef<VoiceInspectorActions>(null);
  const guardRef = useRef(guard);
  guardRef.current = guard;
  useEffect(() => {
    // A footer save can finish while navigation waits. Continue only when all
    // writes settled and no edits made during that save remain unsaved.
    if (guard && !dirty && !inspectorSaving && !guardSaving && !inspector.current?.isSaving?.()) {
      const pending = guardRef.current;
      guardRef.current = null;
      setGuard(null);
      pending?.proceed();
    }
  }, [guard, dirty, inspectorSaving, guardSaving]);
  useEffect(() => () => guardRef.current?.cancel?.(), []);
  useBlocker({
    enableBeforeUnload: dirty,
    shouldBlockFn: () => {
      if (!dirty && !inspectorSaving && !inspector.current?.isSaving?.()) return false;
      return new Promise<boolean>((resolve) =>
        setGuard({ proceed: () => resolve(false), cancel: () => resolve(true) }),
      );
    },
  });
  function requestChange(proceed: () => void) {
    if (dirty || inspectorSaving || inspector.current?.isSaving?.()) setGuard({ proceed });
    else proceed();
  }
  function selectVoice(id: string) {
    if (id === selectedVoiceId) {
      setSheetOpen(true);
      return;
    }
    requestChange(() => {
      setDirty(false);
      setSelectedVoiceId(id);
      setSheetOpen(true);
    });
  }
  function cancelGuard() {
    guard?.cancel?.();
    setGuard(null);
  }
  function discardAndContinue() {
    if (inspectorSaving || inspector.current?.isSaving?.()) return;
    inspector.current?.discard();
    setDirty(false);
    const proceed = guard?.proceed;
    setGuard(null);
    proceed?.();
  }
  async function saveAndContinue() {
    if (guardSaving || inspectorSaving || inspector.current?.isSaving?.()) return;
    setGuardSaving(true);
    try {
      if (await inspector.current?.save()) {
        setDirty(false);
        const proceed = guardRef.current?.proceed;
        setGuard(null);
        proceed?.();
      }
    } finally {
      setGuardSaving(false);
    }
  }

  const filteredProfiles = useMemo(() => {
    if (!profiles) return [];
    if (!search.trim()) return profiles;
    const q = search.trim().toLowerCase();
    return profiles.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.description?.toLowerCase().includes(q) ||
        p.language.toLowerCase().includes(q),
    );
  }, [profiles, search]);

  // Auto-select first profile if none selected
  useEffect(() => {
    if (!selectedVoiceId && profiles && profiles.length > 0) {
      setSelectedVoiceId(profiles[0].id);
    }
    // Clear selection if selected profile was deleted
    if (selectedVoiceId && profiles && !profiles.find((p) => p.id === selectedVoiceId)) {
      setSelectedVoiceId(profiles.length > 0 ? profiles[0].id : null);
    }
  }, [profiles, selectedVoiceId, setSelectedVoiceId]);

  // Get channel assignments for each profile
  const { data: channelAssignments } = useQuery({
    queryKey: ['profile-channels'],
    queryFn: async () => {
      if (!profiles) return {};
      const assignments: Record<string, string[]> = {};
      for (const profile of profiles) {
        try {
          const result = await apiClient.getProfileChannels(profile.id);
          assignments[profile.id] = result.channel_ids;
        } catch {
          assignments[profile.id] = [];
        }
      }
      return assignments;
    },
    enabled: !!profiles,
  });

  // Get all channels
  const { data: channels } = useQuery({
    queryKey: ['channels'],
    queryFn: () => apiClient.listChannels(),
  });

  const handleChannelChange = async (profileId: string, channelIds: string[]) => {
    try {
      await apiClient.setProfileChannels(profileId, channelIds);
      queryClient.invalidateQueries({ queryKey: ['profile-channels'] });
    } catch (error) {
      console.error('Failed to update channels:', error);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-muted-foreground">{t('voicesTab.loading')}</div>
      </div>
    );
  }

  return (
    <div className="h-full flex gap-0 overflow-hidden -mx-8 desktop-page-bleed">
      {/* Left: Table */}
      <div className="flex-1 min-h-0 min-w-0 flex flex-col relative overflow-hidden">
        {/* Header stays in the layout so wrapped controls never cover the table. */}
        <div className="relative z-20 shrink-0 px-6 pb-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="mr-auto min-w-0">
              <h1 className="text-xl font-semibold tracking-tight">{t('voicesTab.title')}</h1>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('voicesTab.description', {
                  defaultValue: 'Your voices, reference audio and delivery defaults.',
                })}
              </p>
            </div>
            <div className="relative min-w-[160px] w-[220px] max-w-full">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder={t('voicesTab.searchPlaceholder')}
                aria-label={t('voicesTab.searchPlaceholder')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-9 pl-8 text-sm"
              />
            </div>
            <Button onClick={() => setDialogOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              {t('voicesTab.newVoice')}
            </Button>
          </div>
        </div>

        {/* Scrollable Content */}
        <div
          ref={scrollRef}
          className={cn(
            'flex-1 min-h-0 overflow-auto relative z-0',
            isPlayerVisible && BOTTOM_SAFE_AREA_PADDING,
          )}
        >
          <Table className="table-fixed min-w-[600px] min-[1400px]:min-w-[860px] [&_td:first-child]:pl-6 [&_th:first-child]:pl-6">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[65%] min-[1100px]:w-[45%] min-[1400px]:w-[26%]">
                  {t('voicesTab.columns.name')}
                </TableHead>
                <TableHead className="w-[20%] min-[1400px]:w-[12%]">
                  {t('voicesTab.columns.language')}
                </TableHead>
                <TableHead className="hidden min-[1400px]:table-cell w-[15%]">
                  {t('voicesTab.columns.generations')}
                </TableHead>
                <TableHead className="w-[15%] min-[1100px]:w-[20%] min-[1400px]:w-[12%]">
                  {t('voicesTab.columns.samples')}
                </TableHead>
                <TableHead className="hidden min-[1100px]:table-cell w-[15%] min-[1400px]:w-[11%]">
                  {t('voicesTab.columns.effects')}
                </TableHead>
                <TableHead className="hidden min-[1400px]:table-cell w-[24%]">
                  {t('voicesTab.columns.channels')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredProfiles.map((profile) => (
                <VoiceRow
                  key={profile.id}
                  profile={profile}
                  isSelected={selectedVoiceId === profile.id}
                  onSelect={() => selectVoice(profile.id)}
                  channelIds={channelAssignments?.[profile.id] || []}
                  channels={channels || []}
                  onChannelChange={(channelIds) => handleChannelChange(profile.id, channelIds)}
                />
              ))}
            </TableBody>
          </Table>
          {!filteredProfiles.length && (
            <output className="block px-6 py-10 text-center text-sm text-muted-foreground">
              {search.trim()
                ? t('voicesTab.noMatches', {
                    defaultValue: 'No matching voices. Try another search.',
                  })
                : t('profiles.list.empty')}
            </output>
          )}
        </div>
      </div>

      {/* Right: Inspector */}
      {selectedVoiceId && !inspectorCompact && (
        <div className="min-h-0 w-[360px] shrink-0 border-l border-t rounded-tl-xl bg-muted/20">
          <VoiceInspector
            key={selectedVoiceId}
            profileId={selectedVoiceId}
            profileSummary={profiles?.find((profile) => profile.id === selectedVoiceId)}
            onDirtyChange={setDirty}
            onSavingChange={setInspectorSaving}
            onExport={(profile) => {
              exportProfile.mutate(profile.id, {
                onError: (err) => {
                  toast({
                    title: t('common.error'),
                    description: err instanceof Error ? err.message : t('common.unknownError'),
                    variant: 'destructive',
                  });
                },
              });
            }}
            onDelete={(profile) => setDeleteTarget(profile)}
            actionsRef={inspector}
          />
        </div>
      )}

      <Dialog
        open={inspectorCompact && sheetOpen && !!selectedVoiceId}
        onOpenChange={(open) => {
          if (!open) requestChange(() => setSheetOpen(false));
        }}
      >
        <DialogContent className="left-auto right-0 top-0 h-dvh max-h-none w-[min(420px,92vw)] max-w-none translate-x-0 translate-y-0 rounded-none p-0 gap-0 overflow-hidden">
          <DialogTitle className="sr-only">
            {t('voiceInspector.sheetTitle', { defaultValue: 'Edit voice' })}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t('voiceInspector.sheetDescription', {
              defaultValue: 'Voice details, reference samples and default effects.',
            })}
          </DialogDescription>
          {selectedVoiceId && inspectorCompact && sheetOpen && (
            <VoiceInspector
              key={selectedVoiceId}
              profileId={selectedVoiceId}
              profileSummary={profiles?.find((profile) => profile.id === selectedVoiceId)}
              overlay
              onDirtyChange={setDirty}
              onSavingChange={setInspectorSaving}
              onExport={(profile) => {
                exportProfile.mutate(profile.id, {
                  onError: (err) => {
                    toast({
                      title: t('common.error'),
                      description: err instanceof Error ? err.message : t('common.unknownError'),
                      variant: 'destructive',
                    });
                  },
                });
              }}
              onDelete={(profile) => setDeleteTarget(profile)}
              actionsRef={inspector}
            />
          )}
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open && !deleteProfile.isPending) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('profiles.deleteDialog.title', { defaultValue: 'Delete voice profile?' })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('profiles.deleteDialog.description', {
                name: deleteTarget?.name ?? '',
                defaultValue: `Delete "${deleteTarget?.name ?? ''}" and its reference samples? This cannot be undone.`,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="ghost"
              disabled={deleteProfile.isPending}
              onClick={() => setDeleteTarget(null)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={deleteProfile.isPending}
              onClick={() => {
                if (!deleteTarget) return;
                const idToDelete = deleteTarget.id;
                deleteProfile.mutate(idToDelete, {
                  onSuccess: () => {
                    if (selectedVoiceId === idToDelete) {
                      setDirty(false);
                      setSelectedVoiceId(null);
                      setSheetOpen(false);
                    }
                    setDeleteTarget(null);
                  },
                  onError: (err) => {
                    toast({
                      title: t('common.error'),
                      description: err instanceof Error ? err.message : t('common.unknownError'),
                      variant: 'destructive',
                    });
                  },
                });
              }}
            >
              {t('common.delete')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={!!guard}
        onOpenChange={(open) => {
          if (!open && !guardSaving) cancelGuard();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('voiceInspector.unsavedTitle', { defaultValue: 'Save your changes?' })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('voiceInspector.unsavedDescription', {
                defaultValue:
                  'This voice has unsaved changes. Save them or discard them before continuing.',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="ghost" disabled={guardSaving} onClick={cancelGuard}>
              {t('voiceInspector.keepEditing', { defaultValue: 'Keep editing' })}
            </Button>
            <Button
              variant="outline"
              disabled={guardSaving || inspectorSaving}
              onClick={discardAndContinue}
            >
              {t('voiceInspector.discard', { defaultValue: 'Discard' })}
            </Button>
            <Button
              disabled={guardSaving || inspectorSaving}
              onClick={() => void saveAndContinue()}
            >
              {guardSaving || inspectorSaving ? t('profileForm.actions.saving') : t('common.save')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ProfileForm />
    </div>
  );
}

interface VoiceRowProps {
  profile: VoiceProfileResponse;
  isSelected: boolean;
  onSelect: () => void;
  channelIds: string[];
  channels: Array<{ id: string; name: string; is_default: boolean }>;
  onChannelChange: (channelIds: string[]) => void;
}

function VoiceRow({
  profile,
  isSelected,
  onSelect,
  channelIds,
  channels,
  onChannelChange,
}: VoiceRowProps) {
  const { t } = useTranslation();
  const serverUrl = useServerStore((state) => state.serverUrl);
  const [avatarError, setAvatarError] = useState(false);
  const avatarUrl = profile.avatar_path ? `${serverUrl}/profiles/${profile.id}/avatar` : null;

  const enabledEffects = profile.effects_chain?.filter((e) => e.enabled) ?? [];
  const effectsSummary = enabledEffects
    .map((e) => t(`effects.types.${e.type}.label`, { defaultValue: e.type }))
    .join(' → ');

  return (
    <TableRow
      className={cn('cursor-pointer', isSelected ? 'bg-muted/50' : 'hover:bg-muted/50')}
      aria-selected={isSelected}
      onClick={onSelect}
    >
      <TableCell>
        <button
          type="button"
          title={profile.name}
          aria-pressed={isSelected}
          className="flex w-full min-w-0 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-4 focus-visible:ring-offset-background"
          onClick={(event) => {
            event.stopPropagation();
            onSelect();
          }}
        >
          <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center shrink-0 overflow-hidden">
            {avatarUrl && !avatarError ? (
              <img
                src={avatarUrl}
                alt={t('voicesTab.avatarAlt', { name: profile.name })}
                className="h-full w-full object-cover"
                onError={() => setAvatarError(true)}
              />
            ) : (
              <Mic className="h-4 w-4 text-muted-foreground" />
            )}
          </div>
          <div className="min-w-0">
            <div className="font-medium truncate">{profile.name}</div>
            {profile.description && (
              <div className="text-sm text-muted-foreground truncate">{profile.description}</div>
            )}
          </div>
        </button>
      </TableCell>
      <TableCell>{profile.language}</TableCell>
      <TableCell className="hidden min-[1400px]:table-cell">{profile.generation_count}</TableCell>
      <TableCell>{profile.sample_count}</TableCell>
      <TableCell className="hidden min-[1100px]:table-cell">
        {enabledEffects.length > 0 ? (
          <span
            className="inline-flex items-center gap-1 text-xs text-accent"
            title={effectsSummary}
          >
            <Sparkles className="h-3 w-3 fill-accent" />
            {enabledEffects.length}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="hidden min-[1400px]:table-cell" onClick={(e) => e.stopPropagation()}>
        <MultiSelect
          options={channels.map((ch) => ({
            value: ch.id,
            label: ch.is_default ? t('voicesTab.channelDefaultLabel', { name: ch.name }) : ch.name,
          }))}
          value={channelIds}
          onChange={onChannelChange}
          placeholder={t('voicesTab.selectChannels')}
          className="w-full"
        />
      </TableCell>
    </TableRow>
  );
}
