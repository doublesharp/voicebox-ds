import { zodResolver } from '@hookform/resolvers/zod';
import { AlertCircle, Download, Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Trans, useTranslation } from 'react-i18next';
import * as z from 'zod';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormField, FormItem, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Toggle } from '@/components/ui/toggle';
import { useToast } from '@/components/ui/use-toast';
import { useAutoUpdater } from '@/hooks/useAutoUpdater';
import { useServerHealth } from '@/lib/hooks/useServer';
import { syncKeepServerRunning } from '@/lib/keepServerRunning';
import { usePlatform } from '@/platform/PlatformContext';
import { LOCAL_SERVER_URL, useServerStore } from '@/stores/serverStore';
import { CloudSection } from './CloudSection';
import { LanguageSelect } from './LanguageSelect';
import { SettingRow, SettingSection } from './SettingRow';
import { ThemeSelect } from './ThemeSelect';

function makeConnectionSchema(invalidUrl: string) {
  return z.object({
    serverUrl: z.string().url(invalidUrl),
  });
}

type ConnectionFormValues = { serverUrl: string };

export function GeneralPage() {
  const { t } = useTranslation();
  const platform = usePlatform();
  const serverUrl = useServerStore((state) => state.serverUrl);
  const setServerUrl = useServerStore((state) => state.setServerUrl);
  const keepServerRunningOnClose = useServerStore((state) => state.keepServerRunningOnClose);
  const keepServerRunningSyncing = useServerStore((state) => state.keepServerRunningSyncing);
  const mode = useServerStore((state) => state.mode);
  const setMode = useServerStore((state) => state.setMode);
  const { toast } = useToast();
  const { data: health, isLoading, error: healthError } = useServerHealth();

  const resolver = useMemo(
    () => zodResolver(makeConnectionSchema(t('settings.general.serverUrl.invalidUrl'))),
    [t],
  );
  const form = useForm<ConnectionFormValues>({
    resolver,
    defaultValues: { serverUrl },
  });

  useEffect(() => {
    form.reset({ serverUrl });
  }, [serverUrl, form]);

  // Re-run validation when the locale changes so existing error messages retranslate.
  useEffect(() => {
    if (form.formState.errors.serverUrl) {
      form.trigger('serverUrl');
    }
  }, [t, form]);

  const { isDirty } = form.formState;

  function onSubmit(data: ConnectionFormValues) {
    setServerUrl(data.serverUrl);
    form.reset(data);
    toast({
      title: t('settings.general.serverUrl.updatedTitle'),
    });
  }

  return (
    <div className="max-w-3xl space-y-5 sm:space-y-6">
      <SettingSection>
        <SettingRow
          title={t('settings.general.serverUrl.title')}
          description={t('settings.general.serverUrl.description')}
          action={
            <ConnectionStatus health={health} isLoading={isLoading} healthError={healthError} />
          }
        >
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="flex items-start gap-2">
              <FormField
                control={form.control}
                name="serverUrl"
                render={({ field }) => (
                  <FormItem className="min-w-0 flex-1">
                    <FormControl>
                      <Input
                        aria-label={t('settings.general.serverUrl.title')}
                        placeholder={LOCAL_SERVER_URL}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button type="submit" disabled={!isDirty}>
                {t('common.save')}
              </Button>
            </form>
          </Form>
        </SettingRow>

        {platform.metadata.isTauri && (
          <SettingRow
            title={t('settings.general.keepServerRunning.title')}
            description={t('settings.general.keepServerRunning.description')}
            htmlFor="keepServerRunning"
            action={
              <Toggle
                id="keepServerRunning"
                checked={keepServerRunningOnClose}
                disabled={keepServerRunningSyncing}
                onCheckedChange={(checked: boolean) => {
                  void syncKeepServerRunning(checked, (value) =>
                    platform.lifecycle.setKeepServerRunning(value),
                  )
                    .then((saved) => {
                      if (!saved) return;
                      toast({
                        title: t('settings.general.keepServerRunning.updatedTitle'),
                        description: checked
                          ? t('settings.general.keepServerRunning.runningDescription')
                          : t('settings.general.keepServerRunning.stoppedDescription'),
                      });
                    })
                    .catch((error) => {
                      console.error('Failed to sync setting to Rust:', error);
                      toast({
                        title: t('settings.general.keepServerRunning.failedTitle'),
                        description: t('settings.general.keepServerRunning.failedDescription'),
                        variant: 'destructive',
                      });
                    });
                }}
              />
            }
          />
        )}

        {platform.metadata.isTauri && (
          <SettingRow
            title={t('settings.general.networkAccess.title')}
            description={t('settings.general.networkAccess.description')}
            htmlFor="allowNetworkAccess"
            action={
              <Toggle
                id="allowNetworkAccess"
                checked={mode === 'remote'}
                onCheckedChange={(checked: boolean) => {
                  setMode(checked ? 'remote' : 'local');
                  toast({
                    title: t('settings.general.networkAccess.updatedTitle'),
                    description: checked
                      ? t('settings.general.networkAccess.enabled')
                      : t('settings.general.networkAccess.disabled'),
                  });
                }}
              />
            }
          />
        )}

        <SettingRow title={t('settings.language.label')} action={<LanguageSelect />} />

        <SettingRow title={t('settings.theme.label')} action={<ThemeSelect />} />
      </SettingSection>

      {health?.cloud_enabled && <CloudSection />}

      <ApiReferenceCard serverUrl={serverUrl} />

      {platform.metadata.isTauri && platform.updater.enabled !== false && <UpdatesSection />}
      <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-muted-foreground">
        <a
          href="https://docs.voicebox.sh"
          target="_blank"
          rel="noreferrer"
          className="hover:underline"
        >
          {t('settings.general.docs.title')}
        </a>
        <a
          href="https://discord.gg/StkzQasqPS"
          target="_blank"
          rel="noreferrer"
          className="hover:underline"
        >
          {t('settings.general.discord.title')}
        </a>
      </div>
    </div>
  );
}

function ConnectionStatus({
  health,
  isLoading,
  healthError,
}: {
  health: ReturnType<typeof useServerHealth>['data'];
  isLoading: boolean;
  healthError: ReturnType<typeof useServerHealth>['error'];
}) {
  const { t } = useTranslation();
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-full border border-border/60 px-3 py-1">
        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        <span className="text-xs text-muted-foreground">
          {t('settings.general.connection.connecting')}
        </span>
      </div>
    );
  }
  if (healthError) {
    return (
      <output className="flex items-center gap-2 rounded-full border border-destructive/30 px-3 py-1">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full rounded-full bg-destructive/40" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-destructive" />
        </span>
        <span className="text-xs text-destructive">{t('settings.general.connection.offline')}</span>
      </output>
    );
  }
  if (health) {
    return (
      <div className="flex items-center gap-2 rounded-full border border-accent/30 px-3 py-1">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent/60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-accent shadow-[0_0_6px_1px_hsl(var(--accent)/0.5)]" />
        </span>
        <span className="text-xs text-muted-foreground">
          {t('settings.general.connection.online')}
        </span>
      </div>
    );
  }
  return null;
}

