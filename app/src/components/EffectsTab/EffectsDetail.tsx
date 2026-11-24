import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Play, Save, Trash2, Wand2 } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { EffectsChainEditor } from '@/components/Effects/EffectsChainEditor';
import { GenerationPicker } from '@/components/Effects/GenerationPicker';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FormSection } from '@/components/ui/form-section';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/use-toast';
import { apiClient } from '@/lib/api/client';
import type { HistoryResponse } from '@/lib/api/types';
import { useHistory } from '@/lib/hooks/useHistory';
import { useEffectsStore } from '@/stores/effectsStore';
import { usePlayerStore } from '@/stores/playerStore';

export function EffectsDetail() {
  const fieldId = useId();
  const { t } = useTranslation();
  const selectedPresetId = useEffectsStore((s) => s.selectedPresetId);
  const isCreatingNew = useEffectsStore((s) => s.isCreatingNew);
  const workingChain = useEffectsStore((s) => s.workingChain);
  const setWorkingChain = useEffectsStore((s) => s.setWorkingChain);
  const setSelectedPresetId = useEffectsStore((s) => s.setSelectedPresetId);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const selectionEpoch = useRef(0);
  const mounted = useRef(false);
  const editRevision = useRef(0);
  const initializedSelection = useRef<string | null>(null);
  const loadedSelection = useRef<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = useEffectsStore.subscribe((state, previous) => {
      if (
        state.selectedPresetId !== previous.selectedPresetId ||
        state.isCreatingNew !== previous.isCreatingNew
      ) {
        selectionEpoch.current++;
        setSaving(false);
        setDeleting(false);
        setPreviewLoading(false);
        setSaveAsDialogOpen(false);
      }
    });
    return () => {
      mounted.current = false;
      selectionEpoch.current++;
      unsubscribe();
    };
  }, []);

  const isCurrent = (epoch: number) => mounted.current && selectionEpoch.current === epoch;

  // "Save as Custom" dialog state
  const [saveAsDialogOpen, setSaveAsDialogOpen] = useState(false);
  const [saveAsName, setSaveAsName] = useState('');
  const [saveAsDescription, setSaveAsDescription] = useState('');

  // Preview state
  const [previewGenId, setPreviewGenId] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewGenerationRef = useRef(previewGenId);
  previewGenerationRef.current = previewGenId;
  const blobUrlRef = useRef<string | null>(null);
  const setAudioWithAutoPlay = usePlayerStore((s) => s.setAudioWithAutoPlay);

  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Auto-select the most recent completed generation as preview source
  const { data: historyData } = useHistory({ limit: 20 });
  useEffect(() => {
    if (!previewGenId && historyData?.items?.length) {
      const first = historyData.items.find((g) => g.status === 'completed');
      if (first) setPreviewGenId(first.id);
    }
  }, [historyData, previewGenId]);

  const { data: preset } = useQuery({
    queryKey: ['effect-preset', selectedPresetId],
    queryFn: () =>
      selectedPresetId
        ? apiClient
            .listEffectPresets()
            .then((all) => all.find((p) => p.id === selectedPresetId) ?? null)
        : null,
    enabled: !!selectedPresetId,
    staleTime: 30_000,
  });

  // Initialize each selection once; background refetches must not replace a draft.
  useEffect(() => {
    const selection = isCreatingNew
      ? 'new'
      : selectedPresetId
        ? `preset:${selectedPresetId}`
        : null;
    if (selection !== initializedSelection.current) {
      initializedSelection.current = selection;
      loadedSelection.current = null;
      setName('');
      setDescription('');
      editRevision.current++;
    }
    if (
      selection?.startsWith('preset:') &&
      preset?.id === selectedPresetId &&
      loadedSelection.current !== selection
    ) {
      loadedSelection.current = selection;
      setName(preset.name);
      setDescription(preset.description ?? '');
    }
  }, [preset, selectedPresetId, isCreatingNew]);

  // Cleanup blob URL on unmount unless the persistent global player is still playing it.
  useEffect(() => {
    return () => {
      if (blobUrlRef.current && usePlayerStore.getState().audioUrl !== blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
      }
      blobUrlRef.current = null;
    };
  }, []);

  const isEditing = !!selectedPresetId || isCreatingNew;
  const isBuiltIn = preset?.is_builtin ?? false;
  const presetName = preset
    ? preset.is_builtin
      ? t(`effects.builtinPresets.${preset.name}.name`, { defaultValue: preset.name })
      : preset.name
    : '';
  const presetDescription = preset
    ? preset.is_builtin
      ? t(`effects.builtinPresets.${preset.name}.description`, {
          defaultValue: preset.description ?? '',
        })
      : preset.description
    : '';

  async function handlePreview() {
    if (!previewGenId || workingChain.length === 0) return;

    const epoch = selectionEpoch.current;
    const generationId = previewGenId;
    const previewChain = workingChain;
    setPreviewLoading(true);
    try {
      const blob = await apiClient.previewEffects(previewGenId, workingChain);

      if (
        !isCurrent(epoch) ||
        useEffectsStore.getState().workingChain !== previewChain ||
        previewGenerationRef.current !== generationId
      )
        return;

      // Revoke old blob URL
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
      }

      const url = URL.createObjectURL(blob);
      blobUrlRef.current = url;

      // Play through the main audio player
      setAudioWithAutoPlay(url, `preview-${Date.now()}`, null, 'Effects Preview');
    } catch (error) {
      if (!isCurrent(epoch)) return;
      toast({
        title: t('effects.toast.previewFailed'),
        description: error instanceof Error ? error.message : t('common.unknownError'),
        variant: 'destructive',
      });
    } finally {
      if (isCurrent(epoch)) setPreviewLoading(false);
    }
  }

  function handleSelectGeneration(gen: HistoryResponse) {
    setPreviewGenId(gen.id);
  }

  async function handleSaveNew() {
    if (!name.trim()) {
      toast({ title: t('effects.toast.nameRequired'), variant: 'destructive' });
      return;
    }
    const epoch = selectionEpoch.current;
    setSaving(true);
    try {
      const created = await apiClient.createEffectPreset({
        name: name.trim(),
        description: description.trim() || undefined,
        effects_chain: workingChain,
      });
      queryClient.invalidateQueries({ queryKey: ['effect-presets'] });
      if (isCurrent(epoch)) {
        // Adopt the acknowledged identity without replacing newer local edits.
        // A second Save must update this preset rather than create a duplicate.
        initializedSelection.current = `preset:${created.id}`;
        loadedSelection.current = initializedSelection.current;
        queryClient.setQueryData(['effect-preset', created.id], created);
        setSelectedPresetId(created.id);
      }
      toast({
        title: t('effects.toast.saved'),
        description: t('effects.toast.createdDescription', { name: created.name }),
      });
    } catch (error) {
      if (!mounted.current) return;
      toast({
        title: t('effects.toast.saveFailed'),
        description: error instanceof Error ? error.message : t('common.unknownError'),
        variant: 'destructive',
      });
    } finally {
      if (isCurrent(epoch)) setSaving(false);
    }
  }

  async function handleSaveExisting() {
    if (!selectedPresetId || !name.trim()) return;
    const epoch = selectionEpoch.current;
    setSaving(true);
    try {
      await apiClient.updateEffectPreset(selectedPresetId, {
        name: name.trim(),
        description: description.trim() || undefined,
        effects_chain: workingChain,
      });
      queryClient.invalidateQueries({ queryKey: ['effect-presets'] });
      queryClient.invalidateQueries({ queryKey: ['effect-preset', selectedPresetId] });
      toast({ title: t('effects.toast.updated') });
    } catch (error) {
      if (!mounted.current) return;
      toast({
        title: t('effects.toast.saveFailed'),
        description: error instanceof Error ? error.message : t('common.unknownError'),
        variant: 'destructive',
      });
    } finally {
      if (isCurrent(epoch)) setSaving(false);
    }
  }

  function handleSaveAsNew() {
    const sourceName = isBuiltIn ? presetName : name;
    setSaveAsName(t('effects.saveAs.suggestedName', { name: sourceName }));
    setSaveAsDescription(description);
    setSaveAsDialogOpen(true);
  }

  async function handleSaveAsConfirm() {
    if (!saveAsName.trim()) {
      toast({ title: t('effects.toast.nameRequired'), variant: 'destructive' });
      return;
    }
    const epoch = selectionEpoch.current;
    const revision = editRevision.current;
    const savedChain = workingChain;
    setSaving(true);
    try {
      const created = await apiClient.createEffectPreset({
        name: saveAsName.trim(),
        description: saveAsDescription.trim() || undefined,
        effects_chain: workingChain,
      });
      queryClient.invalidateQueries({ queryKey: ['effect-presets'] });
      if (
        isCurrent(epoch) &&
        editRevision.current === revision &&
        useEffectsStore.getState().workingChain === savedChain
      ) {
        setSaveAsDialogOpen(false);
        setSelectedPresetId(created.id);
      }
      toast({
        title: t('effects.toast.saved'),
        description: t('effects.toast.createdDescription', { name: created.name }),
      });
    } catch (error) {
      if (!mounted.current) return;
      toast({
        title: t('effects.toast.saveFailed'),
        description: error instanceof Error ? error.message : t('common.unknownError'),
        variant: 'destructive',
      });
    } finally {
      if (isCurrent(epoch)) setSaving(false);
    }
  }

  async function handleDelete() {
    if (!selectedPresetId) return;
    const epoch = selectionEpoch.current;
    setDeleting(true);
    try {
      await apiClient.deleteEffectPreset(selectedPresetId);
      queryClient.invalidateQueries({ queryKey: ['effect-presets'] });
      if (isCurrent(epoch)) {
        setSelectedPresetId(null);
        setWorkingChain([]);
      }
      toast({ title: t('effects.toast.deleted') });
    } catch (error) {
      if (!mounted.current) return;
      toast({
        title: t('effects.toast.deleteFailed'),
        description: error instanceof Error ? error.message : t('common.unknownError'),
        variant: 'destructive',
      });
    } finally {
      if (isCurrent(epoch)) setDeleting(false);
    }
  }

  if (!isEditing) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <div className="text-center space-y-2">
          <Wand2 className="h-10 w-10 mx-auto opacity-30" />
          <p className="text-sm">{t('effects.placeholder')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-3">
        <h2 className="text-base font-semibold tracking-tight">
          {isCreatingNew
            ? t('effects.detail.newTitle')
            : isBuiltIn
              ? presetName
              : t('effects.detail.editTitle')}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {!isBuiltIn && !isCreatingNew && (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-destructive  gap-1.5"
                onClick={handleDelete}
                disabled={deleting}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {deleting ? t('effects.detail.deleting') : t('common.delete')}
              </Button>
              <Button
                size="sm"
                className="h-8 gap-1.5"
                onClick={handleSaveExisting}
                disabled={saving || workingChain.length === 0}
              >
                <Save className="h-3.5 w-3.5" />
                {saving ? t('effects.detail.saving') : t('common.save')}
              </Button>
            </>
          )}
          {isCreatingNew && (
            <Button
              size="sm"
              className="h-8 gap-1.5"
              onClick={handleSaveNew}
              disabled={saving || workingChain.length === 0}
            >
              <Save className="h-3.5 w-3.5" />
              {saving ? t('effects.detail.saving') : t('effects.detail.savePreset')}
            </Button>
          )}
          {isBuiltIn && (
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5"
              onClick={handleSaveAsNew}
              disabled={saving}
            >
              <Save className="h-3.5 w-3.5" />
              {saving ? t('effects.detail.saving') : t('effects.detail.saveAsCustom')}
            </Button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-0.5 pb-5">
        {(isCreatingNew || !isBuiltIn) && (
          <FormSection
            title={t('effects.detail.detailsTitle', { defaultValue: 'Preset details' })}
            className="grid grid-cols-1 gap-2.5 space-y-0 rounded-lg border border-border/70 bg-card/50 p-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] [&>header]:col-span-full"
          >
            <div className="space-y-1.5">
              <Label htmlFor={`${fieldId}-name`}>{t('effects.fields.name')}</Label>
              <Input
                id={`${fieldId}-name`}
                value={name}
                onChange={(e) => {
                  editRevision.current++;
                  setName(e.target.value);
                }}
                placeholder={t('effects.fields.namePlaceholder')}
                className="h-9"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${fieldId}-description`}>{t('effects.fields.description')}</Label>
              <Textarea
                id={`${fieldId}-description`}
                value={description}
                onChange={(e) => {
                  editRevision.current++;
                  setDescription(e.target.value);
                }}
                placeholder={t('effects.fields.descriptionPlaceholder')}
                rows={2}
                className="min-h-14 resize-y py-1.5 leading-5"
              />
            </div>
          </FormSection>
        )}

        {isBuiltIn && presetDescription && (
          <p className="text-sm text-muted-foreground">{presetDescription}</p>
        )}

        <FormSection
          title={t('effects.detail.chainTitle', { defaultValue: 'Effect chain' })}
          className="space-y-3 rounded-lg border border-border/70 bg-card/50 p-3"
        >
          <EffectsChainEditor
            value={workingChain}
            onChange={(chain) => {
              editRevision.current++;
              setWorkingChain(chain);
            }}
            showPresets={false}
          />
        </FormSection>

        <FormSection
          title={t('effects.preview.label')}
          className="space-y-2.5 rounded-lg border border-border/70 bg-muted/20 p-3"
        >
          <div className="flex items-center gap-2">
            <GenerationPicker
              selectedId={previewGenId}
              onSelect={handleSelectGeneration}
              className="min-w-0 flex-1 [&>span]:truncate"
            />
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 shrink-0"
              onClick={handlePreview}
              disabled={!previewGenId || workingChain.length === 0 || previewLoading}
            >
              {previewLoading ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t('effects.preview.processing')}
                </>
              ) : (
                <>
                  <Play className="h-3.5 w-3.5" />
                  {t('effects.preview.button')}
                </>
              )}
            </Button>
          </div>
        </FormSection>
      </div>

      <Dialog
        open={saveAsDialogOpen}
        onOpenChange={(open) => {
          if (!open) editRevision.current++;
          setSaveAsDialogOpen(open);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('effects.saveAs.title')}</DialogTitle>
            <DialogDescription>{t('effects.saveAs.description')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label htmlFor={`${fieldId}-save-name`}>{t('effects.fields.name')}</Label>
              <Input
                id={`${fieldId}-save-name`}
                value={saveAsName}
                onChange={(e) => {
                  editRevision.current++;
                  setSaveAsName(e.target.value);
                }}
                placeholder={t('effects.fields.namePlaceholder')}
                className="h-9"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && saveAsName.trim() && !saving) {
                    handleSaveAsConfirm();
                  }
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t('effects.fields.description')}</Label>
              <Textarea
                value={saveAsDescription}
                onChange={(e) => {
                  editRevision.current++;
                  setSaveAsDescription(e.target.value);
                }}
                placeholder={t('effects.fields.descriptionPlaceholder')}
                className="min-h-[60px] resize-none"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveAsDialogOpen(false)} disabled={saving}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleSaveAsConfirm} disabled={saving || !saveAsName.trim()}>
              <Save className="h-3.5 w-3.5 mr-1.5" />
              {saving ? t('effects.detail.saving') : t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
