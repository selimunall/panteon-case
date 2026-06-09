import type { LeaderboardEntry, PlayerRankView } from '@panteon/shared';

const BASE = import.meta.env.VITE_API_BASE ?? '/api';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json() as Promise<T>;
}

export interface TopResponse { weekId: string; entries: LeaderboardEntry[]; }
export interface PageResponse { weekId: string; offset: number; cap: number; entries: LeaderboardEntry[]; }

export const fetchTop = () => get<TopResponse>('/leaderboard/top');
export const fetchPage = (offset: number, limit = 50) => get<PageResponse>(`/leaderboard/page?offset=${offset}&limit=${limit}`);

/** Returns null when the player has no rank this week (404). */
export async function fetchMe(playerId: string): Promise<PlayerRankView | null> {
  const res = await fetch(`${BASE}/leaderboard/me?playerId=${playerId}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} /leaderboard/me`);
  return res.json() as Promise<PlayerRankView>;
}
