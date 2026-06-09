import type { LeaderboardEntry } from '@panteon/shared';
import { Avatar } from './Avatar.js';
import { formatCompact } from '../lib/format.js';

const ORDER = [1, 0, 2]; // silver, gold, bronze — gold centered
const TIER = ['gold', 'silver', 'bronze'] as const;

export function Podium({ top3, meId, onSelect }: {
  top3: LeaderboardEntry[];
  meId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="podium">
      {ORDER.map((idx) => {
        const e = top3[idx];
        if (!e) return <div key={idx} className="podium-slot is-empty" />;
        const tier = TIER[idx]!;
        return (
          <button
            key={e.playerId}
            className={`podium-slot tier-${tier}${e.playerId === meId ? ' is-me' : ''}`}
            onClick={() => onSelect(e.playerId)}
            title={e.displayName ?? e.playerId}
          >
            <span className="podium-crown">{idx === 0 ? '♕' : ''}</span>
            <Avatar playerId={e.playerId} name={e.displayName} size={idx === 0 ? 76 : 60} />
            <span className="podium-name">{e.displayName ?? e.playerId.slice(0, 8)}</span>
            <span className="podium-score">{formatCompact(e.totalEarned)}</span>
            <span className="podium-pedestal">
              <span className="podium-rank">{e.rank}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
