import { Check, Copy, Plug, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/components/ui/use-toast';
import { APP_BRANDING } from '@/lib/constants/branding';
import { useMCPBindings } from '@/lib/hooks/useMCPBindings';
import { useProfiles } from '@/lib/hooks/useProfiles';
import { useCaptureSettings } from '@/lib/hooks/useSettings';
import { formatDate } from '@/lib/utils/format';
import { useServerStore } from '@/stores/serverStore';
import { SettingRow, SettingSection } from './SettingRow';

function getStdioShimCommand(): string {
  if (typeof navigator === 'undefined') {
    return `/Applications/${APP_BRANDING.name}.app/Contents/MacOS/voicebox-ds-mcp`;
  }

  const platform = `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  if (platform.includes('win')) {
    return `C:\\Program Files\\${APP_BRANDING.name}\\voicebox-ds-mcp.exe`;
  }
  if (platform.includes('linux')) {
    return 'voicebox-ds-mcp';
  }
  return `/Applications/${APP_BRANDING.name}.app/Contents/MacOS/voicebox-ds-mcp`;
}

/**
 * Settings → MCP — configure per-agent voice binding and show copy-paste
 * install snippets for major MCP clients. Backend runs at /mcp on the
 * existing Voicebox server; this page is the agent-onboarding surface.
 */
export function MCPPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const serverUrl = useServerStore((s) => s.serverUrl);
  const { bindings, upsertAsync, removeAsync, isRemoving } = useMCPBindings();
  const { data: profiles } = useProfiles();
  const { settings: captureSettings, update: updateCapture } = useCaptureSettings();

  const defaultProfileId = captureSettings?.default_playback_voice_id ?? '';
  const mcpUrl = `${serverUrl}/mcp`;
  const stdioShimCommand = getStdioShimCommand();

  const [newClientId, setNewClientId] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newProfileId, setNewProfileId] = useState('');
  const [adding, setAdding] = useState(false);
  const [bindingError, setBindingError] = useState<string | null>(null);
  const saveError = t('settings.mcp.bindings.saveFailed', {
    defaultValue: 'Could not save the agent voice binding. Please try again.',
  });

  const handleAdd = async () => {
    if (!newClientId.trim()) return;
    setAdding(true);
    setBindingError(null);
    try {
      await upsertAsync({
        client_id: newClientId.trim(),
        label: newLabel.trim() || null,
        profile_id: newProfileId || null,
      });
      setNewClientId('');
      setNewLabel('');
      setNewProfileId('');
    } catch (error) {
      setBindingError(saveError);
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : t('common.unknownError'),
        variant: 'destructive',
      });
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="max-w-3xl space-y-5 sm:space-y-6">
      <SettingSection
        title={t('settings.mcp.install.title')}
        description={t('settings.mcp.install.description')}
      >
        <SnippetRow
          title={t('settings.mcp.install.http.title')}
          description={t('settings.mcp.install.http.description')}
          snippet={JSON.stringify(
            {
              mcpServers: {
                'voicebox-ds': {
                  url: mcpUrl,
                  headers: { 'X-Voicebox-Client-Id': 'claude-code' },
                },
              },
            },
            null,
            2,
          )}
        />
        <SnippetRow
          title={t('settings.mcp.install.claudeCode.title')}
          description={t('settings.mcp.install.claudeCode.description')}
          snippet={`claude mcp add voicebox-ds --transport http --url ${mcpUrl} --header "X-Voicebox-Client-Id: claude-code"`}
        />
        <SnippetRow
          title={t('settings.mcp.install.stdio.title')}
          description={t('settings.mcp.install.stdio.description')}
          snippet={JSON.stringify(
            {
              mcpServers: {
                'voicebox-ds': {
                  command: stdioShimCommand,
                  env: { VOICEBOX_CLIENT_ID: 'claude-code' },
                },
              },
            },
            null,
            2,
          )}
        />
      </SettingSection>

      <SettingSection
        title={t('settings.mcp.defaultVoice.title')}
        description={t('settings.mcp.defaultVoice.description')}
      >
        <SettingRow
          title={t('settings.mcp.defaultVoice.label')}
          actionClassName="w-full sm:w-auto"
          description={t('settings.mcp.defaultVoice.labelHint')}
          action={
            <Select
              value={defaultProfileId || '__default__'}
              onValueChange={(v) =>
                updateCapture({
                  default_playback_voice_id: v === '__default__' ? null : v,
                })
              }
            >
              <SelectTrigger className="w-full sm:w-[220px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__default__">{t('settings.mcp.defaultVoice.none')}</SelectItem>
                {(profiles ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      </SettingSection>

      <SettingSection
        title={t('settings.mcp.bindings.title')}
        description={t('settings.mcp.bindings.description')}
      >
        {bindingError && <p role="alert" className="py-3 text-sm text-destructive">{bindingError}</p>}
        {bindings.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 italic">
            <Trans i18nKey="settings.mcp.bindings.empty" components={{ code: <code /> }} />
          </p>
        ) : (
          <div className="divide-y divide-border/60">
            {bindings.map((b) => (
              <div
                key={b.client_id}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_11rem_auto] sm:gap-3"
              >
                <div className="col-span-2 min-w-0 sm:col-span-1">
                  <div className="font-medium text-sm truncate">{b.label || b.client_id}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    <code className="text-[11px]">{b.client_id}</code>
                    {' · '}
                    {b.last_seen_at ? (
                      <span
                        title={t('settings.mcp.bindings.lastSeenTitle', { when: b.last_seen_at })}
                      >
                        <Plug className="inline h-3 w-3 text-emerald-500" />{' '}
                        {t('settings.mcp.bindings.lastSeen', {
                          when: formatDate(b.last_seen_at),
                        })}
                      </span>
                    ) : (
                      <span>{t('settings.mcp.bindings.neverConnected')}</span>
                    )}
                  </div>
                </div>
                <Select
                  value={b.profile_id ?? '__default__'}
                  onValueChange={(v) => {
                    setBindingError(null);
                    void upsertAsync({
                      client_id: b.client_id,
                      label: b.label,
                      profile_id: v === '__default__' ? null : v,
                    }).catch((error) => {
                      setBindingError(saveError);
                      toast({
                        title: t('common.error'),
                        description:
                          error instanceof Error ? error.message : t('common.unknownError'),
                        variant: 'destructive',
                      });
                    });
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__default__">
                      {t('settings.mcp.bindings.defaultOption')}
                    </SelectItem>
                    {(profiles ?? []).map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={isRemoving}
                  onClick={() => {
                    setBindingError(null);
                    void removeAsync(b.client_id).catch(() => setBindingError(
                      t('settings.mcp.bindings.removeFailed', {
                        defaultValue: 'Could not remove the agent binding. Please try again.',
                      }),
                    ));
                  }}
                  aria-label={t('settings.mcp.bindings.removeAria', { client: b.client_id })}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        )}

        <div className="space-y-2 py-3.5">
          <div className="text-sm font-medium">{t('settings.mcp.bindings.add.title')}</div>
          <div className="grid gap-2 sm:grid-cols-3">
            <input
              type="text"
              placeholder={t('settings.mcp.bindings.add.clientIdPlaceholder')}
              value={newClientId}
              onChange={(e) => setNewClientId(e.target.value)}
              className="h-9 min-w-0 rounded-md border bg-background px-3 text-sm"
            />
            <input
              type="text"
              placeholder={t('settings.mcp.bindings.add.labelPlaceholder')}
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              className="h-9 min-w-0 rounded-md border bg-background px-3 text-sm"
            />
            <Select
              value={newProfileId || '__default__'}
              onValueChange={(v) => setNewProfileId(v === '__default__' ? '' : v)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__default__">
                  {t('settings.mcp.bindings.defaultOption')}
                </SelectItem>
                {(profiles ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button size="sm" onClick={handleAdd} disabled={!newClientId.trim() || adding}>
            {t('settings.mcp.bindings.add.action')}
          </Button>
        </div>
      </SettingSection>
    </div>
  );
}

function SnippetRow({
  title,
  description,
  snippet,
}: {
  title: string;
  description: string;
  snippet: string;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore; user can still select-and-copy the pre content
    }
  };

  return (
    <SettingRow
      title={title}
      description={description}
      action={
        <Button size="sm" variant="outline" onClick={copy}>
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5 mr-1.5" />
              {t('settings.mcp.install.copied')}
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5 mr-1.5" />
              {t('settings.mcp.install.copy')}
            </>
          )}
        </Button>
      }
    >
      <pre className="whitespace-pre-wrap break-all rounded-md bg-muted/50 p-3 font-mono text-xs text-muted-foreground">
        {snippet}
      </pre>
    </SettingRow>
  );
}
