import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { usePlayerStore } from '@/stores/playerStore';

const ESTIMATED_HEIGHT = 116;
const OVERSCAN = 500;

/** A row observes only its own selection/play state, never the playback clock. */
export function HistoryPlaybackState({
  id,
  children,
}: {
  id: string;
  children: (state: { isSelected: boolean; isCurrentlyPlaying: boolean }) => ReactNode;
}) {
  const state = usePlayerStore((player) =>
    player.audioId === id ? (player.isPlaying ? 2 : 1) : 0,
  );
  return children({ isSelected: state > 0, isCurrentlyPlaying: state === 2 });
}

export function historyWindowRange(offsets: number[], top: number, height: number) {
  const count = offsets.length - 1;
  const search = (value: number) => {
    let low = 0;
    let high = count;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (offsets[middle + 1] < value) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  return {
    start: search(Math.max(0, top - OVERSCAN)),
    end: Math.min(count, search(top + height + OVERSCAN) + 1),
  };
}

/** Variable-height rows share measured offsets across scrolling and expansion. */
export function useHistoryWindow(
  keys: string[],
  scroll: RefObject<HTMLDivElement>,
  embedded: boolean,
  pinned: Array<string | null>,
) {
  const [listNode, setListNode] = useState<HTMLDivElement | null>(null);
  const content = useCallback((node: HTMLDivElement | null) => setListNode(node), []);
  const sizes = useRef(new Map<string, number>());
  const nodes = useRef(new Map<string, HTMLElement>());
  const observer = useRef<ResizeObserver>();
  const [revision, setRevision] = useState(0);
  const [viewport, setViewport] = useState({ top: 0, height: 800 });
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision invalidates offsets when ResizeObserver changes the measured-height map.
  const offsets = useMemo(() => {
    const current = new Set(keys);
    for (const key of sizes.current.keys()) if (!current.has(key)) sizes.current.delete(key);
    const result = [0];
    for (const key of keys)
      result.push(result[result.length - 1] + (sizes.current.get(key) ?? ESTIMATED_HEIGHT));
    return result;
  }, [keys, revision]);
  const measure = useCallback((key: string, node: HTMLElement | null) => {
    const previous = nodes.current.get(key);
    if (previous) observer.current?.unobserve(previous);
    if (node) {
      nodes.current.set(key, node);
      observer.current?.observe(node);
    } else nodes.current.delete(key);
  }, []);
  useEffect(() => {
    const list = listNode;
    if (!list?.getBoundingClientRect || typeof window === 'undefined') return;
    let root: HTMLElement | null = scroll.current;
    if (embedded) {
      root = root?.parentElement ?? null;
      while (root && !/(auto|scroll)/.test(window.getComputedStyle(root).overflowY))
        root = root.parentElement;
    }
    const target = root ?? window;
    const read = () => {
      const top = (root?.getBoundingClientRect().top ?? 0) - list.getBoundingClientRect().top;
      const height = root?.clientHeight || window.innerHeight || 800;
      setViewport((current) =>
        current.top === top && current.height === height ? current : { top, height },
      );
    };
    const resize =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver((entries) => {
            let changed = false;
            for (const entry of entries) {
              const node = entry.target as HTMLElement;
              const key = node.dataset.historyRow;
              if (!key) continue;
              const height = node.getBoundingClientRect().height;
              if (height > 0 && sizes.current.get(key) !== height) {
                sizes.current.set(key, height);
                changed = true;
              }
            }
            if (changed) setRevision((value) => value + 1);
            read();
          });
    observer.current = resize;
    for (const node of nodes.current.values()) resize?.observe(node);
    if (root) resize?.observe(root);
    resize?.observe(list);
    target.addEventListener('scroll', read, { passive: true });
    window.addEventListener('resize', read);
    read();
    return () => {
      observer.current = undefined;
      resize?.disconnect();
      target.removeEventListener('scroll', read);
      window.removeEventListener('resize', read);
    };
  }, [listNode, scroll, embedded]);
  const range = historyWindowRange(offsets, viewport.top, viewport.height);
  const indices = new Set(
    Array.from({ length: Math.max(0, range.end - range.start) }, (_, index) => range.start + index),
  );
  for (const key of pinned) {
    const index = key ? keys.indexOf(key) : -1;
    if (index >= 0) indices.add(index);
  }
  return {
    content,
    measure,
    total: offsets[offsets.length - 1],
    rows: [...indices].sort((a, b) => a - b).map((index) => ({ index, top: offsets[index] })),
  };
}
