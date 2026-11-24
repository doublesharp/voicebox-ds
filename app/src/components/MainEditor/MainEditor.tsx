import { useQueryClient } from '@tanstack/react-query';
import { Mic, Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FloatingGenerateBox } from '@/components/Generation/FloatingGenerateBox';
import { HistoryTable } from '@/components/History/HistoryTable';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/components/ui/use-toast';
import { ProfileForm } from '@/components/VoiceProfiles/ProfileForm';
import { apiClient } from '@/lib/api/client';
import type { HistoryResponse } from '@/lib/api/types';
import { useGeneration } from '@/lib/hooks/useGeneration';
import { generationDetailKey } from '@/lib/hooks/useHistory';
import { useCreateProfile, useImportProfile, useProfiles } from '@/lib/hooks/useProfiles';
import { currentServerScope, isCurrentServer, type ServerScope } from '@/lib/serverScope';
import { useGenerationStore } from '@/stores/generationStore';
import { useServerStore } from '@/stores/serverStore';
import { useUIStore } from '@/stores/uiStore';
import { type FirstRunAttempt, FirstRunWizard } from './FirstRunWizard';

const starterVoice = {
  name: 'Heart',
  language: 'en',
  voice_type: 'preset',
  preset_engine: 'kokoro',
  preset_voice_id: 'af_heart',
  default_engine: 'kokoro',
} as const;
const starterText = 'Hello! This is what your first take sounds like.';

