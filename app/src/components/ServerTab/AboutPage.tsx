import { ArrowUpRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import voiceboxLogo from '@/assets/voicebox-logo.png';
import { DoubleSharpMark } from '@/components/Branding';
import { Button } from '@/components/ui/button';
import { APP_BRANDING } from '@/lib/constants/branding';
import { usePlatform } from '@/platform/PlatformContext';
import { SettingSection } from './SettingRow';

export function AboutPage() {
  const { t } = useTranslation();
  const platform = usePlatform();
  const [version, setVersion] = useState('');

  useEffect(() => {
    platform.metadata
      .getVersion()
      .then(setVersion)
      .catch(() => setVersion(''));
  }, [platform]);

  return (
    <div className="max-w-3xl">
      <SettingSection>
        <div className="flex items-center gap-4 py-4">
          <div className="relative shrink-0">
            <img src={voiceboxLogo} alt="" className="h-12 w-12 object-contain" />
            <DoubleSharpMark className="absolute -right-1 -bottom-1 h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-semibold tracking-tight">{APP_BRANDING.name}</h2>
            <p className="text-sm text-muted-foreground">
              {APP_BRANDING.edition}
              {version && ` · v${version}`}
            </p>
          </div>
        </div>

        <div className="space-y-3 py-3.5">
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <a href={APP_BRANDING.sourceUrl} target="_blank" rel="noopener noreferrer">
                {t('settings.about.editionSource', { defaultValue: 'Edition source' })}
                <ArrowUpRight className="ml-1.5 h-3.5 w-3.5 text-muted-foreground" />
              </a>
            </Button>
            <Button asChild variant="outline" size="sm">
              <a
                href="https://github.com/jamiepine/voicebox"
                target="_blank"
                rel="noopener noreferrer"
              >
                {t('settings.about.upstreamSource', { defaultValue: 'Original Voicebox' })}
                <ArrowUpRight className="ml-1.5 h-3.5 w-3.5 text-muted-foreground" />
              </a>
            </Button>
          </div>

          <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm text-muted-foreground">
            <li>
              <a
                href={APP_BRANDING.websiteUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`${APP_BRANDING.attribution} · DoubleSharp website`}
                className="underline-offset-4 hover:underline"
              >
                {APP_BRANDING.attribution}
              </a>
            </li>
            <li>
              {t('settings.about.createdBy')}{' '}
              <a
                href="https://github.com/jamiepine"
                target="_blank"
                rel="noopener noreferrer"
                className="underline-offset-4 hover:underline"
              >
                Jamie Pine
              </a>
            </li>
            <li>
              <a
                href="https://buymeacoffee.com/jamiepine"
                target="_blank"
                rel="noopener noreferrer"
                className="underline-offset-4 hover:underline"
              >
                {t('settings.about.buyCoffee')}
              </a>
            </li>
          </ul>
        </div>

        <p className="py-3.5 text-xs leading-relaxed text-muted-foreground">
          <Trans
            i18nKey="settings.about.license"
            components={{
              link: (
                // biome-ignore lint/a11y/useAnchorContent: Trans fills content at runtime
                <a
                  href="https://github.com/jamiepine/voicebox/blob/main/LICENSE"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-4"
                />
              ),
            }}
          />
        </p>
      </SettingSection>
    </div>
  );
}
