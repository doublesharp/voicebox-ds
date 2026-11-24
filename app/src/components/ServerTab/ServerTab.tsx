import { Link, Outlet, useMatchRoute } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { BOTTOM_SAFE_AREA_PADDING } from '@/lib/constants/ui';
import { cn } from '@/lib/utils/cn';
import { usePlatform } from '@/platform/PlatformContext';
import { usePlayerStore } from '@/stores/playerStore';

interface SettingsTab {
  labelKey?: string;
  label?: string;
  path:
    | '/settings'
    | '/settings/generation'
    | '/settings/captures'
    | '/settings/mcp'
    | '/settings/gpu'
    | '/settings/logs'
    | '/settings/changelog'
    | '/settings/about';
  tauriOnly?: boolean;
}

const tabs: SettingsTab[] = [
  { labelKey: 'settings.tabs.general', path: '/settings' },
  { labelKey: 'settings.tabs.generation', path: '/settings/generation' },
  { labelKey: 'settings.tabs.captures', path: '/settings/captures' },
  { labelKey: 'settings.tabs.mcp', path: '/settings/mcp' },
  { labelKey: 'settings.tabs.gpu', path: '/settings/gpu', tauriOnly: true },
  { labelKey: 'settings.tabs.logs', path: '/settings/logs', tauriOnly: true },
  { labelKey: 'settings.tabs.changelog', path: '/settings/changelog' },
  { labelKey: 'settings.tabs.about', path: '/settings/about' },
];

export function SettingsLayout() {
  const { t } = useTranslation();
  const platform = usePlatform();
  const isPlayerVisible = !!usePlayerStore((state) => state.audioUrl);
  const matchRoute = useMatchRoute();

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <header className="w-full max-w-5xl shrink-0">
        <h1 className="mb-2 text-xl font-semibold tracking-tight">{t('nav.settings')}</h1>
        <nav
          className="flex flex-nowrap gap-1 overflow-x-auto border-b"
          aria-label={t('nav.settings')}
        >
          {tabs.map((tab) => {
            if (tab.tauriOnly && !platform.metadata.isTauri) return null;

            const isActive =
              tab.path === '/settings'
                ? matchRoute({ to: tab.path, fuzzy: false })
                : matchRoute({ to: tab.path });

            return (
              <Link
                key={tab.path}
                to={tab.path}
                activeOptions={{ exact: tab.path === '/settings' }}
                className={cn(
                  'shrink-0 whitespace-nowrap border-b-2 px-2.5 py-2.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:px-4',
                  isActive
                    ? 'border-accent text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30',
                )}
              >
                {tab.label ?? (tab.labelKey ? t(tab.labelKey) : '')}
              </Link>
            );
          })}
        </nav>
      </header>

      <div
        className={cn(
          '-mx-2 min-h-0 flex-1 overflow-y-auto px-2 pt-4 pb-6 sm:pt-5',
          isPlayerVisible && BOTTOM_SAFE_AREA_PADDING,
        )}
      >
        <Outlet />
      </div>
    </div>
  );
}