function UpdatesSection() {
  const { t } = useTranslation();
  const platform = usePlatform();
  const { status, checkForUpdates, downloadAndInstall, restartAndInstall } = useAutoUpdater(false);
  const [currentVersion, setCurrentVersion] = useState<string | null>('');
  const isDev = !import.meta.env?.PROD;

  useEffect(() => {
    platform.metadata
      .getVersion()
      .then(setCurrentVersion)
      .catch(() => setCurrentVersion(null));
  }, [platform]);

  const versionLabel = currentVersion ?? t('common.unknown');

  return (
    <SettingSection
      title={t('settings.general.updates.title')}
      description={`v${versionLabel}${isDev ? t('settings.general.updates.devSuffix') : ''}`}
    >
      {isDev ? (
        <SettingRow
          title={t('settings.general.updates.devMode.title')}
          description={t('settings.general.updates.devMode.description')}
        />
      ) : (
        <>
          <SettingRow
            title={t('settings.general.updates.check.title')}
            description={
              status.available
                ? t('settings.general.updates.check.available', { version: status.version })
                : status.checking
                  ? t('settings.general.updates.check.checking')
                  : t('settings.general.updates.check.upToDate')
            }
            action={
              <Button
                onClick={checkForUpdates}
                disabled={status.checking || status.downloading || status.readyToInstall}
                variant="outline"
                size="sm"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 mr-1.5 ${status.checking ? 'animate-spin' : ''}`}
                />
                {t('settings.general.updates.check.button')}
              </Button>
            }
          />

          {status.error && (
            <SettingRow title={t('settings.general.updates.error')}>
              <div className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" />
                {status.error}
              </div>
            </SettingRow>
          )}

          {status.available && !status.downloading && !status.readyToInstall && (
            <SettingRow
              title={t('settings.general.updates.download.title', { version: status.version })}
              description={t('settings.general.updates.download.description')}
              action={
                <Button onClick={downloadAndInstall} size="sm">
                  <Download className="h-3.5 w-3.5 mr-1.5" />
                  {t('settings.general.updates.download.button')}
                </Button>
              }
            />
          )}

          {status.downloading && (
            <SettingRow title={t('settings.general.updates.downloading')}>
              <div className="space-y-1.5">
                <Progress value={status.downloadProgress} />
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  {status.downloadedBytes !== undefined &&
                  status.totalBytes !== undefined &&
                  status.totalBytes > 0 ? (
                    <span>
                      {(status.downloadedBytes / 1024 / 1024).toFixed(1)} MB /{' '}
                      {(status.totalBytes / 1024 / 1024).toFixed(1)} MB
                    </span>
                  ) : (
                    <span />
                  )}
                  {status.downloadProgress !== undefined && <span>{status.downloadProgress}%</span>}
                </div>
              </div>
            </SettingRow>
          )}

          {status.readyToInstall && (
            <SettingRow
              title={t('settings.general.updates.ready.title')}
              description={t('settings.general.updates.ready.description', {
                version: status.version,
              })}
              action={
                <Button onClick={restartAndInstall} size="sm">
                  <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                  {t('settings.general.updates.ready.button')}
                </Button>
              }
            />
          )}
        </>
      )}
    </SettingSection>
  );
}

function ApiReferenceCard({ serverUrl }: { serverUrl: string }) {
  const { t } = useTranslation();
  const endpoints = [
    { method: 'POST', path: '/generate', label: t('settings.general.api.endpoints.generate') },
    { method: 'GET', path: '/health', label: t('settings.general.api.endpoints.health') },
    { method: 'GET', path: '/profiles', label: t('settings.general.api.endpoints.profiles') },
    { method: 'GET', path: '/history', label: t('settings.general.api.endpoints.history') },
  ];

  return (
    <details className="rounded-xl border border-border/70 bg-card/50 px-3 py-3.5 sm:px-4">
      <summary className="cursor-pointer text-sm font-medium">
        {t('settings.general.api.title')}
      </summary>
      <div className="mt-3 space-y-3">
        <p className="break-words text-sm text-muted-foreground">
          <Trans
            i18nKey="settings.general.api.description"
            values={{ url: serverUrl }}
            components={{
              code: <code className="text-xs bg-muted px-1 py-0.5 rounded font-mono" />,
            }}
          />
        </p>
        <div className="space-y-1">
          {endpoints.map((ep) => (
            <div key={ep.path} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 py-1">
              <span
                className={`text-[10px] font-mono font-semibold w-9 text-center rounded px-1 py-px ${
                  ep.method === 'POST'
                    ? 'bg-accent/10 text-accent'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                {ep.method}
              </span>
              <code className="text-xs font-mono text-muted-foreground">{ep.path}</code>
              <span className="ml-auto text-xs text-muted-foreground">{ep.label}</span>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          <a
            href={`${serverUrl}/docs`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:underline"
          >
            {t('settings.general.api.viewReference')}
          </a>
        </p>
      </div>
    </details>
  );
}
