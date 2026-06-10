import type { CSSProperties } from 'react';
import type { LeaderboardEntry } from '@panteon/shared';
import { Avatar } from './Avatar.js';
import { formatCompact, formatNumber } from '../lib/format.js';

const MEDAL: Record<number, string> = { 1: 'tier-gold', 2: 'tier-silver', 3: 'tier-bronze' };

export type RowEntry = LeaderboardEntry & { reward?: number };

export function RankRow({ entry, isMe, onSelect, style }: {
  entry: RowEntry;
  isMe: boolean;
  onSelect: (id: string) => void;
  style?: CSSProperties;
}) {
  return (
    <button
      className={`row ${MEDAL[entry.rank] ?? ''}${isMe ? ' is-me' : ''}`}
      style={style}
      onClick={() => onSelect(entry.playerId)}
    >
      <span className="row-rank-cell">
        {entry.rank <= 3 && <span className="row-medal">★</span>}
        <span className="row-rankn">{entry.rank}</span>
      </span>
      <Avatar playerId={entry.playerId} name={entry.displayName} size={34} />
      <span className="row-name">
        {entry.displayName ?? entry.playerId.slice(0, 8)}
        {isMe && <span className="row-you">YOU</span>}
      </span>
      <span className="row-score">
        {formatNumber(entry.totalEarned)}
        {entry.reward != null && entry.reward > 0 && <span className="row-reward">◈ {formatCompact(entry.reward)}</span>}
      </span>
    </button>
  );
}
