import type { Config } from '@panteon/shared';

export interface Payout { rank: number; playerId: string; amount: bigint; }
export interface Distribution { payouts: Payout[]; rolloverOut: bigint; }

/**
 * Distribute an integer pool to the top 100 (architecture §5.3): 1st 20%, 2nd 15%, 3rd 10%,
 * ranks 4..N split 55% by weight (101 - rank)^k. Every amount is floored; the leftover is
 * rolloverOut, so sum(payouts) + rolloverOut === pool exactly.
 */
export function computeDistribution(orderedPlayerIds: string[], pool: bigint, poolCfg: Config['pool']): Distribution {
  const N = Math.min(orderedPlayerIds.length, 100);
  const payouts: Payout[] = [];
  const bps = (f: number) => BigInt(Math.round(f * 10000));
  const add = (rank: number, amount: bigint) => payouts.push({ rank, playerId: orderedPlayerIds[rank - 1]!, amount });

  if (N >= 1) add(1, (pool * bps(poolCfg.top3[0])) / 10000n);
  if (N >= 2) add(2, (pool * bps(poolCfg.top3[1])) / 10000n);
  if (N >= 3) add(3, (pool * bps(poolCfg.top3[2])) / 10000n);

  if (N >= 4) {
    const band = (pool * bps(poolCfg.bandShare)) / 10000n;
    const weights: number[] = [];
    let sumW = 0;
    for (let rank = 4; rank <= N; rank++) { const w = Math.pow(101 - rank, poolCfg.curveExponent); weights.push(w); sumW += w; }
    const sumWi = BigInt(Math.round(sumW * 1e6));
    for (let i = 0; i < weights.length; i++) {
      const wi = BigInt(Math.round(weights[i]! * 1e6));
      add(4 + i, (band * wi) / sumWi);
    }
  }

  const totalPaid = payouts.reduce((a, p) => a + p.amount, 0n);
  return { payouts, rolloverOut: pool - totalPaid };
}
