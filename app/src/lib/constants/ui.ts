/**
 * UI layout constants for safe area padding
 */

const isWindows = typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows');

/**
 * Top safe area padding - height of the drag region bar
 * On macOS this accounts for the overlay titlebar (48px).
 * On Windows the native title bar is outside the webview, so no padding is needed.
 */
export const TOP_SAFE_AREA_PADDING = isWindows ? 'pt-8' : 'pt-12';

export const DIALOG_LAYOUT =
  'visible-scrollbar w-[calc(100vw-1.5rem)] max-w-lg max-h-[calc(100dvh-1.5rem)] overflow-y-auto overscroll-contain scroll-py-4 gap-4 rounded-2xl p-[clamp(1rem,4vw,1.5rem)]';

/**
 * Bottom safe area padding - height of the audio player
 * Follows the measured global player height, including its error state.
 */
export const BOTTOM_SAFE_AREA_PADDING = 'pb-[var(--app-player-height)]';

/** Project workspaces keep the compact rail at every window size. */
export function isProjectWorkspacePath(path: string): boolean {
  return /^\/studio\/projects\/[^/]+\/[^/]+\/?$/.test(path);
}

/** Keep the shell offset synchronized with its mounted audio controls and their actual size. */
export function observeGlobalPlayerHeight(shell: HTMLElement): () => void {
  let player: Element | null = null;
  const updateHeight = () => {
    shell.style.setProperty(
      '--app-player-height',
      `${player?.getBoundingClientRect().height ?? 0}px`,
    );
  };
  const resize = new ResizeObserver(updateHeight);
  const sync = () => {
    const next = shell.querySelector('.app-global-player, .studio-transport');
    if (next !== player) {
      if (player) resize.unobserve(player);
      player = next;
      if (player) resize.observe(player);
    }
    updateHeight();
  };
  const mutations = new MutationObserver(sync);
  mutations.observe(shell, { childList: true, subtree: true });
  sync();
  return () => {
    mutations.disconnect();
    resize.disconnect();
  };
}
