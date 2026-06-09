import { useCallback, useEffect, useRef, useState } from 'react';
import type { LeaderboardEntry, PlayerRankView } from '@panteon/shared';
import { fetchMe, fetchPage, fetchStatus, fetchTop, type WeekStatus } from './api.js';

/** Ticks every second; returns ms remaining until `endsAt`. */
export function useCountdown(endsAt: string | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return endsAt ? new Date(endsAt).getTime() - now : 0;
}

interface PollState<T> { data: T | null; loading: boolean; error: boolean; }

function usePoll<T>(fn: () => Promise<T>, ms: number): PollState<T> {
  const [state, setState] = useState<PollState<T>>({ data: null, loading: true, error: false });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let alive = true;
    const run = async () => {
      try {
        const data = await fnRef.current();
        if (alive) setState({ data, loading: false, error: false });
      } catch {
        if (alive) setState((s) => ({ ...s, loading: false, error: true }));
      }
    };
    run();
    const t = setInterval(run, ms);
    return () => { alive = false; clearInterval(t); };
  }, [ms]);
  return state;
}

export const useStatus = (): PollState<WeekStatus> => usePoll(fetchStatus, 3000);

export function useTop100(): PollState<LeaderboardEntry[]> {
  const { data, loading, error } = usePoll(fetchTop, 3000);
  return { data: data?.entries ?? null, loading, error };
}

export function useMyRank(playerId: string | null): { view: PlayerRankView | null; notRanked: boolean } {
  const [view, setView] = useState<PlayerRankView | null>(null);
  const [notRanked, setNotRanked] = useState(false);
  useEffect(() => {
    if (!playerId) { setView(null); setNotRanked(false); return; }
    let alive = true;
    const run = async () => {
      try {
        const v = await fetchMe(playerId);
        if (!alive) return;
        setView(v);
        setNotRanked(v === null);
      } catch { /* keep last */ }
    };
    run();
    const t = setInterval(run, 3000);
    return () => { alive = false; clearInterval(t); };
  }, [playerId]);
  return { view, notRanked };
}

const PAGE = 50;

/** Incrementally loads the ranking (rank 1..cap) for the scrollable list. */
export function usePages(): {
  entries: LeaderboardEntry[];
  cap: number;
  hasMore: boolean;
  loadMore: () => void;
  loadUntil: (rank: number) => Promise<void>;
} {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [cap, setCap] = useState(1000);
  const offsetRef = useRef(0);
  const busyRef = useRef(false);
  const hasMoreRef = useRef(true);
  const [hasMore, setHasMore] = useState(true);

  const loadNext = useCallback(async (): Promise<void> => {
    if (busyRef.current || !hasMoreRef.current) return;
    busyRef.current = true;
    try {
      const r = await fetchPage(offsetRef.current, PAGE);
      setCap(r.cap);
      setEntries((prev) => {
        const map = new Map(prev.map((e) => [e.rank, e]));
        for (const e of r.entries) map.set(e.rank, e);
        return [...map.values()].sort((a, b) => a.rank - b.rank);
      });
      offsetRef.current += PAGE;
      const more = r.entries.length === PAGE && offsetRef.current < r.cap;
      hasMoreRef.current = more;
      setHasMore(more);
    } finally {
      busyRef.current = false;
    }
  }, []);

  useEffect(() => { void loadNext(); }, [loadNext]);

  const loadUntil = useCallback(async (rank: number): Promise<void> => {
    let guard = 0;
    while (offsetRef.current < rank && hasMoreRef.current && guard++ < 40) {
      await loadNext();
    }
  }, [loadNext]);

  return { entries, cap, hasMore, loadMore: () => void loadNext(), loadUntil };
}
