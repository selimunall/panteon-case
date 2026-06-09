import { z } from 'zod';

/** Client → server earn batch (architecture §3.1). */
export const EarnPayload = z.object({
  playerId: z.string().uuid(),
  delta: z.number().int().nonnegative(),
  weekId: z.string(),
  idempKey: z.string().uuid(),
  clientTs: z.number().int(),
});
export type EarnPayload = z.infer<typeof EarnPayload>;

export interface LeaderboardEntry {
  rank: number;
  playerId: string;
  displayName?: string;
  totalEarned: number;
}

export interface PlayerRankView {
  weekId: string;
  inTop100: boolean;
  player: LeaderboardEntry;
  neighbours: LeaderboardEntry[];
}
