import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
  useNavigate,
  useRouterState,
} from '@tanstack/react-router';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import './app-shell.css';
import { AppFrame } from '@/components/AppFrame/AppFrame';
import { DesktopToolbar } from '@/components/DesktopToolbar';
import { KeyboardShortcuts } from '@/components/KeyboardShortcuts';
import { MainEditor } from '@/components/MainEditor/MainEditor';
import { Sidebar } from '@/components/Sidebar';
import { Toaster } from '@/components/ui/toaster';
import { StudioFrame } from '@/features/studio/StudioFrame';
import { isProjectWorkspacePath, observeGlobalPlayerHeight } from '@/lib/constants/ui';
import { attachDesktopCommands } from '@/lib/desktopCommands';
import { useGenerationProgress } from '@/lib/hooks/useGenerationProgress';
import { useModelDownloadToast } from '@/lib/hooks/useModelDownloadToast';
import { MODEL_DISPLAY_NAMES, useRestoreActiveTasks } from '@/lib/hooks/useRestoreActiveTasks';
import { usePlatform } from '@/platform/PlatformContext';

// Simple platform check that works in both web and Tauri
const isMacOS = () => typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
const isWindows = () => typeof navigator !== 'undefined' && /win/i.test(navigator.userAgent);

// Root layout component
function RootLayout() {
  const shellRef = useRef<HTMLDivElement>(null);
  const { metadata } = usePlatform();
  const desktop = metadata.isTauri && (isMacOS() || isWindows());
  const navigate = useNavigate();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem('voicebox-desktop:sidebar-collapsed') === 'true';
    } catch {
      return false;
    }
  });
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem('voicebox-desktop:sidebar-width'));
      return saved >= 160 && saved <= 280 ? saved : 196;
    } catch {
      return 196;
    }
  });
  const toggleSidebar = () => setSidebarCollapsed((previous) => !previous);
  useEffect(() => {
    if (!desktop) return;
    try {
      localStorage.setItem('voicebox-desktop:sidebar-collapsed', String(sidebarCollapsed));
      localStorage.setItem('voicebox-desktop:sidebar-width', String(sidebarWidth));
    } catch {
      /* Keep the preference for this session if storage is unavailable. */
    }
  }, [desktop, sidebarCollapsed, sidebarWidth]);
  useEffect(() => {
    if (!desktop) return;
    return attachDesktopCommands(
      window,
      (path) => {
        void navigate({ to: path }).catch((error) =>
          console.error('Could not open menu destination:', error),
        );
      },
      () => setSidebarCollapsed((previous) => !previous),
    );
  }, [desktop, navigate]);
  const isProjectWorkspace = useRouterState({
    select: (state) => isProjectWorkspacePath(state.location.pathname),
  });
  useEffect(() => {
    const shell = shellRef.current;
    if (shell) return observeGlobalPlayerHeight(shell);
  }, []);

  // Monitor active downloads/generations and show toasts for them
  const activeDownloads = useRestoreActiveTasks();
  const isStudio = useRouterState({
    select: (state) => state.location.pathname.startsWith('/studio/'),
  });

  // Subscribe to SSE for pending generations — handles completion, auto-play, and history refresh
  useGenerationProgress();

  const Frame = isStudio ? StudioFrame : AppFrame;

  return (
    <div
      ref={shellRef}
      className="app-shell"
      data-project-workspace={isProjectWorkspace}
      style={{ '--desktop-sidebar-width': `${sidebarWidth}px` } as CSSProperties}
      data-desktop={desktop}
      data-sidebar-collapsed={desktop && sidebarCollapsed}
      data-desktop-platform={desktop ? (isMacOS() ? 'macos' : 'windows') : undefined}
    >
      <Frame>
        <KeyboardShortcuts />
        <div className="flex flex-1 min-h-0 overflow-hidden">
          <Sidebar
            isMacOS={isMacOS()}
            desktop={desktop}
            collapsed={sidebarCollapsed}
            onToggle={toggleSidebar}
            width={sidebarWidth}
            onResize={setSidebarWidth}
          />

          <main
            className="flex-1 overflow-hidden flex flex-col"
            style={{ marginLeft: 'var(--app-rail-width)' }}
          >
            {desktop && <DesktopToolbar />}
            <div
              data-desktop-page-content={desktop}
              className={
                isStudio
                  ? `mx-auto w-full px-2 sm:px-4 max-w-[1800px] ${desktop ? 'flex-1 min-h-0' : 'h-full'} overflow-hidden flex flex-col`
                  : `container mx-auto px-3 sm:px-6 lg:px-8 max-w-[1800px] ${desktop ? 'flex-1 min-h-0' : 'h-full'} overflow-hidden flex flex-col`
              }
            >
              <Outlet />
            </div>
          </main>
        </div>

        {/* Show download toasts for any active downloads (from anywhere) */}
        {activeDownloads.map((download) => {
          const displayName = MODEL_DISPLAY_NAMES[download.model_name] || download.model_name;
          return (
            <DownloadToastRestorer
              key={download.model_name}
              modelName={download.model_name}
              displayName={displayName}
            />
          );
        })}

        <Toaster />
      </Frame>
    </div>
  );
}