export function MainEditor() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: profiles, isLoading: profilesLoading, error: profilesError } = useProfiles();
  const setDialogOpen = useUIStore((state) => state.setProfileDialogOpen);
  const importProfile = useImportProfile();
  const createProfile = useCreateProfile();
  const generate = useGeneration();
  const [starter, setStarter] = useState<FirstRunAttempt | null>(null);
  const starterRequest = useRef<ServerScope | null>(null);
  const editorHeadingRef = useRef<HTMLHeadingElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [selection, setSelection] = useState<{ file: File; scope: ServerScope; id: number } | null>(
    null,
  );
  const selectionId = useRef(0);
  const pendingId = useRef<number | null>(null);
  const [pendingSelectionId, setPendingSelectionId] = useState<number | null>(null);
  const serverUrl = useServerStore((state) => state.serverUrl);
  const serverRevision = useServerStore((state) => state.serverRevision);
  const { toast } = useToast();
  const needsVoice = !profilesLoading && !profilesError && profiles?.length === 0;
  const currentStarter =
    starter?.scope.serverUrl === serverUrl && starter.scope.serverRevision === serverRevision
      ? starter
      : null;
  const showStarter = !currentStarter?.finished && (needsVoice || currentStarter !== null);
  const starterFinished = currentStarter?.finished;

  useEffect(() => {
    if (starterFinished) editorHeadingRef.current?.focus();
  }, [starterFinished]);

  async function tryVoice(retryGenerationId?: string) {
    if (starterRequest.current && isCurrentServer(starterRequest.current)) return;
    if (currentStarter && !isCurrentServer(currentStarter.scope)) return;
    const scope = currentServerScope();
    let profileId = currentStarter?.profileId;
    starterRequest.current = scope;
    setStarter({ scope, profileId });
    try {
      if (!profileId) {
        const profile = await createProfile.mutateAsync({ ...starterVoice, _serverScope: scope });
        profileId = profile.id;
      }
      if (!isCurrentServer(scope)) return;
      const result = retryGenerationId
        ? await apiClient.retryGeneration(retryGenerationId)
        : await generate.mutateAsync({
            profile_id: profileId,
            text: starterText,
            language: starterVoice.language,
            engine: starterVoice.preset_engine,
            _serverScope: scope,
          });
      if (!isCurrentServer(scope)) return;
      queryClient.setQueryData<HistoryResponse>(generationDetailKey(result.id, scope), {
        ...result,
        profile_name: starterVoice.name,
      });
      useGenerationStore.getState().addPendingGeneration(result.id);
      setStarter({ scope, profileId, generationId: result.id });
    } catch {
      if (!isCurrentServer(scope)) return;
      setStarter({ scope, profileId, generationId: retryGenerationId, failed: true });
    } finally {
      if (starterRequest.current === scope) starterRequest.current = null;
    }
  }

  function finishFirstRun() {
    if (!currentStarter?.profileId || !isCurrentServer(currentStarter.scope)) return;
    useUIStore.getState().setSelectedProfileId(currentStarter.profileId);
    setStarter({ ...currentStarter, finished: true });
  }

  const clearSelection = useCallback(() => {
    selectionId.current += 1;
    pendingId.current = null;
    setPendingSelectionId(null);
    setImportDialogOpen(false);
    setSelection(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  useEffect(() => {
    if (
      selection &&
      (selection.scope.serverUrl !== serverUrl || selection.scope.serverRevision !== serverRevision)
    ) {
      clearSelection();
    }
  }, [selection, serverUrl, serverRevision, clearSelection]);

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (!file.name.endsWith('.voicebox.zip')) {
        toast({
          title: t('main.import.invalidTitle'),
          description: t('main.import.invalidDescription'),
          variant: 'destructive',
        });
        return;
      }
      const id = ++selectionId.current;
      setSelection({ file, scope: currentServerScope(), id });
      setImportDialogOpen(true);
    }
  };

  const handleImportConfirm = () => {
    if (!selection || !isCurrentServer(selection.scope) || pendingId.current === selection.id)
      return;
    const { file, scope, id } = selection;
    pendingId.current = id;
    setPendingSelectionId(id);
    const isCurrent = () => isCurrentServer(scope) && selectionId.current === id;
    const release = () => {
      if (pendingId.current === id) {
        pendingId.current = null;
        setPendingSelectionId(null);
      }
    };
    importProfile.mutate(
      { file, _serverScope: scope },
      {
        onSuccess: () => {
          release();
          if (!isCurrent()) return;
          clearSelection();
          toast({
            title: t('main.import.successTitle'),
            description: t('main.import.successDescription'),
          });
        },
        onError: (error) => {
          release();
          if (!isCurrent()) return;
          toast({
            title: t('main.import.failedTitle'),
            description: error.message,
            variant: 'destructive',
          });
        },
      },
    );
  };

  const voiceActions = (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" onClick={() => setDialogOpen(true)}>
        <Mic className="h-4 w-4" />
        {t('main.createVoice')}
      </Button>
      <Button variant="outline" size="sm" onClick={handleImportClick}>
        <Upload className="h-4 w-4" />
        {t('main.importVoice')}
      </Button>
    </div>
  );

  return (
    <div
      className="h-full min-h-0 overflow-y-auto"
      style={{ paddingBottom: 'calc(var(--app-player-height) + 1.5rem)' }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".voicebox.zip"
        onChange={handleFileChange}
        className="hidden"
      />
      {showStarter ? (
        <FirstRunWizard
          attempt={currentStarter}
          voiceName={starterVoice.name}
          sampleText={starterText}
          onTryVoice={tryVoice}
          onCreateVoice={() => setDialogOpen(true)}
          onImportVoice={handleImportClick}
          onBack={() => setStarter(null)}
          onFinish={finishFirstRun}
        />
      ) : (
        <>
          <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pb-3 sm:pb-4">
            <h1
              ref={editorHeadingRef}
              tabIndex={-1}
              className="text-xl font-semibold tracking-tight outline-none"
            >
              {t('nav.generate')}
            </h1>
            {!profilesLoading && voiceActions}
          </header>
          {!profilesLoading && (
            <div className="grid grid-cols-1 items-start gap-4 sm:gap-5 min-[1100px]:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
              <section className="min-w-0" aria-label="Generate speech">
                {profilesError && (
                  <p role="alert" className="mb-4 text-sm text-destructive">
                    {t('profiles.list.errorLoading', { message: profilesError.message })}
                  </p>
                )}
                <FloatingGenerateBox layout="docked" />
              </section>
              <section
                className="min-w-0 rounded-xl border border-border/70 bg-card p-3 shadow-xs sm:p-4"
                aria-labelledby="recent-takes-title"
              >
                <HistoryTable embedded headingId="recent-takes-title" />
              </section>
            </div>
          )}
        </>
      )}
      <ProfileForm />

      <Dialog
        open={importDialogOpen}
        onOpenChange={(open) => {
          if (!open) clearSelection();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('main.import.dialogTitle')}</DialogTitle>
            <DialogDescription>
              {t('main.import.dialogDescription', { name: selection?.file.name })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={clearSelection}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={handleImportConfirm}
              disabled={!selection || pendingSelectionId === selection.id}
            >
              {selection && pendingSelectionId === selection.id
                ? t('main.import.importing')
                : t('main.import.action')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
