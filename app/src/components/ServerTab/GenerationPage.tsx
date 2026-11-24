import { FolderOpen } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Toggle } from '@/components/ui/toggle';
import { useToast } from '@/components/ui/use-toast';
import { useGenerationSettings } from '@/lib/hooks/useSettings';
import { usePlatform } from '@/platform/PlatformContext';
import { useServerStore } from '@/stores/serverStore';
import { SettingRow, SettingSection } from './SettingRow';

export function GenerationPage() {
  const { t } = useTranslation();
  const platform = usePlatform();
  const serverUrl = useServerStore((state) => state.serverUrl);
  const { toast } = useToast();
  const onSettingsError = useCallback(() => {
    toast({
      title: t('settings.generation.saveError.title'),
      description: t('settings.generation.saveError.description'),
      variant: 'destructive',
    });
  }, [t, toast]);
  const { settings, update } = useGenerationSettings({ onError: onSettingsError });
  const persistedMaxChunkChars = settings?.max_chunk_chars ?? 800;
  const persistedCrossfadeMs = settings?.crossfade_ms ?? 50;
  const normalizeAudio = settings?.normalize_audio ?? true;
  const autoplayOnGenerate = settings?.autoplay_on_generate ?? true;
  // Slider mirrors persist on commit (pointer-up / keyboard-release) only —
  // onValueChange would fire a PATCH for every pointer-move pixel and round-
  // trip mid-drag failures could leave persisted state out of sync with UI.
  const [maxChunkChars, setMaxChunkChars] = useState(persistedMaxChunkChars);
  const [crossfadeMs, setCrossfadeMs] = useState(persistedCrossfadeMs);
  useEffect(() => setMaxChunkChars(persistedMaxChunkChars), [persistedMaxChunkChars]);
  useEffect(() => setCrossfadeMs(persistedCrossfadeMs), [persistedCrossfadeMs]);
  const [opening, setOpening] = useState(false);
  const [generationsPath, setGenerationsPath] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setGenerationsPath(null);
    if (!serverUrl) return () => { active = false; controller.abort(); };
    fetch(`${serverUrl}/health/filesystem`, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error('Unable to load generations folder');
        return res.json();
      })
      .then((data) => {
        const genDir = data.directories?.find((d: { path: string }) =>
          d.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.toLowerCase() === 'generations',
        );
        if (active && genDir?.path) setGenerationsPath(genDir.path);
      })
      .catch(() => {});
    return () => {
      active = false;
      controller.abort();
    };
  }, [serverUrl]);

  const openGenerationsFolder = useCallback(async () => {
    if (!generationsPath) return;
    setOpening(true);
    try {
      await platform.filesystem.openPath(generationsPath);
    } catch (e) {
      console.error('Failed to open generations folder:', e);
    } finally {
      setOpening(false);
    }
  }, [platform, generationsPath]);

  return (
    <div className="max-w-3xl">
      <SettingSection
        title={t('settings.generation.title')}
        description={t('settings.generation.description')}
      >
        <SettingRow
          title={t('settings.generation.chunkLimit.title')}
          description={t('settings.generation.chunkLimit.description')}
          action={
            <span className="text-sm tabular-nums text-muted-foreground">
              {t('settings.generation.chunkLimit.value', { chars: maxChunkChars })}
            </span>
          }
        >
          <Slider
            id="maxChunkChars"
            value={[maxChunkChars]}
            onValueChange={([value]) => setMaxChunkChars(value)}
            onValueCommit={([value]) => update({ max_chunk_chars: value })}
            min={100}
            max={5000}
            step={50}
            aria-label={t('settings.generation.chunkLimit.title')}
          />
        </SettingRow>

        <SettingRow
          title={t('settings.generation.crossfade.title')}
          description={t('settings.generation.crossfade.description')}
          action={
            <span className="text-sm tabular-nums text-muted-foreground">
              {crossfadeMs === 0
                ? t('settings.generation.crossfade.cut')
                : t('settings.generation.crossfade.ms', { ms: crossfadeMs })}
            </span>
          }
        >
          <Slider
            id="crossfadeMs"
            value={[crossfadeMs]}
            onValueChange={([value]) => setCrossfadeMs(value)}
            onValueCommit={([value]) => update({ crossfade_ms: value })}
            min={0}
            max={200}
            step={10}
            aria-label={t('settings.generation.crossfade.title')}
          />
        </SettingRow>

        <SettingRow
          title={t('settings.generation.normalize.title')}
          description={t('settings.generation.normalize.description')}
          htmlFor="normalizeAudio"
          action={
            <Toggle
              id="normalizeAudio"
              checked={normalizeAudio}
              onCheckedChange={(v) => update({ normalize_audio: v })}
            />
          }
        />

        <SettingRow
          title={t('settings.generation.autoplay.title')}
          description={t('settings.generation.autoplay.description')}
          htmlFor="autoplayOnGenerate"
          action={
            <Toggle
              id="autoplayOnGenerate"
              checked={autoplayOnGenerate}
              onCheckedChange={(v) => update({ autoplay_on_generate: v })}
            />
          }
        />

        <SettingRow
          title={t('settings.generation.folder.title')}
          description={generationsPath ?? t('settings.generation.folder.description')}
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={openGenerationsFolder}
              disabled={opening || !generationsPath}
            >
              <FolderOpen className="h-3.5 w-3.5 mr-1.5" />
              {t('settings.generation.folder.open')}
            </Button>
          }
        />
      </SettingSection>
    </div>
  );
}