/**
 * Component that restores a download toast for a specific model.
 */
function DownloadToastRestorer({
  modelName,
  displayName,
}: {
  modelName: string;
  displayName: string;
}) {
  // Use the download toast hook to restore the toast
  useModelDownloadToast({
    modelName,
    displayName,
    enabled: true,
    includeTerminalSnapshot: true,
  });

  return null;
}

// Root route with layout
const rootRoute = createRootRoute({
  component: RootLayout,
});

// Index route (main/generate)
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: MainEditor,
});

const studioProjectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/studio/projects',
  component: lazyRouteComponent(() => import('@/features/studio/ProjectsPage'), 'ProjectsPage'),
});

const studioProjectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/studio/projects/$projectId/$workspace',
  component: lazyRouteComponent(
    () => import('@/features/studio/StudioProjectPage'),
    'StudioProjectPage',
  ),
});

// Stories route
const storiesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/stories',
  component: lazyRouteComponent(() => import('@/components/StoriesTab/StoriesTab'), 'StoriesTab'),
});

// Voices route
const voicesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/voices',
  component: lazyRouteComponent(() => import('@/components/VoicesTab/VoicesTab'), 'VoicesTab'),
});

// Captures route (prototype — will replace AudioTab once the new flow is ready)
const capturesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/captures',
  component: lazyRouteComponent(
    () => import('@/components/CapturesTab/CapturesTab'),
    'CapturesTab',
  ),
});

// Effects route
const effectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/effects',
  component: lazyRouteComponent(() => import('@/components/EffectsTab/EffectsTab'), 'EffectsTab'),
});

// Models route
const modelsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/models',
  component: lazyRouteComponent(() => import('@/components/ModelsTab/ModelsTab'), 'ModelsTab'),
});

// Settings layout route (parent for sub-tabs)
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: lazyRouteComponent(() => import('@/components/ServerTab/ServerTab'), 'SettingsLayout'),
});

// Settings sub-routes
const settingsGeneralRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/',
  component: lazyRouteComponent(() => import('@/components/ServerTab/GeneralPage'), 'GeneralPage'),
});

const settingsGenerationRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/generation',
  component: lazyRouteComponent(
    () => import('@/components/ServerTab/GenerationPage'),
    'GenerationPage',
  ),
});

const settingsCapturesRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/captures',
  component: lazyRouteComponent(
    () => import('@/components/ServerTab/CapturesPage'),
    'CapturesPage',
  ),
});

const settingsMCPRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/mcp',
  component: lazyRouteComponent(() => import('@/components/ServerTab/MCPPage'), 'MCPPage'),
});

const settingsGpuRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/gpu',
  component: lazyRouteComponent(() => import('@/components/ServerTab/GpuPage'), 'GpuPage'),
});

const settingsChangelogRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/changelog',
  component: lazyRouteComponent(
    () => import('@/components/ServerTab/ChangelogPage'),
    'ChangelogPage',
  ),
});

const settingsLogsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/logs',
  component: lazyRouteComponent(() => import('@/components/ServerTab/LogsPage'), 'LogsPage'),
});

const settingsAboutRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/about',
  component: lazyRouteComponent(() => import('@/components/ServerTab/AboutPage'), 'AboutPage'),
});

// Redirect old /server path to /settings
const serverRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/server',
  beforeLoad: () => {
    throw redirect({ to: '/settings' });
  },
});

// Route tree
const routeTree = rootRoute.addChildren([
  indexRoute,
  studioProjectsRoute,
  studioProjectRoute,
  storiesRoute,
  capturesRoute,
  voicesRoute,
  effectsRoute,
  modelsRoute,
  settingsRoute.addChildren([
    settingsGeneralRoute,
    settingsGenerationRoute,
    settingsCapturesRoute,
    settingsMCPRoute,
    settingsGpuRoute,
    settingsLogsRoute,
    settingsChangelogRoute,
    settingsAboutRoute,
  ]),
  serverRedirectRoute,
]);

// Create router
export const router = createRouter({ routeTree });

// Register router for type safety
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
