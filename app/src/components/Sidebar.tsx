import { Link, useRouterState } from '@tanstack/react-router';
import {
  AudioLines,
  Box,
  Captions,
  FolderOpen,
  Keyboard,
  type LucideIcon,
  Mic,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Volume2,
  Wand2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import voiceboxLogo from '@/assets/voicebox-ds-icon.png';
import { Hint } from '@/components/ui/Hint';
import { APP_BRANDING } from '@/lib/constants/branding';
import { isProjectWorkspacePath } from '@/lib/constants/ui';
import { cn } from '@/lib/utils/cn';
import { usePlatform } from '@/platform/PlatformContext';
import type { UpdateStatus } from '@/platform/types';
import { version } from '../../package.json';

interface SidebarProps {
  isMacOS?: boolean;
  desktop?: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
  width?: number;
  onResize?: (width: number) => void;
}
type NavItem = { path: string; icon: LucideIcon; labelKey?: string; label?: string };
const createItems: NavItem[] = [
  { path: '/studio/projects', icon: FolderOpen, label: 'Projects' },
  { path: '/stories', icon: AudioLines, labelKey: 'nav.stories' },
  { path: '/', icon: Volume2, labelKey: 'nav.generate' },
  { path: '/voices', icon: Mic, labelKey: 'nav.voices' },
  { path: '/captures', icon: Captions, labelKey: 'nav.captures' },
];
const toolItems: NavItem[] = [
  { path: '/effects', icon: Wand2, labelKey: 'nav.effects' },
  { path: '/models', icon: Box, labelKey: 'nav.models' },
];
const settings: NavItem = { path: '/settings', icon: Settings, labelKey: 'nav.settings' };

export function Sidebar({
  isMacOS,
  desktop = false,
  collapsed = false,
  onToggle,
  width = 196,
  onResize,
}: SidebarProps) {
  const { t } = useTranslation();
  const dragging = useRef<number | null>(null);
  const resize = (value: number) => onResize?.(Math.max(160, Math.min(280, value)));
  const path = useRouterState({ select: (state) => state.location.pathname });
  const [wideRail, setWideRail] = useState(false);
  useEffect(() => {
    if (desktop || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(min-width: 1100px)');
    const sync = () => setWideRail(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, [desktop]);
  const showNavHints = desktop ? collapsed : !wideRail || isProjectWorkspacePath(path);
  const platform = usePlatform();
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>(platform.updater.getStatus());
  useEffect(() => platform.updater.subscribe(setUpdateStatus), [platform.updater]);

  const item = (tab: NavItem) => {
    const Icon = tab.icon;
    const label = tab.label ?? t(tab.labelKey!);
    const current =
      tab.path === '/' ? path === '/' : path === tab.path || path.startsWith(`${tab.path}/`);
    return (
      <Hint key={tab.path} content={label} enabled={showNavHints}>
        <Link
          to={tab.path}
          activeOptions={{ exact: tab.path === '/' }}
          className="app-rail-link"
          aria-label={label}
          aria-current={current ? 'page' : undefined}
        >
          <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
          <span className="app-rail-label">{label}</span>
        </Link>
      </Hint>
    );
  };
  return (
    <aside
      className={cn(
        'app-rail fixed left-0 top-0 h-full bg-sidebar border-r border-border flex flex-col py-4 gap-3 overflow-y-auto',
        desktop && isMacOS && 'pt-14',
      )}
    >
      {desktop && (
        <div className="app-rail-header">
          <div className="app-rail-brand" title={APP_BRANDING.name}>
            <img src={voiceboxLogo} alt="" className="size-[26px] shrink-0" />
            <span className="app-rail-heading">{APP_BRANDING.name}</span>
          </div>
          <button
            type="button"
            className="app-rail-toggle"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            aria-controls="desktop-sidebar-navigation"
            onClick={onToggle}
          >
            {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          </button>
        </div>
      )}
      {!desktop && (
        <div className="px-3 mb-2 shrink-0 flex justify-center" title={APP_BRANDING.name}>
          <img
            src={voiceboxLogo}
            alt={APP_BRANDING.name}
            className="sidebar-logo w-12 h-12 object-contain"
          />
        </div>
      )}
      <nav
        id={desktop ? 'desktop-sidebar-navigation' : undefined}
        aria-label="Main navigation"
        className="flex flex-col gap-4 px-2"
      >
        <div className="flex flex-col gap-1">
          <span className="app-rail-group-label">Create</span>
          {createItems.map(item)}
        </div>
        <div className="flex flex-col gap-1">
          <span className="app-rail-group-label">Tools</span>
          {toolItems.map(item)}
        </div>
      </nav>
      <div className="mt-auto px-2 flex flex-col gap-2">
        <Hint content="Keyboard shortcuts · Command or Control + /">
          <button
            type="button"
            className="app-rail-link"
            aria-label="Keyboard shortcuts"
            aria-keyshortcuts="Meta+/ Control+/"
            onClick={() => window.dispatchEvent(new Event('voicebox:keyboard-shortcuts'))}
          >
            <Keyboard className="h-5 w-5 shrink-0" aria-hidden="true" />
            <span className="app-rail-label">Shortcuts</span>
          </button>
        </Hint>
        {item(settings)}
        <div className="flex flex-col items-center gap-1.5">
          {!desktop && <span className="text-[10px] text-muted-foreground/50">v{version}</span>}
          {updateStatus.available && (
            <Link
              to="/settings"
              className="text-[9px] font-semibold tracking-wide uppercase px-2 py-0.5 rounded-full bg-accent/15 text-accent hover:bg-accent/25"
            >
              {t('nav.updateBadge')}
            </Link>
          )}
        </div>
      </div>
      {desktop && !collapsed && (
        <hr
          className="app-rail-resizer"
          tabIndex={0}
          aria-label="Resize sidebar"
          aria-controls="desktop-sidebar-navigation"
          aria-orientation="vertical"
          aria-valuemin={160}
          aria-valuemax={280}
          aria-valuenow={width}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            dragging.current = event.pointerId;
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (dragging.current === event.pointerId) resize(event.clientX);
          }}
          onPointerUp={(event) => {
            if (dragging.current === event.pointerId) dragging.current = null;
          }}
          onPointerCancel={() => {
            dragging.current = null;
          }}
          onLostPointerCapture={() => {
            dragging.current = null;
          }}
          onKeyDown={(event) => {
            const next =
              event.key === 'ArrowLeft'
                ? width - 10
                : event.key === 'ArrowRight'
                  ? width + 10
                  : event.key === 'Home'
                    ? 160
                    : event.key === 'End'
                      ? 280
                      : null;
            if (next !== null) {
              event.preventDefault();
              resize(next);
            }
          }}
        />
      )}
    </aside>
  );
}
