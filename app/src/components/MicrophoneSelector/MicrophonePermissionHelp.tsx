import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { usePlatform } from '@/platform/PlatformContext';

export function MicrophonePermissionHelp() {
  const { t } = useTranslation();
  const { lifecycle, metadata } = usePlatform();
  const [settingsFailed, setSettingsFailed] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <p role="alert" className="text-sm text-destructive">
        {t(
          metadata.isTauri
            ? 'microphone.permissionDeniedDesktop'
            : 'microphone.permissionDeniedBrowser',
        )}
      </p>
      {lifecycle.openMicrophoneSettings && !settingsFailed && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() =>
            void lifecycle.openMicrophoneSettings?.().catch(() => setSettingsFailed(true))
          }
        >
          {t('microphone.openSettings')}
        </Button>
      )}
    </div>
  );
}
