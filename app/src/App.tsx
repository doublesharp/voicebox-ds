import { RouterProvider } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { DictateWindow } from '@/components/DictateWindow/DictateWindow';
import { StartupScreen } from '@/components/StartupScreen';
import { useAutoUpdater } from '@/hooks/useAutoUpdater';
import { useThemeSync } from '@/hooks/useThemeSync';
import { apiClient } from '@/lib/api/client';
import type { HealthResponse } from '@/lib/api/types';
import { useChordSync } from '@/lib/hooks/useChordSync';
import { usePlatform } from '@/platform/PlatformContext';
import { router } from '@/router';
import { useLogStore } from '@/stores/logStore';
import { getDefaultServerUrl, useServerStore } from '@/stores/serverStore';

function isDictateView(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('view') === 'dictate';
}

/**
 * Validate that a health response has the expected Voicebox-specific shape.
 * Prevents misidentifying an unrelated service on the same port.
 */
function isVoiceboxHealthResponse(health: HealthResponse): boolean {
  return (
    health?.status === 'healthy' &&
    typeof health.model_loaded === 'boolean' &&
    typeof health.gpu_available === 'boolean'
  );
}

/**
 * Check whether a startup error indicates the port is occupied by an external
 * server (which we should try to reuse via health-check polling) vs. a real
 * failure (missing sidecar, signing issue, etc.) that should surface immediately.
 */
function isPortInUseError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.includes('already in use') ||
    msg.includes('port') ||
    msg.includes('EADDRINUSE') ||
    msg.includes('address already in use')
  );
}

function App() {
  useThemeSync();

  // The dictate window runs in a separate Tauri webview that must skip
  // server bootstrap (the main window owns that lifecycle) and render only
  // the floating recording surface. Split into a sibling component so the
  // main app's hooks are not called on the dictate path.
  if (isDictateView()) {
    return <DictateWindow />;
  }
  return <MainApp />;
}

function MainApp() {
  const platform = usePlatform();
  const [serverReady, setServerReady] = useState(false);
  const [startupError, setStartupError] = useState<string | null>(null);
  const serverStartingRef = useRef(false);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Automatically check for app updates on startup and show toast notifications
  useAutoUpdater({ checkOnMount: true, showToast: true });

  // Replay the saved chord into the Rust hotkey listener every time
  // capture_settings resolves or the user edits the chord.
  useChordSync();

  // Sync stored setting to Rust on startup
  useEffect(() => {
    if (platform.metadata.isTauri) {
      const keepRunning = useServerStore.getState().keepServerRunningOnClose;
      platform.lifecycle.setKeepServerRunning(keepRunning).catch((error) => {
        console.error('Failed to sync initial setting to Rust:', error);
      });
    }
    // Empty dependency array - platform is stable from context, only run once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform.metadata.isTauri, platform.lifecycle]);

  // Setup lifecycle callbacks
  useEffect(() => {
    platform.lifecycle.onServerReady = () => {
      setServerReady(true);
    };
    // Empty dependency array - platform is stable from context, only run once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform.lifecycle]);

  // Subscribe to server logs
  useEffect(() => {
    const unsubscribe = platform.lifecycle.subscribeToServerLogs((entry) => {
      useLogStore.getState().addEntry(entry);
    });
    return unsubscribe;
  }, [platform.lifecycle]);

  // Setup window close handler and auto-start server when running in Tauri (production only)
  useEffect(() => {
    if (!platform.metadata.isTauri) {
      const serverUrl = getDefaultServerUrl();
      useServerStore.getState().setDiscoveredServerUrl(serverUrl);
      setServerReady(true); // Web assumes server is running
      return;
    }

    // Setup window close handler to check setting and stop server if needed
    // This works in both dev and prod, but will only stop server if it was started by the app
    platform.lifecycle.setupWindowCloseHandler().catch((error) => {
      console.error('Failed to setup window close handler:', error);
    });

    // Only auto-start server in production mode
    // In dev mode, user runs server separately
    if (!import.meta.env?.PROD) {
      console.log('Dev mode: Skipping auto-start of server (run it separately)');
      setServerReady(true); // Mark as ready so UI doesn't show loading screen
      // Mark that server was not started by app (so we don't try to stop it on close)
      window.__voiceboxServerStartedByApp = false;
      return;
    }

    // Auto-start server in production
    if (serverStartingRef.current) {
      return;
    }

    serverStartingRef.current = true;
    const isRemote = useServerStore.getState().mode === 'remote';
    const customModelsDir = useServerStore.getState().customModelsDir;
    console.log(`Production mode: Starting bundled server... (remote: ${isRemote})`);

    platform.lifecycle
      .startServer(isRemote, customModelsDir)
      .then((serverUrl) => {
        console.log('Server is ready at:', serverUrl);
        // Use the bundled server address unless the user saved a custom URL.
        useServerStore.getState().setDiscoveredServerUrl(serverUrl);
        setServerReady(true);
        // Mark that we started the server (so we know to stop it on close)
        window.__voiceboxServerStartedByApp = true;
      })
      .catch((error) => {
        console.error('Failed to auto-start server:', error);
        serverStartingRef.current = false;
        window.__voiceboxServerStartedByApp = false;

        // Only fall back to health-check polling when the error indicates the
        // port is occupied (likely an external server). For real failures
        // (missing sidecar, signing issues, etc.) surface the error immediately.
        if (!isPortInUseError(error)) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error('Real startup failure — not polling:', msg);
          setStartupError(msg);
          return;
        }

        // Fall back to polling: the server may already be running externally
        // (e.g. started via python/uvicorn/Docker). Poll the health endpoint
        // until it responds with a valid Voicebox payload, then transition to
        // the main UI.
        console.log('Falling back to health-check polling...');
        pollIntervalRef.current = setInterval(async () => {
          try {
            const health = await apiClient.getHealth();
            if (!isVoiceboxHealthResponse(health)) {
              console.log('Health response is not from a Voicebox server, keep polling...');
              return;
            }
            console.log('External Voicebox server detected via health check');
            if (pollIntervalRef.current) {
              clearInterval(pollIntervalRef.current);
              pollIntervalRef.current = null;
            }
            if (pollTimeoutRef.current) {
              clearTimeout(pollTimeoutRef.current);
              pollTimeoutRef.current = null;
            }
            setServerReady(true);
          } catch {
            // Server not ready yet, keep polling
          }
        }, 2000);

        // Stop polling after 2 minutes and surface the failure
        pollTimeoutRef.current = setTimeout(() => {
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }
          pollTimeoutRef.current = null;
          serverStartingRef.current = false;
          setStartupError(
            'Could not connect to a Voicebox server within 2 minutes. ' +
              'Please check that the server is running and try again.',
          );
        }, 120_000);
      });

    // Cleanup: stop server on actual unmount (not StrictMode remount)
    // Note: Window close is handled separately in Tauri Rust code
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      if (pollTimeoutRef.current) {
        clearTimeout(pollTimeoutRef.current);
        pollTimeoutRef.current = null;
      }
      // Window close event handles server shutdown based on setting
      serverStartingRef.current = false;
    };
    // Empty dependency array - platform is stable from context, only run once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform.metadata.isTauri, platform.lifecycle]);

  // Show loading screen while server is starting in Tauri
  if (platform.metadata.isTauri && !serverReady) {
    return (
      <StartupScreen
        error={startupError}
        onRetry={() => {
          setStartupError(null);
          serverStartingRef.current = false;
          window.location.reload();
        }}
      />
    );
  }

  return <RouterProvider router={router} />;
}

export default App;
