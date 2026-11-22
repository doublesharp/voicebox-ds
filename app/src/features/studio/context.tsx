import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';
import type { StudioClient, StudioProfile } from './client';
import type { StudioPlayback } from './playback';
import type { ReviewSessions } from './review-session';
import type { ProjectSession, SessionState } from './session';
import type { StudioEngine, StudioProject } from './types';
export interface StudioContextValue {
  reviewSessions?: ReviewSessions;
  client: StudioClient;
  project: StudioProject;
  session: ProjectSession;
  save: SessionState;
  profiles: StudioProfile[];
  engines: StudioEngine[];
  capabilitiesError: string | null;
  playback: StudioPlayback;
  selectedPassageId: string | null;
  selectedClipId: string | null;
  checkedPassages: string[];
  setCheckedPassages: (ids: string[]) => void;
  selectPassage: (id: string) => void;
  selectClip: (id: string) => void;
  playhead: number;
  setPlayhead: (seconds: number) => void;
  revisionId: string;
  setRevisionId: (id: string) => void;
  actionBusy: boolean;
  actionError: string | null;
  runAction: (action: () => Promise<unknown>, options?: { reportError: boolean }) => Promise<void>;
  canMutate: boolean;
}
export const StudioContext = createContext<StudioContextValue | null>(null);
export function useStudio() {
  const context = useContext(StudioContext);
  if (!context) throw new Error('Studio components require a project session.');
  return context;
}

/** Read at command boundaries without putting clock ticks into editor context. */
export function readStudioPlayhead(studio: StudioContextValue) {
  return studio.playback.getPlayhead?.() ?? studio.playhead;
}

/** Only controls that display the cursor subscribe to clock changes. */
export function useStudioPlayhead() {
  const studio = useStudio();
  const snapshot = useCallback(() => readStudioPlayhead(studio), [studio]);
  return useSyncExternalStore(studio.playback.subscribe, snapshot);
}
